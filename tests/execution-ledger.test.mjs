import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchLedger, restoreResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { contentHash } from "../client/local/run-contract.mjs";
import { setup, scope, context, policy, estimate, result } from "./fixtures/local-research.mjs";
import { sourcePolicy, configureEventWatch, intake } from "./fixtures/source-events.mjs";

function environment(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "equitylayer-execution-ledger-"));
  let now = Date.parse("2026-10-12T00:00:00Z");
  const ledger = new ResearchLedger(directory, { clock: () => now, ...options });
  const envelope = setup(ledger); ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  ledger.enqueue(envelope, "test-window", { ...policy(), not_before: now });
  return { directory, ledger, envelope, setNow: (value) => { now = value; }, advance: (delta) => { now += delta; } };
}
function dispatched(env, leaseMs = 30_000) {
  const lease = env.ledger.claim("caller", leaseMs);
  const request = env.ledger.reserveRequest(lease, "stable-operation", estimate());
  env.ledger.markDispatched(lease, request.request_id);
  return { lease, request };
}

test("execution context pins private input, methods, source metadata, and the first execution time across restart", () => {
  const env = environment(); const lease = env.ledger.claim("a", 100);
  const pinned = env.ledger.executionContext(lease);
  assert.equal(pinned.sha256, contentHash(pinned.payload));
  assert.deepEqual(pinned.payload.private_context, context());
  assert.equal(pinned.payload.created_at, "2026-10-12T00:00:00.000Z");
  assert.equal(pinned.payload.envelope.run_id, env.envelope.run_id);
  pinned.payload.private_context.question = "A caller cannot mutate the retained snapshot.";
  env.ledger.close();
  const reopened = new ResearchLedger(env.directory, { clock: () => Date.parse("2026-10-12T00:00:00Z") + 101 });
  const resumed = reopened.executionContext(reopened.claim("b"));
  assert.equal(resumed.sha256, pinned.sha256); assert.deepEqual(resumed.payload.private_context, context());
  reopened.close();
});

test("execution checks current source rights, purpose, parser, staleness, and candidate consent before a call", () => {
  for (const [patch, code] of [
    [{ rights_status: "HOLD" }, "SOURCE_RIGHTS_GATED"], [{ allowed_purposes: [] }, "SOURCE_RIGHTS_GATED"],
    [{ parser_version: "changed" }, "SOURCE_SCHEMA_CHANGED"], [{ max_source_age_ms: 1 }, "STALE_SOURCE"],
    [{ allow_candidate_trials: false }, "METHOD_CURATION_REQUIRED"],
  ]) {
    const env = environment(); env.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), ...patch });
    // Authority changes gate even manually enqueued jobs. No live lease remains.
    assert.equal(env.ledger.run(env.envelope.run_id).gate_code, "SOURCE_POLICY_CHANGED");
    assert.equal(env.ledger.claim("new"), null); assert.equal(env.ledger.requests(env.envelope.run_id).length, 0);
    env.ledger.close();
    const root = mkdtempSync(join(tmpdir(), "equitylayer-source-execution-gate-"));
    const ledger = new ResearchLedger(root, { clock: () => Date.parse("2026-10-12T00:00:00Z") });
    const envelope = setup(ledger); ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), ...patch });
    ledger.enqueue(envelope, "test-window", policy());
    assert.throws(() => ledger.executionContext(ledger.claim("worker")), { code }); ledger.close();
  }
});

test("a manual run without source rights cannot produce execution context", () => {
  const root = mkdtempSync(join(tmpdir(), "equitylayer-no-source-policy-")); const ledger = new ResearchLedger(root);
  const envelope = setup(ledger); ledger.enqueue(envelope, "test-window", policy());
  assert.throws(() => ledger.executionContext(ledger.claim("worker")), { code: "SOURCE_POLICY_MISSING" }); ledger.close();
});

