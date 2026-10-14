import { createHash, randomUUID } from "node:crypto";
import { appendEvalRow, DECISION_RULES_VERSION, EVAL_SCHEMA, evalEnabled, evalFile } from "../core/eval-channel.ts";
import { excerptOf } from "../core/excerpt.ts";
import { questionsVersionFor, registerQuestionContract } from "../core/question-registry.ts";
import { hookMode, jevThreshold, mayRun } from "./modes.ts";

/**
 * A2 Router (`before_agent_start`) — Phase 3, staging.
 *
 * Shadow-only by default: writes receipts/eval rows (`would_*`) and never touches the
 * prompt. Advisory injection requires BOTH mode `advisory`/`live` AND an explicitly
 * measured threshold (`PRIME_JEV_ROUTER_MIN_P`) — no invented defaults (G4).
 * Model/thinking recommendations are recorded, never applied (G3).
 */
export const HOOK_ID = "router";
export const DATA_CLASSES = ["prompt", "skill-metadata"];
export const HINT_MARKER = "[prime-jev-skill-hint-v1]";
export const ROUTER_VERSION = 1;

const MAX_SKILLS = 24;
const MAX_MODELS = 24;
const MAX_PROMPT_BYTES = 4096;
const TOKEN = /[a-z0-9äöüß]+/gi;

/** Prompt filler that carries no retrieval signal (normalized forms). Domain words stay. */
const STOPWORDS = new Set([
	// English function words (>=3 chars leak into tokens otherwise — the 126/129-noise bug)
	"the",
	"and",
	"for",
	"from",
	"with",
	"without",
	"within",
	"into",
	"onto",
	"over",
	"under",
	"about",
	"above",
	"below",
	"between",
	"among",
	"during",
	"before",
	"after",
	"again",
	"further",
	"once",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"any",
	"both",
	"each",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"only",
	"own",
	"same",
	"too",
	"very",
	"can",
	"could",
	"may",
	"might",
	"must",
	"shall",
	"should",
	"will",
	"would",
	"are",
	"was",
	"were",
	"been",
	"being",
	"has",
	"have",
	"had",
	"does",
	"did",
	"doing",
	"not",
	"nor",
	"you",
	"your",
	"yours",
	"our",
	"ours",
	"its",
	"they",
	"them",
	"their",
	"theirs",
	"she",
	"his",
	"her",
	"hers",
	"who",
	"whom",
	"whose",
	"what",
	"which",
	"while",
	"also",
	"just",
	"even",
	"still",
	"yet",
	"ever",
	"never",
	"always",
	"often",
	"sometimes",
	"now",
	"then",
	// English prompt filler
	"please",
	"available",
	"use",
	"used",
	"using",
	"need",
	"needs",
	"needed",
	"want",
	"wants",
	"help",
	"helps",
	"answer",
	"briefly",
	"best",
	"fits",
	"fit",
	"thing",
	"things",
	"way",
	"ways",
	"give",
	"make",
	"makes",
	"take",
	"takes",
	"get",
	"gets",
	"let",
	"lets",
	"one",
	"two",
	"say",
	"tell",
	// German function words / prompt filler
	"der",
	"die",
	"das",
	"den",
	"dem",
	"des",
	"ein",
	"eine",
	"einen",
	"einem",
	"eines",
	"und",
	"oder",
	"aber",
	"wenn",
	"dann",
	"als",
	"dass",
	"dies",
	"diese",
	"dieser",
	"dieses",
	"für",
	"mit",
	"ohne",
	"von",
	"zum",
	"zur",
	"auf",
	"aus",
	"bei",
	"nach",
	"vor",
	"über",
	"unter",
	"zwischen",
	"während",
	"noch",
	"schon",
	"auch",
	"nur",
	"sehr",
	"kann",
	"könnte",
	"muss",
	"soll",
	"sollte",
	"wird",
	"werden",
	"wurde",
	"waren",
	"sind",
	"war",
	"hat",
	"habe",
	"haben",
	"hatte",
	"hatten",
	"doch",
	"nicht",
	"kein",
	"keine",
	"keinen",
	"keiner",
	"ich",
	"du",
	"wir",
	"ihr",
	"mich",
	"dich",
	"sich",
	"uns",
	"euch",
	"mein",
	"dein",
	"sein",
	"ihre",
	"ihrer",
	"unser",
	"wer",
	"wie",
	"wo",
	"wann",
	"warum",
	"welche",
	"welcher",
	"welches",
	"welchen",
	"bitte",
	"kurz",
	"jetzt",
	"aufgabe",
	"aufgaben",
	"frage",
	"fragen",
	"datei",
	"dateien",
	"ding",
	"dinge",
	// Retrieval-neutral prompt words (skill/task vocabulary)
	"skill",
	"modify",
	"file",
	"files",
	"task",
	"tasks",
	"session",
	"work",
	"working",
	"code",
]);

