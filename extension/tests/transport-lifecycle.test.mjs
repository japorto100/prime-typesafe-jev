// J12 + Variant A: endpoint stability across reloads, retire semantics, conservative sweep.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireHostBridge, sweepStaleBridges } from "../transport.ts";

const HOST_BRIDGE = Symbol.for("prime.typesafe.host-bridge.v1");

function callSocket(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "";
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("socket timeout"));
    });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    });
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
  });
}

test("Variant A: re-acquire keeps the endpoint and swaps dispatch (reload simulation)", async () => {
  const first = acquireHostBridge(async () => ({ answer: "one" }));
  await first.ready;
  const endpoint = first.socketPath;
  assert.equal(process.env.PRIME_JEV_SOCKET, endpoint);
  const second = acquireHostBridge(async () => ({ answer: "two" }));
  assert.equal(second, first);
  assert.equal(second.socketPath, endpoint);
  // A client that captured the endpoint before the reload keeps working.
  const reply = await callSocket(endpoint, { method: "noul", params: {} });
  assert.deepEqual(reply, { result: { answer: "two" } });
  const endpointDir = path.dirname(endpoint);
  second.retire();
  assert.equal(fs.existsSync(endpointDir), false, "close removes the private socket dir");
});

test("retire clears registry+env; re-acquire gets a fresh endpoint", async () => {
  const third = acquireHostBridge(async () => ({ answer: "three" }));
  await third.ready;
  const endpoint = third.socketPath;
  third.retire();
  assert.equal(globalThis[HOST_BRIDGE], undefined);
  assert.notEqual(process.env.PRIME_JEV_SOCKET, endpoint);
  assert.equal(fs.existsSync(path.dirname(endpoint)), false, "retire cleans its dir");
  const fourth = acquireHostBridge(async () => ({ answer: "four" }));
  await fourth.ready;
  assert.notEqual(fourth.socketPath, endpoint);
  fourth.retire();
});

test("sweepStaleBridges removes only provably stale owners", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-sweep-"));
  const dead = spawnSync("true").pid;
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stale = path.join(root, "prime-jev-stale");
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, "owner.json"), JSON.stringify({ pid: dead }));
  fs.utimesSync(stale, old, old);
  const live = path.join(root, "prime-jev-live");
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, "owner.json"), JSON.stringify({ pid: process.pid }));
  const unknown = path.join(root, "prime-jev-unknown");
  fs.mkdirSync(unknown);
  const recent = path.join(root, "prime-jev-recent");
  fs.mkdirSync(recent);
  fs.writeFileSync(path.join(recent, "owner.json"), JSON.stringify({ pid: dead }));

  const removed = sweepStaleBridges(root, Date.now());
  assert.deepEqual(removed, [stale]);
  assert.equal(fs.existsSync(stale), false);
  for (const kept of [live, unknown, recent]) assert.equal(fs.existsSync(kept), true, kept);
  fs.rmSync(root, { recursive: true, force: true });
});
