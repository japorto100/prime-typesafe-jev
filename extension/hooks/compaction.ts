import { createHash, randomUUID } from "node:crypto";
import {
	appendEvalRow,
	DECISION_RULES_VERSION,
	EVAL_SCHEMA,
	evalEnabled,
	evalFile,
	sanitizeIdentifier,
} from "../core/eval-channel.ts";
import { questionsVersionFor, registerQuestionContract } from "../core/question-registry.ts";
import { createAsyncJobRunner } from "./async-lifecycle.ts";
import { hookMode, mayRun } from "./modes.ts";
import { createRunContext, type RunContext } from "./run-context.ts";

/**
 * A3 Compaction-Relevance (`session_before_compact`) — Phase 6, shadow-only.
 *
 * INVARIANT: every path returns `undefined` — the native compaction (and the other
 * registered handlers) stay untouched; Prime would let the LAST non-empty result win,
 * so silence is the only safe shadow behavior. Paket D (J14): candidates are ranked by
 * retention SIGNAL (constraints/decisions/failed attempts) with recency only as a tie
 * break, and truncation is reported truthfully — old, still-binding constraints must not
 * be crowded out by the newest blocks alone.
 */
export const HOOK_ID = "compaction";
export const DATA_CLASSES = ["conversation-blocks"];
export const COMPACTION_VERSION = 1;

const MAX_BLOCKS = 8;
const MAX_BLOCK_BYTES = 400;
const MIN_BLOCK_CHARS = 40;

const RETENTION_SIGNAL =
	/(must|never|always|constraint|requirement|decided|decision|architecture|failed|attempt|again|remember|wichtig|muss|niemals|entschieden|entscheidung|regel|rule)/i;

registerQuestionContract({
	hook: HOOK_ID,
	version: COMPACTION_VERSION,
	description:
		"A3: per-block preserve predicates for shadow relevance retention (preserve_block_<id>: unresolved work, architecture decision, failed attempt, user constraint)",
});

export interface CompactionDeps {
	decide: (
		request: any,
		origin: "automatic_hook",
		hook: string,
		meta?: {
			would?: (result: any) => string | null;
			candidates?: string[];
			candidatesTotal?: number;
			candidatesScored?: number;
			candidatesTruncated?: boolean;
			questionsVersion?: string;
			session?: string | null;
			truncated?: boolean;
		},
	) => Promise<any>;
	env?: Record<string, string | undefined>;
	runContext?: RunContext;
}

export interface CompactionBlock {
	id: string;
	kind: string;
	text: string;
	digest: string | null;
}

export function blockText(entry: any): string {
	const content = entry?.message?.content ?? entry?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n");
	}
	return typeof entry?.summary === "string" ? entry.summary : "";
}

export interface CompactionSelection {
	blocks: CompactionBlock[];
	total: number;
	truncated: boolean;
}

export function compactionBlocks(branchEntries: unknown, max = MAX_BLOCKS): CompactionSelection {
	const entries = Array.isArray(branchEntries) ? branchEntries : []; // malformed host events must not throw
	const candidates: Array<CompactionBlock & { index: number; signal: number }> = [];
	const seenIds = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		const text = blockText(entry).trim();
		if (text.length < MIN_BLOCK_CHARS) continue;
		const id =
			typeof entry?.id === "string" ? entry.id : typeof entry?.uuid === "string" ? entry.uuid : `block-${index}`;
		if (seenIds.has(id)) continue; // duplicate ids collapse — one question per block id
		seenIds.add(id);
		candidates.push({
			id,
			kind: typeof entry?.type === "string" ? entry.type : "entry",
			text: text.slice(0, MAX_BLOCK_BYTES),
			digest: text.length > MAX_BLOCK_BYTES ? createHash("sha256").update(text).digest("hex").slice(0, 16) : null,
			index,
			signal: RETENTION_SIGNAL.test(text) ? 1 : 0,
		});
	}
	const selected = [...candidates].sort((a, b) => b.signal - a.signal || b.index - a.index).slice(0, max);
	const selectedIds = new Set(selected.map((entry) => entry.id));
	const blocks = candidates
		.filter((entry) => selectedIds.has(entry.id))
		.map(({ id, kind, text, digest }) => ({ id, kind, text, digest }));
	return { blocks, total: candidates.length, truncated: candidates.length > blocks.length };
}

/**
 * Unique question keys: sanitizing can collide (`a b` vs `a_b`), so a colliding key gets a
 * numeric suffix — every block keeps its own question and `topPreserveSignal` stays exact.
 */
