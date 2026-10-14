import { createHash } from "node:crypto";
import { requestConfirmation } from "../confirmation.ts";
import { excerptOf } from "../core/excerpt.ts";
import { evaluateBashFloor, evaluateIpythonFloor, type FloorVerdict } from "../core/floor.ts";
import { questionsVersionFor, registerQuestionContract } from "../core/question-registry.ts";
import { hookMode, mayRun } from "./modes.ts";

/**
 * A4 Tool-Gate (`tool_call`) — Phase 4, shadow.
 *
 * Layer 1 is the deterministic floor: `block` is hard and never reaches JEV; floor
 * evaluation errors fail closed with their own documented path; a throwing UI can never
 * swallow a verdict. Layer 2 is the JEV grey zone for mutating-looking allowed inputs.
 *
 * Paket D (J12): risk predicates are evaluated independently — a benign high score
 * (`regenerable`) cannot mask a high risk (`irreversible`); a cached decision is
 * re-evaluated on every call, so a denied action can never become allowed by dedupe.
 * Paket D (J16): the question set only asks what the state actually supports
 * (tool + excerpt + cwd); user intent is not invented.
 */
export const HOOK_ID = "tool-gate";
export const DATA_CLASSES = ["tool-input"];
export const GATE_VERSION = 1;

const MAX_EXCERPT_BYTES = 1024;
const CACHE_LIMIT = 50;

/** Decision-relevant risk predicates (ordered by consequence, used for reporting/confirm). */
export const RISK_PREDICATES = [
	"irreversible",
	"accesses_credentials",
	"privileged_or_remote_execution",
	"touches_outside_workspace",
	"uses_network",
	"writes_files",
] as const;

/** Predicates with noul ≥ 0.5, in RISK order — independent evaluation (R13). */
export function riskPredicatesAbove(result: any, threshold = 0.5): string[] {
	const answers = result?.answers ?? {};
	return RISK_PREDICATES.filter((id) => typeof answers?.[id]?.noul === "number" && answers[id].noul >= threshold);
}

/** Highest-probability risk predicate — enum for receipts, benign predicates excluded. */
export function riskTopPredicate(result: any): string | null {
	const answers = result?.answers ?? {};
	let top: string | null = null;
	let best = -1;
	for (const id of RISK_PREDICATES) {
		const value = answers?.[id]?.noul;
		if (typeof value === "number" && value > best) {
			best = value;
			top = id;
		}
	}
	return top;
}

registerQuestionContract({
	hook: HOOK_ID,
	version: GATE_VERSION,
	description:
		"A4: independent risk predicates for a grey-zone tool input (writes_files, touches_outside_workspace, uses_network, accesses_credentials, privileged_or_remote_execution, irreversible, regenerable)",
});

export interface ToolGateMeta {
	would?: (result: any) => string | null;
	would_action?: (result: any) => string | null;
	session?: string | null;
	questionsVersion?: string;
	truncated?: boolean;
}

export interface ToolGateDeps {
	decide: (request: any, origin: "automatic_hook", hook: string, meta?: ToolGateMeta) => Promise<any>;
	env?: Record<string, string | undefined>;
}

