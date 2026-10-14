import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withCodingPolicy } from "./coding-policy.ts";
import { resolveAgentDir } from "./core/agent-dir.ts";
import { createBudget } from "./core/budget.ts";
import type { Reservation } from "./core/budget.ts";
import {
	appendEvalRow,
	DECISION_RULES_VERSION,
	EVAL_SCHEMA,
	evalEnabled,
	evalFile,
	extractPredictions,
	type Prediction,
	safeModelId,
	sanitizeIdentifier,
} from "./core/eval-channel.ts";
import { createFlowGuard } from "./core/flow-guard.ts";
import { activeProvider, assertProviderSupports } from "./core/provider.ts";
import { questionsVersion } from "./core/question-registry.ts";
import { validateChoiceAnswer, validateNoulAnswer, validateScoreAnswer } from "./core/validator.ts";
import { registerCompaction } from "./hooks/compaction.ts";
import { g1Granted, hookMode } from "./hooks/modes.ts";
import { registerRefineAdvisor } from "./hooks/refine-advisor.ts";
import { registerResultTriage } from "./hooks/result-triage.ts";
import { registerRouter } from "./hooks/router.ts";
import { createRunContext } from "./hooks/run-context.ts";
import { createToolGate } from "./hooks/tool-gate.ts";
import { registerWatchdog } from "./hooks/watchdog.ts";
import { advisoryInputHandler, inputTriageEnabled } from "./input-triage.ts";
import {
	appendCallReceipt,
	callReceipt,
	type QueueSnapshot,
	type ReceiptOrigin,
	type ReceiptOutcome,
} from "./receipts.ts";
import { acquireHostBridge } from "./transport.ts";

/**
 * TypeSafe Jev Bridge Extension für Prime Agent.
 *
 * Starts a private per-host Unix socket, inherited via PRIME_JEV_SOCKET.
 * Latency and semantic accuracy require measurement; neither is guaranteed here.
 *
 * Kommuniziert über den Decision-Provider-Seam (`core/provider.ts`, heute genau ein
 * Provider: jev → https://api.typesafe.ai/v1/systemone, model: jev-latest).
 * Klinkt sich zusätzlich in pi.on("tool_call") als deterministischer 2-Layer-Floor ein
 * (bash weiterhin für Fremd-Hosts; unter Prime 0.9.5 ist ipython das reale Tool).
 */

// Dynamische API-Key-Ermittlung (unterstützt /login auth.typesafe.key sowie flache Keys)
function getApiKey(): string | null {
	try {
		const authFile = path.join(resolveAgentDir(), "auth.json");
		if (fs.existsSync(authFile)) {
			const auth = JSON.parse(fs.readFileSync(authFile, "utf-8"));
			const cred = auth.typesafe;
			if (typeof cred === "string" && cred.trim()) return cred.trim();
			if (cred && typeof cred === "object" && typeof cred.key === "string" && cred.key.trim()) return cred.key.trim();
			if (typeof auth.typesafe_api_key === "string" && auth.typesafe_api_key.trim())
				return auth.typesafe_api_key.trim();
		}
	} catch {
		/* ignore parse errors */
	}
	return process.env.TYPESAFE_API_KEY || null;
}

function classifyOutcome(error: unknown, fallback: ReceiptOutcome): ReceiptOutcome {
	const name = (error as { name?: string } | null)?.name;
	if (name === "TimeoutError" || name === "AbortError") return "timeout";
	if (name === "JevRateLimited" || name === "JevCircuitOpen") return "skipped";
	const message = error instanceof Error ? error.message : "";
	if (message.startsWith("JevBudgetExceeded")) return "skipped";
	return fallback;
}

/** Typed prediction extraction for the eval channel (batch or legacy shapes). */
function predictionsFor(result: any): Record<string, Prediction> | null {
	if (result?.answers && typeof result.answers === "object") return extractPredictions(result.answers);
	if (result && typeof result === "object") {
		if (typeof result.noul === "number") return extractPredictions({ decision: { type: "noul", noul: result.noul } });
		if (typeof result.choice === "string")
			return extractPredictions({
				decision: { type: "choice", choice: result.choice, probabilities: result.probabilities, confidence: result.confidence },
			});
		if (typeof result.score === "number")
			return extractPredictions({
				decision: { type: "score", score: result.score, probabilities: result.probabilities, confidence: result.confidence },
			});
	}
	return null;
}