export function compactionQuestionKeys(blocks: CompactionBlock[]): Array<{ block: CompactionBlock; key: string }> {
	const used = new Set<string>();
	return blocks.map((block) => {
		const base = `preserve_${block.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
		let key = base;
		let suffix = 2;
		while (used.has(key)) key = `${base}_${suffix++}`;
		used.add(key);
		return { block, key };
	});
}

export function buildCompactionQuestions(blocks: CompactionBlock[]): Record<string, any> {
	const questions: Record<string, any> = {};
	for (const { block, key } of compactionQuestionKeys(blocks)) {
		questions[key] = {
			type: "noul",
			instructions: `Must block ${block.id} (${block.kind}) be preserved verbatim? It carries unresolved work, an architecture decision, a failed attempt worth avoiding, or a user constraint.`,
		};
	}
	return questions;
}

export function topPreserveSignal(result: any, blocks: CompactionBlock[]): string | null {
	let top: string | null = null;
	let best = -1;
	for (const { block, key } of compactionQuestionKeys(blocks)) {
		const value = result?.answers?.[key]?.noul;
		if (typeof value === "number" && value > best) {
			best = value;
			top = block.id;
		}
	}
	return top ? `preserve:${top}` : null;
}

export interface CompactionHandler {
	(event: any, ctx: any): Promise<undefined>;
	pending(): Promise<void>;
}

function skipRecord(skipReason: string, mode: string, g1Covered: boolean, blockIds: string[] | null = null): void {
	if (!evalEnabled()) return;
	// J19/Contrarian: host entry ids are typed but not automatically content-free —
	// sanitize the same way the answered rows do (free-text ids become opaque).
	const safeIds = blockIds?.map((id, index) => sanitizeIdentifier(id) ?? `block_${index}`);
	appendEvalRow(evalFile(), {
		schema: EVAL_SCHEMA,
		at: new Date().toISOString(),
		hook: HOOK_ID,
		mode,
		origin: "automatic_hook",
		g1_covered: g1Covered,
		questions_version: questionsVersionFor(HOOK_ID),
		provider: "none",
		model: null,
		rules_version: DECISION_RULES_VERSION,
		outcome: "skipped",
		session: null,
		turn: null,
		decision_id: randomUUID(),
		latency_ms: 0,
		candidates: safeIds ?? null,
		candidates_total: safeIds?.length ?? null,
		candidates_scored: null,
		candidates_truncated: false,
		skip_reason: skipReason,
		predictions: {},
	});
}

export function createCompactionHandler(deps: CompactionDeps): CompactionHandler {
	const env = deps.env ?? process.env;
	const runner = createAsyncJobRunner(1);
	const run = deps.runContext ?? createRunContext();

	const handler = async (event: any, ctx: any): Promise<undefined> => {
		const mode = hookMode(HOOK_ID, env);
		if (mode === "off") return undefined;
		if (!mayRun(HOOK_ID, DATA_CLASSES, env)) {
			skipRecord("g1_not_granted", mode, false);
			return undefined;
		}
		const selection = compactionBlocks(event?.branchEntries);
		if (!selection.blocks.length) {
			skipRecord("no_blocks", mode, true);
			return undefined;
		}
		const session = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : null;
		const binding = run.bind(session);
		// C030: the host's own cancel channel for this compaction (event.signal). Reading
		// `.aborted` is a plain getter — no ctx proxy, so the guard can never throw.
		const hostSignal = event?.signal;

		runner.enqueue({
			guard: () =>
				hookMode(HOOK_ID, env) !== "off" &&
				mayRun(HOOK_ID, DATA_CLASSES, env) &&
				run.isCurrent(binding) &&
				!hostSignal?.aborted,
			run: async () => {
				await deps.decide(
					{
						method: "system_one",
						params: {
							state: selection.blocks.map((block) => ({
								id: block.id,
								kind: block.kind,
								excerpt: block.text,
								excerpt_digest: block.digest,
							})),
							questions: buildCompactionQuestions(selection.blocks),
						},
					},
					"automatic_hook",
					HOOK_ID,
					{
						would: (result) => topPreserveSignal(result, selection.blocks),
						candidates: selection.blocks.map((block) => block.id),
						candidatesTotal: selection.total,
						candidatesScored: selection.blocks.length,
						candidatesTruncated: selection.truncated,
						truncated: selection.blocks.some((block) => block.digest !== null),
						questionsVersion: questionsVersionFor(HOOK_ID),
						session,
					},
				);
			},
		});
		return undefined; // INVARIANT: no compaction result, ever
	};

	return Object.assign(handler, { pending: () => runner.pending() });
}

export function registerCompaction(pi: any, deps: CompactionDeps): void {
	if (hookMode(HOOK_ID, deps.env ?? process.env) === "off") return;
	pi.on("session_before_compact", createCompactionHandler(deps));
}
