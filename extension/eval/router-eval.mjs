// Label-Harness: runs curated router tasks headless (no promotion) and scores
// hit@1 against allowed skill sets ([] = "kein Skill nötig"; silent skips count as
// abstention). Measurement only — no thresholds, no live changes.
//
//   node eval/router-eval.mjs --tasks eval/router-tasks.json --out <dir> [--limit N]
//
// Env required for the child prime-agent runs: G1 grant via PRIME_JEV_G1 is set by
// this script; the TypeSafe key comes from the real agent dir (real HOME).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, "..");
// Alt → neu: nach WP2-JEV liegt die Datei in <agentDir>/receipts/jev.calls.jsonl.
// Laut scheitern statt still leer: ohne eine der Dateien gibt es kein Grün.
const RECEIPTS_CANDIDATES = [
  path.join(os.homedir(), ".prime", "agent", "receipts", "jev.calls.jsonl"),
  path.join(os.homedir(), ".prime", "agent", "harness", "jev-calls.jsonl"),
];
const RECEIPTS = RECEIPTS_CANDIDATES.find((p) => fs.existsSync(p));
if (!RECEIPTS) {
  throw new Error(`router-eval: keine JEV-Call-Datei gefunden:\n  ${RECEIPTS_CANDIDATES.join("\n  ")}`);
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const tasksFile = arg("--tasks", path.join(HERE, "router-tasks.json"));
const outDir = arg("--out", path.join(HERE, "out"));
const limit = Number(arg("--limit", "0")) || Infinity;
const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8")).slice(0, limit);

fs.mkdirSync(outDir, { recursive: true });
const evalFile = path.join(outDir, "eval.jsonl");
fs.rmSync(evalFile, { force: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "router-eval-"));

function receiptCount() {
  try {
    return fs.readFileSync(RECEIPTS, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
function lastReceipts(fromLine) {
  const lines = fs.readFileSync(RECEIPTS, "utf8").split("\n").filter(Boolean).slice(fromLine);
  return lines.map((line) => JSON.parse(line));
}
function evalRows() {
  try {
    return fs.readFileSync(evalFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const results = [];
for (const task of tasks) {
  const receiptsBefore = receiptCount();
  const rowsBefore = evalRows().length;
  const started = Date.now();
  const run = spawnSync("prime-agent", ["-ne", "-e", EXTENSION_DIR, "--mode", "json", task.prompt], {
    cwd: scratch,
    env: {
      ...process.env,
      PRIME_JEV_HOOK_ROUTER: "shadow",
      PRIME_JEV_G1: "router:prompt,router:skill-metadata",
      PRIME_JEV_EVAL: "1",
      PRIME_JEV_EVAL_FILE: evalFile,
    },
    timeout: 240000,
    maxBuffer: 64 * 1024 * 1024, // --mode json streams full message state; the 1 MiB default killed verbose runs
    encoding: "utf8",
  });
  const rows = evalRows();
  const newRows = rows.slice(rowsBefore);
  fs.writeFileSync(path.join(outDir, `${task.id}.out.log`), run.stdout ?? "");
  fs.writeFileSync(path.join(outDir, `${task.id}.err.log`), run.stderr ?? "");
  const answeredRow = newRows.find((row) => row.outcome === "answered") ?? null;
  const skipRow = newRows.find((row) => row.outcome === "skipped") ?? null;
  const newReceipts = lastReceipts(receiptsBefore).filter((row) => row.hook === "router");
  const receipt = newReceipts.at(-1) ?? null;
  const would = receipt?.would ?? null;
  const allowed = task.allowed ?? [];
  const skipReason = skipRow?.skip_reason ?? null;
  const called = Boolean(answeredRow);
  // F05 (Review 24.09.): process failures and missing events are NEVER counted as a
  // correct abstention — only answered `none` and deterministic no-signal skips are.
  let category;
  let hit;
  if (run.status !== 0) {
    category = "error";
    hit = false;
  } else if (called) {
    category = "answered";
    hit = would === "none" ? allowed.length === 0 : allowed.includes(would);
  } else if (skipReason) {
    category = `skipped:${skipReason}`;
    hit = allowed.length === 0 && (skipReason === "no_signal" || skipReason === "no_skills");
  } else {
    category = "no_event";
    hit = false;
  }
  const candidateList = Array.isArray(answeredRow?.candidates) ? answeredRow.candidates : null;
  const recall = allowed.length === 0 || !candidateList ? null : allowed.some((name) => candidateList.includes(name));
  results.push({
    id: task.id,
    exit: run.status,
    called,
    category,
    would,
    allowed,
    hit,
    recall,
    skip_reason: skipReason,
    latency_ms: receipt?.elapsed_ms ?? null,
    wall_ms: Date.now() - started,
    error: run.status === 0 ? null : ((run.stderr || "") + (run.stdout || "").slice(-400)).slice(0, 600),
  });
}

const hits = results.filter((r) => r.hit).length;
const available = results.filter((r) => r.category === "answered" || r.category.startsWith("skipped:")).length;
const recallTasks = results.filter((r) => r.recall !== null);
const recallHits = recallTasks.filter((r) => r.recall).length;
const report = {
  at: new Date().toISOString(),
  tasks: tasks.length,
  hit_at_1: `${hits}/${results.length}`,
  candidate_recall: recallTasks.length ? `${recallHits}/${recallTasks.length}` : "n/a",
  availability: `${available}/${results.length}`,
  errors: results.filter((r) => r.category === "error").length,
  no_event: results.filter((r) => r.category === "no_event").length,
  categories: results.reduce((counts, r) => { counts[r.category] = (counts[r.category] ?? 0) + 1; return counts; }, {}),
  results,
};
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
const markdown = [
  `# Router Label-Lauf (${report.at})`,
  "",
  `Tasks: ${tasks.length} · **hit@1: ${hits}/${results.length}** · Candidate-Recall: ${report.candidate_recall} · Availability: ${report.availability} · Fehler: ${report.errors} · no_event: ${report.no_event}`,
  "",
  "| Task | category | would | allowed | hit | recall | lat (ms) |",
  "|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.id} | ${r.category} | ${r.would ?? "—"} | ${r.allowed.join(", ") || "(kein Skill)"} | ${r.hit ? "✅" : "❌"} | ${r.recall === null ? "—" : r.recall ? "✅" : "❌"} | ${r.latency_ms ?? "—"} |`),
  "",
  "`hit` zählt nur: korrekte Skill-Wahl, beantwortete `none`-Abstention oder deterministische `no_signal`/`no_skills`-Skips bei leerer erlaubter Menge. `recall` = mindestens ein erlaubter Skill war in der Shortlist. `error`/`no_event` sind nie Treffer.",
  "",
].join("\n");
fs.writeFileSync(path.join(outDir, "report.md"), markdown);
console.log(markdown);
fs.rmSync(scratch, { recursive: true, force: true });