/** Deterministic "is this worth a semantic look?" prefilter (keeps JEV off read-only calls). */
const MUTATING_HINTS: RegExp[] = [
	/\bopen\s*\([^)]*['"](?:w|a|x)/,
	/writeFile|write_text|write_bytes|appendFile|createWriteStream/,
	/os\.remove|os\.unlink|os\.rmdir|shutil\.(?:rmtree|move|copy)|\.unlink\s*\(/,
	/subprocess\.|os\.system|os\.popen/,
	/\bpip\s+install|npm\s+(?:install|i|ci|publish)|cargo\s+install|apt(?:-get)?\s+install/,
	/\bgit\s+(?:push|reset|clean|checkout)/,
	/\bchmod|chown|chattr/,
	/(?:^|[^\w])rm\b|(?:^|[^\w])mv\b|(?:^|[^\w])cp\b/,
	/requests\.|httpx\.|urllib|socket\.|\bcurl\b|\bwget\b|\bssh\b|\bscp\b/,
];

export function looksMutating(code: string): boolean {
	return MUTATING_HINTS.some((pattern) => pattern.test(code));
}

export function buildGateQuestions(): Record<string, any> {
	return {
		writes_files: { type: "noul", instructions: "Does this code write or modify files?" },
		touches_outside_workspace: {
			type: "noul",
			instructions: "Does it touch paths outside the working directory (`cwd` in the state)?",
		},
		uses_network: { type: "noul", instructions: "Does it use the network?" },
		accesses_credentials: { type: "noul", instructions: "Does it read credentials, keys or secrets?" },
		privileged_or_remote_execution: { type: "noul", instructions: "Does it run privileged or remote execution?" },
		irreversible: { type: "noul", instructions: "If it goes wrong, is the effect irreversible or hard to undo?" },
		regenerable: { type: "noul", instructions: "Is the affected data regenerable from repository state?" },
	};
}

function hardBlockReason(rule: string): { block: true; reason: string } {
	return {
		block: true,
		reason: `[HOST GOVERNANCE REJECTION] Operation denied by host safety policy (${rule}). Destructive system operations are strictly prohibited. Do not attempt alternative execution or deletion commands.`,
	};
}

/** UI side effects must never change a verdict (F03): a throwing notify cannot swallow a block. */
function safeNotify(ctx: any, message: string, level: string): void {
	try {
		const pending = ctx?.ui?.notify?.(message, level);
		if (pending && typeof pending.then === "function")
			pending.catch(() => {
				/* async display failure */
			});
	} catch {
		/* display failure is not a policy failure */
	}
}

export function createToolGate(deps: ToolGateDeps) {
	const env = deps.env ?? process.env;
	const cache = new Map<string, any>();
	// Validate CONFIRM_ON once: unknown predicates are ignored loudly instead of silently
	// disabling the live gate (Verify-Fix 24.09.).
	const confirmOnRaw = (env.PRIME_JEV_TOOLGATE_CONFIRM_ON ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const confirmOn = confirmOnRaw.filter((id) => (RISK_PREDICATES as readonly string[]).includes(id));
	const unknownConfirmOn = confirmOnRaw.filter((id) => !confirmOn.includes(id));
	if (unknownConfirmOn.length) {
		console.error(
			`[typesafe-bridge] PRIME_JEV_TOOLGATE_CONFIRM_ON ignores unknown predicates: ${unknownConfirmOn.join(", ")}`,
		);
	}

	const run = async (event: any, ctx: any): Promise<any> => {
		// --- Layer 1: deterministic floor (fail closed on its own errors) ---
		let verdict: FloorVerdict;
		let display: string;
		let payload: string;
		const floorFailure = (rule: string): { block: true; reason: string } => {
			safeNotify(ctx, `🛡️ [System-1 Guard] Floor-Prüfung fehlgeschlagen (fail-closed): ${rule}`, "warning");
			return {
				block: true,
				reason: "[HOST GOVERNANCE REJECTION] deterministic floor evaluation failed (fail-closed).",
			};
		};
		if (event?.toolName === "bash" && typeof event?.input?.command === "string") {
			payload = event.input.command;
			display = payload
				.replace(/[\r\n\t]+/g, " ")
				.trim()
				.slice(0, 50);
			try {
				verdict = evaluateBashFloor(payload);
			} catch {
				return floorFailure("bash");
			}
		} else if (event?.toolName === "ipython" && typeof event?.input?.code === "string") {
			payload = event.input.code;
			display = payload.replace(/\s+/g, " ").trim().slice(0, 50);
			try {
				verdict = evaluateIpythonFloor(payload);
			} catch {
				return floorFailure("ipython");
			}
		} else {
			return undefined;
		}

		if (verdict.kind === "block") {
			safeNotify(ctx, `🛡️ [System-1 Guard] Blockiert: ${display} (${verdict.rule})`, "warning");
			return hardBlockReason(verdict.rule);
		}

		if (verdict.kind === "warn") {
			const isInteractive = Boolean(ctx?.hasUI && process.stdout?.isTTY && !process.env.CI && !ctx?.headless);
			if (!isInteractive) {
				return {
					block: true,
					reason:
						"[HOST GOVERNANCE REJECTION] Operation requires interactive human confirmation, but no interactive TTY is available.",
				};
			}
			if (typeof ctx?.ui?.confirm === "function") {
				const allowed = await requestConfirmation(
					(options) =>
						ctx.ui.confirm(
							"Sicherheitsprüfung (Host Governance)",
							`Potentiell riskantes Kommando/Code:\n  ${display}\n\nAusführung erlauben?`,
							options,
						),
					ctx.signal,
				);
				if (!allowed) {
					return {
						block: true,
						reason: "[HOST GOVERNANCE REJECTION] Operation denied by operator or confirmation timed out after 30s.",
					};
				}
			} else {
				return {
					block: true,
					reason:
						"[HOST GOVERNANCE REJECTION] Operation requires interactive confirmation, but confirm() dialog is unavailable.",
				};
			}
		}

		// --- Layer 2: JEV grey zone (only allowed but mutating-looking inputs) ---
		const mode = hookMode(HOOK_ID, env);
		if (mode === "off") return undefined;
		if (!mayRun(HOOK_ID, DATA_CLASSES, env)) return undefined;
		if (!looksMutating(payload)) return undefined;
		const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : null;
		const rawSession = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : null;
		const session = typeof rawSession === "string" && rawSession.length > 0 ? rawSession : null;
		// Opt-in candidate policy: cache computation only within a known session.
		// This does NOT certify source freshness or emit a receipt for every cache use.
		const dedupeKey = createHash("sha256")
			.update(JSON.stringify([session, event.toolName, payload, cwd, questionsVersionFor(HOOK_ID)]))
			.digest("hex");
		const cut = excerptOf(payload, MAX_EXCERPT_BYTES);
		const isInteractive = () => Boolean(ctx?.hasUI && process.stdout?.isTTY && !process.env.CI && !ctx?.headless);
		// J20: single source of truth for the action this gate takes on a result — used both
		// for the actual flow and for the audit field (`would_action` in receipt/eval).
		const actionFor = (value: any): "allow" | "confirm" | "deny" | "none" => {
			if (mode !== "live") return "none";
			if (!riskTopPredicate(value)) return "allow";
			const listed = riskPredicatesAbove(value).find((id) => confirmOn.includes(id));
			if (!listed) return "allow";
			if (!isInteractive()) return "deny";
			return typeof ctx?.ui?.confirm === "function" ? "confirm" : "deny";
		};

		// Cached predicates are re-evaluated on every call: dedupe must never turn a denied
		// action into an allowed one (R14) — only the JEV request itself is deduplicated.
		let result = session === null ? undefined : cache.get(dedupeKey);
		if (!result) {
			result = await deps.decide(
				{
					method: "system_one",
					params: {
						state: {
							tool: event.toolName,
							excerpt: cut.excerpt,
							excerpt_digest: cut.digest,
							excerpt_truncated: cut.truncated,
							cwd,
						},
						questions: buildGateQuestions(),
					},
				},
				"automatic_hook",
				HOOK_ID,
				{
					would: riskTopPredicate,
					would_action: actionFor,
					session,
					questionsVersion: questionsVersionFor(HOOK_ID),
					truncated: cut.truncated,
				},
			);
			if (session !== null) cache.set(dedupeKey, result);
			if (cache.size > CACHE_LIMIT) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
		}

		const top = riskTopPredicate(result);
		if (!top) return undefined;

		if (mode === "advisory" || mode === "live") {
			safeNotify(
				ctx,
				`JEV-Hinweis (Grauzone): auffälligstes Risiko-Prädikat bei Tool \`${event.toolName}\`: ${top}. Deterministische Regeln behalten Vorrang.`,
				"info",
			);
		}

		if (mode === "live") {
			const action = actionFor(result);
			if (action === "deny") {
				// Live without an interactive TTY fails closed (documented J20 semantics).
				const reason = isInteractive()
					? "[HOST GOVERNANCE REJECTION] Semantic grey-zone check requires confirmation, but confirm() is unavailable."
					: "[HOST GOVERNANCE REJECTION] Semantic grey-zone confirmation required, but no interactive TTY is available.";
				return { block: true, reason };
			}
			if (action === "confirm") {
				const allowed = await requestConfirmation(
					(options) =>
						ctx.ui.confirm(
							"JEV-Grauzonen-Prüfung (advisory)",
							`Auffälliges Prädikat: ${riskPredicatesAbove(result).find((id) => confirmOn.includes(id))}\n  ${display}\n\nAusführung erlauben?`,
							options,
						),
					ctx.signal,
				);
				if (!allowed)
					return {
						block: true,
						reason: "[HOST GOVERNANCE REJECTION] Semantic grey-zone check denied by operator or timed out.",
					};
			}
		}
		return undefined;
	};

	// Containment: a JEV/other failure must never break the tool path — the deterministic
	// layer already ran, so "no verdict" equals the floor's outcome (fail-open to the floor).
	return async (event: any, ctx: any): Promise<any> => {
		try {
			return await run(event, ctx);
		} catch {
			return undefined;
		}
	};
}
