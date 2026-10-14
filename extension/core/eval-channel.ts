import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "./agent-dir.ts";

/**
 * Phase 2 (R3): separate eval channel. Typed measurement values (nouls/probabilities,
 * candidate references) live HERE — never free text, never in the operational receipts.
 * Enabled only for approved measurement runs: PRIME_JEV_EVAL=1 (+ G1 coverage for automatic
 * hooks; direct client calls are outside the G1 matrix and mark `g1_covered: false` — J19).
 */
export const EVAL_SCHEMA = "prime-jev/eval/1";
export const DECISION_RULES_VERSION = "1";

export function evalEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.PRIME_JEV_EVAL === "1";
}

export function evalFile(env: Record<string, string | undefined> = process.env): string {
	const override = env.PRIME_JEV_EVAL_FILE;
	if (override?.trim()) return override;
	// WP2 (25.09.): <agentDir>/receipts/jev.eval.jsonl; die Altdatei unter harness/ bleibt Historie.
	return path.join(resolveAgentDir(env), "receipts", "jev.eval.jsonl");
}

export type Prediction =
	| { type: "noul"; noul: number }
	| { type: "choice" | "score"; probabilities: Record<string, number>; selected: string | number | null; confidence: number | null };

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * J9 (Review 24.09., F06): typed is not automatically content-free. Free API callers can
 * put arbitrary text into question ids / choice keys, so identifiers are kept only when
 * they look like identifiers — otherwise they are replaced by a stable opaque mapping.
 */
export function sanitizeIdentifier(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	if (SAFE_IDENTIFIER.test(value)) return value;
	return `opaque_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

/** Model ids in eval rows pass the same strict shape check as receipts. */
export function safeModelId(value: unknown): string | null {
	return typeof value === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(value) ? value : null;
}

/** Only numeric/enum values survive — no instructions, no context, no text. */
export function extractPredictions(answers: Record<string, any> | undefined): Record<string, Prediction> {
	const predictions: Record<string, Prediction> = {};
	let fallbackIndex = 0;
	for (const [rawId, answer] of Object.entries(answers ?? {})) {
		fallbackIndex += 1;
		if (!answer || typeof answer !== "object") continue;
		const id = sanitizeIdentifier(rawId) ?? `q_${fallbackIndex}`;
		if (answer.type === "noul" && typeof answer.noul === "number") {
			predictions[id] = { type: "noul", noul: answer.noul };
			continue;
		}
		if (
			(answer.type === "choice" || answer.type === "score") &&
			answer.probabilities &&
			typeof answer.probabilities === "object"
		) {
			const entries = (Object.entries(answer.probabilities) as Array<[string, unknown]>).filter(
				([, value]) => typeof value === "number",
			) as Array<[string, number]>;
			const keyMap = new Map<string, string>();
			let optionIndex = 0;
			for (const [key] of entries) {
				optionIndex += 1;
				keyMap.set(key, sanitizeIdentifier(key) ?? `opt_${optionIndex}`);
			}
			const probabilities: Record<string, number> = {};
			for (const [key, value] of entries) {
				const mapped = keyMap.get(key);
				if (mapped !== undefined) probabilities[mapped] = value;
			}
			let selected: string | number | null = null;
			if (answer.type === "choice" && typeof answer.choice === "string") selected = keyMap.get(answer.choice) ?? null;
			else if (answer.type === "score" && typeof answer.score === "number") selected = answer.score;
			// A distribution statistic, NOT a calibrated probability of correctness.
			// Old/missing values remain unknown; never manufacture zero confidence.
			const confidence = typeof answer.confidence === "number" && Number.isFinite(answer.confidence) &&
				answer.confidence >= 0 && answer.confidence <= 1 ? answer.confidence : null;
			predictions[id] = { type: answer.type, probabilities, selected, confidence };
		}
	}
	return predictions;
}

export interface EvalRow {
	schema: typeof EVAL_SCHEMA;
	at: string;
	hook: string;
	mode: string;
	origin: string;
	/** J19: automatic hooks run under the G1 matrix; direct client calls do not. */
	g1_covered: boolean;
	questions_version: string | null;
	provider: string;
	model: string | null;
	rules_version: string;
	outcome: string;
	session: string | null;
	turn: number | null;
	decision_id?: string | null;
	measurement_revision?: "2";
	latency_ms: number;
	candidates?: string[] | null;
	candidates_total?: number | null;
	candidates_scored?: number | null;
	candidates_truncated?: boolean;
	/** J20: predicted action at decision time (tool-gate; `none` in shadow/advisory). */
	would_action?: string | null;
	skip_reason?: string | null;
	predictions: Record<string, Prediction>;
}

export function appendEvalRow(file: string, row: EvalRow): boolean {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}
