import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, chmodSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { processScheduleTick, runScheduleWorker, scheduleRuntimeHash } from "../client/local/scheduler.mjs";
import { validateScheduleConfig } from "../client/local/schedule-contract.mjs";
import { canonicalJson, contentHash } from "../client/local/run-contract.mjs";
import { readRetainedFeed } from "../client/local/retained-feed.mjs";
import { runLocal } from "../client/local-cli.mjs";
import { spawn } from "node:child_process";
import { scope, context, limits, methodBundle } from "./fixtures/local-research.mjs";
import { configureEventWatch, eventFixture, sourcePolicy } from "./fixtures/source-events.mjs";

function env(t, { allowed = true, liveClock = false, maxRuns = 1, fault } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-scheduler-test-"))); chmodSync(root, 0o700);
  const workspace = join(root, "workspace"), feed = join(root, "feed"); mkdirSync(feed, { mode: 0o700 });
  let now = Date.parse("2026-10-12T00:00:01Z"); const clock = liveClock ? Date.now : () => now;
  let ledger = new ResearchLedger(workspace, { clock, fault }); const method = configureEventWatch(ledger, { configurePolicy: false });
  ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), rights_status: allowed ? "ALLOWED" : "HOLD" });
  let calls = 0;
  const runtime = { identity: "synthetic-schedule-test", config_sha256: contentHash({ synthetic_runtime: 1 }),
    execute: async input => {
      calls++;
      return { agent_fields: { result_state: "REVIEW_REQUIRED", summary: "Synthetic scheduled result, not investment evidence.",
        sources: [{ url: input.research_context.sources[0].artifact.canonical_url, date: "2026-10-11", kind: "reported_fact", claim: "Synthetic fixture only." }],
        drivers: [], falsifiers: [], unknowns: [], next_check_at: new Date(Date.parse(input.research_context.created_at) + 86400_000).toISOString() },
        usage: { tokens: 1, cost_microusd: 1 } };
    } };
  const execution = { timeout_ms: 500, lease_ms: 1000, heartbeat_ms: 20, estimate: { tokens: 100, cost_microusd: 100, wall_ms: 500 } };
  const config = { schema_version: 1, schedule_id: "synthetic-schedule", revision: 1, watch_id: scope().watch_id, scope_revision: 1,
    method_sha256: method.bundle_sha256, source_id: "synthetic-exchange", budget_window: "event-window",
    feed: { kind: "retained_directory", directory: feed }, interval_ms: 1000, max_events: 10, max_runs: maxRuns,
    tick_timeout_ms: 2000, run_policy: { max_attempts: 3, max_wall_ms: 100_000, not_before: 0 },
    runtime_sha256: maxRuns ? scheduleRuntimeHash(runtime, execution) : null };
  ledger.configureSchedule(config);
  const write = (number = 1, patch = {}) => {
    const { bytes, ...source } = eventFixture(number);
    const record = { schema_version: 1, ...source, raw_base64: bytes.toString("base64"), ...patch };
    const path = join(feed, `${contentHash(record)}.json`); writeFileSync(path, JSON.stringify(record), { mode: 0o600 }); return path;
  };
  const options = { clock, runtime, execution, allow_private_context: true, allow_candidate_method: true };
  t.after(() => { try { ledger.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, feed, config, clock, options, runtime, execution, write, calls: () => calls, advance: ms => { now += ms; },
    get ledger() { return ledger; }, reopen() { try { ledger.close(); } catch {} ledger = new ResearchLedger(workspace, { clock }); return ledger; } };
}

test("schedule configuration is immutable and does not claim readiness before a tick", t => {
  const e = env(t); assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).state, "configured");
  assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).research_completion_verified, false);
  assert.equal(e.ledger.configureSchedule(e.config).reused, true);
  assert.throws(() => e.ledger.configureSchedule({ ...e.config, interval_ms: 2000 }), { code: "SCHEDULE_CONFIG_CONFLICT" });
  assert.throws(() => e.ledger.configureSchedule({ ...e.config, revision: 3 }), { code: "SCHEDULE_CONFIG_CONFLICT" });
  assert.throws(() => validateScheduleConfig({ ...e.config, max_runs: 0 }), { code: "SCHEDULE_CONFIG_INVALID" });
  e.ledger.verifyIntegrity();
});

test("scheduled intake and synthetic caller execution deliver once and survive reopen", async t => {
  const e = env(t); e.write();
  const first = await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(first.status, "completed"); assert.equal(first.tick.deliveries, 1); assert.equal(e.calls(), 1);
  assert.equal(e.ledger.inbox().length, 1); assert.equal(e.ledger.watch(scope().watch_id).interpretation_delivery_id, null);
  e.advance(1000); e.reopen();
  const second = await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(second.tick.deliveries, 0); assert.equal(e.calls(), 1); assert.equal(e.ledger.scheduleHistory(e.config.schedule_id).length, 2);
  assert.equal(e.ledger.inbox().length, 1); e.ledger.verifyIntegrity();
});

