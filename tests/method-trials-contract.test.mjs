import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, contentHash } from "../client/local/run-contract.mjs";
import { METHOD_TRIAL_SCHEMA, validateTrialPairRequest, verifyMethodTrials } from "../client/local/method-trials.mjs";
import { validateTrialRuntimePolicy } from "../client/local/trial-policy.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { executeClaimedMethodTrial } from "../client/local/executor.mjs";
import { setup, scope, context, policy, limits, methodBundle, result } from "./fixtures/local-research.mjs";
import { sourcePolicy, configureEventWatch, intake } from "./fixtures/source-events.mjs";

const evaluationAt = "2026-10-12T00:00:00.000Z";
const runtimePolicy = () => ({ schema_version: 1, runtime: { identity: "synthetic-trial", config_sha256: "a".repeat(64) },
  execution: { estimate: { tokens: 100, cost_microusd: 100, wall_ms: 3000 }, timeout_ms: 3000,
    lease_ms: 9000, heartbeat_ms: 2000, retry_delay_ms: 100 } });
const pairRequest = () => ({ plan_id: "plan-1", case_id: "case-1", candidate_id: "candidate-1", repetition: 1,
  runtime_policy: runtimePolicy(), budget_window: "method-trial:synthetic", run_policy: policy() });
function changedBundle() {
  const bundle = methodBundle(); bundle.version = "test-2"; bundle.profiles[0].version = "0.1.1";
  bundle.profiles[0].checks.push("Check the synthetic counterexample.");
  const { content_sha256: ignoredProfile, ...profile } = bundle.profiles[0];
  bundle.profiles[0].content_sha256 = contentHash(profile);
  const { content_sha256: ignoredBundle, ...body } = bundle;
  bundle.content_sha256 = contentHash(body); return bundle;
}
function environment(t, { sourceGate = false, legacy = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "equitylayer-method-trial-contract-"));
  const ledger = new ResearchLedger(directory, { clock: () => Date.parse(evaluationAt) });
  t.after(() => ledger.close());
  let original, captured;
  if (sourceGate) {
    const method = configureEventWatch(ledger);
    ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
    const decision = ledger.intakeSourceEvent(intake(method));
    captured = ledger.captureMethodCase({ case_id: "case-1", origin: { kind: "source_gate", id: `el-event-decision-${contentHash(decision.decision)}` },
      note: "Synthetic source gate with exact fact references.", author_id: "synthetic-author" });
  } else {
    original = setup(ledger); ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
    ledger.enqueue(original, "test-window", policy());
    const lease = ledger.claim("synthetic-capture");
    if (legacy) {
      const retained = ledger.source(original.source_refs[0].source_event_id);
      ledger.checkpoint(lease, "execution-context:v1", { schema_version: 1, envelope: original,
        private_context: context(), method_bundle: methodBundle(),
        sources: [{ reference: original.source_refs[0], event: retained.event, artifact: retained.artifact,
          facts: ledger.sourceFacts(original.source_refs[0].source_event_id) }], baseline_context: [], created_at: evaluationAt });
    } else ledger.executionContext(lease);
    ledger.gateRun(lease, "SYNTHETIC_CASE");
    captured = ledger.captureMethodCase({ case_id: "case-1", origin: { kind: "run", id: original.run_id },
      note: "Synthetic retained input for contract tests.", author_id: "synthetic-author" });
  }
  ledger.retainMethodCandidate({ candidate_id: "candidate-1", bundle: changedBundle(), parent_method_sha256: captured.record.payload.method_sha256,
    case_refs: [{ case_id: "case-1", case_sha256: captured.sha256 }], reason: "Synthetic correction.", author_id: "synthetic-author" });
  ledger.freezeMethodPlan({ plan_id: "plan-1", incumbent_method_sha256: captured.record.payload.method_sha256,
    case_refs: [{ case_id: "case-1", case_sha256: captured.sha256, partition: "regression" }],
    rubric: { version: "synthetic-1", criteria: [{ id: "source-support", description: "Check synthetic source support.", critical: true, weight: 1 }],
      minimum_score_bps: 9000, critical_regression_veto: true, comparison_rule: "paired_incumbent_no_regression" },
    evaluation_at: evaluationAt, repetitions: 2, runtime_policy_sha256: validateTrialRuntimePolicy(runtimePolicy()).sha256,
    author_id: "synthetic-evaluator" });
  ledger.configureBudget(scope().watch_id, pairRequest().budget_window, limits());
  const before = { cursors: ledger.cursors(scope().watch_id), watch: ledger.watch(scope().watch_id) };
  const pair = ledger.enqueueMethodTrialPair(pairRequest());
  const db = new DatabaseSync(ledger.path); t.after(() => db.close());
  return { ledger, db, pair, before, original };
}
function updateManifest(db) {
  const pairs = db.prepare("SELECT pair_id,sha256,incumbent_run_id,candidate_run_id FROM method_trial_pairs ORDER BY pair_id").all().map(row => ({ ...row }));
  db.prepare("UPDATE method_trial_manifest SET sha256=? WHERE singleton=1").run(contentHash(pairs));
}
function rewritePair(env, mutate) {
  const row = env.db.prepare("SELECT record_json FROM method_trial_pairs WHERE pair_id=?").get(env.pair.pair_id);
  const record = JSON.parse(row.record_json); mutate(record);
  env.db.prepare("UPDATE method_trial_pairs SET sha256=?,record_json=? WHERE pair_id=?").run(contentHash(record), canonicalJson(record), env.pair.pair_id);
  updateManifest(env.db);
}
async function complete(env, role = "candidate") {
  const runId = env.pair[`${role}_run_id`], lease = env.ledger.claimMethodTrial(runId, "synthetic-trial", 9000);
  const declared = runtimePolicy(), template = result(lease.envelope);
  const runtime = { ...declared.runtime, async execute() {
    const { result_state, summary, sources, drivers, falsifiers, unknowns } = template;
    return { agent_fields: { result_state, summary, sources, drivers, falsifiers, unknowns, next_check_at: "2026-10-13T00:00:00.000Z" },
      usage: { tokens: 1, cost_microusd: 1 } };
  } };
  return executeClaimedMethodTrial(env.ledger, lease, runtime, { allow_method_trial: true, allow_private_context: true,
    allow_candidate_method: true, runtime_policy: declared, ...declared.execution, clock: () => Date.parse(evaluationAt) });
}

