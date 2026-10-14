import os from "node:os";
import path from "node:path";

/** J11: one host root for auth, receipts (and later budget/eval), overridable for tests/profiles. */
export function resolveAgentDir(env: Record<string, string | undefined> = process.env): string {
	const override = env.PRIME_JEV_AGENT_DIR;
	if (override?.trim()) return override;
	return path.join(os.homedir(), ".prime", "agent");
}