test("unchanged HOLD observations retain one gate notice without AI or completed evidence", async t => {
  const e = env(t, { allowed: false }); e.write();
  const first = await processScheduleTick(e.ledger, e.config.schedule_id, e.options); e.advance(1000);
  const second = await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(first.status, "gated"); assert.equal(second.status, "gated"); assert.equal(e.calls(), 0);
  assert.equal(e.ledger.workspaceStatus().counts.requests, 0); assert.equal(e.ledger.inbox().length, 0);
  assert.equal(e.ledger.cursors(scope().watch_id)[0].completed_event_id, null);
  assert.equal(e.ledger.notices().filter(n => n.payload.kind === "source_gate").length, 1);
  assert.equal(e.ledger.notices().filter(n => n.payload.kind === "schedule_gate").length, 1);
  e.ledger.verifyIntegrity();
});

test("empty and malformed feeds do not become a no-change research result", async t => {
  const e = env(t);
  assert.deepEqual((await processScheduleTick(e.ledger, e.config.schedule_id, e.options)).tick.codes, ["SOURCE_FEED_EMPTY"]);
  e.advance(1000); writeFileSync(join(e.feed, "invalid.json"), "PRIVATE_INVALID_SOURCE", { mode: 0o600 });
  const invalid = await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(invalid.status, "failed"); assert.deepEqual(invalid.tick.codes, ["FEED_BATCH_LIMIT"]);
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_INVALID_SOURCE|el-scheduler-test/); assert.equal(e.calls(), 0);
});

test("runtime consent and exact runtime hash protect automatic dispatch", async t => {
  const e = env(t); e.write();
  const missing = await processScheduleTick(e.ledger, e.config.schedule_id, { clock: e.clock });
  assert.deepEqual(missing.tick.codes, ["CALLER_RUNTIME_CONSENT_REQUIRED"]); assert.equal(e.calls(), 0); e.advance(1000);
  const changed = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, runtime: { ...e.runtime, identity: "changed" } });
  assert.deepEqual(changed.tick.codes, ["SCHEDULE_RUNTIME_CHANGED"]); assert.equal(e.calls(), 0);
});

test("observation-only schedules cannot dispatch an injected runtime", async t => {
  const e = env(t, { maxRuns: 0 }); e.write();
  const output = await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(output.tick.deliveries, 0); assert.equal(e.calls(), 0); assert.equal(e.ledger.workspaceStatus().counts.runs, 1);
});

const attention = ledger => ledger.notices().filter(notice => notice.payload.kind === "research_needed");
function returnExternal(e, number = 1, patch = {}, selection = {}) {
  const prepared = e.ledger.prepareExternalSession({ preparation_id: `33333333-3333-4333-8333-${String(number).padStart(12, "0")}`,
    watch_id: scope().watch_id, revision: 1, method_sha256: e.config.method_sha256, source_event_ids: [`source-event-${number}`], ...selection },
  { allow_private_context: true, allow_candidate_method: true });
  const task = e.ledger.externalSessionTask(prepared.context.context_id, { allow_private_context: true, allow_candidate_method: true });
  const receipt = e.ledger.submitExternalSession({ schema_version: 1, context_id: prepared.context.context_id,
    submission_id: `44444444-4444-4444-8444-${String(number).padStart(12, "0")}`,
    session: { client: "Synthetic session", model: "synthetic-model", session_reference: `synthetic:${number}` },
    agent_fields: { result_state: "REVIEW_REQUIRED", summary: "Synthetic returned research. Not investment evidence.",
      sources: [{ url: "https://example.test/events", date: "2026-10-11", kind: "reported_fact", claim: "Synthetic source only." }],
      drivers: [], falsifiers: [], unknowns: [], next_check_at: "2026-10-13T00:00:00Z", ...patch } }, { allow_external_submission: true });
  return { task, receipt };
}

test("observation-only new evidence retains one actionable notice across repeat ticks and reopen", async t => {
  const e = env(t, { maxRuns: 0 }); e.write();
  await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(attention(e.ledger).length, 1);
  const first = attention(e.ledger)[0];
  assert.equal(first.payload.watch_id, scope().watch_id); assert.equal(first.payload.scope_revision, 1);
  assert.equal(first.payload.source_event_id, "source-event-1"); assert.equal(first.payload.method_sha256, e.config.method_sha256);
  assert.equal(e.calls(), 0); assert.equal(e.ledger.workspaceStatus().counts.requests, 0);
  assert.equal(e.ledger.inbox().length, 0);
  e.advance(1000); e.reopen(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.deepEqual(attention(e.ledger), [first]);
  e.ledger.acknowledgeNotice(first.notice_id); e.advance(1000);
  await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(attention(e.ledger).length, 0); e.ledger.verifyIntegrity();
});

test("external return resolves only its exact evidence notice and keeps native accounting untouched", async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); e.write(2);
  await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(attention(e.ledger).length, 2);
  const budget = e.ledger.budget(scope().watch_id, "event-window"), before = e.ledger.workspaceStatus().counts;
  const { receipt } = returnExternal(e);
  assert.deepEqual(attention(e.ledger).map(notice => notice.payload.source_event_id), ["source-event-2"]);
  assert.equal(e.ledger.notices().filter(notice => notice.payload.kind === "external_research_review").length, 1);
  assert.deepEqual(e.ledger.budget(scope().watch_id, "event-window"), budget);
  const after = e.ledger.workspaceStatus().counts;
  for (const key of ["runs", "requests", "receipts", "deliveries"]) assert.equal(after[key], before[key]);
  assert.equal(e.ledger.externalSessionStatus(e.ledger.externalSessionRecord(receipt.record_id).context.context_id).accepted_evidence, false);
  e.advance(1000); e.reopen(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(attention(e.ledger).length, 1); assert.equal(e.calls(), 0); e.ledger.verifyIntegrity();
});

