import { createHash } from "node:crypto";
import { canonicalJson, contentHash } from "./run-contract.mjs";
import { verifySourceReference } from "./reference-bridge.mjs";
import { verifyEventFacts } from "./source-event-plan.mjs";
import { TWSE_MONTHLY_SOURCE_ID, TWSE_MONTHLY_API, TWSE_LOCAL_VERSION } from "./twse-monthly-contract.mjs";

export { TWSE_MONTHLY_SOURCE_ID, TWSE_MONTHLY_API, TWSE_LOCAL_VERSION };
const MAX_BYTES = 2_000_000;
const numericFields = [
  ["current_revenue", "營業收入-當月營收", "thousands"],
  ["previous_month_revenue", "營業收入-上月營收", "thousands"],
  ["previous_year_revenue", "營業收入-去年當月營收", "thousands"],
  ["mom_percent", "營業收入-上月比較增減(%)", "percent"],
  ["yoy_percent", "營業收入-去年同月增減(%)", "percent"],
  ["ytd_revenue", "累計營業收入-當月累計營收", "thousands"],
  ["previous_ytd_revenue", "累計營業收入-去年累計營收", "thousands"],
  ["ytd_yoy_percent", "累計營業收入-前期比較增減(%)", "percent"]
];
const textFields = [["company_name", "公司名稱"], ["industry", "產業別"], ["issuer_note", "備註"]];
export const TWSE_MONTHLY_METRICS = Object.freeze([...numericFields, ...textFields].map(([id]) => `twse.monthly.${id}`));
const fields = ["出表日期", "資料年月", "公司代號", ...numericFields.map(([, field]) => field), ...textFields.map(([, field]) => field)].sort();
export class SourceFeedError extends Error {
  constructor(code, message) { super(message); this.name = "SourceFeedError"; this.code = code; }
}
const fail = (code, message) => { throw new SourceFeedError(code, message); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) {
    fail("SOURCE_CONFIG_INVALID", "Use an exact UTC retrieval timestamp.");
  }
  return value;
}
function rocPeriod(value) {
  if (typeof value !== "string" || !/^\d{3}(?:0[1-9]|1[0-2])$/.test(value)) fail("SOURCE_SCHEMA_CHANGED", "The source reporting period changed format.");
  return `${Number(value.slice(0, 3)) + 1911}-${value.slice(3)}`;
}
function rocDate(value) {
  if (typeof value !== "string" || !/^\d{7}$/.test(value)) fail("SOURCE_SCHEMA_CHANGED", "The source publication date changed format.");
  const year = Number(value.slice(0, 3)) + 1911, month = Number(value.slice(3, 5)), day = Number(value.slice(5));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail("SOURCE_SCHEMA_CHANGED", "The source publication date is invalid.");
  return new Date(date.getTime() - 8 * 3600000).toISOString();
}
function codes(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(code => typeof code !== "string" || !/^\d{4}$/.test(code)) ||
      new Set(value).size !== value.length) fail("SOURCE_SCOPE_INVALID", "Select one to one hundred unique TWSE company codes.");
  return [...value].sort();
}
function numeric(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))) {
    fail("SOURCE_SCHEMA_CHANGED", "A source numeric field is missing or invalid.");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) fail("SOURCE_SCHEMA_CHANGED", "A source number exceeds the supported range.");
  return number;
}

