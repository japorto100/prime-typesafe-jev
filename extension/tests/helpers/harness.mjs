import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Throwaway HOME so auth/receipt paths never touch the real agent dir. */
export function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-home-"));
  process.env.HOME = home;
  return home;
}

/** Minimal Prime host stub: records hooks and commands. */
export function fakePi() {
  const hooks = new Map();
  const commands = new Map();
  const pi = {
    on(name, fn) {
      hooks.set(name, fn);
    },
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
  };
  return { pi, hooks, commands };
}

/** Offline fetch replacement with a one-deep response queue. */
export function installFetchStub() {
  const previous = globalThis.fetch;
  const state = { calls: 0, payloads: [], next: null };
  globalThis.fetch = async (_url, opts) => {
    state.calls += 1;
    state.payloads.push({ body: JSON.parse(opts.body), headers: opts.headers });
    if (!state.next) throw new Error("fetch stub: no response queued");
    return state.next();
  };
  return {
    state,
    /** Queue an upstream response carrying one answer under the question id `q`. */
    stub(answer, extra = { model: "jev-1.13.0", usage: { input_tokens: 12, output_tokens: 2 } }) {
      state.next = () => new Response(JSON.stringify({ ...extra, answers: { q: answer } }));
    },
    /** Queue a legacy decision response (`answers.decision`). */
    decision(answer, extra = { model: "jev-1.13.0", usage: { input_tokens: 12, output_tokens: 2 } }) {
      state.next = () => new Response(JSON.stringify({ ...extra, answers: { decision: answer } }));
    },
    /** Queue a raw upstream response (status/body controlled by the caller). */
    raw(body, init) {
      state.next = () => new Response(body, init);
    },
    reset() {
      state.calls = 0;
      state.payloads.length = 0;
      state.next = null;
    },
    restore() {
      globalThis.fetch = previous;
    },
  };
}
