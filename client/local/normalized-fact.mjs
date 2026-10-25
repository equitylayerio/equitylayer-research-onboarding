import { canonicalJson, contentHash } from "./run-contract.mjs";
import { types } from "node:util";

export const NORMALIZED_FACT_MAX_BYTES = 2_000_000;
export const NORMALIZED_FACT_MAX_TEXT_LENGTH = 65_536;
export const NORMALIZED_FACT_MAX_DIMENSIONS = 1_000;
const SHA = /^[a-f0-9]{64}$/;
const MARKETS = ["US", "TW", "JP", "KR", "GLOBAL"];
const LAYERS = ["actual", "guidance", "consensus", "management_claim", "derived", "inference", "unknown"];
const STATES = ["VERIFIED", "PROVISIONAL", "WAITING", "STALE", "CONFLICTED", "RETRACTED"];
const SCALES = ["ones", "thousands", "millions", "billions", "percent"];
const BASES = ["GAAP", "NON_GAAP", "SOURCE_REPORTED"];
const IDENTITY_FIELDS = ["issuer_id", "market", "metric_definition_id", "evidence_layer", "period_start", "period_end",
  "fiscal_period", "currency", "unit_scale", "accounting_basis", "dimensions"];
const FACT_FIELDS = ["fact_key", "fact_revision_id", "identity", "value", "value_type", "source_event_id",
  "source_artifact_sha256", "exact_locator", "source_url", "reported_at", "normalized_at", "definition_version",
  "parser_version", "evidence_state", "limitation"];

/** @typedef {"actual"|"guidance"|"consensus"|"management_claim"|"derived"|"inference"|"unknown"} EvidenceLayer */
/**
 * @typedef {object} FactIdentity
 * @property {string} issuer_id
 * @property {"US"|"TW"|"JP"|"KR"|"GLOBAL"} market
 * @property {string} metric_definition_id
 * @property {EvidenceLayer} evidence_layer
 * @property {string|null} period_start
 * @property {string|null} period_end
 * @property {string|null} fiscal_period
 * @property {string|null} currency
 * @property {"ones"|"thousands"|"millions"|"billions"|"percent"|null} unit_scale
 * @property {"GAAP"|"NON_GAAP"|"SOURCE_REPORTED"|null} accounting_basis
 * @property {Record<string, string>} dimensions
 */
/**
 * @typedef {object} NormalizedFact
 * @property {string} fact_key
 * @property {string} fact_revision_id
 * @property {FactIdentity} identity
 * @property {number|string|boolean|null} value
 * @property {"number"|"string"|"boolean"|"missing"} value_type
 * @property {string} source_event_id
 * @property {string} source_artifact_sha256
 * @property {string} exact_locator
 * @property {string} source_url
 * @property {string|null} reported_at
 * @property {string} normalized_at
 * @property {string} definition_version
 * @property {string} parser_version
 * @property {"VERIFIED"|"PROVISIONAL"|"WAITING"|"STALE"|"CONFLICTED"|"RETRACTED"} evidence_state
 * @property {string} limitation
 */

export class NormalizedFactError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "NormalizedFactError";
    /** @type {"INVALID_NORMALIZED_FACT"} */
    this.code = "INVALID_NORMALIZED_FACT";
  }
}
const fail = message => { throw new NormalizedFactError(message); };