// These are issuer-reported observations, not a curated investment conclusion.
export function buildTwseMonthlyRecord(raw, { company_codes, retrieved_at, content_type = "application/json", previous = null } = {}) {
  const selected = codes(company_codes); timestamp(retrieved_at);
  if (!(raw instanceof Uint8Array) || !raw.length || raw.length > MAX_BYTES) fail("SOURCE_BYTES_LIMIT", "Use bounded exact source bytes.");
  const bytes = Buffer.from(raw), rawHash = sha(bytes);
  const identity = contentHash({ raw_sha256: rawHash, retrieved_at, selected, parser: TWSE_LOCAL_VERSION });
  const artifact = { source_artifact_id: `twse-monthly-artifact-${identity}`, source_id: TWSE_MONTHLY_SOURCE_ID,
    source_class: "exchange_dataset", canonical_url: TWSE_MONTHLY_API, published_at: null, retrieved_at,
    source_period: null, content_type, http_status: 200, byte_length: bytes.length, artifact_sha256: rawHash,
    immutable_storage_key: `local/twse-monthly/${identity}` };
  const event = { source_event_id: `twse-monthly-event-${identity}`, source_artifact_id: artifact.source_artifact_id,
    event_kind: "NEW_PERIOD", adapter_version: TWSE_LOCAL_VERSION, parser_version: TWSE_LOCAL_VERSION,
    observed_at: retrieved_at, supersedes_source_event_id: null, affected_fact_keys: [] };
  let facts = [];
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(content_type)) fail("SOURCE_SCHEMA_CHANGED", "The source content type changed.");
    const rows = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(rows) || rows.length > 10000) fail("SOURCE_SCHEMA_CHANGED", "The source is not a bounded row array.");
    const byCode = new Map();
    for (const code of selected) {
      const matches = rows.filter(row => row && typeof row === "object" && !Array.isArray(row) && row["公司代號"] === code);
      if (matches.length !== 1 || canonicalJson(Object.keys(matches[0]).sort()) !== canonicalJson(fields)) {
        fail("SOURCE_SCHEMA_CHANGED", "A selected company row is missing, duplicated, or changed schema.");
      }
      byCode.set(code, matches[0]);
    }
    const periods = [...byCode.values()].map(row => rocPeriod(row["資料年月"]));
    if (new Set(periods).size !== 1) fail("SOURCE_SCHEMA_CHANGED", "Selected companies do not share one reporting period.");
    artifact.source_period = periods[0];
    const published = [...byCode.values()].map(row => rocDate(row["出表日期"]));
    artifact.published_at = [...published].sort().at(-1);
    if (Date.parse(artifact.published_at) > Date.parse(retrieved_at)) fail("SOURCE_TIME_CONFLICT", "The source publication date is in the future.");
    if (previous?.artifact.source_period && artifact.source_period < previous.artifact.source_period) {
      fail("SOURCE_PERIOD_REGRESSION", "The source reporting period moved backwards.");
    }
    const [year, month] = artifact.source_period.split("-").map(Number);
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    for (const [code, row] of byCode) {
      for (const [metric, field, scale = null] of [...numericFields, ...textFields]) {
        const value = scale ? numeric(row[field]) : row[field];
        if (!scale && (typeof value !== "string" || value.length > 6000)) fail("SOURCE_SCHEMA_CHANGED", "A source text field is missing or oversized.");
        const factIdentity = { issuer_id: code, market: "TW", metric_definition_id: `twse.monthly.${metric}`,
          evidence_layer: metric === "issuer_note" ? "management_claim" : "actual", period_start: `${artifact.source_period}-01`, period_end: end,
          fiscal_period: artifact.source_period, currency: scale === "thousands" ? "TWD" : null, unit_scale: scale,
          accounting_basis: "SOURCE_REPORTED", dimensions: { source_field: field, measurement_basis: "field_as_reported_for_period" } };
        facts.push({ fact_key: contentHash(factIdentity), fact_revision_id: contentHash({ identity: factIdentity, value, artifact_sha256: rawHash }),
          identity: factIdentity, value, value_type: scale ? "number" : "string", source_event_id: event.source_event_id,
          source_artifact_sha256: rawHash, exact_locator: `company_code=${code};field=${field}`, source_url: TWSE_MONTHLY_API,
          reported_at: rocDate(row["出表日期"]), normalized_at: retrieved_at, definition_version: "1.0.0", parser_version: TWSE_LOCAL_VERSION,
          evidence_state: "PROVISIONAL", limitation: "Issuer-reported field. Prior-period and cumulative columns retain their source-field definitions. Total revenue does not establish AI or CCL mix, qualification, shipments, margin, or customer exposure." });
      }
    }
    if (previous && previous.artifact.source_period === artifact.source_period && previous.artifact.artifact_sha256 !== rawHash) {
      event.event_kind = "CORRECTED_PERIOD"; event.supersedes_source_event_id = previous.event.source_event_id;
    }
  } catch (error) {
    // Preserve malformed or regressed bytes as a gated event, not a quiet observation.
    facts = []; event.event_kind = "SCHEMA_CHANGE"; event.supersedes_source_event_id = null;
    artifact.published_at = null;
    if (!(error instanceof SourceFeedError) && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
  }
  event.affected_fact_keys = facts.map(fact => fact.fact_key).sort();
  verifySourceReference(event, artifact, bytes); verifyEventFacts(event, artifact, facts);
  return { event, artifact, facts, bytes };
}

