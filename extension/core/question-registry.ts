import { createHash } from "node:crypto";

/**
 * Phase 2 (A1): versioned question contracts per hook. A contract change bumps its
 * version; the digest of the registered set is the cache/calibration generation
 * anchor (R3) — thresholds without a pinned generation are not comparable.
 */
export interface QuestionContract {
	hook: string;
	version: number;
	description: string;
}

const registry = new Map<string, QuestionContract>();

export function registerQuestionContract(contract: QuestionContract): void {
	const key = `${contract.hook}@${contract.version}`;
	if (registry.has(key)) throw new Error(`JevQuestionContractDuplicate: ${key}`);
	registry.set(key, contract);
}

export function registeredContracts(): QuestionContract[] {
	return [...registry.values()].sort((a, b) => `${a.hook}@${a.version}`.localeCompare(`${b.hook}@${b.version}`));
}

export function questionsVersion(contracts: QuestionContract[] = registeredContracts()): string {
	const canonical = contracts.map(({ hook, version, description }) => ({ hook, version, description }));
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Per-hook digest (Review 24.09., J10): a hook binds only its own contracts. */
export function questionsVersionFor(hook: string): string {
	return questionsVersion(registeredContracts().filter((contract) => contract.hook === hook));
}
