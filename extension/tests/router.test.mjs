// Phase 3: A2 router — deterministic lexical shortlist (signal-only), prefilter/dedupe,
// shadow receipts, advisory injection only with measured threshold (G4), marker idempotence, G1 gate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { questionsVersionFor } from "../core/question-registry.ts";
import { buildRouterQuestions, createRouterHandler, decisionSituationKey, deterministicModelShortlist, deterministicSkillShortlist, HINT_MARKER, parseThreshold } from "../hooks/router.ts";
import { fakePi, installFetchStub, makeTempHome } from "./helpers/harness.mjs";

const SHADOW_ENV = { PRIME_JEV_HOOK_ROUTER: "shadow", PRIME_JEV_G1: "router:prompt,router:skill-metadata" };
const event = (prompt, extra = {}) => ({
  prompt,
  systemPrompt: "base prompt",
  systemPromptOptions: { skills: [{ name: "beta", description: "beta helper" }, { name: "alpha", description: "alpha helper" }] },
  ...extra,
});
const ctx = { modelRegistry: { getAvailable: () => [{ provider: "p", id: "m1" }, { provider: "p", id: "m2" }] } };

function makeDecide(result) {
  const calls = [];
  return {
    calls,
    decide: async (request, origin, hook, meta) => {
      calls.push({ request, origin, hook, meta });
      return result;
    },
  };
}

const batch = (choice, probability, needs = 0.9) => ({
  answers: {
    needs_specialist_skill: { type: "noul", noul: needs },
    best_skill: { type: "choice", choice, confidence: 0.9, probabilities: { alpha: probability, beta: 0.5, none: 0.0 } },
  },
});

// --- unit: shortlists and questions -------------------------------------------

test("shortlist keeps only skills with lexical signal (real names, no noise fill)", () => {
  const shortlist = deterministicSkillShortlist(event("x").systemPromptOptions.skills, "please use alpha");
  assert.deepEqual(shortlist.candidates.map((s) => s.name), ["alpha"]);
  assert.equal(shortlist.discovered, 2);
  assert.equal(shortlist.scored, 1);
  assert.equal(shortlist.truncated, false);
  // No signal at all → empty shortlist (the router stays silent).
  assert.deepEqual(deterministicSkillShortlist(event("x").systemPromptOptions.skills, "x").candidates, []);
  assert.deepEqual(deterministicSkillShortlist([{ name: "hidden", disableModelInvocation: true }], "hidden thing").candidates, []);
  assert.deepEqual(deterministicModelShortlist([{ provider: "p", id: "m2" }, { provider: "p", id: "m1" }, {}]), ["p/m1", "p/m2"]);
  const questions = buildRouterQuestions([{ name: "alpha", description: "alpha helper" }], ["p/m1"], true);
  assert.deepEqual(Object.keys(questions.best_skill.criteria).sort(), ["alpha", "none"]);
  assert.deepEqual(Object.keys(questions.best_model.criteria), ["p/m1"]);
  assert.equal(questions.needs_specialist_skill.type, "noul");
  // J11: the model question is opt-in (separate experiment), not part of skill routing by default.
  assert.equal("best_model" in buildRouterQuestions([{ name: "alpha", description: "alpha helper" }], ["p/m1"]), false);
});

test("shortlist ranks prompt-relevant skills first and reports truncation", () => {
  const skills = [
    { name: "alpha", description: "database helper" },
    { name: "beta", description: "database migration support" },
    { name: "gamma", description: "database rollback support" },
  ];
  const ranked = deterministicSkillShortlist(skills, "database migration rollback", 2);
  assert.deepEqual(ranked.candidates.map((s) => s.name).sort(), ["beta", "gamma"]);
  assert.equal(ranked.discovered, 3);
  assert.equal(ranked.scored, 3);
  assert.equal(ranked.truncated, true);
  const nameBoost = deterministicSkillShortlist(skills, "please use beta now", 3);
  assert.equal(nameBoost.candidates[0].name, "beta");
  assert.equal(nameBoost.scored, 1);
  assert.equal(nameBoost.truncated, false);
});