export async function fetchTwseMonthlyBytes({ fetch_impl = globalThis.fetch, signal, timeout_ms = 20000 } = {}) {
  if (typeof fetch_impl !== "function" || !Number.isSafeInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 20000 ||
      signal !== undefined && !(signal instanceof AbortSignal)) {
    fail("SOURCE_CONFIG_INVALID", "Use a bounded source request configuration.");
  }
  const controller = new AbortController(); let timer, reader, response, timedOut = false, abort;
  const cancelBody = value => {
    try { Promise.resolve(value?.body?.cancel()).catch(() => {}); } catch { /* Cleanup must not block the source deadline. */ }
  };
  const stop = () => controller.abort();
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(new SourceFeedError(timedOut ? "SOURCE_FETCH_TIMEOUT" : "SOURCE_FETCH_STOPPED", "The source request stopped before completion."));
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout_ms);
  try {
    if (controller.signal.aborted) await interrupted;
    const fetched = Promise.resolve(fetch_impl(TWSE_MONTHLY_API, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal }))
      .then(value => { if (controller.signal.aborted) cancelBody(value); return value; });
    response = await Promise.race([fetched, interrupted]);
    if (!response?.ok || response.status !== 200 || response.url !== TWSE_MONTHLY_API || !response.body) fail("SOURCE_FETCH_FAILED", "The approved source did not return a complete response.");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) fail("SOURCE_BYTES_LIMIT", "The source response exceeds its byte limit.");
    reader = response.body.getReader(); const chunks = []; let length = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > MAX_BYTES) fail("SOURCE_BYTES_LIMIT", "The source response exceeds its byte limit.");
      chunks.push(Buffer.from(chunk.value));
    }
    if (!length) fail("SOURCE_FETCH_FAILED", "The approved source returned no bytes.");
    return { bytes: Buffer.concat(chunks), content_type: response.headers.get("content-type") ?? "application/octet-stream" };
  } catch (error) {
    if (error instanceof SourceFeedError) throw error;
    fail("SOURCE_FETCH_FAILED", "The approved source request failed. No alternate route was used.");
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", stop);
    controller.signal.removeEventListener("abort", abort); controller.abort();
    if (reader) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Cleanup must not block the source deadline. */ }
    } else cancelBody(response);
  }
}

export async function readTwseMonthlySource(ledger, config, { fetch_impl, signal, clock = Date.now } = {}) {
  const policy = localSourcePolicy(ledger, config);
  const watch = ledger.watch(config.watch_id);
  if (watch?.current_revision !== config.scope_revision) fail("SOURCE_SCOPE_CHANGED", "Use the current watch revision before polling.");
  const scope = watch?.revisions.find(row => row.revision === config.scope_revision)?.scope;
  const selected = scope?.symbols.filter(symbol => /^\d{4}\.TW$/.test(symbol)).map(symbol => symbol.slice(0, 4)) ?? [];
  if (!selected.length || selected.some(code => policy.issuer_map[`${code}.TW`] !== code)) fail("SOURCE_SCOPE_INVALID", "Configure exact TWSE company identifiers for this watch.");
  const initialPolicy = contentHash(policy);
  const fetched = await fetchTwseMonthlyBytes({ fetch_impl, signal });
  const currentPolicy = localSourcePolicy(ledger, config);
  if (initialPolicy !== contentHash(currentPolicy)) fail("SOURCE_POLICY_CHANGED", "Review the source policy change before intake.");
  const currentWatch = ledger.watch(config.watch_id);
  if (currentWatch?.current_revision !== config.scope_revision) fail("SOURCE_SCOPE_CHANGED", "Use the current watch revision before intake.");
  const previous = ledger.sourceChangeHead(config.watch_id, TWSE_MONTHLY_SOURCE_ID);
  return [buildTwseMonthlyRecord(fetched.bytes, { company_codes: selected, retrieved_at: new Date(clock()).toISOString(), content_type: fetched.content_type, previous })];
}

function localSourcePolicy(ledger, config) {
  const policy = ledger.sourcePolicy(config.watch_id, TWSE_MONTHLY_SOURCE_ID)?.policy;
  if (!policy) fail("SOURCE_POLICY_MISSING", "Configure the local source policy before polling.");
  if (policy.rights_status !== "ALLOWED") fail(policy.rights_status === "HOLD" ? "SOURCE_RIGHTS_HOLD" : "SOURCE_RIGHTS_UNKNOWN", "Resolve the local source rights before polling.");
  if (!policy.allowed_purposes.includes("local_research")) fail("SOURCE_PURPOSE_DENIED", "Approve the local research purpose before polling.");
  if (policy.adapter_version !== TWSE_LOCAL_VERSION || policy.parser_version !== TWSE_LOCAL_VERSION) fail("SOURCE_SCHEMA_CHANGED", "Review the exact source adapter and parser version.");
  return policy;
}
