import { createHash } from "node:crypto";
import { contentHash } from "../../client/local/run-contract.mjs";
import { scope, context, methodBundle, limits, policy } from "./local-research.mjs";

export const evaluationAt = "2026-10-12T00:00:00Z";
export function sourcePolicy(revision = 1) {
  return { schema_version: 1, revision, source_id: "synthetic-exchange", rights_status: "ALLOWED",
    rights_reference: "Synthetic test policy. No real source right granted.", allowed_purposes: ["local_research"],
    adapter_version: "1", parser_version: "1", issuer_map: { LITE: "LITE", "2345.TW": "2345", "6701.T": "6701", "000660.KS": "000660" },
    metric_definition_ids: ["synthetic_metric"], allowed_evidence_states: ["VERIFIED"], max_source_age_ms: 7 * 86400_000, allow_candidate_trials: true };
}
export function eventFixture(number = 1, { kind = "NEW_PERIOD", parent = null, sourceId = "synthetic-exchange", period = "2026-09", issuers = ["LITE"] } = {}) {
  const bytes = Buffer.from(JSON.stringify({ synthetic: number, issuers }));
  const artifact = { source_artifact_id: `event-artifact-${number}`, source_id: sourceId, source_class: "exchange_dataset",
    canonical_url: "https://example.test/events", published_at: null, retrieved_at: "2026-10-11T00:00:00Z", source_period: period,
    content_type: "application/json", http_status: 200, byte_length: bytes.length, artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
    immutable_storage_key: `synthetic/event-${number}.json` };
  const facts = issuers.map((issuer) => {
    const identity = { issuer_id: issuer, market: issuer === "LITE" ? "US" : issuer === "2345" ? "TW" : issuer === "6701" ? "JP" : "KR",
      metric_definition_id: "synthetic_metric", evidence_layer: "actual", period_start: "2026-09-01", period_end: "2026-09-30",
      fiscal_period: period, currency: "USD", unit_scale: "ones", accounting_basis: "SOURCE_REPORTED", dimensions: {} };
    return { fact_key: contentHash(identity), fact_revision_id: contentHash({ issuer, number }), identity, value: number, value_type: "number",
      source_event_id: `source-event-${number}`, source_artifact_sha256: artifact.artifact_sha256, exact_locator: `Synthetic row ${issuer}`,
      source_url: artifact.canonical_url, reported_at: null, normalized_at: evaluationAt, definition_version: "test-1", parser_version: "1",
      evidence_state: "VERIFIED", limitation: "Synthetic test fact, not investment evidence." };
  });
  const event = { source_event_id: `source-event-${number}`, event_kind: kind, source_artifact_id: artifact.source_artifact_id,
    adapter_version: "1", parser_version: "1", observed_at: "2026-10-11T00:00:00Z", supersedes_source_event_id: parent,
    affected_fact_keys: facts.map((fact) => fact.fact_key) };
  return { event, artifact, bytes, facts };
}
export function configureEventWatch(ledger, { configurePolicy = true, configureBudget = true } = {}) {
  ledger.saveRevision(scope(), context()); const method = ledger.retainMethod(methodBundle());
  if (configurePolicy) ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  if (configureBudget) ledger.configureBudget(scope().watch_id, "event-window", limits());
  return method;
}
export const intake = (method, fixture = eventFixture()) => ({ ...fixture, watch_id: scope().watch_id,
  method_sha256: method.bundle_sha256, evaluation_at: evaluationAt, budget_window: "event-window", run_policy: policy() });
