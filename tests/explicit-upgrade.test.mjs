import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { runLocal } from "../client/local-cli.mjs";
import { runSession } from "../client/session-cli.mjs";
import { openWorkspace } from "../client/workspace-cli.mjs";
import { setupWorkspace } from "../client/setup-cli.mjs";
import { setupSource } from "../client/source-setup-cli.mjs";
import { setup, scope, methodBundle, context, limits } from "./fixtures/local-research.mjs";
import { canonicalJson } from "../client/local/run-contract.mjs";

const call = (args, options = {}) => runLocal(args, { stdout: () => {}, ...options });
function snapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
      assert.match(name, /^[a-z_]+$/u);
      return { name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value]))) };
    });
  } finally { db.close(); }
}
function downgrade(directory, version) {
  const db = new DatabaseSync(join(directory, 'research.sqlite'));
  try {
    db.exec('DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;');
    if (version === 10) db.exec('DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;');
    db.exec(`PRAGMA user_version=${version}; PRAGMA wal_checkpoint(TRUNCATE);`);
  } finally { db.close(); }
}
function fixture(t, version = 10) {
  const root = mkdtempSync(join(tmpdir(), 'el-explicit-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'old'), target = join(root, 'copy'), path = join(workspace, 'research.sqlite');
  const ledger = new ResearchLedger(workspace); const envelope = setup(ledger); ledger.close();
  downgrade(workspace, version);
  // A closed synthetic old database is a stand-in for an old compatible client's backup.
  const backup = join(root, 'old-backup.sqlite'); writeFileSync(backup, readFileSync(path), { mode: 0o600 });
  const rows = snapshot(path);
  // Close a writable connection after the read-only snapshot removes empty WAL sidecars.
  const closed = new DatabaseSync(path); closed.exec('PRAGMA wal_checkpoint(TRUNCATE);'); closed.close();
  const before = readFileSync(path), backupBytes = readFileSync(backup), files = readdirSync(workspace).sort();
  const unchanged = () => {
    assert.deepEqual(readFileSync(path), before); assert.deepEqual(readFileSync(backup), backupBytes);
    assert.deepEqual(readdirSync(workspace).sort(), files);
  };
  return { root, workspace, target, path, backup, rows, envelope, unchanged };
}
const upgrade = f => ['upgrade', '--backup', f.backup, '--workspace', f.target, '--allow-schema-upgrade'];

test('fresh creation is separate from migration permission', t => {
  const root = mkdtempSync(join(tmpdir(), 'el-creation-policy-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = new ResearchLedger(join(root, 'new'), { allow_creation: true, allow_migration: false });
  try { assert.equal(ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); } finally { ledger.close(); }
  assert.throws(() => new ResearchLedger(root, { allow_creation: 'yes', allow_migration: false }), { code: 'INVALID_INPUT' });
});

for (const version of [10, 11]) test(`explicit copy upgrades schema ${version} and preserves all original rows`, async t => {
  const f = fixture(t, version), output = await call(upgrade(f));
  assert.equal(output.exitCode, 0); assert.equal(output.output.status, 'upgraded_copy');
  assert.equal(output.output.schema_version, LEDGER_SCHEMA_VERSION);
  for (const field of ['execution_authorized', 'accepted_new_evidence', 'accepted_new_interpretation']) assert.equal(output.output[field], false);
  const after = snapshot(join(f.target, 'research.sqlite'));
  for (const table of f.rows) assert.deepEqual(after.find(item => item.name === table.name), table);
  f.unchanged();
  const status = await call(['status', '--workspace', f.target]); assert.equal(status.exitCode, 0);
  assert.equal(status.output.counts.watches, 1); assert.equal(status.output.counts.requests, 0);
  assert.equal(readdirSync(f.target).filter(name => /^before-schema-/.test(name)).length, 1);
});

test('upgrade requires consent before creating its destination', async t => {
  const f = fixture(t);
  const value = await call(upgrade(f).slice(0, -1), { ledgerOptions: { allow_migration: true } });
  assert.equal(value.output.code, 'SCHEMA_UPGRADE_CONSENT_REQUIRED');
  assert.equal(existsSync(f.target), false); f.unchanged();
});

test('ordinary restore refuses an older backup before creating a destination', async t => {
  const f = fixture(t);
  const value = await call(['restore', '--backup', f.backup, '--workspace', f.target], { ledgerOptions: { allow_migration: true } });
  assert.equal(value.output.code, 'SCHEMA_UPGRADE_REQUIRED'); assert.equal(existsSync(f.target), false); f.unchanged();
});

for (const point of ['before_commit', 'after_commit']) test(`migration ${point} failure cannot modify the source or report success`, async t => {
  const f = fixture(t); let injected = false;
  const value = await call(upgrade(f), { ledgerOptions: { fault: boundary => {
    if (boundary === `schema_upgrade:${point}`) { injected = true; throw Error('Synthetic storage fault.'); }
  } } });
  assert.equal(injected, true); assert.equal(value.exitCode, 1); assert.equal(value.output.code, 'STORAGE_WRITE_UNCERTAIN');
  f.unchanged(); assert.equal(existsSync(f.target), true);
  const db = new DatabaseSync(join(f.target, 'research.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, point === 'before_commit' ? 10 : LEDGER_SCHEMA_VERSION); } finally { db.close(); }
  assert.equal((await call(upgrade(f))).output.code, 'UNSAFE_STORAGE_PATH');
});

test('upgrade refuses an existing destination and linked backup', async t => {
  const f = fixture(t); const linked = join(f.root, 'linked.sqlite'); symlinkSync(f.backup, linked);
  assert.equal((await call(['upgrade', '--backup', linked, '--workspace', f.target, '--allow-schema-upgrade'])).output.code, 'UNSAFE_STORAGE_PATH');
  assert.equal(existsSync(f.target), false);
  assert.equal((await call(['upgrade', '--backup', f.backup, '--workspace', f.workspace, '--allow-schema-upgrade'])).output.code, 'UNSAFE_STORAGE_PATH');
  f.unchanged();
});

for (const command of ['status', 'backup', 'init', 'thesis-list', 'schedule-status']) test(`${command} refuses old schemas despite injected migration permission`, async t => {
  const f = fixture(t), input = join(f.root, 'init.json');
  writeFileSync(input, canonicalJson({ scope: scope(), private_context: context(), method_bundle: methodBundle(),
    budget: { window_id: 'test-window', limits: limits() }, source_policies: [] }), { mode: 0o600 });
  const extra = command === 'backup' ? ['--name', 'not-created.sqlite'] : command === 'init' ? ['--input', input]
    : command === 'schedule-status' ? ['--schedule-id', 'synthetic-schedule'] : [];
  for (let index = 0; index < 2; index++) {
    assert.equal((await call([command, '--workspace', f.workspace, ...extra], { ledgerOptions: { allow_migration: true, allow_creation: true } })).output.code, 'SCHEMA_UPGRADE_REQUIRED');
    f.unchanged();
  }
});

test('workspace startup refuses an old schema without a server or backup', async t => {
  const f = fixture(t); let output = '';
  for (let index = 0; index < 2; index++) {
    await assert.rejects(openWorkspace(['--workspace', f.workspace], { stdout: text => { output += text; }, ledgerOptions: { allow_migration: true } }), { code: 'SCHEMA_UPGRADE_REQUIRED' });
    assert.equal(output, ''); f.unchanged();
  }
});

for (const command of ['prepare', 'serve']) test(`session ${command} refuses an older schema without MCP output`, async t => {
  const f = fixture(t); let output = '';
  const args = [command, '--workspace', f.workspace, '--allow-private-context', '--allow-candidate-method',
    ...(command === 'prepare' ? ['--watch', scope().watch_id, '--revision', '1', '--method', f.envelope.method.bundle_sha256]
      : ['--context', `el-session-context-${'a'.repeat(64)}`])];
  await assert.rejects(runSession(args, { stdout: text => { output += text; }, ledgerOptions: { allow_migration: true } }), { code: 'SCHEMA_UPGRADE_REQUIRED' });
  assert.equal(output, ''); f.unchanged();
});

test('setup resume and source setup refuse migration of an existing workspace', async t => {
  const root = mkdtempSync(join(tmpdir(), 'el-upgrade-setup-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await setupWorkspace({ workspace, session: true, answers: { focus: 'ai_compute', symbols: ['AMAT', '2383.TW'],
    question: 'Synthetic private question.', trigger: 'Synthetic trigger.' }, method_bundle: methodBundle() });
  downgrade(workspace, 11); const path = join(workspace, 'research.sqlite'), before = readFileSync(path), files = readdirSync(workspace).sort();
  await assert.rejects(setupWorkspace({ workspace, resume: true }), { code: 'SCHEMA_UPGRADE_REQUIRED' });
  await assert.rejects(setupSource({ workspace, answers: { kind: 'twse_monthly_revenue_api', rights_status: 'HOLD', rights_reference: null, allow_candidate_trials: false } }), { code: 'SCHEMA_UPGRADE_REQUIRED' });
  assert.deepEqual(readFileSync(path), before); assert.deepEqual(readdirSync(workspace).sort(), files);
});
