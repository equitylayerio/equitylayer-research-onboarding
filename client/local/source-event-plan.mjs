import { canonicalJson, contentHash, publicScope } from "./run-contract.mjs";
import { validateSourceArtifact, validateSourceEvent, verifyMethodBundle, verifySourceReference } from "./reference-bridge.mjs";
import { validateNormalizedFact } from "./normalized-fact.mjs";
import { validateCorrectionLineageCore } from "./correction-lineage-core.mjs";
import { twseReportingPeriodGate, TWSE_MONTHLY_SOURCE_ID, TWSE_LOCAL_VERSION } from "./twse-monthly-contract.mjs";
import { secSubmissionsIndexGate, isSecSubmissionsEvent } from "./sec-submissions-contract.mjs";

export class EventPlanError extends Error {
  constructor(code, message) { super(message); this.name = "EventPlanError"; this.code = code; }
}
const fail = (code, message) => { throw new EventPlanError(code, message); };
const copy = (value) => {
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized) > 2_000_000) fail("EVENT_INPUT_TOO_LARGE", "Use a bounded event context.");
  return JSON.parse(serialized);
};
const text = (value, max = 500) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) fail("INVALID_SOURCE_POLICY", "Use bounded printable policy text.");
  return value;
};
const unique = (values, min = 0, max = 1000) => {
  if (!Array.isArray(values) || values.length < min || values.length > max) fail("INVALID_SOURCE_POLICY", "Use a bounded policy list.");
  const parsed = values.map((value) => text(value));
  if (new Set(parsed).size !== parsed.length) fail("INVALID_SOURCE_POLICY", "Remove duplicate policy values.");
  return parsed.sort();
};

// Only the caller's local configuration can grant a use purpose. Source text cannot grant it.
export function validateSourcePolicy(input) {
  const value = copy(input);
  const fields = ["schema_version", "revision", "source_id", "rights_status", "rights_reference", "allowed_purposes", "adapter_version", "parser_version",
    "issuer_map", "metric_definition_ids", "allowed_evidence_states", "max_source_age_ms", "allow_candidate_trials"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== fields.sort().join()) fail("INVALID_SOURCE_POLICY", "Use the required source policy fields only.");
  if (value.schema_version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.max_source_age_ms) || value.max_source_age_ms < 1 ||
      typeof value.allow_candidate_trials !== "boolean") fail("INVALID_SOURCE_POLICY", "Use a supported policy version and bounded limits.");
  text(value.source_id); text(value.adapter_version, 160); text(value.parser_version, 160);
  if (!["ALLOWED", "HOLD", "UNKNOWN"].includes(value.rights_status)) fail("INVALID_SOURCE_POLICY", "Use an explicit rights state.");
  if (value.rights_reference !== null) text(value.rights_reference, 2000);
  if (value.rights_status === "ALLOWED" && value.rights_reference === null) fail("INVALID_SOURCE_POLICY", "An allowed use requires a rights reference.");
  value.allowed_purposes = unique(value.allowed_purposes, 0, 1);
  if (value.allowed_purposes.some((purpose) => purpose !== "local_research")) fail("INVALID_SOURCE_POLICY", "This policy can grant local research only.");
  value.metric_definition_ids = unique(value.metric_definition_ids, 1);
  value.allowed_evidence_states = unique(value.allowed_evidence_states, 1, 2);
  if (value.allowed_evidence_states.some((state) => !["VERIFIED", "PROVISIONAL"].includes(state))) fail("INVALID_SOURCE_POLICY", "Use supported research evidence states only.");
  if (!value.issuer_map || typeof value.issuer_map !== "object" || Array.isArray(value.issuer_map) || Object.keys(value.issuer_map).length < 1 || Object.keys(value.issuer_map).length > 1000) fail("INVALID_SOURCE_POLICY", "Configure explicit company-to-issuer identifiers.");
  for (const [symbol, issuer] of Object.entries(value.issuer_map)) {
    if (!/^[A-Z0-9][A-Z0-9.^-]{0,29}$/.test(symbol)) fail("INVALID_SOURCE_POLICY", "Use canonical company symbols in the issuer map.");
    text(issuer);
  }
  return value;
}

export function verifyEventFacts(event, artifact, values) {
  if (!Array.isArray(values) || values.length > 10000) fail("FACT_CONTEXT_INVALID", "Use at most 10000 affected facts per event.");
  const facts = values.map(validateNormalizedFact); const keys = new Set();
  for (const fact of facts) {
    if (keys.has(fact.fact_key)) fail("FACT_CONTEXT_INVALID", "Use one immutable fact for each event fact key.");
    keys.add(fact.fact_key);
    if (fact.source_event_id !== event.source_event_id || !event.affected_fact_keys.includes(fact.fact_key) ||
        fact.source_artifact_sha256 !== artifact.artifact_sha256 || fact.source_url !== artifact.canonical_url || fact.parser_version !== event.parser_version) {
      fail("FACT_CONTEXT_INVALID", "The fact must match its event, artifact, and parser.");
    }
  }
  return facts;
}