test("pair requests retain detached canonical runtime and run limits", () => {
  const input = pairRequest(), parsed = validateTrialPairRequest(input);
  assert.deepEqual(parsed, input); input.runtime_policy.execution.estimate.tokens = 999;
  assert.equal(parsed.runtime_policy.execution.estimate.tokens, 100);
});
for (const budget_window of ["test-window", "method-trial:", "method-trialish:synthetic"]) {
  test(`pair requests reject the budget window ${budget_window}`, () => {
    assert.throws(() => validateTrialPairRequest({ ...pairRequest(), budget_window }), { code: "METHOD_INPUT_INVALID" });
  });
}
test("pair requests reject missing and extra fields", () => {
  const { candidate_id: ignored, ...missing } = pairRequest();
  assert.throws(() => validateTrialPairRequest(missing), { code: "METHOD_INPUT_INVALID" });
  assert.throws(() => validateTrialPairRequest({ ...pairRequest(), approved: true }), { code: "METHOD_INPUT_INVALID" });
  assert.throws(() => validateTrialPairRequest({ ...pairRequest(), run_policy: { ...policy(), override: true } }), { code: "METHOD_INPUT_INVALID" });
});
test("pair requests bound repetition, attempts, wall time, and scheduling time", () => {
  for (const repetition of [0, 11, 1.5]) assert.throws(() => validateTrialPairRequest({ ...pairRequest(), repetition }), { code: "METHOD_INPUT_INVALID" });
  for (const changed of [{ max_attempts: 0 }, { max_attempts: 11 }, { max_wall_ms: 0 }, { max_wall_ms: 3_600_001 }, { not_before: -1 }, { not_before: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => validateTrialPairRequest({ ...pairRequest(), run_policy: { ...policy(), ...changed } }), { code: "METHOD_INPUT_INVALID" });
  }
  assert.throws(() => validateTrialPairRequest({ ...pairRequest(), run_policy: { ...policy(), max_wall_ms: 2999 } }), { code: "METHOD_INPUT_INVALID" });
});
test("schema six creates an empty manifest and constrained role references", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE runs(run_id TEXT PRIMARY KEY) STRICT;"); db.exec(METHOD_TRIAL_SCHEMA);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
  assert.equal(db.prepare("SELECT sha256 FROM method_trial_manifest").get().sha256, contentHash([]));
  assert.throws(() => db.prepare("INSERT INTO method_trial_pairs VALUES(?,?,?,?,?)").run("pair", "hash", "{}", "missing-a", "missing-b"));
});
test("two retained trial roles use one exact input without changing research state", t => {
  const env = environment(t), retained = env.ledger.methodTrialPair(env.pair.pair_id);
  assert.equal(retained.incumbent.envelope.trial.role, "incumbent"); assert.equal(retained.candidate.envelope.trial.role, "candidate");
  assert.equal(retained.record.input_sha256, contentHash(JSON.parse(retained.record.input_json)));
  assert.deepEqual(env.ledger.cursors(scope().watch_id), env.before.cursors);
  assert.deepEqual(env.ledger.watch(scope().watch_id), env.before.watch);
  assert.equal(env.ledger.claim("research-worker"), null); assert.doesNotThrow(() => verifyMethodTrials(env.db));
  assert.equal(env.ledger.enqueueMethodTrialPair(pairRequest()).reused, true);
});
for (const legacy of [false, true]) test(`paired replay preserves the original v${legacy ? 1 : 2} source content after restart`, t => {
  const env = environment(t, { legacy });
  const captured = env.ledger.methodArtifact("case:case-1").record;
  const original = captured.payload.checkpoints.find(item => item.key === `execution-context:v${legacy ? 1 : 2}`).payload;
  const base = JSON.parse(env.ledger.methodTrialPair(env.pair.pair_id).record.input_json);
  assert.deepEqual(base.sources, original.sources);
  assert.equal(Object.hasOwn(base.sources[0], "source_content"), !legacy);
  if (!legacy) assert.equal(base.sources[0].source_content.coverage, "complete_retained_artifact");
  const reopened = new ResearchLedger(dirname(env.ledger.path), { clock: () => Date.parse(evaluationAt) });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.methodTrialPair(env.pair.pair_id).record.input_json, canonicalJson(base));
  reopened.verifyIntegrity();
});
test("a rehashed trial cannot replace original retained text", t => {
  const env = environment(t);
  rewritePair(env, record => {
    const base = JSON.parse(record.input_json); base.sources[0].source_content.text = "Replacement content";
    record.input_json = canonicalJson(base); record.input_sha256 = contentHash(base);
  });
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
});
test("source-gate input retains exact original fact references while HOLD prevents execution", t => {
  const env = environment(t, { sourceGate: true }), retained = env.ledger.methodTrialPair(env.pair.pair_id);
  const base = JSON.parse(retained.record.input_json), captured = env.ledger.methodArtifact("case:case-1").record;
  const refs = base.sources.flatMap(source => source.facts.map(fact => ({ source_event_id: fact.source_event_id,
    fact_key: fact.fact_key, sha256: contentHash(fact) })));
  assert.deepEqual(refs, captured.payload.origin_record.fact_refs);
  assert.doesNotThrow(() => verifyMethodTrials(env.db));
  const lease = env.ledger.claimMethodTrial(env.pair.candidate_run_id, "synthetic-held", 9000);
  assert.throws(() => env.ledger.methodTrialExecutionContext(lease), { code: "SOURCE_RIGHTS_GATED" });
  assert.equal(env.ledger.requests(env.pair.candidate_run_id).length, 0);
  assert.deepEqual(env.ledger.cursors(scope().watch_id), env.before.cursors);
});
test("integrity rejects a changed manifest", t => {
  const env = environment(t); env.db.prepare("UPDATE method_trial_manifest SET sha256=?").run("f".repeat(64));
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
});
test("integrity rejects an orphan trial after pair deletion", t => {
  const env = environment(t); env.db.prepare("DELETE FROM method_trial_pairs").run(); updateManifest(env.db);
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
});
test("integrity rejects a historical input replacement after hashes change", t => {
  const env = environment(t);
  rewritePair(env, record => {
    const base = JSON.parse(record.input_json); base.private_context.question = "Changed synthetic input.";
    record.input_json = canonicalJson(base); record.input_sha256 = contentHash(base);
  });
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
});
test("integrity rejects an output inserted for a research run", t => {
  const env = environment(t), output = result(env.original);
  env.db.prepare("INSERT INTO method_trial_outputs VALUES(?,?,?,?)").run(env.original.run_id, contentHash(output), canonicalJson(output), Date.parse(evaluationAt));
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
});
test("integrity rejects a trial delivery and an event job", t => {
  const env = environment(t), candidate = env.ledger.run(env.pair.candidate_run_id), output = result(candidate.envelope);
  env.db.prepare("INSERT INTO deliveries(delivery_id,run_id,sha256,result_json,created_at) VALUES(?,?,?,?,?)").run(candidate.envelope.delivery_id, candidate.run_id, contentHash(output), canonicalJson(output), Date.parse(evaluationAt));
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
  env.db.prepare("DELETE FROM deliveries WHERE run_id=?").run(candidate.run_id);
  env.db.prepare("INSERT INTO event_decisions VALUES(?,?,?,?,?,?,?,?,?)").run("synthetic-illegal-decision", "synthetic-illegal-job",
    candidate.watch_id, candidate.revision, candidate.envelope.source_refs[0].source_event_id,
    candidate.envelope.method.bundle_sha256, contentHash({}), canonicalJson({}), candidate.run_id);
  env.db.prepare("INSERT INTO event_jobs VALUES(?,?,?)").run("synthetic-illegal-job", candidate.run_id, "synthetic-illegal-decision");
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
});
test("completed trial output requires the context, input, and validation links", async t => {
  const env = environment(t), completed = await complete(env);
  assert.equal(completed.status, "completed"); assert.equal(completed.result.created_at, evaluationAt);
  assert.doesNotThrow(() => verifyMethodTrials(env.db)); assert.equal(env.ledger.inbox().length, 0);
  assert.deepEqual(env.ledger.cursors(scope().watch_id), env.before.cursors);
  env.db.prepare("DELETE FROM checkpoints WHERE run_id=? AND checkpoint_key='executor:input'").run(env.pair.candidate_run_id);
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
});
test("integrity rejects a completed trial without output", t => {
  const env = environment(t); env.db.prepare("UPDATE runs SET status='completed' WHERE run_id=?").run(env.pair.candidate_run_id);
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
});
test("integrity rejects a changed semantic output time after output and checkpoint hashes change", async t => {
  const env = environment(t); assert.equal((await complete(env)).status, "completed");
  const row = env.db.prepare("SELECT result_json FROM method_trial_outputs WHERE run_id=?").get(env.pair.candidate_run_id);
  const output = JSON.parse(row.result_json); output.created_at = "2026-10-11T00:00:00.000Z";
  env.db.prepare("UPDATE method_trial_outputs SET sha256=?,result_json=? WHERE run_id=?").run(contentHash(output), canonicalJson(output), env.pair.candidate_run_id);
  env.db.prepare("UPDATE checkpoints SET sha256=?,payload_json=? WHERE run_id=? AND checkpoint_key='executor:validated-result'").run(contentHash(output), canonicalJson(output), env.pair.candidate_run_id);
  assert.throws(() => verifyMethodTrials(env.db), { code: "METHOD_TRIAL_INVALID" });
});
