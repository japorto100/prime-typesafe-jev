// Phase 7: A8 refine-advisor — facts-only state, shadow measurement, planner untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { buildRefineQuestions, createRefineAdvisorHandler, refineFacts, topRefineSignal } from "../hooks/refine-advisor.ts";
import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const SHADOW_ENV = { PRIME_JEV_HOOK_REFINE: "shadow", PRIME_JEV_G1: "refine:metrics" };

function batch(top = "repeated_pattern", value = 0.9) {
  const answers = {};
  for (const id of Object.keys(buildRefineQuestions())) answers[id] = { type: "noul", noul: id === top ? value : 0.2 };
  return { answers };
}

const event = (extra = {}) => ({
  type: "session_before_refine",
  preparation: {
    trigger: "auto",
    scope: "local",
    history: [{}, {}],
    conversationText: "x".repeat(1000),
    instructions: "bitte das Socket-Muster als Harness-Wissen prüfen",
    ...extra,
  },
});

test("refine facts stay compact (no conversation text) and are a planning preflight", () => {
  const facts = refineFacts(event());
  assert.deepEqual(facts, {
    trigger: "auto",
    scope: "local",
    history_count: 2,
    conversation_bytes: 1000,
    instructions_excerpt: "bitte das Socket-Muster als Harness-Wissen prüfen",
    planning_state_keys: [],
  });
  const long = refineFacts(event({ instructions: "y".repeat(1000) }));
  assert.equal(String(long.instructions_excerpt).length, 300);
  const withState = refineFacts({ preparation: { trigger: "manual", scope: "global", history: [], conversationText: "", planningState: { localEntries: [], globalEntries: [] } } });
  assert.deepEqual(withState.planning_state_keys, ["localEntries", "globalEntries"]);
});

test("C030: the host's refine abort drops the queued measurement", async () => {
  let calls = 0;
  let release;
  const decide = () => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { release = () => resolve(batch()); });
    return Promise.resolve(batch());
  };
  const controller = new AbortController();
  const handler = createRefineAdvisorHandler({ decide, env: SHADOW_ENV });
  const first = event(); first.signal = controller.signal;
  const second = event({ instructions: "another, different planning instruction" }); second.signal = controller.signal;
  await handler(first, {});  // admitted and in flight
  await handler(second, {}); // queued
  controller.abort();
  release();
  await handler.pending();
  assert.equal(calls, 1, "the host-cancelled round is not measured late");
});

test("refine: off and missing G1 stay silent; handler never interferes", async () => {
  let calls = 0;
  const decide = async () => { calls += 1; return batch(); };
  await createRefineAdvisorHandler({ decide, env: {} })(event(), {});
  await createRefineAdvisorHandler({ decide, env: { PRIME_JEV_HOOK_REFINE: "shadow" } })(event(), {});
  assert.equal(calls, 0);

  const failing = { decide: async () => { throw new Error("down"); } };
  const handler = createRefineAdvisorHandler({ decide: failing.decide, env: SHADOW_ENV });
  assert.equal(await handler(event(), {}), undefined);
  await handler.pending();
});

test("refine shadow: one call per identical fact set, non-blocking, top signal", async () => {
  const calls = [];
  const slow = {
    decide: (request, origin, hook, meta) =>
      new Promise((resolve) => {
        setTimeout(() => {
          calls.push({ request, origin, hook, meta });
          resolve(batch("stable_enough"));
        }, 50);
      }),
  };
  const handler = createRefineAdvisorHandler({ decide: slow.decide, env: SHADOW_ENV });
  const started = performance.now();
  assert.equal(await handler(event(), {}), undefined);
  assert.ok(performance.now() - started < 40, "handler must not wait for JEV");
  assert.equal(await handler(event(), {}), undefined, "identical facts are deduped");
  await handler.pending();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hook, "refine");
  assert.equal(calls[0].origin, "automatic_hook");
  assert.equal(topRefineSignal(batch("stable_enough")), "stable_enough");
  assert.deepEqual(Object.keys(calls[0].request.params.questions).sort(), Object.keys(buildRefineQuestions()).sort());
});

// --- integration: receipt + eval through the single dispatch path --------------

const home = makeTempHome();
const evalFile = path.join(home, "refine-eval.jsonl");
process.env.TYPESAFE_API_KEY = "offline-test-only";
process.env.PRIME_JEV_HOOK_REFINE = "shadow";
process.env.PRIME_JEV_G1 = "refine:metrics";
process.env.PRIME_JEV_EVAL = "1";
process.env.PRIME_JEV_EVAL_FILE = evalFile;
const fetchStub = installFetchStub();
const { default: loadBridge } = await import("../index.ts");
const { pi, hooks } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

test("shadow refine: undefined result, v2 receipt, typed eval row, no text leakage", async () => {
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 4 }, ...batch("generalizable") }));
  const result = await hooks.get("session_before_refine")(event(), {});
  assert.equal(result, undefined, "INVARIANT: planner is never suppressed");

  const deadline = Date.now() + 3000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = fs.existsSync(evalFile) ? fs.readFileSync(evalFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    if (rows.length >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hook, "refine");
  assert.deepEqual(Object.keys(rows[0].predictions).sort(), Object.keys(buildRefineQuestions()).sort());

  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").trim().split("\n").at(-1));
  assert.equal(receipt.hook, "refine");
  assert.equal(receipt.mode, "shadow");
  assert.equal(receipt.outcome, "answered");
  assert.equal(receipt.would, "generalizable");
  assert.equal(JSON.stringify(receipt).includes("Socket-Muster"), false);
  assert.equal(fs.readFileSync(evalFile, "utf8").includes("Socket-Muster"), false, "instructions excerpt never enters the eval channel");
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  delete process.env.PRIME_JEV_HOOK_REFINE;
  delete process.env.PRIME_JEV_G1;
  delete process.env.PRIME_JEV_EVAL;
  delete process.env.PRIME_JEV_EVAL_FILE;
  fs.rmSync(home, { recursive: true, force: true });
});
