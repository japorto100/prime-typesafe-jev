// Konkurrenz-Worker fuer tests/budget-concurrency.test.mjs (R2-7).
// Usage: node budget-concurrency.worker.mjs <state-file> <tries> <policyJson>
import { createBudget } from "../core/budget.ts";

const [, , file, triesRaw, policyRaw] = process.argv;
const tries = Number(triesRaw);
const policy = JSON.parse(policyRaw);
const b = createBudget({
  rootId: `p${process.pid}`,
  file,
  policy,
  env: {},
  now: () => new Date("2026-09-29T12:00:00Z"),
});
let ok = 0;
for (let i = 0; i < tries && ok < 10; i += 1) {
  if (b.reserve("q", 10)) ok += 1;
}
process.stdout.write(JSON.stringify({ ok }));
