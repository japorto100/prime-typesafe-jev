// R2-7 (Contrarian Rev.2): Zwei-Prozess-Interleaving gegen dieselbe State-Datei.
// Invarianten: keine Ueber-Admission, keine verlorenen Updates (persistierte Calls == Summe
// der bestaetigten Reservierungen beider Prozesse).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(HERE, "budget-concurrency.worker.mjs");
const policy = { rootCalls: 1000, perHook: {}, rootBytes: 1_000_000, dayCalls: 12, dayBytes: 1_000_000 };

function runWorker(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, file, "60", JSON.stringify(policy)], {
      cwd: HERE,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("two processes interleave without over-admission or lost updates (R2-7)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-budget-conc-"));
  const file = path.join(dir, "state.json");
  try {
    const [a, b] = await Promise.all([runWorker(file), runWorker(file)]);
    assert.equal(a.code, 0, a.err || a.out);
    assert.equal(b.code, 0, b.err || b.out);
    const okA = JSON.parse(a.out).ok;
    const okB = JSON.parse(b.out).ok;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(okA + okB, 12, `no over-admission (A=${okA}, B=${okB})`);
    assert.equal(state.calls, 12, "persisted calls equal admitted calls (no lost update)");
    assert.equal(state.bytes, 120);
    assert.equal(state.active.length, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
