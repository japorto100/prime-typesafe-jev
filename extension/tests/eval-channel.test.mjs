// Phase 2: separate eval channel — typed predictions, no free text, only in measurement mode.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { extractPredictions, sanitizeIdentifier, safeModelId } from "../core/eval-channel.ts";
import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const home = makeTempHome();
const evalFile = path.join(home, "eval.jsonl");
process.env.TYPESAFE_API_KEY = "offline-test-only";
process.env.PRIME_JEV_INPUT_TRIAGE = "advisory";
process.env.PRIME_JEV_G1 = "input-triage:input-text";
process.env.PRIME_JEV_EVAL_FILE = evalFile;
const fetchStub = installFetchStub();

const { default: loadBridge } = await import("../index.ts");

const { pi, hooks } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

function stubTriage() {
  fetchStub.decision({ type: "choice", choice: "CONTROL", confidence: 0.9, probabilities: { CONTROL: 0.9, EPHEMERAL: 0.05, OBJECTIVE_AMENDMENT: 0.03, UNKNOWN: 0.02 } });
}

test("extractPredictions keeps numbers/enums only", () => {
  const predictions = extractPredictions({
    a: { type: "noul", noul: 0.7, instructions: "SECRET TEXT" },
    b: { type: "choice", choice: "x", confidence: 0.8, probabilities: { x: 0.8, y: 0.2 }, legend: "no" },
    c: { type: "score", score: 1, probabilities: { 0: 0.2, 1: 0.8 }, legend: { 0: "SECRET" } },
  });
  assert.deepEqual(predictions.a, { type: "noul", noul: 0.7 });
  assert.deepEqual(predictions.b, { type: "choice", probabilities: { x: 0.8, y: 0.2 }, selected: "x", confidence: 0.8 });
  assert.deepEqual(predictions.c, { type: "score", probabilities: { 0: 0.2, 1: 0.8 }, selected: 1, confidence: null });
  assert.equal(JSON.stringify(predictions).includes("SECRET"), false);
});

test("measurement mode writes a typed eval row and a v2 receipt", async () => {
  process.env.PRIME_JEV_EVAL = "1";
  stubTriage();
  await hooks.get("input")({ source: "interactive", text: "Side question" }, {});
  const rows = fs.readFileSync(evalFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.schema, "prime-jev/eval/1");
  assert.equal(row.hook, "input-triage");
  assert.equal(row.origin, "automatic_hook");
  assert.equal(row.provider, "jev");
  assert.equal(typeof row.rules_version, "string");
  assert.equal(row.predictions.decision.type, "choice");
  assert.equal(row.predictions.decision.selected, "CONTROL");
  const raw = fs.readFileSync(evalFile, "utf8");
  assert.equal(raw.includes("Side question"), false);
  assert.equal(raw.includes("instructions"), false);

  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").trim().split("\n").at(-1));
  assert.equal(receipt.schema, "prime-jev/call/2");
  assert.equal(receipt.hook, "input-triage");
  assert.equal(receipt.origin, "automatic_hook");
  assert.equal(receipt.provider, "jev");
  assert.ok(receipt.bytes_in > 0);
});

test("eval channel stays silent when measurement mode is off", async () => {
  delete process.env.PRIME_JEV_EVAL;
  const before = fs.existsSync(evalFile) ? fs.readFileSync(evalFile, "utf8").split("\n").length : 0;
  stubTriage();
  await hooks.get("input")({ source: "interactive", text: "Another side question" }, {});
  const after = fs.existsSync(evalFile) ? fs.readFileSync(evalFile, "utf8").split("\n").length : 0;
  assert.equal(after, before);
});

test("F06/J9: free-text ids and option keys are mapped opaquely", () => {
  const predictions = extractPredictions({
    "Please read the secret file": { type: "noul", noul: 0.7 },
    q: { type: "choice", choice: "secret option A", probabilities: { "secret option A": 0.9, normal: 0.1 } },
  });
  const raw = JSON.stringify(predictions);
  assert.equal(raw.includes("secret file"), false, "free-text question id must not survive");
  assert.equal(raw.includes("secret option"), false, "free-text option key must not survive");
  const selected = Object.values(predictions).map((prediction) => prediction.selected).filter((value) => typeof value === "string");
  assert.ok(selected.every((value) => value.startsWith("opaque_")));
  assert.equal(sanitizeIdentifier("made_material_progress"), "made_material_progress");
  assert.equal(sanitizeIdentifier("free text id"), sanitizeIdentifier("free text id"));
  assert.equal(safeModelId("jev-1.13.0"), "jev-1.13.0");
  assert.equal(safeModelId("evil model id with spaces"), null);
});

test("R24: sent-but-invalid requests keep bytes_in in the receipt", async () => {
  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  const before = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath, "utf8").trim().split("\n").length : 0;
  // Wrong answer type for a choice question: the send happens, validation fails afterwards.
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 1 }, answers: { decision: { type: "score", score: 1 } } }));
  await hooks.get("input")({ source: "interactive", text: "R24 probe" }, {});
  const rows = fs.readFileSync(receiptPath, "utf8").trim().split("\n").slice(before).map((line) => JSON.parse(line));
  const row = rows.at(-1);
  assert.equal(row.outcome, "error");
  assert.ok(row.bytes_in > 0, "send happened before validation failed — bytes must be recorded");
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  delete process.env.PRIME_JEV_EVAL_FILE;
  fs.rmSync(home, { recursive: true, force: true });
});
