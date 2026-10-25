import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { startWorkspaceServer } from "../client/local/workspace-server.mjs";
import { loadWorkspaceAssets } from "../client/local/workspace-ui.mjs";
import { configureEventWatch, sourcePolicy } from "./fixtures/source-events.mjs";
import { scope, setup, result, policy } from "./fixtures/local-research.mjs";

function environment(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-tracking-workspace-test-")));
  let now = Date.parse("2026-10-12T12:00:00Z"), ledger = new ResearchLedger(join(root, "workspace"), { clock: () => now });
  const method = configureEventWatch(ledger);
  const config = { schema_version: 1, schedule_id: "user-tracking", revision: 1, watch_id: scope().watch_id, scope_revision: 1,
    method_sha256: method.bundle_sha256, source_id: "synthetic-exchange", budget_window: "event-window",
    feed: { kind: "retained_directory", directory: join(root, "PRIVATE_FEED_PATH") }, interval_ms: 1000, max_events: 10, max_runs: 0,
    tick_timeout_ms: 2000, run_policy: policy(), runtime_sha256: null };
  ledger.configureSchedule(config);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { config, workspace: join(root, "workspace"), service: new WorkspaceService(ledger), get ledger() { return ledger; }, advance(ms) { now += ms; },
    reopen() { ledger.close(); ledger = new ResearchLedger(join(root, "workspace"), { clock: () => now }); this.service = new WorkspaceService(ledger); } };
}

test("a tracking page retains one SQLite snapshot during concurrent replacement", t => {
  const e = environment(t), peer = new ResearchLedger(e.workspace), original = e.ledger.scheduleStatus.bind(e.ledger);
  t.after(() => peer.close()); let once = true;
  e.ledger.scheduleStatus = id => {
    if (once) {
      once = false;
      peer.saveRevision({ ...scope(), revision: 2, symbols: ["NVDA"] }, {});
      peer.configureSchedule({ ...e.config, revision: 2, scope_revision: 2 });
    }
    return original(id);
  };
  const item = e.service.schedules().items[0];
  assert.equal(item.revision, 1); assert.equal(item.scope_revision, 1); assert.equal(item.is_current_scope, true);
  assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).revision, 2);
});
const stop = item => ({ schedule_id: item.schedule_id, revision: item.revision, config_sha256: item.config_sha256, confirm_stop: true });
const planRequest = item => ({ schedule_id: item.schedule_id, revision: item.revision, config_sha256: item.config_sha256 });

test("source check instructions pin the current observation schedule without starting work", t => {
  const e = environment(t), before = e.ledger.workspaceStatus(), item = e.service.schedules().items[0];
  const plan = e.service.observationPlan(planRequest(item));
  assert.equal(plan.available, true); assert.equal(plan.worker_started, false); assert.equal(plan.ai_execution_authorized, false);
  assert.equal(plan.service_installation_performed, false); assert.equal(plan.source_rights_verified, false);
  assert.equal(plan.commercial_reuse_authorized, false); assert.equal(plan.payment_authorized, false); assert.equal(plan.trading_authorized, false);
  assert.equal(plan.command.command, process.execPath); assert.ok(plan.command.args[0].endsWith('/bin/equitylayer.mjs'));
  assert.deepEqual(plan.command.args.slice(1), ['local', 'schedule-daemon-observe', '--workspace', e.ledger.directory,
    '--schedule-id', item.schedule_id, '--revision', '1', '--config-sha256', item.config_sha256, '--allow-continuous']);
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE_FEED_PATH|private_context|runtime_sha256|--allow-private-context/);
  assert.deepEqual(e.ledger.workspaceStatus(), before); e.ledger.verifyIntegrity();
});

for (const reason of ['stopped', 'scope', 'HOLD', 'UNKNOWN', 'missing purpose', 'research', 'worker', 'check']) {
  test(`source check instructions refuse ${reason} without changing authority`, t => {
    const e = environment(t), item = e.service.schedules().items[0];
    if (reason === 'stopped') e.service.stopSchedule(stop(item));
    if (reason === 'scope') e.ledger.saveRevision({ ...scope(), revision: 2 }, {});
    if (['HOLD', 'UNKNOWN', 'missing purpose'].includes(reason)) e.ledger.configureSourcePolicy(scope().watch_id,
      { ...sourcePolicy(2), rights_status: reason === 'missing purpose' ? 'ALLOWED' : reason,
        allowed_purposes: [], allow_candidate_trials: false });
    if (reason === 'research') e.ledger.configureSchedule({ ...e.config, revision: 2, max_runs: 1, runtime_sha256: 'a'.repeat(64) });
    if (reason === 'worker') e.ledger.claimScheduleWorker(item.schedule_id, 'synthetic-owner', item);
    if (reason === 'check') e.ledger.claimSchedule(item.schedule_id, 'synthetic-finite-owner');
    const current = e.service.schedules().items[0], before = e.ledger.workspaceStatus();
    const plan = e.service.observationPlan(planRequest(current));
    assert.equal(plan.available, false); assert.equal(plan.command, null); assert.equal(plan.shell_command, null);
    assert.equal(plan.worker_started, false); assert.ok(plan.code); assert.ok(plan.message);
    assert.deepEqual(e.ledger.workspaceStatus(), before); e.ledger.verifyIntegrity();
  });
}

