/**
 * Phase 2 hook scaffolding (A2–A8 stay off until their phases land).
 * Rollout ladder per hook: off → G1 → shadow → advisory → live.
 *
 * Consumer-Migration 30.09.2026 (CONFIG-MAP §2.7, CONFIG-SCHEMA-V1 §5/§6): die Modi kommen
 * schema-basiert aus `extensionConfig.jev.hooks.<x>` über den vendorten Resolver v1 — Env bleibt
 * Override (kanonischer Name zuerst, danach `PRIME_LAB_JEV_*`-Altnamen aus `envAliases` und die
 * bekannte Fehlform aus `DEFAULT_ENV_ALIASES`), dann Projekt-/Global-settings, dann Code-Default
 * „off“. Eine vorhandene, aber kaputte `settings.json` bricht den Aufruf sichtbar ab (V10), statt
 * still „off“ zu bedeuten.
 *
 * **G1 bleibt env-only** (`PRIME_JEV_G1`): Freigaben sind eine Sitzungs-/Sicherheitsentscheidung
 * und laufen nie über den generischen Merge (CONFIG-SCHEMA §10); `BUDGET_KILL`, `EGRESS` und
 * `PRIME_JEV_AGENT_DIR` ebenso.
 *
 * Der (über `env` injizierbare) Settings-Root ist der Host-Agent-Dir des Resolvers
 * (`agentDir(env)` = Host-Query, sonst `PRIME_AGENT_CODING_AGENT_DIR`, sonst `~/.prime/agent`) —
 * derselbe Ort, den alle Consumer für `extensionConfig` lesen. `PRIME_JEV_AGENT_DIR` isoliert
 * weiterhin nur Auth/Receipts/Budget (`core/agent-dir.ts`), nicht die Settings-Heimat.
 */
import { type ConfigSchema, getConfig } from "../_shared/host-contract/resolver.ts";

export type HookMode = "off" | "shadow" | "advisory" | "live";
export const HOOK_LADDER: HookMode[] = ["off", "shadow", "advisory", "live"];

/** Bekannte Hooks: ID → Literal-Key unter `extensionConfig.jev` + kanonischer Env-Name. */
const HOOKS: ReadonlyArray<{ hook: string; key: string; env: string }> = [
	{ hook: "router", key: "hooks.router", env: "PRIME_JEV_HOOK_ROUTER" },
	{ hook: "tool-gate", key: "hooks.tool_gate", env: "PRIME_JEV_HOOK_TOOL_GATE" },
	{ hook: "watchdog", key: "hooks.watchdog", env: "PRIME_JEV_HOOK_WATCHDOG" },
	{ hook: "result-triage", key: "hooks.result_triage", env: "PRIME_JEV_HOOK_RESULT_TRIAGE" },
	{ hook: "compaction", key: "hooks.compaction", env: "PRIME_JEV_HOOK_COMPACTION" },
	{ hook: "refine", key: "hooks.refine", env: "PRIME_JEV_HOOK_REFINE" },
];

const THRESHOLDS: ReadonlyArray<{ key: "thresholds.min_p" | "thresholds.min_needs"; env: string }> = [
	{ key: "thresholds.min_p", env: "PRIME_JEV_ROUTER_MIN_P" },
	{ key: "thresholds.min_needs", env: "PRIME_JEV_ROUTER_MIN_NEEDS" },
];

const hookLadderValues: Record<string, readonly string[]> = Object.fromEntries(
	HOOKS.map(({ key }) => [key, HOOK_LADDER]),
);

/**
 * Schema der Modes/Thresholds (CONFIG-MAP §2.7, Katalog `catalog.source.json` → `jev`).
 * `env` nennt die dokumentierten Bestandsnamen; `envAliases` nimmt die `PRIME_LAB_JEV_*`-Altnamen
 * auf (die Fehlformen `PRIME_JEV_HOOKS_ROUTER`/`PRIME_JEV_THRESHOLDS_MIN_*` liefert
 * `DEFAULT_ENV_ALIASES.jev` des Resolvers, kanonisch gewinnt jeweils).
 */
