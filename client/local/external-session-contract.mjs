import { canonicalJson, contentHash, createRunEnvelope } from "./run-contract.mjs";
import { verifyMethodBundle, verifySourceMetadataReference, verifySourceReference } from "./reference-bridge.mjs";
import { ExecutorError, validateCallerResponse } from "./executor.mjs";

export class ExternalSessionError extends Error {
  constructor(code) { super(code); this.name = "ExternalSessionError"; this.code = code; }
}
const fail = code => { throw new ExternalSessionError(code); };
const exact = (value, fields) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)) ||
      Object.keys(value).some(field => !fields.includes(field)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !Object.hasOwn(descriptor, "value"))) {
    fail("EXTERNAL_SESSION_INPUT_INVALID");
  }
};
function dataOnly(value, ancestors = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value) || ancestors.size > 64 ||
      Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) fail("EXTERNAL_SESSION_INPUT_INVALID");
  ancestors.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, "value")) fail("EXTERNAL_SESSION_INPUT_INVALID");
    dataOnly(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
const copy = value => {
  try {
    dataOnly(value);
    const text = canonicalJson(value);
    if (Buffer.byteLength(text) > 2_000_000) fail("EXTERNAL_SESSION_INPUT_LIMIT");
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ExternalSessionError) throw error;
    fail("EXTERNAL_SESSION_INPUT_INVALID");
  }
};
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const text = (value, max) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) fail("EXTERNAL_SESSION_INPUT_INVALID");
  return value;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const contextFields = ["schema_version", "kind", "preparation_id", "scope", "method_bundle", "source_records", "baselines", "evaluation_at", "local_context_sha256"];

function contextBody(value) {
  exact(value, contextFields);
  value = copy(value);
  if (![1, 2].includes(value.schema_version) || value.kind !== "external_session_context" || typeof value.preparation_id !== "string" || !UUID.test(value.preparation_id) ||
      !Array.isArray(value.source_records) || value.source_records.length > 30) fail("EXTERNAL_SESSION_CONTEXT_INVALID");
  const method = verifyMethodBundle(value.method_bundle);
  const records = value.source_records.map(source => {
    exact(source, ["event", "artifact"]);
    verifySourceMetadataReference(source.event, source.artifact);
    const url = new URL(source.artifact.canonical_url);
    if (url.protocol !== "https:" || url.username || url.password) fail("EXTERNAL_SESSION_CONTEXT_INVALID");
    return copy(source);
  }).sort((left, right) => left.event.source_event_id < right.event.source_event_id ? -1 : left.event.source_event_id > right.event.source_event_id ? 1 : 0);
  // Reuse scope, method, source, baseline, and time rules. Discard all runner identities.
  const pinned = createRunEnvelope({ scope: value.scope, method,
    source_refs: records.map(source => verifySourceMetadataReference(source.event, source.artifact)),
    baselines: value.baselines, evaluation_at: value.evaluation_at, local_context_sha256: value.local_context_sha256 });
  if (records.some(source => Date.parse(source.artifact.retrieved_at) > Date.parse(pinned.evaluation_at) ||
      source.artifact.published_at !== null && Date.parse(source.artifact.published_at) > Date.parse(pinned.evaluation_at) ||
      Date.parse(source.event.observed_at) > Date.parse(pinned.evaluation_at))) fail("EXTERNAL_SESSION_CONTEXT_INVALID");
  return copy({ schema_version: value.schema_version, kind: "external_session_context", preparation_id: value.preparation_id.toLowerCase(), scope: pinned.scope, method_bundle: value.method_bundle,
    source_records: records, baselines: pinned.baselines, evaluation_at: pinned.evaluation_at,
    local_context_sha256: pinned.local_context_sha256 });
}

// The caller must check current source permission and scope before creation and submission.
// Integrity checks do not grant source rights or authenticate the external session.
export function createExternalSessionContext(input) {
  exact(input, ["preparation_id", "scope", "method_bundle", "source_records", "baselines", "evaluation_at", "local_context_sha256"]);
  if (!Array.isArray(input.source_records) || Object.getPrototypeOf(input.source_records) !== Array.prototype ||
      input.source_records.length > 30 || Object.keys(input.source_records).length !== input.source_records.length ||
      Object.values(Object.getOwnPropertyDescriptors(input.source_records)).some(descriptor => !Object.hasOwn(descriptor, "value"))) {
    fail("EXTERNAL_SESSION_CONTEXT_INVALID");
  }
  const records = Array.prototype.map.call(input.source_records, source => {
    exact(source, ["event", "artifact", "bytes"]);
    const metadata = copy({ event: source.event, artifact: source.artifact });
    verifySourceReference(metadata.event, metadata.artifact, source.bytes);
    return metadata;
  });
  const body = contextBody({ ...input, source_records: records, schema_version: 2, kind: "external_session_context" });
  const sha256 = contentHash(body);
  return freeze({ ...body, context_id: `el-session-context-${sha256}`, context_sha256: sha256 });
}

