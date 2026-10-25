import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "../client/local/run-contract.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { processScheduleTick } from "../client/local/scheduler.mjs";
import { validateScheduleConfig } from "../client/local/schedule-contract.mjs";
import { validateSecFeed, secSourceId, secSubmissionsUrl, secSubmissionsIndexGate, SEC_SUBMISSIONS_VERSION, SEC_SUBMISSIONS_METRIC } from "../client/local/sec-submissions-contract.mjs";
import { buildSecSubmissionsRecord, fetchSecSubmissionsBytes, readSecSubmissionsSource } from "../client/local/sec-submissions-source.mjs";
import { configureEventWatch, sourcePolicy } from "./fixtures/source-events.mjs";
import { scope, policy, setup, estimate } from "./fixtures/local-research.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { secFeed, secAt, secData, secBytes, secResponse } from "./fixtures/sec-submissions.mjs";

const build = (data = secData(), options = {}) => buildSecSubmissionsRecord(secBytes(data), { feed: secFeed(), retrieved_at: secAt, ...options });
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-sec-source-test-")));
  let now = Date.parse(secAt), ledger = new ResearchLedger(join(root, "workspace"), { clock: () => now });
  const method = configureEventWatch(ledger), source_id = secSourceId(secFeed().cik);
  ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), source_id, adapter_version: SEC_SUBMISSIONS_VERSION,
    parser_version: SEC_SUBMISSIONS_VERSION, issuer_map: { LITE: secFeed().cik }, metric_definition_ids: [SEC_SUBMISSIONS_METRIC], allowed_evidence_states: ["PROVISIONAL"] });
  const config = { schema_version: 1, schedule_id: "synthetic-sec", revision: 1, watch_id: scope().watch_id, scope_revision: 1,
    method_sha256: method.bundle_sha256, source_id, budget_window: "event-window", feed: secFeed(), interval_ms: 86400000,
    max_events: 20, max_runs: 0, tick_timeout_ms: 30000, run_policy: policy(), runtime_sha256: null };
  ledger.configureSchedule(config);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { config, get ledger() { return ledger; }, advance(ms = 86400000) { now += ms; }, clock: () => now,
    reopen() { ledger.close(); ledger = new ResearchLedger(join(root, "workspace"), { clock: () => now }); } };
}

test("fixed SEC contract binds one source, CIK, symbol, and contact without a custom URL", () => {
  assert.equal(validateSecFeed(secFeed()).symbol, "LITE"); assert.equal(secSourceId("0000000001"), "sec_submissions_local_0000000001_v1");
  assert.equal(secSubmissionsUrl("0000000001"), "https://data.sec.gov/submissions/CIK0000000001.json");
});
for (const input of [{ cik: "1" }, { cik: "0000000000" }, { cik: 1 }, { cik: "0000000001/.." }, { symbol: "2383.TW" },
  { symbol: "6752.T" }, { symbol: "000150.KS" }, { symbol: "lite" }, { user_agent: "anonymous" }, { user_agent: "Name a@b.test\r\nCookie: key" },
  { user_agent: "X".repeat(251) }, { url: "https://example.test/" }, { headers: {} }]) {
  test(`fixed SEC feed rejects unsupported input ${JSON.stringify(input)}`, () => assert.throws(() => validateSecFeed({ ...secFeed(), ...input }), { code: "SOURCE_CONFIG_INVALID" }));
}

