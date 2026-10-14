// J11: the agent-dir override must drive both credential lookup and receipt paths.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { resolveAgentDir } from "../core/agent-dir.ts";
import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const home = makeTempHome();
const override = fs.mkdtempSync(path.join(os.tmpdir(), "jev-agent-dir-"));
process.env.PRIME_JEV_AGENT_DIR = override;
process.env.PRIME_JEV_INPUT_TRIAGE = "advisory";
process.env.PRIME_JEV_G1 = "input-triage:input-text";
delete process.env.TYPESAFE_API_KEY;
fs.writeFileSync(path.join(override, "auth.json"), JSON.stringify({ typesafe: { key: "k-from-file" } }));

const fetchStub = installFetchStub();
const { default: loadBridge } = await import("../index.ts");

const { pi, hooks } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

test("J11 override resolves and drives auth + receipts", async () => {
  assert.equal(resolveAgentDir(), override);
  fetchStub.decision({ type: "choice", choice: "CONTROL", confidence: 0.9, probabilities: { CONTROL: 0.9, EPHEMERAL: 0.05, OBJECTIVE_AMENDMENT: 0.03, UNKNOWN: 0.02 } });
  await hooks.get("input")({ source: "interactive", text: "Another side question" }, {});
  const headers = fetchStub.state.payloads.at(-1).headers;
  assert.equal(headers.Authorization, "Bearer k-from-file");
  const receiptPath = path.join(override, "receipts", "jev.calls.jsonl");
  assert.equal(fs.existsSync(receiptPath), true);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").trim());
  assert.equal(receipt.outcome, "answered");
  assert.equal(receipt.model, "jev-1.13.0", "legacy call metadata reaches the receipt");
  assert.equal(fs.existsSync(path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl")), false);
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  delete process.env.PRIME_JEV_AGENT_DIR;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(override, { recursive: true, force: true });
});
