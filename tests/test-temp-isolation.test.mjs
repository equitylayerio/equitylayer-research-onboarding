import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const helper = fileURLToPath(new URL("./fixtures/owned-test-temp.mjs", import.meta.url));
function fixture(t, source, name = "synthetic.test.mjs") {
  const root = mkdtempSync(join(tmpdir(), "el-suite-hook-check-")), base = join(root, "temporary"); mkdirSync(base);
  const sentinel = join(base, "older-directory"); mkdirSync(sentinel); writeFileSync(join(sentinel, "keep"), "older synthetic data");
  const entry = join(root, name); writeFileSync(entry, source);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = spawnSync(process.execPath, ["--import", helper, entry], {
    env: { ...process.env, TMPDIR: base }, encoding: "utf8", timeout: 5000
  });
  assert.equal(output.error, undefined); assert.equal(output.status, 0, output.stderr);
  assert.equal(readFileSync(join(sentinel, "keep"), "utf8"), "older synthetic data");
  return { root, base, output: JSON.parse(output.stdout) };
}

test("each test process removes only its own temporary tree after exit", t => {
  const f = fixture(t, `import {tmpdir} from 'node:os'; import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
const root=tmpdir();writeFileSync(join(root,'generated'),'synthetic');console.log(JSON.stringify({root}));`);
  assert.notEqual(f.output.root, f.base); assert.equal(existsSync(f.output.root), false);
  assert.equal(existsSync(f.base), true);
});

test("the cleanup hook leaves non-test commands and their temporary base unchanged", t => {
  const f = fixture(t, `import {tmpdir} from 'node:os';console.log(JSON.stringify({root:tmpdir()}));`, "synthetic.mjs");
  assert.equal(f.output.root, f.base); assert.equal(existsSync(f.base), true);
});

test("a replacement directory at the owned path is not cleanup authority", t => {
  const f = fixture(t, `import {tmpdir} from 'node:os';import {renameSync,mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const root=tmpdir();renameSync(root,root+'-original');mkdirSync(root);writeFileSync(join(root,'keep'),'replacement');console.log(JSON.stringify({root}));`);
  assert.equal(readFileSync(join(f.output.root, "keep"), "utf8"), "replacement");
  assert.equal(existsSync(f.output.root + "-original"), true);
});

test("a symlink at the owned path cannot delete another synthetic directory", t => {
  const f = fixture(t, `import {tmpdir} from 'node:os';import {renameSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';import {join,dirname} from 'node:path';
const root=tmpdir(),outside=join(dirname(root),'unrelated');renameSync(root,root+'-original');mkdirSync(outside);writeFileSync(join(outside,'keep'),'unrelated');symlinkSync(outside,root,'dir');console.log(JSON.stringify({root,outside}));`);
  assert.equal(readFileSync(join(f.output.outside, "keep"), "utf8"), "unrelated");
  assert.equal(existsSync(f.output.root + "-original"), true);
});