test("SEC metadata retains exact bytes and supplies no financial values or inferred reporting period", () => {
  const source = build();
  assert.equal(source.event.event_kind, "NEW_PERIOD"); assert.equal(source.artifact.source_period, null); assert.equal(source.artifact.published_at, null);
  assert.deepEqual(source.bytes, secBytes()); assert.equal(source.facts.length, 1);
  const fact = source.facts[0]; assert.equal(fact.value_type, "string"); assert.equal(fact.evidence_state, "PROVISIONAL");
  assert.equal(fact.identity.fiscal_period, null); assert.equal(fact.identity.unit_scale, null); assert.equal(fact.reported_at, null);
  assert.match(fact.limitation, /No filing body, revenue/);
  assert.equal(JSON.parse(fact.value)[0].document_url, "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/synthetic-q3.htm");
});
test("listing aliases for one SEC issuer share one immutable event and fact identity", t => {
  const f = fixture(t), data = secData(); data.tickers.push("ALTERNATE");
  const first = build(data), alias = build(data, { feed: { ...secFeed(), symbol: "ALTERNATE" } });
  assert.equal(first.artifact.source_artifact_id, alias.artifact.source_artifact_id);
  assert.deepEqual(first.event, alias.event); assert.deepEqual(first.facts, alias.facts);
  f.ledger.retainSource(first.event, first.artifact, first.bytes);
  assert.doesNotThrow(() => f.ledger.retainSource(alias.event, alias.artifact, alias.bytes));
  f.ledger.verifyIntegrity();
});
test("two watched listing aliases can observe the same issuer bytes without an immutable-reference conflict", async t => {
  const f = fixture(t), aliasWatch = { ...scope(), watch_id: "22222222-2222-4222-8222-222222222222", symbols: ["ALTERNATE", "2345.TW"] };
  f.ledger.saveRevision(aliasWatch, {});
  const existing = f.ledger.sourcePolicy(scope().watch_id, f.config.source_id).policy;
  f.ledger.configureSourcePolicy(aliasWatch.watch_id, { ...existing, issuer_map: { ALTERNATE: secFeed().cik } });
  f.ledger.configureBudget(aliasWatch.watch_id, f.config.budget_window, { requests: 0, tokens: 0, cost_microusd: 0, wall_ms: 0 });
  const second = { ...f.config, schedule_id: "alias-sec", watch_id: aliasWatch.watch_id, feed: { ...secFeed(), symbol: "ALTERNATE" } };
  f.ledger.configureSchedule(second); const data = secData(); data.tickers.push("ALTERNATE");
  for (const config of [f.config, second]) {
    const output = await processScheduleTick(f.ledger, config.schedule_id, { clock: f.clock, source_fetch_impl: async () => secResponse(secBytes(data)) });
    assert.equal(output.status, "completed");
  }
  assert.equal(f.ledger.workspaceStatus().counts.runs, 2); assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
  f.ledger.verifyIntegrity();
});
test("one watch's repeated SEC observation cannot conflict with another watch's first observation", async t => {
  const f = fixture(t), aliasWatch = { ...scope(), watch_id: "33333333-3333-4333-8333-333333333333", symbols: ["ALTERNATE", "2345.TW"] };
  const data = secData(); data.tickers.push("ALTERNATE");
  const observe = id => processScheduleTick(f.ledger, id, { clock: f.clock, source_fetch_impl: async () => secResponse(secBytes(data)) });
  assert.equal((await observe(f.config.schedule_id)).status, "completed"); f.advance();
  f.ledger.saveRevision(aliasWatch, {});
  const p = f.ledger.sourcePolicy(scope().watch_id, f.config.source_id).policy;
  f.ledger.configureSourcePolicy(aliasWatch.watch_id, { ...p, issuer_map: { ALTERNATE: secFeed().cik } });
  f.ledger.configureBudget(aliasWatch.watch_id, f.config.budget_window, { requests: 0, tokens: 0, cost_microusd: 0, wall_ms: 0 });
  f.ledger.configureSchedule({ ...f.config, schedule_id: "new-alias-sec", watch_id: aliasWatch.watch_id, feed: { ...secFeed(), symbol: "ALTERNATE" } });
  assert.equal((await observe(f.config.schedule_id)).status, "completed");
  assert.equal((await observe("new-alias-sec")).status, "completed");
  assert.equal(f.ledger.workspaceStatus().counts.runs, 2); assert.equal(f.ledger.workspaceStatus().counts.requests, 0); f.ledger.verifyIntegrity();
});
test("SEC source history gates regression without suppressing a first job after explicit curation approval", async t => {
  const f = fixture(t), p = f.ledger.sourcePolicy(scope().watch_id, f.config.source_id).policy;
  f.ledger.configureSourcePolicy(scope().watch_id, { ...p, revision: 2, allow_candidate_trials: false });
  const first = await processScheduleTick(f.ledger, f.config.schedule_id, { clock: f.clock, source_fetch_impl: async () => secResponse() });
  assert.equal(first.status, "gated"); assert.deepEqual(first.tick.codes, ["METHOD_CURATION_REQUIRED"]);
  assert.equal(f.ledger.workspaceStatus().counts.runs, 0);
  f.ledger.configureSourcePolicy(scope().watch_id, { ...p, revision: 3, allow_candidate_trials: true }); f.advance();
  const older = secData(); older.filings.recent.acceptanceDateTime[0] = "2026-10-09T18:00:00.000Z";
  const stale = build(older, { retrieved_at: new Date(f.clock()).toISOString() });
  const intake = f.ledger.intakeSourceEvent({ ...stale, watch_id: scope().watch_id, method_sha256: f.config.method_sha256,
    evaluation_at: new Date(f.clock()).toISOString(), budget_window: f.config.budget_window, run_policy: policy() });
  assert.equal(intake.decision.outcome, "gated"); assert.equal(intake.decision.gate_code, "SOURCE_SCHEMA_CHANGED");
  assert.equal(f.ledger.workspaceStatus().counts.runs, 0);
  const equal = await processScheduleTick(f.ledger, f.config.schedule_id, { clock: f.clock, source_fetch_impl: async () => secResponse() });
  assert.equal(equal.status, "completed"); assert.equal(f.ledger.workspaceStatus().counts.runs, 1);
  assert.equal(f.ledger.workspaceStatus().counts.requests, 0); f.ledger.verifyIntegrity();
});
test("SEC schema gates cannot reuse the immutable event ID of a valid mapping for the same bytes", t => {
  const f = fixture(t), valid = build(), mismatch = build(undefined, { feed: { ...secFeed(), symbol: "OTHER" } });
  assert.equal(valid.artifact.source_artifact_id, mismatch.artifact.source_artifact_id);
  assert.equal(mismatch.event.event_kind, "SCHEMA_CHANGE"); assert.notEqual(valid.event.source_event_id, mismatch.event.source_event_id);
  f.ledger.retainSource(valid.event, valid.artifact, valid.bytes);
  assert.doesNotThrow(() => f.ledger.retainSource(mismatch.event, mismatch.artifact, mismatch.bytes)); f.ledger.verifyIntegrity();
});
test("the SEC intake gate rejects malformed detector facts and future metadata without affecting other parsers", () => {
  const current = build(), gate = (facts, previous = null) => secSubmissionsIndexGate(current.event, current.artifact, facts, previous);
  assert.equal(gate(current.facts), null);
  for (const value of ["{", "[]", "null", '[{"accepted_at":"bad"}]', '[{"accepted_at":"2026-02-30T00:00:00.000Z"}]'])
    assert.equal(gate([{ ...current.facts[0], value }]), "SOURCE_SCHEMA_CHANGED");
  assert.equal(gate([]), "SOURCE_SCHEMA_CHANGED");
  assert.equal(gate(current.facts, { ...current, facts: [] }), "SOURCE_SCHEMA_CHANGED");
  const rows = JSON.parse(current.facts[0].value); rows[0].accepted_at = "2026-10-13T00:00:00.000Z";
  assert.equal(gate([{ ...current.facts[0], value: JSON.stringify(rows) }]), "SOURCE_TIME_CONFLICT");
  assert.equal(secSubmissionsIndexGate({ parser_version: "other" }, current.artifact, [], null), null);
  assert.equal(secSubmissionsIndexGate(current.event, { ...current.artifact, source_id: "other" }, [], null), null);
});
for (const [name, mutate] of [
  ["issuer", d => d.cik = "0000000002"], ["ticker", d => d.tickers = ["OTHER"]], ["columns", d => d.filings.recent.form.push("10-Q")],
  ["missing column", d => delete d.filings.recent.primaryDocument], ["accession", d => d.filings.recent.accessionNumber[0] = "../other"],
  ["path traversal", d => d.filings.recent.primaryDocument[0] = "../other.htm"], ["URL fragment", d => d.filings.recent.primaryDocument[0] = "x.htm#other"],
  ["invalid date", d => d.filings.recent.filingDate[0] = "2026-02-30"], ["future accepted", d => d.filings.recent.acceptanceDateTime[0] = "2026-10-13T00:00:00.000Z"],
  ["future reported", d => d.filings.recent.reportDate[0] = "2026-10-13"], ["unknown timezone", d => d.filings.recent.acceptanceDateTime[0] = "2026-10-10T18:00:00"],
]) test(`invalid SEC ${name} retains gated source bytes`, () => {
  const data = secData(); mutate(data); const source = build(data);
  assert.equal(source.event.event_kind, "SCHEMA_CHANGE"); assert.deepEqual(source.facts, []); assert.deepEqual(source.bytes, secBytes(data));
});
for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.from("null")]) test(`malformed SEC body ${bytes.toString("hex")} becomes a schema gate`, () => {
  assert.equal(buildSecSubmissionsRecord(bytes, { feed: secFeed(), retrieved_at: secAt }).event.event_kind, "SCHEMA_CHANGE");
});
test("SEC parsing stays independent of prior watch history and does not declare financial corrections", () => {
  const empty = secData(); empty.filings.recent.form[0] = "4"; assert.equal(build(empty).event.event_kind, "NO_DATA");
  const first = build(); assert.deepEqual(build(undefined, { previous: first }).event, first.event);
  const amended = secData(); amended.filings.recent.form[0] = "10-Q/A";
  assert.equal(build(amended).event.supersedes_source_event_id, null); assert.match(build(amended).facts[0].limitation, /not a validated correction/);
  const duplicate = secData(); for (const values of Object.values(duplicate.filings.recent)) values.push(values[0]);
  assert.equal(build(duplicate).event.event_kind, "SCHEMA_CHANGE");
  const old = secData(); old.filings.recent.acceptanceDateTime[0] = "2026-10-09T18:00:00.000Z";
  assert.equal(build(old, { previous: first }).event.event_kind, "NEW_PERIOD");
});

