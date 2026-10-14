// Phase 6: A3 compaction shadow — invariant "return undefined always", bounded blocks,
// per-block preserve predictions in the eval channel, skip reasons for hook_status.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { buildCompactionQuestions, compactionBlocks, createCompactionHandler, topPreserveSignal } from "../hooks/compaction.ts";
import { createRunContext } from "../hooks/run-context.ts";
import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const SHADOW_ENV = { PRIME_JEV_HOOK_COMPACTION: "shadow", PRIME_JEV_G1: "compaction:conversation-blocks" };

const entry = (id, text) => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const event = (entries) => ({ type: "session_before_compact", preparation: { tokensBefore: 1000 }, branchEntries: entries, signal: new AbortController().signal });

function compactionBatch(blocks, topId) {
  const answers = {};
  for (const block of blocks) {
    const key = `preserve_${block.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    answers[key] = { type: "noul", noul: block.id === topId ? 0.9 : 0.2 };
  }
  return { answers };
}

test("blocks: bounded, signal-ranked, deterministic ids", () => {
  const selection = compactionBlocks([
    entry("b1", "kurz"),
    entry("b2", "x".repeat(600)),
    { id: "b3", type: "summary", summary: "an important decision was made about the socket architecture" },
  ]);
  assert.deepEqual(selection.blocks.map((block) => block.id), ["b2", "b3"]);
  assert.equal(selection.blocks[0].text.length, 400, "excerpt bounded");
  assert.equal(selection.total, 2, "short block filtered");
  assert.equal(selection.truncated, false);
  const questions = buildCompactionQuestions(selection.blocks);
  assert.deepEqual(Object.keys(questions).sort(), ["preserve_b2", "preserve_b3"].sort());
});

test("J14/R19: an old constraint is not crowded out by recent generic blocks; truncation is reported", () => {
  const entries = [entry("old-constraint", "We must never delete user data — hard requirement for every model decision.")];
  for (let index = 0; index < 10; index += 1) entries.push(entry(`recent-${index}`, `generic chatter number ${index} `.repeat(6)));
  const selection = compactionBlocks(entries);
  assert.ok(selection.blocks.some((block) => block.id === "old-constraint"), "signal-bearing old block survives the cap");
  assert.equal(selection.total, 11);
  assert.equal(selection.truncated, true, "truncation is reported truthfully");
  assert.equal(selection.blocks.length, 8);
});

test("Verify-Fix: duplicate ids collapse, non-iterable entries never throw, keys stay unique", () => {
  const dup = compactionBlocks([entry("same", "x".repeat(100)), entry("same", "y".repeat(100))]);
  assert.equal(dup.total, 1, "one candidate per id");
  assert.equal(dup.blocks.length, 1);
  assert.equal(dup.truncated, false);
  assert.equal(compactionBlocks(undefined).blocks.length, 0);
  assert.equal(compactionBlocks({ branchEntries: [] }).blocks.length, 0, "malformed host events must not throw");

  const blocks = [
    { id: "a b", kind: "message", text: "t", digest: null },
    { id: "a_b", kind: "message", text: "t", digest: null },
  ];
  const keys = Object.keys(buildCompactionQuestions(blocks));
  assert.equal(keys.length, 2, "sanitizing collisions get their own keys");
  assert.equal(new Set(keys).size, 2);
  const result = { answers: { [keys[0]]: { noul: 0.1 }, [keys[1]]: { noul: 0.9 } } };
  assert.equal(topPreserveSignal(result, blocks), "preserve:a_b", "top signal stays exact despite the collision");
});

test("Verify-Fix: a cut block excerpt carries its digest header", () => {
  const selection = compactionBlocks([entry("long", "w".repeat(600))]);
  assert.equal(selection.blocks[0].text.length, 400);
  assert.match(selection.blocks[0].digest, /^[0-9a-f]{16}$/);
  const short = compactionBlocks([entry("short", "s".repeat(100))]);
  assert.equal(short.blocks[0].digest, null, "an uncut block needs no digest");
});

test("invariant: the handler always returns undefined (even with decide failing)", async () => {
  const failing = { decide: async () => { throw new Error("down"); } };
  const handler = createCompactionHandler({ decide: failing.decide, env: SHADOW_ENV });
  const result = await handler(event([entry("b1", "y".repeat(100))]), {});
  assert.equal(result, undefined);
  await handler.pending();
});

test("gating and no-block paths stay silent (skip records only in measurement mode)", async () => {
  let calls = 0;
  const decide = async () => { calls += 1; return { answers: {} }; };
  await createCompactionHandler({ decide, env: {} })(event([entry("b1", "z".repeat(100))]), {});
  await createCompactionHandler({ decide, env: { PRIME_JEV_HOOK_COMPACTION: "shadow" } })(event([entry("b1", "z".repeat(100))]), {});
  await createCompactionHandler({ decide, env: { ...SHADOW_ENV, PRIME_JEV_HOOK_COMPACTION: "advisory" } })(event([]), {});
  assert.equal(calls, 0);
});

test("shadow asks once per block set and records the top preserve signal", async () => {
  const calls = [];
  const source = event([entry("b1", "a".repeat(100)), entry("b2", "b".repeat(100))]);
  const selection = compactionBlocks(source.branchEntries);
  const handler = createCompactionHandler({
    decide: async (request, origin, hook, meta) => {
      calls.push({ request, origin, hook, meta });
      return compactionBatch(selection.blocks, "b2");
    },
    env: SHADOW_ENV,
  });
  assert.equal(await handler(source, {}), undefined);
  await handler.pending();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hook, "compaction");
  assert.deepEqual(calls[0].meta.candidates, ["b1", "b2"]);
  assert.equal(calls[0].meta.candidatesTruncated, false);
  assert.equal(topPreserveSignal(compactionBatch(selection.blocks, "b2"), selection.blocks), "preserve:b2");
});

// --- C030: host boundary / host abort on the real event shape -------------------

test("C030: the host's compaction abort drops the queued measurement", async () => {
  let calls = 0;
  let release;
  const decide = () => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { release = () => resolve({ answers: {} }); });
    return Promise.resolve({ answers: {} });
  };
  const controller = new AbortController();
  const handler = createCompactionHandler({ decide, env: SHADOW_ENV });
  const first = event([entry("b1", "a".repeat(100))]); first.signal = controller.signal;
  const second = event([entry("b2", "b".repeat(100))]); second.signal = controller.signal;
  await handler(first, {});  // admitted and in flight before the abort
  await handler(second, {}); // queued behind it
  controller.abort();
  release();
  await handler.pending();
  assert.equal(calls, 1, "only the already-admitted measurement ran");

  const preAborted = new AbortController();
  preAborted.abort();
  const refused = event([entry("b3", "c".repeat(100))]); refused.signal = preAborted.signal;
  await handler(refused, {});
  await handler.pending();
  assert.equal(calls, 1, "an already-aborted host signal is refused at enqueue");
});

test("C030: jobs bind the session observed at event time and die with its boundary", async () => {
  const runContext = createRunContext();
  const calls = [];
  let release;
  const decide = (request, origin, hook, meta) => {
    calls.push(meta.session);
    if (calls.length === 1) return new Promise((resolve) => { release = () => resolve({ answers: {} }); });
    return Promise.resolve({ answers: {} });
  };
  const handler = createCompactionHandler({ decide, env: SHADOW_ENV, runContext });
  let current = "A";
  // The real host ctx exposes sessionManager as a live getter (dist `createContext`).
  const ctx = { get sessionManager() { return { getSessionId: () => current }; } };
  await handler(event([entry("b1", "a".repeat(100))]), ctx); // in flight, session A
  await handler(event([entry("b2", "b".repeat(100))]), ctx); // queued, session A
  current = "B"; // a switch already moved the live getter
  runContext.invalidate("A"); // session_shutdown(A) does exactly this
  release();
  await handler.pending();
  assert.deepEqual(calls, ["A"], "the queued send of the closed session is dropped; the in-flight measurement keeps A");
});

test("C030: a late result keeps the event-time session, never a later ctx value", async () => {
  const runContext = createRunContext();
  const calls = [];
  let release;
  const decide = (request, origin, hook, meta) => {
    calls.push(meta.session);
    if (calls.length === 1) return new Promise((resolve) => { release = () => resolve({ answers: {} }); });
    return Promise.resolve({ answers: {} });
  };
  const handler = createCompactionHandler({ decide, env: SHADOW_ENV, runContext });
  let current = "A";
  const ctx = { get sessionManager() { return { getSessionId: () => current }; } };
  await handler(event([entry("b1", "a".repeat(100))]), ctx);
  await handler(event([entry("b2", "b".repeat(100))]), ctx);
  current = "B"; // no boundary event yet — only the getter moved
  release();
  await handler.pending();
  assert.deepEqual(calls, ["A", "A"], "both jobs stay attributed to the session observed at their event");
});

// --- integration: receipt + eval through the single dispatch path --------------

const home = makeTempHome();
const evalFile = path.join(home, "compaction-eval.jsonl");
process.env.TYPESAFE_API_KEY = "offline-test-only";
process.env.PRIME_JEV_HOOK_COMPACTION = "shadow";
process.env.PRIME_JEV_G1 = "compaction:conversation-blocks";
// Measurement env is set inside the integration test only — the unit tests above run
// with the eval channel off, so their skip paths write nothing.
const fetchStub = installFetchStub();
const { default: loadBridge } = await import("../index.ts");
const { pi, hooks } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

test("shadow compaction: undefined result, v2 receipt, per-block eval predictions", async () => {
  process.env.PRIME_JEV_EVAL = "1";
  process.env.PRIME_JEV_EVAL_FILE = evalFile;
  const source = event([
    entry("b1", "We decided to keep the socket bridge because credential isolation matters. ".repeat(2)),
    entry("b2", "The earlier attempt with a shared global socket failed because of reload races. ".repeat(2)),
  ]);
  const blocks = compactionBlocks(source.branchEntries).blocks;
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 5 }, ...compactionBatch(blocks, "b2") }));
  const result = await hooks.get("session_before_compact")(source, {});
  assert.equal(result, undefined, "INVARIANT: no compaction result");

  const deadline = Date.now() + 3000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = fs.existsSync(evalFile) ? fs.readFileSync(evalFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    if (rows.length >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.hook, "compaction");
  assert.equal(row.g1_covered, true, "automatic hook row is G1-covered (J19)");
  assert.deepEqual(row.candidates, ["b1", "b2"]);
  assert.deepEqual(Object.keys(row.predictions).sort(), ["preserve_b1", "preserve_b2"]);

  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").trim().split("\n").at(-1));
  assert.equal(receipt.schema, "prime-jev/call/2");
  assert.equal(receipt.hook, "compaction");
  assert.equal(receipt.mode, "shadow");
  assert.equal(receipt.would, "preserve:b2");
  const raw = JSON.stringify(receipt);
  assert.equal(raw.includes("socket bridge because"), false, "no conversation text in receipts");
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  delete process.env.PRIME_JEV_HOOK_COMPACTION;
  delete process.env.PRIME_JEV_G1;
  delete process.env.PRIME_JEV_EVAL;
  delete process.env.PRIME_JEV_EVAL_FILE;
  fs.rmSync(home, { recursive: true, force: true });
});