test("source check instructions reject stale pins and browser-supplied execution fields", t => {
  const e = environment(t), item = e.service.schedules().items[0];
  for (const extra of [{ revision: 0 }, { config_sha256: 'bad' }, { execute: true }, { command: '/bin/sh' }])
    assert.throws(() => e.service.observationPlan({ ...planRequest(item), ...extra }));
  e.ledger.configureSchedule({ ...e.config, revision: 2 });
  assert.throws(() => e.service.observationPlan(planRequest(item)), { code: 'SCHEDULE_CONFLICT' });
  assert.throws(() => e.service.observationPlan({ ...planRequest(item), schedule_id: 'missing' }), { code: 'SCHEDULE_MISSING' });
  assert.equal(e.ledger.workspaceStatus().counts.requests, 0);
});

test("terminal instructions quote arguments instead of interpreting source identifiers", t => {
  const e = environment(t), sentinel = join(e.workspace, 'must-not-exist');
  const directory = `${e.workspace} quote' $(touch ${sentinel}) ; &`;
  const service = new WorkspaceService({ directory, scheduleObservationPlan: () => ({ available: true, code: null,
    schedule_id: "synthetic ' $PATH ; $(false)", revision: 1, config_sha256: 'b'.repeat(64) }) });
  const output = service.observationPlan({ schedule_id: 'synthetic', revision: 1, config_sha256: 'b'.repeat(64) });
  // Parse quoted arguments with set. Do not invoke the generated command.
  const parsed = spawnSync('/bin/sh', ['-c', `set -- ${output.shell_command}; printf '%s\\0' "$@"`], { encoding: 'utf8', timeout: 2000 });
  assert.equal(parsed.status, 0); assert.deepEqual(parsed.stdout.split('\0').slice(0, -1), [output.command.command, ...output.command.args]);
  assert.equal(existsSync(sentinel), false);
});

test("an expired worker can obtain new instructions without reclaiming or clearing its old record", t => {
  const e = environment(t), item = e.service.schedules().items[0];
  e.ledger.claimScheduleWorker(item.schedule_id, 'synthetic-old', item, 1000); e.advance(1001);
  assert.equal(e.service.observationPlan(planRequest(item)).available, true);
  assert.equal(e.ledger.scheduleWorkerStatus(item.schedule_id).state, 'offline');
  e.reopen(); assert.equal(e.service.observationPlan(planRequest(item)).available, true); e.ledger.verifyIntegrity();
});

test("authenticated observation-plan HTTP returns instructions only and rejects foreign requests", async t => {
  const e = environment(t), server = await startWorkspaceServer({ service: e.service, assets: await loadWorkspaceAssets() });
  t.after(() => server.close()); const item = e.service.schedules().items[0];
  const request = { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, Origin: server.origin,
    'Content-Type': 'application/json', 'X-EquityLayer-Request': '1' }, body: JSON.stringify(planRequest(item)) };
  const path = `${server.origin}/api/schedules/observation-plan`;
  assert.equal((await fetch(path, { ...request, headers: {} })).status, 403);
  assert.equal((await fetch(path, { ...request, headers: { ...request.headers, Origin: 'https://example.test' } })).status, 403);
  assert.equal((await fetch(path)).status, 403);
  const allowed = await fetch(path, request); assert.equal(allowed.status, 200); assert.equal((await allowed.json()).worker_started, false);
  e.ledger.configureSchedule({ ...e.config, revision: 2 }); assert.equal((await fetch(path, request)).status, 409);
  assert.equal(e.ledger.scheduleWorkerStatus(item.schedule_id).state, 'not_verified'); assert.equal(e.ledger.workspaceStatus().counts.requests, 0);
});

