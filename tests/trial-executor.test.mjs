import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { ResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { executeClaimedMethodTrial, executeClaimedRun } from "../client/local/executor.mjs";
import { contentHash, canonicalJson } from "../client/local/run-contract.mjs";
import { trialFixture, trialOptions, trialRuntime } from "./fixtures/method-trials.mjs";
import { scope, context, setup, policy } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";

const claim = (env, role = "incumbent") => env.ledger.claimMethodTrial(env.pair[`${role}_run_id`], "synthetic-trial-worker", 1000);
const execute = (env, lease = claim(env), engine = trialRuntime(env), changes = {}) =>
  executeClaimedMethodTrial(env.ledger, lease, engine, { ...trialOptions(env), ...changes });

test("a retained pair completes two roles without research delivery or baseline mutation", async t => {
  const env = trialFixture(); t.after(() => env.ledger.close());
  const before = env.ledger.watch(scope().watch_id), cursor = env.ledger.cursors(scope().watch_id);
  let seen = [];
  for (const role of ["incumbent", "candidate"]) {
    const base = trialRuntime(env);
    const response = await execute(env, claim(env, role), trialRuntime(env, async input => { seen.push(input.research_context); return base.execute(); }));
    assert.equal(response.status, "completed"); assert.ok(response.trial_output); assert.equal(response.delivery, undefined);
  }
  const { method_bundle: a, envelope: ae, ...ai } = seen[0], { method_bundle: b, envelope: be, ...bi } = seen[1];
  assert.deepEqual(ai, bi); assert.notEqual(a.content_sha256, b.content_sha256); assert.notEqual(ae.run_id, be.run_id);
  assert.equal(env.ledger.methodTrialPair(env.pair.pair_id).outputs.length, 2);
  assert.equal(env.ledger.inbox().length, 0); assert.deepEqual(env.ledger.watch(scope().watch_id), before);
  assert.deepEqual(env.ledger.cursors(scope().watch_id), cursor);
  assert.equal(env.ledger.notices().filter(n => n.payload.kind === "research_review").length, 0);
  assert.equal(env.ledger.budget(scope().watch_id, "method-trial:test").spent.requests, 2);
  assert.equal(env.ledger.budget(scope().watch_id, "event-window").spent.requests, 0);
  env.ledger.verifyIntegrity();
});
test("enqueue is idempotent and ordinary claims cannot acquire paired roles", t => {
  const env = trialFixture(); t.after(() => env.ledger.close()); const before = env.ledger.workspaceStatus();
  assert.equal(env.ledger.enqueueMethodTrialPair(env.request).reused, true); assert.deepEqual(env.ledger.workspaceStatus(), before);
  assert.equal(env.ledger.claim("research-worker"), null);
  assert.throws(() => env.ledger.enqueueMethodTrialPair({ ...env.request, repetition: 3 }), { code: "METHOD_TRIAL_PLAN_CONFLICT" });
  assert.throws(() => env.ledger.enqueueMethodTrialPair({ ...env.request, runtime_policy: { ...env.runtimePolicy, runtime: { ...env.runtimePolicy.runtime, identity: "other" } } }), { code: "METHOD_TRIAL_PLAN_CONFLICT" });
  assert.deepEqual(env.ledger.workspaceStatus(), before);
});
test("ordinary executor, context and finish cannot process a paired role", async t => {
  const env = trialFixture(); t.after(() => env.ledger.close()); const lease = claim(env); let calls = 0;
  assert.equal((await executeClaimedRun(env.ledger, lease, trialRuntime(env, () => { calls++; }), trialOptions(env))).code, "METHOD_TRIAL_EXECUTOR_REQUIRED");
  assert.throws(() => env.ledger.executionContext(lease), { code: "METHOD_TRIAL_CONTEXT_REQUIRED" });
  assert.throws(() => env.ledger.finish(lease, {}), { code: "METHOD_TRIAL_FINISH_REQUIRED" }); assert.equal(calls, 0);
});
for (const secondConnection of [false, true]) test(`a changed second controller cannot gate an active dispatch: second connection ${secondConnection}`, async t => {
  const env = trialFixture(); t.after(() => env.ledger.close()); const lease = claim(env), base = trialRuntime(env);
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const first = execute(env, lease, trialRuntime(env, async () => { entered(); await pending; return base.execute(); }));
  await started;
  const other = secondConnection ? new ResearchLedger(env.directory, { clock: env.clock }) : env.ledger;
  if (secondConnection) t.after(() => other.close());
  for (const changes of [{ allow_method_trial: false }, { runtime_policy: { ...env.runtimePolicy, runtime: { ...env.runtimePolicy.runtime, identity: "changed" } } }]) {
    assert.equal((await executeClaimedMethodTrial(other, lease, base, { ...trialOptions(env), ...changes })).status, "busy");
  }
  assert.equal(env.ledger.run(lease.run_id).status, "running"); assert.equal(env.ledger.requests(lease.run_id)[0].status, "dispatched");
  release(); assert.equal((await first).status, "completed");
});
for (const [changes, code] of [[{ allow_method_trial: false }, "METHOD_TRIAL_CONSENT_REQUIRED"], [{ allow_private_context: false }, "PRIVATE_CONTEXT_CONSENT_REQUIRED"],
  [{ allow_candidate_method: false }, "METHOD_CONSENT_REQUIRED"], [{ timeout_ms: 101 }, "TRIAL_POLICY_INVALID"]]) {
  test(`trial consent and policy gate: ${code}`, async t => {
    const env = trialFixture(); t.after(() => env.ledger.close()); let calls = 0;
    const response = await execute(env, claim(env), trialRuntime(env, () => { calls++; }), changes);
    assert.equal(response.code, code); assert.equal(calls, 0); assert.equal(env.ledger.requests(env.pair.incumbent_run_id).length, 0);
  });
}
test("real-time source HOLD gates a retained pair before model dispatch", async t => {
  const env = trialFixture({ allow: false }); t.after(() => env.ledger.close()); let calls = 0;
  assert.equal((await execute(env, claim(env), trialRuntime(env, () => { calls++; }))).code, "SOURCE_RIGHTS_GATED");
  assert.equal(calls, 0); assert.equal(env.ledger.methodTrialPair(env.pair.pair_id).outputs.length, 0);
});
for (const change of [{ issuer_map: { LITE: "other-issuer" } }, { metric_definition_ids: ["different-metric"] }, { allowed_evidence_states: ["PROVISIONAL"] }]) {
  test(`current fact permission prevents trial dispatch: ${Object.keys(change)[0]}`, async t => {
    const env = trialFixture(); t.after(() => env.ledger.close());
    env.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(4), ...change });
    const pair = env.ledger.enqueueMethodTrialPair({ ...env.request, repetition: 2 }); let calls = 0;
    const lease = env.ledger.claimMethodTrial(pair.incumbent_run_id, "worker", 1000);
    assert.equal((await execute(env, lease, trialRuntime(env, () => { calls++; }))).code, "SOURCE_POLICY_CHANGED");
    assert.equal(calls, 0); assert.equal(env.ledger.requests(lease.run_id).length, 0);
  });
}
test("a resolved source gate requires an explicit immutable resume decision", async t => {
  const env = trialFixture({ allow: false }); t.after(() => env.ledger.close());
  assert.equal((await execute(env)).code, "SOURCE_RIGHTS_GATED");
  const request = { run_id: env.pair.incumbent_run_id, decision_id: "resume-1", reason: "Synthetic source policy reviewed." };
  assert.throws(() => env.ledger.resumeMethodTrial(request), { code: "SOURCE_RIGHTS_GATED" });
  env.ledger.configureSourcePolicy(scope().watch_id, sourcePolicy(3)); assert.equal(claim(env), null);
  assert.equal(env.ledger.resumeMethodTrial(request).status, "queued"); assert.equal(env.ledger.resumeMethodTrial(request).reused, true);
  assert.throws(() => env.ledger.resumeMethodTrial({ ...request, reason: "Changed decision." }), { code: "METHOD_TRIAL_RESUME_CONFLICT" });
  assert.equal((await execute(env)).status, "completed"); env.ledger.verifyIntegrity();
});
test("explicit trial resume cannot erase unknown usage or extend a deadline", async t => {
  const env = trialFixture(); t.after(() => env.ledger.close()); const base = trialRuntime(env), raw = await base.execute(); raw.usage = null;
  await execute(env, claim(env), trialRuntime(env, async () => raw));
  const request = { run_id: env.pair.incumbent_run_id, decision_id: "not-an-accounting-approval", reason: "Synthetic retry request." };
  assert.throws(() => env.ledger.resumeMethodTrial(request), { code: "METHOD_TRIAL_RESUME_GATED" });
  const other = trialFixture({ allow: false }); t.after(() => other.ledger.close()); await execute(other); other.ledger.configureSourcePolicy(scope().watch_id, sourcePolicy(3));
  other.setNow(other.clock() + 100001);
  assert.throws(() => other.ledger.resumeMethodTrial({ ...request, run_id: other.pair.incumbent_run_id }), { code: "DEADLINE_EXCEEDED" });
});
for (const rehash of [false, true]) test(`active trial resume detects changed retained decision: rehash ${rehash}`, t => {
  const env = trialFixture(); t.after(() => env.ledger.close());
  const request = { run_id: env.pair.incumbent_run_id, decision_id: "resume-integrity", reason: "Original synthetic reason." };
  env.ledger.gateRun(claim(env), "METHOD_TRIAL_CONSENT_REQUIRED"); env.ledger.resumeMethodTrial(request);
  const db = new DatabaseSync(join(env.directory, "research.sqlite"));
  const row = db.prepare("SELECT payload_json FROM checkpoints WHERE run_id=? AND checkpoint_key=?").get(request.run_id, "trial-resume:resume-integrity");
  const record = JSON.parse(row.payload_json); record.request.reason = "Changed synthetic reason.";
  if (rehash) db.prepare("UPDATE checkpoints SET payload_json=?,sha256=? WHERE run_id=? AND checkpoint_key=?").run(canonicalJson(record), contentHash(record), request.run_id, "trial-resume:resume-integrity");
  else db.prepare("UPDATE checkpoints SET payload_json=? WHERE run_id=? AND checkpoint_key=?").run(canonicalJson(record), request.run_id, "trial-resume:resume-integrity");
  db.close(); assert.throws(() => env.ledger.resumeMethodTrial(request), error => ["STORAGE_CORRUPT", "METHOD_TRIAL_INVALID"].includes(error.code));
  assert.throws(() => env.ledger.verifyIntegrity(), { code: "STORAGE_CORRUPT" });
});
test("current source rights are checked again at the dispatch transaction", t => {
  const env = trialFixture(); t.after(() => env.ledger.close()); const lease = claim(env);
  env.ledger.methodTrialExecutionContext(lease); const request = env.ledger.reserveRequest(lease, "synthetic-operation", env.runtimePolicy.execution.estimate);
  const other = new ResearchLedger(env.directory, { clock: env.clock });
  other.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(4), rights_status: "HOLD" }); other.close();
  assert.throws(() => env.ledger.markDispatched(lease, request.request_id), { code: "LEASE_LOST" });
  assert.equal(env.ledger.requests(lease.run_id)[0].dispatched_at, null);
});
test("historical pair survives a new watch revision and preserves original input", async t => {
  const env = trialFixture(); t.after(() => env.ledger.close());
  env.ledger.saveRevision(scope(2), { ...context(), question: "Changed current thesis." });
  let input; const base = trialRuntime(env);
  assert.equal((await execute(env, claim(env), trialRuntime(env, async value => { input = value; return base.execute(); }))).status, "completed");
  assert.equal(input.research_context.envelope.scope.revision, 1); assert.deepEqual(input.research_context.private_context, context());
  assert.equal(env.ledger.watch(scope().watch_id).current_revision, 2); env.ledger.verifyIntegrity();
});
test("expired trial leases use only the dedicated reaper and reject stale completion", t => {
  const env = trialFixture(); t.after(() => env.ledger.close()); const old = claim(env);
  env.setNow(env.clock() + 1100); assert.equal(env.ledger.claim("research-worker"), null);
  assert.equal(env.ledger.run(old.run_id).status, "running"); const next = claim(env); assert.equal(next.fence, old.fence + 1);
  assert.throws(() => env.ledger.methodTrialExecutionContext(old), { code: "LEASE_LOST" });
});
test("restart reuses a settled trial response without another dispatch", async t => {
  let failOnce = true;
  const env = trialFixture({ fault: label => { if (label === "finish_method_trial:before_commit" && failOnce) { failOnce = false; throw Error("Synthetic completion interruption."); } } });
  const lease = claim(env); let calls = 0; const base = trialRuntime(env);
  await execute(env, lease, trialRuntime(env, async () => { calls++; return base.execute(); }));
  // A storage failure after settlement is a gate. A crash before completion leaves a running lease.
  const db = new DatabaseSync(join(env.directory, "research.sqlite")); db.prepare("UPDATE runs SET status='running',owner=?,fence=?,lease_until=? WHERE run_id=?")
    .run(lease.owner, lease.fence, lease.lease_until, lease.run_id); db.close(); env.ledger.close(); env.setNow(env.clock() + 1100);
  const reopened = new ResearchLedger(env.directory, { clock: env.clock }); t.after(() => reopened.close());
  const fresh = reopened.claimMethodTrial(lease.run_id, "restarted-worker", 1000);
  const response = await executeClaimedMethodTrial(reopened, fresh, trialRuntime(env, () => { calls++; }), trialOptions(env));
  assert.equal(response.status, "completed"); assert.equal(calls, 1); assert.equal(reopened.requests(lease.run_id).length, 1);
  assert.equal(reopened.inbox().length, 0); reopened.verifyIntegrity();
});
test("unknown trial usage stays held and explicit reconciliation resumes a historical role", async t => {
  const env = trialFixture(); t.after(() => env.ledger.close()); const lease = claim(env), base = trialRuntime(env);
  const raw = await base.execute(); raw.usage = null;
  assert.equal((await execute(env, lease, trialRuntime(env, async () => raw))).code, "USAGE_UNKNOWN");
  env.ledger.saveRevision(scope(2), { question: "New thesis." });
  const request = env.ledger.requests(lease.run_id)[0];
  const receipt = env.ledger.recordRequestReceipt(request.request_id, { tokens: 10, cost_microusd: 20 }, { ...raw, usage: { tokens: 10, cost_microusd: 20 } });
  assert.equal(env.ledger.reconcileRequestUsage(request.request_id, receipt.receipt_sha256, "Synthetic measured receipt.", "trial-resume", { resume: true }).status, "queued");
  let calls = 0; assert.equal((await execute(env, claim(env), trialRuntime(env, () => { calls++; }))).status, "completed");
  assert.equal(calls, 0); assert.equal(env.ledger.budget(scope().watch_id, "method-trial:test").spent.requests, 1); env.ledger.verifyIntegrity();
});
test("schema five upgrades with a private backup and retains method artifacts", t => {
  const env = trialFixture(); env.ledger.close();
  const db = new DatabaseSync(join(env.directory, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers;");
  db.exec("DROP TABLE thesis_reviews; DROP TABLE thesis_proposals; DROP TABLE thesis_heads; DROP TABLE thesis_manifest;");
  db.exec("DROP TABLE schedule_run_leases; DROP TABLE schedule_ticks; DROP TABLE schedule_state; DROP TABLE schedule_configs;");
  db.exec("DELETE FROM method_trial_pairs; DELETE FROM runs WHERE json_extract(envelope_json,'$.trial') IS NOT NULL; DROP TABLE method_trial_outputs; DROP TABLE method_trial_manifest; DROP TABLE method_trial_pairs; PRAGMA user_version=5;"); db.close();
  const upgraded = new ResearchLedger(env.directory, { clock: env.clock }); t.after(() => upgraded.close());
  assert.equal(upgraded.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); assert.equal(upgraded.methodImprovementStatus().counts.case, 1);
  assert.ok(readdirSync(env.directory).some(name => name.startsWith("before-schema-6-"))); assert.equal(upgraded.enqueueMethodTrialPair(env.request).reused, false);
});
for (const sql of ["DELETE FROM method_trial_manifest", "DELETE FROM method_trial_pairs", "UPDATE method_trial_pairs SET record_json='{}'"]) {
  test(`trial integrity rejects missing or changed pair content: ${sql}`, () => {
    const env = trialFixture(); env.ledger.close(); const db = new DatabaseSync(join(env.directory, "research.sqlite")); db.exec(sql); db.close();
    assert.throws(() => new ResearchLedger(env.directory), { code: "STORAGE_CORRUPT" });
  });
}
test("a case without its original execution snapshot cannot silently use current broad facts", t => {
  const env = trialFixture(); t.after(() => env.ledger.close());
  const envelope = setup(env.ledger, 2, 1); env.ledger.enqueue(envelope, "test-window", policy()); env.ledger.gateRun(env.ledger.claim("research"), "SYNTHETIC_GATE");
  const captured = env.ledger.captureMethodCase({ case_id: "missing-snapshot", origin: { kind: "run", id: envelope.run_id }, note: "No original snapshot.", author_id: "owner" });
  const plan = env.ledger.methodArtifact("plan:synthetic-plan").record.request;
  env.ledger.freezeMethodPlan({ ...plan, plan_id: "missing-snapshot-plan", case_refs: [{ case_id: "missing-snapshot", case_sha256: captured.sha256, partition: "regression" }] });
  assert.throws(() => env.ledger.enqueueMethodTrialPair({ ...env.request, plan_id: "missing-snapshot-plan", case_id: "missing-snapshot" }), { code: "METHOD_CASE_INPUT_MISSING" });
});
