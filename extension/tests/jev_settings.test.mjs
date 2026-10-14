// Consumer-Migration JEV: Modes/Thresholds schema-basiert über `extensionConfig.jev` —
// Env bleibt Override (inkl. PRIME_LAB_*-Altnamen), G1/BUDGET_KILL/EGRESS/AGENT_DIR bleiben
// env-only, kaputte Settings brechen sichtbar ab (V10). Kein Netz: `decide` ist injiziert.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigResolutionError } from "../_shared/host-contract/resolver.ts";
import { hookMode, jevThreshold, mayRun } from "../hooks/modes.ts";
import { createRouterHandler, HINT_MARKER } from "../hooks/router.ts";

function workspace() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-settings-"));
	const agent = path.join(dir, "agent");
	const project = path.join(dir, "project");
	fs.mkdirSync(agent, { recursive: true });
	fs.mkdirSync(path.join(project, ".prime", "agent"), { recursive: true });
	return {
		dir, agent, project,
		globalSettings: path.join(agent, "settings.json"),
		projectSettings: path.join(project, ".prime", "agent", "settings.json"),
	};
}

const writeSettings = (file, jev) => fs.writeFileSync(file, JSON.stringify({ extensionConfig: { jev } }));
const env = (w, extra = {}) => ({ PRIME_AGENT_CODING_AGENT_DIR: w.agent, PWD: w.project, ...extra });

test("settings drive hook modes; project wins over global; unset falls back to off", () => {
	const w = workspace();
	try {
		assert.equal(hookMode("router", env(w)), "off", "no layer carries a mode");
		writeSettings(w.globalSettings, { "hooks.router": "shadow" });
		assert.equal(hookMode("router", env(w)), "shadow");
		writeSettings(w.projectSettings, { "hooks.router": "advisory" });
		assert.equal(hookMode("router", env(w)), "advisory", "project settings beat global settings");
		writeSettings(w.projectSettings, { "hooks.router": "off" });
		assert.equal(hookMode("router", env(w)), "off", "an explicit off in the higher layer wins");
	} finally {
		fs.rmSync(w.dir, { recursive: true, force: true });
	}
})

test("env stays the override: canonical name > PRIME_LAB_* alias > known wrong form", () => {
	const w = workspace();
	try {
		writeSettings(w.projectSettings, { "hooks.router": "shadow" });
		assert.equal(hookMode("router", env(w, { PRIME_JEV_HOOK_ROUTER: "live" })), "live");
		assert.equal(hookMode("router", env(w, { PRIME_LAB_JEV_HOOK_ROUTER: "advisory" })), "advisory", "PRIME_LAB_* alias is declared with envAliases");
		assert.equal(hookMode("router", env(w, { PRIME_JEV_HOOKS_ROUTER: "live" })), "live", "the known wrong form stays a capture");
		assert.equal(
			hookMode("router", env(w, { PRIME_JEV_HOOKS_ROUTER: "live", PRIME_JEV_HOOK_ROUTER: "advisory" })),
			"advisory",
			"within the env layer the canonical name wins",
		);
		assert.equal(
			hookMode("router", env(w, { PRIME_JEV_HOOK_ROUTER: "  ", PRIME_JEV_HOOKS_ROUTER: "live" })),
			"live",
			"empty canonical env counts as unset, the alias carries",
		);
	} finally {
		fs.rmSync(w.dir, { recursive: true, force: true });
	}
})

test("thresholds: settings numbers, env override, empty/0 stay 'no effect'", () => {
	const w = workspace();
	try {
		assert.equal(jevThreshold("thresholds.min_p", env(w)), null);
		writeSettings(w.projectSettings, { "thresholds.min_p": 0.6, "thresholds.min_needs": 0.25 });
		assert.equal(jevThreshold("thresholds.min_p", env(w)), 0.6);
		assert.equal(jevThreshold("thresholds.min_needs", env(w)), 0.25);
		assert.equal(jevThreshold("thresholds.min_p", env(w, { PRIME_JEV_ROUTER_MIN_P: "0.5" })), 0.5, "env overrides settings");
		assert.equal(jevThreshold("thresholds.min_p", env(w, { PRIME_LAB_JEV_ROUTER_MIN_P: "0.4" })), 0.4, "LAB alias stays a channel");
		assert.equal(jevThreshold("thresholds.min_p", env(w, { PRIME_JEV_ROUTER_MIN_P: "" })), 0.6, "empty env counts unset and falls through to settings");
		assert.equal(jevThreshold("thresholds.min_p", env(w, { PRIME_JEV_ROUTER_MIN_P: "0" })), null, "0 in env stays the override and means 'no effect'");
		writeSettings(w.projectSettings, { "thresholds.min_p": 0 });
		assert.equal(jevThreshold("thresholds.min_p", env(w)), null, "0 means advisory has no effect");
	} finally {
		fs.rmSync(w.dir, { recursive: true, force: true });
	}
})

