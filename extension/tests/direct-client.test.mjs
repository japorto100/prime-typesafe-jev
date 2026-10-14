// J19/Contrarian: direct client calls (socket path) are outside the hook mode ladder and
// the G1 matrix — receipts mark them `direct`, eval rows `g1_covered: false`.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { after } from "node:test";

import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const home = makeTempHome();
const evalFile = path.join(home, "direct-eval.jsonl");
process.env.TYPESAFE_API_KEY = "offline-test-only";
process.env.PRIME_JEV_EVAL = "1";
process.env.PRIME_JEV_EVAL_FILE = evalFile;
const fetchStub = installFetchStub();
const { default: loadBridge } = await import("../index.ts");
const { pi } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

function callSocket(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("socket timeout"));
    });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    });
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
  });
}

test("socket call is marked `direct` and its eval row is not G1-covered", async () => {
  fetchStub.decision({ type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } });
  const response = await callSocket(bridge.socketPath, { method: "choice", params: { task: "x", criteria: { yes: "y", no: "n" } } });
  assert.equal(response.error, undefined);

  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").trim().split("\n").at(-1));
  assert.equal(receipt.hook, "explicit_python");
  assert.equal(receipt.origin, "explicit_python");
  assert.equal(receipt.mode, "direct", "direct calls are not on the hook ladder");
  assert.equal(receipt.outcome, "answered");

  const evalRow = JSON.parse(fs.readFileSync(evalFile, "utf8").trim().split("\n").at(-1));
  assert.equal(evalRow.mode, "direct");
  assert.equal(evalRow.g1_covered, false, "the G1 matrix does not cover direct client calls");
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  delete process.env.PRIME_JEV_EVAL;
  delete process.env.PRIME_JEV_EVAL_FILE;
  fs.rmSync(home, { recursive: true, force: true });
});
