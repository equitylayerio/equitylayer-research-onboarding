import { canonicalJson, publicScope } from "./run-contract.mjs";

export class ResultFileError extends Error {
  constructor(message) { super(message); this.name = "ResultFileError"; this.code = "RESULT_INVALID"; }
}
export const RESULT_UTC_TIMESTAMP_PATTERN = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$`;
const utcTimestamp = new RegExp(RESULT_UTC_TIMESTAMP_PATTERN);
const issues = new WeakMap();
// Only validator-created failures carry these fixed labels. Never copy an error message or submitted value.
export const resultValidationIssue = error => {
  const issue = issues.get(error);
  return issue ? { ...issue } : null;
};
const fail = (message, field = null, rule = null) => {
  const error = new ResultFileError(message);
  if (field !== null) issues.set(error, Object.freeze({ field, rule }));
  throw error;
};
const record = (value, required, optional = [], field = null) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => ![...required, ...optional].includes(key))) fail("The research record has missing or unsupported fields.", field, "FIELDS");
};
const text = (value, max, trim = true, field = null) => {
  if (typeof value !== "string") fail("Use bounded research text.", field, "TEXT_TYPE");
  const result = trim ? value.trim() : value;
  if (!result.length || result.length > max) fail("Use bounded nonempty research text.", field, "TEXT_LENGTH");
  return result;
};
const list = (value, max, parse, min = 0, field = null) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail("The research list has an invalid length.", field, "LIST_LENGTH");
  return value.map(parse);
};
const date = (value, field = null) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail("Use a real calendar date.", field, "CALENDAR_DATE");
  return value;
};
const timestamp = (value, offset = false, field = null) => {
  const pattern = offset ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
    : utcTimestamp;
  if (typeof value !== "string" || !pattern.test(value) || !Number.isFinite(Date.parse(value))) fail("Use a valid research timestamp.", field, "UTC_TIMESTAMP");
  date(value.slice(0, 10), field);
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || value[16] === ":" && Number(value.slice(17, 19)) > 59) fail("Use a real calendar time.", field, "CALENDAR_TIME");
  return value;
};
const symbol = (value) => {
  const normalized = text(value, 30).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.^-]{0,29}$/.test(normalized)) fail("Use a valid company symbol.");
  return normalized;
};

// This checks result-file structure. It does not verify financial claims or payment receipts.
export function validateResearchResultFile(input) {
  let value;
  try { value = JSON.parse(canonicalJson(input)); } catch { fail("Use a JSON research result without unsupported values."); }
  record(value, ["schema_version", "result_id", "watch_id", "scope_revision", "theme_id", "symbols", "created_at", "result_state",
    "summary", "sources", "drivers", "falsifiers", "unknowns", "next_check_at"], ["stage_id", "as_of_feed_day", "baseline", "purchase_records"]);
  if (value.schema_version !== 1 || typeof value.result_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.result_id)) fail("Use result schema version one and a result UUID.");
  let scope;
  try { scope = publicScope({ watch_id: value.watch_id, revision: value.scope_revision, theme_id: value.theme_id, symbols: value.symbols,
    ...(value.stage_id !== undefined ? { stage_id: value.stage_id } : {}) }); } catch { fail("Use a valid research scope."); }
  value.watch_id = scope.watch_id; value.symbols = scope.symbols;
  if (!["INITIAL_RESEARCH", "NO_NEW_EVIDENCE", "REVIEW_REQUIRED", "SOURCE_NEEDED"].includes(value.result_state)) fail("Use a supported result state.", "result_state", "RESULT_STATE");
  value.summary = text(value.summary, 3000, true, "summary");
  timestamp(value.created_at); timestamp(value.next_check_at, false, "next_check_at");
  if (value.as_of_feed_day !== undefined) date(value.as_of_feed_day);
  value.sources = list(value.sources, 30, (source, index) => {
    const field = `sources[${index}]`;
    record(source, ["url", "date", "claim", "kind"], [], field);
    const urlText = text(source.url, 2000, false, `${field}.url`); let url;
    try { url = new URL(urlText); } catch { fail("Use a valid HTTPS source URL.", `${field}.url`, "HTTPS_URL"); }
    if (url.protocol !== "https:" || url.username || url.password) fail("Use HTTPS sources without credentials.", `${field}.url`, "HTTPS_URL");
    if (!["reported_fact", "management_claim", "inference"].includes(source.kind)) fail("Use a supported source evidence kind.", `${field}.kind`, "EVIDENCE_KIND");
    return { url: urlText, date: date(source.date, `${field}.date`), claim: text(source.claim, 1200, true, `${field}.claim`), kind: source.kind };
  }, 0, "sources");
  if (value.result_state !== "SOURCE_NEEDED" && !value.sources.length) fail("Use SOURCE_NEEDED when sources are unavailable.", "sources", "SOURCES_REQUIRED");
  for (const [key, max] of [["drivers", 3], ["falsifiers", 5], ["unknowns", 10]]) value[key] = list(value[key], max,
    (item, index) => text(item, 600, false, `${key}[${index}]`), 0, key);
  if (value.baseline !== undefined) {
    record(value.baseline, ["pack_id", "version"]);
    text(value.baseline.pack_id, 120, false); text(value.baseline.version, 160, false);
  }
  if (value.purchase_records !== undefined) value.purchase_records = list(value.purchase_records, 10, (receipt) => {
    record(receipt, ["capability_id", "research_version", "covered_symbols", "receipt_reference", "output_hash", "network", "transaction_reference", "settled_at", "verification"]);
    if (receipt.capability_id !== "taiwan-monthly-revenue-monitor" || receipt.network !== "eip155:5042002" || receipt.verification !== "agent_reported" ||
        typeof receipt.output_hash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.output_hash)) fail("Use supported agent-reported receipt fields.");
    receipt.covered_symbols = list(receipt.covered_symbols, 3, symbol, 1);
    if (receipt.covered_symbols.some((item) => !["2383.TW", "3037.TW", "8046.TW"].includes(item)) || !receipt.covered_symbols.some((item) => value.symbols.includes(item))) {
      fail("The research Pack must cover a selected released company.");
    }
    text(receipt.research_version, 160, false); text(receipt.receipt_reference, 200, false); text(receipt.transaction_reference, 200, false);
    timestamp(receipt.settled_at, true);
    return receipt;
  });
  return value;
}