test("second synthetic source update carries accepted external evidence and preserves human judgment", async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  const first = returnExternal(e).receipt;
  const review = (id, action, revision) => e.ledger.reviewExternalSession({ external_record_id: id, action,
    note: "Synthetic human decision in an isolated test.", review_id: `synthetic-review-${revision}`, expected_revision: revision }, { confirm_human_review: true });
  review(first.record_id, "accept_evidence", 0); review(first.record_id, "accept_interpretation", 1);
  e.advance(1000); e.write(2); e.reopen(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(attention(e.ledger).length, 1); const second = returnExternal(e, 2);
  assert.equal(second.task.baseline_context[0].purpose, "comparison_evidence_only");
  assert.equal(second.task.context.baselines[0].pack_version, first.record_id);
  for (const [index, action] of ["received", "revisit", "reject"].entries()) review(second.receipt.record_id, action, index + 2);
  e.reopen(); const detail = e.ledger.workspaceExternalSessionRecord(second.receipt.record_id);
  assert.equal(detail.evidence_reference.id, first.record_id); assert.equal(detail.interpretation_reference.id, first.record_id);
  assert.equal(detail.accepted_evidence, false); assert.equal(detail.accepted_interpretation, false);
  assert.equal(e.ledger.workspaceStatus().counts.requests, 0); assert.equal(attention(e.ledger).length, 0);
  e.ledger.verifyIntegrity();
});

test("native delivery resolves an earlier observation notice without marking evidence accepted", async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(attention(e.ledger).length, 1);
  // Simulate an explicitly authorized native completion through the existing API, not a real model call.
  const lease = e.ledger.claim("synthetic-native-completion");
  const task = e.ledger.executionContext(lease);
  const result = { schema_version: 1, result_id: "11111111-2222-4333-8444-555555555555", watch_id: scope().watch_id,
    scope_revision: 1, theme_id: scope().theme_id, symbols: scope().symbols,
    result_state: "SOURCE_NEEDED", summary: "Synthetic missing evidence.", sources: [], drivers: [], falsifiers: [], unknowns: [],
    created_at: new Date(e.clock()).toISOString(), next_check_at: "2026-10-13T00:00:00Z" };
  assert.ok(task); e.ledger.finish(lease, result);
  assert.equal(attention(e.ledger).length, 0); assert.equal(e.ledger.inbox().length, 1);
  assert.equal(e.ledger.watch(scope().watch_id).evidence_delivery_id, null); e.ledger.verifyIntegrity();
});

for (const [allowed, maxRuns] of [[false, 0], [true, 1]]) test(`held or native work does not create observation attention (${allowed},${maxRuns})`, async t => {
  const e = env(t, { allowed, maxRuns }); e.write();
  await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(attention(e.ledger).length, 0); e.ledger.verifyIntegrity();
});

for (const phase of ["before_commit", "after_commit"]) test(`external attention resolution remains atomic with a ${phase} fault`, async t => {
  let armed = false;
  const e = env(t, { maxRuns: 0, fault: point => {
    if (armed && point === `external_submit:${phase}`) { armed = false; throw Error("Synthetic commit interruption."); }
  } });
  e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options); armed = true;
  assert.throws(() => returnExternal(e)); e.reopen();
  assert.equal(attention(e.ledger).length, phase === "before_commit" ? 1 : 0);
  const retry = returnExternal(e); assert.equal(retry.receipt.reused, phase === "after_commit");
  assert.equal(attention(e.ledger).length, 0);
  assert.equal(e.ledger.notices().filter(notice => notice.payload.kind === "external_research_review").length, 1);
  assert.equal(e.ledger.workspaceStatus().counts.requests, 0); e.ledger.verifyIntegrity();
});

for (const different of ["watch", "method"]) test(`an external return for another ${different} cannot resolve the original notice`, async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  const before = attention(e.ledger), selection = {};
  if (different === "watch") {
    selection.watch_id = "55555555-5555-4555-8555-555555555555";
    e.ledger.saveRevision({ ...scope(), watch_id: selection.watch_id }, context());
    e.ledger.configureSourcePolicy(selection.watch_id, sourcePolicy());
  } else {
    const method = methodBundle(); delete method.content_sha256; method.version = "synthetic-other-method";
    method.content_sha256 = contentHash(method); selection.method_sha256 = e.ledger.retainMethod(method).bundle_sha256;
  }
  returnExternal(e, 1, {}, selection);
  assert.deepEqual(attention(e.ledger), before); e.ledger.verifyIntegrity();
});

test("a result returned before observation does not create a redundant evidence reminder", async t => {
  const e = env(t, { maxRuns: 0 }), retained = eventFixture();
  e.ledger.retainSource(retained.event, retained.artifact, retained.bytes); returnExternal(e);
  e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(attention(e.ledger).length, 0); assert.equal(e.calls(), 0); e.ledger.verifyIntegrity();
});

