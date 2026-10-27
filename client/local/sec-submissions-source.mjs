import { createHash } from "node:crypto";
import { canonicalJson, contentHash } from "./run-contract.mjs";
import { verifySourceReference } from "./reference-bridge.mjs";
import { verifyEventFacts } from "./source-event-plan.mjs";
import { SEC_SUBMISSIONS_VERSION, SEC_SUBMISSIONS_METRIC, SEC_SUBMISSIONS_FORMS, SecSourceError,
  secFail as fail, secSourceId, secSubmissionsUrl, validateSecFeed } from "./sec-submissions-contract.mjs";

export { SEC_SUBMISSIONS_VERSION, SEC_SUBMISSIONS_METRIC, secSourceId };
const MAX_BYTES = 2_000_000;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const limitation = "Filing-index metadata only. No filing body, revenue, margin, guidance, customer relationship, or investment conclusion is established. An amended filing is not a validated correction to a financial fact.";
function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    fail("SOURCE_SCHEMA_CHANGED", "The SEC metadata contains an invalid calendar date.");
  return value;
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value)
    fail("SOURCE_SCHEMA_CHANGED", "Use an exact UTC metadata timestamp.");
  return value;
}
function filings(data, feed, retrievedAt) {
  const cik = typeof data.cik === "number" && Number.isSafeInteger(data.cik) ? String(data.cik).padStart(10, "0") : data.cik;
  if (cik !== feed.cik || !Array.isArray(data.tickers) || !data.tickers.includes(feed.symbol))
    fail("SOURCE_ISSUER_CONFLICT", "The SEC issuer and listed symbol do not match the configured source.");
  const recent = data.filings?.recent, fields = ["accessionNumber", "form", "filingDate", "reportDate", "acceptanceDateTime", "primaryDocument"];
  if (!recent || fields.some(field => !Array.isArray(recent[field])) || recent.form.length > 10000 || fields.some(field => recent[field].length !== recent.form.length))
    fail("SOURCE_SCHEMA_CHANGED", "The SEC filing columns are missing or have different lengths.");
  const selected = [], accessions = new Set();
  for (let index = 0; index < recent.form.length; index++) {
    if (typeof recent.form[index] !== "string") fail("SOURCE_SCHEMA_CHANGED", "A filing form is not text.");
    if (!SEC_SUBMISSIONS_FORMS.includes(recent.form[index])) continue;
    const accession = recent.accessionNumber[index], document = recent.primaryDocument[index];
    if (typeof accession !== "string" || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || accessions.has(accession) ||
        typeof document !== "string" || document.length > 500 || !document || document.split("/").some(part => !part || part === "." || part === ".." || /[\u0000-\u0020\u007f?#\\]/.test(part)))
      fail("SOURCE_SCHEMA_CHANGED", "A financial filing has an invalid or duplicate identity.");
    accessions.add(accession);
    const filed = date(recent.filingDate[index]), accepted = timestamp(recent.acceptanceDateTime[index]);
    const reported = recent.reportDate[index] === "" ? null : date(recent.reportDate[index]);
    if (accepted > retrievedAt || filed > retrievedAt.slice(0, 10) || reported !== null && reported > retrievedAt.slice(0, 10))
      fail("SOURCE_TIME_CONFLICT", "A financial filing has metadata after the retrieval time.");
    selected.push({ accession, form: recent.form[index], filing_date: filed, report_date: reported, accepted_at: accepted,
      document_url: `https://www.sec.gov/Archives/edgar/data/${Number(feed.cik)}/${accession.replaceAll("-", "")}/${document.split("/").map(encodeURIComponent).join("/")}` });
  }
  return selected.sort((a, b) => b.accepted_at.localeCompare(a.accepted_at) || a.accession.localeCompare(b.accession)).slice(0, 20);
}

export function buildSecSubmissionsRecord(bytes, { feed, retrieved_at, content_type = "application/json" }) {
  validateSecFeed(feed); timestamp(retrieved_at);
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) fail("SOURCE_BYTES_LIMIT", "Use bounded, nonempty SEC response bytes.");
  const raw = Buffer.from(bytes), hash = sha(raw), sourceId = secSourceId(feed.cik), url = secSubmissionsUrl(feed.cik);
  const identity = { source_id: sourceId, artifact_sha256: hash, retrieved_at };
  const artifact = { source_artifact_id: `sec-artifact-${contentHash(identity)}`, source_id: sourceId, source_class: "regulatory_filing",
    canonical_url: url, published_at: null, retrieved_at, source_period: null, content_type, http_status: 200,
    byte_length: raw.length, artifact_sha256: hash, immutable_storage_key: `local-sec/${feed.cik}/${hash}.json` };
  const event = { source_event_id: `sec-event-${contentHash({ ...identity, parser: SEC_SUBMISSIONS_VERSION })}`, event_kind: "NEW_PERIOD",
    source_artifact_id: artifact.source_artifact_id, adapter_version: SEC_SUBMISSIONS_VERSION, parser_version: SEC_SUBMISSIONS_VERSION,
    observed_at: retrieved_at, supersedes_source_event_id: null, affected_fact_keys: [] };
  let facts = [];
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), selected = filings(data, feed, retrieved_at);
    if (!selected.length) event.event_kind = "NO_DATA";
    else {
      const factIdentity = { issuer_id: feed.cik, market: "US", metric_definition_id: SEC_SUBMISSIONS_METRIC, evidence_layer: "actual",
        period_start: null, period_end: null, fiscal_period: null, currency: null, unit_scale: null, accounting_basis: "SOURCE_REPORTED",
        dimensions: { selection: "latest_20_supported_financial_forms" } };
      const value = canonicalJson(selected);
      facts = [{ fact_key: contentHash(factIdentity), fact_revision_id: contentHash({ identity: factIdentity, value, artifact_sha256: hash }),
        identity: factIdentity, value, value_type: "string", source_event_id: event.source_event_id, source_artifact_sha256: hash,
        exact_locator: "filings.recent; latest 20 supported financial forms ordered by acceptance time and accession",
        source_url: url, reported_at: null, normalized_at: retrieved_at, definition_version: "1.0.0", parser_version: SEC_SUBMISSIONS_VERSION,
        evidence_state: "PROVISIONAL", limitation }];
    }
  } catch (error) {
    // Retain changed or malformed bytes as a gate. Never interpret them as quiet success.
    if (!(error instanceof SecSourceError || error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)) throw error;
    facts = []; event.event_kind = "SCHEMA_CHANGE";
  }
  event.affected_fact_keys = facts.map(fact => fact.fact_key);
  // Source identity cannot depend on whether a particular watch observed these bytes before.
  const { source_event_id: ignoredId, ...eventBody } = event;
  event.source_event_id = `sec-event-${contentHash(eventBody)}`;
  for (const fact of facts) fact.source_event_id = event.source_event_id;
  verifySourceReference(event, artifact, raw); verifyEventFacts(event, artifact, facts);
  return { event, artifact, facts, bytes: raw };
}

