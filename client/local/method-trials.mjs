import { canonicalJson, contentHash, publicScope, validateRunEnvelope } from "./run-contract.mjs";
import { methodExact, methodText, methodHash, MethodArtifactError, validateMethodArtifact } from "./method-artifacts.mjs";
import { validateTrialRuntimePolicy } from "./trial-policy.mjs";
import { verifyMethodBundle } from "./reference-bridge.mjs";
import { validateResearchResultFile } from "./result-file.mjs";
import { checkResearchAdviceFields } from "./research-advice-core.mjs";
import { verifyRetainedSourceContent } from "./source-content.mjs";

const fail = message => { throw new MethodArtifactError("METHOD_TRIAL_INVALID", message); };
const bounded = (value, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MethodArtifactError("METHOD_INPUT_INVALID", "Use bounded integer trial limits.");
  }
};

export function validateTrialPairRequest(value) {
  methodExact(value, ["plan_id", "case_id", "candidate_id", "repetition", "runtime_policy", "budget_window", "run_policy"]);
  for (const field of ["plan_id", "case_id", "candidate_id", "budget_window"]) methodText(value[field]);
  if (!value.budget_window.startsWith("method-trial:") || value.budget_window.length === "method-trial:".length) {
    throw new MethodArtifactError("METHOD_INPUT_INVALID", "Use a named method-trial budget window.");
  }
  bounded(value.repetition, 1, 10);
  const runtime = validateTrialRuntimePolicy(value.runtime_policy);
  methodExact(value.run_policy, ["max_attempts", "max_wall_ms", "not_before"]);
  bounded(value.run_policy.max_attempts, 1, 10);
  bounded(value.run_policy.max_wall_ms, 1, 3_600_000);
  bounded(value.run_policy.not_before, 0, Number.MAX_SAFE_INTEGER);
  if (runtime.policy.execution.timeout_ms > value.run_policy.max_wall_ms) {
    throw new MethodArtifactError("METHOD_INPUT_INVALID", "Keep the runtime timeout within the run wall limit.");
  }
  return JSON.parse(canonicalJson({ ...value, runtime_policy: runtime.policy }));
}

export const METHOD_TRIAL_SCHEMA = `
CREATE TABLE method_trial_pairs(pair_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,record_json TEXT NOT NULL,
 incumbent_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),candidate_run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
 CHECK(incumbent_run_id<>candidate_run_id)) STRICT;
CREATE TABLE method_trial_manifest(singleton INTEGER PRIMARY KEY CHECK(singleton=1),sha256 TEXT NOT NULL) STRICT;
INSERT INTO method_trial_manifest VALUES(1,'${contentHash([])}');
CREATE TABLE method_trial_outputs(run_id TEXT PRIMARY KEY REFERENCES runs(run_id),sha256 TEXT NOT NULL,
 result_json TEXT NOT NULL,created_at INTEGER NOT NULL CHECK(created_at>=0)) STRICT;
PRAGMA user_version=6;`;

