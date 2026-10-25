import test from "node:test";
import assert from "node:assert/strict";
import { planSourceEvent, validateSourcePolicy, verifyEventFacts } from "../client/local/source-event-plan.mjs";
import { contentHash } from "../client/local/run-contract.mjs";
import { scope, methodBundle } from "./fixtures/local-research.mjs";
import { eventFixture, sourcePolicy, evaluationAt } from "./fixtures/source-events.mjs";

const input = (fixture = eventFixture()) => ({ ...fixture, scope: scope(), method_bundle: methodBundle(), policy: sourcePolicy(), evaluation_at: evaluationAt });

test("explicit issuer and metric mapping selects all four markets without replacing company scope", () => {
  const value = input(eventFixture(1, { issuers: ["LITE", "2345", "6701", "000660"] })); const plan = planSourceEvent(value);
  assert.equal(plan.outcome, "queue"); assert.equal(plan.relevant_fact_keys.length, 4); assert.deepEqual(plan.scope.symbols, scope().symbols);
  assert.equal(plan.verification, "structural_only");
  assert.notEqual(planSourceEvent({ ...value, scope: { ...scope(), revision: 2 } }).task_key, plan.task_key);
});

for (const [name, change, code] of [
  ["missing policy", (value) => { value.policy = null; }, "SOURCE_POLICY_MISSING"],
  ["rights hold", (value) => { value.policy.rights_status = "HOLD"; }, "SOURCE_RIGHTS_HOLD"],
  ["rights unknown", (value) => { value.policy.rights_status = "UNKNOWN"; }, "SOURCE_RIGHTS_UNKNOWN"],
  ["wrong source", (value) => { value.policy.source_id = "another-source"; }, "SOURCE_POLICY_CONFLICT"],
  ["denied purpose", (value) => { value.policy.allowed_purposes = []; }, "SOURCE_PURPOSE_DENIED"],
  ["unapproved candidate", (value) => { value.policy.allow_candidate_trials = false; }, "METHOD_CURATION_REQUIRED"],
  ["schema event", (value) => { value.event.event_kind = "SCHEMA_CHANGE"; }, "SOURCE_SCHEMA_CHANGED"],
  ["parser drift", (value) => { value.policy.parser_version = "2"; }, "SOURCE_SCHEMA_CHANGED"],
  ["adapter drift", (value) => { value.policy.adapter_version = "2"; }, "SOURCE_SCHEMA_CHANGED"],
  ["no data", (value) => { value.event.event_kind = "NO_DATA"; }, "SOURCE_NEEDED"],
  ["fetch error", (value) => { value.artifact.http_status = 500; }, "SOURCE_FETCH_FAILED"],
  ["old retrieval", (value) => { value.policy.max_source_age_ms = 1; }, "STALE_SOURCE"],
  ["future source", (value) => { value.artifact.retrieved_at = "2026-10-13T00:00:00Z"; }, "SOURCE_TIME_CONFLICT"],
  ["missing facts", (value) => { value.facts = []; }, "MISSING_FACT_CONTEXT"],
  ["missing value", (value) => { value.facts[0].value = null; value.facts[0].value_type = "missing"; }, "SOURCE_NEEDED"],
  ["conflicted evidence", (value) => { value.facts[0].evidence_state = "CONFLICTED"; }, "EVIDENCE_STATE_REVIEW_REQUIRED"],
  ["unproved no change", (value) => { value.event.event_kind = "OBSERVATION_NO_CHANGE"; }, "NO_CHANGE_UNVERIFIED"],
]) test(`${name} creates its named gate, not a completed no-change claim`, () => {
  const value = input(); change(value); const plan = planSourceEvent(value);
  assert.equal(plan.outcome, "gated"); assert.equal(plan.gate_code, code);
});

test("unrelated issuers and metrics cause no research task", () => {
  const issuer = planSourceEvent(input(eventFixture(1, { issuers: ["UNTRACKED"] })));
  const metricInput = input(); metricInput.policy.metric_definition_ids = ["unrelated_metric"];
  assert.equal(issuer.outcome, "ignored"); assert.equal(issuer.reason, "UNRELATED_EVENT");
  assert.equal(planSourceEvent(metricInput).outcome, "ignored");
});

