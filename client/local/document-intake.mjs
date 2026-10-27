import { createHash } from "node:crypto";
import { canonicalJson, contentHash } from "./run-contract.mjs";
import { verifySourceReference } from "./reference-bridge.mjs";
import { validateSourcePolicy } from "./source-event-plan.mjs";
import { buildRetainedSourceContent } from "./source-content.mjs";

export class DocumentError extends Error {
  constructor(code) { super(code); this.name = "DocumentError"; this.code = code; }
}
const fail = code => { throw new DocumentError(code); };
const VERSION = "local-document-1";
const FIELDS = ["canonical_url", "source_class", "symbols", "retrieved_at", "published_at", "source_period", "content_type",
  "http_status", "rights_status", "rights_reference", "allow_candidate_trials", "max_source_age_days"];

// A local declaration is not an authenticated retrieval or a commercial-use approval.
export function documentPlan(metadata, bytes, scope, observedAt, confirmLocalUse = false) {
  if (!metadata || Object.getPrototypeOf(metadata) !== Object.prototype || Object.keys(metadata).sort().join() !== [...FIELDS].sort().join()) fail("DOCUMENT_METADATA_INVALID");
  const m = JSON.parse(canonicalJson(metadata));
  let url;
  try { url = new URL(m.canonical_url); } catch { fail("DOCUMENT_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== m.canonical_url) fail("DOCUMENT_URL_INVALID");
  if (!Array.isArray(m.symbols) || !m.symbols.length || new Set(m.symbols).size !== m.symbols.length ||
      m.symbols.some(symbol => !scope.symbols.includes(symbol))) fail("DOCUMENT_SCOPE_CONFLICT");
  if (!Number.isInteger(m.max_source_age_days) || m.max_source_age_days < 1 || m.max_source_age_days > 366 ||
      !["HOLD", "UNKNOWN", "ALLOWED"].includes(m.rights_status) || typeof m.allow_candidate_trials !== "boolean") fail("DOCUMENT_METADATA_INVALID");
  if (m.rights_status === "ALLOWED" && confirmLocalUse !== true) fail("DOCUMENT_LOCAL_USE_CONFIRMATION_REQUIRED");
  if (m.rights_status !== "ALLOWED" && (m.allow_candidate_trials || m.rights_reference !== null)) fail("DOCUMENT_METADATA_INVALID");
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 2_000_000) fail("DOCUMENT_CONTENT_INVALID");
  const sourceId = `local-document-${contentHash({ canonical_url: m.canonical_url })}`;
  const digest = createHash("sha256").update(bytes).digest("hex");
  const identity = contentHash({ source_id: sourceId, source_class: m.source_class, retrieved_at: m.retrieved_at,
    published_at: m.published_at, source_period: m.source_period, content_type: m.content_type, http_status: m.http_status, artifact_sha256: digest });
  const artifact = { source_artifact_id: `local-document-artifact-${identity}`, source_id: sourceId, source_class: m.source_class,
    canonical_url: m.canonical_url, retrieved_at: m.retrieved_at, published_at: m.published_at, source_period: m.source_period,
    content_type: m.content_type, http_status: m.http_status, byte_length: bytes.length, artifact_sha256: digest,
    immutable_storage_key: `local-document/${digest}` };
  const event = { source_event_id: `local-document-event-${identity}`, event_kind: "LATE_SOURCE_ARRIVED",
    source_artifact_id: artifact.source_artifact_id, adapter_version: VERSION, parser_version: VERSION,
    observed_at: observedAt, supersedes_source_event_id: null, affected_fact_keys: [] };
  const reference = verifySourceReference(event, artifact, bytes);
  if (Date.parse(m.retrieved_at) > Date.parse(observedAt) || m.published_at !== null && Date.parse(m.published_at) > Date.parse(m.retrieved_at)) fail("DOCUMENT_TIME_INVALID");
  if (buildRetainedSourceContent({ event, artifact, bytes }).status !== "included") fail("DOCUMENT_CONTENT_INVALID");
  const policy = validateSourcePolicy({ schema_version: 1, revision: 1, source_id: sourceId, rights_status: m.rights_status,
    rights_reference: m.rights_reference, allowed_purposes: m.rights_status === "ALLOWED" ? ["local_research"] : [],
    adapter_version: VERSION, parser_version: VERSION, issuer_map: Object.fromEntries([...m.symbols].sort().map(symbol => [symbol, symbol])),
    metric_definition_ids: ["unparsed_retained_document"], allowed_evidence_states: ["PROVISIONAL"],
    max_source_age_ms: m.max_source_age_days * 86400000, allow_candidate_trials: m.allow_candidate_trials });
  return { event, artifact, reference, policy };
}
