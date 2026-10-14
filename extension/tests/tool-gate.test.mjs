// Phase 4: A4 tool-gate — deterministic floor first (hard/fail-closed), JEV grey-zone
// layer second (shadow/advisory/live, G1-gated, never blocks by JEV alone).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { buildGateQuestions, createToolGate, looksMutating, riskPredicatesAbove, riskTopPredicate } from "../hooks/tool-gate.ts";
import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const SHADOW_ENV = { PRIME_JEV_HOOK_TOOL_GATE: "shadow", PRIME_JEV_G1: "tool-gate:tool-input" };
const ipy = (code, extra = {}) => ({ toolName: "ipython", input: { code }, ...extra });

const batch = (top = "irreversible", value = 0.8) => {
  const answers = {};
  for (const id of Object.keys(buildGateQuestions())) answers[id] = { type: "noul", noul: id === top ? value : 0.2 };
  return { answers };
};

function makeDecide(result) {
  const calls = [];
  return {
    calls,
    decide: async (request, origin, hook, meta) => {
      calls.push({ request, origin, hook, meta });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("prefilter: only mutating-looking inputs are grey zone", () => {
  assert.equal(looksMutating("print('hello')"), false);
  assert.equal(looksMutating("df = pd.read_csv('x.csv')"), false);
  assert.equal(looksMutating("open('config.yaml','w').write(text)"), true);
  assert.equal(looksMutating("subprocess.run(['git','status'])"), true);
});

test("read-only calls never reach JEV", async () => {
  const fake = makeDecide(batch());
  const gate = createToolGate({ decide: fake.decide, env: SHADOW_ENV });
  assert.equal(await gate(ipy("print('hi')"), {}), undefined);
  assert.equal(fake.calls.length, 0);
});

test("mutating allowed calls are asked once (dedupe); shadow never blocks", async () => {
  const fake = makeDecide(batch("irreversible"));
  const gate = createToolGate({ decide: fake.decide, env: SHADOW_ENV });
  const code = "open('out.txt','w').write('data')";
  const sessionManager = { getSessionId: () => "gate-fixture" };
  assert.equal(await gate(ipy(code), { cwd: "/work", sessionManager }), undefined);
  assert.equal(await gate(ipy(code), { cwd: "/work", sessionManager }), undefined);
  assert.equal(fake.calls.length, 1, "identical (session, tool, payload, cwd) is deduped");
  assert.equal(fake.calls[0].hook, "tool-gate");
  assert.equal(fake.calls[0].origin, "automatic_hook");
  assert.equal(fake.calls[0].request.params.state.cwd, "/work", "cwd is part of the grey-zone state");
  assert.deepEqual(Object.keys(fake.calls[0].request.params.questions).sort(), Object.keys(buildGateQuestions()).sort());
  assert.equal(riskTopPredicate(batch("uses_network")), "uses_network");
  assert.equal(await gate(ipy(code), { cwd: "/elsewhere", sessionManager }), undefined);
  assert.equal(fake.calls.length, 2, "the same payload in a different cwd is a different decision situation");
});

test("Verify-Fix: unknown CONFIRM_ON predicates never trigger a live block", async () => {
  const fake = makeDecide(batch("irreversible", 0.9));
  const env = { ...SHADOW_ENV, PRIME_JEV_HOOK_TOOL_GATE: "live", PRIME_JEV_TOOLGATE_CONFIRM_ON: "typo_predicate" };
  const gate = createToolGate({ decide: fake.decide, env });
  assert.equal(await gate(ipy("open('q','w')"), { headless: true }), undefined, "unknown predicate is ignored (logged), not a confirm source");
});

test("hard blocks and warnings stay deterministic — no JEV call", async () => {
  const fake = makeDecide(batch());
  const gate = createToolGate({ decide: fake.decide, env: SHADOW_ENV });
  const destructive = await gate(ipy("import subprocess; subprocess.run(['dd','of=/dev/sda'])"), { hasUI: false });
  assert.equal(destructive.block, true);
  const warn = await gate(ipy("os.remove('/tmp/foo')"), { hasUI: false });
  assert.equal(warn.block, true, "headless soft path fails closed");
  assert.equal(fake.calls.length, 0);
});

test("F03 UI failure cannot swallow the deterministic hard block", async () => {
  const fake = makeDecide(batch());
  const gate = createToolGate({ decide: fake.decide, env: SHADOW_ENV });
  const result = await gate(ipy("shutil.rmtree('/')"), { ui: { notify: () => { throw new Error("ui down"); } } });
  assert.equal(result?.block, true, "floor verdict survives a throwing UI");
  assert.equal(fake.calls.length, 0);
  assert.equal(result.reason.includes("denied by host safety policy"), true);
});

test("J12/R13: a benign high predicate cannot mask a high risk predicate", async () => {
  const answers = batch("irreversible", 0.98).answers;
  answers.regenerable = { type: "noul", noul: 0.99 };
  const decide = async () => ({ answers });
  const env = { ...SHADOW_ENV, PRIME_JEV_HOOK_TOOL_GATE: "live", PRIME_JEV_TOOLGATE_CONFIRM_ON: "irreversible" };
  const gate = createToolGate({ decide, env });
  const headless = await gate(ipy("open('z','w')"), { hasUI: false });
  assert.equal(headless?.block, true, "listed risk predicate still triggers confirmation despite benign 0.99");
  assert.deepEqual(riskPredicatesAbove({ answers }), ["irreversible"]);
  assert.equal(riskTopPredicate({ answers }), "irreversible");
});

test("J12/R14: a previously denied action is never allowed by dedupe", async () => {
  let calls = 0;
  const decide = async () => { calls += 1; return batch("irreversible"); };
  const env = { ...SHADOW_ENV, PRIME_JEV_HOOK_TOOL_GATE: "live", PRIME_JEV_TOOLGATE_CONFIRM_ON: "irreversible" };
  const gate = createToolGate({ decide, env });
  const code = "open('once.txt','w')";
  const sessionManager = { getSessionId: () => "denial-fixture" };
  assert.equal((await gate(ipy(code), { hasUI: false, sessionManager }))?.block, true);
  assert.equal((await gate(ipy(code), { hasUI: false, sessionManager }))?.block, true, "repeat must be denied again");
  assert.equal(calls, 1, "the JEV request itself is cached, the DECISION is re-evaluated");
});

test("missing G1 stays silent; JEV outage falls back to the floor", async () => {
  const noGrant = makeDecide(batch());
  const gateNoGrant = createToolGate({ decide: noGrant.decide, env: { PRIME_JEV_HOOK_TOOL_GATE: "shadow" } });
  await gateNoGrant(ipy("open('x','w')"), {});
  assert.equal(noGrant.calls.length, 0);

  const outage = makeDecide(new Error("JevBridgeError: down"));
  const gateOutage = createToolGate({ decide: outage.decide, env: SHADOW_ENV });
  assert.equal(await gateOutage(ipy("open('y','w')"), {}), undefined, "JEV outage must not throw or block");
});

test("advisory notifies but never blocks", async () => {
  const fake = makeDecide(batch("accesses_credentials"));
  const notices = [];
  const gate = createToolGate({ decide: fake.decide, env: { ...SHADOW_ENV, PRIME_JEV_HOOK_TOOL_GATE: "advisory" } });
  const result = await gate(ipy("open('.env','w')"), { ui: { notify: (message, level) => notices.push({ message, level }) } });
  assert.equal(result, undefined);
  assert.equal(notices.length, 1);
  assert.ok(notices[0].message.includes("accesses_credentials"));
});

test("live HITL only for explicitly listed predicates", async () => {
  const listed = makeDecide(batch("irreversible"));
  const env = { ...SHADOW_ENV, PRIME_JEV_HOOK_TOOL_GATE: "live", PRIME_JEV_TOOLGATE_CONFIRM_ON: "irreversible" };
  const gate = createToolGate({ decide: listed.decide, env });
  const headless = await gate(ipy("open('z','w')"), { hasUI: false });
  assert.equal(headless.block, true, "headless confirm requirement fails closed");

  const unlisted = makeDecide(batch("uses_network"));
  const gateUnlisted = createToolGate({ decide: unlisted.decide, env });
  assert.equal(await gateUnlisted(ipy("requests.get('https://example.com')"), { hasUI: false }), undefined);
});

// --- integration: receipt + eval through the single dispatch path --------------

const home = makeTempHome();
const evalFile = path.join(home, "gate-eval.jsonl");
process.env.TYPESAFE_API_KEY = "offline-test-only";
process.env.PRIME_JEV_HOOK_TOOL_GATE = "shadow";
process.env.PRIME_JEV_G1 = "tool-gate:tool-input";
process.env.PRIME_JEV_EVAL = "1";
process.env.PRIME_JEV_EVAL_FILE = evalFile;
const fetchStub = installFetchStub();
const { default: loadBridge } = await import("../index.ts");
const { pi, hooks } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

test("shadow gate: v2 receipt with would + typed eval row; blocked stays JEV-free", async () => {
  const answers = {};
  for (const id of Object.keys(buildGateQuestions())) answers[id] = { type: "noul", noul: id === "accesses_credentials" ? 0.9 : 0.1 };
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 8 }, answers }));
  const result = await hooks.get("tool_call")({ toolName: "ipython", input: { code: "open('secrets.txt','w').write('x')" } }, { hasUI: false });
  assert.equal(result, undefined, "shadow gate never blocks");

  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").trim().split("\n").at(-1));
  assert.equal(receipt.schema, "prime-jev/call/2");
  assert.equal(receipt.hook, "tool-gate");
  assert.equal(receipt.mode, "shadow");
  assert.equal(receipt.origin, "automatic_hook");
  assert.equal(receipt.outcome, "answered");
  assert.equal(receipt.would, "accesses_credentials");
  assert.ok(receipt.bytes_in > 0);
  assert.equal(JSON.stringify(receipt).includes("secrets.txt"), false, "no tool payload in receipts");

  const row = JSON.parse(fs.readFileSync(evalFile, "utf8").trim().split("\n").at(-1));
  assert.equal(row.hook, "tool-gate");
  assert.deepEqual(Object.keys(row.predictions).sort(), Object.keys(buildGateQuestions()).sort());
  assert.equal(fs.readFileSync(evalFile, "utf8").includes("secrets.txt"), false);

  const callsBefore = fetchStub.state.calls;
  const blocked = await hooks.get("tool_call")({ toolName: "ipython", input: { code: "shutil.rmtree('/')" } }, { hasUI: false });
  assert.equal(blocked.block, true);
  assert.equal(fetchStub.state.calls, callsBefore, "hard blocks never reach the provider");
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  delete process.env.PRIME_JEV_HOOK_TOOL_GATE;
  delete process.env.PRIME_JEV_G1;
  delete process.env.PRIME_JEV_EVAL;
  delete process.env.PRIME_JEV_EVAL_FILE;
  fs.rmSync(home, { recursive: true, force: true });
});