test("a bounded retry releases an undispatched reservation but preserves attempt limits and checkpoints", () => {
  const env = environment(); const a = env.ledger.claim("a");
  env.ledger.checkpoint(a, "retained", { stable: true }); env.ledger.reserveRequest(a, "not-dispatched", estimate());
  assert.deepEqual(env.ledger.retryRun(a, Date.parse("2026-10-12T00:00:00Z") + 100), { status: "queued" });
  assert.equal(env.ledger.budget(scope().watch_id, "test-window").reserved.requests, 0);
  assert.equal(env.ledger.claim("early"), null); env.advance(100);
  const b = env.ledger.claim("b"); assert.equal(b.fence, 2);
  assert.equal(env.ledger.checkpoints(b.run_id)[0].payload.stable, true);
  assert.equal(env.ledger.retryRun(b, env.ledger.run(b.run_id).deadline).code, "DEADLINE_EXCEEDED");
  env.ledger.close();
});

test("a dispatched failure gates unknown usage and retains all non-request holds", () => {
  const env = environment(); const { lease } = dispatched(env);
  assert.deepEqual(env.ledger.retryRun(lease, 0), { status: "gated", code: "USAGE_UNKNOWN" });
  const budget = env.ledger.budget(scope().watch_id, "test-window");
  assert.equal(budget.spent.requests, 1); assert.equal(budget.reserved.tokens, estimate().tokens);
  assert.equal(env.ledger.requests(env.envelope.run_id)[0].status, "unknown");
  assert.equal(env.ledger.claim("blind-retry"), null); assert.equal(env.ledger.inbox().length, 0); env.ledger.close();
});

test("late receipts are immutable and do not settle usage, resume a run, deliver, or accept a thesis", () => {
  const env = environment(); const { lease, request } = dispatched(env); env.ledger.gateRun(lease, "EXECUTION_TIMEOUT");
  env.advance(10); const receipt = env.ledger.recordRequestReceipt(request.request_id, { tokens: 7, cost_microusd: 9 }, { complete: true });
  env.advance(10); assert.equal(env.ledger.recordRequestReceipt(request.request_id, { tokens: 7, cost_microusd: 9 }, { complete: true }).reused, true);
  assert.equal(env.ledger.requestReceipts(request.request_id).length, 1);
  assert.equal(env.ledger.requests(env.envelope.run_id)[0].status, "unknown");
  assert.equal(env.ledger.run(env.envelope.run_id).status, "gated"); assert.equal(env.ledger.inbox().length, 0);
  assert.equal(env.ledger.watch(scope().watch_id).interpretation_delivery_id, null);
  assert.equal(env.ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); assert.ok(receipt.receipt_sha256); env.ledger.close();
});

test("explicit measured-usage reconciliation is idempotent and resumes cached output only by owner choice", () => {
  const env = environment(); const { lease, request } = dispatched(env);
  env.ledger.settleRequest(lease, request.request_id, null, { cached: "The response remains local." });
  const unknown = env.ledger.requestReceipts(request.request_id)[0];
  assert.throws(() => env.ledger.reconcileRequestUsage(request.request_id, unknown.receipt_sha256, "Measured usage is missing.", "unknown-review"), { code: "USAGE_UNKNOWN" });
  env.advance(10); const receipt = env.ledger.recordRequestReceipt(request.request_id, { tokens: 4, cost_microusd: 6 }, { cached: "The response remains local." });
  assert.equal(env.ledger.reconcileRequestUsage(request.request_id, receipt.receipt_sha256, "Checked the caller receipt.", "review-1", { resume: true }).status, "queued");
  assert.equal(env.ledger.reconcileRequestUsage(request.request_id, receipt.receipt_sha256, "Checked the caller receipt.", "review-1", { resume: true }).reused, true);
  assert.throws(() => env.ledger.reconcileRequestUsage(request.request_id, receipt.receipt_sha256, "Another decision.", "review-1", { resume: true }), { code: "RECONCILIATION_CONFLICT" });
  const resumed = env.ledger.claim("new-worker"); const cached = env.ledger.reserveRequest(resumed, "stable-operation", estimate());
  assert.equal(cached.status, "settled"); assert.deepEqual(cached.response, { cached: "The response remains local." });
  assert.equal(env.ledger.budget(scope().watch_id, "test-window").spent.requests, 1);
  assert.equal(env.ledger.budget(scope().watch_id, "test-window").reserved.tokens, 0);
  env.ledger.finish(resumed, result(env.envelope)); assert.equal(env.ledger.inbox().length, 1);
  assert.equal(env.ledger.watch(scope().watch_id).interpretation_delivery_id, null);
  env.ledger.verifyIntegrity(); env.ledger.close();
});

