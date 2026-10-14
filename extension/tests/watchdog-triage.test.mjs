// Phase 5: A5 watchdog (non-blocking, stale-bound) + A6 result-triage (large-only, content-safe).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { buildTriageQuestions, createResultTriageHandler, topTriageSignal } from "../hooks/result-triage.ts";
import { createRunContext } from "../hooks/run-context.ts";
import { buildWatchdogQuestions, createWatchdogHandler, shouldWatch, topWatchdogSignal, turnFacts } from "../hooks/watchdog.ts";
import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const WATCH_ENV = { PRIME_JEV_HOOK_WATCHDOG: "shadow", PRIME_JEV_G1: "watchdog:turn-facts" };
const TRIAGE_ENV = { PRIME_JEV_HOOK_RESULT_TRIAGE: "shadow", PRIME_JEV_G1: "result-triage:tool-result" };

const turnEvent = (turnIndex, errors = 0, text = "arbeit") => ({
  type: "turn_end",
  turnIndex,
  message: { role: "assistant", content: [{ type: "text", text }] },
  toolResults: Array.from({ length: errors }, () => ({ isError: true })),
});

function watchdogBatch(top = "made_material_progress", value = 0.9) {
  const answers = {};
  for (const id of Object.keys(buildWatchdogQuestions())) answers[id] = { type: "noul", noul: id === top ? value : 0.1 };
  return { answers };
}

function triageBatch(failure = 0.2, category = "none") {
  const probabilities = { code_bug: 0.05, transient: 0.05, config: 0.05, data: 0.05, none: 0.05, unknown: 0.05 };
  probabilities[category] = 0.7;
  probabilities[category === "none" ? "unknown" : "none"] = 0.1;
  return {
    answers: {
      is_relevant_to_current_problem: { type: "noul", noul: 0.8 },
      contains_new_evidence: { type: "noul", noul: 0.7 },
      contains_a_failure: { type: "noul", noul: failure },
      failure_category: { type: "choice", choice: category, confidence: 0.8, probabilities },
      can_be_recovered_from_artifact: { type: "noul", noul: 0.6 },
    },
  };
}

function slowDecide(result, delayMs) {
  const calls = [];
  return {
    calls,
    decide: (request, origin, hook, meta) =>
      new Promise((resolve) => {
        setTimeout(() => {
          calls.push({ request, origin, hook, meta });
          resolve(result);
        }, delayMs);
      }),
  };
}

// --- watchdog ------------------------------------------------------------------

test("watchdog facts and cadence are deterministic", () => {
  const facts = turnFacts(turnEvent(3, 2, "tail text"));
  assert.deepEqual(facts, { turn: 3, toolResults: 2, errors: 2, excerpt: "tail text", excerpt_digest: null, excerpt_truncated: false });
  const long = turnFacts(turnEvent(3, 0, "x".repeat(700)));
  assert.equal(long.excerpt.length, 512);
  assert.equal(long.excerpt_truncated, true);
  assert.match(long.excerpt_digest, /^[0-9a-f]{16}$/, "a cut excerpt carries its digest header");
  assert.equal(shouldWatch(turnFacts(turnEvent(1)), {}).run, false);
  assert.equal(shouldWatch(turnFacts(turnEvent(3)), {}).run, true);
  assert.equal(shouldWatch(turnFacts(turnEvent(1, 1)), {}).run, true, "errors always trigger");
  assert.equal(shouldWatch(turnFacts(turnEvent(3)), { PRIME_JEV_WATCHDOG_EVERY: "2" }).run, false, "cadence is configurable");
});

test("watchdog: off and missing G1 stay silent", async () => {
  const off = slowDecide(watchdogBatch(), 1);
  await createWatchdogHandler({ decide: off.decide, env: {} })(turnEvent(3), {});
  assert.equal(off.calls.length, 0);
  const noGrant = slowDecide(watchdogBatch(), 1);
  await createWatchdogHandler({ decide: noGrant.decide, env: { PRIME_JEV_HOOK_WATCHDOG: "shadow" } })(turnEvent(3), {});
  assert.equal(noGrant.calls.length, 0);
});