for (const tamper of ["context", "manifest"]) test(`observation does not trust an unvalidated external ${tamper} when suppressing attention`, async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options); returnExternal(e);
  const db = new DatabaseSync(join(e.workspace, "research.sqlite"));
  try {
    if (tamper === "manifest") db.exec("UPDATE external_session_manifest SET sha256='invalid'");
    else {
      const row = db.prepare("SELECT context_id,payload_json FROM external_session_contexts LIMIT 1").get();
      const payload = JSON.parse(row.payload_json); payload.context.source_records[0].event.source_event_id = "source-event-2";
      db.prepare("UPDATE external_session_contexts SET payload_json=? WHERE context_id=?").run(canonicalJson(payload), row.context_id);
    }
  } finally { db.close(); }
  e.advance(1000); e.write(2);
  const output = await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(output.status, "failed"); assert.deepEqual(output.tick.codes, ["EXTERNAL_SESSION_STORAGE_INVALID"]);
  assert.equal(e.ledger.workspaceStatus().counts.runs, 1); assert.equal(e.calls(), 0);
});

test("a changed scope disables the old schedule without executing another watch", async t => {
  const e = env(t); e.write(); e.ledger.saveRevision(scope(2), context());
  const output = await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(output.schedule.state, "stopped"); assert.equal(e.calls(), 0); assert.equal(e.ledger.workspaceStatus().counts.runs, 0);
});

test("two connections cannot own one schedule and an expired worker is fenced", t => {
  const e = env(t); const other = new ResearchLedger(e.workspace, { clock: e.clock }); t.after(() => other.close());
  const first = e.ledger.claimSchedule(e.config.schedule_id, "first", 500);
  assert.equal(other.claimSchedule(e.config.schedule_id, "second", 500), null); e.advance(501);
  const second = other.claimSchedule(e.config.schedule_id, "second", 500);
  assert.equal(second.fence, first.fence + 1);
  assert.throws(() => e.ledger.finishSchedule(first, { status: "completed", events: 0, deliveries: 0, codes: [] }), { code: "SCHEDULE_LEASE_LOST" });
  other.finishSchedule(second, { status: "completed", events: 0, deliveries: 0, codes: [] });
  const history = e.ledger.scheduleHistory(e.config.schedule_id);
  assert.equal(history[0].status, "interrupted"); assert.equal(history[0].events, null); assert.equal(history.length, 2); e.ledger.verifyIntegrity();
});

test("stopping a running schedule preserves unknown counts and rejects its lease", t => {
  const e = env(t); const lease = e.ledger.claimSchedule(e.config.schedule_id, "worker");
  e.ledger.stopSchedule(e.config.schedule_id); e.ledger.stopSchedule(e.config.schedule_id);
  assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).state, "stopped");
  assert.equal(e.ledger.scheduleHistory(e.config.schedule_id).length, 1);
  assert.throws(() => e.ledger.heartbeatSchedule(lease), { code: "SCHEDULE_LEASE_LOST" }); e.ledger.verifyIntegrity();
});

const resumePins = e => ({ revision: e.config.revision, config_sha256: contentHash(e.config), confirm_resume: true });
test("explicit observation resume saves only the next configuration and preserves research state", async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  e.advance(1000);
  const oldLease = e.ledger.claimSchedule(e.config.schedule_id, "old-check");
  assert.ok(oldLease);
  e.ledger.stopSchedule(e.config.schedule_id);
  const before = e.ledger.workspaceStatus().counts, history = e.ledger.scheduleHistory(e.config.schedule_id);
  const budget = e.ledger.budget(scope().watch_id, "event-window"), watch = e.ledger.watch(scope().watch_id);
  const resumed = e.ledger.resumeObservationSchedule(e.config.schedule_id, resumePins(e));
  assert.equal(resumed.reused, false); assert.equal(resumed.schedule.revision, 2); assert.equal(resumed.schedule.enabled, true);
  assert.equal(resumed.schedule.config_sha256, contentHash({ ...e.config, revision: 2 }));
  assert.equal(resumed.worker_started, false); assert.equal(resumed.ai_execution_authorized, false);
  assert.deepEqual(e.ledger.workspaceStatus().counts, before); assert.deepEqual(e.ledger.watch(scope().watch_id), watch);
  assert.deepEqual(e.ledger.budget(scope().watch_id, "event-window"), budget);
  assert.deepEqual(e.ledger.scheduleHistory(e.config.schedule_id), history);
  assert.throws(() => e.ledger.heartbeatSchedule(oldLease), { code: "SCHEDULE_LEASE_LOST" });
  const replay = e.reopen().resumeObservationSchedule(e.config.schedule_id, resumePins(e)); assert.equal(replay.reused, true);
  assert.equal(e.ledger.configureSchedule(e.config).reused, true); assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).revision, 2);
  assert.equal(e.calls(), 0); e.ledger.verifyIntegrity();
});

test("replaying an earlier resume cannot undo a later stop or replace a newer configuration", t => {
  const e = env(t, { maxRuns: 0 }); e.ledger.stopSchedule(e.config.schedule_id);
  const resumed = e.ledger.resumeObservationSchedule(e.config.schedule_id, resumePins(e));
  e.ledger.stopSchedule(e.config.schedule_id, resumed.schedule);
  const replay = e.ledger.resumeObservationSchedule(e.config.schedule_id, resumePins(e));
  assert.equal(replay.reused, true); assert.equal(replay.schedule.enabled, false); assert.equal(replay.schedule.revision, 2);
  e.ledger.configureSchedule({ ...e.config, revision: 3, interval_ms: 2000 });
  assert.throws(() => e.ledger.resumeObservationSchedule(e.config.schedule_id, resumePins(e)), { code: "SCHEDULE_CONFLICT" });
  assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).revision, 3); e.ledger.verifyIntegrity();
});