test("reconciliation without explicit resume preserves the run gate", () => {
  const env = environment(); const { lease, request } = dispatched(env); env.ledger.gateRun(lease, "EXECUTION_TIMEOUT");
  const receipt = env.ledger.recordRequestReceipt(request.request_id, { tokens: 1, cost_microusd: 1 }, {});
  assert.equal(env.ledger.reconcileRequestUsage(request.request_id, receipt.receipt_sha256, "Checked usage only.", "review").status, "gated");
  assert.equal(env.ledger.claim("no-resume"), null); env.ledger.close();
});

test("reconciliation cannot reopen changed scopes or exceeded budgets", () => {
  for (const change of ["scope", "budget"]) {
    const env = environment(); const { lease, request } = dispatched(env); env.ledger.gateRun(lease, "EXECUTION_TIMEOUT");
    if (change === "scope") env.ledger.saveRevision(scope(2), context());
    const receipt = env.ledger.recordRequestReceipt(request.request_id, { tokens: change === "budget" ? 1001 : 1, cost_microusd: 1 }, {});
    env.ledger.reconcileRequestUsage(request.request_id, receipt.receipt_sha256, "Checked the caller usage report.", "review", { resume: true });
    assert.equal(env.ledger.run(env.envelope.run_id).status, change === "scope" ? "cancelled" : "gated");
    assert.equal(env.ledger.claim("not-authorized"), null); env.ledger.close();
  }
});

test("resumed source intake uses the newly checked policy without changing the original run identity", () => {
  const root = mkdtempSync(join(tmpdir(), "equitylayer-policy-resume-context-")); const ledger = new ResearchLedger(root, { clock: () => Date.parse("2026-10-12T00:00:00Z") });
  const method = configureEventWatch(ledger); const first = ledger.intakeSourceEvent(intake(method));
  ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy(3));
  const again = ledger.intakeSourceEvent(intake(method)); assert.equal(again.run.run_id, first.run.run_id);
  assert.equal(ledger.executionContext(ledger.claim("caller")).payload.envelope.run_id, first.run.run_id); ledger.close();
});

