import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentHash, canonicalJson } from "../client/local/run-contract.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { executeClaimedRun } from "../client/local/executor.mjs";
import { NativeRuntimeError } from "../client/local/native-runtime.mjs";
import { executionFailureSummary } from "../client/local/execution-diagnostics.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { runLocal } from "../client/local-cli.mjs";
import { setup, policy, scope } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";

function environment(t, ledgerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "el-executor-test-diagnostic-"));
  const clock = () => Date.parse("2026-10-11T00:00:02Z");
  const ledger = new ResearchLedger(root, { clock, ...ledgerOptions });
  const envelope = setup(ledger); ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  ledger.enqueue(envelope, "test-window", policy());
  const lease = ledger.claim("synthetic-diagnostic", 10000);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const options = { allow_private_context: true, allow_candidate_method: true, timeout_ms: 1000,
    lease_ms: 10000, heartbeat_ms: 500, clock, estimate: { tokens: 100, cost_microusd: 100, wall_ms: 1000 } };
  const execute = callback => executeClaimedRun(ledger, lease, { identity: "synthetic-diagnostic", config_sha256: "a".repeat(64), execute: callback }, options);
  return { root, ledger, lease, clock, options, execute };
}

for (const code of ["NATIVE_COMMAND_FAILED", "NATIVE_OUTPUT_INVALID", "NATIVE_VERSION_CHANGED", "NATIVE_COST_CONTROL_UNVERIFIED",
  "NATIVE_START_FAILED", "NATIVE_TIMEOUT", "NATIVE_OUTPUT_LIMIT", "NATIVE_STDERR_LIMIT", "NATIVE_TURN_FAILED_REPORTED", "NATIVE_CALLER_ERROR_REPORTED",
  "NATIVE_ARGUMENT_ERROR_REPORTED", "NATIVE_EXECUTABLE_MISSING", "NATIVE_EXECUTABLE_DENIED"]) {
  test(`retain ${code} separately from unknown accounting`, async t => {
    const env = environment(t);
    assert.deepEqual(await env.execute(async () => { throw new NativeRuntimeError(code, "SECRET_PROVIDER_OUTPUT"); }), { status: "gated", code: "USAGE_UNKNOWN" });
    const diagnostic = env.ledger.workspaceStatus().gates[0].execution_failure;
    assert.equal(diagnostic.failure_code, code); assert.equal(diagnostic.dispatch_state, "dispatched");
    assert.equal(env.ledger.requests(env.lease.run_id)[0].status, "unknown");
    assert.equal(env.ledger.budget(scope().watch_id, "test-window").gate_code, "USAGE_UNKNOWN");
    assert.equal(env.ledger.budget(scope().watch_id, "test-window").reserved.cost_microusd, 100);
    assert.equal(env.ledger.inbox().length, 0); assert.equal(env.ledger.claim("no-retry"), null);
    const reopened = new ResearchLedger(env.root, { clock: env.clock });
    try {
      assert.deepEqual(reopened.workspaceStatus().gates[0].execution_failure, diagnostic);
      assert.deepEqual(new WorkspaceService(reopened).status().gates[0].execution_failure, diagnostic);
    } finally { reopened.close(); }
    const status = await runLocal(["status", "--workspace", env.root], { clock: env.clock, stdout: () => {} });
    assert.equal(status.output.gates[0].execution_failure.failure_code, code);
    assert.doesNotMatch(JSON.stringify(status.output), /SECRET_PROVIDER_OUTPUT|private_context|stderr|stdout/);
    assert.equal(env.ledger.requestReceipts(diagnostic.request_id).length, 0);
    assert.equal(env.ledger.watch(scope().watch_id).evidence_delivery_id, null);
    assert.equal(env.ledger.watch(scope().watch_id).interpretation_delivery_id, null);
  });
}

test("untrusted errors cannot retain arbitrary text or spoof a native diagnosis", async t => {
  const env = environment(t); let reads = 0;
  const error = new Error("SECRET_PROVIDER_OUTPUT");
  Object.defineProperty(error, "code", { get() { reads++; return reads === 1 ? "NATIVE_COMMAND_FAILED" : "SECRET_KEY"; } });
  await env.execute(async () => { throw error; });
  assert.equal(reads, 1);
  assert.equal(env.ledger.workspaceStatus().gates[0].execution_failure.failure_code, "DISPATCH_UNCERTAIN");
  assert.doesNotMatch(JSON.stringify(env.ledger.checkpoints(env.lease.run_id)), /SECRET_PROVIDER_OUTPUT|SECRET_KEY/);
});

