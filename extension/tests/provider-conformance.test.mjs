// Phase 2: provider seam conformance — capability gate, unknown provider, real provider metrics.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { activeProvider, assertProviderSupports, jevProvider, JEV_DEADLINE_MS } from "../core/provider.ts";
import { installFetchStub } from "./helpers/harness.mjs";

const fetchStub = installFetchStub();

const fakeProvider = {
  id: "fake",
  capabilities: { methods: ["choice"], batching: false, probabilities: false, legend: false, usage: false, modelId: false, maxQuestions: 1, maxBytes: 1024, timeoutClass: "fast", egress: "local", cost: "none" },
  decide: async () => {
    throw new Error("a provider without the capability must never be asked");
  },
};

test("capability gate: unsupported method is refused before any call", () => {
  assert.throws(() => assertProviderSupports(fakeProvider, "noul"), /JevProviderUnsupported/);
  assert.throws(() => assertProviderSupports(fakeProvider, "system_one"), /JevProviderUnsupported/);
  assert.doesNotThrow(() => assertProviderSupports(fakeProvider, "choice"));
  assert.doesNotThrow(() => assertProviderSupports(jevProvider, "system_one"));
});

test("unknown provider id is refused", () => {
  assert.throws(() => activeProvider({ PRIME_JEV_PROVIDER: "nope" }), /JevProviderUnknown/);
  assert.equal(activeProvider({}).id, "jev");
});

test("prepare/send split: prepare is pure, send performs the request", async () => {
  const prepared = jevProvider.prepare({ state: "offline", questions: { q: { type: "noul", instructions: "X" } }, env: {} });
  assert.ok(prepared.bytesIn > 0);
  assert.equal(prepared.redactions, 0);
  const before = fetchStub.state.calls;
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: {}, answers: {} }));
  const sent = await jevProvider.send(prepared, "offline-test-only");
  assert.equal(fetchStub.state.calls, before + 1);
  assert.equal(sent.model, "jev-1.13.0");
  assert.ok(sent.bytesOut > 0);
});

test("real provider returns metrics and passes model through", async () => {
  fetchStub.raw(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 3 }, answers: {} }));
  const result = await jevProvider.decide({
    state: "offline",
    questions: { q: { type: "noul", instructions: "X" } },
    apiKey: "offline-test-only",
    env: {},
  });
  assert.equal(result.model, "jev-1.13.0");
  assert.ok(result.bytesIn > 0);
  assert.ok(result.bytesOut > 0);
  assert.equal(result.redactions, 0);
});

test("provider egress block refuses before fetch", async () => {
  const before = fetchStub.state.calls;
  await assert.rejects(
    () => jevProvider.decide({ state: "token=abcdef1234567890abcdef", questions: {}, apiKey: "k", env: { PRIME_JEV_EGRESS: "block" } }),
    /JevEgressBlocked/,
  );
  assert.equal(fetchStub.state.calls, before);
});

test("one deadline constant for the fast class", () => {
  assert.equal(JEV_DEADLINE_MS, 1200);
  assert.equal(jevProvider.capabilities.timeoutClass, "fast");
});

after(() => fetchStub.restore());