for (const gate of ["HOLD", "UNKNOWN", "purpose", "scope", "running", "execution", "hash", "missing"]) {
  test(`observation resume refuses ${gate} without changing the stopped setup`, t => {
    const e = env(t, { maxRuns: gate === "execution" ? 1 : 0 });
    if (gate !== "running") e.ledger.stopSchedule(e.config.schedule_id);
    if (["HOLD", "UNKNOWN", "purpose"].includes(gate)) e.ledger.configureSourcePolicy(scope().watch_id,
      { ...sourcePolicy(2), ...(gate === "purpose" ? { allowed_purposes: [] } : { rights_status: gate }) });
    if (gate === "scope") e.ledger.saveRevision(scope(2), context());
    const before = e.ledger.workspaceStatus(), status = e.ledger.scheduleStatus(e.config.schedule_id);
    const code = ["HOLD", "UNKNOWN", "purpose"].includes(gate) ? "SOURCE_RIGHTS_GATED" : gate === "scope" ? "SCHEDULE_SCOPE_CHANGED"
      : gate === "execution" ? "OBSERVATION_SCHEDULE_REQUIRED" : gate === "missing" ? "SCHEDULE_MISSING" : "SCHEDULE_CONFLICT";
    assert.throws(() => e.ledger.resumeObservationSchedule(gate === "missing" ? "missing-schedule" : e.config.schedule_id,
      { ...resumePins(e), ...(gate === "hash" ? { config_sha256: "f".repeat(64) } : {}) }), { code });
    assert.deepEqual(e.ledger.workspaceStatus(), before); assert.deepEqual(e.ledger.scheduleStatus(e.config.schedule_id), status);
    assert.equal(e.ledger.configureSchedule({ ...e.config, revision: 2, scope_revision: gate === "scope" ? 2 : 1 }).reused, false);
    e.ledger.verifyIntegrity();
  });
}

for (const patch of [{ confirm_resume: false }, { revision: 0 }, { revision: 1.5 }, { config_sha256: "invalid" }, { feed: {} }]) {
  test(`observation resume rejects invalid pins ${JSON.stringify(patch)}`, t => {
    const e = env(t, { maxRuns: 0 }); e.ledger.stopSchedule(e.config.schedule_id);
    assert.throws(() => e.ledger.resumeObservationSchedule(e.config.schedule_id, { ...resumePins(e), ...patch }), { code: "INVALID_INPUT" });
    assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).enabled, false); e.ledger.verifyIntegrity();
  });
}

test("two ledger connections replay one observation revision rather than create two resumes", t => {
  const e = env(t, { maxRuns: 0 }); e.ledger.stopSchedule(e.config.schedule_id);
  const other = new ResearchLedger(e.workspace, { clock: e.clock }); t.after(() => other.close());
  assert.equal(e.ledger.resumeObservationSchedule(e.config.schedule_id, resumePins(e)).reused, false);
  assert.equal(other.resumeObservationSchedule(e.config.schedule_id, resumePins(e)).reused, true);
  assert.equal(other.scheduleStatus(e.config.schedule_id).revision, 2); other.verifyIntegrity();
});

for (const phase of ["before_commit", "after_commit"]) test(`observation resume remains recoverable after ${phase} interruption`, t => {
  let armed = false;
  const e = env(t, { maxRuns: 0, fault: point => {
    if (armed && point === `schedule_resume_observe:${phase}`) { armed = false; throw Error("Synthetic resume interruption."); }
  } });
  e.ledger.stopSchedule(e.config.schedule_id); armed = true;
  assert.throws(() => e.ledger.resumeObservationSchedule(e.config.schedule_id, resumePins(e)));
  const ledger = e.reopen(), retry = ledger.resumeObservationSchedule(e.config.schedule_id, resumePins(e));
  assert.equal(retry.reused, phase === "after_commit"); assert.equal(retry.schedule.revision, 2); ledger.verifyIntegrity();
});

test("resumed observation uses existing event decisions and does not repeat research", async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  const original = attention(e.ledger); e.ledger.stopSchedule(e.config.schedule_id);
  const resumed = e.ledger.resumeObservationSchedule(e.config.schedule_id, resumePins(e));
  await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.deepEqual(attention(e.ledger), original); assert.equal(e.ledger.workspaceStatus().counts.runs, 1); assert.equal(e.calls(), 0);
  assert.equal(e.ledger.scheduleObservationPlan(e.config.schedule_id, resumed.schedule).available, true); e.ledger.verifyIntegrity();
});

test("observation resume preserves a synthetic unknown-usage reservation", async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  const lease = e.ledger.claim("synthetic-unknown-accounting");
  const request = e.ledger.reserveRequest(lease, "synthetic-operation", { tokens: 1, cost_microusd: 1, wall_ms: 1 });
  e.ledger.markDispatched(lease, request.request_id); e.ledger.settleRequest(lease, request.request_id, null, { synthetic: true });
  const budget = e.ledger.budget(scope().watch_id, "event-window"), counts = e.ledger.workspaceStatus().counts;
  assert.equal(budget.gate_code, "USAGE_UNKNOWN"); e.ledger.stopSchedule(e.config.schedule_id);
  e.ledger.resumeObservationSchedule(e.config.schedule_id, resumePins(e));
  assert.deepEqual(e.ledger.budget(scope().watch_id, "event-window"), budget);
  assert.deepEqual(e.ledger.workspaceStatus().counts, counts); assert.equal(e.calls(), 0); e.ledger.verifyIntegrity();
});