export const JEV_SCHEMA: ConfigSchema = {
	kind: {
		"hooks.router": "enum",
		"hooks.tool_gate": "enum",
		"hooks.watchdog": "enum",
		"hooks.result_triage": "enum",
		"hooks.compaction": "enum",
		"hooks.refine": "enum",
		"thresholds.min_p": "number",
		"thresholds.min_needs": "number",
	},
	values: { ...hookLadderValues },
	min: { "thresholds.min_p": 0, "thresholds.min_needs": 0 },
	max: { "thresholds.min_p": 1, "thresholds.min_needs": 1 },
	env: {
		...Object.fromEntries(HOOKS.map(({ key, env }) => [key, env])),
		...Object.fromEntries(THRESHOLDS.map(({ key, env }) => [key, env])),
	},
	envAliases: {
		"hooks.router": ["PRIME_LAB_JEV_HOOK_ROUTER"],
		"hooks.tool_gate": ["PRIME_LAB_JEV_HOOK_TOOL_GATE"],
		"hooks.watchdog": ["PRIME_LAB_JEV_HOOK_WATCHDOG"],
		"hooks.result_triage": ["PRIME_LAB_JEV_HOOK_RESULT_TRIAGE"],
		"hooks.compaction": ["PRIME_LAB_JEV_HOOK_COMPACTION"],
		"hooks.refine": ["PRIME_LAB_JEV_HOOK_REFINE"],
		"thresholds.min_p": ["PRIME_LAB_JEV_ROUTER_MIN_P", "PRIME_JEV_THRESHOLDS_MIN_P"],
		"thresholds.min_needs": ["PRIME_LAB_JEV_ROUTER_MIN_NEEDS", "PRIME_JEV_THRESHOLDS_MIN_NEEDS"],
	},
};

/** Settings-Kanal: derselbe Host-Agent-Dir wie für alle anderen Consumer (siehe Dateikopf). */
function jevCtx(env: Record<string, string | undefined>): { env: Record<string, string | undefined> } {
	return { env };
}

/** Alte Env-Ableitung — nur noch für unbekannte Hook-IDs (Bestand; keine Schema-Schicht). */
function legacyHookMode(hook: string, env: Record<string, string | undefined>): HookMode {
	const key = `PRIME_JEV_HOOK_${hook.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
	const value = env[key];
	return value === "shadow" || value === "advisory" || value === "live" ? value : "off";
}

/**
 * Modus eines Hooks. Kanonischer Env-Name (`PRIME_JEV_HOOK_*`) > `PRIME_LAB_JEV_*`-Alias >
 * Fehlform (`PRIME_JEV_HOOKS_*`/`PRIME_JEV_THRESHOLDS_*`) > Projekt-/Global-settings >
 * Code-Default „off“. Ungültige Werte brechen sichtbar ab (V10); unbekannte Hook-IDs bleiben
 * auf der alten Env-Ableitung (kein Schema-Key).
 */
export function hookMode(hook: string, env: Record<string, string | undefined> = process.env): HookMode {
	const entry = HOOKS.find((candidate) => candidate.hook === hook);
	if (!entry) return legacyHookMode(hook, env);
	const resolved = getConfig<HookMode>("jev", entry.key, { schema: JEV_SCHEMA, ctx: jevCtx(env) });
	return resolved.set ? resolved.value : "off";
}

/**
 * Advisory-Schwelle (`thresholds.min_p`/`thresholds.min_needs`) aus Env oder Settings.
 * `null` = ungesetzt/leer oder 0 — dieselbe „hat keine Wirkung"-Semantik wie `parseThreshold`;
 * ein ungültiger Rohwert bricht im Resolver ab (V10) und wird vom aufrufenden Handler gefangen.
 */
export function jevThreshold(
	key: "thresholds.min_p" | "thresholds.min_needs",
	env: Record<string, string | undefined> = process.env,
): number | null {
	const resolved = getConfig<number>("jev", key, { schema: JEV_SCHEMA, ctx: jevCtx(env) });
	if (!resolved.set || typeof resolved.value !== "number" || resolved.value <= 0) return null;
	return resolved.value;
}

/** G1: explicit grant per hook × data class; nothing is granted by default. **Env-only.** */
export function g1Granted(
	hook: string,
	dataClass: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const grants = (env.PRIME_JEV_G1 ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return grants.includes(`${hook}:${dataClass}`);
}

/** G1 precedes shadow: any non-off mode requires every data class of the hook to be granted. */
export function mayRun(
	hook: string,
	dataClasses: string[],
	env: Record<string, string | undefined> = process.env,
): boolean {
	const mode = hookMode(hook, env);
	if (mode === "off") return false;
	return dataClasses.every((dataClass) => g1Granted(hook, dataClass, env));
}