test("fixed request supplies the user's contact only to SEC and retrieves no filing body", async () => {
  let calls = 0; const data = await fetchSecSubmissionsBytes(secFeed(), { fetch_impl: async (url, options) => {
    calls++; assert.equal(url, secSubmissionsUrl(secFeed().cik)); assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { accept: "application/json", "user-agent": secFeed().user_agent }); return secResponse();
  } });
  assert.equal(calls, 1); assert.deepEqual(data.bytes, secBytes());
});
for (const change of [{ status: 403, ok: false }, { url: "https://example.test/redirect" }, { body: null },
  { headers: new Headers({ "content-length": "2000001" }) }, { headers: new Headers({ "content-length": "invalid" }) },
  { headers: new Headers({ "content-length": "1" }) }]) test(`SEC request refuses incomplete or nonfixed reply ${JSON.stringify(change)}`, async () => {
  let calls = 0; await assert.rejects(fetchSecSubmissionsBytes(secFeed(), { fetch_impl: async () => { calls++; return secResponse(undefined, change); } }));
  assert.equal(calls, 1);
});
test("decompressed response length is not compared with compressed content-length", async () => {
  const data = await fetchSecSubmissionsBytes(secFeed(), { fetch_impl: async () => secResponse(undefined, { headers: new Headers({ "content-length": "20", "content-encoding": "gzip" }) }) });
  assert.deepEqual(data.bytes, secBytes());
});
test("SEC deadline covers both unresolved headers and stalled body", async () => {
  for (const fetch_impl of [() => new Promise(() => {}), async () => secResponse(undefined, { body: new ReadableStream({ pull() { return new Promise(() => {}); } }) })]) {
    const start = Date.now(); await assert.rejects(fetchSecSubmissionsBytes(secFeed(), { fetch_impl, timeout_ms: 20 }), { code: "SOURCE_FETCH_TIMEOUT" });
    assert.ok(Date.now() - start < 1000);
  }
});
test("SEC cancellation prevents a request or stops a pending request", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(fetchSecSubmissionsBytes(secFeed(), { signal: controller.signal, fetch_impl: async () => { calls++; return secResponse(); } }), { code: "SOURCE_FETCH_STOPPED" });
  assert.equal(calls, 0);
  const active = new AbortController(), pending = fetchSecSubmissionsBytes(secFeed(), { signal: active.signal, fetch_impl: () => new Promise(() => {}) }); active.abort();
  await assert.rejects(pending, { code: "SOURCE_FETCH_STOPPED" });
});
test("SEC fetch rejects invalid limits, empty bytes, oversized streams, and transport errors without raw details", async () => {
  for (const timeout_ms of [0, 20001, NaN]) await assert.rejects(fetchSecSubmissionsBytes(secFeed(), { timeout_ms }), { code: "SOURCE_CONFIG_INVALID" });
  await assert.rejects(fetchSecSubmissionsBytes(secFeed(), { fetch_impl: async () => secResponse(Buffer.alloc(0)) }), { code: "SOURCE_FETCH_FAILED" });
  await assert.rejects(fetchSecSubmissionsBytes(secFeed(), { fetch_impl: async () => secResponse(Buffer.alloc(2000001)) }), { code: "SOURCE_BYTES_LIMIT" });
  await assert.rejects(fetchSecSubmissionsBytes(secFeed(), { fetch_impl: async () => { throw Error("PRIVATE_TRANSPORT_DETAIL"); } }), error => error.code === "SOURCE_FETCH_FAILED" && !error.message.includes("PRIVATE_"));
  assert.throws(() => buildSecSubmissionsRecord(Buffer.alloc(0), { feed: secFeed(), retrieved_at: secAt }), { code: "SOURCE_BYTES_LIMIT" });
});

