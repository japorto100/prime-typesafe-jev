// Paket B (J10): golden snapshot — the actual question contracts and retrieval behavior are
// pinned. Any drift fails loudly; update deliberately with UPDATE_QUESTION_GOLDEN=1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compactionBlocks, buildCompactionQuestions } from "../hooks/compaction.ts";
import { buildRefineQuestions } from "../hooks/refine-advisor.ts";
import { buildTriageQuestions } from "../hooks/result-triage.ts";
import { buildRouterQuestions, deterministicSkillShortlist } from "../hooks/router.ts";
import { buildGateQuestions } from "../hooks/tool-gate.ts";
import { buildWatchdogQuestions } from "../hooks/watchdog.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "question-golden.json");
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function currentGolden() {
  const sampleSkills = Array.from({ length: 30 }, (_, index) => ({
    name: `skill-${String(index).padStart(2, "0")}`,
    description: index % 3 === 0 ? "database migration rollback support" : `general helper ${index}`,
  }));
  const shortlist = deterministicSkillShortlist(sampleSkills, "database migration rollback", 24);
  const block = [{ id: "b1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(80) }] } }];
  return {
    router: sha(buildRouterQuestions([{ name: "alpha", description: "alpha helper" }], ["p/m1"])),
    gate: sha(buildGateQuestions()),
    watchdog: sha(buildWatchdogQuestions()),
    triage: sha(buildTriageQuestions()),
    compaction: sha(buildCompactionQuestions(compactionBlocks(block).blocks)),
    refine: sha(buildRefineQuestions()),
    retrieval: sha({
      candidates: shortlist.candidates.map((skill) => skill.name),
      discovered: shortlist.discovered,
      scored: shortlist.scored,
      truncated: shortlist.truncated,
    }),
  };
}

test("J10: question contracts and retrieval behavior are pinned (golden snapshot)", () => {
  const current = currentGolden();
  if (process.env.UPDATE_QUESTION_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(current, null, 2) + "\n");
    return;
  }
  assert.ok(fs.existsSync(FIXTURE), "missing tests/fixtures/question-golden.json — create it once with UPDATE_QUESTION_GOLDEN=1");
  const golden = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const key of Object.keys(golden)) {
    assert.equal(current[key], golden[key], `${key} changed — question contract/retrieval drift; update deliberately (UPDATE_QUESTION_GOLDEN=1)`);
  }
});