test("watchdog is non-blocking and completes in the background", async () => {
  // Structural non-blocking proof instead of a wall-clock bound: the handler must return while
  // the JEV decision is still in flight. (The old `elapsed < 40ms` flaked under parallel
  // `node --test` load on this machine; the invariant it checked is unchanged.)
  let settled = false;
  const slow = slowDecide(watchdogBatch(), 60);
  const decide = async (...args) => {
    const result = await slow.decide(...args);
    settled = true;
    return result;
  };
  const handler = createWatchdogHandler({ decide, env: WATCH_ENV });
  assert.equal(await handler(turnEvent(3), {}), undefined);
  assert.equal(settled, false, "handler returned while the JEV decision was still pending (non-blocking)");
  await handler.pending();
  assert.equal(settled, true, "the queued evaluation completes in the background");
  assert.equal(slow.calls.length, 1);
  assert.equal(slow.calls[0].hook, "watchdog");
  assert.equal(slow.calls[0].meta.turn, 3);
  assert.ok(Array.isArray(slow.calls[0].request.params.state.recent_error_signatures));
});

test("J13: watchdog evaluations are serialized (concurrency 1) and ordered", async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const decide = async (request) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push(request.params.state.turn);
    active -= 1;
    return watchdogBatch();
  };
  const handler = createWatchdogHandler({ decide, env: { ...WATCH_ENV, PRIME_JEV_WATCHDOG_EVERY: "1" } });
  await handler(turnEvent(1), {});
  await handler(turnEvent(2), {});
  await handler.pending();
  assert.equal(maxActive, 1, "never two simultaneous evaluations");
  assert.deepEqual(order, [1, 2]);
});

test("watchdog advisory hints are stale-bound to the observed turn", async () => {
  const slow = slowDecide(watchdogBatch("stuck_in_loop"), 50);
  const notices = [];
  const handler = createWatchdogHandler({ decide: slow.decide, env: { ...WATCH_ENV, PRIME_JEV_HOOK_WATCHDOG: "advisory" } });
  await handler(turnEvent(3), { ui: { notify: (message) => notices.push(message) } });
  await handler(turnEvent(4), {}); // turn advances while the decision is in flight
  await handler.pending();
  assert.equal(notices.length, 0, "a stale turn's hint must never surface");
  assert.equal(topWatchdogSignal(watchdogBatch("stuck_in_loop")), "stuck_in_loop");
});

test("Verify-Fix F2/F4: a session boundary aborts queued sends and suppresses in-flight hints", async () => {
  const calls = [];
  const runContext = createRunContext();
  const notices = [];
  const decide = (request) => new Promise((resolve) => {
    setTimeout(() => {
      calls.push(request.params.state.turn);
      resolve(watchdogBatch("stuck_in_loop"));
    }, 30);
  });
  const handler = createWatchdogHandler({ decide, env: { ...WATCH_ENV, PRIME_JEV_HOOK_WATCHDOG: "advisory" }, runContext });
  const ctx = { sessionManager: { getSessionId: () => "sess-A" }, ui: { notify: (message) => notices.push(message) } };
  await handler(turnEvent(3), ctx); // starts immediately and stays in flight
  await handler(turnEvent(4), ctx); // queued behind the first job
  runContext.invalidate();          // session boundary while job 2 still waits
  runContext.noteSession("sess-B");
  await handler.pending();
  assert.deepEqual(calls, [3], "the queued stale send is aborted; the in-flight measurement stays");
  assert.equal(notices.length, 0, "no hint crosses the session boundary");
});

