import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { executeClaimedRun } from "../client/local/executor.mjs";
import { setup, policy, result, limits, scope } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";

function environment(t, ledgerOptions = {}, sourceOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "el-executor-test-"));
  let now = Date.parse("2026-10-11T00:00:02Z");
  const ledger = new ResearchLedger(directory, { clock: () => now, ...ledgerOptions });
  const envelope = setup(ledger); ledger.enqueue(envelope, "test-window", policy());
  if (sourceOptions !== null) ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), ...sourceOptions });
  const lease = ledger.claim("synthetic-worker", 1000);
  t.after(() => ledger.close());
  return { ledger, directory, envelope, lease, setNow: (number) => { now = number; }, clock: () => now };
}
const fields = (envelope) => {
  const all = result(envelope);
  return Object.fromEntries(["result_state", "summary", "sources", "drivers", "falsifiers", "unknowns", "next_check_at"].map((key) => [key, all[key]]));
};
const runtime = (env, execute) => ({ identity: "synthetic-runtime-v1", config_sha256: "a".repeat(64),
  execute: execute ?? (async () => ({ agent_fields: fields(env.envelope), usage: { tokens: 10, cost_microusd: 20 } })) });
const options = (env, overrides = {}) => ({ allow_private_context: true, allow_candidate_method: true, timeout_ms: 200,
  heartbeat_ms: 20, lease_ms: 1000, clock: env.clock, estimate: { tokens: 100, cost_microusd: 100, wall_ms: 500 }, ...overrides });
const execute = (env, engine = runtime(env), overrides = {}) => executeClaimedRun(env.ledger, env.lease, engine, options(env, overrides));

