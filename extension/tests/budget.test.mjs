// Paket B (J7): hard budget contract — atomic reservation, shared day state, byte ceiling
// with incoming size, day rotation, dynamic kill switch, separate skipped accounting.
// Policy B (30.09.): reserve returns a reservation handle; refunds are reservation-bound.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { createBudget } from "../core/budget.ts";

const tempDirs = [];
function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-budget-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const basePolicy = (over = {}) => ({ rootCalls: 100, perHook: {}, rootBytes: 10000, dayCalls: 10, dayBytes: 10000, ...over });

test("reservation is atomic: day cap 1 admits exactly one call before it ends", () => {
  const file = tempFile("budget.json");
  const budget = createBudget({ rootId: "r", file, policy: basePolicy({ dayCalls: 1 }), env: {}, now: () => new Date("2026-09-24T10:00:00Z") });
  assert.ok(budget.reserve("explicit_python", 10));
  assert.equal(budget.reserve("explicit_python", 10), null, "second admission denied while the first is in flight");
  budget.noteSkipped("explicit_python");
  const summary = budget.summary();
  assert.equal(summary.dayCalls, 1);
  assert.equal(summary.skippedCalls, 1, "skipped attempts are separate from sent quota");
});

test("two handles share the persistent day state; byte ceiling uses the incoming size", () => {
  const file = tempFile("budget.json");
  const now = () => new Date("2026-09-24T10:00:00Z");
  const policy = basePolicy({ dayBytes: 100 });
  const first = createBudget({ rootId: "a", file, policy, env: {}, now });
  const second = createBudget({ rootId: "b", file, policy, env: {}, now });
  assert.ok(first.reserve("x", 90));
  assert.equal(second.reserve("x", 20), null, "the other handle's reservation is visible");
  assert.ok(first.reserve("x", 10));
  assert.equal(second.reserve("x", 1), null, "byte ceiling enforced on the whole request size");
  assert.equal(second.summary().dayBytes, 100);
});

test("day window rotates on access", () => {
  const file = tempFile("budget.json");
  let clock = new Date("2026-09-24T23:59:00Z");
  const budget = createBudget({ rootId: "r", file, policy: basePolicy({ dayCalls: 1 }), env: {}, now: () => clock });
  assert.ok(budget.reserve("x", 5));
  assert.equal(budget.reserve("x", 5), null);
  clock = new Date("2026-09-25T00:01:00Z");
  assert.ok(budget.reserve("x", 5), "a new day resets the window");
  assert.equal(budget.summary().dayCalls, 1);
});

test("kill switch is checked dynamically; release refunds a reservation", () => {
  const file = tempFile("budget.json");
  const env = {};
  const budget = createBudget({ rootId: "r", file, policy: basePolicy(), env, now: () => new Date("2026-09-24T10:00:00Z") });
  const reservation = budget.reserve("x", 5);
  assert.ok(reservation);
  assert.equal(budget.release(reservation), "refunded");
  assert.equal(budget.summary().dayCalls, 0, "released reservation no longer counts");
  env.PRIME_JEV_BUDGET_KILL = "1";
  assert.equal(budget.reserve("x", 5), null, "kill switch observed at call time, not construction");
});

test("root caps are per-process by contract; day caps persist across handles", () => {
  const file = tempFile("budget.json");
  const policy = basePolicy({ rootCalls: 1 });
  const first = createBudget({ rootId: "same", file, policy, env: {}, now: () => new Date("2026-09-24T10:00:00Z") });
  assert.ok(first.reserve("x", 5));
  assert.equal(first.reserve("x", 5), null, "root cap inside the process");
  const second = createBudget({ rootId: "same", file, policy, env: {}, now: () => new Date("2026-09-24T10:00:00Z") });
  assert.ok(second.reserve("x", 5), "a new handle is a new process root (documented contract)");
  assert.equal(second.summary().dayCalls, 2, "day counter survived the handle swap");
});

test("per-hook caps deny with separate skipped accounting", () => {
  const file = tempFile("budget.json");
  const budget = createBudget({ rootId: "r", file, policy: basePolicy({ perHook: { router: 1 } }), env: {}, now: () => new Date("2026-09-24T10:00:00Z") });
  assert.ok(budget.reserve("router", 5));
  assert.equal(budget.reserve("router", 5), null);
  budget.noteSkipped("router");
  assert.equal(budget.summary().hookCalls.router, 1);
  assert.equal(budget.summary().skippedCalls, 1);
});
