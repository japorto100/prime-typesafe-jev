import { createHash } from "node:crypto";
import { questionsVersionFor, registerQuestionContract } from "../core/question-registry.ts";
import { createAsyncJobRunner } from "./async-lifecycle.ts";
import { hookMode, mayRun } from "./modes.ts";
import { createRunContext, type RunContext } from "./run-context.ts";

/**
 * A5 Watchdog (`turn_end`) — Phase 5, shadow. Paket D (J13): bounded queue (concurrency 1),
 * guard re-checked before send, stale-bound visible hints, no parallel evaluations.
 * Verify-Fix 24.09.: jobs are bound to (session, run epoch) — the send requires a current
 * binding, the visible hint additionally requires the observed turn to still be current.
 *
 * Non-blocking by contract: the handler returns immediately; work runs in the shared
 * async-lifecycle runner. A stale result may still be measured (the receipt carries the
 * bound turn), but it never becomes a visible hint. Advisory only.
 */
export const HOOK_ID = "watchdog";
export const DATA_CLASSES = ["turn-facts"];
export const WATCHDOG_VERSION = 1;

const DEFAULT_EVERY = 3;
const MAX_EXCERPT = 512;
const HISTORY_DEPTH = 3;

registerQuestionContract({
	hook: HOOK_ID,
	version: WATCHDOG_VERSION,
	description:
		"A5: progress/stall sensing over compact turn facts (made_material_progress, stuck_in_loop, repeating_same_strategy, completion_claim_missing_evidence, should_invoke_reviewer, should_deepen_reasoning)",
});

export interface WatchdogDeps {
	decide: (
		request: any,
		origin: "automatic_hook",
		hook: string,
		meta?: {
			would?: (result: any) => string | null;
			session?: string | null;
			turn?: number | null;
			questionsVersion?: string;
			truncated?: boolean;
		},
	) => Promise<any>;
	env?: Record<string, string | undefined>;
	runContext?: RunContext;
}

export interface TurnFacts {
	turn: number;
	toolResults: number;
	errors: number;
	excerpt: string;
	excerpt_digest: string | null;
	excerpt_truncated: boolean;
}

export function buildWatchdogQuestions(): Record<string, any> {
	return {
		made_material_progress: {
			type: "noul",
			instructions: "Did this turn make material progress on the task (not just activity)?",
		},
		stuck_in_loop: { type: "noul", instructions: "Is the work stuck in a repeating loop?" },
		repeating_same_strategy: {
			type: "noul",
			instructions:
				"Is it repeating a strategy that already failed in an earlier turn (see `recent_error_signatures`)?",
		},
		completion_claim_missing_evidence: {
			type: "noul",
			instructions: "Does a completion claim lack executed evidence (tests, read-backs)?",
		},
		should_invoke_reviewer: {
			type: "noul",
			instructions: "Should an independent review step be invoked before continuing?",
		},
		should_deepen_reasoning: {
			type: "noul",
			instructions: "Does the next step need deeper reasoning than the current pace?",
		},
	};
}

export function turnFacts(event: any): TurnFacts {
	const turn = typeof event?.turnIndex === "number" ? event.turnIndex : -1;
	const results = Array.isArray(event?.toolResults) ? event.toolResults : [];
	const errors = results.filter((result: any) => result?.isError === true).length;
	const content = event?.message?.content;
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n");
	}
	const truncated = text.length > MAX_EXCERPT;
	const excerpt = truncated ? text.slice(-MAX_EXCERPT) : text;
	const digest = truncated ? createHash("sha256").update(text).digest("hex").slice(0, 16) : null;
	return { turn, toolResults: results.length, errors, excerpt, excerpt_digest: digest, excerpt_truncated: truncated };
}

function signatureOf(facts: TurnFacts): string | null {
	if (facts.errors <= 0 || !facts.excerpt) return null;
	return createHash("sha256").update(facts.excerpt).digest("hex").slice(0, 12);
}

/** True when this turn is worth a semantic look (errors always, otherwise cadence). */
export function shouldWatch(
	facts: TurnFacts,
	env: Record<string, string | undefined>,
): { run: boolean; reason: string } {
	if (facts.errors > 0) return { run: true, reason: "tool_error" };
	const every = Number(env.PRIME_JEV_WATCHDOG_EVERY ?? DEFAULT_EVERY);
	const cadence = Number.isFinite(every) && every > 0 ? every : DEFAULT_EVERY;
	if (facts.turn >= 0 && facts.turn % cadence === 0) return { run: true, reason: "cadence" };
	return { run: false, reason: "cadence_skip" };
}