// Check retained identity and provenance. Hashes do not authenticate authors or model claims.
export function verifyMethodTrials(db) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const check = condition => { if (!condition) fail("Retained trial content or references changed."); };
  const same = (left, right) => canonicalJson(left) === canonicalJson(right);
  const checkpoint = (runId, key) => {
    const row = get("SELECT sha256,payload_json FROM checkpoints WHERE run_id=? AND checkpoint_key=?", runId, key);
    if (!row) return null;
    const payload = JSON.parse(row.payload_json);
    check(canonicalJson(payload) === row.payload_json && contentHash(payload) === row.sha256);
    return { ...row, payload };
  };
  const artifact = (kind, id, sha) => {
    const row = get("SELECT kind,sha256,record_json FROM method_artifacts WHERE artifact_id=?", `${kind}:${id}`);
    check(row && row.kind === kind && row.sha256 === sha);
    const record = validateMethodArtifact(kind, JSON.parse(row.record_json));
    check(record.request[`${kind}_id`] === id && canonicalJson(record) === row.record_json && contentHash(record) === row.sha256);
    return record;
  };
  try {
    const pairs = all("SELECT * FROM method_trial_pairs ORDER BY pair_id");
    const membership = new Map();
    for (const pair of pairs) {
      const record = JSON.parse(pair.record_json);
      methodExact(record, ["schema_version", "request", "request_sha256", "created_at", "plan_sha256", "case_sha256", "candidate_sha256", "input_sha256", "input_json"]);
      check(record.schema_version === 1 && canonicalJson(record) === pair.record_json && contentHash(record) === pair.sha256);
      bounded(record.created_at, 0, Number.MAX_SAFE_INTEGER);
      for (const field of ["request_sha256", "plan_sha256", "case_sha256", "candidate_sha256", "input_sha256"]) methodHash(record[field]);
      const request = validateTrialPairRequest(record.request);
      check(same(request, record.request) && contentHash(request) === record.request_sha256);
      check(pair.pair_id === `el-method-pair-${contentHash({ request_sha256: record.request_sha256 })}`);
      const plan = artifact("plan", request.plan_id, record.plan_sha256);
      const captured = artifact("case", request.case_id, record.case_sha256);
      const candidate = artifact("candidate", request.candidate_id, record.candidate_sha256);
      const runtime = validateTrialRuntimePolicy(request.runtime_policy);
      check(plan.request.runtime_policy_sha256 === runtime.sha256 && request.repetition <= plan.request.repetitions);
      check(plan.request.case_refs.some(ref => ref.case_id === request.case_id && ref.case_sha256 === record.case_sha256 && ref.partition === "regression"));
      check(candidate.request.parent_method_sha256 === plan.request.incumbent_method_sha256);
      check(typeof record.input_json === "string");
      const base = JSON.parse(record.input_json);
      methodExact(base, ["schema_version", "scope", "private_context", "sources", "baselines", "evaluation_at"]);
      check(base.schema_version === 1 && canonicalJson(base) === record.input_json && contentHash(base) === record.input_sha256);
      check(same(publicScope(base.scope), base.scope) && same(base.scope, captured.payload.scope));
      check(same(base.private_context, captured.payload.private_context) && base.evaluation_at === plan.request.evaluation_at);
      check(same(base.baselines, captured.payload.envelope?.baselines ?? []) && Array.isArray(base.sources));
      check(same(base.sources.map(source => source.reference), captured.payload.source_refs));

      const snapshots = captured.payload.checkpoints.filter(item => ["execution-context:v1", "execution-context:v2"].includes(item.key));
      check(snapshots.length <= 1);
      const retainedContext = snapshots[0]?.payload
        ?? captured.payload.checkpoints.find(item => item.key === "executor:input")?.payload?.research_context;
      let originalRefs;
      if (retainedContext) {
        if (snapshots[0]) check(snapshots[0].key === `execution-context:v${retainedContext.schema_version}`);
        check([1, 2].includes(retainedContext.schema_version));
        if (retainedContext.schema_version === 2) methodHash(retainedContext.source_content_renderer_sha256);
        check(same(base.sources, retainedContext.sources) && same(base.private_context, retainedContext.private_context));
        check(same(base.scope, retainedContext.envelope.scope) && same(retainedContext.envelope, captured.payload.envelope));
      } else {
        if (captured.request.origin.kind === "source_gate") originalRefs = captured.payload.origin_record.fact_refs;
        else if (captured.payload.envelope) {
          const decision = get("SELECT d.decision_json FROM event_jobs j JOIN event_decisions d USING(decision_id) WHERE j.run_id=?", captured.payload.envelope.run_id);
          originalRefs = decision ? JSON.parse(decision.decision_json).fact_refs : undefined;
        }
        check(Array.isArray(originalRefs));
      }
      const selectedFacts = [];
      for (const source of base.sources) {
        const hasContent = Object.hasOwn(source, "source_content");
        methodExact(source, ["reference", "event", "artifact", "facts", ...(hasContent ? ["source_content"] : [])]);
        if (retainedContext?.schema_version === 2) check(hasContent);
        if (hasContent) verifyRetainedSourceContent(source);
        const retained = get("SELECT e.sha256,e.artifact_id,e.event_json,a.sha256 AS artifact_sha,a.metadata_json FROM source_events e JOIN artifacts a ON a.artifact_id=e.artifact_id WHERE e.event_id=?", source.reference.source_event_id);
        check(retained && retained.sha256 === source.reference.source_event_sha256 && retained.artifact_id === source.reference.source_artifact_id && retained.artifact_sha === source.reference.artifact_sha256);
        check(retained.event_json === canonicalJson(source.event) && retained.metadata_json === canonicalJson(source.artifact) && Array.isArray(source.facts));
        for (const fact of source.facts) {
          const row = get("SELECT sha256,fact_json FROM normalized_facts WHERE source_event_id=? AND fact_key=?", source.reference.source_event_id, fact.fact_key);
          check(fact.source_event_id === source.reference.source_event_id && row && row.sha256 === contentHash(fact) && row.fact_json === canonicalJson(fact));
          selectedFacts.push({ source_event_id: fact.source_event_id, fact_key: fact.fact_key, sha256: row.sha256 });
        }
      }
      if (originalRefs) {
        const ordered = refs => [...refs].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
        check(same(ordered(selectedFacts), ordered(originalRefs)));
      }
      check(pair.incumbent_run_id !== pair.candidate_run_id);
      for (const role of ["incumbent", "candidate"]) {
        const runId = pair[`${role}_run_id`];
        membership.set(runId, (membership.get(runId) ?? 0) + 1);
        const run = get("SELECT * FROM runs WHERE run_id=?", runId);
        check(run);
        const envelope = validateRunEnvelope(JSON.parse(run.envelope_json));
        const expectedTrial = { plan_id: request.plan_id, plan_sha256: record.plan_sha256, case_id: request.case_id,
          case_sha256: record.case_sha256, candidate_id: request.candidate_id, candidate_sha256: record.candidate_sha256,
          role, repetition: request.repetition, runtime_policy_sha256: runtime.sha256 };
        check(envelope.run_id === runId && same(envelope.trial, expectedTrial) && canonicalJson(envelope) === run.envelope_json);
        check(same(envelope.scope, base.scope) && envelope.local_context_sha256 === contentHash(base.private_context));
        check(same(envelope.source_refs, base.sources.map(source => source.reference)) && same(envelope.baselines, base.baselines) && envelope.evaluation_at === base.evaluation_at);
        const methodSha = role === "incumbent" ? plan.request.incumbent_method_sha256 : candidate.payload.method_sha256;
        const storedMethod = get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", methodSha);
        check(storedMethod);
        const bundle = JSON.parse(storedMethod.bundle_json);
        check(same(envelope.method, verifyMethodBundle(bundle)));
        check(run.watch_id === base.scope.watch_id && run.revision === base.scope.revision && run.window_id === request.budget_window && run.policy_json === canonicalJson(request.run_policy));
        check(["queued", "running", "gated", "cancelled", "completed"].includes(run.status));
        check(!get("SELECT run_id FROM deliveries WHERE run_id=?", runId) && !get("SELECT run_id FROM event_jobs WHERE run_id=?", runId));
        const context = checkpoint(runId, "trial-context:v1");
        if (context) check(same(context.payload, { schema_version: 1, envelope, private_context: base.private_context, method_bundle: bundle, sources: base.sources, created_at: base.evaluation_at }));
        const executorInput = checkpoint(runId, "executor:input");
        const runtimePin = { schema_version: 1, ...runtime.policy.runtime };
        if (executorInput) check(context && executorInput.payload.context_sha256 === context.sha256 && same(executorInput.payload.research_context, context.payload) && same(executorInput.payload.runtime, runtimePin));
        const declaredRuntime = checkpoint(runId, "executor:runtime");
        if (declaredRuntime) check(same(declaredRuntime.payload, runtimePin));
        for (const row of all("SELECT checkpoint_key FROM checkpoints WHERE run_id=? AND checkpoint_key LIKE 'trial-resume:%'", runId)) {
          const decision = checkpoint(runId, row.checkpoint_key).payload;
          methodExact(decision, ["request_sha256", "request", "previous_gate", "recorded_at"]);
          methodExact(decision.request, ["run_id", "decision_id", "reason"]);
          methodHash(decision.request_sha256); methodText(decision.request.decision_id); methodText(decision.request.reason, 1200);
          bounded(decision.recorded_at, 0, Number.MAX_SAFE_INTEGER);
          check(decision.request.run_id === runId && row.checkpoint_key === `trial-resume:${decision.request.decision_id}` &&
            contentHash(decision.request) === decision.request_sha256 && typeof decision.previous_gate === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(decision.previous_gate));
        }
        const output = get("SELECT * FROM method_trial_outputs WHERE run_id=?", runId);
        if (run.status === "completed") check(output && context && executorInput);
        if (output) {
          check(run.status === "completed");
          bounded(output.created_at, 0, Number.MAX_SAFE_INTEGER);
          const result = validateResearchResultFile(JSON.parse(output.result_json));
          check(canonicalJson(result) === output.result_json && contentHash(result) === output.sha256);
          check(same(publicScope({ watch_id: result.watch_id, revision: result.scope_revision, theme_id: result.theme_id,
            symbols: result.symbols, ...(result.stage_id === undefined ? {} : { stage_id: result.stage_id }) }), base.scope));
          check(result.created_at === base.evaluation_at && Date.parse(result.next_check_at) > Date.parse(result.created_at));
          const urls = new Set(base.sources.map(source => source.artifact.canonical_url));
          check(result.sources.every(source => urls.has(source.url) && source.date <= result.created_at.slice(0, 10)));
          check(result.result_state !== "NO_NEW_EVIDENCE" || base.baselines.length > 0);
          check(checkResearchAdviceFields(result).length === 0);
          const validated = checkpoint(runId, "executor:validated-result");
          check(validated && validated.sha256 === output.sha256 && validated.payload_json === output.result_json);
        }
      }
    }
    for (const run of all("SELECT run_id,envelope_json FROM runs")) {
      const trial = validateRunEnvelope(JSON.parse(run.envelope_json)).trial;
      if (trial) check(membership.get(run.run_id) === 1);
      else check(!membership.has(run.run_id) && !get("SELECT run_id FROM method_trial_outputs WHERE run_id=?", run.run_id));
    }
    for (const output of all("SELECT run_id FROM method_trial_outputs")) check(membership.get(output.run_id) === 1);
    const manifest = get("SELECT sha256 FROM method_trial_manifest WHERE singleton=1");
    check(manifest && manifest.sha256 === contentHash(pairs.map(({ pair_id, sha256, incumbent_run_id, candidate_run_id }) => ({ pair_id, sha256, incumbent_run_id, candidate_run_id }))));
  } catch (error) {
    if ([5, 6].includes(error.errcode)) throw error;
    if (error instanceof MethodArtifactError && error.code === "METHOD_TRIAL_INVALID") throw error;
    throw new MethodArtifactError("METHOD_TRIAL_INVALID", "Retained trial content failed verification.");
  }
}