test("unchanged bytes need a matching source, period, parser, and a retained prior source", () => {
  const value = input(); value.previous_source = eventFixture(); value.event.event_kind = "OBSERVATION_NO_CHANGE";
  assert.equal(planSourceEvent(value).reason, "SOURCE_BYTES_UNCHANGED");
  for (const field of ["source_id", "source_period", "artifact_sha256"]) {
    const changed = structuredClone(value); changed.previous_source.artifact[field] = "different";
    assert.equal(planSourceEvent(changed).gate_code, "NO_CHANGE_UNVERIFIED");
  }
});

test("legal multi-issuer corrections use the shared core and require complete context", () => {
  const a = eventFixture(1, { issuers: ["LITE", "2345"] });
  const b = eventFixture(2, { kind: "CORRECTED_PERIOD", parent: a.event.source_event_id, issuers: ["LITE", "2345"] });
  const value = { ...input(b), retained_events: [a.event], lineage_context: { artifacts: [a.artifact, b.artifact], facts: [...a.facts, ...b.facts] } };
  assert.equal(planSourceEvent(value).outcome, "queue");
  assert.equal(planSourceEvent({ ...value, lineage_context: undefined }).gate_code, "CORRECTION_REVIEW_REQUIRED");
  assert.equal(planSourceEvent({ ...value, retained_events: [] }).gate_code, "CORRECTION_REVIEW_REQUIRED");
  const changed = structuredClone(value); changed.lineage_context.facts[0].definition_version = "other-definition";
  assert.equal(planSourceEvent(changed).gate_code, "CORRECTION_REVIEW_REQUIRED");
});

test("public correction context cannot replace actual facts or bypass retained record validation", () => {
  const a = eventFixture(); const b = eventFixture(2, { kind: "CORRECTED_PERIOD", parent: a.event.source_event_id });
  const value = { ...input(b), retained_events: [a.event], lineage_context: { artifacts: [a.artifact, b.artifact], facts: [...a.facts, ...b.facts] } };
  const forged = structuredClone(value); forged.facts[0].definition_version = "changed-definition";
  assert.equal(planSourceEvent(forged).gate_code, "CORRECTION_REVIEW_REQUIRED");
  for (const change of [
    (current) => { current.retained_events[0].event_kind = "THIS_IS_NOT_VALID"; },
    (current) => { current.retained_events[0].affected_fact_keys = null; },
    (current) => { current.lineage_context.artifacts[0].source_class = "invalid"; },
    (current) => { current.lineage_context.artifacts[1].source_period = "wrong"; },
  ]) { const current = structuredClone(value); change(current); assert.equal(planSourceEvent(current).gate_code, "CORRECTION_REVIEW_REQUIRED"); }
});

test("source policy and event fact conflicts reject unsupported or ambiguous input", () => {
  for (const change of [
    (value) => { value.rights_reference = null; }, (value) => { value.allowed_purposes = ["trading"]; },
    (value) => { value.allow_candidate_trials = "true"; }, (value) => { value.max_source_age_ms = Infinity; },
    (value) => { value.issuer_map = {}; }, (value) => { value.revision = 0; }, (value) => { value.extra = true; },
  ]) { const value = sourcePolicy(); change(value); assert.throws(() => validateSourcePolicy(value)); }
  const fixture = eventFixture(); assert.throws(() => verifyEventFacts(fixture.event, fixture.artifact, [fixture.facts[0], fixture.facts[0]]), { code: "FACT_CONTEXT_INVALID" });
  const wrong = structuredClone(fixture.facts[0]); wrong.source_event_id = "different";
  assert.throws(() => verifyEventFacts(fixture.event, fixture.artifact, [wrong]), { code: "FACT_CONTEXT_INVALID" });
  const changedIdentity = structuredClone(fixture.facts[0]); changedIdentity.identity.issuer_id = "other"; changedIdentity.fact_key = contentHash(changedIdentity.identity);
  assert.throws(() => verifyEventFacts(fixture.event, fixture.artifact, [changedIdentity]), { code: "FACT_CONTEXT_INVALID" });
  assert.throws(() => planSourceEvent({ ...input(), evaluation_at: "2026-02-30T00:00:00Z" }), { code: "EVENT_INPUT_INVALID" });
});
