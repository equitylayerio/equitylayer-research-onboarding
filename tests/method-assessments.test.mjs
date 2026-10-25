import test from "node:test";
import assert from "node:assert/strict";
import { assessMethodPair } from "../client/local/method-assessments.mjs";
import { canonicalJson, contentHash, createRunEnvelope } from "../client/local/run-contract.mjs";
import { validateTrialRuntimePolicy } from "../client/local/trial-policy.mjs";
import { verifyMethodBundle } from "../client/local/reference-bridge.mjs";
import { scope, context, methodBundle, result, policy } from "./fixtures/local-research.mjs";

const evaluationAt = "2026-10-12T00:00:00.000Z";
const clone = value => JSON.parse(canonicalJson(value));
const defaultCriteria = () => [{ id: "accuracy", description: "Check synthetic accuracy.", critical: true, weight: 2 },
  { id: "clarity", description: "Check synthetic clarity.", critical: false, weight: 1 }];
function fixture({ criteria = defaultCriteria(), minimum = 5000 } = {}) {
  const runtime = { schema_version: 1, runtime: { identity: "synthetic-runtime", config_sha256: "a".repeat(64) },
    execution: { estimate: { tokens: 1, cost_microusd: 1, wall_ms: 3000 }, timeout_ms: 3000,
      lease_ms: 9000, heartbeat_ms: 2000, retry_delay_ms: 0 } };
  const incumbent = methodBundle(), candidate = methodBundle(); candidate.version = "test-2";
  candidate.profiles[0].version = "0.1.1"; candidate.profiles[0].checks.push("Check synthetic contrary evidence.");
  const { content_sha256: ignoredProfile, ...profile } = candidate.profiles[0]; candidate.profiles[0].content_sha256 = contentHash(profile);
  const { content_sha256: ignoredBundle, ...body } = candidate; candidate.content_sha256 = contentHash(body);
  const planRequest = { plan_id: "plan-1", incumbent_method_sha256: incumbent.content_sha256,
    case_refs: [{ case_id: "case-1", case_sha256: "b".repeat(64), partition: "regression" }],
    rubric: { version: "synthetic-rubric", criteria, minimum_score_bps: minimum, critical_regression_veto: true,
      comparison_rule: "paired_incumbent_no_regression" }, evaluation_at: evaluationAt, repetitions: 2,
    runtime_policy_sha256: validateTrialRuntimePolicy(runtime).sha256, author_id: "synthetic-owner" };
  const planRecord = { schema_version: 1, request: planRequest, request_sha256: contentHash(planRequest), captured_at: 0,
    payload: { corpus_sha256: contentHash(planRequest.case_refs), rubric_sha256: contentHash(planRequest.rubric),
      release_gate: "D12_UNANSWERED", evaluation_status: "not_executed" } };
  const plan = { artifact_id: "plan:plan-1", sha256: contentHash(planRecord), record: planRecord };
  const request = { plan_id: "plan-1", case_id: "case-1", candidate_id: "candidate-1", repetition: 1,
    runtime_policy: runtime, budget_window: "method-trial:synthetic", run_policy: policy() };
  const base = { schema_version: 1, scope: scope(), private_context: context(), sources: [], baselines: [], evaluation_at: evaluationAt };
  const record = { schema_version: 1, request, request_sha256: contentHash(request), created_at: 0,
    plan_sha256: plan.sha256, case_sha256: "b".repeat(64), candidate_sha256: "c".repeat(64),
    input_sha256: contentHash(base), input_json: canonicalJson(base) };
  const trial = { plan_id: request.plan_id, plan_sha256: plan.sha256, case_id: request.case_id, case_sha256: record.case_sha256,
    candidate_id: request.candidate_id, candidate_sha256: record.candidate_sha256, repetition: 1,
    runtime_policy_sha256: planRequest.runtime_policy_sha256 };
  const roles = Object.fromEntries(["incumbent", "candidate"].map(role => {
    const envelope = createRunEnvelope({ scope: base.scope, method: verifyMethodBundle(role === "incumbent" ? incumbent : candidate),
      source_refs: [], baselines: [], evaluation_at: evaluationAt, local_context_sha256: contentHash(base.private_context), trial: { ...trial, role } });
    return [role, { run_id: envelope.run_id, status: "completed", envelope }];
  }));
  const outputs = ["incumbent", "candidate"].map((role, index) => {
    const output = { ...result(roles[role].envelope, "SOURCE_NEEDED"), result_id: `11111111-1111-4111-8111-11111111111${index}`,
      created_at: evaluationAt, next_check_at: "2026-10-13T00:00:00.000Z" };
    return { run_id: roles[role].run_id, sha256: contentHash(output), result: output };
  });
  const pair = { pair_id: `el-method-pair-${contentHash({ request_sha256: record.request_sha256 })}`, sha256: contentHash(record), record, ...roles, outputs };
  const assessment = { schema_version: 1, pair_id: pair.pair_id, pair_sha256: pair.sha256,
    assessor: { identity: "synthetic-assessor", config_sha256: "d".repeat(64) }, rubric_sha256: contentHash(planRequest.rubric),
    roles: Object.fromEntries(["incumbent", "candidate"].map((role, index) => [role, { output_sha256: outputs[index].sha256,
      criteria: criteria.map(criterion => ({ id: criterion.id, score_bps: role === "incumbent" ? 5000 : 6000,
        reason: `Synthetic reason for ${criterion.id}.` })) }])) };
  return { pair, assessment, plan };
}
const assess = env => assessMethodPair(env.pair, env.assessment, env.plan);
const score = (env, role, id, value) => { env.assessment.roles[role].criteria.find(criterion => criterion.id === id).score_bps = value; };

