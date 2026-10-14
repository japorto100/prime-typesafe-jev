import { createHash } from "node:crypto";
import { excerptOf } from "../core/excerpt.ts";
import { questionsVersionFor, registerQuestionContract } from "../core/question-registry.ts";
import type { QueueSnapshot } from "../receipts.ts";
import { type AsyncQueueStats, createAsyncJobRunner } from "./async-lifecycle.ts";
import { hookMode, mayRun } from "./modes.ts";
import { createRunContext, type RunContext } from "./run-context.ts";

/**
 * A6 Result-Triage (`tool_result`) — Phase 5, shadow. Paket D (J13): bounded queue,
 * guard re-checked before send, recent-evidence signatures give the "new evidence"
 * question a real reference (J16). Never mutates `content` — "never delete, only hint".
 *
 * D05/D14 (Audit 26.09.): dedup and history are per session (identical output in B is new
 * evidence in B; `recent_evidence_signatures` answers for its own session), jobs are bound
 * to the session's run epoch, and the queue carries the runner's load contract — per-session
 * coalescing, pending/byte caps, a queue-wait deadline and visible counters via `stats()`.
 */
export const HOOK_ID = "result-triage";
export const DATA_CLASSES = ["tool-result"];
export const TRIAGE_VERSION = 1;

const MIN_BYTES = 32 * 1024;
const MAX_EXCERPT = 1024;
const HISTORY_DEPTH = 3;

registerQuestionContract({
	hook: HOOK_ID,
	version: TRIAGE_VERSION,
	description:
		"A6: relevance/failure triage for a large tool result (is_relevant_to_current_problem, contains_new_evidence, contains_a_failure, failure_category choice, can_be_recovered_from_artifact)",
});

export interface TriageDeps {
	decide: (
		request: any,
		origin: "automatic_hook",
		hook: string,
		meta?: {
			would?: (result: any) => string | null;
			session?: string | null;
			questionsVersion?: string;
			truncated?: boolean;
			queue?: QueueSnapshot | null;
		},
	) => Promise<any>;
	env?: Record<string, string | undefined>;
	runContext?: RunContext;
}

export function buildTriageQuestions(): Record<string, any> {
	return {
		is_relevant_to_current_problem: { type: "noul", instructions: "Is this result relevant to the current problem?" },
		contains_new_evidence: {
			type: "noul",
			instructions: "Does it contain evidence not already seen in this session (see `recent_evidence_signatures`)?",
		},
		contains_a_failure: { type: "noul", instructions: "Does it contain a failure or error?" },
		failure_category: {
			type: "choice",
			instructions: "If it contains a failure, what category fits best?",
			criteria: {
				code_bug: "A defect in the code under test.",
				transient: "A transient/environmental failure (network, flake, timeout).",
				config: "A configuration or dependency problem.",
				data: "Bad or unexpected input data.",
				none: "No failure is contained.",
				unknown: "Not enough information to categorize.",
			},
		},
		can_be_recovered_from_artifact: {
			type: "noul",
			instructions: "Can the full result be recovered from a file/artifact if only a short excerpt were kept?",
		},
	};
}

export function resultText(event: any): string {
	const content = event?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n");
	}
	return "";
}

export function topTriageSignal(result: any): string | null {
	const answer = result?.answers;
	if (typeof answer?.contains_a_failure?.noul === "number" && answer.contains_a_failure.noul >= 0.5) {
		const category = answer?.failure_category?.choice;
		return typeof category === "string" ? `failure:${category}` : "contains_a_failure";
	}
	let top: string | null = null;
	let best = -1;
	for (const id of ["is_relevant_to_current_problem", "contains_new_evidence", "can_be_recovered_from_artifact"]) {
		const value = answer?.[id]?.noul;
		if (typeof value === "number" && value > best) {
			best = value;
			top = id;
		}
	}
	return top;
}

export interface TriageHandler {
	(event: any, ctx: any): Promise<undefined>;
	pending(): Promise<void>;
	/** D14: live load-contract counters (active/pending/bytes, dropped/coalesced/expired/gated). */
	stats(): AsyncQueueStats;
}

/** D05: one dedup/history scope per stable session id; identity-less calls share the null scope. */
interface TriageSession {
	seen: Set<string>;
	history: string[];
}
const MAX_TRIAGE_SESSIONS = 8;
const MAX_SEEN_PER_SESSION = 500;