export default function (pi: any) {
	let requestCount = 0;

	let lastStatusUpdate = 0;
	let activeUiContext: any = null;
	const budget = createBudget({ rootId: `pid:${process.pid}` });
	// Run binding for async advisor hooks (Verify-Fix 24.09., D05): epochs are per session —
	// a run start or session boundary invalidates only that session's queued jobs; stale
	// results are dropped, never displayed, and session B's work survives A's shutdown.
	const runContext = createRunContext();
	// Contrarian-Fix 24.09.: rolling-minute cap + consecutive-failure breaker for the upstream.
	const flow = createFlowGuard();
	const sessionIdOf = (ctx: any): string | null =>
		typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : null;

	// Throttled Footer-Status-Badge (schont den Node.js Event-Loop auf der i7-2600 CPU)
	const updateStatus = (ctx?: any, force = false) => {
		const ui = ctx?.ui || activeUiContext?.ui;
		if (!ui?.setStatus) return;
		const now = Date.now();
		if (!force && now - lastStatusUpdate < 1000) return;
		lastStatusUpdate = now;

		const currentKey = getApiKey();
		const isMock = !currentKey;
		const theme = ui.theme;

		if (isMock) {
			const badge = theme?.fg ? theme.fg("warning", "⚠ Jev: UNAVAILABLE") : "⚠ Jev: UNAVAILABLE";
			ui.setStatus("typesafe-jev", badge);
		} else {
			const dot = theme?.fg ? theme.fg("success", "⚡") : "⚡";
			const text = theme?.fg
				? theme.fg("dim", ` Jev: CONFIGURED (${requestCount})`)
				: ` Jev: CONFIGURED (${requestCount})`;
			ui.setStatus("typesafe-jev", dot + text);
		}
	};

	// J09/Phase 2/B: every decision call goes through one receipt + budget + eval path.
	// Admission happens on the PREPARED (redacted) request size; metrics survive failures.
	const INSTANCE_ID = randomUUID();
	const dispatchWithReceipt = async (
		request: any,
		origin: ReceiptOrigin,
		hook: string,
		meta?: {
			would?: (result: any) => string | null;
			would_action?: (result: any) => string | null;
			candidates?: string[];
			candidatesTotal?: number;
			candidatesScored?: number;
			candidatesTruncated?: boolean;
			session?: string | null;
			turn?: number | null;
			questionsVersion?: string;
			truncated?: boolean;
			queue?: QueueSnapshot | null;
		},
	) => {
		requestCount++;
		updateStatus();
		const key = getApiKey();
		const started = performance.now();
		// J19/Contrarian: direct client calls are NOT on the hook mode ladder; `direct` is
		// the truthful marker (the old `live` claim was not backed by a ladder promotion).
		const mode = hook === "explicit_python" ? "direct" : hookMode(hook);
		const decisionId = randomUUID();
		const version = meta?.questionsVersion ?? questionsVersion();
		let providerId = "unknown";
		let result: any;
		let metrics: { bytesIn: number; bytesOut: number; redactions: number; model: string | null } = {
			bytesIn: 0,
			bytesOut: 0,
			redactions: 0,
			model: null,
		};
		let outcome: ReceiptOutcome = "error";
		let reservation: Reservation | null = null;
		try {
			providerId = activeProvider().id;
			if (flow.isOpen()) {
				const open = new Error("JevCircuitOpen: provider temporarily unavailable after repeated failures");
				open.name = "JevCircuitOpen";
				throw open;
			}
			const run = await runDecisionDetailed(request, key, !key, {
				onPrepared: (prepared) => {
					const reserved = budget.reserve(hook, prepared.bytesIn);
					if (!reserved) {
						throw new Error("JevBudgetExceeded: call budget reached; deterministic path required");
					}
					reservation = reserved;
				},
				beforeSend: () => {
					const rate = flow.checkRate();
					if (!rate.ok) {
						const limited = new Error("JevRateLimited: rolling-minute cap reached");
						limited.name = "JevRateLimited";
						throw limited;
					}
					flow.onSend();
				},
			});
			result = run.result;
			metrics = run;
			outcome = "answered";
			if (reservation !== null) budget.send(reservation);
			flow.onSuccess();
			return result;
		} catch (error) {
			metrics = (error as { jevMetrics?: typeof metrics })?.jevMetrics ?? metrics;
			outcome = classifyOutcome(error, outcome);
			if (reservation === null) {
				budget.noteSkipped(hook); // rejected/skipped attempts stay separate from sent quota
			} else if (outcome === "skipped") {
				// Reserved but never sent (rate cap): refund is reservation-bound (Policy B, JEV-06/07).
				const refund = budget.release(reservation);
				if (refund === "unavailable") {
					activeUiContext?.ui?.notify?.("JEV budget refund not persisted; state unavailable", "warning");
				}
				budget.noteSkipped(hook);
			}
			const name = (error as { name?: string } | null)?.name ?? "";
			const message = error instanceof Error ? error.message : "";
			if (
				outcome === "timeout" ||
				name === "JevOverloaded" ||
				message.startsWith("TypeSafe API Error") ||
				name === "TypeError"
			) {
				flow.onFailure();
			}
			throw error;
		} finally {
			// WP2 (25.09.): <agentDir>/receipts/jev.calls.jsonl; Altdatei `harness/jev-calls.jsonl`
			// bleibt als Historie (Reader nutzen die Union, z. B. router-eval).
			const file = path.join(resolveAgentDir(), "receipts", "jev.calls.jsonl");
			const row = callReceipt(
				request,
				result,
				outcome === "answered" ? "success" : "error",
				performance.now() - started,
				{
					hook,
					mode,
					origin,
					outcome,
					questions_version: version,
					provider: providerId,
					bytes_in: metrics.bytesIn,
					bytes_out: metrics.bytesOut,
					redactions: metrics.redactions,
					would: outcome === "answered" && result ? (meta?.would?.(result) ?? null) : null,
					would_action: outcome === "answered" && result ? (meta?.would_action?.(result) ?? null) : null,
					truncated: meta?.truncated === true,
					session: meta?.session ?? INSTANCE_ID,
					turn: meta?.turn ?? null,
					decision_id: decisionId,
					queue: meta?.queue ?? null,
				},
			);
			if (!appendCallReceipt(file, row)) {
				activeUiContext?.ui?.notify?.("JEV call receipt unavailable; invocation evidence incomplete", "warning");
			}
			if (evalEnabled()) {
				// Include failed/skipped dispatches: absence of an answer is not a negative prediction.
				const predictions = outcome === "answered" ? (predictionsFor(result) ?? {}) : {};
				{
					appendEvalRow(evalFile(), {
						schema: EVAL_SCHEMA,
						measurement_revision: "2",
						at: new Date().toISOString(),
						hook,
						mode,
						origin,
						g1_covered: origin === "automatic_hook",
						questions_version: version,
						provider: providerId,
						model: safeModelId(result?.model),
						rules_version: DECISION_RULES_VERSION,
						outcome,
						session: meta?.session ?? INSTANCE_ID,
						turn: meta?.turn ?? null,
						decision_id: decisionId,
						latency_ms: Math.max(0, Math.round(performance.now() - started)),
						candidates: meta?.candidates?.map((name) => sanitizeIdentifier(name) ?? name) ?? null,
						candidates_total: meta?.candidatesTotal ?? null,
						candidates_scored: meta?.candidatesScored ?? null,
						candidates_truncated: meta?.candidatesTruncated === true,
						would_action: outcome === "answered" && result ? (meta?.would_action?.(result) ?? null) : null,
						predictions,
					});
				}
			}
		}
	};

	const bridge = acquireHostBridge((request) => dispatchWithReceipt(request, "explicit_python", "explicit_python"));
	const SOCKET_PATH = bridge.socketPath;
	void bridge.ready.catch(() => {
		activeUiContext?.ui?.notify?.("JEV bridge startup failed", "error");
	});
	// Reload keeps the process-owned endpoint stable (Variant A); only a real quit retires it.

	// 5. Lifecycle & UI Hooks
	if (typeof pi?.on === "function") {
		pi.on("before_agent_start", (event: any, ctx: any) => {
			// New run boundary (Prime resets turnIndex here) — that session's queued jobs become stale.
			runContext.beginRun(sessionIdOf(ctx));
			runContext.noteSession(sessionIdOf(ctx));
			if (typeof event?.systemPrompt !== "string") return;
			return { systemPrompt: withCodingPolicy(event.systemPrompt) };
		});

		pi.on("session_start", async (_event: any, ctx: any) => {
			// Missing identity is not attributed to another session: a nameless boundary clears all slots.
			runContext.invalidate(sessionIdOf(ctx) ?? undefined);
			runContext.noteSession(sessionIdOf(ctx));
			activeUiContext = ctx;
			updateStatus(ctx, true);
		});

		// J12: only a real quit retires the endpoint; any reload path leaves it untouched.
		// Verify-Fix + D05: a session boundary invalidates that session's pending advisor results.
		pi.on("session_shutdown", (event: any, ctx: any) => {
			runContext.invalidate(sessionIdOf(ctx) ?? undefined);
			if (event?.reason === "quit" && typeof bridge.retire === "function") bridge.retire();
		});

		// Off by default; requires the legacy opt-in AND a G1 grant for the input-text data class
		// (Review 24.09., R23: the legacy path must not bypass the shared admission matrix).
		if (inputTriageEnabled(process.env) && g1Granted("input-triage", "input-text", process.env)) {
			pi.on(
				"input",
				advisoryInputHandler(async (text) =>
					dispatchWithReceipt(
						{
							method: "choice",
							params: {
								task: "Classify operator input for advisory UI hints only.",
								criteria: {
									CONTROL: "The operator explicitly wants to interrupt ongoing work.",
									EPHEMERAL: "An independent side question without changing the task.",
									OBJECTIVE_AMENDMENT: "An instruction or change to the current task.",
									UNKNOWN: "Ambiguous intent; no hint is justified.",
								},
								context: text,
							},
						},
						"automatic_hook",
						"input-triage",
					),
				),
			);
		}

		// A4 (Phase 4): deterministic floor + JEV grey zone (modes/G1 guarded; JEV never blocks).
		const toolGate = createToolGate({ decide: dispatchWithReceipt });
		pi.on("tool_call", async (event: any, ctx: any) => {
			if (ctx) activeUiContext = ctx;
			return toolGate(event, ctx);
		});

		// A2 router (Phase 3): registers only when its hook mode is not off (G1 + shadow/advisory).
		registerRouter(pi, { decide: dispatchWithReceipt });

		// A5/A6 (Phase 5): watchdog + result triage — non-blocking, shadow by default.
		registerWatchdog(pi, { decide: dispatchWithReceipt, runContext });
		registerResultTriage(pi, { decide: dispatchWithReceipt, runContext });

		// A3 (Phase 6): compaction relevance — shadow-only, always returns undefined.
		registerCompaction(pi, { decide: dispatchWithReceipt, runContext });

		// A8 (Phase 7): refine advisor — shadow-only, never touches the planner.
		registerRefineAdvisor(pi, { decide: dispatchWithReceipt, runContext });
	}

	// 6. TUI-Kommandos registrieren
	if (typeof pi?.registerCommand === "function") {
		pi.registerCommand("typesafe-status", {
			description: "Status der TypeSafe Jev Unix-Socket Bridge anzeigen",
			handler: async (_args: any, ctx: any) => {
				const currentKey = getApiKey();
				const isMock = !currentKey;
				let budgetState: string;
				try { budgetState = JSON.stringify(budget.summary().hookCalls); }
				catch { budgetState = "UNAVAILABLE (admission refused; inspect budget state)"; }
				const statusMsg = `TypeSafe Bridge: ${isMock ? "UNAVAILABLE (no credentials)" : "CONFIGURED (not a connectivity proof)"} | Provider: ${activeProvider().id} | Socket: ${SOCKET_PATH} | Requests: ${requestCount} | Budget: ${budgetState}`;
				if (ctx?.ui?.notify) {
					ctx.ui.notify(statusMsg, isMock ? "warning" : "info");
				} else {
					console.log(statusMsg);
				}
			},
		});

		pi.registerCommand("typesafe-key", {
			description: "Hinweise zur lokalen TypeSafe-Credential-Konfiguration (keine Key-Eingabe)",
			handler: async (_args: any, ctx: any) => {
				const message =
					"Keine API-Keys im Chat oder als Befehlsargument eingeben. " +
					"Vorhandene lokale Credentials bleiben unverändert. Alternativ TYPESAFE_API_KEY " +
					"über die geschützte lokale Startumgebung bereitstellen; der Bridge-Befehl " +
					"schreibt auth.json nicht. Falls hier ein Key eingegeben wurde, kann er bereits " +
					"in der Eingabehistorie stehen: beim Anbieter rotieren.";
				if (ctx?.ui?.notify) ctx.ui.notify(message, "warning");
				else console.log(message);
			},
		});
	}
}