test("executor pins input and produces one immutable scoped result", async (t) => {
  const env = environment(t); let seen;
  const response = await execute(env, runtime(env, async (input) => {
    seen = input; assert.ok(Object.isFrozen(input.research_context.private_context));
    return { agent_fields: fields(env.envelope), usage: { tokens: 10, cost_microusd: 20 } };
  }));
  assert.equal(response.status, "completed"); assert.equal(response.result.watch_id, env.envelope.scope.watch_id);
  assert.equal(response.result.created_at, seen.research_context.created_at);
  assert.equal(env.ledger.inbox().length, 1);
  assert.ok(env.ledger.checkpoints(env.lease.run_id).some((item) => item.key === "executor:validated-result"));
});
test("private context consent prevents runtime dispatch", async (t) => {
  const env = environment(t); let calls = 0;
  const response = await execute(env, runtime(env, () => { calls++; }), { allow_private_context: false });
  assert.equal(response.code, "PRIVATE_CONTEXT_CONSENT_REQUIRED"); assert.equal(calls, 0);
});
test("candidate method consent prevents runtime dispatch", async (t) => {
  const env = environment(t); let calls = 0;
  assert.equal((await execute(env, runtime(env, () => { calls++; }), { allow_candidate_method: false })).code, "METHOD_CONSENT_REQUIRED");
  assert.equal(calls, 0);
});
test("runtime changes gate before dispatch after restart", async (t) => {
  const env = environment(t);
  env.ledger.checkpoint(env.lease, "executor:runtime", { schema_version: 1, identity: "other-runtime", config_sha256: "b".repeat(64) });
  assert.equal((await execute(env)).code, "RUNTIME_CHANGED"); assert.equal(env.ledger.inbox().length, 0);
});
test("budget exhaustion prevents runtime dispatch", async (t) => {
  const env = environment(t); let calls = 0;
  assert.equal((await execute(env, runtime(env, () => { calls++; }), { estimate: { tokens: limits().tokens + 1, cost_microusd: 100, wall_ms: 500 } })).code, "BUDGET_EXHAUSTED"); assert.equal(calls, 0);
});
test("usage overruns gate after actual settlement", async (t) => {
  const env = environment(t);
  const response = await execute(env, runtime(env, async () => ({ agent_fields: fields(env.envelope), usage: { tokens: 101, cost_microusd: 20 } })));
  assert.equal(response.code, "BUDGET_EXCEEDED"); assert.equal(env.ledger.inbox().length, 0);
});
for (const usage of [null, { tokens: -1, cost_microusd: 0 }]) test(`unknown or invalid usage gates ${JSON.stringify(usage)}`, async (t) => {
  const env = environment(t);
  assert.equal((await execute(env, runtime(env, async () => ({ agent_fields: fields(env.envelope), usage })))).code, "USAGE_UNKNOWN");
  assert.equal(env.ledger.inbox().length, 0);
});
for (const extra of ["result_id", "watch_id", "baseline", "purchase_records"]) test(`agent cannot supply ${extra}`, async (t) => {
  const env = environment(t);
  const response = await execute(env, runtime(env, async () => ({ agent_fields: { ...fields(env.envelope), [extra]: "synthetic" }, usage: { tokens: 1, cost_microusd: 1 } })));
  assert.equal(response.code, "AGENT_FIELDS_INVALID"); assert.equal(env.ledger.inbox().length, 0);
});
test("shared advice guard blocks investment instructions", async (t) => {
  const env = environment(t);
  const response = await execute(env, runtime(env, async () => ({ agent_fields: { ...fields(env.envelope), summary: "Buy LITE now." }, usage: { tokens: 1, cost_microusd: 1 } })));
  assert.equal(response.code, "RESEARCH_ADVICE_BLOCKED");
});
test("unretained sources cannot enter a result", async (t) => {
  const env = environment(t); const data = fields(env.envelope); data.sources[0].url = "https://example.test/unretained";
  assert.equal((await execute(env, runtime(env, async () => ({ agent_fields: data, usage: { tokens: 1, cost_microusd: 1 } })))).code, "RESULT_SOURCE_INVALID");
});
test("invalid dates and source state fail validation", async (t) => {
  const env = environment(t); const data = fields(env.envelope); data.sources = []; data.next_check_at = "2026-02-30T00:00:00Z";
  assert.equal((await execute(env, runtime(env, async () => ({ agent_fields: data, usage: { tokens: 1, cost_microusd: 1 } })))).code, "RESULT_INVALID");
});
test("SOURCE_NEEDED can retain explicit unknowns without a citation", async (t) => {
  const env = environment(t); const data = fields(env.envelope); data.sources = []; data.result_state = "SOURCE_NEEDED"; data.unknowns = ["Synthetic evidence is unavailable."];
  assert.equal((await execute(env, runtime(env, async () => ({ agent_fields: data, usage: { tokens: 1, cost_microusd: 1 } })))).status, "completed");
});
test("dispatched exceptions gate without a blind retry", async (t) => {
  const env = environment(t); let calls = 0;
  assert.equal((await execute(env, runtime(env, async () => { calls++; throw new Error("SECRET_SENTINEL"); }), { retry_delay_ms: 0 })).code, "USAGE_UNKNOWN");
  assert.equal(calls, 1); assert.equal(env.ledger.claim("another-worker"), null);
});
test("timeout aborts execution and retains late output only as a receipt", async (t) => {
  const env = environment(t); let resolve, signal, receipts = 0;
  const original = env.ledger.recordRequestReceipt.bind(env.ledger);
  env.ledger.recordRequestReceipt = (...args) => { receipts++; return original(...args); };
  const task = execute(env, runtime(env, (_input, config) => { signal = config.signal; return new Promise((done) => { resolve = done; }); }), { timeout_ms: 30 });
  assert.equal((await task).code, "USAGE_UNKNOWN"); assert.equal(signal.aborted, true);
  resolve({ agent_fields: fields(env.envelope), usage: { tokens: 2, cost_microusd: 2 } });
  await new Promise((done) => setImmediate(done));
  assert.equal(receipts, 1); assert.equal(env.ledger.inbox().length, 0); assert.equal(env.ledger.run(env.lease.run_id).status, "gated");
});
test("heartbeat lease loss aborts and never delivers a stale result", async (t) => {
  const env = environment(t); let resolve, signal;
  env.ledger.heartbeat = () => { throw Object.assign(new Error("Synthetic lease loss."), { code: "LEASE_LOST" }); };
  const response = await execute(env, runtime(env, (_input, config) => { signal = config.signal; return new Promise((done) => { resolve = done; }); }));
  assert.equal(response.code, "LEASE_LOST"); assert.equal(signal.aborted, true);
  resolve({ agent_fields: fields(env.envelope), usage: { tokens: 1, cost_microusd: 1 } });
  await new Promise((done) => setImmediate(done)); assert.equal(env.ledger.inbox().length, 0);
});
test("concurrent calls cannot dispatch the same lease twice", async (t) => {
  const env = environment(t); let resolve, calls = 0;
  const first = execute(env, runtime(env, () => { calls++; return new Promise((done) => { resolve = done; }); }));
  await new Promise((done) => setImmediate(done));
  assert.equal((await execute(env)).status, "busy");
  resolve({ agent_fields: fields(env.envelope), usage: { tokens: 1, cost_microusd: 1 } });
  assert.equal((await first).status, "completed"); assert.equal(calls, 1);
});