test("a dispatch commit fault retains the actual state without a blind retry", async t => {
  let enabled = true, calls = 0;
  const env = environment(t, { fault(point) { if (enabled && point === "dispatch:after_commit") { enabled = false; throw Error("SECRET_FAULT"); } } });
  env.options.retry_delay_ms = 0;
  assert.equal((await env.execute(() => { calls++; })).code, "USAGE_UNKNOWN"); assert.equal(calls, 0);
  const diagnostic = env.ledger.workspaceStatus().gates[0].execution_failure;
  assert.equal(diagnostic.failure_code, "DISPATCH_UNCERTAIN"); assert.equal(diagnostic.dispatch_state, "dispatched");
  assert.equal(env.ledger.claim("no-retry"), null);
});

test("the diagnostic and gate commit together or both roll back", t => {
  let enabled = true;
  const env = environment(t, { fault(point) { if (enabled && point === "gate_run:before_commit") throw Error("SECRET_WRITE_FAILURE"); } });
  const request = env.ledger.reserveRequest(env.lease, "synthetic-operation", env.options.estimate);
  env.ledger.markDispatched(env.lease, request.request_id);
  assert.throws(() => env.ledger.gateRun(env.lease, "NATIVE_COMMAND_FAILED", "NATIVE_COMMAND_FAILED"));
  assert.equal(env.ledger.run(env.lease.run_id).status, "running");
  assert.equal(env.ledger.checkpoints(env.lease.run_id).some(item => item.key.startsWith("executor:failure:")), false);
  enabled = false;
  assert.equal(env.ledger.gateRun(env.lease, "NATIVE_COMMAND_FAILED", "NATIVE_COMMAND_FAILED").code, "USAGE_UNKNOWN");
  assert.equal(env.ledger.workspaceStatus().gates[0].execution_failure.dispatch_state, "dispatched");
});

test("invalid diagnostic fields do not enter the ledger or a summary", t => {
  const env = environment(t);
  assert.throws(() => env.ledger.gateRun(env.lease, "NATIVE_COMMAND_FAILED", "SECRET_CODE"), { code: "INVALID_INPUT" });
  assert.equal(env.ledger.run(env.lease.run_id).status, "running");
  const record = { schema_version: 1, failure_code: "NATIVE_COMMAND_FAILED", request_id: null, dispatch_state: "none" };
  assert.ok(executionFailureSummary(record));
  for (const patch of [{ message: "SECRET_KEY" }, { failure_code: "SECRET_KEY" }, { request_id: "SECRET_PATH" }, { dispatch_state: "settled" }]) {
    assert.equal(executionFailureSummary({ ...record, ...patch }), null);
  }
});

test("a failure before reservation does not claim model dispatch or usage", async t => {
  const env = environment(t);
  env.ledger.reserveRequest = () => { throw new Error("SECRET_RESERVATION_FAILURE"); };
  assert.equal((await env.execute(() => assert.fail("No dispatch permitted."))).code, "PREDISPATCH_FAILED");
  const diagnostic = env.ledger.workspaceStatus().gates[0].execution_failure;
  assert.equal(diagnostic.dispatch_state, "none"); assert.equal(diagnostic.request_id, null);
  assert.equal(env.ledger.workspaceStatus().counts.requests, 0);
  assert.equal(env.ledger.budget(scope().watch_id, "test-window").gate_code, null);
});

for (const tamper of ["request", "none", "settled", "fence"]) test(`reject a rehashed diagnostic with a changed ${tamper} binding`, async t => {
  const env = environment(t);
  await env.execute(async () => { throw new NativeRuntimeError("NATIVE_COMMAND_FAILED", "Synthetic failure."); });
  const row = env.ledger.checkpoints(env.lease.run_id).find(item => item.key.startsWith("executor:failure:"));
  const payload = { ...row.payload };
  if (tamper === "request") payload.request_id = "el-request-" + "b".repeat(64);
  if (tamper === "none") { payload.request_id = null; payload.dispatch_state = "none"; }
  if (tamper === "settled") payload.dispatch_state = "settled";
  const db = new DatabaseSync(env.ledger.path);
  try {
    if (tamper === "fence") db.prepare("UPDATE checkpoints SET checkpoint_key=? WHERE run_id=? AND checkpoint_key=?").run("executor:failure:999", env.lease.run_id, row.key);
    else db.prepare("UPDATE checkpoints SET payload_json=?,sha256=? WHERE run_id=? AND checkpoint_key=?").run(canonicalJson(payload), contentHash(payload), env.lease.run_id, row.key);
  } finally { db.close(); }
  assert.throws(() => env.ledger.verifyIntegrity(), { code: "STORAGE_CORRUPT" });
  if (tamper !== "fence") assert.throws(() => env.ledger.workspaceStatus(), { code: "STORAGE_CORRUPT" });
  assert.throws(() => new ResearchLedger(env.root, { clock: env.clock }), { code: "STORAGE_CORRUPT" });
});
