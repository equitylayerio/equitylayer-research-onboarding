import { createHash } from "node:crypto";
import { contentHash, createRunEnvelope } from "../../client/local/run-contract.mjs";

export const scope = (revision = 1) => ({ watch_id: "8713bba6-e91e-4c1a-b756-2b18d2b7c775", revision,
  theme_id: "optical_cpo", symbols: ["000660.KS", "2345.TW", "6701.T", "LITE"] });
export const context = () => ({ question: "Synthetic local research question.", trigger: "Synthetic release." });
export function methodBundle() {
  const profile = { profile_id: "synthetic-cpo-test", version: "0.1.0", parent_theme_id: "ai_compute", stage_id: "network",
    title: "Synthetic method fixture", market_scope: ["US", "TW", "JP", "KR"], checks: ["Check a synthetic disclosure."],
    required_evidence: ["Retain source bytes."], counterevidence_checks: ["Check missing evidence."],
    trigger_types: ["Synthetic event"], inference_limits: ["This fixture makes no company claim."],
    curation_status: "founder_review_required", verified_company_evidence: false, selection_policy: "Keep selected companies." };
  profile.content_sha256 = contentHash(profile);
  const bundle = { version: "test-1", release_status: "candidate", execution_policy: "Local candidate test only.", profiles: [profile] };
  bundle.content_sha256 = contentHash(bundle);
  return bundle;
}
export function source(number = 1) {
  const bytes = Buffer.from(JSON.stringify({ synthetic_value: number }));
  const artifact = { source_artifact_id: `artifact-${number}`, source_id: "synthetic-exchange", source_class: "exchange_dataset",
    canonical_url: "https://example.test/source", published_at: null, retrieved_at: "2026-10-11T00:00:00Z", source_period: "2026-09",
    content_type: "application/json", http_status: 200, byte_length: bytes.length,
    artifact_sha256: createHash("sha256").update(bytes).digest("hex"), immutable_storage_key: `raw/source-${number}.json` };
  const event = { source_event_id: `event-${number}`, event_kind: "NEW_PERIOD", source_artifact_id: artifact.source_artifact_id,
    adapter_version: "1", parser_version: "1", observed_at: "2026-10-11T00:00:00Z", supersedes_source_event_id: null,
    affected_fact_keys: [contentHash({ synthetic_fact: number })] };
  return { bytes, artifact, event };
}
export const limits = () => ({ requests: 100, tokens: 100_000, cost_microusd: 1_000_000, wall_ms: 1_000_000 });
export const estimate = () => ({ tokens: 1000, cost_microusd: 1000, wall_ms: 1000 });
export function setup(ledger, number = 1, revision = 1) {
  const saved = ledger.saveRevision(scope(revision), context());
  const method = ledger.retainMethod(methodBundle());
  const { event, artifact, bytes } = source(number);
  const reference = ledger.retainSource(event, artifact, bytes);
  ledger.configureBudget(scope().watch_id, "test-window", limits());
  return createRunEnvelope({ scope: saved.scope, method, source_refs: [reference], baselines: [],
    evaluation_at: new Date(Date.UTC(2026, 9, 11, 0, 0, number)).toISOString(), local_context_sha256: saved.local_context_sha256 });
}
export const policy = () => ({ max_attempts: 3, max_wall_ms: 100_000, not_before: 0 });
export const result = (envelope, state = "REVIEW_REQUIRED") => ({ schema_version: 1, result_id: "11111111-1111-4111-8111-111111111111",
  watch_id: envelope.scope.watch_id, scope_revision: envelope.scope.revision, theme_id: envelope.scope.theme_id, symbols: envelope.scope.symbols,
  result_state: state, summary: "Synthetic research result, not investment evidence.",
  sources: state === "SOURCE_NEEDED" ? [] : [{ url: "https://example.test/source", date: "2026-10-11", kind: "reported_fact", claim: "Synthetic claim." }],
  drivers: [], falsifiers: [], unknowns: [], created_at: "2026-10-11T00:00:00Z", next_check_at: "2026-10-12T00:00:00Z" });