for (const validity of ["valid", "invalid"]) test(`restart reuses settled ${validity} output without another request`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "el-executor-crash-test-"));
  const initialNow = Date.parse("2026-10-11T00:00:02Z");
  const initial = new ResearchLedger(directory, { clock: () => initialNow });
  const envelope = setup(initial); initial.configureSourcePolicy(scope().watch_id, sourcePolicy());
  initial.enqueue(envelope, "test-window", policy()); initial.close();
  const helper = fileURLToPath(new URL("./helpers/executor-crash.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [helper, directory, String(initialNow), validity], { timeout: 3000, encoding: "utf8" });
  assert.equal(child.status, 23);
  const now = initialNow + 1001;
  const ledger = new ResearchLedger(directory, { clock: () => now }); t.after(() => ledger.close());
  const before = ledger.checkpoints(envelope.run_id).find((item) => item.key === "executor:input").payload.research_context.created_at;
  const lease = ledger.claim("synthetic-restart-worker", 1000); let calls = 0;
  const env = { ledger, lease, envelope, clock: () => now };
  const response = await execute(env, runtime(env, async () => { calls++; throw new Error("No second dispatch permitted."); }));
  assert.equal(calls, 0);
  assert.equal(ledger.budget(scope().watch_id, "test-window").spent.requests, 1);
  if (validity === "valid") {
    assert.equal(response.status, "completed"); assert.equal(response.result.created_at, before); assert.equal(ledger.inbox().length, 1);
  } else { assert.equal(response.code, "AGENT_FIELDS_INVALID"); assert.equal(ledger.inbox().length, 0); }
});

test("safe failures before dispatch use only a bounded retry policy", async (t) => {
  const env = environment(t); const original = env.ledger.reserveRequest.bind(env.ledger); let fail = true;
  env.ledger.reserveRequest = (...args) => { if (fail) { fail = false; throw new Error("Synthetic predispatch failure."); } return original(...args); };
  assert.equal((await execute(env, runtime(env), { retry_delay_ms: 0 })).status, "queued");
  env.lease = env.ledger.claim("synthetic-retry-worker", 1000);
  assert.equal((await execute(env)).status, "completed");
});

test("a real expired lease preserves late usage without baseline or delivery changes", async (t) => {
  const env = environment(t); let resolve, signal;
  const task = execute(env, runtime(env, (_input, config) => { signal = config.signal; return new Promise((done) => { resolve = done; }); }));
  await new Promise((done) => setImmediate(done));
  env.setNow(env.clock() + 1001); assert.equal(env.ledger.claim("synthetic-new-worker"), null);
  assert.equal((await task).code, "LEASE_LOST"); assert.equal(signal.aborted, true);
  resolve({ agent_fields: fields(env.envelope), usage: { tokens: 1, cost_microusd: 1 } });
  await new Promise((done) => setImmediate(done));
  assert.equal(env.ledger.run(env.lease.run_id).gate_code, "USAGE_UNKNOWN"); assert.equal(env.ledger.inbox().length, 0);
  assert.equal(env.ledger.watch(scope().watch_id).evidence_delivery_id, null);
});

for (const [change, code] of [
  [{ rights_status: "HOLD" }, "SOURCE_RIGHTS_GATED"], [{ parser_version: "2" }, "SOURCE_SCHEMA_CHANGED"],
  [{ max_source_age_ms: 1 }, "STALE_SOURCE"], [{ allow_candidate_trials: false }, "METHOD_CURATION_REQUIRED"]
]) test(`${code} prevents dispatch and prevents automatic retry`, async (t) => {
  const env = environment(t, {}, change); let calls = 0;
  assert.equal((await execute(env, runtime(env, () => { calls++; }), { retry_delay_ms: 0 })).code, code);
  assert.equal(calls, 0); assert.equal(env.ledger.run(env.lease.run_id).status, "gated");
});

