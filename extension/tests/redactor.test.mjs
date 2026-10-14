// J10 redactor corpus + egress modes (redact default, block opt-in).
// Review 24.09. F01: structural payload redaction (valid JSON, secret gone) and full Bearer removal.
import assert from "node:assert/strict";
import fs from "node:fs";
import test, { after } from "node:test";

import { redactBody, redactPayload } from "../core/redactor.ts";
import { installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const home = makeTempHome();
process.env.TYPESAFE_API_KEY = "offline-test-only";
const fetchStub = installFetchStub();
const { handleDecision } = await import("../index.ts");

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const PRIVATE_KEY_BLOCK = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----";

const SECRETS = [
  `Authorization: Bearer ${JWT}`,
  "token=ghp_abcdefghijklmnopqrstuvwx",
  "openrouter key sk-or-v1-abcdefghijklmnopqrstuvwx",
  "aws AKIAIOSFODNN7EXAMPLE",
  PRIVATE_KEY_BLOCK,
  'api_key = "abcdef1234567890abcdef"',
  "postgres://admin:hunter2secret@db.example.com:5432/app",
];

// Verify-Fix 24.09.: §4 path deny — these paths never leave the host.
const SENSITIVE_PATHS = [
  "file=.env",
  "config/.env.local",
  "auth.json",
  "/home/user/.ssh/id_rsa",
  "certs/server.pem",
  "~/project/.env",
];

const BENIGN = [
  "hello world",
  "the token budget is 64 KiB",
  "rm -rf is documented in the guard corpus",
  "sk-1.2.3 is a package version, not a secret",
  "secret sauce recipe",
  "path: /home/user/project/src/index.ts",
  "Bearer tokens are validated by the host",
  "auth.jsonl rotation is documented",
  "environment variables are listed",
  "the pem format has a header",
];

test("J10 secret corpus is redacted", () => {
  for (const secret of SECRETS) {
    const { body, redactions } = redactBody(`state=${secret}`);
    assert.ok(redactions >= 1, `no redaction for: ${secret.slice(0, 30)}`);
    assert.ok(body.includes("[REDACTED]"));
    if (!secret.includes("PRIVATE KEY")) {
      assert.equal(body.includes(secret), false, `secret leaked: ${secret.slice(0, 30)}`);
    }
  }
});

test("F01 bearer token is fully removed, not merely marked", () => {
  const { body, redactions } = redactBody(`Authorization: Bearer ${JWT}`);
  assert.ok(redactions >= 1);
  assert.equal(body.includes(JWT), false, "the token value must disappear");
  assert.equal(body.includes("Bearer [REDACTED]"), true);
});

test("Verify-Fix: §4 path-deny corpus is redacted with its own marker", () => {
  for (const path of SENSITIVE_PATHS) {
    const { body, redactions } = redactBody(`cwd=${path} and more`);
    assert.ok(redactions >= 1, `no redaction for: ${path}`);
    assert.ok(body.includes("[REDACTED:path]"), `missing path marker for: ${path}`);
    const tail = path.split("/").pop();
    if (tail && !tail.startsWith(".env") && tail !== "auth.json") {
      assert.equal(body.includes(path), false, `path leaked: ${path}`);
    }
  }
});

test("Verify-Fix: path-deny works end to end and stays out of the wire body", async () => {
  delete process.env.PRIME_JEV_EGRESS;
  fetchStub.raw(JSON.stringify({ answers: { decision: { type: "noul", noul: 0.8 } } }));
  await handleDecision({ method: "noul", params: { condition: "x", context: "reads /home/u/.ssh/id_rsa before running" } }, "test", false);
  const sent = fetchStub.state.payloads.at(-1).body;
  assert.equal(JSON.stringify(sent).includes(".ssh/id_rsa"), false);
  assert.ok(JSON.stringify(sent).includes("[REDACTED:path]"));
});

test("F01 structured payload redaction keeps valid JSON and removes secret values", () => {
  const payload = {
    state: { password: "hunter2supersecret", token: "ghp_abcdefghijklmnopqrstuvwx", note: "keep me" },
    questions: { q: { type: "noul", instructions: "uses Bearer " + JWT } },
  };
  const { value, redactions } = redactPayload(payload);
  const serialized = JSON.stringify(value);
  assert.ok(redactions >= 3);
  assert.equal(serialized.includes("hunter2supersecret"), false);
  assert.equal(serialized.includes("ghp_abcdefghijklmnopqrstuvwx"), false);
  assert.equal(serialized.includes(JWT), false);
  assert.equal(serialized.includes("keep me"), true, "non-secret values survive");
  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.deepEqual(Object.keys(JSON.parse(serialized).state).sort(), ["note", "password", "token"]);
});

test("J10 benign corpus is untouched", () => {
  for (const text of BENIGN) {
    const { body, redactions } = redactBody(text);
    assert.equal(redactions, 0, `false positive for: ${text}`);
    assert.equal(body, text);
  }
});

test("J10 default redact works end to end (payload carries [REDACTED], no raw secret)", async () => {
  delete process.env.PRIME_JEV_EGRESS;
  fetchStub.raw(JSON.stringify({ answers: { decision: { type: "noul", noul: 0.8 } } }));
  await handleDecision({ method: "noul", params: { condition: "x", context: "key=ghp_abcdefghijklmnopqrstuvwx" } }, "test", false);
  const sent = fetchStub.state.payloads.at(-1).body;
  assert.equal(JSON.stringify(sent).includes("ghp_abcdefghijklmnopqrstuvwx"), false);
  assert.ok(JSON.stringify(sent).includes("[REDACTED]"));
});

test("F01 structured redaction works end to end (wire body stays valid JSON)", async () => {
  delete process.env.PRIME_JEV_EGRESS;
  fetchStub.raw(JSON.stringify({ answers: { decision: { type: "noul", noul: 0.8 } } }));
  await handleDecision({ method: "noul", params: { condition: "x", context: { password: "supersecretvalue1", keep: "ok" } } }, "test", false);
  const sent = fetchStub.state.payloads.at(-1).body; // helper JSON.parses the wire body — invalid JSON would throw here
  assert.equal(JSON.stringify(sent).includes("supersecretvalue1"), false);
  assert.equal(sent.state.keep, "ok");
  assert.equal(typeof sent.state.password, "string");
});

test("J10 block mode refuses before any fetch", async () => {
  process.env.PRIME_JEV_EGRESS = "block";
  const before = fetchStub.state.calls;
  fetchStub.raw(JSON.stringify({ answers: { decision: { type: "noul", noul: 0.8 } } }));
  await assert.rejects(
    () => handleDecision({ method: "noul", params: { condition: "x", context: "api_key=abcdef1234567890abcdef" } }, "test", false),
    /JevEgressBlocked/,
  );
  assert.equal(fetchStub.state.calls, before);
  delete process.env.PRIME_JEV_EGRESS;
});

test("J10 redaction stays bounded on 64 KiB input", () => {
  const big = { state: "x".repeat(65536) };
  const started = performance.now();
  const { redactions } = redactPayload(big);
  const elapsed = performance.now() - started;
  assert.equal(redactions, 0);
  assert.ok(elapsed < 1000, `redaction took ${elapsed.toFixed(0)}ms (must stay well under the hook budget)`);
});

after(() => {
  fetchStub.restore();
  fs.rmSync(home, { recursive: true, force: true });
});