/** Baut die Upstream-Questions aus einer Methode + Params (Batch und Legacy-Adapter). */
function buildQuestionsPayload(method: string, params: Record<string, any>): Record<string, any> {
	if (method === "system_one") {
		const questions = params.questions;
		if (!questions || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length) {
			throw new Error("JevInvalidRequest: questions must be a nonempty map");
		}
		for (const question of Object.values(questions) as any[]) {
			if (!question || !["choice", "score", "noul"].includes(question.type) || question.instructions == null) {
				throw new Error("JevInvalidRequest: invalid question");
			}
			if (
				question.type === "choice" &&
				(!question.criteria ||
					Array.isArray(question.criteria) ||
					typeof question.criteria !== "object" ||
					!Object.keys(question.criteria).length)
			) {
				throw new Error("JevInvalidRequest: choice requires criteria map");
			}
			if (
				question.type === "score" &&
				(!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10)
			) {
				throw new Error("JevInvalidRequest: score requires ordered criteria");
			}
		}
		return questions;
	}
	if (method === "choice") {
		const rawChoices = Array.isArray(params.choices)
			? params.choices
			: Array.isArray(params.options)
				? params.options
				: [];
		const criteriaObj: Record<string, string> = {};
		if (params.criteria && typeof params.criteria === "object" && !Array.isArray(params.criteria)) {
			Object.assign(criteriaObj, params.criteria);
		} else {
			for (const c of rawChoices) {
				criteriaObj[c] = String(c);
			}
		}
		return {
			decision: {
				type: "choice",
				instructions: params.task || params.instructions || "Wähle die zutreffende Option.",
				criteria: criteriaObj,
			},
		};
	}
	if (method === "score") {
		let scoreCriteria: string[] = [];
		if (Array.isArray(params.criteria)) {
			scoreCriteria = params.criteria.map(String);
		} else if (Array.isArray(params.rubric)) {
			scoreCriteria = params.rubric.map(String);
		} else if (typeof params.criterion === "string") {
			// Splitte z.B. "0 = safe, 1 = test broken, 2 = critical regression"
			const parts = params.criterion
				.split(/[,;\n]+/)
				.map((s: string) => s.trim())
				.filter(Boolean);
			if (parts.length >= 2 && parts.length <= 10) {
				scoreCriteria = parts;
			}
		}
		// An invented or truncated rubric changes the question, not just its encoding.
		if (scoreCriteria.length < 2 || scoreCriteria.length > 10) {
			throw new Error("JevInvalidRequest: score requires 2..10 explicit levels");
		}
		return {
			decision: {
				type: "score",
				instructions:
					params.instructions || params.task || params.criterion || "Bewerte den Zustand anhand der Rubrik.",
				criteria: scoreCriteria,
			},
		};
	}
	if (method === "noul") {
		return {
			decision: {
				type: "noul",
				instructions: params.condition || params.instructions || "Ist die Aussage oder Invariante wahr?",
			},
		};
	}
	throw new Error(`Unbekannte Jev-Methode: ${method}`);
}