test("observation resume invalidates old continuous pins without starting a new owner", t => {
  const e = env(t, { maxRuns: 0 }), expected = resumePins(e);
  const worker = e.ledger.claimScheduleWorker(e.config.schedule_id, "synthetic-old-worker", expected);
  e.ledger.stopSchedule(e.config.schedule_id); const resumed = e.ledger.resumeObservationSchedule(e.config.schedule_id, expected);
  assert.equal(e.ledger.scheduleWorkerStatus(e.config.schedule_id).state, "offline");
  assert.throws(() => e.ledger.heartbeatScheduleWorker(worker), { code: "WORKER_CONFIG_CHANGED" });
  assert.throws(() => e.ledger.claimScheduleWorker(e.config.schedule_id, "synthetic-old-restart", expected), { code: "WORKER_CONFIG_CHANGED" });
  e.advance(15_001);
  const replacement = e.ledger.claimScheduleWorker(e.config.schedule_id, "synthetic-new-worker", resumed.schedule);
  assert.equal(replacement.revision, 2); assert.equal(replacement.fence, worker.fence + 1); e.ledger.finishScheduleWorker(replacement);
  assert.equal(e.calls(), 0); e.ledger.verifyIntegrity();
});

test("private feed paths reject links, altered hashes, extra fields and shared permissions", t => {
  const e = env(t); const path = e.write(); chmodSync(path, 0o644);
  assert.throws(() => readRetainedFeed(e.config), { code: "FEED_FILE_UNSAFE" }); chmodSync(path, 0o600);
  writeFileSync(path, "{}"); assert.throws(() => readRetainedFeed(e.config), { code: "FEED_RECORD_INVALID" });
  rmSync(path); const link = join(e.feed, `${"a".repeat(64)}.json`); symlinkSync("/synthetic/unreadable", link);
  assert.throws(() => readRetainedFeed(e.config), { code: "FEED_FILE_UNSAFE" });
});

test("schema six receives a private backup before schedule tables and preserves all research state", t => {
  const e = env(t); e.ledger.close();
  const db = new DatabaseSync(join(e.workspace, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers;");
  db.exec("DROP TABLE thesis_reviews; DROP TABLE thesis_proposals; DROP TABLE thesis_heads; DROP TABLE thesis_manifest;");
  db.exec("DROP TABLE schedule_run_leases; DROP TABLE schedule_ticks; DROP TABLE schedule_state; DROP TABLE schedule_configs; PRAGMA user_version=6"); db.close();
  e.reopen(); assert.equal(e.ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
  assert.equal(e.ledger.watch(scope().watch_id).current_revision, 1);
  assert.ok(readdirSync(e.workspace).some(name => name.startsWith("before-schema-7-")));
});

test("a finite real-timer worker performs two due observations without background installation", { timeout: 5000 }, async t => {
  const e = env(t, { liveClock: true, maxRuns: 0 }); e.write(); const outputs = [];
  const output = await runScheduleWorker(e.ledger, e.config.schedule_id, { ...e.options, ticks: 2, onTick: tick => outputs.push(tick) });
  assert.equal(output.ticks, 2); assert.equal(outputs.length, 2); assert.ok(outputs[1].tick.started_at - outputs[0].tick.finished_at >= 1000);
  assert.equal(e.calls(), 0); assert.equal(e.ledger.scheduleHistory(e.config.schedule_id).length, 2);
});

test("next research pins accepted evidence and never accepts the new interpretation", async t => {
  const e = env(t); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  const first = e.ledger.inbox()[0]; e.ledger.review(first.delivery_id, "accept_evidence", "Synthetic explicit evidence review.", "first-evidence", 0);
  e.advance(1000); e.write(2); let seen;
  const runtime = { ...e.runtime, execute: async input => { seen = input.research_context; return e.runtime.execute(input); } };
  const output = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, runtime });
  assert.equal(output.tick.deliveries, 1); assert.equal(seen.envelope.baselines.length, 1);
  assert.equal(seen.baseline_context[0].result.result_id, first.result.result_id);
  assert.equal(seen.baseline_context[0].purpose, "comparison_evidence_only");
  assert.equal(e.ledger.watch(scope().watch_id).evidence_delivery_id, first.delivery_id);
  assert.equal(e.ledger.watch(scope().watch_id).interpretation_delivery_id, null);
});

test("CLI exposes schedule health without private feed paths or runtime consent", async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); const outputs = [];
  const call = (args) => runLocal(args, { stdout: output => outputs.push(JSON.parse(output)), clock: e.clock });
  const configured = await call(["schedule-status", "--workspace", e.workspace, "--schedule-id", e.config.schedule_id]);
  assert.equal(configured.output.state, "configured");
  const observed = await call(["schedule-observe", "--workspace", e.workspace, "--schedule-id", e.config.schedule_id, "--ticks", "1"]);
  assert.equal(observed.exitCode, 0); assert.equal(observed.output.background_service_installed, false); assert.equal(e.calls(), 0);
  assert.doesNotMatch(JSON.stringify(outputs), /retained_directory|el-scheduler-test|question|private_context/);
  const denied = await call(["schedule-run", "--workspace", e.workspace, "--schedule-id", e.config.schedule_id, "--ticks", "1"]);
  assert.equal(denied.output.code, "RUN_CONSENT_REQUIRED");
});

