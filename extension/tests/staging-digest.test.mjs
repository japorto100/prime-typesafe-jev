// Digest gates: (a) the imported review archive is immutable, (b) the staging
// tree matches manifests/STAGING-SHA256.json (regenerate deliberately with
// `UPDATE_STAGING_MANIFEST=1 node --test tests/staging-digest.test.mjs`).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(HERE, "..", "..", "..");
const ARCHIVE = path.join(HARNESS, "archive", "2026-09-23-jev-review");
const STAGING_MANIFEST = path.join(HARNESS, "manifests", "STAGING-SHA256.json");
const STAGING_ROOTS = ["extensions/typesafe-bridge", "skills/typesafe-jev"];
const EXCLUDE_DIRS = new Set(["node_modules", "__pycache__", ".pytest_cache"]);
const EXCLUDE_FILES = new Set([".DS_Store"]);

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), base, out);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name) || entry.name.endsWith(".pyc")) continue;
      out.push(path.relative(base, path.join(dir, entry.name)));
    }
  }
  return out;
}

test("review archive matches SOURCE-SHA256.json (historical, immutable)", (t) => {
  if (!fs.existsSync(path.join(ARCHIVE, "SOURCE-SHA256.json"))) {
    t.skip("standalone mode: review archive fixture not present");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ARCHIVE, "SOURCE-SHA256.json"), "utf8"));
  const mismatches = [];
  for (const [rel, want] of Object.entries(manifest.source_files)) {
    const file = path.join(ARCHIVE, rel);
    if (!fs.existsSync(file) || sha256(file) !== want) mismatches.push(rel);
  }
  assert.deepEqual(mismatches, [], `archive changed: ${mismatches.join(", ")}`);
});

test("review archive matches SHA256SUMS and contains no unlisted files", (t) => {
  if (!fs.existsSync(path.join(ARCHIVE, "SHA256SUMS"))) {
    t.skip("standalone mode: review archive fixture not present");
    return;
  }
  const sums = new Map();
  for (const line of fs.readFileSync(path.join(ARCHIVE, "SHA256SUMS"), "utf8").split("\n")) {
    const match = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line);
    if (match) sums.set(match[2], match[1]);
  }
  const allowed = new Set(["README.md", "SOURCE-SHA256.json", "SHA256SUMS"]);
  const problems = [];
  for (const rel of walk(ARCHIVE)) {
    const want = sums.get(rel);
    if (!want) {
      if (!allowed.has(rel)) problems.push(`unlisted: ${rel}`);
      continue;
    }
    if (sha256(path.join(ARCHIVE, rel)) !== want) problems.push(`hash: ${rel}`);
  }
  for (const rel of sums.keys()) {
    if (!fs.existsSync(path.join(ARCHIVE, rel))) problems.push(`missing: ${rel}`);
  }
  assert.deepEqual(problems, []);
});

test("staging matches manifests/STAGING-SHA256.json (update only via UPDATE_STAGING_MANIFEST=1)", (t) => {
  const update = process.env.UPDATE_STAGING_MANIFEST === "1";
  if (!update && !fs.existsSync(STAGING_MANIFEST)) {
    t.skip("standalone mode: staging manifest not present");
    return;
  }
  const current = {};
  for (const root of STAGING_ROOTS) {
    const abs = path.join(HARNESS, root);
    for (const rel of walk(abs)) current[`${root}/${rel}`] = sha256(path.join(abs, rel));
  }
  if (process.env.UPDATE_STAGING_MANIFEST === "1") {
    const manifest = {
      role: "staging build manifest — regenerate deliberately: UPDATE_STAGING_MANIFEST=1 node --test tests/staging-digest.test.mjs",
      generated_at: new Date().toISOString(),
      roots: STAGING_ROOTS,
      files: current,
    };
    fs.writeFileSync(STAGING_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(STAGING_MANIFEST, "utf8"));
  const known = manifest.files;
  const problems = [];
  for (const [rel, hash] of Object.entries(current)) {
    if (!(rel in known)) problems.push(`new: ${rel}`);
    else if (known[rel] !== hash) problems.push(`changed: ${rel}`);
  }
  for (const rel of Object.keys(known)) if (!(rel in current)) problems.push(`removed: ${rel}`);
  assert.deepEqual(problems, [], `staging drift (run UPDATE_STAGING_MANIFEST=1 deliberately): ${problems.join(", ")}`);
});
