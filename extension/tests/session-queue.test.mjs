// Audit 26.09. D05 (per-session dedup/history/run binding) and D14 (bounded queue contract).
// Offline, no provider: every decision is a local fake; the queue is driven by deferreds.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createAsyncJobRunner } from "../hooks/async-lifecycle.ts";
import { createResultTriageHandler } from "../hooks/result-triage.ts";
import { createRunContext } from "../hooks/run-context.ts";

const TRIAGE_ENV = { PRIME_JEV_HOOK_RESULT_TRIAGE: "shadow", PRIME_JEV_G1: "result-triage:tool-result" };
const sessionCtx = (id) => ({ sessionManager: { getSessionId: () => id } });
const bigText = (ch) => ({ toolName: "ipython", content: [{ type: "text", text: ch.repeat(40000) }], isError: false });
const digestOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);

// --- D05: per-session dedup / history / binding ---------------------------------

test("D05 R19: identical output in session B is new evidence, not already-seen from A", async () => {
  const calls = [];
  const handler = createResultTriageHandler({ decide: async (...args) => { calls.push(args); return {}; }, env: TRIAGE_ENV });
  const event = bigText("x");
  await handler(event, sessionCtx("A"));
  await handler.pending();
  await handler(event, sessionCtx("B"));
  await handler.pending();
  assert.equal(calls.length, 2, "the same text in another session must be classified again");
  assert.deepEqual(calls.map((call) => call[3].session), ["A", "B"]);
  assert.deepEqual(calls[1][0].params.state.recent_evidence_signatures, [], "B's history is not A's history");
});

test("D05: dedup and recent-evidence history stay inside their session", async () => {
  const calls = [];
  const handler = createResultTriageHandler({ decide: async (...args) => { calls.push(args); return {}; }, env: TRIAGE_ENV });
  await handler(bigText("x"), sessionCtx("A"));
  await handler.pending();
  await handler(bigText("x"), sessionCtx("A"));
  await handler.pending();
  assert.equal(calls.length, 1, "a duplicate inside one session stays deduped");
  await handler(bigText("y"), sessionCtx("A"));
  await handler.pending();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][0].params.state.recent_evidence_signatures, [digestOf("x".repeat(40000))]);
});

test("D05: session A shutdown drops only A's queued work; B keeps measuring", async () => {
  const runContext = createRunContext();
  const calls = [];
  let releaseA;
  const decide = (request, origin, hook, meta) => {
    calls.push(meta.session);
    if (meta.session === "A") return new Promise((resolve) => { releaseA = () => resolve({}); });
    return Promise.resolve({});
  };
  const handler = createResultTriageHandler({ decide, env: TRIAGE_ENV, runContext });
  await handler(bigText("a"), sessionCtx("A")); // starts immediately and stays in flight
  await handler(bigText("b"), sessionCtx("B")); // queued behind A
  runContext.invalidate("A"); // A's boundary must not touch B's binding
  releaseA();
  await handler.pending();
  assert.deepEqual(calls, ["A", "B"], "B's queued send survives A's shutdown");
});

test("D05: a queued job of a closed session is dropped at the send guard", async () => {
  const runContext = createRunContext();
  const calls = [];
  let releaseB;
  const decide = async (request, origin, hook, meta) => {
    calls.push(meta.session);
    if (meta.session === "B") await new Promise((resolve) => { releaseB = resolve; });
    return {};
  };
  const handler = createResultTriageHandler({ decide, env: TRIAGE_ENV, runContext });
  await handler(bigText("b"), sessionCtx("B")); // active, blocked
  await handler(bigText("a"), sessionCtx("A")); // queued
  runContext.invalidate("A");
  releaseB();
  await handler.pending();
  assert.deepEqual(calls, ["B"], "A's queued send is dropped before the provider call");
  assert.equal(handler.stats().gated, 1);
});

// --- D14: bounded queue contract ---------------------------------------------------

test("D14 R20: the default runner bounds admission (1 active + 32 pendings)", async () => {
  const runner = createAsyncJobRunner(1);
  let release;
  let executed = 0;
  runner.enqueue({ guard: () => true, run: () => new Promise((resolve) => { release = resolve; }) });
  for (let n = 0; n < 120; n += 1) runner.enqueue({ guard: () => true, run: async () => { executed += 1; } });
  assert.equal(runner.stats().pending, 32);
  assert.equal(runner.stats().dropped, 88);
  release();
  await runner.pending();
  assert.equal(executed, 32, "only admitted pendings ran");
  assert.equal(runner.stats().admitted, 33);
  assert.equal(runner.stats().pending, 0);
});

test("D14: same-key jobs coalesce to the newest payload", async () => {
  const runner = createAsyncJobRunner(1, { maxPending: 8 });
  let release;
  const order = [];
  runner.enqueue({ guard: () => true, run: () => new Promise((resolve) => { release = resolve; }) });
  runner.enqueue({ guard: () => true, coalesceKey: "s", run: async () => { order.push("first"); } });
  const outcome = runner.enqueue({ guard: () => true, coalesceKey: "s", run: async () => { order.push("second"); } });
  assert.equal(outcome, "replaced");
  assert.equal(runner.stats().coalesced, 1);
  assert.equal(runner.stats().pending, 1);
  release();
  await runner.pending();
  assert.deepEqual(order, ["second"]);
});

