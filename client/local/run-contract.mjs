import { createHash } from "node:crypto";

export const RUN_CONTRACT_VERSION = "1.0.0";
export const TRIAL_RUN_CONTRACT_VERSION = "1.1.0";
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STAGES = new Set(["chip", "memory", "rack", "network", "facility", "cooling", "power", "grid"]);
const THEMES = new Set(["ai_compute", "optical_cpo", "ai_power_thermal", "physical_ai", "space_infrastructure"]);

export class RunContractError extends Error {
  constructor(code, message) { super(message); this.name = "RunContractError"; this.code = code; }
}
const fail = (message) => { throw new RunContractError("INVALID_RUN_CONTRACT", message); };

// This uses the research-change-contract canonical format for JSON values.
export function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
    fail("Use JSON values only.");
  }
  if (ancestors.has(value) || ancestors.size > 64) fail("The JSON value contains a cycle or exceeds the depth limit.");
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail("Use a dense JSON array without extra fields.");
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) fail("Use a dense JSON array without extra fields.");
    }
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`
      : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}

export const contentHash = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const hash = (value) => { if (typeof value !== "string" || !SHA.test(value)) fail("Use a lowercase SHA-256 hash."); return value; };
const text = (value, max = 160) => {
  if (typeof value !== "string" || !value.length || value.length > max || value !== value.trim() ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) fail("Use a bounded printable identifier.");
  return value;
};
const object = (value, required, optional = []) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) {
    fail("The record contains missing or unsupported fields.");
  }
  return value;
};
const list = (value, min = 0, max = 1000) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail("The list has an invalid length.");
  return value;
};
const unique = (values) => {
  if (new Set(values).size !== values.length) fail("Remove duplicate identifiers.");
  return [...values].sort();
};
const timestamp = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("Use a valid UTC timestamp.");
  }
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) fail("Use a real calendar date.");
  return normalized;
};
const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export function publicScope(value) {
  object(value, ["watch_id", "revision", "theme_id", "symbols"], ["stage_id"]);
  if (typeof value.watch_id !== "string" || !UUID.test(value.watch_id) || !Number.isSafeInteger(value.revision) || value.revision < 1) fail("Use a watch UUID and a positive revision.");
  if (!THEMES.has(value.theme_id)) fail("Use a supported research theme.");
  if (value.stage_id !== undefined && (!STAGES.has(value.stage_id) || value.theme_id !== "ai_compute")) fail("A stage must belong to AI Compute.");
  const symbols = unique(list(value.symbols, 1, 20).map((symbol) => {
    if (typeof symbol !== "string") fail("Use company symbols only.");
    const normalized = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.^-]{0,29}$/.test(normalized)) fail("Use a valid company symbol.");
    return normalized;
  }));
  return { watch_id: value.watch_id.toLowerCase(), revision: value.revision, theme_id: text(value.theme_id, 80),
    ...(value.stage_id ? { stage_id: value.stage_id } : {}), symbols };
}

export function methodTrialIdentity(value) {
  object(value, ["plan_id", "plan_sha256", "case_id", "case_sha256", "candidate_id", "candidate_sha256", "role", "repetition", "runtime_policy_sha256"]);
  if (!["incumbent", "candidate"].includes(value.role) || !Number.isSafeInteger(value.repetition) || value.repetition < 1 || value.repetition > 10) {
    fail("Use a trial role and a repetition from one to ten.");
  }
  return { plan_id: text(value.plan_id), plan_sha256: hash(value.plan_sha256), case_id: text(value.case_id), case_sha256: hash(value.case_sha256),
    candidate_id: text(value.candidate_id), candidate_sha256: hash(value.candidate_sha256), role: value.role, repetition: value.repetition,
    runtime_policy_sha256: hash(value.runtime_policy_sha256) };
}
function basis(value) {
  object(value, ["scope", "method", "source_refs", "baselines", "evaluation_at", "local_context_sha256"], ["trial"]);
  const scope = publicScope(value.scope);
  object(value.method, ["bundle_version", "bundle_sha256", "profile_ids"]);
  const method = { bundle_version: text(value.method.bundle_version), bundle_sha256: hash(value.method.bundle_sha256),
    profile_ids: unique(list(value.method.profile_ids, 1, 20).map((id) => text(id))) };
  const sources = new Map();
  const source_refs = list(value.source_refs).map((ref) => {
    object(ref, ["source_event_id", "source_event_sha256", "source_artifact_id", "artifact_sha256"]);
    const parsed = { source_event_id: text(ref.source_event_id, 500), source_event_sha256: hash(ref.source_event_sha256),
      source_artifact_id: text(ref.source_artifact_id, 500), artifact_sha256: hash(ref.artifact_sha256) };
    if (sources.has(parsed.source_event_id)) fail("Use one immutable reference for each source event.");
    sources.set(parsed.source_event_id, parsed);
    return parsed;
  }).sort((a, b) => a.source_event_id < b.source_event_id ? -1 : 1);
  const baselineIds = new Set();
  const baselines = list(value.baselines, 0, 100).map((ref) => {
    // Reuse baselineReference field names. Do not infer a missing legacy hash.
    object(ref, ["owner", "pack_id", "pack_version", "output_sha256", "recorded_at"]);
    if (!["caller_local", "equitylayer_public"].includes(ref.owner)) fail("Use a supported baseline owner.");
    const parsed = { owner: ref.owner, pack_id: text(ref.pack_id), pack_version: text(ref.pack_version),
      output_sha256: hash(ref.output_sha256), recorded_at: timestamp(ref.recorded_at) };
    if (baselineIds.has(parsed.pack_id)) fail("Use one comparison baseline for each Pack.");
    baselineIds.add(parsed.pack_id);
    return parsed;
  }).sort((a, b) => a.pack_id < b.pack_id ? -1 : 1);
  return { contract_version: value.trial === undefined ? RUN_CONTRACT_VERSION : TRIAL_RUN_CONTRACT_VERSION, scope, method, source_refs, baselines,
    evaluation_at: timestamp(value.evaluation_at), local_context_sha256: hash(value.local_context_sha256),
    ...(value.trial === undefined ? {} : { trial: methodTrialIdentity(value.trial) }) };
}

export function createRunEnvelope(value) {
  const pinned = basis(value);
  const run_id = `el-run-${contentHash(pinned)}`;
  return freeze({ ...pinned, run_id, delivery_id: `el-delivery-${contentHash({ run_id })}` });
}

export function validateRunEnvelope(value) {
  object(value, ["contract_version", "scope", "method", "source_refs", "baselines", "evaluation_at", "local_context_sha256", "run_id", "delivery_id"], ["trial"]);
  if (value.contract_version !== (value.trial === undefined ? RUN_CONTRACT_VERSION : TRIAL_RUN_CONTRACT_VERSION)) fail("The run contract version does not match its execution purpose.");
  const { contract_version: ignored, run_id, delivery_id, ...input } = value;
  const expected = createRunEnvelope(input);
  if (run_id !== expected.run_id || delivery_id !== expected.delivery_id) {
    throw new RunContractError("RUN_IDENTITY_CONFLICT", "The run ID does not match its pinned inputs.");
  }
  return expected;
}

export function publicBeginArguments(envelope) {
  // No private context, local hash, baseline text, sources, or run IDs leave the caller.
  const parsed = validateRunEnvelope(envelope);
  if (parsed.trial) throw new RunContractError("LOCAL_TRIAL_ONLY", "Method trials cannot use the shared research endpoint.");
  return publicScope(parsed.scope);
}

export function legacyResultProvenance(result) {
  return freeze({ status: "unknown", original_result_sha256: contentHash(result), method: null, source_refs: null, run_id: null });
}
