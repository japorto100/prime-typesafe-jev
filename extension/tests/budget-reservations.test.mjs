// Policy B (JEV-06/07, Contrarian Rev.2): reservation-bound refund contract.
// Pflichtfälle: RES01 (Fremdtag-Refund debit nicht), RES02 (Hookquote zurück),
// Doppel-release (keine Über-Admission), Doppel-refund, release nach send, Migration v1->v2,
// Listengrenze (Cap -> fail-closed statt Eviction), Orphan-Verhalten, Zukunftsdatum,
// 4-KiB-/Rollback-Lesbarkeit, Lock-Fehlerpropagation.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, mock } from "node:test";

import { createBudget } from "../core/budget.ts";

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-budget-resv-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
const policy = (over = {}) => ({ rootCalls: 1000, perHook: {}, rootBytes: 1_000_000, dayCalls: 1000, dayBytes: 1_000_000, ...over });
const DAY1 = () => new Date("2026-09-29T23:59:00Z");
const DAY2 = () => new Date("2026-09-30T00:01:00Z");

test("RES01: a foreign-day refund must not debit today's reservations", () => {
  const file = path.join(tempDir(), "state.json");
  const a = createBudget({ rootId: "a", file, policy: policy({ dayCalls: 1 }), env: {}, now: DAY1 });
  const r1 = a.reserve("q", 100);
  assert.ok(r1);
  const b = createBudget({ rootId: "b", file, policy: policy({ dayCalls: 1 }), env: {}, now: DAY2 });
  assert.ok(b.reserve("q", 100), "new day quota admits one call");
  assert.equal(b.release(r1), "noop", "foreign-day refund is a documented no-op");
  const c = createBudget({ rootId: "c", file, policy: policy({ dayCalls: 1 }), env: {}, now: DAY2 });
  assert.equal(c.reserve("q", 100), null, "today's quota was not refunded by yesterday's release");
});

test("RES02: a pre-send refund restores the hook quota (Policy B)", () => {
  const file = path.join(tempDir(), "state.json");
  const b = createBudget({ rootId: "a", file, policy: policy({ perHook: { q: 1 } }), env: {}, now: DAY1 });
  const r = b.reserve("q", 100);
  assert.ok(r);
  assert.equal(b.reserve("q", 100), null, "hook cap reached while reserved");
  assert.equal(b.release(r), "refunded");
  assert.ok(b.reserve("q", 100), "hook quota is available again after the refund");
});

test("double release does not over-admit (verify reproducer)", () => {
  const file = path.join(tempDir(), "state.json");
  const b = createBudget({ rootId: "a", file, policy: policy({ dayCalls: 2 }), env: {}, now: DAY1 });
  const a = b.reserve("q", 100);
  const c = b.reserve("q", 100);
  assert.ok(a && c);
  assert.equal(b.release(a), "refunded");
  assert.equal(b.release(a), "noop", "second release of the same handle is a no-op");
  assert.ok(b.reserve("q", 100), "exactly one slot was freed");
  assert.equal(b.reserve("q", 100), null, "no extra slot from the double release");
});

test("release after send and a second send are no-ops", () => {
  const file = path.join(tempDir(), "state.json");
  const b = createBudget({ rootId: "a", file, policy: policy({ perHook: { q: 1 } }), env: {}, now: DAY1 });
  const r = b.reserve("q", 100);
  assert.ok(r);
  assert.equal(b.send(r), "sent");
  assert.equal(b.send(r), "noop");
  assert.equal(b.release(r), "noop", "a sent reservation cannot be refunded");
  assert.equal(b.reserve("q", 100), null, "hook quota stays consumed after send");
});

test("active reservations are capped fail-closed (no eviction over-admission)", () => {
  const file = path.join(tempDir(), "state.json");
  const b = createBudget({ rootId: "a", file, policy: policy(), env: {}, now: DAY1 });
  const handles = [];
  for (let i = 0; i < 24; i += 1) {
    const r = b.reserve("q", 1);
    assert.ok(r, `reservation ${i} admitted`);
    handles.push(r);
  }
  assert.equal(b.reserve("q", 1), null, "cap reached -> denied, not evicted");
  assert.equal(b.release(handles[0]), "refunded");
  assert.ok(b.reserve("q", 1), "freed slot admits again");
});

test("migration v1 -> v2 keeps counters and adds reservation fields", () => {
  const file = path.join(tempDir(), "state.json");
  fs.writeFileSync(file, JSON.stringify({ day: "2026-09-29", calls: 3, bytes: 30, skipped: 1 }) + "\n");
  const b = createBudget({ rootId: "a", file, policy: policy(), env: {}, now: DAY1 });
  assert.ok(b.reserve("q", 5));
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.calls, 4, "v1 counters carried forward");
  assert.equal(raw.skipped, 1);
  assert.equal(raw.v, 2);
  assert.ok(Array.isArray(raw.active));
  assert.equal(typeof raw.revision, "number");
});

test("state stays small and v1-shape readable (rollback safety)", () => {
  const file = path.join(tempDir(), "state.json");
  const b = createBudget({ rootId: "a", file, policy: policy(), env: {}, now: DAY1 });
  for (let i = 0; i < 24; i += 1) assert.ok(b.reserve(`h${i % 3}`, 16));
  const raw = fs.readFileSync(file);
  assert.ok(raw.byteLength <= 4096, `state file bounded (${raw.byteLength} bytes)`);
  const parsed = JSON.parse(raw.toString("utf8"));
  // v1 reader compatibility: the legacy counters remain valid and top-level.
  assert.equal(typeof parsed.day, "string");
  assert.equal(typeof parsed.calls, "number");
  assert.equal(typeof parsed.bytes, "number");
  assert.equal(typeof parsed.skipped, "number");
});

