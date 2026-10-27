import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { ResearchLedger, restoreResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { contentHash } from "../client/local/run-contract.mjs";
import { validateCaseRequest, validateCandidateRequest, validatePlanRequest, validateMethodArtifact } from "../client/local/method-artifacts.mjs";
import { setup, scope, policy, context, result, estimate, methodBundle } from "./fixtures/local-research.mjs";
import { configureEventWatch, intake, sourcePolicy } from "./fixtures/source-events.mjs";

const root = () => mkdtempSync(join(tmpdir(), "equitylayer-method-artifacts-"));
function environment(options = {}) {
  const directory = root(); const ledger = new ResearchLedger(directory, { clock: () => Date.parse("2026-10-12T00:00:00Z"), ...options });
  return { directory, ledger };
}
const request = (kind, id, caseId = "case-1") => ({ case_id: caseId, origin: { kind, id }, note: "Synthetic case for engineering tests.", author_id: "synthetic-owner" });
function gated(ledger) {
  const envelope = setup(ledger); ledger.enqueue(envelope, "test-window", policy());
  const lease = ledger.claim("synthetic-worker"); ledger.gateRun(lease, "SYNTHETIC_RESEARCH_GATE"); return envelope;
}
function changedBundle(version = "test-2") {
  const bundle = methodBundle(); bundle.version = version; bundle.profiles[0].version = "0.1.1"; bundle.profiles[0].checks.push("Check the synthetic counterexample.");
  const { content_sha256: ignoredProfile, ...profile } = bundle.profiles[0]; bundle.profiles[0].content_sha256 = contentHash(profile);
  const { content_sha256: ignoredBundle, ...content } = bundle; bundle.content_sha256 = contentHash(content); return bundle;
}
function candidate(ledger, captured, version = "test-2", id = "candidate-1") {
  return { candidate_id: id, bundle: changedBundle(version), parent_method_sha256: methodBundle().content_sha256,
    case_refs: [{ case_id: captured.record.request.case_id, case_sha256: captured.sha256 }], reason: "Synthetic candidate change.", author_id: "synthetic-author" };
}
function plan(captured) {
  return { plan_id: "plan-1", incumbent_method_sha256: methodBundle().content_sha256,
    case_refs: [{ case_id: captured.record.request.case_id, case_sha256: captured.sha256, partition: "regression" }],
    rubric: { version: "synthetic-rubric-1", criteria: [{ id: "source-support", description: "Synthetic expected source support.", critical: true, weight: 1 }],
      minimum_score_bps: 9000, critical_regression_veto: true, comparison_rule: "paired_incumbent_no_regression" },
    evaluation_at: "2026-10-12T00:00:00.000Z", repetitions: 2, runtime_policy_sha256: "a".repeat(64), author_id: "synthetic-evaluator" };
}

test("new storage has an empty method manifest and no active method release", () => {
  const env = environment(); assert.deepEqual(env.ledger.methodImprovementStatus(), { counts: { case: 0, candidate: 0, plan: 0 },
    release_gate: "HUMAN_METHOD_APPROVAL_REQUIRED", evaluation_status: "not_verified", active_method_changed: false });
  assert.equal(env.ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); env.ledger.close();
});
test("a gated run case retains original private scope, method pins, missing snapshot status, and no unseen claim", () => {
  const env = environment(); const envelope = gated(env.ledger); const before = env.ledger.workspaceStatus();
  const captured = env.ledger.captureMethodCase(request("run", envelope.run_id));
  assert.equal(captured.record.payload.classification, "regression"); assert.equal(captured.record.payload.curation_status, "founder_review_required");
  assert.deepEqual(captured.record.payload.private_context, context()); assert.deepEqual(captured.record.payload.envelope, envelope);
  assert.deepEqual(captured.record.payload.checkpoints, []); assert.equal(captured.record.payload.delivery, null);
  assert.match(captured.record.payload.retention_limits, /may be unavailable/);
  assert.deepEqual(env.ledger.workspaceStatus(), before); env.ledger.verifyIntegrity(); env.ledger.close();
  const reopened = new ResearchLedger(env.directory); assert.equal(reopened.methodArtifact(captured.artifact_id).sha256, captured.sha256); reopened.close();
});
test("exact case replay retains its first snapshot after run and watch state changes", () => {
  const env = environment(); const envelope = gated(env.ledger); const input = request("run", envelope.run_id);
  const first = env.ledger.captureMethodCase(input); env.ledger.saveRevision(scope(2), { question: "Changed synthetic question." });
  const replay = env.ledger.captureMethodCase(input); assert.equal(replay.reused, true); assert.equal(replay.sha256, first.sha256);
  assert.deepEqual(replay.record.payload.scope, scope()); assert.deepEqual(replay.record.payload.private_context, context());
  assert.throws(() => env.ledger.captureMethodCase({ ...input, note: "Different annotation." }), { code: "METHOD_ARTIFACT_CONFLICT" });
  env.ledger.verifyIntegrity(); env.ledger.close();
});
test("explicit rejection creates a case but does not replace earlier accepted evidence or interpretation", () => {
  const env = environment(); const envelope = setup(env.ledger); env.ledger.enqueue(envelope, "test-window", policy()); env.ledger.finish(env.ledger.claim("worker"), result(envelope));
  env.ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  env.ledger.review(envelope.delivery_id, "accept_evidence", "Synthetic evidence acceptance.", "a", 0);
  env.ledger.review(envelope.delivery_id, "accept_interpretation", "Synthetic interpretation acceptance.", "b", 1);
  env.ledger.review(envelope.delivery_id, "reject", "Synthetic recheck reason.", "c", 2);
  const before = env.ledger.watch(scope().watch_id); const captured = env.ledger.captureMethodCase(request("review", "c"));
  assert.equal(captured.record.payload.origin_record.action, "reject"); assert.equal(captured.record.payload.delivery.delivery_id, envelope.delivery_id);
  assert.deepEqual(env.ledger.watch(scope().watch_id), before);
  assert.throws(() => env.ledger.captureMethodCase(request("review", "a", "accepted-is-not-failure")), { code: "METHOD_ORIGIN_INVALID" });
  env.ledger.verifyIntegrity(); env.ledger.close();
});
test("source HOLD can form a local missing-evidence case without authorizing a request or changing rights", () => {
  const env = environment(); const method = configureEventWatch(env.ledger);
  env.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
  const decision = env.ledger.intakeSourceEvent(intake(method)); const id = `el-event-decision-${contentHash(decision.decision)}`;
  const before = env.ledger.workspaceStatus(); const captured = env.ledger.captureMethodCase(request("source_gate", id));
  assert.equal(captured.record.payload.envelope, null); assert.equal(captured.record.payload.origin_record.gate_code, "SOURCE_RIGHTS_HOLD");
  assert.equal(captured.record.payload.source_refs.length, 1); assert.deepEqual(env.ledger.workspaceStatus(), before);
  assert.equal(env.ledger.sourcePolicy(scope().watch_id, "synthetic-exchange").policy.rights_status, "HOLD");
  env.ledger.verifyIntegrity(); env.ledger.close();
});
test("unknown usage and late receipt capture remain historical accounting, not model quality proof", () => {
  const env = environment(); const envelope = setup(env.ledger); env.ledger.enqueue(envelope, "test-window", policy());
  const lease = env.ledger.claim("worker"); const reservation = env.ledger.reserveRequest(lease, "operation", estimate());
  env.ledger.markDispatched(lease, reservation.request_id); env.ledger.settleRequest(lease, reservation.request_id, null, { invalid: true });
  const captured = env.ledger.captureMethodCase(request("run", envelope.run_id)); assert.equal(captured.record.payload.requests[0].usage, null);
  assert.equal(captured.record.payload.requests[0].receipts[0].record.usage, null);
  env.ledger.recordRequestReceipt(reservation.request_id, { tokens: 1, cost_microusd: 1 }, { final: true });
  assert.equal(env.ledger.methodArtifact(captured.artifact_id).record.payload.requests[0].receipts.length, 1);
  env.ledger.verifyIntegrity(); env.ledger.close();
});
test("candidate metadata pins parent, rationale cases, content hash, full serialization hash, and curation", () => {
  const env = environment(); const envelope = gated(env.ledger); const captured = env.ledger.captureMethodCase(request("run", envelope.run_id));
  const input = candidate(env.ledger, captured); const before = env.ledger.workspaceStatus(); const saved = env.ledger.retainMethodCandidate(input);
  assert.equal(saved.record.payload.method_sha256, input.bundle.content_sha256); assert.equal(saved.record.payload.serialized_sha256, contentHash(input.bundle));
  assert.notEqual(saved.record.payload.method_sha256, saved.record.payload.serialized_sha256); assert.equal(saved.record.payload.release_status, "candidate");
  assert.equal(env.ledger.retainMethodCandidate(input).reused, true); assert.deepEqual(env.ledger.workspaceStatus(), before);
  assert.throws(() => env.ledger.retainMethodCandidate({ ...input, reason: "Changed rationale." }), { code: "METHOD_ARTIFACT_CONFLICT" });
  env.ledger.verifyIntegrity(); env.ledger.close();
});
test("candidate parent/version/reference errors do not create partial method artifacts", () => {
  const env = environment(); const envelope = gated(env.ledger); const captured = env.ledger.captureMethodCase(request("run", envelope.run_id)); const input = candidate(env.ledger, captured);
  for (const [changes, code] of [[{ parent_method_sha256: "b".repeat(64) }, "METHOD_PARENT_MISSING"], [{ bundle: changedBundle("test-1") }, "METHOD_VERSION_CONFLICT"],
    [{ case_refs: [{ case_id: "absent", case_sha256: captured.sha256 }] }, "METHOD_CASE_MISSING"]]) {
    assert.throws(() => env.ledger.retainMethodCandidate({ ...input, ...changes }), { code });
  }
  assert.equal(env.ledger.methodImprovementStatus().counts.candidate, 0); env.ledger.verifyIntegrity(); env.ledger.close();
});
test("changed evidence profile content needs a distinct version and candidate metadata still cannot approve it", () => {
  const env = environment(); const envelope = gated(env.ledger); const captured = env.ledger.captureMethodCase(request("run", envelope.run_id));
  const input = candidate(env.ledger, captured); input.bundle.profiles[0].version = "0.1.0";
  const { content_sha256: ignoredProfile, ...profile } = input.bundle.profiles[0]; input.bundle.profiles[0].content_sha256 = contentHash(profile);
  const { content_sha256: ignoredBundle, ...bundle } = input.bundle; input.bundle.content_sha256 = contentHash(bundle);
  assert.throws(() => env.ledger.retainMethodCandidate(input), { code: "METHOD_VERSION_CONFLICT" });
  assert.equal(env.ledger.methodImprovementStatus().counts.candidate, 0); env.ledger.close();
});
test("a frozen regression plan pins rubric, corpus, incumbent, time, repetition, and runtime without execution", () => {
  const env = environment(); const envelope = gated(env.ledger); const captured = env.ledger.captureMethodCase(request("run", envelope.run_id)); const input = plan(captured);
  const frozen = env.ledger.freezeMethodPlan(input);
  assert.equal(frozen.record.payload.rubric_sha256, contentHash(input.rubric)); assert.equal(frozen.record.payload.corpus_sha256, contentHash(input.case_refs));
  assert.equal(frozen.record.payload.evaluation_status, "not_executed"); assert.equal(frozen.record.payload.release_gate, "HUMAN_METHOD_APPROVAL_REQUIRED");
  assert.equal(env.ledger.freezeMethodPlan(input).reused, true);
  assert.throws(() => env.ledger.freezeMethodPlan({ ...input, repetitions: 3 }), { code: "METHOD_ARTIFACT_CONFLICT" });
  assert.equal(env.ledger.methodImprovementStatus().active_method_changed, false); env.ledger.verifyIntegrity(); env.ledger.close();
});
test("historical cases cannot be relabeled as holdouts or counted twice through separate annotations", () => {
  const env = environment(); const envelope = gated(env.ledger); const first = env.ledger.captureMethodCase(request("run", envelope.run_id));
  const second = env.ledger.captureMethodCase(request("run", envelope.run_id, "case-2")); const input = plan(first);
  assert.equal(first.record.payload.family_sha256, second.record.payload.family_sha256);
  assert.throws(() => env.ledger.freezeMethodPlan({ ...input, case_refs: [{ ...input.case_refs[0], partition: "holdout" }] }), { code: "METHOD_HOLDOUT_EXPOSED" });
  assert.throws(() => env.ledger.freezeMethodPlan({ ...input, case_refs: [...input.case_refs, { case_id: "case-2", case_sha256: second.sha256, partition: "regression" }] }), { code: "METHOD_CASE_DUPLICATE" });
  assert.equal(env.ledger.methodImprovementStatus().counts.plan, 0); env.ledger.close();
});
test("adopted workflow preserves historical D12 plan records without approving a method", () => {
  const env = environment(); const envelope = gated(env.ledger), captured = env.ledger.captureMethodCase(request("run", envelope.run_id));
  const frozen = env.ledger.freezeMethodPlan(plan(captured));
  const historical = JSON.parse(JSON.stringify(frozen.record)); historical.payload.release_gate = "D12_UNANSWERED";
  assert.deepEqual(validateMethodArtifact("plan", historical), historical);
  assert.equal(historical.payload.release_gate, "D12_UNANSWERED");
  assert.equal(env.ledger.methodImprovementStatus().release_gate, "HUMAN_METHOD_APPROVAL_REQUIRED");
  assert.equal(env.ledger.methodImprovementStatus().active_method_changed, false);
  assert.throws(() => validateMethodArtifact("plan", { ...historical, payload: { ...historical.payload, release_gate: "APPROVED" } }), { code: "METHOD_ARTIFACT_INVALID" });
  env.ledger.close();
});
test("plan input keeps critical veto, paired comparison, positive weights, real time, and strict fields", () => {
  const env = environment(); const envelope = gated(env.ledger); const captured = env.ledger.captureMethodCase(request("run", envelope.run_id)); const input = plan(captured);
  for (const changes of [{ promote: true }, { evaluation_at: "2026-02-30T00:00:00.000Z" }, { repetitions: 0 },
    { rubric: { ...input.rubric, critical_regression_veto: false } }, { rubric: { ...input.rubric, minimum_score_bps: 10001 } },
    { rubric: { ...input.rubric, criteria: [{ ...input.rubric.criteria[0], weight: 0 }] } }]) assert.throws(() => validatePlanRequest({ ...input, ...changes }), { code: "METHOD_INPUT_INVALID" });
  assert.throws(() => validateCaseRequest({ ...request("run", envelope.run_id), partition: "holdout" }), { code: "METHOD_INPUT_INVALID" });
  assert.throws(() => validateCandidateRequest({ ...candidate(env.ledger, captured), approved: true }), { code: "METHOD_INPUT_INVALID" }); env.ledger.close();
});
for (const point of ["before_commit", "after_commit"]) test(`method case recovers ${point} failure without duplicate history`, () => {
  const env = environment({ fault: label => { if (label === `method_case:${point}`) throw Error("Synthetic storage interruption."); } });
  const envelope = gated(env.ledger), input = request("run", envelope.run_id);
  assert.throws(() => env.ledger.captureMethodCase(input), { code: "STORAGE_WRITE_UNCERTAIN" }); env.ledger.close();
  const reopened = new ResearchLedger(env.directory); const saved = reopened.captureMethodCase(input);
  assert.equal(saved.reused, point === "after_commit"); assert.equal(reopened.methodImprovementStatus().counts.case, 1); reopened.verifyIntegrity(); reopened.close();
});
test("complete method history remains paginated past 31 records", () => {
  const env = environment(); const envelope = gated(env.ledger);
  for (let n = 0; n < 42; n++) env.ledger.captureMethodCase(request("run", envelope.run_id, `case-${n}`));
  const a = env.ledger.methodArtifacts({ limit: 21 }); const b = env.ledger.methodArtifacts({ after: a.at(-1).sequence, limit: 21 });
  assert.equal(a.length + b.length, 42); assert.equal(env.ledger.methodImprovementStatus().counts.case, 42); env.ledger.verifyIntegrity(); env.ledger.close();
});
test("schema-four migration backs up before adding method records and preserves prior research state", () => {
  const env = environment(); const envelope = gated(env.ledger); const before = env.ledger.workspaceStatus(); env.ledger.close();
  const db = new DatabaseSync(join(env.directory, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers;");
  db.exec("DROP TABLE thesis_reviews; DROP TABLE thesis_proposals; DROP TABLE thesis_heads; DROP TABLE thesis_manifest;");
  db.exec("DROP TABLE schedule_run_leases; DROP TABLE schedule_ticks; DROP TABLE schedule_state; DROP TABLE schedule_configs; DROP TABLE method_trial_outputs; DROP TABLE method_trial_manifest; DROP TABLE method_trial_pairs; DROP TABLE method_artifact_manifest; DROP TABLE method_artifacts; PRAGMA user_version=4;"); db.close();
  const upgraded = new ResearchLedger(env.directory); assert.equal(upgraded.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); assert.deepEqual(upgraded.workspaceStatus(), before);
  assert.ok(readdirSync(env.directory).some(name => name.startsWith("before-schema-5-")));
  upgraded.captureMethodCase(request("run", envelope.run_id)); const backup = upgraded.backup("method-backup.sqlite"); upgraded.close();
  const restored = restoreResearchLedger(backup, join(env.directory, "restored")); assert.equal(restored.methodImprovementStatus().counts.case, 1); restored.verifyIntegrity(); restored.close();
});
for (const sql of ["DELETE FROM method_artifacts", "UPDATE method_artifacts SET record_json='{}'", "DELETE FROM method_artifact_manifest", "UPDATE method_artifact_manifest SET sha256='changed'"]) {
  test(`method integrity rejects retained changes: ${sql}`, () => {
    const env = environment(); const envelope = gated(env.ledger); env.ledger.captureMethodCase(request("run", envelope.run_id)); env.ledger.close();
    const db = new DatabaseSync(join(env.directory, "research.sqlite")); db.exec(sql); db.close();
    assert.throws(() => new ResearchLedger(env.directory), { code: "STORAGE_CORRUPT" });
  });
}
test("concurrent schema-four startup completes one upgrade without replacing research state", async () => {
  const env = environment(); gated(env.ledger); env.ledger.close();
  const db = new DatabaseSync(join(env.directory, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers;");
  db.exec("DROP TABLE thesis_reviews; DROP TABLE thesis_proposals; DROP TABLE thesis_heads; DROP TABLE thesis_manifest;");
  db.exec("DROP TABLE schedule_run_leases; DROP TABLE schedule_ticks; DROP TABLE schedule_state; DROP TABLE schedule_configs; DROP TABLE method_trial_outputs; DROP TABLE method_trial_manifest; DROP TABLE method_trial_pairs; DROP TABLE method_artifact_manifest; DROP TABLE method_artifacts; PRAGMA user_version=4;"); db.close();
  const code = `import {ResearchLedger} from './client/local/ledger.mjs'; const ledger=new ResearchLedger(process.argv[1]); ledger.verifyIntegrity(); ledger.close();`;
  const outcomes = await Promise.all(Array.from({ length: 3 }, () => new Promise(resolve => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code, env.directory]); let error = "";
    process.stderr.on("data", data => { error += data; }); process.on("close", exit => resolve({ exit, error }));
  })));
  outcomes.forEach(outcome => assert.equal(outcome.exit, 0, outcome.error)); const reopened = new ResearchLedger(env.directory); assert.equal(reopened.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); reopened.close();
});
