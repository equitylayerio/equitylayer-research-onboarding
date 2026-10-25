import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildTwseMonthlyRecord, fetchTwseMonthlyBytes, readTwseMonthlySource,
  TWSE_MONTHLY_API, TWSE_MONTHLY_SOURCE_ID, TWSE_LOCAL_VERSION, TWSE_MONTHLY_METRICS } from "../client/local/twse-monthly-source.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { processScheduleTick, scheduleRuntimeHash } from "../client/local/scheduler.mjs";
import { validateScheduleConfig } from "../client/local/schedule-contract.mjs";
import { contentHash } from "../client/local/run-contract.mjs";
import { planSourceEvent } from "../client/local/source-event-plan.mjs";
import { twseReportingPeriodGate } from "../client/local/twse-monthly-contract.mjs";
import { eventFixture, sourcePolicy as genericPolicy } from "./fixtures/source-events.mjs";
import { scope, context, methodBundle, limits, policy } from "./fixtures/local-research.mjs";

const selectedCodes = ["2383", "3037", "8046", "2345"];
const retrieved = "2026-10-13T12:00:00.000Z";
function row(code = "2383", patch = {}) {
  return { "出表日期": "1151010", "資料年月": "11509", "公司代號": code, "公司名稱": `Synthetic ${code}`,
    "產業別": "Synthetic", "營業收入-當月營收": "120", "營業收入-上月營收": "100", "營業收入-去年當月營收": "90",
    "營業收入-上月比較增減(%)": "20", "營業收入-去年同月增減(%)": "33.33", "累計營業收入-當月累計營收": "900",
    "累計營業收入-去年累計營收": "800", "累計營業收入-前期比較增減(%)": "12.5", "備註": "Synthetic issuer note.", ...patch };
}
const bytes = (rows = selectedCodes.map(code => row(code))) => Buffer.from(JSON.stringify(rows));
const parse = (raw = bytes(), options = {}) => buildTwseMonthlyRecord(raw, { company_codes: selectedCodes, retrieved_at: retrieved, ...options });
function response(raw = bytes(), patch = {}) {
  const result = new Response(raw, { headers: { "content-type": "application/json" }, ...patch });
  Object.defineProperty(result, "url", { value: TWSE_MONTHLY_API }); return result;
}
function environment(t, { rights = "ALLOWED", policyPatch = {}, configured = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-twse-test-"))); chmodSync(root, 0o700);
  let now = Date.parse(retrieved); const clock = () => now;
  let ledger = new ResearchLedger(join(root, "workspace"), { clock });
  const watched = { ...scope(), symbols: ["NVDA", "6701.T", "000660.KS", ...selectedCodes.map(code => `${code}.TW`)].sort() };
  ledger.saveRevision(watched, context()); const method = ledger.retainMethod(methodBundle());
  const sourcePolicy = { schema_version: 1, revision: 1, source_id: TWSE_MONTHLY_SOURCE_ID,
    rights_status: rights, rights_reference: "Synthetic policy only. No source rights granted.", allowed_purposes: ["local_research"],
    adapter_version: TWSE_LOCAL_VERSION, parser_version: TWSE_LOCAL_VERSION,
    issuer_map: Object.fromEntries(selectedCodes.map(code => [`${code}.TW`, code])), metric_definition_ids: [...TWSE_MONTHLY_METRICS],
    allowed_evidence_states: ["PROVISIONAL"], max_source_age_ms: 86400000, allow_candidate_trials: true, ...policyPatch };
  if (configured) ledger.configureSourcePolicy(watched.watch_id, sourcePolicy);
  ledger.configureBudget(watched.watch_id, "twse-test", limits()); let calls = 0;
  const runtime = { identity: "synthetic-twse-caller", config_sha256: contentHash({ synthetic: "twse" }), execute: async input => {
    calls++; return { agent_fields: { result_state: "REVIEW_REQUIRED", summary: "Synthetic source adapter test. No investment conclusion.",
      sources: [{ url: TWSE_MONTHLY_API, date: "2026-10-10", kind: "reported_fact", claim: "Synthetic observations only." }],
      drivers: [], falsifiers: [], unknowns: [], next_check_at: new Date(Date.parse(input.research_context.created_at) + 86400000).toISOString() },
      usage: { tokens: 1, cost_microusd: 1 } };
  } };
  const execution = { timeout_ms: 500, lease_ms: 1000, heartbeat_ms: 20, estimate: { tokens: 100, cost_microusd: 100, wall_ms: 500 } };
  const config = { schema_version: 1, schedule_id: "twse-test-schedule", revision: 1, watch_id: watched.watch_id,
    scope_revision: 1, method_sha256: method.bundle_sha256, source_id: TWSE_MONTHLY_SOURCE_ID, budget_window: "twse-test",
    feed: { kind: "twse_monthly_revenue_api" }, interval_ms: 86400000, max_events: 1, max_runs: 1,
    tick_timeout_ms: 1000, run_policy: policy(), runtime_sha256: scheduleRuntimeHash(runtime, execution) };
  ledger.configureSchedule(config);
  const options = { clock, runtime, execution, allow_private_context: true, allow_candidate_method: true };
  t.after(() => { try { ledger.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { config, sourcePolicy, watched, options, clock, calls: () => calls, advance: (ms = 86400000) => { now += ms; },
    get ledger() { return ledger; }, reopen() { ledger.close(); ledger = new ResearchLedger(join(root, "workspace"), { clock }); } };
}

test("TWSE records preserve bytes, four companies, source-field units, notes and provisional limits", () => {
  const raw = bytes(), record = parse(raw);
  assert.equal(record.artifact.artifact_sha256, createHash("sha256").update(raw).digest("hex"));
  assert.deepEqual(record.bytes, raw); assert.equal(record.facts.length, 44);
  assert.equal(record.artifact.source_period, "2026-09"); assert.equal(record.artifact.published_at, "2026-10-09T16:00:00.000Z");
  assert.equal(record.event.event_kind, "NEW_PERIOD");
  for (const fact of record.facts) { assert.equal(fact.evidence_state, "PROVISIONAL"); assert.match(fact.limitation, /does not establish/); }
  const money = record.facts.find(f => f.identity.metric_definition_id === "twse.monthly.current_revenue");
  assert.equal(money.value, 120); assert.equal(money.identity.unit_scale, "thousands"); assert.equal(money.identity.currency, "TWD");
  assert.equal(record.facts.filter(f => f.value_type === "number").length, 32);
  const note = record.facts.find(f => f.identity.metric_definition_id === "twse.monthly.issuer_note");
  assert.equal(note.identity.evidence_layer, "management_claim");
  assert.deepEqual(parse(bytes(selectedCodes.map(code => row(code, { "備註": "" })))).event.event_kind, "NEW_PERIOD");
});

const malformed = {
  missing: () => bytes([row()]), duplicate: () => bytes([...selectedCodes.map(code => row(code)), row()]),
  mixed_period: () => bytes(selectedCodes.map(code => row(code, code === "2383" ? { "資料年月": "11508" } : {}))),
  missing_number: () => bytes(selectedCodes.map(code => row(code, { "營業收入-當月營收": "" }))),
  scientific_number: () => bytes(selectedCodes.map(code => row(code, { "營業收入-當月營收": "1e3" }))),
  invalid_date: () => bytes(selectedCodes.map(code => row(code, { "出表日期": "1150230" }))),
  future_date: () => bytes(selectedCodes.map(code => row(code, { "出表日期": "1151201" }))),
  schema_extra: () => bytes(selectedCodes.map(code => row(code, { extra: "new schema" }))),
  invalid_text: () => bytes(selectedCodes.map(code => row(code, { "備註": null }))),
  invalid_json: () => Buffer.from("{ invalid"), invalid_utf8: () => Buffer.from([0xff]),
  not_array: () => Buffer.from("{}"), oversized_number: () => bytes(selectedCodes.map(code => row(code, { "營業收入-當月營收": "99999999999999999999" })))
};
for (const [name, make] of Object.entries(malformed)) test(`malformed ${name} retains exact bytes behind a schema gate`, () => {
  const raw = make(), result = parse(raw); assert.equal(result.event.event_kind, "SCHEMA_CHANGE");
  assert.equal(result.facts.length, 0); assert.equal(result.artifact.published_at, null); assert.deepEqual(result.bytes, raw);
});
test("HTML content type and backwards period do not become unchanged observations", () => {
  assert.equal(parse(bytes(), { content_type: "text/html" }).event.event_kind, "SCHEMA_CHANGE");
  const previous = parse(); const older = bytes(selectedCodes.map(code => row(code, { "資料年月": "11508" })));
  assert.equal(parse(older, { previous }).event.event_kind, "SCHEMA_CHANGE");
});
test("source configuration rejects duplicate codes, empty bytes and oversized bytes", () => {
  assert.throws(() => parse(bytes(), { company_codes: ["2383", "2383"] }), { code: "SOURCE_SCOPE_INVALID" });
  assert.throws(() => parse(Buffer.alloc(0)), { code: "SOURCE_BYTES_LIMIT" });
  assert.throws(() => parse(Buffer.alloc(2000001)), { code: "SOURCE_BYTES_LIMIT" });
});

test("fetch uses only the fixed approved endpoint and does not follow redirects", async () => {
  const raw = bytes(); let captured;
  const out = await fetchTwseMonthlyBytes({ fetch_impl: async (url, options) => { captured = { url, options }; return response(raw); } });
  assert.equal(captured.url, TWSE_MONTHLY_API); assert.equal(captured.options.redirect, "error");
  assert.equal(captured.options.headers.accept, "application/json"); assert.equal(captured.options.signal.aborted, true);
  assert.deepEqual(out.bytes, raw);
  await assert.rejects(fetchTwseMonthlyBytes({ fetch_impl: async () => ({ ...response(), ok: true, status: 200, url: "https://example.test/alternate", body: {} }) }), { code: "SOURCE_FETCH_FAILED" });
});
test("HTTP failure, empty bytes, oversized declared or streamed bytes fail without fallback", async () => {
  for (const supplied of [response(null, { status: 429 }), response(Buffer.alloc(0))]) {
    await assert.rejects(fetchTwseMonthlyBytes({ fetch_impl: async () => supplied }), { code: "SOURCE_FETCH_FAILED" });
  }
  for (const supplied of [response(bytes(), { headers: { "content-length": "2000001" } }), response(Buffer.alloc(2000001))]) {
    await assert.rejects(fetchTwseMonthlyBytes({ fetch_impl: async () => supplied }), { code: "SOURCE_BYTES_LIMIT" });
  }
});
test("headers and body have a bounded deadline even when the fetch implementation ignores cancellation", async () => {
  await assert.rejects(fetchTwseMonthlyBytes({ timeout_ms: 10, fetch_impl: () => new Promise(() => {}) }), { code: "SOURCE_FETCH_TIMEOUT" });
  let cancelled = false;
  const supplied = { ok: true, status: 200, url: TWSE_MONTHLY_API, headers: new Headers(), body: { getReader: () => ({
    read: () => new Promise(() => {}), cancel: () => { cancelled = true; return new Promise(() => {}); }
  }) } };
  await assert.rejects(fetchTwseMonthlyBytes({ timeout_ms: 10, fetch_impl: async () => supplied }), { code: "SOURCE_FETCH_TIMEOUT" });
  assert.equal(cancelled, true);
});
test("an existing stop signal prevents a source request", async () => {
  const signal = AbortSignal.abort(); let calls = 0;
  await assert.rejects(fetchTwseMonthlyBytes({ signal, fetch_impl: async () => { calls++; return response(); } }), { code: "SOURCE_FETCH_STOPPED" });
  assert.equal(calls, 0);
});
test("invalid fetch limits and cancellation signals fail before network access", async () => {
  let polls = 0;
  for (const patch of [{ timeout_ms: 0 }, { timeout_ms: 20001 }, { signal: {} }, { fetch_impl: null }]) {
    await assert.rejects(fetchTwseMonthlyBytes({ fetch_impl: async () => { polls++; return response(); }, ...patch }), { code: "SOURCE_CONFIG_INVALID" });
  }
  assert.equal(polls, 0);
});
test("late header responses and rejected headers close their bodies without delaying the deadline", async () => {
  let resolve, cancellations = 0;
  const pending = fetchTwseMonthlyBytes({ timeout_ms: 10, fetch_impl: () => new Promise(done => { resolve = done; }) });
  await assert.rejects(pending, { code: "SOURCE_FETCH_TIMEOUT" });
  resolve({ body: { cancel: () => { cancellations++; return new Promise(() => {}); } } });
  await new Promise(done => setTimeout(done, 10)); assert.equal(cancellations, 1);
  await assert.rejects(fetchTwseMonthlyBytes({ fetch_impl: async () => ({ ok: true, status: 200, url: TWSE_MONTHLY_API,
    headers: new Headers({ "content-length": "2000001" }), body: { cancel: () => { cancellations++; return new Promise(() => {}); } } }) }), { code: "SOURCE_BYTES_LIMIT" });
  assert.equal(cancellations, 2);
});
test("live schedules reject arbitrary source URLs, source identifiers and faster polling", t => {
  const e = environment(t);
  for (const patch of [{ feed: { kind: "twse_monthly_revenue_api", url: "https://example.test" } },
    { source_id: "other" }, { interval_ms: 1000 }]) {
    assert.throws(() => validateScheduleConfig({ ...e.config, ...patch }), { code: "SCHEDULE_CONFIG_INVALID" });
  }
});
for (const [name, config, expected] of [
  ["missing", { configured: false }, "SOURCE_POLICY_MISSING"], ["HOLD", { rights: "HOLD" }, "SOURCE_RIGHTS_HOLD"],
  ["unknown", { rights: "UNKNOWN" }, "SOURCE_RIGHTS_UNKNOWN"],
  ["purpose", { policyPatch: { allowed_purposes: [] } }, "SOURCE_PURPOSE_DENIED"],
  ["version", { policyPatch: { parser_version: "unreviewed" } }, "SOURCE_SCHEMA_CHANGED"]
]) test(`${name} source policy prevents network requests and AI execution`, async t => {
  const e = environment(t, config); let polls = 0;
  const tick = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => { polls++; return response(); } });
  assert.deepEqual(tick.tick.codes, [expected]); assert.equal(polls, 0); assert.equal(e.calls(), 0); assert.equal(e.ledger.inbox().length, 0);
});
test("a daily live tick delivers once, survives reopen and ignores unchanged scoped evidence", async t => {
  const e = environment(t); let raw = bytes();
  const tick = () => processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => response(raw) });
  const first = await tick(); assert.equal(first.status, "completed"); assert.equal(first.tick.deliveries, 1);
  const accepted = e.ledger.inbox()[0]; e.ledger.review(accepted.delivery_id, "accept_evidence", "Synthetic review only.", "twse-review", 0);
  e.advance(); e.reopen(); assert.equal((await tick()).tick.deliveries, 0); assert.equal(e.calls(), 1);
  e.advance(); raw = bytes([...selectedCodes.map(code => row(code)), row("9999", { "營業收入-當月營收": "999" })]);
  const unrelated = await tick(); assert.equal(unrelated.tick.deliveries, 0); assert.equal(e.calls(), 1);
  assert.equal(e.ledger.eventDecisions(e.watched.watch_id).at(-1).reason, "FIXED_SCOPE_EVIDENCE_UNCHANGED");
  e.advance(); raw = bytes([...selectedCodes.map(code => row(code, code === "2383" ? { "備註": "Changed synthetic issuer note." } : {})), row("9999")]);
  const changed = await tick(); assert.equal(changed.tick.deliveries, 1); assert.equal(e.calls(), 2);
  assert.equal(e.ledger.watch(e.watched.watch_id).evidence_delivery_id, accepted.delivery_id);
  assert.equal(e.ledger.watch(e.watched.watch_id).interpretation_delivery_id, null);
  assert.deepEqual(e.ledger.watch(e.watched.watch_id).revisions[0].scope.symbols, e.watched.symbols);
  e.ledger.verifyIntegrity();
});
test("a new reporting period queues again and never auto-adopts a thesis", async t => {
  const e = environment(t); let raw = bytes();
  const tick = () => processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => response(raw) });
  assert.equal((await tick()).tick.deliveries, 1); e.advance(31 * 86400000);
  raw = bytes(selectedCodes.map(code => row(code, { "資料年月": "11510", "出表日期": "1151110" })));
  assert.equal((await tick()).tick.deliveries, 1); assert.equal(e.calls(), 2); assert.equal(e.ledger.inbox().length, 2);
  assert.equal(e.ledger.watch(e.watched.watch_id).interpretation_delivery_id, null); e.ledger.verifyIntegrity();
});
test("fresh transport bytes cannot make an old reporting period current", async t => {
  const e = environment(t); e.advance(31 * 86400000);
  const out = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => response() });
  assert.deepEqual(out.tick.codes, ["STALE_REPORTING_PERIOD"]); assert.equal(e.calls(), 0);
  const event = e.ledger.eventDecisions(e.watched.watch_id)[0].source_ref.source_event_id;
  assert.deepEqual(e.ledger.source(event).bytes, bytes()); assert.equal(e.ledger.sourceFacts(event).length, 44); e.ledger.verifyIntegrity();
});
test("a current-calendar-month report is not a completed monthly period", async t => {
  const e = environment(t); const raw = bytes(selectedCodes.map(code => row(code, { "資料年月": "11510" })));
  const out = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => response(raw) });
  assert.deepEqual(out.tick.codes, ["SOURCE_TIME_CONFLICT"]); assert.equal(e.calls(), 0); e.ledger.verifyIntegrity();
});
test("a rejected future report cannot poison recovery to the correct reporting month", async t => {
  const e = environment(t); let raw = bytes(selectedCodes.map(code => row(code, { "資料年月": "11510" })));
  const tick = () => processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => response(raw) });
  assert.deepEqual((await tick()).tick.codes, ["SOURCE_TIME_CONFLICT"]);
  assert.equal(e.ledger.sourceChangeHead(e.watched.watch_id, TWSE_MONTHLY_SOURCE_ID), null);
  e.advance(); raw = bytes(); assert.equal((await tick()).tick.deliveries, 1); assert.equal(e.calls(), 1); e.ledger.verifyIntegrity();
});
test("an imported future report under HOLD cannot poison an approved current-period poll", async t => {
  const e = environment(t, { rights: "HOLD" });
  const source = parse(bytes(selectedCodes.map(code => row(code, { "資料年月": "11510" }))));
  const held = e.ledger.intakeSourceEvent({ ...source, watch_id: e.watched.watch_id, method_sha256: e.config.method_sha256,
    evaluation_at: new Date(e.clock()).toISOString(), budget_window: e.config.budget_window, run_policy: policy() });
  assert.equal(held.decision.gate_code, "SOURCE_RIGHTS_HOLD");
  e.ledger.configureSourcePolicy(e.watched.watch_id, { ...e.sourcePolicy, revision: 2, rights_status: "ALLOWED" });
  const out = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => response() });
  assert.equal(out.tick.deliveries, 1); assert.equal(e.calls(), 1); e.ledger.verifyIntegrity();
});
test("time passing cannot make a future-at-retrieval record a valid correction parent", async t => {
  const e = environment(t, { rights: "HOLD" });
  const source = parse(bytes(selectedCodes.map(code => row(code, { "資料年月": "11510" }))));
  e.ledger.intakeSourceEvent({ ...source, watch_id: e.watched.watch_id, method_sha256: e.config.method_sha256,
    evaluation_at: new Date(e.clock()).toISOString(), budget_window: e.config.budget_window, run_policy: policy() });
  e.advance(31 * 86400000);
  assert.equal(e.ledger.sourceChangeHead(e.watched.watch_id, TWSE_MONTHLY_SOURCE_ID), null);
  e.ledger.configureSourcePolicy(e.watched.watch_id, { ...e.sourcePolicy, revision: 2, rights_status: "ALLOWED" });
  const raw = bytes(selectedCodes.map(code => row(code, { "資料年月": "11510", "出表日期": "1151110" })));
  const out = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => response(raw) });
  assert.equal(out.tick.deliveries, 1);
  assert.equal(e.ledger.sourceChangeHead(e.watched.watch_id, TWSE_MONTHLY_SOURCE_ID).event.event_kind, "NEW_PERIOD"); e.ledger.verifyIntegrity();
});
for (const corruption of ["payload", "revision", "hash"]) test(`policy ${corruption} corruption fails before a network request`, async t => {
  const e = environment(t, { rights: "HOLD" }); const db = new DatabaseSync(join(e.ledger.directory, "research.sqlite"));
  if (corruption === "payload") db.prepare("UPDATE source_policies SET policy_json=?").run(JSON.stringify({ ...e.sourcePolicy, rights_status: "ALLOWED" }));
  if (corruption === "revision") db.exec("UPDATE source_policies SET revision=2");
  if (corruption === "hash") db.exec("UPDATE source_policies SET sha256='invalid'"); db.close();
  let polls = 0;
  await assert.rejects(readTwseMonthlySource(e.ledger, e.config, { clock: e.clock, fetch_impl: async () => { polls++; return response(); } }), { code: "STORAGE_CORRUPT" });
  assert.equal(polls, 0); assert.equal(e.calls(), 0);
});
test("generic publication-time changes remain material to scoped event comparison", () => {
  const previous = eventFixture(1), current = eventFixture(2);
  current.facts = current.facts.map(f => ({ ...f, value: 1, reported_at: "2026-10-11T00:00:00Z" }));
  assert.equal(planSourceEvent({ scope: scope(), method_bundle: methodBundle(), ...current,
    policy: genericPolicy(), previous_source: previous, evaluation_at: "2026-10-12T00:00:00Z" }).outcome, "queue");
});
test("monthly freshness uses the Taipei month boundary and handles a year rollover", () => {
  const { event, artifact } = parse();
  assert.equal(twseReportingPeriodGate(event, artifact, Date.parse("2026-10-31T15:59:59Z")), null);
  assert.equal(twseReportingPeriodGate(event, artifact, Date.parse("2026-10-31T16:00:00Z")), "STALE_REPORTING_PERIOD");
  assert.equal(twseReportingPeriodGate(event, { ...artifact, source_period: "2026-12" }, Date.parse("2027-01-01T00:00:00Z")), null);
});
test("repeated malformed source bytes keep one notice and produce no research", async t => {
  const e = environment(t); const tick = () => processScheduleTick(e.ledger, e.config.schedule_id,
    { ...e.options, source_fetch_impl: async () => response(Buffer.from("bad source")) });
  assert.deepEqual((await tick()).tick.codes, ["SOURCE_SCHEMA_CHANGED"]); e.advance();
  assert.deepEqual((await tick()).tick.codes, ["SOURCE_SCHEMA_CHANGED"]); assert.equal(e.calls(), 0);
  assert.equal(e.ledger.notices().filter(n => n.payload.kind === "source_gate").length, 1); e.ledger.verifyIntegrity();
});
test("network failures persist in health and recover on the next due tick", async t => {
  const e = environment(t);
  const failed = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => { throw new Error("PRIVATE_PROVIDER_BODY"); } });
  assert.deepEqual(failed.tick.codes, ["SOURCE_FETCH_FAILED"]); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_BODY/);
  e.reopen(); e.advance(); const recovered = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => response() });
  assert.equal(recovered.tick.deliveries, 1); assert.equal(e.ledger.scheduleHistory(e.config.schedule_id).length, 2); e.ledger.verifyIntegrity();
});
test("stopping during a source fetch prevents intake and delivery", async t => {
  const e = environment(t); const controller = new AbortController(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, signal: controller.signal,
    source_fetch_impl: () => { started(); return new Promise(() => {}); } });
  await ready; controller.abort(); const stopped = await pending;
  assert.equal(stopped.status, "failed"); assert.ok(stopped.tick.codes.includes("SOURCE_FETCH_STOPPED"));
  assert.equal(e.ledger.eventDecisions(e.watched.watch_id).length, 0); assert.equal(e.calls(), 0); e.ledger.verifyIntegrity();
});
test("a policy change during fetch prevents delivery under the prior permission", async t => {
  const e = environment(t); let resolve;
  const pending = processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: () => new Promise(done => { resolve = done; }) });
  e.ledger.configureSourcePolicy(e.watched.watch_id, { ...e.sourcePolicy, revision: 2, rights_status: "HOLD" }); resolve(response());
  const out = await pending; assert.equal(out.tick.deliveries, 0); assert.equal(e.calls(), 0);
  assert.ok(out.tick.codes.includes("SOURCE_RIGHTS_HOLD")); e.ledger.verifyIntegrity();
});
test("standalone reader rechecks policy and current scope instead of returning stale authority", async t => {
  const e = environment(t); let resolve;
  const pending = readTwseMonthlySource(e.ledger, e.config, { clock: e.clock, fetch_impl: () => new Promise(done => { resolve = done; }) });
  e.ledger.configureSourcePolicy(e.watched.watch_id, { ...e.sourcePolicy, revision: 2, rights_status: "HOLD" }); resolve(response());
  await assert.rejects(pending, { code: "SOURCE_RIGHTS_HOLD" });
  e.ledger.configureSourcePolicy(e.watched.watch_id, { ...e.sourcePolicy, revision: 3 });
  e.ledger.saveRevision({ ...e.watched, revision: 2 }, context()); let polls = 0;
  await assert.rejects(readTwseMonthlySource(e.ledger, e.config, { clock: e.clock, fetch_impl: async () => { polls++; return response(); } }), { code: "SOURCE_SCOPE_CHANGED" });
  assert.equal(polls, 0); e.ledger.verifyIntegrity();
});
for (const intervening of ["identical", "unrelated", "malformed"]) test(`correction history continues after an ${intervening} observation`, async t => {
  const e = environment(t); let raw = bytes();
  const tick = () => processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: async () => response(raw) });
  await tick(); e.advance(); raw = bytes(selectedCodes.map(code => row(code, { "營業收入-當月營收": "130" })));
  await tick(); const correction = e.ledger.sourceChangeHead(e.watched.watch_id, TWSE_MONTHLY_SOURCE_ID);
  assert.equal(correction.event.event_kind, "CORRECTED_PERIOD"); e.advance();
  if (intervening === "unrelated") raw = bytes([...selectedCodes.map(code => row(code, { "營業收入-當月營收": "130" })), row("9999")]);
  if (intervening === "malformed") raw = Buffer.from("malformed intermediary");
  await tick(); const parent = e.ledger.sourceChangeHead(e.watched.watch_id, TWSE_MONTHLY_SOURCE_ID);
  if (intervening !== "unrelated") assert.equal(parent.event.source_event_id, correction.event.source_event_id);
  else assert.equal(parent.event.supersedes_source_event_id, correction.event.source_event_id);
  e.advance(); raw = bytes(selectedCodes.map(code => row(code, { "營業收入-當月營收": "140" })));
  const last = await tick(); assert.equal(last.tick.deliveries, 1); assert.equal(e.calls(), 3);
  const head = e.ledger.sourceChangeHead(e.watched.watch_id, TWSE_MONTHLY_SOURCE_ID);
  assert.equal(head.event.supersedes_source_event_id, parent.event.source_event_id); e.ledger.verifyIntegrity();
});
for (const boundary of ["stop", "replace", "expire"]) test(`parent ${boundary} during source fetch prevents intake and delivery`, async t => {
  const e = environment(t); let resolve;
  const pending = processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, source_fetch_impl: () => new Promise(done => { resolve = done; }) });
  if (boundary === "stop") e.ledger.stopSchedule(e.config.schedule_id);
  if (boundary === "replace") e.ledger.configureSchedule({ ...e.config, revision: 2 });
  if (boundary === "expire") e.advance(3600001);
  resolve(response()); const out = await pending;
  assert.equal(out.status, "interrupted"); assert.equal(e.calls(), 0); assert.equal(e.ledger.inbox().length, 0);
  assert.equal(e.ledger.eventDecisions(e.watched.watch_id).length, 0); e.ledger.verifyIntegrity();
});