test("tracking status exposes scope and last check without private configuration or invented workers", t => {
  const e = environment(t); const item = e.service.schedules().items[0];
  assert.equal(item.state, "configured"); assert.equal(item.worker_state, "not_verified"); assert.equal(item.mode, "observation_only");
  assert.equal(item.source_rights_status, "ALLOWED"); assert.equal(item.research_completion_verified, false);
  assert.deepEqual(item.symbols, scope().symbols.toSorted()); assert.doesNotMatch(JSON.stringify(item), /PRIVATE_FEED_PATH|private_context|runtime_sha256|directory/);
  assert.equal(e.ledger.workspaceStatus().counts.requests, 0); e.ledger.verifyIntegrity();
});
test("worker leases, interruption and failed checks are visible and persist after reopen", t => {
  const e = environment(t); const lease = e.ledger.claimSchedule(e.config.schedule_id, "test-worker", 1000);
  assert.equal(e.service.schedules().items[0].worker_state, "checking"); e.advance(1001);
  assert.equal(e.service.schedules().items[0].worker_state, "interrupted");
  const recovered = e.ledger.claimSchedule(e.config.schedule_id, "new-test-worker", 1000);
  e.ledger.finishSchedule(recovered, { status: "failed", events: 0, deliveries: 0, codes: ["SOURCE_FETCH_FAILED"] });
  e.reopen(); const item = e.service.schedules().items[0];
  assert.equal(item.last_tick.status, "failed"); assert.deepEqual(item.last_tick.codes, ["SOURCE_FETCH_FAILED"]); e.ledger.verifyIntegrity();
});
test("a stale stop cannot disable a replacement configuration", t => {
  const e = environment(t); const before = e.service.schedules().items[0];
  e.ledger.configureSchedule({ ...e.config, revision: 2 });
  assert.throws(() => e.service.stopSchedule(stop(before)), { code: "SCHEDULE_CONFLICT" });
  assert.equal(e.ledger.scheduleStatus(e.config.schedule_id).enabled, true);
  const current = e.service.schedules().items[0];
  assert.throws(() => e.service.stopSchedule({ ...stop(current), config_sha256: "a".repeat(64) }), { code: "SCHEDULE_CONFLICT" }); e.ledger.verifyIntegrity();
});
test("stopping and exact retries preserve accepted evidence and judgment", t => {
  const e = environment(t); const envelope = setup(e.ledger, 100);
  e.ledger.enqueue(envelope, "test-window", policy()); e.ledger.finish(e.ledger.claim("synthetic-worker"), result(envelope));
  e.ledger.review(envelope.delivery_id, "accept_evidence", "Synthetic explicit review.", "evidence", 0);
  e.ledger.review(envelope.delivery_id, "accept_interpretation", "Synthetic explicit review.", "judgment", 1);
  const baseline = e.ledger.watch(scope().watch_id); const item = e.service.schedules().items[0];
  const lease = e.ledger.claimSchedule(item.schedule_id, "in-flight");
  assert.equal(e.service.stopSchedule(stop(item)).stopped, true); assert.equal(e.service.stopSchedule(stop(item)).stopped, true);
  assert.throws(() => e.ledger.heartbeatSchedule(lease), { code: "SCHEDULE_LEASE_LOST" });
  e.reopen(); const watch = e.ledger.watch(scope().watch_id);
  assert.equal(watch.evidence_delivery_id, baseline.evidence_delivery_id); assert.equal(watch.interpretation_delivery_id, baseline.interpretation_delivery_id);
  assert.equal(e.service.schedules().items[0].enabled, false); e.ledger.verifyIntegrity();
});
test("tracking pages validate bounds and do not authorize source use or execution", t => {
  const e = environment(t);
  assert.equal(e.service.schedules({ watch_id: scope().watch_id, limit: 1 }).items.length, 1);
  assert.equal(e.service.schedules({ after: 1 }).items.length, 0);
  for (const input of [{ limit: 101 }, { after: -1 }, { execute: true }]) assert.throws(() => e.service.schedules(input), { code: "WORKSPACE_INPUT_INVALID" });
  const item = e.service.schedules().items[0];
  for (const input of [{ ...stop(item), confirm_stop: false }, { ...stop(item), execute: true }]) assert.throws(() => e.service.stopSchedule(input), { code: "WORKSPACE_INPUT_INVALID" });
  assert.equal(e.ledger.workspaceStatus().counts.requests, 0); e.ledger.verifyIntegrity();
});
test("authenticated HTTP tracking reads and guarded stops use the same SQLite record", async t => {
  const e = environment(t), assets = await loadWorkspaceAssets();
  const server = await startWorkspaceServer({ service: e.service, assets });
  try {
    assert.equal((await fetch(`${server.origin}/api/schedules`)).status, 403);
    const headers = { Authorization: `Bearer ${server.token}` };
    const item = (await (await fetch(`${server.origin}/api/schedules`, { headers })).json()).items[0];
    assert.equal(item.worker_state, "not_verified");
    const request = { method: "POST", headers: { ...headers, Origin: server.origin, "Content-Type": "application/json", "X-EquityLayer-Request": "1" }, body: JSON.stringify(stop(item)) };
    assert.equal((await fetch(`${server.origin}/api/schedules/stop`, { ...request, headers })).status, 403);
    e.ledger.configureSchedule({ ...e.config, revision: 2 });
    assert.equal((await fetch(`${server.origin}/api/schedules/stop`, request)).status, 409);
    const current = e.service.schedules().items[0];
    assert.equal((await fetch(`${server.origin}/api/schedules/stop`, { ...request, body: JSON.stringify(stop(current)) })).status, 200);
    assert.equal(e.ledger.scheduleStatus(current.schedule_id).enabled, false);
    for (const path of ["/api/schedules/run", "/api/schedules/configure", "/api/trade", "/api/pay"]) assert.equal((await fetch(server.origin + path, request)).status, 404);
    assert.equal(e.ledger.workspaceStatus().counts.requests, 0); e.ledger.verifyIntegrity();
  } finally { await server.close(); }
});