test("retrieval: stopwords, IDF weighting and DE→EN morphology", () => {
  // Pure filler must not create candidates.
  assert.deepEqual(deterministicSkillShortlist(event("x").systemPromptOptions.skills, "which available skill fits best, please answer briefly").candidates, []);
  // English/German function words are neutralized (the 126/129-noise class).
  const noisePrompt = "The test is for the skill and the answer with the best approach for a task";
  const noise = deterministicSkillShortlist([
    { name: "noise-a", description: "the and for with about this that" },
    { name: "signal", description: "hypothesis driven root cause analysis" },
  ], noisePrompt);
  assert.deepEqual(noise.candidates.map((skill) => skill.name), [], "function words create no signal");
  const signal = deterministicSkillShortlist([
    { name: "noise-a", description: "the and for with about this that" },
    { name: "signal", description: "hypothesis driven root cause analysis" },
  ], "find the root cause with a hypothesis");
  assert.deepEqual(signal.candidates.map((skill) => skill.name), ["signal"]);
  // IDF: a rare token outranks a token that appears in every skill.
  const idfSkills = [
    { name: "common-a", description: "widget support" },
    { name: "common-b", description: "widget support" },
    { name: "rare", description: "gadget support" },
  ];
  const idf = deterministicSkillShortlist(idfSkills, "widget gadget", 3);
  assert.equal(idf.candidates[0].name, "rare", "rare token wins over ubiquitous token");
  // Morphology: German prompt tokens reach English skill metadata (observed miss: Rollen↔roles).
  const morphology = deterministicSkillShortlist(event("x").systemPromptOptions.skills, "Wir müssen Rollen koordinieren");
  assert.deepEqual(morphology.candidates.map((s) => s.name), []);
  const roleSkills = [{ name: "roles", description: "coordinate subagents" }, { name: "other", description: "nothing here" }];
  const roleShortlist = deterministicSkillShortlist(roleSkills, "Wir müssen Rollen koordinieren");
  assert.deepEqual(roleShortlist.candidates.map((s) => s.name), ["roles"]);
  // Hyphenated compounds must split (observed miss: Subagenten-Rollen as one token).
  const hyphenated = deterministicSkillShortlist(roleSkills, "Subagenten-Rollen koordinieren");
  assert.deepEqual(hyphenated.candidates.map((s) => s.name), ["roles"]);
});

test("decision situation key binds prompt + candidates + contract version", () => {
  const a = decisionSituationKey("p", ["x"], "v1");
  assert.equal(a, decisionSituationKey("p", ["x"], "v1"));
  assert.notEqual(a, decisionSituationKey("p", ["y"], "v1"));
  assert.notEqual(a, decisionSituationKey("q", ["x"], "v1"));
  assert.notEqual(a, decisionSituationKey("p", ["x"], "v2"));
});

// --- unit: gates, prefilter, shadow --------------------------------------------

test("off mode and missing G1 stay silent", async () => {
  const off = makeDecide(batch("alpha", 0.9));
  await createRouterHandler({ decide: off.decide, env: {} })(event("please use alpha now"), ctx);
  assert.equal(off.calls.length, 0);

  const noGrant = makeDecide(batch("alpha", 0.9));
  await createRouterHandler({ decide: noGrant.decide, env: { PRIME_JEV_HOOK_ROUTER: "shadow" } })(event("please use alpha now"), ctx);
  assert.equal(noGrant.calls.length, 0, "G1 precedes shadow");
});