test("SEC source requires rights, purpose, exact parser, issuer, scope, and schedule binding before fetch", async t => {
  const f = fixture(t), original = f.ledger.sourcePolicy(scope().watch_id, f.config.source_id).policy; let calls = 0;
  for (const change of [{ rights_status: "HOLD", allowed_purposes: [], allow_candidate_trials: false }, { rights_status: "UNKNOWN", allowed_purposes: [], allow_candidate_trials: false },
    { allowed_purposes: [] }, { parser_version: "other" }, { issuer_map: { LITE: "other" } }, { metric_definition_ids: ["other"] }]) {
    const current = f.ledger.sourcePolicy(scope().watch_id, f.config.source_id).policy;
    f.ledger.configureSourcePolicy(scope().watch_id, { ...original, ...change, revision: current.revision + 1 });
    await assert.rejects(readSecSubmissionsSource(f.ledger, f.config, { fetch_impl: async () => { calls++; return secResponse(); }, clock: f.clock }));
  }
  assert.equal(calls, 0);
  assert.throws(() => validateScheduleConfig({ ...f.config, interval_ms: 1000 }), { code: "SCHEDULE_CONFIG_INVALID" });
  assert.throws(() => validateScheduleConfig({ ...f.config, source_id: "other" }), { code: "SCHEDULE_CONFIG_INVALID" });
});
test("a policy or watch replacement during SEC fetch cannot reach intake", async t => {
  for (const mode of ["policy", "watch"]) {
    const f = fixture(t); let calls = 0;
    await assert.rejects(readSecSubmissionsSource(f.ledger, f.config, { clock: f.clock, fetch_impl: async () => {
      calls++;
      if (mode === "policy") { const p = f.ledger.sourcePolicy(scope().watch_id, f.config.source_id).policy;
        f.ledger.configureSourcePolicy(scope().watch_id, { ...p, revision: p.revision + 1 }); }
      else f.ledger.saveRevision({ ...scope(), revision: 2 }, {});
      return secResponse();
    } }), { code: mode === "policy" ? "SOURCE_POLICY_CHANGED" : "SOURCE_SCOPE_CHANGED" });
    assert.equal(calls, 1); assert.equal(f.ledger.workspaceStatus().counts.runs, 0);
  }
});
test("SEC observation queues one research-needed job, ignores repeats and unrelated changes, and retains a stopped schedule", async t => {
  const f = fixture(t); let data = secData(), calls = 0;
  const tick = () => processScheduleTick(f.ledger, f.config.schedule_id, { clock: f.clock, source_fetch_impl: async () => { calls++; return secResponse(secBytes(data)); } });
  assert.equal((await tick()).status, "completed");
  assert.equal(f.ledger.workspaceStatus().counts.runs, 1); assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
  assert.equal(f.ledger.notices().filter(row => row.payload.kind === "research_needed").length, 1);
  assert.equal(f.ledger.workspaceStatus().counts.deliveries, 0);
  f.advance(); assert.equal((await tick()).status, "completed"); assert.equal(f.ledger.workspaceStatus().counts.runs, 1);
  data.name = "Unrelated metadata changed"; f.advance(); assert.equal((await tick()).status, "completed"); assert.equal(f.ledger.workspaceStatus().counts.runs, 1);
  data.filings.recent.accessionNumber[0] = "0000000001-26-000002"; data.filings.recent.acceptanceDateTime[0] = "2026-10-13T18:00:00.000Z";
  f.advance(); assert.equal((await tick()).status, "completed"); assert.equal(f.ledger.workspaceStatus().counts.runs, 2);
  assert.equal(f.ledger.workspaceStatus().counts.requests, 0); assert.equal(calls, 4);
  assert.equal(f.ledger.notices().filter(row => row.payload.kind === "research_needed").length, 2);
  const before = f.ledger.workspaceStatus().counts; f.ledger.stopSchedule(f.config.schedule_id); f.reopen(); f.advance();
  assert.equal((await tick()).status, "waiting"); assert.equal(calls, 4); assert.deepEqual(f.ledger.workspaceStatus().counts, before);
  assert.equal(f.ledger.scheduleStatus(f.config.schedule_id).enabled, false); f.ledger.verifyIntegrity();
});
test("the integrated SEC intake uses retained facts and gates a backward index without a second job", async t => {
  const f = fixture(t), first = () => processScheduleTick(f.ledger, f.config.schedule_id, { clock: f.clock, source_fetch_impl: async () => secResponse() });
  assert.equal((await first()).status, "completed");
  const head = f.ledger.sourceChangeHead(scope().watch_id, f.config.source_id);
  assert.equal(head.facts, undefined); assert.equal(f.ledger.sourceFacts(head.event.source_event_id).length, 1);
  f.reopen(); f.advance(); const older = secData(); older.filings.recent.acceptanceDateTime[0] = "2026-10-09T18:00:00.000Z";
  const output = await processScheduleTick(f.ledger, f.config.schedule_id, { clock: f.clock, source_fetch_impl: async () => secResponse(secBytes(older)) });
  assert.equal(output.status, "gated"); assert.deepEqual(output.tick.codes, ["SOURCE_SCHEMA_CHANGED"]);
  assert.equal(f.ledger.workspaceStatus().counts.runs, 1); assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
  assert.equal(f.ledger.notices().filter(row => row.payload.kind === "research_needed").length, 1);
  f.ledger.verifyIntegrity();
});
test("transaction-current SEC evidence gates a backward record even when its parser had no prior snapshot", async t => {
  const f = fixture(t);
  await processScheduleTick(f.ledger, f.config.schedule_id, { clock: f.clock, source_fetch_impl: async () => secResponse() });
  f.advance(); const older = secData(); older.filings.recent.acceptanceDateTime[0] = "2026-10-09T18:00:00.000Z";
  const staleParse = build(older, { retrieved_at: new Date(f.clock()).toISOString() });
  assert.equal(staleParse.event.event_kind, "NEW_PERIOD");
  const output = f.ledger.intakeSourceEvent({ ...staleParse, watch_id: scope().watch_id, method_sha256: f.config.method_sha256,
    evaluation_at: new Date(f.clock()).toISOString(), budget_window: f.config.budget_window, run_policy: policy() });
  assert.equal(output.decision.outcome, "gated"); assert.equal(output.decision.gate_code, "SOURCE_SCHEMA_CHANGED");
  assert.equal(f.ledger.workspaceStatus().counts.runs, 1); assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
  f.ledger.verifyIntegrity();
});
test("stopping during SEC fetch cannot retain an event or queue research", async t => {
  const f = fixture(t);
  const output = await processScheduleTick(f.ledger, f.config.schedule_id, { clock: f.clock, source_fetch_impl: async () => {
    f.ledger.stopSchedule(f.config.schedule_id); return secResponse();
  } });
  assert.equal(output.status, "interrupted"); assert.equal(f.ledger.sourceChangeHead(scope().watch_id, f.config.source_id), null);
  assert.equal(f.ledger.workspaceStatus().counts.runs, 0); assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
});
test("new SEC evidence and startup instructions cannot clear an unknown request or expose the contact header", async t => {
  const f = fixture(t), envelope = setup(f.ledger, 100); f.ledger.enqueue(envelope, "test-window", policy());
  const lease = f.ledger.claim("synthetic-unknown"), request = f.ledger.reserveRequest(lease, "synthetic-dispatch", estimate());
  f.ledger.markDispatched(lease, request.request_id); f.ledger.gateRun(lease, "DISPATCH_UNCERTAIN");
  const before = { requests: f.ledger.requests(envelope.run_id), budget: f.ledger.budget(scope().watch_id, "test-window") };
  const service = new WorkspaceService(f.ledger), item = service.schedules().items[0];
  const plan = service.observationPlan({ schedule_id: item.schedule_id, revision: item.revision, config_sha256: item.config_sha256 });
  assert.doesNotMatch(JSON.stringify([plan, service.schedules()]), /tests@example|SyntheticFixture/);
  assert.equal((await processScheduleTick(f.ledger, f.config.schedule_id, { clock: f.clock, source_fetch_impl: async () => secResponse() })).status, "completed");
  assert.deepEqual({ requests: f.ledger.requests(envelope.run_id), budget: f.ledger.budget(scope().watch_id, "test-window") }, before);
  assert.equal(f.ledger.workspaceStatus().counts.requests, 1); assert.equal(f.ledger.workspaceStatus().counts.deliveries, 0);
  f.ledger.verifyIntegrity();
});
