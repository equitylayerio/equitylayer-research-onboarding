import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, chmodSync, symlinkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runLocal } from "../client/local-cli.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { setup, policy, scope, result } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";

function environment(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-local-restore-")));
  const workspace = join(root, "original"), destination = join(root, "restored");
  const ledger = new ResearchLedger(workspace);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const envelope = setup(ledger); ledger.enqueue(envelope, "test-window", policy());
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  const lease = ledger.claim("synthetic-owner"), value = result(envelope);
  ledger.finish(lease, value);
  const delivered = ledger.inbox()[0];
  ledger.review(delivered.delivery_id, "accept_evidence", "Synthetic evidence only.", "test-evidence-review", 0);
  ledger.review(delivered.delivery_id, "accept_interpretation", "Synthetic interpretation only.", "test-interpretation-review", 1);
  return { root, workspace, destination, ledger, delivered };
}
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");

test("CLI backup and restore preserve research, acceptance, and review history without AI", async t => {
  const f = environment(t); let emitted = "";
  const backup = await runLocal(["backup", "--workspace", f.workspace, "--name", "personal-backup.sqlite"], { stdout: text => { emitted += text; } });
  assert.equal(backup.output.status, "backed_up");
  const path = join(f.workspace, "personal-backup.sqlite"), before = digest(path);
  const restored = await runLocal(["restore", "--backup", path, "--workspace", f.destination], { stdout: text => { emitted += text; } });
  assert.equal(restored.exitCode, 0); assert.equal(restored.output.status, "restored");
  assert.equal(restored.output.execution_authorized, false);
  assert.equal(digest(path), before);
  assert.equal(statSync(f.destination).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.destination, "research.sqlite")).mode & 0o777, 0o600);
  const reopened = new ResearchLedger(f.destination);
  try {
    assert.deepEqual(reopened.inbox(), f.ledger.inbox());
    assert.deepEqual(reopened.reviews(scope().watch_id), f.ledger.reviews(scope().watch_id));
    assert.deepEqual(reopened.watch(scope().watch_id), f.ledger.watch(scope().watch_id));
    assert.equal(reopened.workspaceStatus().counts.requests, 0); reopened.verifyIntegrity();
  } finally { reopened.close(); }
  assert.doesNotMatch(emitted, /Synthetic research result|Synthetic local research question/);
});

test("restore refuses an existing workspace and preserves its bytes", async t => {
  const f = environment(t), path = f.ledger.backup("snapshot.sqlite"), before = digest(f.ledger.path);
  const out = await runLocal(["restore", "--backup", path, "--workspace", f.workspace], { stdout: () => {} });
  assert.equal(out.exitCode, 1); assert.equal(out.output.code, "UNSAFE_STORAGE_PATH");
  assert.equal(digest(f.ledger.path), before);
});

test("restore validates absolute paths and required flags before creating a directory", async t => {
  const f = environment(t);
  for (const [args, code] of [
    [["restore", "--backup", "relative.sqlite", "--workspace", f.destination], "BACKUP_PATH_INVALID"],
    [["restore", "--backup", join(f.root, "missing.sqlite"), "--workspace", "relative"], "WORKSPACE_PATH_INVALID"],
    [["restore", "--workspace", f.destination], "CLI_FLAGS_INVALID"],
    [["restore", "--backup", join(f.root, "missing.sqlite"), "--workspace", f.destination, "--allow-private-context"], "CLI_FLAGS_INVALID"],
  ]) {
    const out = await runLocal(args, { stdout: () => {} });
    assert.equal(out.output.code, code); assert.equal(existsSync(f.destination), false);
  }
});

test("restore refuses linked or nonprivate backups before creating the destination", async t => {
  const f = environment(t), path = f.ledger.backup("snapshot.sqlite"), link = join(f.root, "linked.sqlite");
  symlinkSync(path, link);
  for (const backup of [link, path]) {
    if (backup === path) chmodSync(path, 0o644);
    const out = await runLocal(["restore", "--backup", backup, "--workspace", f.destination], { stdout: () => {} });
    assert.equal(out.exitCode, 1); assert.equal(existsSync(f.destination), false);
  }
});

test("invalid backup data cannot become an empty restored workspace", async t => {
  const f = environment(t), path = join(f.root, "invalid.sqlite");
  writeFileSync(path, "PRIVATE_SENTINEL not a database", { mode: 0o600 }); let output = "";
  const out = await runLocal(["restore", "--backup", path, "--workspace", f.destination], { stdout: text => { output += text; } });
  assert.equal(out.exitCode, 1); assert.equal(existsSync(f.destination), false);
  assert.doesNotMatch(output, /PRIVATE_SENTINEL|not a database/);
});
