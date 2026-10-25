import { canonicalJson, contentHash, publicScope, validateRunEnvelope } from "./run-contract.mjs";
import { methodExact, methodText, methodHash, methodList, MethodArtifactError, validateMethodArtifact } from "./method-artifacts.mjs";
import { validateTrialPairRequest } from "./method-trials.mjs";
import { validateTrialRuntimePolicy } from "./trial-policy.mjs";
import { validateResearchResultFile } from "./result-file.mjs";

const fail = message => { throw new MethodArtifactError("METHOD_ASSESSMENT_INVALID", message); };
const check = (condition, message) => { if (!condition) fail(message); };
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const copy = value => JSON.parse(canonicalJson(value));

// Compare declared scores only. This does not prove assessor calibration or authenticity.
export function assessMethodPair(pairValue, assessmentValue, planArtifactValue) {
  try {
    const pair = copy(pairValue), assessment = copy(assessmentValue), planArtifact = copy(planArtifactValue);
    methodExact(pair, ["pair_id", "sha256", "record", "incumbent", "candidate", "outputs"]);
    methodText(pair.pair_id); methodHash(pair.sha256);
    const record = pair.record;
    methodExact(record, ["schema_version", "request", "request_sha256", "created_at", "plan_sha256", "case_sha256", "candidate_sha256", "input_sha256", "input_json"]);
    check(record.schema_version === 1 && contentHash(record) === pair.sha256, "Use the exact retained pair record.");
    check(Number.isSafeInteger(record.created_at) && record.created_at >= 0, "Use a valid retained pair time.");
    for (const field of ["request_sha256", "plan_sha256", "case_sha256", "candidate_sha256", "input_sha256"]) methodHash(record[field]);
    const request = validateTrialPairRequest(record.request);
    check(same(request, record.request) && contentHash(request) === record.request_sha256 &&
      pair.pair_id === `el-method-pair-${contentHash({ request_sha256: record.request_sha256 })}`, "Use the exact pair request identity.");
    methodExact(planArtifact, ["artifact_id", "sha256", "record"]); methodHash(planArtifact.sha256);
    const plan = validateMethodArtifact("plan", planArtifact.record);
    check(planArtifact.artifact_id === `plan:${request.plan_id}` && plan.request.plan_id === request.plan_id &&
      planArtifact.sha256 === record.plan_sha256 && contentHash(plan) === planArtifact.sha256, "Use the frozen plan pinned by this pair.");
    const rubric = plan.request.rubric, rubricSha = contentHash(rubric);
    const runtime = validateTrialRuntimePolicy(request.runtime_policy);
    check(plan.request.runtime_policy_sha256 === runtime.sha256 && request.repetition <= plan.request.repetitions &&
      plan.request.case_refs.some(ref => ref.case_id === request.case_id && ref.case_sha256 === record.case_sha256 && ref.partition === "regression"),
    "Use the frozen case, repetition, and runtime policy.");
    check(typeof record.input_json === "string", "Use the retained canonical trial input.");
    const base = JSON.parse(record.input_json);
    methodExact(base, ["schema_version", "scope", "private_context", "sources", "baselines", "evaluation_at"]);
    check(base.schema_version === 1 && canonicalJson(base) === record.input_json && contentHash(base) === record.input_sha256 &&
      base.evaluation_at === plan.request.evaluation_at && same(publicScope(base.scope), base.scope), "Use the exact frozen input scope and time.");
    methodList(base.sources, 0, 1000); methodList(base.baselines, 0, 100);
    methodList(pair.outputs, 2, 2);
    const outputs = new Map();
    for (const output of pair.outputs) {
      methodExact(output, ["run_id", "sha256", "result"]); methodText(output.run_id, 500); methodHash(output.sha256);
      check(!outputs.has(output.run_id), "Use one output for each trial role.");
      const result = validateResearchResultFile(output.result);
      check(same(result, output.result) && contentHash(result) === output.sha256, "Use the exact retained trial output hash.");
      check(same(publicScope({ watch_id: result.watch_id, revision: result.scope_revision, theme_id: result.theme_id,
        symbols: result.symbols, ...(result.stage_id === undefined ? {} : { stage_id: result.stage_id }) }), base.scope) &&
        result.created_at === base.evaluation_at && Date.parse(result.next_check_at) > Date.parse(result.created_at), "Use the frozen output scope and time.");
      outputs.set(output.run_id, output);
    }
    const roleOutputs = {};
    for (const role of ["incumbent", "candidate"]) {
      const run = pair[role];
      check(run && run.status === "completed", "Complete both trial roles before assessment.");
      const envelope = validateRunEnvelope(run.envelope);
      const expectedTrial = { plan_id: request.plan_id, plan_sha256: record.plan_sha256, case_id: request.case_id,
        case_sha256: record.case_sha256, candidate_id: request.candidate_id, candidate_sha256: record.candidate_sha256,
        role, repetition: request.repetition, runtime_policy_sha256: runtime.sha256 };
      check(envelope.run_id === run.run_id && same(envelope.trial, expectedTrial), "Use the exact completed trial role identity.");
      check(same(envelope.scope, base.scope) && envelope.local_context_sha256 === contentHash(base.private_context) &&
        same(envelope.source_refs, base.sources.map(source => source.reference)) && same(envelope.baselines, base.baselines) &&
        envelope.evaluation_at === base.evaluation_at, "Use the exact input for both trial roles.");
      if (role === "incumbent") check(envelope.method.bundle_sha256 === plan.request.incumbent_method_sha256, "Use the frozen incumbent method.");
      const output = outputs.get(run.run_id);
      check(output, "Retain both completed trial outputs.");
      roleOutputs[role] = output;
    }
    check(pair.incumbent.run_id !== pair.candidate.run_id, "Use distinct incumbent and candidate runs.");
    check(pair.incumbent.envelope.method.bundle_sha256 !== pair.candidate.envelope.method.bundle_sha256, "Use a changed candidate method.");

    methodExact(assessment, ["schema_version", "pair_id", "pair_sha256", "assessor", "rubric_sha256", "roles"]);
    check(assessment.schema_version === 1 && assessment.pair_id === pair.pair_id && assessment.pair_sha256 === pair.sha256,
      "Assess the exact retained pair identity.");
    methodHash(assessment.pair_sha256); methodHash(assessment.rubric_sha256);
    check(assessment.rubric_sha256 === rubricSha, "Use the frozen rubric hash.");
    methodExact(assessment.assessor, ["identity", "config_sha256"]);
    methodText(assessment.assessor.identity); methodHash(assessment.assessor.config_sha256);
    methodExact(assessment.roles, ["incumbent", "candidate"]);
    const criteria = [...rubric.criteria].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const scores = {};
    for (const role of ["incumbent", "candidate"]) {
      const supplied = assessment.roles[role]; methodExact(supplied, ["output_sha256", "criteria"]);
      methodHash(supplied.output_sha256);
      check(supplied.output_sha256 === roleOutputs[role].sha256, "Assess the exact output for each role.");
      methodList(supplied.criteria, criteria.length, criteria.length);
      const byId = new Map();
      for (const criterion of supplied.criteria) {
        methodExact(criterion, ["id", "score_bps", "reason"]); methodText(criterion.id); methodText(criterion.reason, 1200);
        check(!byId.has(criterion.id) && criteria.some(frozen => frozen.id === criterion.id), "Score each frozen criterion once.");
        check(Number.isSafeInteger(criterion.score_bps) && criterion.score_bps >= 0 && criterion.score_bps <= 10000, "Use an integer score from zero to ten thousand.");
        byId.set(criterion.id, criterion);
      }
      supplied.criteria = criteria.map(criterion => byId.get(criterion.id));
      const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
      const weightedSum = criteria.reduce((sum, criterion) => sum + criterion.weight * byId.get(criterion.id).score_bps, 0);
      scores[role] = { weighted_sum: weightedSum, total_weight: totalWeight, score_bps: Math.floor(weightedSum / totalWeight) };
    }
    const criticalRegressions = criteria.filter((criterion, index) => criterion.critical &&
      assessment.roles.candidate.criteria[index].score_bps < assessment.roles.incumbent.criteria[index].score_bps).map(criterion => criterion.id);
    const thresholdPass = scores.candidate.weighted_sum >= rubric.minimum_score_bps * scores.candidate.total_weight;
    const noTotalRegression = scores.candidate.weighted_sum >= scores.incumbent.weighted_sum;
    const criticalPass = criticalRegressions.length === 0;
    const comparison = { schema_version: 1, outcome: thresholdPass && noTotalRegression && criticalPass ? "comparison_pass" : "comparison_fail",
      scores, minimum_score_bps: rubric.minimum_score_bps, threshold_pass: thresholdPass, no_total_regression: noTotalRegression,
      critical_regression_veto_pass: criticalPass, critical_regressions: criticalRegressions,
      research_quality_verified: false, method_approved: false, assessor_calibration_verified: false, assessor_authenticity_verified: false };
    return copy({ assessment, assessment_sha256: contentHash(assessment), comparison });
  } catch (error) {
    if (error instanceof MethodArtifactError && error.code === "METHOD_ASSESSMENT_INVALID") throw error;
    throw new MethodArtifactError("METHOD_ASSESSMENT_INVALID", "Use a complete assessment with exact frozen references.");
  }
}