test("CLI resumes only an explicitly pinned stopped observation and reports no worker start", async t => {
  const e = env(t, { maxRuns: 0 }); e.ledger.stopSchedule(e.config.schedule_id); const outputs = [];
  const args = ["schedule-resume-observe", "--workspace", e.workspace, "--schedule-id", e.config.schedule_id,
    "--revision", "1", "--config-sha256", contentHash(e.config), "--confirm-resume"];
  const call = input => runLocal(input, { clock: e.clock, stdout: value => outputs.push(JSON.parse(value)) });
  assert.equal((await call(args.slice(0, -1))).output.code, "CLI_FLAGS_INVALID");
  assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).enabled, false);
  const resumed = await call(args); assert.equal(resumed.exitCode, 0); assert.equal(resumed.output.status, "configuration_saved");
  assert.equal(resumed.output.schedule.revision, 2); assert.equal(resumed.output.worker_started, false);
  assert.equal(resumed.output.ai_execution_authorized, false); assert.equal(resumed.output.reused, false);
  assert.equal((await call(args)).output.reused, true);
  assert.equal(e.ledger.workspaceStatus().counts.requests, 0); assert.equal(e.calls(), 0);
  assert.doesNotMatch(JSON.stringify(outputs), /retained_directory|el-scheduler-test|question|private_context/); e.ledger.verifyIntegrity();
});

test("external stop interrupts a dispatched caller and preserves unknown usage", async t => {
  const e = env(t); e.write(); const stop = new AbortController(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const runtime = { ...e.runtime, execute: (_input, { signal }) => { started(); return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("PRIVATE_PROVIDER_ERROR")), { once: true });
  }); } };
  const pending = processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, runtime, signal: stop.signal });
  await ready; stop.abort(); const output = await pending;
  assert.equal(output.status, "gated"); assert.equal(e.ledger.workspaceStatus().counts.requests, 1);
  assert.equal(e.ledger.workspaceStatus().requests[0].status, "unknown"); assert.equal(e.ledger.inbox().length, 0);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_PROVIDER_ERROR/); e.ledger.verifyIntegrity();
});

for (const boundary of ["before_commit", "after_commit"]) test(`SIGKILL during schedule finish at ${boundary} preserves restart`, { timeout: 10000 }, async t => {
  const e = env(t, { maxRuns: 0 });
  const code = `import {ResearchLedger} from './client/local/ledger.mjs';const db=new ResearchLedger(process.argv[1],{clock:()=>${e.clock()},fault:p=>{if(p==='schedule_finish:${boundary}')process.kill(process.pid,'SIGKILL')}});const lease=db.claimSchedule('synthetic-schedule','killed',500);db.finishSchedule(lease,{status:'completed',events:0,deliveries:0,codes:[]});db.close();`;
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, e.workspace], { stdio: "ignore" });
    child.once("error", reject); child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  assert.equal(outcome.signal, "SIGKILL"); e.advance(1001); e.reopen();
  const lease = e.ledger.claimSchedule(e.config.schedule_id, "recovered", 500);
  assert.ok(lease); e.ledger.finishSchedule(lease, { status: "completed", events: 0, deliveries: 0, codes: [] });
  assert.equal(e.ledger.scheduleHistory(e.config.schedule_id).length, 2); e.ledger.verifyIntegrity();
});

test("deleted schedule history fails verification rather than replaying a success", async t => {
  const e = env(t, { maxRuns: 0 }); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options); e.ledger.close();
  const db = new DatabaseSync(join(e.workspace, "research.sqlite")); db.exec("DELETE FROM schedule_ticks"); db.close();
  assert.throws(() => e.reopen(), { code: "STORAGE_CORRUPT" });
});

test("a scheduled worker neither claims nor recovers another watch's expired run", async t => {
  const e = env(t); const other = { ...scope(), watch_id: "8713bba6-e91e-4c1a-b756-2b18d2b7c776" };
  e.ledger.saveRevision(other, { question: "OTHER_PRIVATE_SENTINEL" });
  e.ledger.configureBudget(other.watch_id, "event-window", limits()); e.ledger.configureSourcePolicy(other.watch_id, sourcePolicy());
  const foreign = e.ledger.intakeSourceEvent({ ...eventFixture(9), watch_id: other.watch_id, method_sha256: e.config.method_sha256,
    evaluation_at: new Date(e.clock()).toISOString(), budget_window: "event-window", run_policy: e.config.run_policy });
  const lease = e.ledger.claim("foreign-worker", 500); assert.equal(lease.run_id, foreign.run.run_id);
  e.advance(501); const before = e.ledger.run(lease.run_id); e.write();
  const output = await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
  assert.equal(output.tick.deliveries, 1); assert.equal(e.calls(), 1);
  assert.deepEqual(e.ledger.run(lease.run_id), before); e.ledger.verifyIntegrity();
});