test("invalid values abort visibly (V10) — settings and env, with key path", () => {
	const w = workspace();
	try {
		writeSettings(w.projectSettings, { "hooks.router": "maybe" });
		assert.throws(
			() => hookMode("router", env(w)),
			(e) => e instanceof ConfigResolutionError && e.code === "INVALID_CONFIG" && e.scope === "project" && e.keyPath === "hooks.router",
		);
		writeSettings(w.projectSettings, { "thresholds.min_p": "nope" });
		assert.throws(
			() => jevThreshold("thresholds.min_p", env(w)),
			(e) => e.code === "INVALID_CONFIG" && e.keyPath === "thresholds.min_p",
		);
		writeSettings(w.projectSettings, {});
		assert.throws(
			() => jevThreshold("thresholds.min_p", env(w, { PRIME_JEV_ROUTER_MIN_P: "nope" })),
			(e) => e.code === "INVALID_CONFIG" && e.scope === "env" && e.keyPath === "thresholds.min_p",
		);
		const range = env(w, { PRIME_JEV_ROUTER_MIN_P: "1.5" });
		assert.throws(() => jevThreshold("thresholds.min_p", range), (e) => e.keyPath === "thresholds.min_p", "out-of-range aborts");
	} finally {
		fs.rmSync(w.dir, { recursive: true, force: true });
	}
})

test("V10: a broken settings file aborts even when env carries the mode", () => {
	const w = workspace();
	try {
		fs.writeFileSync(w.projectSettings, "{ broken");
		assert.throws(
			() => hookMode("router", env(w, { PRIME_JEV_HOOK_ROUTER: "shadow" })),
			(e) => e.code === "INVALID_CONFIG" && e.scope === "project" && e.origin === w.projectSettings,
		);
		fs.rmSync(w.projectSettings);
		fs.mkdirSync(path.join(w.agent, "settings.json"));
		assert.throws(
			() => hookMode("router", env(w, { PRIME_JEV_HOOK_ROUTER: "shadow" })),
			(e) => e.code === "UNREADABLE_CONFIG" && e.scope === "global" && e.origin === w.globalSettings,
		);
	} finally {
		fs.rmSync(w.dir, { recursive: true, force: true });
	}
})

test("G1 stays env-only: settings grants are ignored, env grant gates the mode", () => {
	const w = workspace();
	try {
		writeSettings(w.projectSettings, { "hooks.router": "shadow", g1: "router:prompt,router:skill-metadata" });
		assert.equal(mayRun("router", ["prompt", "skill-metadata"], env(w)), false, "a settings 'g1' key is not a grant");
		assert.equal(mayRun("router", ["prompt", "skill-metadata"], env(w, { PRIME_JEV_G1: "router:prompt" })), false, "partial grant stays closed");
		assert.equal(mayRun("router", ["prompt", "skill-metadata"], env(w, { PRIME_JEV_G1: "router:prompt,router:skill-metadata" })), true);
	} finally {
		fs.rmSync(w.dir, { recursive: true, force: true });
	}
})

test("router end-to-end: mode and threshold come from settings, G1 from env", async () => {
	const w = workspace();
	try {
		writeSettings(w.globalSettings, { "hooks.router": "advisory", "thresholds.min_p": 0.5 });
		const calls = [];
		const decide = async (request, origin, hook, meta) => {
			calls.push({ request, origin, hook, meta });
			return {
				answers: {
					needs_specialist_skill: { type: "noul", noul: 0.9 },
					best_skill: { type: "choice", choice: "alpha", confidence: 0.9, probabilities: { alpha: 0.8, beta: 0.2, none: 0 } },
				},
			};
		};
		const handler = createRouterHandler({ decide, env: env(w, { PRIME_JEV_G1: "router:prompt,router:skill-metadata" }) });
		const event = {
			prompt: "Implement alpha feature",
			systemPrompt: "base prompt",
			systemPromptOptions: { skills: [{ name: "alpha", description: "alpha helper" }] },
		};
		const result = await handler(event, { modelRegistry: { getAvailable: () => [] } });
		assert.ok(result?.systemPrompt.includes(HINT_MARKER), "advisory hint injected from settings threshold");
		assert.equal(calls.length, 1);

		const silent = createRouterHandler({
			decide,
			env: env(w, { PRIME_JEV_G1: "router:prompt,router:skill-metadata", PRIME_JEV_HOOK_ROUTER: "off" }),
		});
		assert.equal(await silent({ ...event, prompt: "Other alpha task" }, { modelRegistry: { getAvailable: () => [] } }), undefined, "env off overrides the settings mode");
	} finally {
		fs.rmSync(w.dir, { recursive: true, force: true });
	}
})