test("assessment returns exact identities, declared reasons, and a comparison without authority", () => {
  const env = fixture(), output = assess(env);
  assert.equal(output.comparison.outcome, "comparison_pass");
  assert.equal(output.assessment_sha256, contentHash(output.assessment));
  assert.deepEqual(output.assessment, env.assessment);
  assert.deepEqual(output.comparison.scores.candidate, { weighted_sum: 18000, total_weight: 3, score_bps: 6000 });
  for (const field of ["research_quality_verified", "method_approved", "assessor_calibration_verified", "assessor_authenticity_verified"]) {
    assert.equal(output.comparison[field], false);
  }
});
test("comparison requires the frozen candidate threshold", () => {
  const env = fixture({ minimum: 7000 });
  const output = assess(env); assert.equal(output.comparison.outcome, "comparison_fail");
  assert.equal(output.comparison.threshold_pass, false); assert.equal(output.comparison.no_total_regression, true);
});
test("equal scores pass at the exact minimum threshold", () => {
  const env = fixture(); score(env, "candidate", "accuracy", 5000); score(env, "candidate", "clarity", 5000);
  assert.equal(assess(env).comparison.outcome, "comparison_pass");
});
test("critical regression fails even when the candidate total improves", () => {
  const env = fixture({ minimum: 0 }); score(env, "candidate", "accuracy", 4999); score(env, "candidate", "clarity", 10000);
  const output = assess(env); assert.equal(output.comparison.outcome, "comparison_fail");
  assert.equal(output.comparison.no_total_regression, true); assert.equal(output.comparison.critical_regression_veto_pass, false);
  assert.deepEqual(output.comparison.critical_regressions, ["accuracy"]);
});
test("weights affect the result without requiring every noncritical score to improve", () => {
  const criteria = defaultCriteria(); criteria[0].critical = false; criteria[0].weight = 100;
  const env = fixture({ criteria, minimum: 0 }); score(env, "candidate", "accuracy", 5001); score(env, "candidate", "clarity", 4900);
  const output = assess(env); assert.equal(output.comparison.outcome, "comparison_pass");
  assert.equal(output.comparison.scores.candidate.weighted_sum, 505000);
  assert.equal(output.comparison.scores.candidate.total_weight, 101);
});
test("integer display rounding cannot conceal a total regression", () => {
  const criteria = defaultCriteria(); criteria[0].critical = false; criteria[0].weight = 100;
  const env = fixture({ criteria, minimum: 0 });
  score(env, "incumbent", "accuracy", 5000); score(env, "incumbent", "clarity", 1);
  score(env, "candidate", "accuracy", 5000); score(env, "candidate", "clarity", 0);
  const output = assess(env);
  assert.equal(output.comparison.scores.incumbent.score_bps, output.comparison.scores.candidate.score_bps);
  assert.equal(output.comparison.no_total_regression, false); assert.equal(output.comparison.outcome, "comparison_fail");
});
test("fractional weighted scores below the threshold fail", () => {
  const criteria = defaultCriteria(); criteria[0].critical = false; criteria[0].weight = 1;
  const env = fixture({ criteria });
  score(env, "incumbent", "accuracy", 0); score(env, "incumbent", "clarity", 0);
  score(env, "candidate", "accuracy", 5000); score(env, "candidate", "clarity", 4999);
  assert.equal(assess(env).comparison.threshold_pass, false);
});
test("maximum rubric weights and score boundaries use exact integer arithmetic", () => {
  const criteria = Array.from({ length: 20 }, (_, index) => ({ id: `criterion-${index}`, description: "Synthetic boundary criterion.", critical: true, weight: 100 }));
  const env = fixture({ criteria, minimum: 10000 });
  for (const role of ["incumbent", "candidate"]) for (const criterion of env.assessment.roles[role].criteria) criterion.score_bps = role === "incumbent" ? 0 : 10000;
  const output = assess(env); assert.equal(output.comparison.outcome, "comparison_pass");
  assert.deepEqual(output.comparison.scores.candidate, { weighted_sum: 20_000_000, total_weight: 2000, score_bps: 10000 });
});
test("replay normalizes criterion order and preserves input objects", () => {
  const env = fixture(), before = canonicalJson(env), first = assess(env);
  assert.equal(canonicalJson(env), before);
  env.assessment.roles.incumbent.criteria.reverse(); env.assessment.roles.candidate.criteria.reverse(); env.pair.outputs.reverse();
  assert.deepEqual(assess(env), first);
  first.assessment.roles.candidate.criteria[0].reason = "Returned object mutation.";
  assert.notEqual(env.assessment.roles.candidate.criteria[0].reason, "Returned object mutation.");
});
test("assessor and reason changes produce distinct retained assessment hashes", () => {
  const env = fixture(), original = assess(env).assessment_sha256;
  env.assessment.assessor.identity = "another-assessor";
  assert.notEqual(assess(env).assessment_sha256, original);
  env.assessment.assessor.identity = "synthetic-assessor"; env.assessment.assessor.config_sha256 = "e".repeat(64);
  assert.notEqual(assess(env).assessment_sha256, original);
  env.assessment.assessor.config_sha256 = "d".repeat(64); env.assessment.roles.candidate.criteria[0].reason = "Another declared reason.";
  assert.notEqual(assess(env).assessment_sha256, original);
});
for (const mutate of [
  env => { env.pair.candidate.status = "running"; },
  env => { env.pair.outputs.pop(); },
  env => { env.pair.outputs[1] = clone(env.pair.outputs[0]); },
  env => { env.pair.outputs[1].result.summary = "Changed retained output."; },
  env => { env.assessment.roles.candidate.output_sha256 = "f".repeat(64); },
  env => { env.assessment.pair_sha256 = "f".repeat(64); },
  env => { env.plan.record.request.rubric.minimum_score_bps = 8000; },
  env => { env.assessment.rubric_sha256 = "f".repeat(64); },
  env => { env.pair.record.input_sha256 = "f".repeat(64); },
  env => { env.pair.candidate = clone(env.pair.incumbent); },
]) {
  test(`assessment rejects changed or incomplete evidence ${mutate.toString()}`, () => {
    const env = fixture(); mutate(env); assert.throws(() => assess(env), { code: "METHOD_ASSESSMENT_INVALID" });
  });
}
for (const mutate of [
  role => { role.criteria.pop(); },
  role => { role.criteria[1].id = role.criteria[0].id; },
  role => { role.criteria[1].id = "unknown-criterion"; },
  role => { delete role.criteria[0].reason; },
  role => { role.criteria[0].reason = " "; },
  role => { role.criteria[0].reason = "x".repeat(1201); },
  role => { role.criteria[0].score_bps = -1; },
  role => { role.criteria[0].score_bps = 10001; },
  role => { role.criteria[0].score_bps = 5000.5; },
  role => { role.criteria[0].score_bps = Number.MAX_SAFE_INTEGER + 1; },
]) {
  test(`assessment rejects malformed scores ${mutate.toString()}`, () => {
    const env = fixture(); mutate(env.assessment.roles.candidate); assert.throws(() => assess(env), { code: "METHOD_ASSESSMENT_INVALID" });
  });
}
test("assessment rejects invalid assessor hashes and all extra permission fields", () => {
  const invalid = fixture(); invalid.assessment.assessor.config_sha256 = "invalid";
  assert.throws(() => assess(invalid), { code: "METHOD_ASSESSMENT_INVALID" });
  for (const field of ["method_approved", "allow_payment", "allow_trading", "source_rights", "release_gate", "calibration_verified"]) {
    for (const target of ["assessment", "assessor", "role", "criterion"]) {
      const env = fixture();
      const record = target === "assessment" ? env.assessment : target === "assessor" ? env.assessment.assessor :
        target === "role" ? env.assessment.roles.candidate : env.assessment.roles.candidate.criteria[0];
      record[field] = true; assert.throws(() => assess(env), { code: "METHOD_ASSESSMENT_INVALID" });
    }
  }
});
