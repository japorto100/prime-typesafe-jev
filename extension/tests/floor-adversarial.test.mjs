// E2 — adversarial gate fixtures (equivalent effect paths).
//
// Values tests against the DETERMINISTIC floor (core/floor.ts) and the bounded confirm
// (confirmation.ts) with faux stubs only: no real effects, no provider/network call.
// Cases with coverage "gap" pin the current mechanical boundary and must never be read
// as PASS for safety (the floor is a tripwire, not a security boundary).
// Matrix + findings: archive/2026-10-01-jev-papers/papers/runs/2026-09-30-e2-gate-fixtures/{MATRIX,BEFUND}.md
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { requestConfirmation } from "../confirmation.ts";
import { evaluateBashFloor, evaluateIpythonFloor } from "../core/floor.ts";
import { buildGateQuestions, createToolGate } from "../hooks/tool-gate.ts";

const FIXTURES = JSON.parse(fs.readFileSync(new URL("./fixtures/floor-adversarial.json", import.meta.url), "utf8"));
const FLOOR_KIND_BY_COVERAGE = { covered: "block", "covered-soft": "warn", partial: "warn", gap: "allow", control: "allow" };

function evaluateFloor(fixture) {
	if (fixture.evaluator === "bash-floor") return evaluateBashFloor(fixture.input);
	if (fixture.evaluator === "ipython-floor") return evaluateIpythonFloor(fixture.input);
	throw new Error(`unknown floor evaluator: ${fixture.evaluator}`);
}

function highIrreversible() {
	const answers = {};
	for (const id of Object.keys(buildGateQuestions())) {
		answers[id] = { type: "noul", noul: id === "irreversible" ? 0.9 : 0.2 };
	}
	return { answers };
}

function makeDecide(kind) {
	const calls = [];
	const decide = async (request, origin, hook, meta) => {
		calls.push({ request, origin, hook, meta });
		return kind === "high-irreversible" ? highIrreversible() : { answers: {} };
	};
	return { decide, calls };
}

/** Fake TTY + CI-free process for the interactive gate path; always restores. */
function withFakeTTY(value) {
	const hadTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const hadCI = process.env.CI;
	delete process.env.CI;
	Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
	return () => {
		if (hadTTY) Object.defineProperty(process.stdout, "isTTY", hadTTY);
		else delete process.stdout.isTTY;
		if (hadCI !== undefined) process.env.CI = hadCI;
	};
}

function uiFor(kind, spy) {
	if (kind === null || kind === undefined) return null;
	if (kind === "empty") return {};
	return {
		confirm: async () => {
			spy.count += 1;
			if (kind === "confirm-true") return true;
			if (kind === "confirm-false") return false;
			if (kind === "confirm-throw") throw new Error("ui down");
			throw new Error(`unknown ui kind: ${kind}`);
		},
	};
}

async function runGateCase(fixture) {
	const spec = fixture.gate;
	const env = { PRIME_JEV_HOOK_TOOL_GATE: spec.mode };
	if (spec.g1) env.PRIME_JEV_G1 = FIXTURES.gate_defaults.g1_grant;
	if (spec.mode === "live") env.PRIME_JEV_TOOLGATE_CONFIRM_ON = FIXTURES.gate_defaults.live_confirm_on;
	const { decide, calls } = makeDecide(spec.decide);
	const confirmSpy = { count: 0 };
	const ctx = {};
	if (spec.hasUI !== undefined) ctx.hasUI = spec.hasUI;
	if (spec.headless !== undefined) ctx.headless = spec.headless;
	const ui = uiFor(spec.ui, confirmSpy);
	if (ui) ctx.ui = ui;
	const gate = createToolGate({ decide, env });
	const restore = withFakeTTY(Boolean(spec.tty));
	try {
		const result = await gate({ toolName: fixture.tool, input: fixture.input }, ctx);
		return { result, decideCalls: calls.length, confirmCalls: confirmSpy.count };
	} finally {
		restore();
	}
}

async function runConfirmCase(fixture) {
	const parent = new AbortController();
	if (fixture.parent_aborted) parent.abort();
	const timers = [];
	const spy = { count: 0 };
	const confirmFn = () => {
		spy.count += 1;
		if (fixture.confirm === "true") return true;
		if (fixture.confirm === "false") return false;
		if (fixture.confirm === "throw") throw new Error("ui down");
		if (fixture.confirm === "malformed-yes") return "yes";
		if (fixture.confirm === "never") return new Promise(() => {});
		if (fixture.confirm === "late-true")
			return new Promise((resolve) => {
				timers.push(setTimeout(() => resolve(true), fixture.delay_ms));
			});
		throw new Error(`unknown confirm kind: ${fixture.confirm}`);
	};
	if (fixture.abort_after_ms) timers.push(setTimeout(() => parent.abort(), fixture.abort_after_ms));
	const signal = fixture.parent_aborted || fixture.abort_after_ms ? parent.signal : undefined;
	try {
		const allowed = await requestConfirmation(confirmFn, signal, fixture.timeout_ms);
		return { allowed, confirmCalls: spy.count };
	} finally {
		for (const timer of timers) clearTimeout(timer);
	}
}

