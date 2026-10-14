// Ported from archive/2026-09-23-jev-review/checks/check_bridge.cjs (18 probes).
// Phase 1: the former confirmed_gap probes now assert the FIXED behavior; the archived
// review package stays red as historical counter-evidence (never run in place).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const home = makeTempHome();
process.env.TYPESAFE_API_KEY = "offline-test-only";
process.env.PRIME_JEV_INPUT_TRIAGE = "advisory";
process.env.PRIME_JEV_G1 = "input-triage:input-text";
const fetchStub = installFetchStub();

const { default: loadBridge, handleDecision } = await import("../index.ts");
const { requestConfirmation } = await import("../confirmation.ts");
const { withCodingPolicy } = await import("../coding-policy.ts");

const request = (q) => ({ method: "system_one", params: { state: "offline fixture", questions: { q } } });
const cq = { type: "choice", instructions: "Choose the matching option", criteria: { a: "A", b: "B" } };
const sq = { type: "score", instructions: "Rate", criteria: ["low", "high"] };
const nq = { type: "noul", instructions: "Is this true?" };

// --- guards that were already working ----------------------------------------

test("batch rejects missing answer", async () => {
  fetchStub.raw(JSON.stringify({ answers: {} }));
  await assert.rejects(() => handleDecision(request(nq), "test", false), /missing/);
});

test("batch rejects nonnormalized distribution", async () => {
  fetchStub.stub({ type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.9 } });
  await assert.rejects(() => handleDecision(request(cq), "test", false), /distribution/);
});

test("batch rejects score-distribution conflict", async () => {
  fetchStub.stub({ type: "score", score: 1, confidence: 1, probabilities: { 0: 1, 1: 0 }, legend: { 0: "low", 1: "high" } });
  await assert.rejects(() => handleDecision(request(sq), "test", false), /disagrees/);
});

test("batch accepts rounded consistent distribution", async () => {
  fetchStub.stub({ type: "score", score: 1, confidence: 0.1, probabilities: { 0: 0.33, 1: 0.33, 2: 0.33 }, legend: { 0: "low", 1: "mid", 2: "high" } });
  const result = await handleDecision(request({ ...sq, criteria: ["low", "mid", "high"] }), "test", false);
  assert.equal(result.answers.q.score, 1);
});

test("oversized upstream request rejected before fetch", async () => {
  const before = fetchStub.state.calls;
  await assert.rejects(
    () => handleDecision({ method: "system_one", params: { state: "x".repeat(65536), questions: { q: nq } } }, "test", false),
    /TooLarge/,
  );
  assert.equal(fetchStub.state.calls, before);
});

test("upstream private error body is not reflected", async () => {
  fetchStub.raw("PRIVATE_SECRET_BODY", { status: 503 });
  await assert.rejects(
    () => handleDecision(request(nq), "test", false),
    (error) => error.message.includes("503") && !error.message.includes("PRIVATE_SECRET"),
  );
});

test("malformed JSON does not reflect private bytes", async () => {
  fetchStub.raw("PRIVATE_SECRET_NOT_JSON");
  await assert.rejects(
    () => handleDecision(request(nq), "test", false),
    (error) => error.message.includes("malformed") && !error.message.includes("PRIVATE_SECRET"),
  );
});

test("coding policy append is idempotent", () => {
  const once = withCodingPolicy("base");
  assert.equal(withCodingPolicy(once), once);
});

test("confirmation timeout denies", async () => {
  assert.equal(await requestConfirmation(() => new Promise(() => {}), undefined, 15), false);
});

test("malformed confirmation truthy string denies", async () => {
  assert.equal(await requestConfirmation(() => "true", undefined, 30), false);
});

// --- Phase 1 fixes (formerly confirmed gaps) ----------------------------------

test("J03 wrong choice argmax is rejected (0.01 vs 0.99)", async () => {
  fetchStub.stub({ type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.01, b: 0.99 } });
  await assert.rejects(() => handleDecision(request(cq), "test", false), /disagrees/);
});

test("J03 tied maxima are accepted (incl. rounding ties)", async () => {
  fetchStub.stub({ type: "choice", choice: "a", confidence: 0.5, probabilities: { a: 0.5, b: 0.5 } });
  const tied = await handleDecision(request(cq), "test", false);
  assert.equal(tied.answers.q.choice, "a");
  // 0.49 vs 0.50: intervals touch at 0.495 — a true tie is possible under hundredth rounding.
  fetchStub.stub({ type: "choice", choice: "a", confidence: 0.5, probabilities: { a: 0.49, b: 0.5 } });
  const rounded = await handleDecision(request(cq), "test", false);
  assert.equal(rounded.answers.q.choice, "a");
});

test("J03 a clearly smaller probability never passes as maximum", async () => {
  fetchStub.stub({ type: "choice", choice: "b", confidence: 0.9, probabilities: { a: 0.6, b: 0.4 } });
  await assert.rejects(() => handleDecision(request(cq), "test", false), /disagrees/);
});