test("Verify-Fix F2: a new agent run (epoch bump) invalidates queued evaluations", async () => {
  const calls = [];
  const runContext = createRunContext();
  const decide = (request) => new Promise((resolve) => {
    setTimeout(() => {
      calls.push(request.params.state.turn);
      resolve(watchdogBatch());
    }, 30);
  });
  const handler = createWatchdogHandler({ decide, env: { ...WATCH_ENV, PRIME_JEV_WATCHDOG_EVERY: "1" }, runContext });
  await handler(turnEvent(1), {});
  await handler(turnEvent(2), {}); // queued
  runContext.beginRun();            // new run starts (turnIndex resets there)
  await handler.pending();
  assert.deepEqual(calls, [1], "the queued job from the previous run is dropped");
});

// --- result triage -------------------------------------------------------------

test("triage: large-only, spill-skip, dedupe, content untouched", async () => {
  const fake = slowDecide(triageBatch(), 1);
  const handler = createResultTriageHandler({ decide: fake.decide, env: TRIAGE_ENV });
  const small = { toolName: "ipython", content: [{ type: "text", text: "ok" }], isError: false };
  assert.equal(await handler(small, {}), undefined);
  assert.equal(fake.calls.length, 0);

  const big = { toolName: "ipython", content: [{ type: "text", text: "x".repeat(40000) }], isError: false };
  assert.equal(await handler(big, {}), undefined);
  assert.equal(await handler(big, {}), undefined, "identical result is deduped");
  await handler.pending();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].hook, "result-triage");

  const spill = slowDecide(triageBatch(), 1);
  const spillHandler = createResultTriageHandler({ decide: spill.decide, env: { ...TRIAGE_ENV, PRIME_COMPACT_SPILL_MAX_BYTES: "30000" } });
  await spillHandler(big, {});
  await spillHandler.pending();
  assert.equal(spill.calls.length, 0, "spill owns large outputs");

  const zero = slowDecide(triageBatch(), 1);
  // legacy name on purpose: the shim must keep "0" meaning spill-off
  const zeroHandler = createResultTriageHandler({ decide: zero.decide, env: { ...TRIAGE_ENV, PRIME_LAB_SPILL_MAX_BYTES: "0" } });
  await zeroHandler(big, {});
  await zeroHandler.pending();
  assert.equal(zero.calls.length, 1, `"0"/"false" means spill is off`);
});

test("Verify-Fix: the >32 KiB threshold is exclusive; excerpts carry digest headers", async () => {
  const fake = slowDecide(triageBatch(), 1);
  const handler = createResultTriageHandler({ decide: fake.decide, env: TRIAGE_ENV });
  const exact = { toolName: "ipython", content: [{ type: "text", text: "z".repeat(32 * 1024) }], isError: false };
  const over = { toolName: "ipython", content: [{ type: "text", text: "z".repeat(32 * 1024 + 1) }], isError: false };
  await handler(exact, {});
  await handler(over, {});
  await handler.pending();
  assert.equal(fake.calls.length, 1, "exactly 32 KiB is not “large”");
  const state = fake.calls[0].request.params.state;
  assert.equal(state.excerpt.length, 1024);
  assert.equal(state.excerpt_truncated, true);
  assert.match(state.excerpt_digest, /^[0-9a-f]{16}$/);
  assert.equal(fake.calls[0].meta.truncated, true, "receipts learn about the cut");
});

test("triage failure signal maps to a category enum", () => {
  assert.equal(topTriageSignal(triageBatch(0.9, "code_bug")), "failure:code_bug");
  assert.equal(topTriageSignal(triageBatch(0.2)), "is_relevant_to_current_problem");
  assert.deepEqual(Object.keys(buildTriageQuestions()).sort(), ["can_be_recovered_from_artifact", "contains_a_failure", "contains_new_evidence", "failure_category", "is_relevant_to_current_problem"].sort());
});

// --- integration: receipts + eval through the single dispatch path -------------