test("D14: retained bytes are capped while waiting; an idle runner still starts an oversized job", async () => {
  const runner = createAsyncJobRunner(1, { maxPending: 8, maxRetainedBytes: 1000 });
  let release;
  runner.enqueue({ guard: () => true, run: () => new Promise((resolve) => { release = resolve; }) });
  assert.equal(runner.enqueue({ guard: () => true, bytes: 600, run: async () => {} }), "queued");
  assert.equal(runner.stats().retainedBytes, 600);
  assert.equal(runner.enqueue({ guard: () => true, bytes: 600, run: async () => {} }), "dropped");
  assert.equal(runner.stats().retainedBytes, 600, "a refused payload is not retained");
  assert.equal(runner.enqueue({ guard: () => true, coalesceKey: "k", bytes: 200, run: async () => {} }), "queued");
  assert.equal(runner.enqueue({ guard: () => true, coalesceKey: "k", bytes: 900, run: async () => {} }), "dropped");
  assert.equal(runner.stats().retainedBytes, 800, "a replacement over the byte cap is refused, the queued payload stays");
  release();
  await runner.pending();
  assert.equal(runner.stats().retainedBytes, 0);
  const idle = createAsyncJobRunner(1, { maxRetainedBytes: 1000 });
  let ran = false;
  assert.equal(idle.enqueue({ guard: () => true, bytes: 5_000_000, run: async () => { ran = true; } }), "queued");
  await idle.pending();
  assert.equal(ran, true, "the cap bounds accumulation, not a single immediately-started result");
});

test("D14: queue-wait deadlines expire visibly instead of executing late", async () => {
  const now = createAsyncJobRunner(1, { maxPending: 8, maxQueueWaitMs: 0 });
  assert.equal(now.enqueue({ guard: () => true, deadline: Date.now() - 1, run: async () => { throw new Error("must not run"); } }), "expired");
  assert.equal(now.stats().expired, 1);

  const runner = createAsyncJobRunner(1, { maxPending: 8, maxQueueWaitMs: 60_000 });
  let release;
  runner.enqueue({ guard: () => true, run: () => new Promise((resolve) => { release = resolve; }) });
  let ran = false;
  runner.enqueue({ guard: () => true, deadline: Date.now() + 10, run: async () => { ran = true; } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await runner.pending();
  assert.equal(ran, false);
  assert.equal(runner.stats().expired, 1);
});

test("D14: guards are checked at enqueue and again before send", async () => {
  const gated = createAsyncJobRunner(1, { maxPending: 4 });
  assert.equal(gated.enqueue({ guard: () => false, run: async () => { throw new Error("must not run"); } }), "gated");
  assert.equal(gated.stats().gated, 1);
  await gated.pending();

  let open = true;
  const runner = createAsyncJobRunner(1, { maxPending: 4 });
  let release;
  runner.enqueue({ guard: () => true, run: () => new Promise((resolve) => { release = resolve; }) });
  let ran = false;
  runner.enqueue({ guard: () => open, run: async () => { ran = true; } });
  open = false; // flips after admission, before send
  release();
  await runner.pending();
  assert.equal(ran, false);
  assert.equal(runner.stats().gated, 1);
});

test("D14: triage surfaces dropped/coalesced counters instead of silent cost", async () => {
  const calls = [];
  let release;
  const decide = (request, origin, hook, meta) => {
    calls.push(meta.session);
    if (calls.length === 1) return new Promise((resolve) => { release = () => resolve({}); });
    return Promise.resolve({});
  };
  const handler = createResultTriageHandler({ decide, env: { ...TRIAGE_ENV, PRIME_JEV_TRIAGE_MAX_PENDING: "1" } });
  await handler(bigText("a"), sessionCtx("A"));
  await handler(bigText("b"), sessionCtx("B"));
  await handler(bigText("c"), sessionCtx("C"));
  assert.equal(handler.stats().pending, 1);
  assert.equal(handler.stats().dropped, 1);
  release();
  await handler.pending();
  assert.deepEqual(calls, ["A", "B"]);
  assert.equal(handler.stats().dropped, 1, "counters survive the drain");
});

test("D14: a second result of the same session replaces the queued payload", async () => {
  const calls = [];
  let release;
  const decide = async (request, origin, hook, meta) => {
    calls.push({ session: meta.session, excerpt: request.params.state.excerpt });
    if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
    return {};
  };
  const handler = createResultTriageHandler({ decide, env: TRIAGE_ENV });
  await handler(bigText("a"), sessionCtx("A")); // starts, blocked
  await handler(bigText("b"), sessionCtx("B")); // queued
  await handler(bigText("c"), sessionCtx("B")); // replaces B's payload
  assert.equal(handler.stats().coalesced, 1);
  assert.equal(handler.stats().pending, 1);
  release();
  await handler.pending();
  assert.deepEqual(calls.map((call) => call.session), ["A", "B"]);
  assert.equal(calls[1].excerpt[0], "c", "the newest payload is the one measured");
});
