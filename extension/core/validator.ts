import { choiceFits, distributionBounds, scoreFits } from "../distribution.ts";

/** Shared answer validation for every adapter (batch and legacy) — J02/J03/J04. */

export function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function requireDistribution(answer: any, expectedKeys: string[]): Record<string, number> {
	const probabilities = answer?.probabilities;
	if (
		!isProbability(answer?.confidence) ||
		!probabilities ||
		typeof probabilities !== "object" ||
		Array.isArray(probabilities)
	) {
		throw new Error("JevInvalidDecision: missing distribution");
	}
	const values = Object.values(probabilities) as number[];
	if (!distributionBounds(values)) throw new Error("JevInvalidDecision: invalid distribution");
	const expected = [...expectedKeys].sort();
	if (JSON.stringify(expected) !== JSON.stringify(Object.keys(probabilities).sort())) {
		throw new Error("JevInvalidDecision: criteria mismatch");
	}
	return probabilities;
}

export function validateChoiceAnswer(answer: any, criteriaKeys: string[]): void {
	const expected = [...criteriaKeys].sort();
	if (typeof answer?.choice !== "string" || !expected.includes(answer.choice)) {
		throw new Error("JevInvalidDecision: choice outside requested options");
	}
	const probabilities = requireDistribution(answer, expected);
	if (!choiceFits(answer.choice, probabilities)) {
		throw new Error("JevInvalidDecision: choice disagrees with distribution");
	}
}

export function validateScoreAnswer(answer: any, criteria: string[]): void {
	const expected = criteria.map((_, index) => String(index));
	const probabilities = requireDistribution(answer, expected);
	// TypeSafe Score = probability-weighted value that "can land between levels" (docs):
	// fractional scores like 1.05 for {0:0, 1:0.95, 2:0.05} are valid. No integer coercion.
	if (
		typeof answer?.score !== "number" ||
		!Number.isFinite(answer.score) ||
		answer.score < 0 ||
		answer.score > expected.length - 1
	) {
		throw new Error("JevInvalidDecision: invalid score");
	}
	if (
		!answer.legend ||
		typeof answer.legend !== "object" ||
		Array.isArray(answer.legend) ||
		JSON.stringify(expected) !== JSON.stringify(Object.keys(answer.legend).sort())
	) {
		throw new Error("JevInvalidDecision: invalid score or level keys");
	}
	if (expected.some((key, index) => String(answer.legend[key]) !== String(criteria[index]))) {
		throw new Error("JevInvalidDecision: legend disagrees with requested rubric");
	}
	if (
		!scoreFits(
			answer.score,
			expected.map((key) => probabilities[key]),
		)
	) {
		throw new Error("JevInvalidDecision: score disagrees with distribution");
	}
}

export function validateNoulAnswer(answer: any): void {
	if (!isProbability(answer?.noul)) throw new Error("JevInvalidDecision: invalid noul probability");
}