test("shadow calls once per decision situation and never touches the prompt", async () => {
  const fake = makeDecide(batch("alpha", 0.9));
  const handler = createRouterHandler({ decide: fake.decide, env: SHADOW_ENV });
  const first = await handler(event("Implement alpha feature X"), ctx);
  assert.equal(first, undefined, "shadow writes no prompt changes");
  const second = await handler(event("Implement alpha feature X"), ctx);
  assert.equal(second, undefined);
  assert.equal(fake.calls.length, 1, "identical decision situation is deduped");
  assert.equal(fake.calls[0].hook, "router");
  assert.equal(fake.calls[0].origin, "automatic_hook");
  assert.deepEqual(fake.calls[0].meta.candidates, ["alpha"]);
  assert.equal(fake.calls[0].meta.candidatesTotal, 2);
  assert.equal(fake.calls[0].meta.candidatesScored, 1);
  assert.deepEqual(Object.keys(fake.calls[0].request.params.questions).sort(), ["best_skill", "needs_specialist_skill", "requires_independent_review", "underspecified"].sort());
});

test("prefilter: no skills, no lexical signal, slash commands and oversized prompts stay silent", async () => {
  const fake = makeDecide(batch("alpha", 0.9));
  const handler = createRouterHandler({ decide: fake.decide, env: SHADOW_ENV });
  await handler(event("please use alpha", { systemPromptOptions: { skills: [] } }), ctx);
  await handler(event("totally unrelated words"), ctx);
  await handler(event("/status"), ctx);
  await handler(event("x".repeat(5000)), ctx);
  assert.equal(fake.calls.length, 0);
});

// --- unit: advisory injection (G4) ---------------------------------------------

test("advisory without a measured threshold stays shadow-equivalent", async () => {
  const fake = makeDecide(batch("alpha", 0.9));
  const handler = createRouterHandler({ decide: fake.decide, env: { ...SHADOW_ENV, PRIME_JEV_HOOK_ROUTER: "advisory" } });
  assert.equal(await handler(event("Implement alpha feature Y"), ctx), undefined);
  assert.equal(fake.calls.length, 1);
});

test("advisory injects a marked hint only above the explicit threshold", async () => {
  const fake = makeDecide(batch("alpha", 0.8));
  const env = { ...SHADOW_ENV, PRIME_JEV_HOOK_ROUTER: "advisory", PRIME_JEV_ROUTER_MIN_P: "0.5" };
  const handler = createRouterHandler({ decide: fake.decide, env });
  const result = await handler(event("Implement alpha feature Z"), ctx);
  assert.ok(result?.systemPrompt.includes(HINT_MARKER));
  assert.ok(result.systemPrompt.includes("`alpha`"));
  assert.ok(result.systemPrompt.includes("base prompt"));

  // Below threshold → no hint (new situation to bypass dedupe).
  const low = makeDecide(batch("alpha", 0.2));
  const lowResult = await createRouterHandler({ decide: low.decide, env })(event("Another alpha task"), ctx);
  assert.equal(lowResult, undefined);

  // Marker idempotence: an already-hinted prompt is never hinted twice.
  const again = makeDecide(batch("alpha", 0.9));
  const againResult = await createRouterHandler({ decide: again.decide, env })(event("Third alpha task", { systemPrompt: `base ${HINT_MARKER}` }), ctx);
  assert.equal(againResult, undefined);
});