/** Modell/Usage sind Receipt-Pflicht; jede Antwort läuft durch denselben Validator. */
function validateBatch(data: any, questionsPayload: Record<string, any>): void {
	if (typeof data?.model !== "string" || !data.model.trim()) {
		throw new Error("JevInvalidDecision: missing model");
	}
	if (!data?.usage || typeof data.usage !== "object" || Array.isArray(data.usage)) {
		throw new Error("JevInvalidDecision: missing usage");
	}
	if (!Object.values(data.usage).some((value) => typeof value === "number" && Number.isFinite(value))) {
		throw new Error("JevInvalidDecision: usage carries no numeric counters");
	}
	for (const [id, question] of Object.entries(questionsPayload)) {
		const answer = data?.answers?.[id];
		if (!answer || answer.type !== question.type) throw new Error("JevInvalidDecision: missing or mismatched answer");
		if (question.type === "noul") {
			validateNoulAnswer(answer);
		} else if (question.type === "choice") {
			validateChoiceAnswer(answer, Object.keys(question.criteria));
		} else {
			validateScoreAnswer(answer, question.criteria);
		}
	}
}

export interface DecisionRunMetrics {
	result: any;
	bytesIn: number;
	bytesOut: number;
	redactions: number;
	model: string | null;
}

type RunMetrics = Omit<DecisionRunMetrics, "result">;