const home = makeTempHome();
const evalFile = path.join(home, "watch-triage-eval.jsonl");
// Tests define their own policy: scrub inherited live knobs (PRIME_COMPACT_SPILL_MAX_BYTES,
// PRIME_JEV_HOOK_ROUTER, …) so a developer shell cannot change the outcome. Restored by the
// process-scoped test runner; nothing outside this file's child process is affected.
for (const key of Object.keys(process.env)) if (/^PRIME_(JEV|COMPACT|LAB)_/.test(key)) delete process.env[key];
process.env.TYPESAFE_API_KEY = "offline-test-only";
process.env.PRIME_JEV_HOOK_WATCHDOG = "shadow";
process.env.PRIME_JEV_HOOK_RESULT_TRIAGE = "shadow";
process.env.PRIME_JEV_HOOK_TOOL_GATE = "shadow";
process.env.PRIME_JEV_G1 = "watchdog:turn-facts,result-triage:tool-result,tool-gate:tool-input";
process.env.PRIME_JEV_EVAL = "1";
process.env.PRIME_JEV_EVAL_FILE = evalFile;
const fetchStub = installFetchStub();
const { default: loadBridge } = await import("../index.ts");
const { pi, hooks } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

async function waitForRows(file, count, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
    if (rows.length >= count) return rows.map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

test("shadow watchdog + triage write v2 receipts and typed eval rows", async () => {
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 5 }, ...watchdogBatch("completion_claim_missing_evidence") }));
  await hooks.get("turn_end")(turnEvent(3, 0, "Alles fertig."), {});
  await waitForRows(evalFile, 1);

  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 5 }, ...triageBatch(0.9, "transient") }));
  await hooks.get("tool_result")({ toolName: "ipython", content: [{ type: "text", text: "y".repeat(40000) }], isError: true }, {});

  const rows = await waitForRows(evalFile, 2);
  assert.equal(rows.length, 2);
  const watchdogRow = rows.find((row) => row.hook === "watchdog");
  const triageRow = rows.find((row) => row.hook === "result-triage");
  assert.equal(watchdogRow.turn, 3);
  assert.equal(triageRow.outcome, "answered");
  assert.equal(watchdogRow.g1_covered, true, "automatic hooks run under the G1 matrix (J19)");

  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const watchdogReceipt = receipts.findLast((row) => row.hook === "watchdog");
  const triageReceipt = receipts.findLast((row) => row.hook === "result-triage");
  assert.equal(watchdogReceipt.schema, "prime-jev/call/2");
  assert.equal(watchdogReceipt.mode, "shadow");
  assert.equal(watchdogReceipt.would, "completion_claim_missing_evidence");
  assert.equal(triageReceipt.would, "failure:transient");
  assert.equal(triageReceipt.truncated, true, "a cut excerpt is flagged in the receipt (Verify-Fix)");
  assert.equal(typeof triageReceipt.queue?.pending, "number", "D14: queue counters ride in the receipt, not in the dark");
  assert.equal(JSON.stringify(receipts).includes("Alles fertig."), false);
  assert.equal(JSON.stringify(receipts).includes("yyyy"), false);

  // J20 audit: the tool gate records which action it took / would take.
  const gateAnswers = Object.fromEntries(
    ["writes_files", "touches_outside_workspace", "uses_network", "accesses_credentials", "privileged_or_remote_execution", "irreversible", "regenerable"]
      .map((id) => [id, { type: "noul", noul: id === "writes_files" ? 0.9 : 0.1 }]),
  );
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 5 }, answers: gateAnswers }));
  await hooks.get("tool_call")({ toolName: "ipython", input: { code: "open('gate-out.txt','w')" } }, { cwd: "/work" });
  const gateReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").trim().split("\n").at(-1));
  assert.equal(gateReceipt.hook, "tool-gate");
  assert.equal(gateReceipt.mode, "shadow");
  assert.equal(gateReceipt.would_action, "none", "shadow takes no action (J20 audit field)");
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  delete process.env.PRIME_JEV_HOOK_WATCHDOG;
  delete process.env.PRIME_JEV_HOOK_RESULT_TRIAGE;
  delete process.env.PRIME_JEV_HOOK_TOOL_GATE;
  delete process.env.PRIME_JEV_G1;
  delete process.env.PRIME_JEV_EVAL;
  delete process.env.PRIME_JEV_EVAL_FILE;
  fs.rmSync(home, { recursive: true, force: true });
});
