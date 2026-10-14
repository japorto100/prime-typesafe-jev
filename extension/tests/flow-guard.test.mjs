// Contrarian-Fix 24.09. (Concurrency/Last): rolling-minute cap, consecutive-failure
// circuit breaker, bounded 429 retry, and the release () refund wiring on the send path.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { createFlowGuard } from "../core/flow-guard.ts";
import { jevProvider } from "../core/provider.ts";
import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

test("rolling-minute cap admits up to the cap, then reports the window", () => {
  let clock = 1_000_000;
  const guard = createFlowGuard({ env: { PRIME_JEV_RATE_PER_MIN: "2" }, now: () => clock });
  assert.equal(guard.checkRate().ok, true);
  guard.onSend();
  guard.onSend();
  const denied = guard.checkRate();
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000);
  clock += 60_000;
  assert.equal(guard.checkRate().ok, true, "the window slides");
});

test("circuit breaker opens after N consecutive failures and closes after cooldown", () => {
  let clock = 0;
  const guard = createFlowGuard({ env: { PRIME_JEV_BREAKER_FAILS: "3", PRIME_JEV_BREAKER_COOLDOWN_MS: "1000" }, now: () => clock });
  guard.onFailure();
  guard.onFailure();
  assert.equal(guard.isOpen(), false, "two failures are not enough");
  guard.onFailure();
  assert.equal(guard.isOpen(), true);
  clock += 1000;
  assert.equal(guard.isOpen(), false, "cooldown closes the breaker");
  guard.onSuccess();
  assert.equal(guard.state().breakerOpen, false);
});

test("zero disables both protections (documented escape hatch)", () => {
  const guard = createFlowGuard({ env: { PRIME_JEV_RATE_PER_MIN: "0", PRIME_JEV_BREAKER_FAILS: "0" }, now: () => 0 });
  for (let index = 0; index < 10; index += 1) {
    guard.onSend();
    guard.onFailure();
  }
  assert.equal(guard.checkRate().ok, true);
  assert.equal(guard.isOpen(), false);
});

test("provider retries once on 429 (bounded) and then succeeds", async () => {
  const fetchStub = installFetchStub();
  try {
    let attempt = 0;
    fetchStub.state.next = () => {
      attempt += 1;
      if (attempt === 1) return new Response("busy", { status: 429, headers: { "retry-after": "0.05" } });
      return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 1 }, answers: { decision: { type: "noul", noul: 0.8 } } }));
    };
    const prepared = jevProvider.prepare({ state: "x", questions: { decision: { type: "noul", instructions: "x" } }, env: {} });
    const started = Date.now();
    const sent = await jevProvider.send(prepared, "test");
    assert.equal(attempt, 2, "exactly one retry");
    assert.equal(sent.model, "jev-1.13.0");
    assert.ok(Date.now() - started >= 40, "honors a bounded retry-after wait");
  } finally {
    fetchStub.restore();
  }
});

// --- integration: rate cap skips + refunds through the single dispatch path ---------

const home = makeTempHome();
const evalFile = path.join(home, "flow-eval.jsonl");
process.env.TYPESAFE_API_KEY = "offline-test-only";
process.env.PRIME_JEV_HOOK_WATCHDOG = "shadow";
process.env.PRIME_JEV_G1 = "watchdog:turn-facts";
process.env.PRIME_JEV_WATCHDOG_EVERY = "1";
process.env.PRIME_JEV_RATE_PER_MIN = "1";
process.env.PRIME_JEV_EVAL = "1";
process.env.PRIME_JEV_EVAL_FILE = evalFile;
const fetchStub = installFetchStub();
const { default: loadBridge } = await import("../index.ts");
const { pi, hooks } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

const turnEvent = (turnIndex) => ({
  type: "turn_end",
  turnIndex,
  message: { role: "assistant", content: [{ type: "text", text: "arbeit" }] },
  toolResults: [],
});
const watchdogAnswers = () => {
  const answers = {};
  for (const id of ["made_material_progress", "stuck_in_loop", "repeating_same_strategy", "completion_claim_missing_evidence", "should_invoke_reviewer", "should_deepen_reasoning"]) {
    answers[id] = { type: "noul", noul: 0.1 };
  }
  return answers;
};

test("rate cap: a second send is skipped AND its reservation is refunded", async () => {
  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 1 }, answers: watchdogAnswers() }));
  await hooks.get("turn_end")(turnEvent(1), {});
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath, "utf8").trim().split("\n").filter(Boolean) : [];
    if (rows.length >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await hooks.get("turn_end")(turnEvent(2), {});
  while (Date.now() < deadline) {
    const rows = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath, "utf8").trim().split("\n").filter(Boolean) : [];
    if (rows.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const rows = fs.readFileSync(receiptPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows[0].outcome, "answered");
  assert.equal(rows[1].outcome, "skipped");
  assert.equal(fetchStub.state.calls, 1, "the capped send never reached the provider");
  const budget = JSON.parse(fs.readFileSync(path.join(home, ".prime", "agent", "receipts", "jev.budget.json"), "utf8"));
  assert.equal(budget.calls, 1, "the skipped reservation was refunded");
  assert.equal(budget.skipped, 1, "the denied attempt is counted separately");
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  for (const key of ["PRIME_JEV_HOOK_WATCHDOG", "PRIME_JEV_G1", "PRIME_JEV_WATCHDOG_EVERY", "PRIME_JEV_RATE_PER_MIN", "PRIME_JEV_EVAL", "PRIME_JEV_EVAL_FILE"]) {
    delete process.env[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
});