// Read data properties only. Text remains data throughout validation.
function copyInput(input) {
  const ancestors = new Set();
  let nodes = 0;
  let textBytes = 0;
  const copy = (value, depth = 0) => {
    if (++nodes > 4_096 || depth > 4) fail("The fact exceeds the structure limit.");
    if (typeof value === "string") {
      if (value.length > NORMALIZED_FACT_MAX_TEXT_LENGTH) fail("The text exceeds the length limit.");
      textBytes += Buffer.byteLength(value);
      if (textBytes > NORMALIZED_FACT_MAX_BYTES) fail("The fact exceeds the size limit.");
      return value;
    }
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    if (!value || typeof value !== "object" || types.isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype || ancestors.has(value)) {
      fail("Use JSON records without cycles or unsupported values.");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 1_000) fail("The record exceeds the field limit.");
    ancestors.add(value);
    try {
      return Object.fromEntries(keys.map(key => {
        if (typeof key !== "string") fail("Use string field names only.");
        copy(key, depth + 1);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("Use enumerable data fields only.");
        return [key, copy(descriptor.value, depth + 1)];
      }));
    } finally { ancestors.delete(value); }
  };
  const result = copy(input);
  if (Buffer.byteLength(canonicalJson(result)) > NORMALIZED_FACT_MAX_BYTES) fail("The fact exceeds the size limit.");
  return result;
}

const record = (value, fields) => {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype ||
      fields.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !fields.includes(field))) {
    fail("The record contains missing or unsupported fields.");
  }
};
const text = (value, allowEmpty = false) => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail("Use a text value with the required length.");
};
const enumeration = (value, values) => { if (!values.includes(value)) fail("Use a supported field value."); };
const hash = value => { if (typeof value !== "string" || !SHA.test(value)) fail("Use a lowercase SHA-256 hash."); };
const timestamp = value => {
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) fail("Use a valid ISO timestamp with a timezone.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail("Use a real calendar date.");
};
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

/**
 * Check the public fact shape and identity hash. Return an immutable copy.
 * This checks the revision ID format only. It does not check source truth or revision content.
 * @param {unknown} input
 * @returns {NormalizedFact}
 * @throws {NormalizedFactError}
 */
export function validateNormalizedFact(input) {
  const fact = copyInput(input);
  record(fact, FACT_FIELDS);
  const identity = fact.identity;
  record(identity, IDENTITY_FIELDS);
  text(identity.issuer_id); text(identity.metric_definition_id);
  enumeration(identity.market, MARKETS); enumeration(identity.evidence_layer, LAYERS);
  for (const field of ["period_start", "period_end", "fiscal_period", "currency"]) {
    if (identity[field] !== null) text(identity[field]);
  }
  if (identity.unit_scale !== null) enumeration(identity.unit_scale, SCALES);
  if (identity.accounting_basis !== null) enumeration(identity.accounting_basis, BASES);
  if (!identity.dimensions || typeof identity.dimensions !== "object" ||
      Object.getPrototypeOf(identity.dimensions) !== Object.prototype ||
      Object.keys(identity.dimensions).length > NORMALIZED_FACT_MAX_DIMENSIONS) fail("Use a bounded dimensions record.");
  Object.values(identity.dimensions).forEach(value => text(value, true));
  for (const field of ["fact_key", "fact_revision_id", "source_artifact_sha256"]) hash(fact[field]);
  for (const field of ["source_event_id", "exact_locator", "definition_version", "parser_version", "source_url"]) text(fact[field]);
  try { new URL(fact.source_url); } catch { fail("Use an absolute source URL."); }
  if (fact.reported_at !== null) timestamp(fact.reported_at);
  timestamp(fact.normalized_at);
  enumeration(fact.value_type, ["number", "string", "boolean", "missing"]);
  enumeration(fact.evidence_state, STATES);
  text(fact.limitation, true);
  if (fact.value !== null && typeof fact.value !== "string" && typeof fact.value !== "boolean" &&
      !(typeof fact.value === "number" && Number.isFinite(fact.value))) fail("Use a finite number, text, boolean, or null value.");
  if (fact.fact_key !== contentHash(identity)) fail("The fact key does not match the fact identity.");
  if (fact.value_type === "missing" && fact.value !== null) fail("A missing fact must have a null value.");
  if (identity.evidence_layer === "unknown" && fact.value_type !== "missing") fail("An unknown fact must use the missing value type.");
  return freeze(fact);
}