export function createResultTriageHandler(deps: TriageDeps): TriageHandler {
	const env = deps.env ?? process.env;
	const queueLimit = (name: string, fallback: number): number => {
		const value = Number(env[name]);
		return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
	};
	const runner = createAsyncJobRunner(1, {
		maxPending: queueLimit("PRIME_JEV_TRIAGE_MAX_PENDING", 32),
		maxRetainedBytes: queueLimit("PRIME_JEV_TRIAGE_MAX_BYTES", 8 * 1024 * 1024),
		maxQueueWaitMs: queueLimit("PRIME_JEV_TRIAGE_MAX_WAIT_MS", 60_000),
	});
	const run = deps.runContext ?? createRunContext();
	const sessions = new Map<string, TriageSession>();
	const sessionScope = (key: string): TriageSession => {
		let scope = sessions.get(key);
		if (!scope) {
			scope = { seen: new Set(), history: [] };
			sessions.set(key, scope);
			if (sessions.size > MAX_TRIAGE_SESSIONS) {
				const oldest = sessions.keys().next().value;
				if (oldest !== undefined && oldest !== key) sessions.delete(oldest);
			}
			return scope;
		}
		// Refresh recency so an active session is not the next eviction candidate.
		sessions.delete(key);
		sessions.set(key, scope);
		return scope;
	};

	const handler = async (event: any, ctx: any): Promise<undefined> => {
		const mode = hookMode(HOOK_ID, env);
		if (mode === "off") return undefined;
		if (!mayRun(HOOK_ID, DATA_CLASSES, env)) return undefined;
		// Rename 25.09.2026: compact-Spillname gewinnt, der Altname gilt weiter (Shim auf der Leseseite).
		const spill = env.PRIME_COMPACT_SPILL_MAX_BYTES ?? env.PRIME_LAB_SPILL_MAX_BYTES;
		if (spill && spill !== "0" && spill.toLowerCase() !== "false") return undefined; // spill already owns large outputs

		const text = resultText(event);
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes <= MIN_BYTES) return undefined; // "> 32 KiB" — exactly 32 KiB is not large
		// D05: dedup and history are per session — the identical output in B is NEW evidence in B.
		const session = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : null;
		const scope = sessionScope(session ?? "\u0000no-session");
		// Cheap duplicate gate over the edges only; the full digest is computed in the job
		// (hashing a 10 MiB result synchronously would block the event loop for ~80 ms).
		const edgeKey = createHash("sha256")
			.update(`${bytes}\n${text.slice(0, 512)}\n${text.slice(-512)}`)
			.digest("hex");
		if (scope.seen.has(edgeKey)) return undefined;
		scope.seen.add(edgeKey);
		if (scope.seen.size > MAX_SEEN_PER_SESSION) {
			const oldest = scope.seen.values().next().value;
			if (oldest !== undefined) scope.seen.delete(oldest);
		}

		const binding = run.bind(session);

		runner.enqueue({
			guard: () => hookMode(HOOK_ID, env) !== "off" && mayRun(HOOK_ID, DATA_CLASSES, env) && run.isCurrent(binding),
			// D14: the queue retains just this payload until send; a same-session result replaces it.
			bytes,
			coalesceKey: `result-triage:${session ?? "\u0000no-session"}`,
			run: async () => {
				const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
				const recent = [...scope.history];
				scope.history.push(digest);
				if (scope.history.length > HISTORY_DEPTH) scope.history.shift();
				const cut = excerptOf(text, MAX_EXCERPT);
				await deps.decide(
					{
						method: "system_one",
						params: {
							state: {
								tool: event?.toolName ?? "unknown",
								bytes,
								is_error: event?.isError === true,
								excerpt: cut.excerpt,
								excerpt_digest: cut.digest,
								excerpt_truncated: cut.truncated,
								recent_evidence_signatures: recent,
							},
							questions: buildTriageQuestions(),
						},
					},
					"automatic_hook",
					HOOK_ID,
					{
						would: topTriageSignal,
						session,
						questionsVersion: questionsVersionFor(HOOK_ID),
						truncated: cut.truncated,
						queue: runner.stats(),
					},
				);
			},
		});
		return undefined; // content is never mutated
	};

	return Object.assign(handler, { pending: () => runner.pending(), stats: () => runner.stats() });
}

export function registerResultTriage(pi: any, deps: TriageDeps): TriageHandler | undefined {
	if (hookMode(HOOK_ID, deps.env ?? process.env) === "off") return undefined;
	const handler = createResultTriageHandler(deps);
	pi.on("tool_result", handler);
	return handler;
}