test("J11: empty/invalid thresholds mean 'unset'; needs threshold can differ", async () => {
  assert.equal(parseThreshold(undefined), null);
  assert.equal(parseThreshold(""), null);
  assert.equal(parseThreshold("  "), null);
  assert.equal(parseThreshold("0"), null);
  assert.equal(parseThreshold("1.5"), null);
  assert.equal(parseThreshold("nope"), null);
  assert.equal(parseThreshold("0.5"), 0.5);

  const env = { ...SHADOW_ENV, PRIME_JEV_HOOK_ROUTER: "advisory", PRIME_JEV_ROUTER_MIN_P: "", PRIME_JEV_ROUTER_MIN_NEEDS: "" };
  const empty = makeDecide(batch("alpha", 0.9));
  assert.equal(await createRouterHandler({ decide: empty.decide, env })(event("Empty alpha threshold task"), ctx), undefined);

  // Separate needs threshold: skill high but needs below the needs bar ⇒ no hint.
  const splitEnv = { ...SHADOW_ENV, PRIME_JEV_HOOK_ROUTER: "advisory", PRIME_JEV_ROUTER_MIN_P: "0.5", PRIME_JEV_ROUTER_MIN_NEEDS: "0.95" };
  const lowNeeds = makeDecide(batch("alpha", 0.9, 0.9));
  assert.equal(await createRouterHandler({ decide: lowNeeds.decide, env: splitEnv })(event("Low needs alpha task"), ctx), undefined);
  const highNeeds = makeDecide(batch("alpha", 0.9, 0.96));
  const hinted = await createRouterHandler({ decide: highNeeds.decide, env: splitEnv })(event("High needs alpha task"), ctx);
  assert.ok(hinted?.systemPrompt.includes(HINT_MARKER));
});

// --- integration: receipt + eval through the single dispatch path --------------

const home = makeTempHome();
const evalFile = path.join(home, "router-eval.jsonl");
process.env.TYPESAFE_API_KEY = "offline-test-only";
process.env.PRIME_JEV_HOOK_ROUTER = "shadow";
process.env.PRIME_JEV_G1 = "router:prompt,router:skill-metadata";
process.env.PRIME_JEV_EVAL = "1";
process.env.PRIME_JEV_EVAL_FILE = evalFile;
const fetchStub = installFetchStub();
const { default: loadBridge } = await import("../index.ts");
const { pi, hooks } = fakePi();
loadBridge(pi);
const bridge = globalThis[Symbol.for("prime.typesafe.host-bridge.v1")];
await bridge.ready;