for (const action of ["stop", "replace", "expire"]) test(`parent schedule ${action} prevents an in-flight delivery`, async t => {
  const e = env(t); e.write();
  const execution = { ...e.execution, lease_ms: 10000, estimate: { ...e.execution.estimate, wall_ms: 10000 } };
  e.ledger.configureSchedule({ ...e.config, revision: 2, runtime_sha256: scheduleRuntimeHash(e.runtime, execution) });
  const runtime = { ...e.runtime, execute: async input => {
    if (action === "stop") e.ledger.stopSchedule(e.config.schedule_id);
    if (action === "replace") e.ledger.configureSchedule({ ...e.config, revision: 3, runtime_sha256: scheduleRuntimeHash(e.runtime, execution) });
    if (action === "expire") e.advance(2001);
    return e.runtime.execute(input);
  } };
  const output = await processScheduleTick(e.ledger, e.config.schedule_id, { ...e.options, runtime, execution });
  assert.equal(output.status, "interrupted"); assert.equal(e.ledger.inbox().length, 0);
  assert.equal(e.ledger.watch(scope().watch_id).evidence_delivery_id, null);
  assert.equal(e.ledger.watch(scope().watch_id).interpretation_delivery_id, null);
  e.ledger.verifyIntegrity();
});

test("live schedule configuration corruption blocks reads and replay", t => {
  const e = env(t); const db = new DatabaseSync(join(e.workspace, "research.sqlite")); t.after(() => db.close());
  db.prepare("UPDATE schedule_configs SET config_json=?").run(canonicalJson({ ...e.config, interval_ms: 2000 }));
  assert.throws(() => e.ledger.scheduleStatus(e.config.schedule_id), { code: "STORAGE_CORRUPT" });
  assert.throws(() => e.ledger.configureSchedule(e.config), { code: "STORAGE_CORRUPT" });
  assert.throws(() => e.ledger.claimSchedule(e.config.schedule_id, "worker"), { code: "STORAGE_CORRUPT" });
});

for (const change of [{ schema_version: 999 }, { unexpected: true }, { codes: ["FALSE_GATE"] }, { codes: ["FALSE_GATE", "FALSE_GATE"] }, { events: 101 }]) {
  test(`changed schedule tick fields fail live and retained checks: ${Object.keys(change)[0]}`, async t => {
    const e = env(t, { maxRuns: 0 }); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, e.options);
    const db = new DatabaseSync(join(e.workspace, "research.sqlite"));
    const row = db.prepare("SELECT * FROM schedule_ticks").get(); const changed = { ...JSON.parse(row.record_json), ...change };
    db.prepare("UPDATE schedule_ticks SET sha256=?,record_json=?").run(contentHash(changed), canonicalJson(changed)); db.close();
    assert.throws(() => e.ledger.scheduleStatus(e.config.schedule_id), { code: "STORAGE_CORRUPT" });
    assert.throws(() => e.ledger.scheduleHistory(e.config.schedule_id), { code: "STORAGE_CORRUPT" });
    assert.throws(() => e.ledger.verifyIntegrity(), { code: "STORAGE_CORRUPT" });
  });
}

for (const removed of ["binding", "marker"]) test(`deleted ${removed} cannot remove parent schedule authority`, async t => {
  const e = env(t); e.write(); await processScheduleTick(e.ledger, e.config.schedule_id, { clock: e.clock }); e.advance(1000);
  const parent = e.ledger.claimSchedule(e.config.schedule_id, "worker");
  const lease = e.ledger.claim("worker", 1000, { schedule_lease: parent }); assert.ok(lease);
  const db = new DatabaseSync(join(e.workspace, "research.sqlite"));
  db.exec(removed === "binding" ? "DELETE FROM schedule_run_leases" : "DELETE FROM checkpoints WHERE checkpoint_key LIKE 'schedule-binding:%'"); db.close();
  assert.throws(() => e.ledger.heartbeat(lease), { code: "STORAGE_CORRUPT" });
  assert.throws(() => e.ledger.verifyIntegrity(), { code: "STORAGE_CORRUPT" });
  assert.throws(() => e.reopen(), { code: "STORAGE_CORRUPT" });
});

test("finite workers report another owner without an unbounded retry loop", async t => {
  const e = env(t); e.ledger.claimSchedule(e.config.schedule_id, "other");
  const output = await runScheduleWorker(e.ledger, e.config.schedule_id, { ...e.options, ticks: 1 });
  assert.equal(output.busy, true); assert.equal(output.ticks, 0); assert.equal(e.calls(), 0);
  const cli = await runLocal(["schedule-observe", "--workspace", e.workspace, "--schedule-id", e.config.schedule_id, "--ticks", "1"], { stdout: () => {}, clock: e.clock });
  assert.equal(cli.exitCode, 2);
});

test("invalid cancellation signals fail before schedule claims", async t => {
  const e = env(t);
  await assert.rejects(() => processScheduleTick(e.ledger, e.config.schedule_id, { signal: {} }), { code: "SCHEDULE_SIGNAL_INVALID" });
  assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).state, "configured");
});

test("schema seven upgrade adds bindings without fabricating prior authority", t => {
  const e = env(t); const before = e.ledger.scheduleStatus(e.config.schedule_id); e.ledger.close();
  const db = new DatabaseSync(join(e.workspace, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers; ALTER TABLE schedule_state DROP COLUMN worker_fence;");
  db.exec("DROP TABLE thesis_reviews; DROP TABLE thesis_proposals; DROP TABLE thesis_heads; DROP TABLE thesis_manifest;");
  db.exec("DROP TABLE schedule_run_leases; PRAGMA user_version=7"); db.close();
  e.reopen(); assert.deepEqual(e.ledger.scheduleStatus(e.config.schedule_id), before);
  assert.ok(readdirSync(e.workspace).some(name => name.startsWith("before-schema-8-")));
  assert.equal(e.ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
});