export async function fetchSecSubmissionsBytes(feed, { fetch_impl = globalThis.fetch, signal, timeout_ms = 20000 } = {}) {
  validateSecFeed(feed);
  if (typeof fetch_impl !== "function" || !Number.isSafeInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 20000 || signal !== undefined && !(signal instanceof AbortSignal))
    fail("SOURCE_CONFIG_INVALID", "Use a bounded SEC request configuration.");
  const controller = new AbortController(); let timer, reader, response, abort, timedOut = false;
  const cancel = value => { try { Promise.resolve(value?.body?.cancel()).catch(() => {}); } catch {} };
  const stop = () => controller.abort();
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(new SecSourceError(timedOut ? "SOURCE_FETCH_TIMEOUT" : "SOURCE_FETCH_STOPPED", "The SEC request stopped before completion."));
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop();
  timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout_ms);
  try {
    if (controller.signal.aborted) await interrupted;
    const url = secSubmissionsUrl(feed.cik);
    const requested = Promise.resolve(fetch_impl(url, { headers: { accept: "application/json", "user-agent": feed.user_agent }, redirect: "error", signal: controller.signal }))
      .then(value => { if (controller.signal.aborted) cancel(value); return value; });
    response = await Promise.race([requested, interrupted]);
    if (response?.status !== 200 || !response.ok || response.url !== url || !response.body) fail("SOURCE_FETCH_FAILED", "The fixed SEC endpoint did not return a complete response.");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) fail("SOURCE_BYTES_LIMIT", "The SEC response exceeds its byte limit.");
    reader = response.body.getReader(); const chunks = []; let length = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted]); if (chunk.done) break;
      length += chunk.value.length; if (length > MAX_BYTES) fail("SOURCE_BYTES_LIMIT", "The SEC response exceeds its byte limit.");
      chunks.push(Buffer.from(chunk.value));
    }
    const encoding = response.headers.get("content-encoding");
    if (!length || declared !== null && (!encoding || encoding === "identity") && Number(declared) !== length)
      fail("SOURCE_FETCH_FAILED", "The SEC response is empty or incomplete.");
    return { bytes: Buffer.concat(chunks), content_type: response.headers.get("content-type") ?? "application/octet-stream" };
  } catch (error) {
    if (error instanceof SecSourceError) throw error;
    fail("SOURCE_FETCH_FAILED", "The fixed SEC request failed. No alternate route or filing body was requested.");
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", stop); controller.signal.removeEventListener("abort", abort); controller.abort();
    if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} } else cancel(response);
  }
}