// Share fact eligibility across native plans and external research contexts.
export function selectSourceFacts(scope, policy, facts) {
  const relevant = facts.filter(fact => scope.symbols.some(symbol => policy.issuer_map[symbol] === fact.identity.issuer_id) &&
    policy.metric_definition_ids.includes(fact.identity.metric_definition_id));
  const gate_code = relevant.some(fact => fact.value_type === "missing" || fact.identity.evidence_layer === "unknown") ? "SOURCE_NEEDED" :
    relevant.some(fact => !policy.allowed_evidence_states.includes(fact.evidence_state)) ? "EVIDENCE_STATE_REVIEW_REQUIRED" : null;
  return { relevant, gate_code };
}

// The plan establishes relevance and execution gates. It does not accept an investment interpretation.
export function planSourceEvent({ scope: scopeValue, method_bundle, event, artifact, bytes, facts, retained_events = [], lineage_context,
  policy: policyValue, previous_source, sec_index_head, evaluation_at }) {
  const scope = publicScope(scopeValue); const method = verifyMethodBundle(method_bundle);
  const source_ref = verifySourceReference(event, artifact, bytes);
  const parsedFacts = verifyEventFacts(event, artifact, facts);
  const policy = policyValue === null || policyValue === undefined ? null : validateSourcePolicy(policyValue);
  const evaluationTime = Date.parse(evaluation_at);
  if (typeof evaluation_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(evaluation_at) || !Number.isFinite(evaluationTime) ||
      new Date(evaluationTime).toISOString().slice(0, 19) !== evaluation_at.slice(0, 19)) fail("EVENT_INPUT_INVALID", "Use a real UTC evaluation time.");
  const task_key = `el-event-task-${contentHash({ scope, method, source_ref })}`;
  const context = lineage_context ? copy(lineage_context) : null;
  const factRefs = new Map();
  const retainFactRef = (fact) => factRefs.set(`${fact.source_event_id}:${fact.fact_key}:${contentHash(fact)}`,
    { source_event_id: fact.source_event_id, fact_key: fact.fact_key, sha256: contentHash(fact) });
  parsedFacts.forEach(retainFactRef);
  // Current records always enter the lineage core. A supplied copy cannot replace them.
  let boundContext; let boundEvents; let contextInvalid = false;
  try {
    boundEvents = retained_events.map(validateSourceEvent);
    if (context) {
      if (!Array.isArray(context.artifacts) || !Array.isArray(context.facts) || Object.keys(context).sort().join() !== "artifacts,facts") throw new Error("Invalid context.");
      const contextFacts = context.facts.map(validateNormalizedFact); contextFacts.forEach(retainFactRef);
      boundContext = { artifacts: [...context.artifacts.map(validateSourceArtifact), artifact], facts: [...contextFacts, ...parsedFacts] };
    }
  } catch { contextInvalid = true; }
  const sec = isSecSubmissionsEvent(event, artifact), indexHead = sec_index_head === undefined ? previous_source : sec_index_head;
  let indexContext = null;
  if (sec && indexHead) {
    const reference = verifySourceReference(indexHead.event, indexHead.artifact, indexHead.bytes);
    const headFacts = verifyEventFacts(indexHead.event, indexHead.artifact, indexHead.facts);
    headFacts.forEach(retainFactRef); indexContext = { source_ref: reference, facts: headFacts };
  }
  const basis = { schema_version: 1, task_key, scope, method, source_ref,
    policy_sha256: policy ? contentHash(policy) : null, evidence_context_sha256: contentHash({ facts: parsedFacts, retained_events,
      lineage_context: context, ...(sec ? { sec_index_head: indexContext } : {}) }),
    fact_refs: [...factRefs.values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))), relevant_fact_keys: [], verification: "structural_only" };
  const gate = (code) => ({ ...basis, outcome: "gated", gate_code: code });
  const ignore = (reason) => ({ ...basis, outcome: "ignored", gate_code: null, reason });
  if (!policy) return gate("SOURCE_POLICY_MISSING");
  if (policy.source_id !== artifact.source_id) return gate("SOURCE_POLICY_CONFLICT");
  if (policy.rights_status !== "ALLOWED") return gate(policy.rights_status === "HOLD" ? "SOURCE_RIGHTS_HOLD" : "SOURCE_RIGHTS_UNKNOWN");
  if (!policy.allowed_purposes.includes("local_research")) return gate("SOURCE_PURPOSE_DENIED");
  if (!policy.allow_candidate_trials) return gate("METHOD_CURATION_REQUIRED");
  if (event.event_kind === "SCHEMA_CHANGE" || event.parser_version !== policy.parser_version || event.adapter_version !== policy.adapter_version) return gate("SOURCE_SCHEMA_CHANGED");
  if (event.event_kind === "NO_DATA") return gate("SOURCE_NEEDED");
  if (artifact.http_status < 200 || artifact.http_status >= 300) return gate("SOURCE_FETCH_FAILED");
  const retrieved = Date.parse(artifact.retrieved_at); const observed = Date.parse(event.observed_at);
  if (retrieved > evaluationTime || observed > evaluationTime || artifact.published_at !== null && Date.parse(artifact.published_at) > evaluationTime) return gate("SOURCE_TIME_CONFLICT");
  if (evaluationTime - retrieved > policy.max_source_age_ms) return gate("STALE_SOURCE");
  const reportingGate = twseReportingPeriodGate(event, artifact, evaluationTime);
  if (reportingGate) return gate(reportingGate);
  if (event.event_kind === "CORRECTED_PERIOD" || event.supersedes_source_event_id !== null) {
    try {
      if (event.event_kind !== "CORRECTED_PERIOD" || contextInvalid) return gate("CORRECTION_REVIEW_REQUIRED");
      validateCorrectionLineageCore(event, boundEvents, boundContext,
        { canonicalJson, gate: () => fail("CORRECTION_REVIEW_REQUIRED", "The correction requires contextual review.") });
    } catch (error) {
      if (error.code === "CORRECTION_REVIEW_REQUIRED" || error.code === "INVALID_NORMALIZED_FACT") return gate("CORRECTION_REVIEW_REQUIRED");
      throw error;
    }
  }
  if (!event.affected_fact_keys.length || parsedFacts.length !== event.affected_fact_keys.length) return gate("MISSING_FACT_CONTEXT");
  const { relevant, gate_code } = selectSourceFacts(scope, policy, parsedFacts);
  basis.relevant_fact_keys = relevant.map((fact) => fact.fact_key).sort();
  if (!relevant.length) return ignore("UNRELATED_EVENT");
  if (gate_code) return gate(gate_code);
  const secGate = secSubmissionsIndexGate(event, artifact, relevant, indexHead);
  if (secGate) return gate(secGate);
  const identical = previous_source && previous_source.artifact.source_id === artifact.source_id &&
    previous_source.artifact.source_period === artifact.source_period && previous_source.artifact.artifact_sha256 === artifact.artifact_sha256 &&
    previous_source.event.parser_version === event.parser_version && previous_source.event.adapter_version === event.adapter_version;
  if (identical) {
    const comparable = (values) => values.map(validateNormalizedFact).map((fact) => ({ fact_key: fact.fact_key, identity: fact.identity,
      value: fact.value, value_type: fact.value_type, definition_version: fact.definition_version, parser_version: fact.parser_version,
      evidence_state: fact.evidence_state, limitation: fact.limitation, exact_locator: fact.exact_locator, source_url: fact.source_url, reported_at: fact.reported_at }))
      .sort((a, b) => a.fact_key.localeCompare(b.fact_key));
    try {
      if (!previous_source.facts || canonicalJson(comparable(previous_source.facts)) !== canonicalJson(comparable(parsedFacts))) return gate("FACT_PARSE_CONFLICT");
    } catch { return gate("FACT_PARSE_CONFLICT"); }
  }
  if (event.event_kind === "OBSERVATION_NO_CHANGE") return identical ? ignore("SOURCE_BYTES_UNCHANGED") : gate("NO_CHANGE_UNVERIFIED");
  if (identical && event.event_kind !== "CORRECTED_PERIOD") return ignore("SOURCE_BYTES_UNCHANGED");
  if (previous_source?.facts && previous_source.artifact.source_id === artifact.source_id &&
      previous_source.artifact.source_period === artifact.source_period && previous_source.event.parser_version === event.parser_version &&
      previous_source.event.adapter_version === event.adapter_version) {
    const comparable = values => values.map(validateNormalizedFact)
      .filter(fact => scope.symbols.some(symbol => policy.issuer_map[symbol] === fact.identity.issuer_id) && policy.metric_definition_ids.includes(fact.identity.metric_definition_id))
      .map(fact => ({ fact_key: fact.fact_key, identity: fact.identity, value: fact.value, value_type: fact.value_type,
        definition_version: fact.definition_version, parser_version: fact.parser_version, evidence_state: fact.evidence_state,
        limitation: fact.limitation, exact_locator: fact.exact_locator, source_url: fact.source_url,
        reported_at: artifact.source_id === TWSE_MONTHLY_SOURCE_ID && event.parser_version === TWSE_LOCAL_VERSION ? null : fact.reported_at }))
      .sort((a, b) => a.fact_key.localeCompare(b.fact_key));
    if (canonicalJson(comparable(previous_source.facts)) === canonicalJson(comparable(parsedFacts))) return ignore("FIXED_SCOPE_EVIDENCE_UNCHANGED");
  }
  return { ...basis, outcome: "queue", gate_code: null };
}