export function topWatchdogSignal(result: any): string | null {
	let top: string | null = null;
	let best = -1;
	for (const [id, answer] of Object.entries(result?.answers ?? {}) as Array<[string, any]>) {
		if (typeof answer?.noul === "number" && answer.noul > best) {
			best = answer.noul;
			top = id;
		}
	}
	return top;
}

export interface WatchdogHandler {
	(event: any, ctx: any): Promise<undefined>;
	pending(): Promise<void>;
}

/**
 * D05: turn progress and error history are per session — two interleaved sessions must not
 * overwrite each other's `state.turn` (that stale-check would compare a foreign turn).
 */
interface WatchdogSessionState {
	turn: number;
	history: Array<{ turn: number; errors: number; signature: string | null }>;
}
const MAX_WATCHDOG_SESSIONS = 8;

export function createWatchdogHandler(deps: WatchdogDeps): WatchdogHandler {
	const env = deps.env ?? process.env;
	const runner = createAsyncJobRunner(1);
	const run = deps.runContext ?? createRunContext();
	const sessions = new Map<string, WatchdogSessionState>();
	const stateOf = (session: string | null): WatchdogSessionState => {
		const key = session ?? "\u0000no-session";
		let state = sessions.get(key);
		if (!state) {
			state = { turn: -1, history: [] };
			sessions.set(key, state);
			if (sessions.size > MAX_WATCHDOG_SESSIONS) {
				const oldest = sessions.keys().next().value;
				if (oldest !== undefined && oldest !== key) sessions.delete(oldest);
			}
			return state;
		}
		sessions.delete(key);
		sessions.set(key, state);
		return state;
	};

	const handler = async (event: any, ctx: any): Promise<undefined> => {
		const mode = hookMode(HOOK_ID, env);
		if (mode === "off") return undefined;
		if (!mayRun(HOOK_ID, DATA_CLASSES, env)) return undefined;

		const facts = turnFacts(event);
		const session = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : null;
		const state = stateOf(session);
		state.turn = facts.turn;
		const gate = shouldWatch(facts, env);
		if (!gate.run) return undefined;

		const boundTurn = facts.turn;
		const recent = state.history
			.map((entry) => entry.signature)
			.filter((value): value is string => typeof value === "string");
		state.history = [...state.history, { turn: facts.turn, errors: facts.errors, signature: signatureOf(facts) }].slice(
			-HISTORY_DEPTH,
		);
		const binding = run.bind(session);

		runner.enqueue({
			// Send gate: mode/G1 plus the run binding (session + run epoch). Turn progress while a
			// job waits does NOT abort the measurement — the receipt carries the bound turn — but
			// the visible apply below additionally requires the observed turn to still be current.
			guard: () => hookMode(HOOK_ID, env) !== "off" && mayRun(HOOK_ID, DATA_CLASSES, env) && run.isCurrent(binding),
			run: async () => {
				const result = await deps.decide(
					{
						method: "system_one",
						params: { state: { ...facts, recent_error_signatures: recent }, questions: buildWatchdogQuestions() },
					},
					"automatic_hook",
					HOOK_ID,
					{
						would: topWatchdogSignal,
						session,
						turn: boundTurn,
						questionsVersion: questionsVersionFor(HOOK_ID),
						truncated: facts.excerpt_truncated,
					},
				);
				const top = topWatchdogSignal(result);
				const modeNow = hookMode(HOOK_ID, env);
				if (
					(modeNow === "advisory" || modeNow === "live") &&
					top &&
					state.turn === boundTurn &&
					run.isCurrent(binding)
				) {
					try {
						ctx?.ui?.notify?.(
							`JEV-Hinweis (Fortschritt): auffälligstes Signal: ${top}. Der Agent behält die Entscheidung.`,
							"info",
						);
					} catch {
						/* display failure is not a policy failure */
					}
				}
			},
		});
		return undefined; // non-blocking: the turn never waits for JEV
	};

	return Object.assign(handler, { pending: () => runner.pending() });
}

export function registerWatchdog(pi: any, deps: WatchdogDeps): void {
	if (hookMode(HOOK_ID, deps.env ?? process.env) === "off") return;
	pi.on("turn_end", createWatchdogHandler(deps));
}