function sourcePolicy(ledger, config) {
  const policy = ledger.sourcePolicy(config.watch_id, secSourceId(config.feed.cik))?.policy;
  if (!policy) fail("SOURCE_POLICY_MISSING", "Configure permitted local SEC use before polling.");
  if (policy.rights_status !== "ALLOWED") fail(policy.rights_status === "HOLD" ? "SOURCE_RIGHTS_HOLD" : "SOURCE_RIGHTS_UNKNOWN", "Resolve local source rights before polling.");
  if (!policy.allowed_purposes.includes("local_research")) fail("SOURCE_PURPOSE_DENIED", "Approve the local research purpose before polling.");
  if (policy.adapter_version !== SEC_SUBMISSIONS_VERSION || policy.parser_version !== SEC_SUBMISSIONS_VERSION ||
      policy.issuer_map[config.feed.symbol] !== config.feed.cik || !policy.metric_definition_ids.includes(SEC_SUBMISSIONS_METRIC))
    fail("SOURCE_SCHEMA_CHANGED", "Use the exact SEC parser, issuer mapping, and filing-index metric.");
  return policy;
}
export async function readSecSubmissionsSource(ledger, config, { fetch_impl, signal, clock = Date.now } = {}) {
  validateSecFeed(config.feed);
  if (config.source_id !== secSourceId(config.feed.cik)) fail("SOURCE_CONFIG_INVALID", "Bind the schedule to this exact SEC issuer source.");
  const initial = contentHash(sourcePolicy(ledger, config));
  const currentWatch = () => {
    const watch = ledger.watch(config.watch_id);
    if (watch?.current_revision !== config.scope_revision || !watch.revisions.find(row => row.revision === config.scope_revision)?.scope.symbols.includes(config.feed.symbol))
      fail("SOURCE_SCOPE_CHANGED", "Use the current watch and its selected listed symbol before SEC intake.");
  };
  currentWatch();
  const fetched = await fetchSecSubmissionsBytes(config.feed, { fetch_impl, signal });
  if (contentHash(sourcePolicy(ledger, config)) !== initial) fail("SOURCE_POLICY_CHANGED", "Review the local source policy change before intake.");
  currentWatch();
  return [buildSecSubmissionsRecord(fetched.bytes, { feed: config.feed, retrieved_at: new Date(clock()).toISOString(), content_type: fetched.content_type })];
}