test("shadow router: content-free v2 receipt with would_* + typed eval row", async () => {
  fetchStub.raw(JSON.stringify({
    model: "jev-1.13.0",
    usage: { input_tokens: 10, output_tokens: 3 },
    answers: {
      needs_specialist_skill: { type: "noul", noul: 0.8 },
      requires_independent_review: { type: "noul", noul: 0.3 },
      underspecified: { type: "noul", noul: 0.1 },
      best_skill: { type: "choice", choice: "alpha", confidence: 0.9, probabilities: { alpha: 0.9, none: 0.1 } },
      best_model: { type: "choice", choice: "p/m1", confidence: 0.9, probabilities: { "p/m1": 1 } },
    },
  }));
  const result = await hooks.get("before_agent_start")({
    prompt: "Implement the alpha router shadow",
    systemPrompt: "base prompt",
    systemPromptOptions: { skills: [{ name: "beta", description: "beta helper" }, { name: "alpha", description: "alpha helper" }] },
  }, { modelRegistry: { getAvailable: () => [{ provider: "p", id: "m1" }] } });
  assert.equal(result, undefined, "shadow never modifies the prompt");

  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8").trim().split("\n").at(-1));
  assert.equal(receipt.schema, "prime-jev/call/2");
  assert.equal(receipt.hook, "router");
  assert.equal(receipt.mode, "shadow");
  assert.equal(receipt.origin, "automatic_hook");
  assert.equal(receipt.outcome, "answered");
  assert.equal(receipt.would, "alpha");
  assert.equal(receipt.provider, "jev");
  assert.equal(receipt.questions_version, questionsVersionFor("router"));
  assert.ok(receipt.bytes_in > 0);
  const rawReceipt = JSON.stringify(receipt);
  assert.equal(rawReceipt.includes("Implement the alpha router shadow"), false);
  assert.equal(rawReceipt.includes("description"), false, "no skill descriptions in receipts");

  const rows = fs.readFileSync(evalFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const row = rows.at(-1);
  assert.equal(row.hook, "router");
  assert.equal(row.origin, "automatic_hook");
  assert.deepEqual(row.candidates, ["alpha"]);
  assert.equal(row.candidates_total, 2);
  assert.equal(row.candidates_scored, 1);
  assert.equal(row.candidates_truncated, false);
  assert.equal(row.predictions.best_skill.selected, "alpha");
  assert.deepEqual(Object.keys(row.predictions).sort(), ["best_model", "best_skill", "needs_specialist_skill", "requires_independent_review", "underspecified"].sort());
  assert.equal(fs.readFileSync(evalFile, "utf8").includes("Implement the alpha router shadow"), false);
  // J11: the sent questions must NOT include the model question by default.
  const sent = fetchStub.state.payloads.at(-1).body;
  assert.deepEqual(Object.keys(sent.questions).sort(), ["best_skill", "needs_specialist_skill", "requires_independent_review", "underspecified"].sort());
  assert.equal(sent.state.prompt, "Implement the alpha router shadow", "full prompt is sent, not a tail-only excerpt");
});

test("silent skips are recorded with a reason (denominator evidence)", async () => {  const rowsBefore = fs.readFileSync(evalFile, "utf8").trim().split("\n").length;
  const result = await hooks.get("before_agent_start")({
    prompt: "völlig unverbundene worte",
    systemPrompt: "base prompt",
    systemPromptOptions: { skills: [{ name: "alpha", description: "alpha helper" }] },
  }, { modelRegistry: { getAvailable: () => [] } });
  assert.equal(result, undefined);
  const rows = fs.readFileSync(evalFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, rowsBefore + 1);
  const row = rows.at(-1);
  assert.equal(row.outcome, "skipped");
  assert.equal(row.skip_reason, "no_signal");
  assert.equal(row.hook, "router");
  assert.equal(row.provider, "none");
});

test("J8/J10: decision_id joins receipt and eval; per-hook version + session are set", async () => {
  fetchStub.raw(JSON.stringify({
    model: "jev-1.13.0",
    usage: { input_tokens: 10 },
    answers: {
      needs_specialist_skill: { type: "noul", noul: 0.8 },
      requires_independent_review: { type: "noul", noul: 0.3 },
      underspecified: { type: "noul", noul: 0.1 },
      best_skill: { type: "choice", choice: "alpha", confidence: 0.9, probabilities: { alpha: 0.9, none: 0.1 } },
    },
  }));
  const rowsBefore = fs.readFileSync(evalFile, "utf8").trim().split("\n").filter(Boolean).length;
  await hooks.get("before_agent_start")({
    prompt: "Implement alpha feature J8",
    systemPrompt: "base prompt",
    systemPromptOptions: { skills: [{ name: "alpha", description: "alpha helper" }] },
  }, { modelRegistry: { getAvailable: () => [] } });
  const deadline = Date.now() + 3000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = fs.readFileSync(evalFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (rows.length > rowsBefore) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const row = rows.at(-1);
  assert.equal(row.outcome, "answered");
  assert.equal(row.questions_version, questionsVersionFor("router"));
  assert.ok(row.session && row.session.length > 10, "session proxy is set");
  const receiptPath = path.join(home, ".prime", "agent", "receipts", "jev.calls.jsonl");
  const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const receipt = receipts.at(-1);
  assert.equal(receipt.decision_id, row.decision_id, "decision_id joins receipt and eval");
  assert.equal(receipt.session, row.session);
  assert.equal(receipt.questions_version, questionsVersionFor("router"));
});

after(() => {
  bridge.retire();
  fetchStub.restore();
  delete process.env.PRIME_JEV_HOOK_ROUTER;
  delete process.env.PRIME_JEV_G1;
  delete process.env.PRIME_JEV_EVAL;
  delete process.env.PRIME_JEV_EVAL_FILE;
  fs.rmSync(home, { recursive: true, force: true });
});
