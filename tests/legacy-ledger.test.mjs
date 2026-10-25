import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ResearchLedger, restoreResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { contentHash } from "../client/local/run-contract.mjs";
import { setup, scope, policy, result, context } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";

const directory = () => mkdtempSync(join(tmpdir(), "equitylayer-legacy-ledger-"));
const bytes = (value) => Buffer.from(JSON.stringify(value, null, 2));
function legacy(count = 1) {
  const current = scope(2);
  const results = Array.from({ length: count }, (_, index) => ({ ...result({ scope: current }),
    result_id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111` }));
  const reviews = results.map((entry) => ({ result_id: entry.result_id, decision: "revisit",
    reviewed_at: "2026-10-11T00:00:00Z", reason: "Legacy synthetic review, not a new acceptance." }));
  return { schema_version: 1, watches: [{ scope: { ...current, component: "", ...context() },
    saved_at: "2026-10-11T00:00:00Z", results, reviews, accepted_result_id: results[0]?.result_id }] };
}
function downgradeSyntheticFixture(path) {
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers;");
  db.exec("DROP TABLE thesis_reviews; DROP TABLE thesis_proposals; DROP TABLE thesis_heads; DROP TABLE thesis_manifest;");
  db.exec("DROP TABLE schedule_run_leases; DROP TABLE schedule_ticks; DROP TABLE schedule_state; DROP TABLE schedule_configs;");
  db.exec("DROP TABLE method_trial_outputs; DROP TABLE method_trial_manifest; DROP TABLE method_trial_pairs; DROP TABLE method_artifact_manifest; DROP TABLE method_artifacts;");
  db.exec("DROP TABLE usage_reconciliations; DROP TABLE request_receipts; ALTER TABLE requests DROP COLUMN accounting_version; ALTER TABLE requests DROP COLUMN receipt_set_sha256; ALTER TABLE requests DROP COLUMN selected_receipt_sha256; ALTER TABLE requests DROP COLUMN reconciliation_sha256; DROP TABLE event_jobs; DROP TABLE event_decisions; DROP TABLE source_policies; DROP TABLE source_fact_sets; DROP TABLE normalized_facts; DROP TABLE legacy_reviews; DROP TABLE legacy_archive_results; DROP TABLE legacy_results; DROP TABLE legacy_imports; DROP TABLE legacy_archives; ALTER TABLE reviews DROP COLUMN expected_revision; ALTER TABLE reviews DROP COLUMN record_sha256; PRAGMA user_version=1;");
  db.close();
}

test("legacy migration preserves raw bytes, complete history, unknown provenance, and the original acceptance", () => {
  const root = directory(); const ledger = new ResearchLedger(root);
  const raw = bytes(legacy(35)); const saved = ledger.importLegacyWorkspace(raw);
  assert.equal(saved.reused, false); assert.equal(saved.watches, 1);
  assert.deepEqual(ledger.legacyWorkspace(saved.archive_sha256).raw_bytes, raw);
  assert.equal(ledger.legacyWorkspace(saved.archive_sha256).watches[0].accepted_result.status, "legacy-unclassified");
  assert.equal(ledger.legacyWorkspace(saved.archive_sha256).watches[0].accepted_result_id, legacy().watches[0].accepted_result_id);
  const first = ledger.legacyHistory(scope().watch_id, { limit: 30 });
  const second = ledger.legacyHistory(scope().watch_id, { after: first.at(-1).sequence });
  assert.equal(first.length, 30); assert.equal(second.length, 5);
  assert.deepEqual(first[0].provenance, { status: "unknown", run_id: null, method: null, source_refs: null });
  assert.equal(ledger.inbox().length, 0); assert.equal(ledger.reviews(scope().watch_id).length, 0);
  assert.equal(ledger.watch(scope().watch_id).evidence_delivery_id, null);
  assert.equal(ledger.watch(scope().watch_id).interpretation_delivery_id, null);
  assert.equal(ledger.notices()[0].payload.kind, "legacy_review");
  assert.equal(ledger.importLegacyWorkspace(raw).reused, true); assert.equal(ledger.notices().length, 1);
  assert.equal(ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); ledger.close();
  const reopened = new ResearchLedger(root);
  assert.equal(reopened.legacyHistory(scope().watch_id).length, 35);
  assert.deepEqual(reopened.legacyWorkspace(saved.archive_sha256).raw_bytes, raw); reopened.close();
});

test("different archive formatting preserves distinct raw archives without duplicating results", () => {
  const ledger = new ResearchLedger(directory()); const value = legacy();
  const a = ledger.importLegacyWorkspace(bytes(value));
  value.watches[0].reviews[0].decision = "keep";
  const b = ledger.importLegacyWorkspace(Buffer.from(JSON.stringify(value)));
  assert.notEqual(a.archive_sha256, b.archive_sha256); assert.equal(ledger.legacyHistory(scope().watch_id).length, 1);
  assert.equal(ledger.legacyWorkspace(a.archive_sha256).watches[0].reviews[0].decision, "revisit");
  assert.equal(ledger.legacyWorkspace(b.archive_sha256).watches[0].reviews[0].decision, "keep");
  assert.equal(ledger.watch(scope().watch_id).evidence_delivery_id, null); ledger.verifyIntegrity(); ledger.close();
});

test("a conflicting legacy result rolls back every watch and archive in the import", () => {
  const ledger = new ResearchLedger(directory()); const initial = legacy(); ledger.importLegacyWorkspace(bytes(initial));
  const conflict = legacy(); conflict.watches[0].results[0].summary = "Different immutable result.";
  const newWatch = structuredClone(initial.watches[0]); newWatch.scope.watch_id = "8713bba6-e91e-4c1a-b756-2b18d2b7c776";
  newWatch.results = []; newWatch.reviews = []; delete newWatch.accepted_result_id;
  conflict.watches.unshift(newWatch);
  assert.throws(() => ledger.importLegacyWorkspace(bytes(conflict)), { code: "LEGACY_IMPORT_CONFLICT" });
  assert.equal(ledger.watch(newWatch.scope.watch_id), null); assert.equal(ledger.notices().length, 1);
  assert.equal(ledger.legacyHistory(scope().watch_id)[0].result.summary, initial.watches[0].results[0].summary);
  ledger.verifyIntegrity(); ledger.close();
});

test("legacy import cannot replace a current scope, private context, or accepted references", () => {
  const ledger = new ResearchLedger(directory()); const envelope = setup(ledger);
  ledger.enqueue(envelope, "test-window", policy()); const delivery = ledger.finish(ledger.claim("a"), result(envelope));
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  ledger.review(delivery.delivery_id, "accept_evidence", "Accept synthetic A.", "a", 0);
  assert.throws(() => ledger.importLegacyWorkspace(bytes(legacy())), { code: "LEGACY_IMPORT_CONFLICT" });
  const matching = legacy(); matching.watches[0].scope.revision = 1; matching.watches[0].results[0].scope_revision = 1;
  assert.throws(() => ledger.importLegacyWorkspace(bytes(matching)), { code: "REVISION_CONFLICT" });
  assert.equal(ledger.watch(scope().watch_id).evidence_delivery_id, delivery.delivery_id);
  assert.equal(ledger.legacyHistory(scope().watch_id).length, 0); ledger.close();
});

for (const point of ["before_commit", "after_commit"]) test(`legacy import recovers after a ${point} storage failure`, () => {
  const root = directory(); let fail = true;
  const ledger = new ResearchLedger(root, { fault: (event) => { if (fail && event === `legacy_import:${point}`) { fail = false; throw new Error("Synthetic ENOSPC."); } } });
  const raw = bytes(legacy());
  assert.throws(() => ledger.importLegacyWorkspace(raw), { code: "STORAGE_WRITE_UNCERTAIN" }); ledger.close();
  const reopened = new ResearchLedger(root);
  assert.equal(reopened.legacyHistory(scope().watch_id).length, point === "after_commit" ? 1 : 0);
  assert.equal(reopened.importLegacyWorkspace(raw).reused, point === "after_commit");
  assert.equal(reopened.notices().length, 1); reopened.close();
});

test("version-one schema upgrades retain a private backup and both accepted references", () => {
  const root = directory(); const ledger = new ResearchLedger(root); const envelope = setup(ledger);
  ledger.enqueue(envelope, "test-window", policy()); const delivery = ledger.finish(ledger.claim("a"), result(envelope));
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  ledger.review(delivery.delivery_id, "accept_evidence", "Accept synthetic evidence.", "e", 0);
  ledger.review(delivery.delivery_id, "accept_interpretation", "Accept synthetic interpretation.", "i", 1);
  ledger.close(); downgradeSyntheticFixture(join(root, "research.sqlite"));
  const upgraded = new ResearchLedger(root);
  const snapshot = readdirSync(root).find((name) => name.startsWith("before-schema-2-")); assert.ok(snapshot);
  const previous = new DatabaseSync(join(root, snapshot), { readOnly: true });
  assert.equal(previous.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(previous.prepare("SELECT interpretation_delivery_id FROM watches").get().interpretation_delivery_id, delivery.delivery_id); previous.close();
  assert.equal(upgraded.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
  assert.equal(upgraded.watch(scope().watch_id).evidence_delivery_id, delivery.delivery_id);
  upgraded.importLegacyWorkspace(bytes({ schema_version: 1, watches: [] })); upgraded.close();
  const restored = restoreResearchLedger(join(root, snapshot), join(root, "restored-v1"));
  assert.equal(restored.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
  assert.equal(restored.watch(scope().watch_id).interpretation_delivery_id, delivery.delivery_id); restored.close();
});

for (const point of ["before_commit", "after_commit"]) test(`schema upgrade recovers after a ${point} failure without replacing the backup`, () => {
  const root = directory(); const ledger = new ResearchLedger(root); ledger.saveRevision(scope(), context()); ledger.close();
  downgradeSyntheticFixture(join(root, "research.sqlite"));
  assert.throws(() => new ResearchLedger(root, { fault: (event) => { if (event === `schema_upgrade:${point}`) throw new Error("Synthetic storage failure."); } }), { code: "STORAGE_WRITE_UNCERTAIN" });
  const snapshots = readdirSync(root).filter((name) => name.startsWith("before-schema-2-")); assert.equal(snapshots.length, 1);
  const retainedBackup = readFileSync(join(root, snapshots[0]));
  const raw = new DatabaseSync(join(root, "research.sqlite"), { readOnly: true });
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, point === "before_commit" ? 1 : LEDGER_SCHEMA_VERSION); raw.close();
  const reopened = new ResearchLedger(root); assert.equal(reopened.watch(scope().watch_id).current_revision, 1); reopened.close();
  assert.deepEqual(readFileSync(join(root, snapshots[0])), retainedBackup);
});

test("backup and restore preserve legacy archives without creating a new acceptance", () => {
  const root = directory(); const ledger = new ResearchLedger(root);
  const raw = bytes(legacy(35)); const saved = ledger.importLegacyWorkspace(raw); const snapshot = ledger.backup("legacy.sqlite");
  const restored = restoreResearchLedger(snapshot, join(root, "restored"));
  assert.deepEqual(restored.legacyWorkspace(saved.archive_sha256).raw_bytes, raw);
  assert.equal(restored.legacyHistory(scope().watch_id).length, 35);
  assert.equal(restored.watch(scope().watch_id).interpretation_delivery_id, null);
  assert.equal(restored.notices().length, 1); restored.close(); ledger.close();
});

test("changed source bytes and pinned content fail integrity checks before backup or restore", () => {
  for (const change of [
    "UPDATE artifacts SET bytes=x'7b7d'",
    "UPDATE revisions SET context_json='{}'",
    "UPDATE deliveries SET result_json=json_set(result_json,'$.summary','Changed')",
    "UPDATE checkpoints SET payload_json='{}'",
  ]) {
    const root = directory(); const ledger = new ResearchLedger(root); const envelope = setup(ledger);
    ledger.enqueue(envelope, "test-window", policy()); const lease = ledger.claim("a");
    ledger.checkpoint(lease, "test", { retained: true }); ledger.finish(lease, result(envelope));
    const snapshot = ledger.backup("untampered.sqlite"); ledger.close();
    const db = new DatabaseSync(snapshot); db.exec(change); db.close();
    assert.throws(() => restoreResearchLedger(snapshot, join(root, "rejected")), { code: "STORAGE_CORRUPT" });
    const unsafe = new DatabaseSync(join(root, "research.sqlite")); unsafe.exec(change); unsafe.close();
    assert.throws(() => new ResearchLedger(root), { code: "STORAGE_CORRUPT" });
  }
});

test("legacy archive and review snapshot changes fail retained integrity checks", () => {
  for (const change of ["UPDATE legacy_archives SET bytes=x'7b7d'", "UPDATE legacy_reviews SET review_json='{}'",
    "UPDATE legacy_imports SET accepted_result_id=NULL", "UPDATE legacy_archive_results SET position=99"]) {
    const root = directory(); const ledger = new ResearchLedger(root); ledger.importLegacyWorkspace(bytes(legacy())); ledger.close();
    const db = new DatabaseSync(join(root, "research.sqlite")); db.exec(change); db.close();
    assert.throws(() => new ResearchLedger(root), { code: "STORAGE_CORRUPT" });
  }
});

test("review reasons, actions, timestamps, optimistic versions, and hashes cannot change during restore", () => {
  for (const change of ["UPDATE reviews SET note='Modified review note.'", "UPDATE reviews SET action='revisit'",
    "UPDATE reviews SET created_at=99999", "UPDATE reviews SET expected_revision=99", "UPDATE reviews SET request_sha256='changed'"]) {
    const root = directory(); const ledger = new ResearchLedger(root); const envelope = setup(ledger);
    ledger.enqueue(envelope, "test-window", policy()); const delivery = ledger.finish(ledger.claim("a"), result(envelope));
    ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
    ledger.review(delivery.delivery_id, "accept_evidence", "Original reason.", "original", 0);
    const snapshot = ledger.backup("review.sqlite"); ledger.close();
    const db = new DatabaseSync(snapshot); db.exec(change); db.close();
    assert.throws(() => restoreResearchLedger(snapshot, join(root, "rejected")), { code: "STORAGE_CORRUPT" });
  }
});

test("changed version-one review reasons fail before the schema upgrade and remain available for recovery", () => {
  const root = directory(); const ledger = new ResearchLedger(root); const envelope = setup(ledger);
  ledger.enqueue(envelope, "test-window", policy()); const delivery = ledger.finish(ledger.claim("a"), result(envelope));
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  ledger.review(delivery.delivery_id, "accept_evidence", "Original version-one reason.", "original", 0); ledger.close();
  const path = join(root, "research.sqlite"); downgradeSyntheticFixture(path);
  const changed = new DatabaseSync(path); changed.exec("UPDATE reviews SET note='Changed without the request hash'"); changed.close();
  assert.throws(() => new ResearchLedger(root), { code: "STORAGE_CORRUPT" });
  const retained = new DatabaseSync(path, { readOnly: true });
  assert.equal(retained.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(retained.prepare("SELECT note FROM reviews").get().note, "Changed without the request hash"); retained.close();
  assert.equal(readdirSync(root).some((name) => name.startsWith("before-schema-2-")), false);
});

test("integrity verification uses one snapshot when another connection commits a valid review", () => {
  const root = directory(); const ledger = new ResearchLedger(root); const envelope = setup(ledger);
  ledger.enqueue(envelope, "test-window", policy()); const delivery = ledger.finish(ledger.claim("a"), result(envelope));
  const other = new ResearchLedger(root); const originalPrepare = DatabaseSync.prototype.prepare; let injected = false;
  try {
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = originalPrepare.call(this, sql);
      if (!sql.startsWith("SELECT v.*,r.watch_id FROM reviews")) return statement;
      return { all: (...args) => {
        const rows = statement.all(...args);
        if (!injected) { injected = true; other.review(delivery.delivery_id, "received", "Concurrent valid review.", "concurrent", 0); }
        return rows;
      } };
    };
    assert.equal(ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); assert.equal(injected, true);
  } finally { DatabaseSync.prototype.prepare = originalPrepare; }
  assert.equal(ledger.watch(scope().watch_id).review_revision, 1); ledger.verifyIntegrity();
  other.close(); ledger.close();
});

test("legacy history bounds and missing archives do not change storage", () => {
  const ledger = new ResearchLedger(directory()); ledger.importLegacyWorkspace(bytes(legacy()));
  assert.equal(ledger.legacyWorkspace(contentHash("missing")), null);
  assert.throws(() => ledger.legacyHistory(scope().watch_id, { limit: 101 }), { code: "INVALID_INPUT" });
  assert.throws(() => ledger.legacyHistory(scope().watch_id, { after: -1 }), { code: "INVALID_INPUT" });
  assert.throws(() => ledger.importLegacyWorkspace(Buffer.from("invalid")), { code: "LEGACY_WORKSPACE_INVALID" });
  assert.equal(ledger.notices().length, 1); ledger.close();
});

test("two processes upgrade the same version-one workspace without changing retained state", { timeout: 10_000 }, async () => {
  const root = directory(); const ledger = new ResearchLedger(root); ledger.saveRevision(scope(), context()); ledger.close();
  downgradeSyntheticFixture(join(root, "research.sqlite"));
  const helper = fileURLToPath(new URL("./helpers/ledger-process.mjs", import.meta.url)); const children = [];
  try {
    await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
      const child = fork(helper, [root, "worker"], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
      let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("message", resolve); child.once("error", reject);
      child.once("exit", () => reject(new Error(`The migration worker exited before readiness. ${stderr}`)));
    })));
  } finally {
    await Promise.all(children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.disconnect();
      });
    }));
  }
  const reopened = new ResearchLedger(root); assert.equal(reopened.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
  assert.deepEqual(reopened.watch(scope().watch_id).revisions[0].local_context, context()); reopened.close();
  assert.ok(readdirSync(root).some((name) => name.startsWith("before-schema-2-")));
});

for (const operation of ["schema_upgrade", "legacy_import"]) {
  for (const boundary of ["before_commit", "after_commit"]) test(`SIGKILL at ${operation}:${boundary} preserves migration recovery`, { timeout: 10_000 }, async () => {
    const root = directory(); const ledger = new ResearchLedger(root); ledger.close();
    if (operation === "schema_upgrade") downgradeSyntheticFixture(join(root, "research.sqlite"));
    const script = `import { ResearchLedger } from ${JSON.stringify(new URL("../client/local/ledger.mjs", import.meta.url).href)};
      const ledger = new ResearchLedger(process.argv[1], { fault: point => { if (point === process.argv[2]) process.kill(process.pid, 'SIGKILL'); } });
      if (process.argv[2].startsWith('legacy_import:')) ledger.importLegacyWorkspace(Buffer.from(process.argv[3]));
      ledger.close();`;
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", script, root, `${operation}:${boundary}`, bytes(legacy()).toString("utf8")], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
    });
    assert.equal(exit.signal, "SIGKILL", exit.stderr);
    const reopened = new ResearchLedger(root); assert.equal(reopened.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
    if (operation === "legacy_import") {
      assert.equal(reopened.legacyHistory(scope().watch_id).length, boundary === "before_commit" ? 0 : 1);
      assert.equal(reopened.importLegacyWorkspace(bytes(legacy())).reused, boundary === "after_commit");
      assert.equal(reopened.notices().length, 1);
    } else assert.ok(readdirSync(root).some((name) => name.startsWith("before-schema-2-")));
    reopened.close();
  });
}