export function validateExternalSessionContext(input) {
  exact(input, [...contextFields, "context_id", "context_sha256"]);
  const { context_id, context_sha256, ...value } = input;
  const body = contextBody(value), sha256 = contentHash(body);
  if (context_sha256 !== sha256 || context_id !== `el-session-context-${sha256}`) fail("EXTERNAL_SESSION_CONTEXT_CONFLICT");
  return freeze({ ...body, context_id, context_sha256 });
}

// Dates describe retained metadata. They do not prove publication or claim support.
export function externalSessionCitationDates(retainedContext) {
  const context = validateExternalSessionContext(retainedContext);
  return freeze(context.source_records.map(({ event, artifact }) => ({ source_event_id: event.source_event_id,
    artifact_sha256: artifact.artifact_sha256, url: artifact.canonical_url,
    date: new Date(artifact.published_at ?? artifact.retrieved_at).toISOString().slice(0, 10),
    basis: artifact.published_at === null ? "retained_retrieval" : "declared_publication" })));
}

// This returns a validation value only. It writes no record and settles no usage.
export function validateExternalSessionSubmission(input, retainedContext) {
  const context = validateExternalSessionContext(retainedContext);
  exact(input, ["schema_version", "context_id", "submission_id", "session", "agent_fields"]);
  if (input.schema_version !== 1 || input.context_id !== context.context_id) fail("EXTERNAL_SESSION_CONTEXT_CONFLICT");
  if (typeof input.submission_id !== "string" || !UUID.test(input.submission_id)) {
    fail("EXTERNAL_SESSION_INPUT_INVALID");
  }
  exact(input.session, ["client", "model", "session_reference"]);
  const session = Object.fromEntries(Object.entries(input.session).map(([key, value]) => [key, text(value, key === "session_reference" ? 200 : 160)]));
  const submission_id = input.submission_id.toLowerCase();
  const resultIdentity = contentHash({ kind: "external_session_result", context_id: context.context_id, submission_id });
  let result;
  try {
    result = validateCallerResponse({ agent_fields: copy(input.agent_fields), usage: null },
      { envelope: { scope: context.scope, baselines: context.baselines }, created_at: context.evaluation_at,
        sources: context.source_records }, resultIdentity);
  } catch (error) {
    if (error instanceof ExecutorError) fail(error.code);
    throw error;
  }
  const dates = context.schema_version === 2 ? externalSessionCitationDates(context) : null;
  const sourceDates = dates === null ? null : result.sources.map((citation, citation_index) => {
    const matches = dates.filter(item => item.url === citation.url && item.date === citation.date);
    if (!matches.length) fail("EXTERNAL_SESSION_SOURCE_DATE_INVALID");
    return { citation_index, matches };
  });
  const body = copy({ schema_version: context.schema_version, kind: "external_session_record", submission_id, context_id: context.context_id,
    context_sha256: context.context_sha256, session, result,
    ...(sourceDates === null ? {} : { source_dates: sourceDates }),
    verification: { session_identity: "caller_declared", usage: "unverified", source_authenticity: "not_verified",
      research_quality: "not_verified" } });
  return freeze({ ...body, record_id: `el-external-${contentHash({ submission_id, context_id: context.context_id })}`,
    content_sha256: contentHash(body) });
}

export function validateExternalSessionPreparation(input) {
  exact(input, ["preparation_id", "watch_id", "revision", "method_sha256", "source_event_ids"]);
  const value = copy(input);
  if (typeof value.preparation_id !== "string" || !UUID.test(value.preparation_id) || typeof value.watch_id !== "string" || !UUID.test(value.watch_id) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.method_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.method_sha256) ||
      !Array.isArray(value.source_event_ids) || value.source_event_ids.length > 30 ||
      new Set(value.source_event_ids).size !== value.source_event_ids.length) fail("EXTERNAL_SESSION_INPUT_INVALID");
  value.source_event_ids.forEach(id => text(id, 500));
  return freeze({ ...value, preparation_id: value.preparation_id.toLowerCase(), watch_id: value.watch_id.toLowerCase(),
    source_event_ids: [...value.source_event_ids].sort() });
}