/** Small deterministic DE→EN + morphology alias map (extend only with evidence). */
const ALIASES: Record<string, string> = {
	rollen: "roles",
	subagenten: "subagent",
	subagents: "subagent",
	debugging: "debug",
	hintergrundjob: "background",
	hintergrundjobs: "background",
	hintergrund: "background",
	benachrichtigung: "notification",
	fortschritt: "progress",
	projekt: "project",
	projekts: "project",
	// Holdout-2 baseline 24.09. (recall gaps, one evidence entry per concept — no blind growth):
	ursache: "diagnose",
	fehlersuche: "diagnose",
	eingrenzen: "diagnose",
	fehler: "error",
	beschreibung: "description",
	umziehen: "migration",
	umbau: "migration",
	ausfallzeit: "downtime",
	tabelle: "table",
	tabellen: "table",
	typen: "types",
	typsystem: "types",
	bedingte: "conditional",
	ähnliche: "similar",
	aehnliche: "similar",
	speichern: "store",
	abstand: "distance",
	suche: "search",
	suchen: "search",
	speicherabbild: "memory",
	zeitlinie: "timeline",
	vorfall: "incident",
	forensik: "forensic",
	foliendeck: "slides",
	folien: "slides",
	präsentation: "presentation",
	sprechernotizen: "notes",
	notizen: "notes",
	kalkulation: "spreadsheet",
	blätter: "sheets",
	formeln: "formulas",
	zugangsschutz: "authentication",
	rollenprüfung: "rbac",
	endpunkte: "endpoints",
	endpunkt: "endpoint",
	zeitreihen: "time",
	messwerte: "metrics",
	sensordaten: "sensor",
	aufbewahrung: "retention",
	komprimiert: "compression",
	// Holdout-2 korrigiert 24.09. (Ziele in Prime-Discovery; Aliaswert = normalisierte Token-Form):
	ticket: "issue",
	datenbank: "database",
	einbettung: "embedding",
	abbruch: "cancellation",
	anfrage: "request",
	prüfen: "review",
	pruefen: "review",
	risiken: "risk",
	architekturentscheidungen: "decision",
	bewerten: "review",
	refactoring: "refactor",
	kopplung: "coupling",
	krypto: "crypto",
	dateisystem: "filesystem",
	vergleichen: "compare",
	engpässe: "bottleneck",
	profildaten: "profiling",
};

function normalizeToken(token: string): string {
	const lower = token.toLowerCase();
	const aliased = ALIASES[lower] ?? lower;
	// Alias first, then light normalizations — both sides of a match use this path.
	// "-ies" would become "…ie" with the plain plural strip (repositories/repository),
	// so it maps to "-y" instead.
	if (aliased.length >= 4 && aliased.endsWith("ies")) return `${aliased.slice(0, -3)}y`;
	if (aliased.length >= 4 && aliased.endsWith("s") && !aliased.endsWith("ss")) return aliased.slice(0, -1);
	return aliased;
}

function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const match of text.toLowerCase().matchAll(TOKEN)) {
		const normalized = normalizeToken(match[0]);
		if (normalized.length >= 3 && !STOPWORDS.has(normalized)) tokens.add(normalized);
	}
	return tokens;
}

registerQuestionContract({
	hook: HOOK_ID,
	version: ROUTER_VERSION,
	description:
		"A2: orthogonal fit predicates (noul) + best_skill choice over the deterministic shortlist with residual `none` + best_model choice over registry models",
});

export interface RouterDecideMeta {
	would?: (result: any) => string | null;
	candidates?: string[];
	candidatesTotal?: number;
	candidatesScored?: number;
	candidatesTruncated?: boolean;
	questionsVersion?: string;
	session?: string | null;
	truncated?: boolean;
}

export interface RouterDeps {
	decide: (request: any, origin: "automatic_hook", hook: string, meta?: RouterDecideMeta) => Promise<any>;
	env?: Record<string, string | undefined>;
}

export interface SkillShortlist {
	candidates: Array<{ name: string; description: string }>;
	discovered: number;
	scored: number;
	truncated: boolean;
}