test("missing source policy creates a named gate without an automatic retry", async (t) => {
  const env = environment(t, {}, null);
  assert.equal((await execute(env, runtime(env), { retry_delay_ms: 0 })).code, "SOURCE_POLICY_MISSING");
});

test("a reservation fault after commit releases holds before a safe retry", async (t) => {
  let enabled = true;
  const env = environment(t, { fault: (point) => {
    if (enabled && point === "reserve:after_commit") { enabled = false; throw new Error("Synthetic reservation fault."); }
  } });
  assert.equal((await execute(env, runtime(env), { retry_delay_ms: 0 })).status, "queued");
  assert.deepEqual(env.ledger.budget(scope().watch_id, "test-window").reserved, { requests: 0, tokens: 0, cost_microusd: 0, wall_ms: 0 });
  env.lease = env.ledger.claim("synthetic-reservation-retry", 1000);
  assert.equal((await execute(env)).status, "completed");
});

test("a dispatch fault after commit records uncertainty without a blind retry", async (t) => {
  let enabled = true, calls = 0;
  const env = environment(t, { fault: (point) => {
    if (enabled && point === "dispatch:after_commit") { enabled = false; throw new Error("Synthetic dispatch fault."); }
  } });
  assert.equal((await execute(env, runtime(env, () => { calls++; }), { retry_delay_ms: 0 })).code, "USAGE_UNKNOWN");
  assert.equal(calls, 0); assert.equal(env.ledger.claim("synthetic-dispatch-retry"), null);
});

test("an estimate that does not cover the bounded time limit prevents dispatch", async (t) => {
  const env = environment(t); let calls = 0;
  assert.equal((await execute(env, runtime(env, () => { calls++; }), { estimate: { tokens: 100, cost_microusd: 100, wall_ms: 10 } })).code, "ESTIMATE_INVALID");
  assert.equal(calls, 0);
});

test("no new evidence requires a retained comparison baseline", async (t) => {
  const env = environment(t); const data = fields(env.envelope); data.result_state = "NO_NEW_EVIDENCE";
  assert.equal((await execute(env, runtime(env, async () => ({ agent_fields: data, usage: { tokens: 1, cost_microusd: 1 } })))).code, "BASELINE_REQUIRED");
  assert.equal(env.ledger.inbox().length, 0);
});

test("a second ledger connection cannot cancel another controller with the same current lease", async (t) => {
  const env = environment(t); let resolve;
  const first = execute(env, runtime(env, () => new Promise((done) => { resolve = done; })));
  await new Promise((done) => setImmediate(done));
  const second = new ResearchLedger(env.directory, { clock: env.clock }); t.after(() => second.close());
  const response = await executeClaimedRun(second, env.lease, runtime(env), options(env));
  assert.equal(response.status, "busy"); assert.equal(env.ledger.run(env.lease.run_id).status, "running");
  resolve({ agent_fields: fields(env.envelope), usage: { tokens: 1, cost_microusd: 1 } });
  assert.equal((await first).status, "completed"); assert.equal(second.inbox().length, 1);
});

test("timeout retains an output that resolves synchronously during signal abort", async (t) => {
  const env = environment(t); let requestId;
  const response = await execute(env, runtime(env, (_input, config) => {
    requestId = config.request_id;
    return new Promise((resolve) => config.signal.addEventListener("abort", () => resolve({ agent_fields: fields(env.envelope), usage: { tokens: 1, cost_microusd: 1 } }), { once: true }));
  }), { timeout_ms: 20 });
  assert.equal(response.code, "USAGE_UNKNOWN");
  await new Promise((done) => setImmediate(done));
  assert.equal(env.ledger.requestReceipts(requestId).length, 1); assert.equal(env.ledger.inbox().length, 0);
});

test("future source retrieval creates a named gate without a safe retry", async (t) => {
  const env = environment(t); env.setNow(Date.parse("2026-10-10T00:00:00Z")); let calls = 0;
  assert.equal((await execute(env, runtime(env, () => { calls++; }), { retry_delay_ms: 0 })).code, "SOURCE_TIME_INVALID");
  assert.equal(calls, 0); assert.equal(env.ledger.run(env.lease.run_id).status, "gated");
});