test("J04 missing model and usage are rejected", async () => {
  fetchStub.stub({ type: "noul", noul: 0.8 }, {});
  await assert.rejects(() => handleDecision(request(nq), "test", false), /missing model|missing usage/);
});

test("J04 legend must match the requested rubric", async () => {
  fetchStub.stub({ type: "score", score: 0, confidence: 1, probabilities: { 0: 1, 1: 0 }, legend: { 0: "high", 1: "low" } });
  await assert.rejects(() => handleDecision(request(sq), "test", false), /legend disagrees/);
});

test("J02 legacy score outside the rubric is rejected", async () => {
  fetchStub.raw(JSON.stringify({ answers: { decision: { type: "score", score: 999, confidence: 1, probabilities: { 0: 1, 1: 0 }, legend: { 0: "low", 1: "high" } } } }));
  await assert.rejects(() => handleDecision({ method: "score", params: { context: "x", criteria: ["low", "high"] } }, "test", false), /invalid score/);
});

test("J02 legacy answer type mismatch and invalid confidence are rejected", async () => {
  fetchStub.raw(JSON.stringify({ answers: { decision: { type: "score", choice: "a", confidence: -10, probabilities: {} } } }));
  await assert.rejects(() => handleDecision({ method: "choice", params: { choices: ["a", "b"], context: "x" } }, "test", false), /mismatched answer/);
});

test("F02 fractional scores are valid (docs: score can land between levels)", async () => {
  fetchStub.stub({ type: "score", score: 1.05, confidence: 0.92, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, legend: { 0: "low", 1: "mid", 2: "high" } });
  const accepted = await handleDecision(request({ ...sq, criteria: ["low", "mid", "high"] }), "test", false);
  assert.equal(accepted.answers.q.score, 1.05);
  fetchStub.stub({ type: "score", score: 2.5, confidence: 0.9, probabilities: { 0: 0, 1: 0.1, 2: 0.9 }, legend: { 0: "low", 1: "mid", 2: "high" } });
  await assert.rejects(() => handleDecision(request({ ...sq, criteria: ["low", "mid", "high"] }), "test", false), /invalid score/);
});

test("F02 legacy fractional score accepted and metadata survives the return path", async () => {
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 1 }, answers: { decision: { type: "score", score: 1.05, confidence: 0.9, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, legend: { 0: "low", 1: "mid", 2: "high" } } } }));
  const result = await handleDecision({ method: "score", params: { context: "x", criteria: ["low", "mid", "high"] } }, "test", false);
  assert.equal(result.score, 1.05);
  assert.equal(result.model, "jev-1.13.0", "legacy results keep model metadata");
});

test("J01 bash guard: dd --help passes, raw-device dd blocks", async () => {
  const help = await hooks.get("tool_call")({ toolName: "bash", input: { command: "dd --help" } }, { hasUI: false });
  assert.equal(help, undefined);
  const raw = await hooks.get("tool_call")({ toolName: "bash", input: { command: "dd of=/dev/sda bs=1M" } }, { hasUI: false });
  assert.equal(raw.block, true);
});

test("J01 ipython floor blocks destructive calls and spares benign ones", async () => {
  const benign = await hooks.get("tool_call")({ toolName: "ipython", input: { code: "import subprocess; subprocess.run(['dd', '--help'])" } }, { hasUI: false });
  assert.equal(benign, undefined);
  const destructive = await hooks.get("tool_call")({ toolName: "ipython", input: { code: "import subprocess; subprocess.run(['dd', 'of=/dev/sda'])" } }, { hasUI: false });
  assert.equal(destructive.block, true);
});

test("J09 triage calls write a content-free receipt", async () => {
  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  assert.equal(fs.existsSync(receiptPath), false);
  fetchStub.decision({ type: "choice", choice: "CONTROL", confidence: 0.9, probabilities: { CONTROL: 0.9, EPHEMERAL: 0.05, OBJECTIVE_AMENDMENT: 0.03, UNKNOWN: 0.02 } });
  await hooks.get("input")({ source: "interactive", text: "Side question" }, {});
  assert.equal(fs.existsSync(receiptPath), true);
  const lines = fs.readFileSync(receiptPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.schema, "prime-jev/call/2");
  assert.equal(receipt.method, "choice");
  assert.equal(receipt.status, "success");
  assert.equal(receipt.outcome, "answered");
  const raw = fs.readFileSync(receiptPath, "utf8");
  assert.equal(raw.includes("Side question"), false);
  assert.equal(raw.includes("Control"), false);
});

// The bash/ipython gates are registered by loading the extension exactly like the host does.
const { pi, hooks } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

test("J12 endpoint stays stable across a reload-style re-acquire", async () => {
  const before = bridge.socketPath;
  const again = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
  assert.equal(again.socketPath, before);
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  fs.rmSync(home, { recursive: true, force: true });
});
