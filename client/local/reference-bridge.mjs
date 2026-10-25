import { createHash } from "node:crypto";
import { canonicalJson, contentHash } from "./run-contract.mjs";

const SHA = /^[a-f0-9]{64}$/;
const STAGES = new Set(["chip", "memory", "rack", "network", "facility", "cooling", "power", "grid"]);
const SOURCE_CLASSES = new Set(["regulatory_filing", "exchange_dataset", "issuer_release", "issuer_presentation", "issuer_call_material", "consensus_vendor_snapshot"]);
const EVENT_KINDS = new Set(["NEW_PERIOD", "CORRECTED_PERIOD", "LATE_SOURCE_ARRIVED", "OBSERVATION_NO_CHANGE", "SCHEMA_CHANGE", "NO_DATA"]);
const REF_FIELDS = ["source_event_id", "source_event_sha256", "source_artifact_id", "artifact_sha256"];
const METHOD_FIELDS = ["bundle_version", "bundle_sha256", "profile_ids"];

export class ReferenceBridgeError extends Error {
  constructor(code, message) { super(message); this.name = "ReferenceBridgeError"; this.code = code; }
}
const fail = (code, message) => { throw new ReferenceBridgeError(code, message); };
const copy = (value, code) => {
  try { return JSON.parse(canonicalJson(value)); }
  catch { fail(code, "Use JSON records without cycles or unsupported values."); }
};
const record = (value, fields, code) => {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      fields.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !fields.includes(field))) {
    fail(code, "The record contains missing or unsupported fields.");
  }
};
const text = (value, code, max = 4096) => {
  if (typeof value !== "string" || !value.length || value.length > max || value !== value.trim() ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    fail(code, "Use bounded printable text without surrounding spaces.");
  }
};
const hash = (value, code) => { if (typeof value !== "string" || !SHA.test(value)) fail(code, "Use a lowercase SHA-256 hash."); };
const timestamp = (value, code) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(code, "Use a valid ISO timestamp with a timezone.");
  }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
      Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) {
    fail(code, "Use a real calendar date and time.");
  }
};
const strings = (value, code, min, max, itemMax = 4096) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(code, "The list has an invalid length.");
  value.forEach(item => text(item, code, itemMax));
};
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const sourceRef = (ref, code) => {
  record(ref, REF_FIELDS, code);
  text(ref.source_event_id, code, 500); text(ref.source_artifact_id, code, 500);
  hash(ref.source_event_sha256, code); hash(ref.artifact_sha256, code);
};
const methodRef = (method, code) => {
  record(method, METHOD_FIELDS, code);
  text(method.bundle_version, code, 160); hash(method.bundle_sha256, code);
  strings(method.profile_ids, code, 1, 20, 160);
  if (new Set(method.profile_ids).size !== method.profile_ids.length) fail(code, "Remove duplicate profile IDs.");
};

// These checks prove byte and record integrity only. They do not prove source truth, rights, or correction lineage.
export function validateSourceArtifact(artifact) {
  const code = "INVALID_SOURCE_REFERENCE";
  const a = copy(artifact, code);
  record(a, ["source_artifact_id", "source_id", "source_class", "canonical_url", "published_at", "retrieved_at", "source_period", "content_type", "http_status", "byte_length", "artifact_sha256", "immutable_storage_key"], code);
  for (const field of ["source_artifact_id", "source_id"]) text(a[field], code, 500);
  for (const field of ["content_type", "immutable_storage_key", "canonical_url"]) text(a[field], code);
  if (!SOURCE_CLASSES.has(a.source_class)) fail(code, "Use a supported source class.");
  try { new URL(a.canonical_url); } catch { fail(code, "Use an absolute source URL."); }
  timestamp(a.retrieved_at, code);
  if (a.published_at !== null) timestamp(a.published_at, code);
  if (a.source_period !== null) text(a.source_period, code);
  if (!Number.isInteger(a.http_status) || a.http_status < 100 || a.http_status > 599) fail(code, "Use a valid HTTP status.");
  if (!Number.isSafeInteger(a.byte_length) || a.byte_length < 0) fail(code, "Use a nonnegative byte length.");
  hash(a.artifact_sha256, code);
  return a;
}