test("E2 fixture data is well-formed and coverage labels match expectations", () => {
	const all = [...FIXTURES.floor_cases, ...FIXTURES.gate_cases, ...FIXTURES.confirm_cases];
	const ids = all.map((fixture) => fixture.id);
	assert.equal(new Set(ids).size, ids.length, "fixture ids must be unique");
	for (const fixture of FIXTURES.floor_cases) {
		assert.ok(FIXTURES.paths.includes(fixture.path), `${fixture.id}: unknown path ${fixture.path}`);
		assert.ok(fixture.evaluator === "bash-floor" || fixture.evaluator === "ipython-floor", `${fixture.id}: bad evaluator`);
		assert.equal(
			FLOOR_KIND_BY_COVERAGE[fixture.coverage],
			fixture.expected.kind,
			`${fixture.id}: coverage ${fixture.coverage} contradicts expected kind ${fixture.expected.kind}`,
		);
	}
	for (const fixture of FIXTURES.gate_cases) {
		assert.ok(FIXTURES.paths.includes(fixture.path), `${fixture.id}: unknown path ${fixture.path}`);
		assert.ok(["block", "undefined"].includes(fixture.expect.result), `${fixture.id}: bad expected result`);
		if (fixture.coverage === "gap") assert.equal(fixture.expect.result, "undefined", `${fixture.id}: gaps must expect no verdict`);
	}
	const floorPaths = new Set(FIXTURES.floor_cases.map((fixture) => fixture.path));
	const gatePaths = new Set(FIXTURES.gate_cases.map((fixture) => fixture.path));
	for (const path of FIXTURES.paths) {
		assert.ok(floorPaths.has(path) || gatePaths.has(path), `no fixture exercises path ${path}`);
	}
	assert.ok(gatePaths.has("alt-client"), "alt-client is a gate-level path");
});

for (const path of ["direct", "shell-eval", "file-script", "rephrased-obfuscated"]) {
	test(`E2 floor value cases: path=${path}`, () => {
		const cases = FIXTURES.floor_cases.filter((fixture) => fixture.path === path);
		assert.ok(cases.length > 0, `no floor cases for ${path}`);
		for (const fixture of cases) {
			const verdict = evaluateFloor(fixture);
			assert.equal(verdict.kind, fixture.expected.kind, `${fixture.id} (${fixture.coverage}): ${fixture.input}`);
			if (fixture.expected.rule) assert.equal(verdict.rule, fixture.expected.rule, `${fixture.id}: ${fixture.input}`);
			if (fixture.coverage === "gap") assert.equal(verdict.rule, "", `${fixture.id}: a gap must not carry a rule`);
		}
	});
}

test("E2 gate value cases: confirm deck, tool cover, field contract", async () => {
	const seenPaths = new Set();
	for (const fixture of FIXTURES.gate_cases) {
		seenPaths.add(fixture.path);
		const { result, decideCalls, confirmCalls } = await runGateCase(fixture);
		if (fixture.expect.result === "undefined") {
			assert.equal(result, undefined, `${fixture.id} (${fixture.coverage}): expected no gate verdict`);
		} else {
			assert.equal(result?.block, true, `${fixture.id}: expected a block`);
			if (fixture.expect.reason_includes)
				assert.ok(result.reason.includes(fixture.expect.reason_includes), `${fixture.id}: reason was ${result.reason}`);
		}
		assert.equal(decideCalls, fixture.expect.decide_calls, `${fixture.id}: semantic-layer decide calls`);
		assert.equal(confirmCalls, fixture.expect.confirm_calls, `${fixture.id}: ui.confirm calls`);
	}
	assert.ok(seenPaths.has("alt-client"), "alt-client scenarios must be present");
});

test("E2 confirm value cases: bounded approval denies on everything but a fresh explicit true", async () => {
	for (const fixture of FIXTURES.confirm_cases) {
		const { allowed, confirmCalls } = await runConfirmCase(fixture);
		assert.equal(allowed, fixture.expect, `${fixture.id}: ${fixture.note}`);
		if (fixture.expect_confirm_calls !== undefined)
			assert.equal(confirmCalls, fixture.expect_confirm_calls, `${fixture.id}: confirm invocations`);
	}
});