test("schema-three migration keeps a private backup and marks old accounting as unverified legacy", () => {
  const env = environment(); const { lease, request } = dispatched(env); env.ledger.settleRequest(lease, request.request_id, { tokens: 1, cost_microusd: 1 }, {}); env.ledger.close();
  const db = new DatabaseSync(join(env.directory, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers;");
  db.exec("DROP TABLE thesis_reviews; DROP TABLE thesis_proposals; DROP TABLE thesis_heads; DROP TABLE thesis_manifest;");
  db.exec("DROP TABLE schedule_run_leases; DROP TABLE schedule_ticks; DROP TABLE schedule_state; DROP TABLE schedule_configs;");
  db.exec("DROP TABLE method_trial_outputs; DROP TABLE method_trial_manifest; DROP TABLE method_trial_pairs; DROP TABLE method_artifact_manifest; DROP TABLE method_artifacts;");
  db.exec("DROP TABLE usage_reconciliations; DROP TABLE request_receipts; ALTER TABLE requests DROP COLUMN accounting_version; ALTER TABLE requests DROP COLUMN receipt_set_sha256; ALTER TABLE requests DROP COLUMN selected_receipt_sha256; ALTER TABLE requests DROP COLUMN reconciliation_sha256; PRAGMA user_version=3;"); db.close();
  const upgraded = new ResearchLedger(env.directory);
  assert.ok(readdirSync(env.directory).some((name) => name.startsWith("before-schema-4-")));
  assert.equal(upgraded.requests(env.envelope.run_id)[0].accounting_version, 0);
  assert.equal(upgraded.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); upgraded.close();
});

test("receipt content, manifest deletion, request inputs, and selected accounting changes fail integrity and restore", () => {
  for (const sql of ["DELETE FROM request_receipts", "UPDATE request_receipts SET receipt_json='{}'", "UPDATE requests SET usage_json='{}'", "UPDATE requests SET owner='changed'", "DELETE FROM request_receipts; DELETE FROM requests", "UPDATE budgets SET spent_json='{}'"]) {
    const env = environment(); const { lease, request } = dispatched(env); env.advance(10);
    env.ledger.settleRequest(lease, request.request_id, { tokens: 1, cost_microusd: 1 }, { retained: true });
    const backup = env.ledger.backup("accounting.sqlite"); env.ledger.close();
    const db = new DatabaseSync(backup); db.exec(sql); db.close();
    assert.throws(() => restoreResearchLedger(backup, join(env.directory, "rejected")), { code: "STORAGE_CORRUPT" });
  }
});

test("deleted reconciliation decisions cannot become silent accounting success", () => {
  const env = environment(); const { lease, request } = dispatched(env); env.ledger.gateRun(lease, "EXECUTION_TIMEOUT");
  const receipt = env.ledger.recordRequestReceipt(request.request_id, { tokens: 1, cost_microusd: 1 }, {});
  env.ledger.reconcileRequestUsage(request.request_id, receipt.receipt_sha256, "Checked the measured usage.", "review");
  const backup = env.ledger.backup("reviewed.sqlite"); env.ledger.close();
  const db = new DatabaseSync(backup); db.exec("DELETE FROM usage_reconciliations"); db.close();
  assert.throws(() => restoreResearchLedger(backup, join(env.directory, "rejected")), { code: "STORAGE_CORRUPT" });
});

test("an exact resume decision can recover after another unknown request clears the shared budget gate", () => {
  const env = environment(); const second = setup(env.ledger, 2);
  env.ledger.enqueue(second, "test-window", policy());
  const first = dispatched(env); const otherLease = env.ledger.claim("other");
  const other = env.ledger.reserveRequest(otherLease, "other-operation", estimate()); env.ledger.markDispatched(otherLease, other.request_id);
  env.ledger.gateRun(first.lease, "EXECUTION_TIMEOUT"); env.ledger.gateRun(otherLease, "EXECUTION_TIMEOUT");
  const a = env.ledger.recordRequestReceipt(first.request.request_id, { tokens: 1, cost_microusd: 1 }, {});
  const b = env.ledger.recordRequestReceipt(other.request_id, { tokens: 1, cost_microusd: 1 }, {});
  assert.equal(env.ledger.reconcileRequestUsage(first.request.request_id, a.receipt_sha256, "Checked first usage.", "first", { resume: true }).status, "gated");
  assert.equal(env.ledger.reconcileRequestUsage(other.request_id, b.receipt_sha256, "Checked second usage.", "second", { resume: true }).status, "queued");
  assert.equal(env.ledger.reconcileRequestUsage(first.request.request_id, a.receipt_sha256, "Checked first usage.", "first", { resume: true }).status, "queued");
  assert.equal(env.ledger.budget(scope().watch_id, "test-window").spent.requests, 2);
  assert.equal(env.ledger.workspaceStatus().runs.filter((run) => run.status === "queued").length, 2);
  env.ledger.verifyIntegrity(); env.ledger.close();
});
