import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { runContinuousWorker } from "../client/local/continuous-worker.mjs";
import { processScheduleTick, scheduleRuntimeHash } from "../client/local/scheduler.mjs";
import { contentHash } from "../client/local/run-contract.mjs";
import { runLocal } from "../client/local-cli.mjs";
import { scope, context, policy } from "./fixtures/local-research.mjs";
import { configureEventWatch, sourcePolicy, eventFixture } from "./fixtures/source-events.mjs";

function fixture(t, { live = false, runs = 0, allowed = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-continuous-test-"))), workspace = join(root, "workspace"), feed = join(root, "feed");
  mkdirSync(feed, { mode: 0o700 }); let now = Date.parse("2026-10-13T00:00:01Z");
  // Advance within the fixture's evidence period, independent of the calendar date.
  const started = performance.now();
  const clock = live ? () => now + Math.floor(performance.now() - started) : () => now;
  let ledger = new ResearchLedger(workspace, { clock }); const method = configureEventWatch(ledger);
  if (!allowed) ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
  let calls = 0;
  const runtime = { identity: "synthetic-continuous-test", config_sha256: "a".repeat(64), execute: async input => {
    calls++; return { agent_fields: { result_state: "REVIEW_REQUIRED", summary: "Synthetic controlled output, not financial research.",
      sources: [{ url: input.research_context.sources[0].artifact.canonical_url, date: "2026-10-11", kind: "reported_fact", claim: "Synthetic fixture." }],
      drivers: [], falsifiers: [], unknowns: [], next_check_at: new Date(clock() + 86400000).toISOString() }, usage: { tokens: 1, cost_microusd: 1 } };
  } };
  const execution = { timeout_ms: 500, lease_ms: 1000, heartbeat_ms: 20, estimate: { tokens: 100, cost_microusd: 100, wall_ms: 500 } };
  const config = { schema_version: 1, schedule_id: "continuous-test", revision: 1, watch_id: scope().watch_id, scope_revision: 1,
    method_sha256: method.bundle_sha256, source_id: "synthetic-exchange", budget_window: "event-window", feed: { kind: "retained_directory", directory: feed },
    interval_ms: 1000, max_events: 10, max_runs: runs, tick_timeout_ms: 2000, run_policy: policy(), runtime_sha256: runs ? scheduleRuntimeHash(runtime, execution) : null };
  ledger.configureSchedule(config);
  const expected = { revision: 1, config_sha256: contentHash(config) };
  const controller = new AbortController(), options = { expected, signal: controller.signal, owner: "continuous-owner", clock,
    lease_ms: 1000, heartbeat_ms: 50, poll_ms: 20, runtime, execution, allow_private_context: true, allow_candidate_method: true };
  function source(n = 1) { const { bytes, ...record } = eventFixture(n), payload = { schema_version: 1, ...record, raw_base64: bytes.toString("base64") };
    writeFileSync(join(feed, contentHash(payload) + ".json"), JSON.stringify(payload), { mode: 0o600 }); }
  t.after(() => { controller.abort(); try { ledger.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, config, expected, options, controller, source, runtime, execution, clock, calls: () => calls,
    get ledger() { return ledger; }, advance(ms) { now += ms; }, reopen() { try { ledger.close(); } catch {} ledger = new ResearchLedger(workspace, { clock }); } };
}

test("continuous ownership reports heartbeat, offline expiry and fenced restart", t => {
  const e = fixture(t), first = e.ledger.claimScheduleWorker(e.config.schedule_id, "first", e.expected, 1000);
  assert.equal(e.ledger.scheduleWorkerStatus(e.config.schedule_id).state, "monitoring");
  assert.equal(e.ledger.claimScheduleWorker(e.config.schedule_id, "second", e.expected), null);
  assert.equal(e.ledger.claimSchedule(e.config.schedule_id, "finite"), null);
  e.advance(1001); e.reopen(); assert.equal(e.ledger.scheduleWorkerStatus(e.config.schedule_id).state, "offline");
  const second = e.ledger.claimScheduleWorker(e.config.schedule_id, "second", e.expected, 1000);
  assert.equal(second.fence, first.fence + 1);
  assert.throws(() => e.ledger.heartbeatScheduleWorker(first), { code: "WORKER_LEASE_LOST" });
  assert.throws(() => e.ledger.finishScheduleWorker(first), { code: "WORKER_LEASE_LOST" });
  e.ledger.finishScheduleWorker(second); e.ledger.verifyIntegrity();
});
test("worker expiry prevents a bound source intake and old tick delivery", t => {
  const e = fixture(t), worker = e.ledger.claimScheduleWorker(e.config.schedule_id, "owner", e.expected, 1000);
  const tick = e.ledger.claimSchedule(e.config.schedule_id, "owner", 2000, { worker_lease: worker }); e.advance(1001);
  assert.throws(() => e.ledger.heartbeatSchedule(tick), { code: "SCHEDULE_LEASE_LOST" });
  assert.throws(() => e.ledger.finishSchedule(tick, { status: "completed", events: 0, deliveries: 0, codes: [] }), { code: "SCHEDULE_LEASE_LOST" });
  const replacement = e.ledger.claimScheduleWorker(e.config.schedule_id, "new", e.expected);
  assert.equal(e.ledger.scheduleHistory(e.config.schedule_id)[0].status, "interrupted");
  e.ledger.finishScheduleWorker(replacement); assert.equal(e.ledger.inbox().length, 0); e.ledger.verifyIntegrity();
});
test("a live finite check takes priority over a stopped continuous worker", t => {
  const e = fixture(t), worker = e.ledger.claimScheduleWorker(e.config.schedule_id, "continuous", e.expected);
  e.ledger.finishScheduleWorker(worker);
  const tick = e.ledger.claimSchedule(e.config.schedule_id, "finite");
  assert.equal(e.ledger.pageSchedules()[0].worker_state, "checking");
  e.ledger.finishSchedule(tick, { status: "completed", events: 0, deliveries: 0, codes: [] }); e.ledger.verifyIntegrity();
});
test("explicit stop, configuration replacement and scope change cannot retarget a worker", t => {
  for (const action of ["stop", "config", "scope"]) {
    const e = fixture(t), worker = e.ledger.claimScheduleWorker(e.config.schedule_id, "owner", e.expected);
    if (action === "stop") e.ledger.stopSchedule(e.config.schedule_id);
    if (action === "config") e.ledger.configureSchedule({ ...e.config, revision: 2 });
    if (action === "scope") e.ledger.saveRevision({ ...scope(), revision: 2 }, context());
    assert.throws(() => e.ledger.heartbeatScheduleWorker(worker), { code: action === "stop" ? "WORKER_SCHEDULE_STOPPED" : action === "config" ? "WORKER_CONFIG_CHANGED" : "WORKER_SCOPE_CHANGED" });
    e.ledger.finishScheduleWorker(worker); e.ledger.verifyIntegrity();
  }
});
test("continuous loop performs two ticks and unchanged evidence never repeats synthetic AI", { timeout: 5000 }, async t => {
  const e = fixture(t, { live: true, runs: 1 }); e.source(); const ticks = [];
  const output = await runContinuousWorker(e.ledger, e.config.schedule_id, { ...e.options, onTick: tick => {
    ticks.push(tick); if (ticks.length === 2) e.controller.abort();
  } });
  assert.deepEqual(output, { status: "stopped", code: "WORKER_PROCESS_STOPPED", ticks: 2 });
  assert.equal(e.calls(), 1); assert.equal(e.ledger.inbox().length, 1);
  assert.equal(e.ledger.scheduleWorkerStatus(e.config.schedule_id).state, "offline");
  assert.equal(e.ledger.watch(scope().watch_id).interpretation_delivery_id, null); e.reopen(); e.ledger.verifyIntegrity();
});
test("a second source update reaches Inbox once through the same continuous scope", { timeout: 5000 }, async t => {
  const e = fixture(t, { live: true, runs: 1 }); e.source(); let seen = 0;
  await runContinuousWorker(e.ledger, e.config.schedule_id, { ...e.options, onTick: () => {
    if (++seen === 1) e.source(2); else e.controller.abort();
  } });
  assert.equal(seen, 2); assert.equal(e.calls(), 2); assert.equal(e.ledger.inbox().length, 2);
  assert.equal(e.ledger.watch(scope().watch_id).interpretation_delivery_id, null); e.ledger.verifyIntegrity();
});
test("HOLD and observation-only continuous loops invoke no AI", { timeout: 5000 }, async t => {
  for (const setup of [{ allowed: false, runs: 1 }, { runs: 0 }]) {
    const e = fixture(t, { live: true, ...setup }); e.source();
    await runContinuousWorker(e.ledger, e.config.schedule_id, { ...e.options, onTick: () => e.controller.abort() });
    assert.equal(e.calls(), 0); assert.equal(e.ledger.inbox().length, 0); assert.equal(e.ledger.workspaceStatus().counts.requests, 0); e.ledger.verifyIntegrity();
  }
});
test("expired retained evidence gates a continuous tick without invoking AI", { timeout: 5000 }, async t => {
  const e = fixture(t, { live: true, runs: 1 }); e.source(); e.advance(8 * 86400000);
  const ticks = [];
  await runContinuousWorker(e.ledger, e.config.schedule_id, { ...e.options, onTick: tick => {
    ticks.push(tick); e.controller.abort();
  } });
  assert.equal(ticks.length, 1); assert.equal(ticks[0].status, "gated");
  assert.ok(ticks[0].tick.codes.includes("STALE_SOURCE"));
  assert.equal(e.calls(), 0); assert.equal(e.ledger.inbox().length, 0);
  assert.equal(e.ledger.workspaceStatus().counts.requests, 0); e.ledger.verifyIntegrity();
});
test("missing execution consent and a different runtime fail before source intake", async t => {
  for (const patch of [{ allow_private_context: false }, { runtime: { identity: "different", config_sha256: "b".repeat(64), execute() { assert.fail(); } } }]) {
    const e = fixture(t, { runs: 1 }); e.source();
    const out = await runContinuousWorker(e.ledger, e.config.schedule_id, { ...e.options, ...patch });
    assert.equal(out.status, "failed"); assert.equal(e.ledger.scheduleHistory(e.config.schedule_id).length, 0);
    assert.equal(e.ledger.workspaceStatus().counts.requests, 0); e.ledger.verifyIntegrity();
  }
});
test("an in-flight retained stop exits deliberately without delivery or accounting release", async t => {
  const e = fixture(t, { live: true, runs: 1 }); e.source();
  const original = e.runtime.execute;
  e.runtime.execute = async input => { e.ledger.stopSchedule(e.config.schedule_id); return original(input); };
  const output = await runContinuousWorker(e.ledger, e.config.schedule_id, e.options);
  assert.equal(output.status, "stopped"); assert.equal(output.code, "WORKER_SCHEDULE_STOPPED");
  assert.equal(e.ledger.inbox().length, 0); assert.equal(e.ledger.budget(scope().watch_id, "event-window").gate_code, "USAGE_UNKNOWN"); e.ledger.verifyIntegrity();
});
test("continuous options reject absent cancellation and unbounded timers before writes", async t => {
  const e = fixture(t);
  for (const patch of [{ signal: undefined }, { lease_ms: 60_001 }, { heartbeat_ms: 1000 }, { poll_ms: 0 }, { onTick: false }]) {
    await assert.rejects(runContinuousWorker(e.ledger, e.config.schedule_id, { ...e.options, ...patch }), { code: "WORKER_OPTIONS_INVALID" });
  }
  assert.equal(e.ledger.scheduleWorkerStatus(e.config.schedule_id).state, "not_verified");
  assert.throws(() => e.ledger.claimScheduleWorker(e.config.schedule_id, "owner", { ...e.expected, revision: 2 }), { code: "WORKER_CONFIG_CHANGED" });
});
test("corrupt worker content and a deleted binding cannot remove parent authority", t => {
  for (const sql of ["UPDATE schedule_workers SET sha256='changed'", "DELETE FROM schedule_worker_ticks"]) {
    const e = fixture(t), worker = e.ledger.claimScheduleWorker(e.config.schedule_id, "owner", e.expected);
    const tick = e.ledger.claimSchedule(e.config.schedule_id, "owner", 2000, { worker_lease: worker });
    const db = new DatabaseSync(join(e.workspace, "research.sqlite")); db.exec(sql); db.close();
    assert.throws(() => e.ledger.heartbeatSchedule(tick)); assert.throws(() => e.ledger.verifyIntegrity(), { code: "STORAGE_CORRUPT" });
  }
});
test("schema nine upgrades with private backup and no invented running worker", t => {
  const e = fixture(t); e.ledger.close(); const db = new DatabaseSync(join(e.workspace, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers; ALTER TABLE schedule_state DROP COLUMN worker_fence; PRAGMA user_version=9;"); db.close();
  e.reopen(); assert.equal(e.ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
  assert.equal(e.ledger.scheduleWorkerStatus(e.config.schedule_id).state, "not_verified");
  assert.ok(readdirSync(e.workspace).some(name => name.startsWith("before-schema-10-")));
});
test("CLI requires continuous consent and exact pins and emits no private configuration", async t => {
  const e = fixture(t, { live: true }); e.source(); const args = ["schedule-daemon-observe", "--workspace", e.workspace, "--schedule-id", e.config.schedule_id,
    "--revision", "1", "--config-sha256", e.expected.config_sha256, "--allow-continuous"];
  assert.equal((await runLocal(args.slice(0, -1), { stdout() {} })).exitCode, 1);
  let text = ""; const output = await runLocal(args, { signal: e.controller.signal, stdout: value => {
    text += value; if (JSON.parse(value).tick) e.controller.abort();
  } });
  assert.equal(output.exitCode, 0); assert.doesNotMatch(text, /directory|private_context|el-continuous-test/);
  assert.equal(output.output.background_service_installed, false);
});