export interface DecisionRunOptions {
	/** Admission hook: called with the prepared (redacted, size-checked) request. */
	onPrepared?: (prepared: { bytesIn: number; redactions: number }) => void | Promise<void>;
	/** Flow-control hook (rate cap): after admission, immediately before the send. */
	beforeSend?: (prepared: { bytesIn: number; redactions: number }) => void | Promise<void>;
}

function attachMetrics(error: unknown, metrics: RunMetrics): void {
	try {
		(error as { jevMetrics?: RunMetrics }).jevMetrics = metrics;
	} catch {
		/* frozen error — caller defaults remain */
	}
}

/**
 * Verarbeitet eine Entscheidung über den aktiven Provider (heute: jev) inklusive
 * Capability-Prüfung und gemeinsamem Validator (Batch und Legacy-Adapter).
 * Metriken hängen auch an geworfenen Fehlern, damit Receipts `bytes_in` behalten, wenn der
 * Versand stattfand und erst die Validierung scheitert (Review 24.09., R24).
 */
export async function runDecisionDetailed(
	req: JevRequest,
	apiKey: string | null,
	isMockMode: boolean,
	options: DecisionRunOptions = {},
): Promise<DecisionRunMetrics> {
	const { method, params } = req;

	// No decision provider bound → error, never a fabricated result.
	if (isMockMode || !apiKey) {
		throw new Error("JevUnavailable: no authenticated decision provider");
	}

	const provider = activeProvider();
	assertProviderSupports(provider, method);
	const questionsPayload = buildQuestionsPayload(method, params);
	const state = params.state ?? params.context ?? "";

	const prepared = provider.prepare({ state, questions: questionsPayload, env: process.env });
	try {
		if (options.onPrepared) await options.onPrepared({ bytesIn: prepared.bytesIn, redactions: prepared.redactions });
		if (options.beforeSend) await options.beforeSend({ bytesIn: prepared.bytesIn, redactions: prepared.redactions });
	} catch (error) {
		// Metrics survive pre-send refusals too, so a reserved-but-never-sent call can refund.
		attachMetrics(error, { bytesIn: prepared.bytesIn, bytesOut: 0, redactions: prepared.redactions, model: null });
		throw error;
	}

	let sent: { data: any; bytesOut: number; model: string | null };
	try {
		sent = await provider.send(prepared, apiKey);
	} catch (error) {
		attachMetrics(error, { bytesIn: prepared.bytesIn, bytesOut: 0, redactions: prepared.redactions, model: null });
		throw error;
	}
	const metrics: RunMetrics = {
		bytesIn: prepared.bytesIn,
		bytesOut: sent.bytesOut,
		redactions: prepared.redactions,
		model: sent.model,
	};
	const data = sent.data;
	const model = sent.model;

	try {
		if (method === "system_one") {
			validateBatch(data, questionsPayload);
			return { result: data, ...metrics };
		}

		const decision = data?.answers?.decision;
		if (!decision) {
			throw new Error("TypeSafe API lieferte kein decision-Feld im Antwort-Payload");
		}
		if (decision.type !== method) {
			throw new Error("JevInvalidDecision: missing or mismatched answer");
		}

		if (method === "choice") {
			validateChoiceAnswer(decision, Object.keys(questionsPayload.decision.criteria));
			return {
				result: {
					choice: decision.choice,
					confidence: decision.confidence,
					probabilities: decision.probabilities,
					distribution: decision.probabilities, // Compatibility alias for existing callers.
					model, // keep metadata on the return path (Review §8)
					usage: data?.usage ?? null,
				},
				...metrics,
			};
		}

		if (method === "score") {
			validateScoreAnswer(decision, questionsPayload.decision.criteria);
			return {
				result: {
					score: decision.score,
					confidence: decision.confidence,
					probabilities: decision.probabilities,
					legend: decision.legend,
					model,
					usage: data?.usage ?? null,
				},
				...metrics,
			};
		}

		if (method === "noul") {
			validateNoulAnswer(decision);
			const prob = decision.noul;
			return {
				result: {
					verdict: prob >= 0.5,
					probability: prob,
					noul: prob, // Preserve the native probability; verdict is only the legacy adapter.
					model,
					usage: data?.usage ?? null,
				},
				...metrics,
			};
		}

		throw new Error(`Unbekannte Jev-Methode: ${method}`);
	} catch (error) {
		attachMetrics(error, metrics);
		throw error;
	}
}

export async function handleDecision(req: JevRequest, apiKey: string | null, isMockMode: boolean): Promise<any> {
	return (await runDecisionDetailed(req, apiKey, isMockMode)).result;
}

interface JevRequest {
	method: "choice" | "score" | "noul" | string;
	params: Record<string, any>;
}
