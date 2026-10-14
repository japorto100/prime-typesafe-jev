// Phase 2: receipts v2 is an additive superset — the union reader accepts v1 and v2 rows.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callReceipt, normalizeReceipt } from "../receipts.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.resolve(HERE, "..", "..", "..", "archive", "2026-09-24-jev-calls-baseline", "jev-calls.jsonl");
// Standalone fallback (Review 24.09. §8): the union reader is testable without the
// baseline archive — a real v1 row shape (content-free) is embedded.
const EMBEDDED_V1 = JSON.stringify({
  schema: "prime-jev/call/1",
  at: "2026-09-19T12:00:00.000Z",
  host_pid: 12345,
  reported_client_pid: null,
  reported_depth: null,
  origin_attested: false,
  method: "noul",
  question_count: 1,
  status: "success",
  elapsed_ms: 700,
  model: "jev-1.13.0",
});

test("v1 baseline rows normalize with explicit defaults", () => {
  const first = fs.existsSync(BASELINE) ? fs.readFileSync(BASELINE, "utf8").split("\n").find(Boolean) : EMBEDDED_V1;
  const row = JSON.parse(first);
  assert.equal(row.schema, "prime-jev/call/1");
  const normalized = normalizeReceipt(row);
  assert.equal(normalized.schema, "prime-jev/call/1");
  assert.equal(normalized.hook, "unknown");
  assert.equal(normalized.mode, "live");
  assert.equal(normalized.origin, "unknown");
  assert.equal(normalized.outcome, row.status === "success" ? "answered" : "error");
  assert.equal(normalized.provider, null);
  assert.equal(normalized.redactions, 0);
  assert.equal(typeof normalized.elapsed_ms, "number");
});

test("v2 rows carry the new contract fields additively (incl. model)", () => {
  const request = { method: "system_one", params: { questions: { q: {} } }, caller: { pid: 123, reported_depth: "2" } };
  const result = { model: "jev-1.13.0" };
  const row = callReceipt(request, result, "success", 42.4, {
    hook: "input-triage",
    mode: "shadow",
    origin: "automatic_hook",
    outcome: "answered",
    questions_version: "abc",
    provider: "jev",
    bytes_in: 100,
    bytes_out: 50,
    redactions: 2,
    decision_id: "d-1",
    session: "s-1",
    turn: 3,
  });
  assert.equal(row.schema, "prime-jev/call/2");
  assert.equal(row.model, "jev-1.13.0");
  assert.equal(row.question_count, 1);
  assert.equal(row.reported_depth, 2);
  assert.equal(row.hook, "input-triage");
  assert.equal(row.mode, "shadow");
  assert.equal(row.origin, "automatic_hook");
  assert.equal(row.outcome, "answered");
  assert.equal(row.provider, "jev");
  assert.equal(row.bytes_in, 100);
  assert.equal(row.bytes_out, 50);
  assert.equal(row.redactions, 2);
  assert.equal(row.would, null);
  assert.equal(row.decision_id, "d-1");
  assert.equal(row.session, "s-1");
  assert.equal(row.turn, 3);
  const normalized = normalizeReceipt(row);
  assert.equal(normalized.hook, "input-triage");
  assert.equal(normalized.origin, "automatic_hook");
  assert.equal(normalized.provider, "jev");
  assert.equal(normalized.decision_id, "d-1");
});

test("v2 rows stay content-free", () => {
  const row = callReceipt(
    { method: "choice", params: { context: "secret context", choices: ["a"] } },
    { choice: "a" },
    "success",
    5,
    { hook: "x" },
  );
  const raw = JSON.stringify(row);
  assert.equal(raw.includes("secret context"), false);
  assert.equal(raw.includes("secret"), false);
});