/**
 * Deterministic skill shortlist: real discovered skills only. Lexical score with
 * stopword removal, light DE→EN/morphology normalization and IDF weighting over the
 * discovered set (rare tokens dominate). Only skills with a positive score become
 * candidates — a generic prompt must not be answered from an alphabetical noise list.
 * Counts are reported for the eval channel.
 */
export function deterministicSkillShortlist(skills: any[] | undefined, prompt = "", max = MAX_SKILLS): SkillShortlist {
	const eligible = (skills ?? [])
		.filter(
			(skill) => skill && typeof skill.name === "string" && skill.name.trim() && skill.disableModelInvocation !== true,
		)
		.map((skill) => ({
			name: skill.name,
			description: typeof skill.description === "string" ? skill.description : "",
		}));
	const promptTokens = tokenize(prompt);
	const documents = eligible.map((skill) => ({
		name: tokenize(skill.name.replace(/[-_]/g, " ")),
		description: tokenize(skill.description),
	}));
	const documentFrequency = new Map<string, number>();
	for (const document of documents) {
		for (const token of new Set([...document.name, ...document.description])) {
			documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
		}
	}
	const scored = eligible
		.map((skill, index) => {
			const document = documents[index];
			let score = 0;
			for (const token of promptTokens) {
				const frequency = documentFrequency.get(token) ?? 0;
				const weight = 1 + Math.log((eligible.length + 1) / (frequency + 1));
				if (document.name.has(token)) score += 3 * weight;
				else if (document.description.has(token)) score += weight;
			}
			return { skill, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
	const candidates = scored.slice(0, max).map((entry) => entry.skill);
	return {
		candidates,
		discovered: eligible.length,
		scored: scored.length,
		truncated: scored.length > candidates.length,
	};
}

/** Deterministic model shortlist from the actual registry (provider/id — never invented). */
export function deterministicModelShortlist(models: any[] | undefined): string[] {
	const ids = new Set<string>();
	for (const model of models ?? []) {
		if (model && typeof model.id === "string" && typeof model.provider === "string") {
			ids.add(`${model.provider}/${model.id}`);
		}
	}
	return [...ids].sort().slice(0, MAX_MODELS);
}

/** Dedupe key for the identical decision situation (prompt + candidates + contract version). */
export function decisionSituationKey(prompt: string, candidates: string[], version: string): string {
	return createHash("sha256").update(JSON.stringify({ prompt, candidates, version })).digest("hex");
}

/** Empty/whitespace/invalid/out-of-range values mean "threshold not set" (Review 24.09., J11). */
export function parseThreshold(raw: unknown): number | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0 || value > 1) return null;
	return value;
}

export function buildRouterQuestions(
	skills: Array<{ name: string; description: string }>,
	models: string[],
	includeModelQuestion = false,
): Record<string, any> {
	const skillCriteria: Record<string, string> = { none: "No specialist skill is needed for this task." };
	for (const skill of skills) skillCriteria[skill.name] = skill.description || skill.name;
	const questions: Record<string, any> = {
		needs_specialist_skill: {
			type: "noul",
			instructions: "Does this task require a specialist skill beyond the general workflow?",
		},
		requires_independent_review: {
			type: "noul",
			instructions: "Does this task require an independent review or verification step before completion?",
		},
		underspecified: {
			type: "noul",
			instructions: "Is the supplied request underspecified in a way that changes the next step?",
		},
		best_skill: {
			type: "choice",
			instructions: "Which available skill best matches this task? Choose `none` when no skill fits.",
			criteria: skillCriteria,
		},
	};
	if (includeModelQuestion && models.length) {
		const modelCriteria: Record<string, string> = {};
		for (const id of models) modelCriteria[id] = id;
		questions.best_model = {
			type: "choice",
			instructions: "Which available model best matches this task?",
			criteria: modelCriteria,
		};
	}
	return questions;
}

export function createRouterHandler(deps: RouterDeps) {
	const env = deps.env ?? process.env;
	const seen = new Set<string>();
	const INSTANCE_ID = randomUUID(); // session proxy until the host exposes a real session id
	return async (event: any, ctx: any): Promise<any> => {
		const mode = hookMode(HOOK_ID, env);
		if (mode === "off") return undefined;
		// G1 precedes shadow: without an explicit grant for both data classes, stay silent.
		if (!mayRun(HOOK_ID, DATA_CLASSES, env)) return undefined;
		try {
			const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
			if (!prompt || prompt.startsWith("/")) return undefined;
			if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) return undefined;
			const shortlist = deterministicSkillShortlist(event?.systemPromptOptions?.skills, prompt);
			if (!shortlist.candidates.length) {
				// Denominator evidence: a silent skip is a measurement, not an absence of data.
				if (evalEnabled()) {
					appendEvalRow(evalFile(), {
						schema: EVAL_SCHEMA,
						at: new Date().toISOString(),
						hook: HOOK_ID,
						mode,
						origin: "automatic_hook",
						g1_covered: true,
						questions_version: questionsVersionFor(HOOK_ID),
						provider: "none",
						model: null,
						rules_version: DECISION_RULES_VERSION,
						outcome: "skipped",
						session: INSTANCE_ID,
						turn: null,
						decision_id: randomUUID(),
						latency_ms: 0,
						candidates: null,
						candidates_total: shortlist.discovered,
						candidates_scored: 0,
						candidates_truncated: false,
						skip_reason: shortlist.discovered === 0 ? "no_skills" : "no_signal",
						predictions: {},
					});
				}
				return undefined;
			}
			// Marker check BEFORE the call: an already-hinted prompt is the same decision
			// situation, so a JEV call would only cost budget (Verify-Fix 24.09.).
			if (typeof event.systemPrompt === "string" && event.systemPrompt.includes(HINT_MARKER)) return undefined;
			const models =
				env.PRIME_JEV_ROUTER_MODEL_QUESTION === "1"
					? deterministicModelShortlist(ctx?.modelRegistry?.getAvailable?.())
					: [];
			const key = decisionSituationKey(
				prompt,
				shortlist.candidates.map((skill) => `${skill.name}\u0000${skill.description}`),
				`${questionsVersionFor(HOOK_ID)}|${INSTANCE_ID}`,
			);
			if (seen.has(key)) return undefined; // same decision situation → one shadow call
			seen.add(key);
			const cut = excerptOf(prompt, MAX_PROMPT_BYTES);

			const result = await deps.decide(
				{
					method: "system_one",
					params: {
						// J11: the semantic step sees the full bounded prompt (head-preserving cap with a
						// digest header when it is cut) — retrieval and decision use the same text.
						state: { prompt: cut.excerpt, prompt_digest: cut.digest, prompt_truncated: cut.truncated },
						questions: buildRouterQuestions(shortlist.candidates, models, env.PRIME_JEV_ROUTER_MODEL_QUESTION === "1"),
					},
				},
				"automatic_hook",
				HOOK_ID,
				{
					would: (value) => value?.answers?.best_skill?.choice ?? null,
					candidates: shortlist.candidates.map((skill) => skill.name),
					candidatesTotal: shortlist.discovered,
					candidatesScored: shortlist.scored,
					candidatesTruncated: shortlist.truncated,
					questionsVersion: questionsVersionFor(HOOK_ID),
					session: INSTANCE_ID,
					truncated: cut.truncated,
				},
			);

			// Advisory injection is threshold-gated (G4) and marker-idempotent.
			if (mode !== "advisory" && mode !== "live") return undefined;
			// Schema-basiert (Env > Settings, CONFIG-MAP §2.7): ungesetzt/leer/0 ⇒ advisory ohne
			// Wirkung; ein ungültiger Wert bricht im Resolver ab (V10) und wird vom Handler gefangen.
			const threshold = jevThreshold("thresholds.min_p", env);
			if (threshold === null) return undefined;
			const needsThreshold = jevThreshold("thresholds.min_needs", env) ?? threshold;
			const answer = result?.answers?.best_skill;
			const probability = answer?.probabilities?.[answer?.choice];
			const needs = result?.answers?.needs_specialist_skill?.noul;
			if (!answer || answer.choice === "none") return undefined;
			if (typeof probability !== "number" || probability < threshold) return undefined;
			if (typeof needs === "number" && needs < needsThreshold) return undefined;
			if (typeof event.systemPrompt !== "string") return undefined;
			const hint = `\n\n${HINT_MARKER}\nSkill hint (advisory): highest-relevance skill \`${answer.choice}\` (p=${probability.toFixed(2)}). The agent keeps its own judgment; nothing is auto-executed.`;
			return { systemPrompt: event.systemPrompt + hint };
		} catch {
			// A router failure must never disturb the agent start (advisory only).
			return undefined;
		}
	};
}

export function registerRouter(pi: any, deps: RouterDeps): void {
	if (hookMode(HOOK_ID, deps.env ?? process.env) === "off") return;
	pi.on("before_agent_start", createRouterHandler(deps));
}
