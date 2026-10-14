import { questionsVersionFor, registerQuestionContract } from "../core/question-registry.ts";
import { createAsyncJobRunner } from "./async-lifecycle.ts";
import { hookMode, mayRun } from "./modes.ts";
import { createRunContext, type RunContext } from "./run-context.ts";

/**
 * A8 Refine-Advisor (`session_before_refine`) — Phase 7, lab-only, shadow.
 *
 * **Preflight semantics (J15):** in Prime 0.9.6 this event fires BEFORE refinement
 * planning; there is no generated proposal yet. The questions therefore target the
 * planning round ("would this lesson be worth persisting?"), not a concrete proposal.
 * A proposal-level review belongs to a later point in the pipeline.
 *
 * INVARIANT: always returns `undefined` — the refine planner is never suppressed or
 * altered; the hook only measures reuse-worthiness (receipts/eval). Paket D (J13):
 * bounded queue via the shared async-lifecycle runner.
 */
export const HOOK_ID = "refine";
export const DATA_CLASSES = ["metrics"];
export const REFINE_VERSION = 1;

const MAX_INSTRUCTION_CHARS = 300;

registerQuestionContract({
	hook: HOOK_ID,
	version: REFINE_VERSION,
	description:
		"A8: reuse-worthiness of a planned refinement round (repeated_pattern, project_specific, generalizable, already_covered, stable_enough, one_off)",
});

export interface RefineDeps {
	decide: (
		request: any,
		origin: "automatic_hook",
		hook: string,
		meta?: { would?: (result: any) => string | null; session?: string | null; questionsVersion?: string },
	) => Promise<any>;
	env?: Record<string, string | undefined>;
	runContext?: RunContext;
}

export function buildRefineQuestions(): Record<string, any> {
	return {
		repeated_pattern: {
			type: "noul",
			instructions: "Does this refinement round address a repeated, recurring pattern rather than a one-off?",
		},
		project_specific: {
			type: "noul",
			instructions: "Is the knowledge project-specific in a way the harness must not generalize?",
		},
		generalizable: { type: "noul", instructions: "Would this refinement generalize safely beyond this one incident?" },
		already_covered: {
			type: "noul",
			instructions: "Is this already covered by an existing harness entry or guideline?",
		},
		stable_enough: {
			type: "noul",
			instructions: "Is the underlying lesson stable enough to persist (not still in flux)?",
		},
		one_off: {
			type: "noul",
			instructions: "Is this most likely a one-off event that should not become harness knowledge?",
		},
	};
}

export function refineFacts(event: any): Record<string, unknown> {
	const preparation = event?.preparation ?? {};
	const instructions = typeof preparation?.instructions === "string" ? preparation.instructions : "";
	const history = Array.isArray(preparation?.history) ? preparation.history.length : 0;
	const conversation = typeof preparation?.conversationText === "string" ? preparation.conversationText : "";
	const planningState =
		preparation?.planningState && typeof preparation.planningState === "object"
			? Object.keys(preparation.planningState).slice(0, 12)
			: [];
	return {
		trigger: typeof preparation?.trigger === "string" ? preparation.trigger : "unknown",
		scope: typeof preparation?.scope === "string" ? preparation.scope : "unknown",
		history_count: history,
		conversation_bytes: Buffer.byteLength(conversation, "utf8"),
		instructions_excerpt: instructions.slice(0, MAX_INSTRUCTION_CHARS),
		planning_state_keys: planningState,
	};
}

export function topRefineSignal(result: any): string | null {
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

export interface RefineHandler {
	(event: any, ctx: any): Promise<undefined>;
	pending(): Promise<void>;
}

export function createRefineAdvisorHandler(deps: RefineDeps): RefineHandler {
	const env = deps.env ?? process.env;
	const runner = createAsyncJobRunner(1);
	const run = deps.runContext ?? createRunContext();
	// D05: identical planner facts are only "already seen" within the session that saw them.
	const sessions = new Map<string, Set<string>>();
	const seenOf = (session: string | null): Set<string> => {
		const key = session ?? "\u0000no-session";
		let seen = sessions.get(key);
		if (!seen) {
			seen = new Set();
			sessions.set(key, seen);
			if (sessions.size > 8) {
				const oldest = sessions.keys().next().value;
				if (oldest !== undefined && oldest !== key) sessions.delete(oldest);
			}
			return seen;
		}
		sessions.delete(key);
		sessions.set(key, seen);
		return seen;
	};

	const handler = async (event: any, ctx: any): Promise<undefined> => {
		const mode = hookMode(HOOK_ID, env);
		if (mode === "off") return undefined;
		if (!mayRun(HOOK_ID, DATA_CLASSES, env)) return undefined;

		const facts = refineFacts(event);
		const session = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : null;
		const seen = seenOf(session);
		const dedupeKey = JSON.stringify(facts);
		if (seen.has(dedupeKey)) return undefined;
		seen.add(dedupeKey);
		if (seen.size > 200) {
			const oldest = seen.values().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}

		const binding = run.bind(session);
		// C030: the host's own cancel channel for this refinement round (event.signal);
		// a host-cancelled round must not be measured late.
		const hostSignal = event?.signal;
		runner.enqueue({
			guard: () =>
				hookMode(HOOK_ID, env) !== "off" &&
				mayRun(HOOK_ID, DATA_CLASSES, env) &&
				run.isCurrent(binding) &&
				!hostSignal?.aborted,
			run: async () => {
				await deps.decide(
					{ method: "system_one", params: { state: facts, questions: buildRefineQuestions() } },
					"automatic_hook",
					HOOK_ID,
					{ would: topRefineSignal, session, questionsVersion: questionsVersionFor(HOOK_ID) },
				);
			},
		});
		return undefined; // INVARIANT: never suppress or replace the refine planner
	};

	return Object.assign(handler, { pending: () => runner.pending() });
}

export function registerRefineAdvisor(pi: any, deps: RefineDeps): void {
	if (hookMode(HOOK_ID, deps.env ?? process.env) === "off") return;
	pi.on("session_before_refine", createRefineAdvisorHandler(deps));
}
