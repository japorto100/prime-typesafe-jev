// J01/F5 floor corpus: 10 destructive + 10 legitimate snippets (expected block/warn/allow),
// plus explicitly documented evasions. The floor is a tripwire, NOT a security boundary.
import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBashFloor, evaluateIpythonFloor } from "../core/floor.ts";

const DESTRUCTIVE_IPYTHON = [
  ["subprocess.run(['dd','of=/dev/sda'])", "block"],
  ["subprocess.run('rm -rf /', shell=True)", "block"],
  ["os.system('mkfs.ext4 /dev/sdb1')", "block"],
  ["shutil.rmtree('/')", "block"],
  ["shutil.rmtree('~')", "block"],
  ["import os; os.system('git push --force origin main')", "block"],
  ["os.system('kill -9 1')", "block"],
  ["dd if=/dev/sda of=dump.bin", "block"],
  ["shutil.rmtree('build/')", "warn"],
  ["os.remove('/tmp/foo')", "warn"],
  ["os.chmod('/etc/passwd', 0o777)", "warn"],
];

const LEGIT_IPYTHON = [
  "import subprocess; subprocess.run(['dd', '--help'])",
  "print('rm -rf is dangerous')",
  "shutil.disk_usage('/')",
  "subprocess.run(['git', 'status'])",
  "import pandas as pd; df = pd.read_csv('data.csv')",
  "open('notes.txt').read()",
  "import os; os.path.join('/tmp', 'x')",
  "subprocess.run(['pytest', '-q'])",
  "for f in pathlib.Path('.').glob('*.py'): print(f)",
  "subprocess.check_output(['git', 'log', '-1'])",
];

// Undetected by design: string construction evades any regex floor.
const EVASIONS = [
  "getattr(__import__('shutil'), 'rmtree')('/')",
  "''.join(['d', 'd']) + ' of=/dev/sda'",
];

// Verify-Fix 24.09.: a mention is not an action — hard block only for imperative contexts.
const DD_MENTIONS = [
  ["print('dd of=/dev/sda is dangerous')", "warn"],
  ["x = 'dd of=/dev/sda'", "warn"],
  ["# dd of=/dev/sda example", "warn"],
  ["subprocess.run(['dd', '--help'])", "allow"],
];

const DD_IMPERATIVE = [
  ["!dd of=/dev/sda", "block"],
  ["dd if=/dev/sda of=dump.bin", "block"],
];

test("F5 destructive corpus is blocked or warned", () => {
  for (const [code, expected] of DESTRUCTIVE_IPYTHON) {
    assert.equal(evaluateIpythonFloor(code).kind, expected, code);
  }
});

test("Verify-Fix: dd mentions warn instead of hard-blocking; imperative dd stays blocked", () => {
  for (const [code, expected] of DD_MENTIONS) {
    assert.equal(evaluateIpythonFloor(code).kind, expected, code);
  }
  for (const [code, expected] of DD_IMPERATIVE) {
    assert.equal(evaluateIpythonFloor(code).kind, expected, code);
  }
  assert.equal(evaluateBashFloor('echo "dd of=/dev/sda"').kind, "warn", "a bash echo mention is not an action");
  assert.equal(evaluateBashFloor("dd of=/dev/sda bs=1M").kind, "block", "a real bash dd still blocks");
});

test("F5 legitimate corpus is allowed", () => {
  for (const code of LEGIT_IPYTHON) {
    assert.equal(evaluateIpythonFloor(code).kind, "allow", code);
  }
});

test("F5 documented evasions are explicitly not caught (tripwire, not boundary)", () => {
  for (const code of EVASIONS) {
    assert.equal(evaluateIpythonFloor(code).kind, "allow", code);
  }
});

test("F5 bash floor: narrowed dd rule", () => {
  assert.equal(evaluateBashFloor("dd --help").kind, "allow");
  assert.equal(evaluateBashFloor("dd of=/dev/nvme0n1 bs=1M").kind, "block");
  assert.equal(evaluateBashFloor("rm -rf /").kind, "block");
  assert.equal(evaluateBashFloor("rm /tmp/one-file").kind, "warn");
  assert.equal(evaluateBashFloor("git status").kind, "allow");
});