test("future-dated state is refused fail-closed", () => {
  const file = path.join(tempDir(), "state.json");
  fs.writeFileSync(file, JSON.stringify({ day: "2026-10-01", calls: 0, bytes: 0, skipped: 0 }) + "\n");
  const b = createBudget({ rootId: "a", file, policy: policy(), env: {}, now: DAY1 });
  assert.equal(b.reserve("q", 5), null, "future day refuses admission");
});

test("corrupt state file refuses admission (P01 regression)", () => {
  const dir = tempDir();
  const asDir = path.join(dir, "state.json");
  fs.mkdirSync(asDir);
  assert.equal(createBudget({ rootId: "a", file: asDir, policy: policy(), env: {}, now: DAY1 }).reserve("q", 5), null);
  const corrupt = path.join(dir, "corrupt.json");
  fs.writeFileSync(corrupt, '{"day":');
  assert.equal(createBudget({ rootId: "a", file: corrupt, policy: policy(), env: {}, now: DAY1 }).reserve("q", 5), null);
  const negative = path.join(dir, "negative.json");
  fs.writeFileSync(negative, JSON.stringify({ day: "2026-09-29", calls: -3, bytes: 10, skipped: 0 }) + "\n");
  assert.equal(createBudget({ rootId: "a", file: negative, policy: policy(), env: {}, now: DAY1 }).reserve("q", 5), null);
});

test("lock unavailability is propagated, never a silent no-op (Rev.2)", () => {
  const file = path.join(tempDir(), "state.json");
  const b = createBudget({ rootId: "a", file, policy: policy(), env: {}, now: DAY1 });
  const r = b.reserve("q", 5);
  assert.ok(r);
  fs.writeFileSync(`${file}.lock`, ""); // fresh lock: retries exhaust (~500 ms)
  assert.equal(b.release(r), "unavailable");
  assert.equal(b.noteSkipped("q"), false);
  fs.unlinkSync(`${file}.lock`);
  assert.equal(b.release(r), "refunded", "after the lock clears the refund lands");
});

test("orphan reservations expire with the day window (no auto-refund) — R2-4/Rev.2.1", () => {
  const file = path.join(tempDir(), "state.json");
  const day1 = createBudget({ rootId: "a", file, policy: policy({ dayCalls: 1 }), env: {}, now: DAY1 });
  const orphan = day1.reserve("q", 100);
  assert.ok(orphan);
  const day2 = createBudget({ rootId: "b", file, policy: policy({ dayCalls: 1 }), env: {}, now: DAY2 });
  assert.equal(day2.release(orphan), "noop", "no auto-refund for the orphan");
  assert.ok(day2.reserve("q", 100), "the new day starts with fresh quota");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.active.length, 1, "only the new reservation is active");
});

test("state revision increments monotonically across mutations — R2-6/Rev.2.1", () => {
  const file = path.join(tempDir(), "state.json");
  const b = createBudget({ rootId: "a", file, policy: policy(), env: {}, now: DAY1 });
  const revision = () => JSON.parse(fs.readFileSync(file, "utf8")).revision;
  const revs = [];
  const r = b.reserve("q", 5);
  assert.ok(r);
  revs.push(revision());
  b.noteSkipped("q");
  revs.push(revision());
  b.send(r);
  revs.push(revision());
  const r2 = b.reserve("q", 5);
  assert.ok(r2);
  revs.push(revision());
  b.release(r2);
  revs.push(revision());
  for (let i = 1; i < revs.length; i += 1) {
    assert.ok(revs[i] > revs[i - 1], `revision strictly increases (${revs.join(",")})`);
  }
});

test("revision mismatch after write is refused (conservative, R2-6/Rev.2.1)", () => {
  const file = path.join(tempDir(), "state.json");
  const b = createBudget({ rootId: "a", file, policy: policy(), env: {}, now: DAY1 });
  const rename = fs.renameSync.bind(fs);
  let tampered = false;
  const stubbed = mock.method(fs, "renameSync", (from, to) => {
    rename(from, to);
    if (!tampered && String(to).endsWith("state.json")) {
      tampered = true;
      const raw = JSON.parse(fs.readFileSync(String(to), "utf8"));
      raw.revision += 100; // simuliert einen fremden Writer (gestohlener Lock)
      fs.writeFileSync(String(to), JSON.stringify(raw) + "\n");
    }
  });
  try {
    assert.equal(b.reserve("q", 5), null, "revision mismatch => admission reported as refused");
  } finally {
    stubbed.mock.restore();
  }
  assert.ok(tampered, "tamper hook fired");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  // Konservative Semantik (dokumentiert): der bereits geschriebene Zaehler bleibt stehen
  // (Leak zugunsten der Grenze), es gibt keinen stillen Ueber-Admissions-Pfad.
  assert.ok(raw.revision >= 100, "tampered revision persisted");
  assert.equal(b.release({ id: "unknown", hook: "q", bytes: 5, day: "2026-09-29" }), "noop");
});

test("hook counters are authoritative across handles (persisted)", () => {
  const file = path.join(tempDir(), "state.json");
  const a = createBudget({ rootId: "a", file, policy: policy({ perHook: { q: 2 } }), env: {}, now: DAY1 });
  assert.ok(a.reserve("q", 5));
  const b = createBudget({ rootId: "b", file, policy: policy({ perHook: { q: 2 } }), env: {}, now: DAY1 });
  assert.ok(b.reserve("q", 5), "second handle sees the persisted reserved count");
  assert.equal(b.reserve("q", 5), null);
});