export function validateSourceEvent(event) {
  const code = "INVALID_SOURCE_REFERENCE"; const e = copy(event, code);
  record(e, ["source_event_id", "event_kind", "source_artifact_id", "adapter_version", "parser_version", "observed_at", "supersedes_source_event_id", "affected_fact_keys"], code);
  for (const field of ["source_event_id", "source_artifact_id"]) text(e[field], code, 500);
  for (const field of ["adapter_version", "parser_version"]) text(e[field], code, 160);
  if (!EVENT_KINDS.has(e.event_kind)) fail(code, "Use a supported source event kind.");
  timestamp(e.observed_at, code);
  if (e.supersedes_source_event_id !== null) text(e.supersedes_source_event_id, code, 500);
  if (e.supersedes_source_event_id === e.source_event_id || (e.event_kind === "CORRECTED_PERIOD" && e.supersedes_source_event_id === null)) {
    fail(code, "A correction must reference another source event.");
  }
  strings(e.affected_fact_keys, code, 0, 10000, 64);
  e.affected_fact_keys.forEach(key => hash(key, code));
  if (new Set(e.affected_fact_keys).size !== e.affected_fact_keys.length) fail(code, "Remove duplicate affected fact keys.");
  return e;
}

export function verifySourceMetadataReference(event, artifact, expectedRef) {
  const code = "INVALID_SOURCE_REFERENCE";
  const e = validateSourceEvent(event); const a = validateSourceArtifact(artifact);
  if (e.source_artifact_id !== a.source_artifact_id) fail(code, "The event must reference this artifact ID.");
  const ref = { source_event_id: e.source_event_id, source_event_sha256: contentHash(e), source_artifact_id: a.source_artifact_id, artifact_sha256: a.artifact_sha256 };
  if (expectedRef !== undefined) {
    const expected = copy(expectedRef, code); sourceRef(expected, code);
    if (canonicalJson(expected) !== canonicalJson(ref)) fail("SOURCE_REFERENCE_CONFLICT", "The source reference does not match the pinned reference.");
  }
  return freeze(ref);
}

export function verifySourceReference(event, artifact, bytes, expectedRef) {
  const code = "INVALID_SOURCE_REFERENCE";
  const retainedArtifact = validateSourceArtifact(artifact);
  const ref = verifySourceMetadataReference(event, retainedArtifact, expectedRef);
  if (!(bytes instanceof Uint8Array)) fail(code, "Supply the retained artifact as bytes.");
  const retainedBytes = Buffer.from(bytes);
  if (retainedBytes.length !== retainedArtifact.byte_length || createHash("sha256").update(retainedBytes).digest("hex") !== ref.artifact_sha256) {
    fail(code, "The retained bytes do not match the artifact hash and length.");
  }
  return ref;
}

// Candidate profiles remain candidates. Hash checks do not approve a method or verify a company claim.
export function verifyMethodBundle(bundle, expectedMethod) {
  const code = "INVALID_METHOD_BUNDLE";
  const b = copy(bundle, code);
  record(b, ["version", "release_status", "execution_policy", "profiles", "content_sha256"], code);
  text(b.version, code, 160); text(b.execution_policy, code); hash(b.content_sha256, code);
  if (b.release_status !== "candidate") fail(code, "Use a candidate method bundle without promotion.");
  if (!Array.isArray(b.profiles) || b.profiles.length < 1 || b.profiles.length > 20) fail(code, "Use one to twenty evidence profiles.");
  const ids = new Set();
  for (const p of b.profiles) {
    record(p, ["profile_id", "version", "parent_theme_id", "stage_id", "title", "market_scope", "checks", "required_evidence", "counterevidence_checks", "trigger_types", "inference_limits", "curation_status", "verified_company_evidence", "selection_policy", "content_sha256"], code);
    text(p.profile_id, code, 160); text(p.title, code); text(p.selection_policy, code); hash(p.content_sha256, code);
    if (ids.has(p.profile_id)) fail(code, "Use one profile for each profile ID.");
    ids.add(p.profile_id);
    if (typeof p.version !== "string" || !/^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/.test(p.version) || p.parent_theme_id !== "ai_compute" || !STAGES.has(p.stage_id) ||
        p.curation_status !== "founder_review_required" || p.verified_company_evidence !== false) {
      fail(code, "Keep the supported candidate profile metadata.");
    }
    if (canonicalJson(p.market_scope) !== canonicalJson(["US", "TW", "JP", "KR"])) fail(code, "Keep the four-market profile scope.");
    for (const field of ["checks", "required_evidence", "counterevidence_checks", "trigger_types", "inference_limits"]) strings(p[field], code, 1, 100);
    const { content_sha256, ...content } = p;
    if (contentHash(content) !== content_sha256) fail(code, "The profile content does not match its hash.");
  }
  const { content_sha256, ...content } = b;
  if (contentHash(content) !== content_sha256) fail(code, "The method bundle does not match its hash.");
  const method = { bundle_version: b.version, bundle_sha256: b.content_sha256, profile_ids: [...ids].sort() };
  if (expectedMethod !== undefined) {
    const expected = copy(expectedMethod, code); methodRef(expected, code);
    expected.profile_ids.sort();
    if (canonicalJson(expected) !== canonicalJson(method)) fail("METHOD_REFERENCE_CONFLICT", "The method does not match the pinned reference.");
  }
  return freeze(method);
}
