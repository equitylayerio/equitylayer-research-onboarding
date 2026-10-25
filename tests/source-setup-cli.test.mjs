import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync, symlinkSync, chmodSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { getEventListeners } from "node:events";
import { setupWorkspace } from "../client/setup-cli.mjs";
import { setupSource, runSourceSetup, collectSourceAnswers } from "../client/source-setup-cli.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { methodBundle } from "./fixtures/local-research.mjs";
import { TWSE_MONTHLY_SOURCE_ID } from "../client/local/twse-monthly-source.mjs";
import { SEC_SUBMISSIONS_VERSION, SEC_SUBMISSIONS_METRIC, secSourceId } from "../client/local/sec-submissions-contract.mjs";
import { createRunEnvelope, contentHash } from "../client/local/run-contract.mjs";
import { processScheduleTick } from "../client/local/scheduler.mjs";
import { eventFixture } from "./fixtures/source-events.mjs";
const clock = () => Date.parse("2026-10-15T20:00:00Z");
const held = () => ({ kind: "twse_monthly_revenue_api", rights_status: "HOLD", rights_reference: null, allow_candidate_trials: false });
const allowed = () => ({ ...held(), rights_status: "ALLOWED", rights_reference: "Synthetic local-use permission, not real source approval.", allow_candidate_trials: true });

function workspaceBytes(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry =>
    [entry.name, entry.isDirectory() ? workspaceBytes(join(directory, entry.name)) : readFileSync(join(directory, entry.name)).toString("hex")]);
}
async function fixture(t, symbols = ["TTMI", "2383.TW", "6752.T", "000150.KS"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-source-setup-test-"))), workspace = join(root, "workspace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const answers = { focus: "pcb_ccl", symbols, question: "PRIVATE_QUESTION", trigger: "PRIVATE_TRIGGER",
    runtime: { native: { allow_native_research: true, provider: "claude-code", executable: process.execPath, cli_version: "2.1.150",
      model: "not-invoked", env: { HOME: root }, timeout_ms: 120000 },
      execution: { estimate: { tokens: 1000, cost_microusd: 100000, wall_ms: 120000 }, timeout_ms: 120000 } },
    budget: { requests: 1, tokens: 10000, cost_microusd: 1000000, wall_ms: 120000 } };
  const setup = await setupWorkspace({ workspace, answers, method_bundle: methodBundle() }, { clock });
  const open = () => new ResearchLedger(workspace, { clock });
  const run = (options = {}, dependencies = {}) => setupSource({ workspace, answers: held(), ...options }, { clock, ...dependencies });
  return { root, workspace, setup, open, run, answers };
}

async function terminalSource(t, { boundary = "source", action = "SIGINT", success = false } = {}) {
  const f = await fixture(t), input = new PassThrough(), promptOutput = new PassThrough(), controller = new AbortController();
  input.isTTY = true; promptOutput.isTTY = true; promptOutput.columns = 80;
  let displayed = "", printed = "", reached = false, release, step = 0;
  const ready = new Promise(resolve => { release = resolve; });
  const steps = [["Source: twse, sec, or retained", "sec"], ["Selected US-listed symbol", "TTMI"],
    ["Issuer ten-digit SEC CIK", "0001116942"], ["Your application name and contact email", "SyntheticTest tests@example.com"],
    ["Local research rights", "ALLOWED"], ["Documented permission reference", "Synthetic local use only."],
    ["Confirm your permitted local use", "yes"], ["Permit candidate-method jobs", "no"], ["Save this observation configuration?", "yes"]];
  const target = boundary === "source" ? steps[0][0] : steps[6][0];
  promptOutput.on("data", bytes => {
    displayed += bytes;
    if (!reached && displayed.includes(target)) { reached = true; release(); }
    if (step < steps.length && displayed.includes(steps[step][0])) {
      const [prompt, answer] = steps[step++];
      if (!success && prompt === target) return;
      queueMicrotask(() => input.write(`${answer}\n`));
    }
  });
  t.after(() => { input.destroy(); promptOutput.destroy(); });
  const before = workspaceBytes(f.workspace), listeners = getEventListeners(controller.signal, "abort").length;
  let timer;
  const limit = promise => Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("Synthetic source prompt exceeded the test deadline.")), 1500);
  })]).finally(() => clearTimeout(timer));
  const attempt = runSourceSetup(["--workspace", f.workspace], { input, promptOutput, signal: controller.signal, clock,
    stdout: value => { printed += value; } });
  if (!success) {
    await limit(ready);
    if (action === "SIGINT") input.write("\u0003");
    else if (action === "EOF") input.end();
    else controller.abort();
  }
  const outcome = await limit(attempt);
  if (success) {
    assert.equal(outcome.exitCode, 0); assert.equal(outcome.output.status, "configured_not_running");
    assert.equal(outcome.output.network_called, false); assert.equal(outcome.output.model_called, false);
    assert.equal(outcome.output.tracking_started, false); assert.equal(outcome.output.max_runs, 0);
  } else {
    assert.deepEqual(outcome, { exitCode: 1, output: { status: "error", code: "SOURCE_SETUP_CANCELLED" } });
    assert.equal(printed, '{"status":"error","code":"SOURCE_SETUP_CANCELLED"}\n');
    assert.deepEqual(workspaceBytes(f.workspace), before);
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, listeners);
  assert.equal(input.listenerCount("keypress"), 0); assert.equal(input.listenerCount("end"), 0);
  return { f, input, promptOutput, controller, displayed, printed };
}

for (const boundary of ["source", "local consent"]) for (const action of ["SIGINT", "EOF", "external abort"]) {
  test(`source terminal ${action} at ${boundary} cancels without changing workspace bytes`, { timeout: 6000 }, async t => {
    await terminalSource(t, { boundary, action });
  });
}

test("source terminal completion still requires explicit local-use and save confirmations", { timeout: 6000 }, async t => {
  await terminalSource(t, { success: true });
});

test("source terminal cancellation removes listeners before a second attempt", { timeout: 6000 }, async t => {
  await terminalSource(t); await terminalSource(t, { boundary: "local consent", action: "EOF" });
});

test("a non-terminal source invocation still requires machine answers", async t => {
  const f = await fixture(t), input = new PassThrough(), promptOutput = new PassThrough();
  t.after(() => { input.destroy(); promptOutput.destroy(); });
  const before = workspaceBytes(f.workspace);
  const outcome = await runSourceSetup(["--workspace", f.workspace], { input, promptOutput, stdout() {} });
  assert.equal(outcome.output.code, "SOURCE_SETUP_INTERACTIVE_REQUIRED"); assert.deepEqual(workspaceBytes(f.workspace), before);
});

test("an unrelated source prompt AbortError remains an operation failure", async t => {
  const f = await fixture(t), before = workspaceBytes(f.workspace);
  const outcome = await runSourceSetup(["--workspace", f.workspace], { stdout() {}, ask: async () => {
    const error = Error("Synthetic unrelated failure."); error.name = "AbortError"; error.code = "ABORT_ERR"; throw error;
  } });
  assert.equal(outcome.output.code, "SOURCE_SETUP_OPERATION_FAILED"); assert.deepEqual(workspaceBytes(f.workspace), before);
});

test("an already cancelled source terminal displays no prompt and changes nothing", async t => {
  const f = await fixture(t), before = workspaceBytes(f.workspace), input = new PassThrough(), promptOutput = new PassThrough();
  const controller = new AbortController(); controller.abort(); let displayed = "";
  input.isTTY = true; promptOutput.isTTY = true; promptOutput.on("data", bytes => { displayed += bytes; });
  t.after(() => { input.destroy(); promptOutput.destroy(); });
  const outcome = await runSourceSetup(["--workspace", f.workspace], { input, promptOutput, signal: controller.signal, stdout() {} });
  assert.equal(outcome.output.code, "SOURCE_SETUP_CANCELLED"); assert.equal(displayed, "");
  assert.deepEqual(workspaceBytes(f.workspace), before); assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("TWSE source setup preserves companies and creates a held observation schedule without execution", async t => {
  const f = await fixture(t), output = await f.run();
  assert.equal(output.status, "needs_source_rights"); assert.equal(output.rights_status, "HOLD");
  assert.equal(output.max_runs, 0); assert.equal(output.tracking_started, false); assert.equal(output.model_called, false); assert.equal(output.network_called, false);
  assert.equal(output.commercial_reuse_authorized, false); assert.equal(output.payment_authorized, false); assert.equal(output.trading_authorized, false);
  assert.equal(output.next_command, null); assert.equal(output.source_rights_verified, false); assert.equal(output.research_completion_verified, false);
  assert.deepEqual(output.configured_symbols, ["2383.TW"]); assert.deepEqual(output.missing_source_symbols, ["000150.KS", "6752.T", "TTMI"]);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_|Synthetic local-use/);
  assert.deepEqual(output.counts, { watches: 1, runs: 0, deliveries: 0, requests: 0, receipts: 0, notices: 0 });
  const ledger = f.open();
  try {
    const policy = ledger.sourcePolicy(f.setup.watch_id, output.source_id).policy;
    assert.deepEqual(policy.allowed_purposes, []); assert.equal(policy.allow_candidate_trials, false);
    const schedule = JSON.parse(readFileSync(join(f.workspace, output.snapshot_file))).schedule;
    assert.equal(schedule.max_runs, 0); assert.equal(schedule.runtime_sha256, null);
    assert.equal(ledger.pageSchedules()[0].mode, "observation_only");
    assert.equal(ledger.scheduleWorkerStatus(output.schedule_id).state, "not_verified");
    assert.deepEqual(ledger.watch(f.setup.watch_id).revisions[0].scope.symbols, [...f.answers.symbols].sort());
  } finally { ledger.close(); }
});

test("ALLOWED requires separate consent and a rights reference before snapshot or policy writes", async t => {
  const f = await fixture(t), before = readdirSync(f.workspace);
  await assert.rejects(f.run({ answers: allowed() }), { code: "SOURCE_SETUP_LOCAL_USE_CONFIRMATION_REQUIRED" });
  await assert.rejects(f.run({ answers: { ...allowed(), rights_reference: null }, confirm_local_use: true }), { code: "INVALID_SOURCE_POLICY" });
  assert.deepEqual(readdirSync(f.workspace), before);
  const ledger = f.open(); try { assert.equal(ledger.sourcePolicy(f.setup.watch_id, TWSE_MONTHLY_SOURCE_ID), null); } finally { ledger.close(); }
  const output = await f.run({ answers: allowed(), confirm_local_use: true });
  assert.equal(output.status, "configured_not_running"); assert.equal(output.rights_basis, "caller_declared_local_use_only");
  assert.equal(output.source_authenticity_verified, false); assert.equal(output.counts.requests, 0);
  assert.equal(output.tracking_started, false);
});

test("existing HOLD cannot become ALLOWED through this wizard", async t => {
  const f = await fixture(t), first = await f.run(), before = readFileSync(join(f.workspace, first.snapshot_file));
  await assert.rejects(f.run({ answers: allowed(), confirm_local_use: true }), { code: "SOURCE_SETUP_STATE_CHANGED" });
  assert.deepEqual(readFileSync(join(f.workspace, first.snapshot_file)), before);
  const ledger = f.open(); try { assert.equal(ledger.sourcePolicy(f.setup.watch_id, TWSE_MONTHLY_SOURCE_ID).policy.rights_status, "HOLD"); } finally { ledger.close(); }
});

for (const point of ["source_setup:after_snapshot", "source_setup:after_policy"]) test(`exact resume recovers ${point} without refetch or a model`, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({}, { fault: key => { if (key === point) throw new Error("Synthetic interruption."); } }));
  const output = await setupSource({ workspace: f.workspace, resume_source: TWSE_MONTHLY_SOURCE_ID }, { clock });
  assert.equal(output.status, "needs_source_rights"); assert.equal(output.counts.requests, 0); assert.equal(output.counts.deliveries, 0);
  const ledger = f.open(); try { ledger.verifyIntegrity(); assert.equal(ledger.pageSchedules().length, 1); } finally { ledger.close(); }
});

test("resume cannot restore a revoked policy or enable a stopped schedule", async t => {
  const f = await fixture(t), output = await f.run({ answers: allowed(), confirm_local_use: true });
  const ledger = f.open();
  try { ledger.stopSchedule(output.schedule_id); } finally { ledger.close(); }
  const stopped = await setupSource({ workspace: f.workspace, resume_source: output.source_id }, { clock });
  assert.equal(stopped.schedule_enabled, false);
  assert.equal(stopped.status, "stopped"); assert.equal(stopped.next_command, null);
  const later = f.open();
  try { const old = later.sourcePolicy(f.setup.watch_id, output.source_id).policy;
    later.configureSourcePolicy(f.setup.watch_id, { ...old, revision: 2, rights_status: "HOLD", allowed_purposes: [], allow_candidate_trials: false });
  } finally { later.close(); }
  await assert.rejects(setupSource({ workspace: f.workspace, resume_source: output.source_id }, { clock }), { code: "SOURCE_SETUP_STATE_CHANGED" });
});

test("a policy change during configuration stops before schedule creation", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ answers: allowed(), confirm_local_use: true }, { fault: point => {
    if (point !== "source_setup:after_policy") return;
    const ledger = f.open();
    try { const old = ledger.sourcePolicy(f.setup.watch_id, TWSE_MONTHLY_SOURCE_ID).policy;
      ledger.configureSourcePolicy(f.setup.watch_id, { ...old, revision: 2, rights_status: "HOLD", allowed_purposes: [], allow_candidate_trials: false });
    } finally { ledger.close(); }
  } }), { code: "SOURCE_SETUP_STATE_CHANGED" });
  const ledger = f.open(); try { assert.deepEqual(ledger.pageSchedules(), []); } finally { ledger.close(); }
});

test("new scope revisions do not receive an old source configuration", async t => {
  const f = await fixture(t), ledger = f.open();
  try { const watch = ledger.watch(f.setup.watch_id); ledger.saveRevision({ ...watch.revisions[0].scope, revision: 2 }, watch.revisions[0].local_context); }
  finally { ledger.close(); }
  await assert.rejects(f.run(), { code: "SOURCE_SETUP_SCOPE_CHANGED" });
});

test("a watch without TWSE symbols keeps its scope and gets an explicit gap", async t => {
  const f = await fixture(t, ["TTMI", "6752.T"]);
  await assert.rejects(f.run(), { code: "SOURCE_SETUP_TWSE_COMPANY_REQUIRED" });
});

test("private connector setup preserves exact mapping and refuses extra companies or unsafe directories", async t => {
  const f = await fixture(t), directory = join(f.root, "connector"); mkdirSync(directory, { mode: 0o700 });
  const answers = { ...held(), kind: "retained_directory", directory, source_id: "synthetic-connector", adapter_version: "1", parser_version: "1",
    issuer_map: { TTMI: "synthetic-issuer" }, metric_definition_ids: ["synthetic.revenue"], allowed_evidence_states: ["PROVISIONAL"], max_source_age_ms: 86400000, interval_ms: 60000 };
  await assert.rejects(f.run({ answers: { ...answers, issuer_map: { OTHER: "wrong" } } }), { code: "SOURCE_SETUP_SCOPE_CONFLICT" });
  const link = join(f.root, "feed-link"); symlinkSync(directory, link);
  await assert.rejects(f.run({ answers: { ...answers, directory: link } }), { code: "SOURCE_SETUP_FEED_UNSAFE" });
  const output = await f.run({ answers }); assert.deepEqual(output.configured_symbols, ["TTMI"]);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-issuer|connector\//);
});

test("changed source snapshots fail without overwriting them", async t => {
  const f = await fixture(t), output = await f.run(), path = join(f.workspace, output.snapshot_file);
  const record = JSON.parse(readFileSync(path)); record.local_use_confirmed = true;
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(setupSource({ workspace: f.workspace, resume_source: output.source_id }, { clock }), { code: "SOURCE_SETUP_SNAPSHOT_INVALID" });
});

for (const kind of ["link", "hard-link", "shared"]) test(`source resume refuses a ${kind} snapshot without replacement`, async t => {
  const f = await fixture(t), output = await f.run(), path = join(f.workspace, output.snapshot_file), before = readFileSync(path);
  if (kind === "shared") chmodSync(path, 0o644);
  else {
    const target = join(f.root, "snapshot.json"); writeFileSync(target, before, { mode: 0o600 }); rmSync(path);
    if (kind === "link") symlinkSync(target, path);
    else linkSync(target, path);
  }
  await assert.rejects(setupSource({ workspace: f.workspace, resume_source: output.source_id }, { clock }));
  assert.deepEqual(readFileSync(path), before);
});

test("source setup preserves unknown requests, held budget and accepted references", async t => {
  const f = await fixture(t), ledger = f.open(); let runId, before;
  try {
    const saved = ledger.watch(f.setup.watch_id).revisions[0], method = ledger.retainMethod(methodBundle());
    const envelope = createRunEnvelope({ scope: saved.scope, method, source_refs: [], baselines: [],
      evaluation_at: new Date(clock()).toISOString(), local_context_sha256: saved.local_context_sha256 });
    runId = envelope.run_id; ledger.enqueue(envelope, "initial", { max_attempts: 1, max_wall_ms: 120000, not_before: 0 });
    const lease = ledger.claim("synthetic-source-setup-worker", 10000), request = ledger.reserveRequest(lease, "unknown", f.answers.runtime.execution.estimate);
    ledger.markDispatched(lease, request.request_id); ledger.gateRun(lease, "DISPATCH_UNCERTAIN");
    before = { budget: ledger.budget(f.setup.watch_id, "initial"), requests: ledger.requests(runId), watch: ledger.watch(f.setup.watch_id),
      gates: ledger.workspaceStatus().gates.map(gate => gate.gate_code) };
  } finally { ledger.close(); }
  const output = await f.run(); assert.equal(output.counts.requests, 1); assert.deepEqual(output.existing_gates, before.gates);
  assert.ok(output.existing_gates.includes("USAGE_UNKNOWN"));
  const reopened = f.open();
  try {
    assert.deepEqual(reopened.budget(f.setup.watch_id, "initial"), before.budget);
    assert.deepEqual(reopened.requests(runId), before.requests); assert.equal(reopened.requests(runId)[0].status, "unknown");
    assert.deepEqual(reopened.watch(f.setup.watch_id), before.watch); reopened.verifyIntegrity();
  } finally { reopened.close(); }
});

test("a configured TWSE HOLD stops a later observation before any source request", async t => {
  const f = await fixture(t), output = await f.run(), ledger = f.open(); let calls = 0;
  try {
    const tick = await processScheduleTick(ledger, output.schedule_id, { clock, source_fetch_impl: () => { calls++; throw new Error("No network."); } });
    assert.deepEqual(tick.tick.codes, ["SOURCE_RIGHTS_HOLD"]); assert.equal(calls, 0);
    assert.equal(ledger.workspaceStatus().counts.requests, 0);
  } finally { ledger.close(); }
});

test("configured connector observation reaches the existing queue without AI or duplicate work", async t => {
  const f = await fixture(t, ["LITE", "2345.TW"]), directory = join(f.root, "feed"); mkdirSync(directory, { mode: 0o700 });
  const answers = { ...allowed(), kind: "retained_directory", directory, source_id: "synthetic-exchange", adapter_version: "1", parser_version: "1",
    issuer_map: { LITE: "LITE", "2345.TW": "2345" }, metric_definition_ids: ["synthetic_metric"], allowed_evidence_states: ["VERIFIED"],
    max_source_age_ms: 7 * 86400000, interval_ms: 1000 };
  const output = await f.run({ answers, confirm_local_use: true });
  const { bytes, ...source } = eventFixture(), record = { schema_version: 1, ...source, raw_base64: bytes.toString("base64") };
  writeFileSync(join(directory, `${contentHash(record)}.json`), JSON.stringify(record), { mode: 0o600 });
  const ledger = f.open();
  try {
    const tick = await processScheduleTick(ledger, output.schedule_id, { clock });
    assert.equal(tick.status, "completed"); assert.equal(tick.tick.deliveries, 0);
    assert.equal(ledger.workspaceStatus().counts.runs, 1); assert.equal(ledger.workspaceStatus().counts.requests, 0);
  } finally { ledger.close(); }
  const reopened = new ResearchLedger(f.workspace, { clock: () => clock() + 1000 });
  try {
    await processScheduleTick(reopened, output.schedule_id, { clock: () => clock() + 1000 });
    assert.equal(reopened.workspaceStatus().counts.runs, 1); assert.equal(reopened.workspaceStatus().counts.requests, 0);
    reopened.verifyIntegrity();
  } finally { reopened.close(); }
});

test("CLI help and validation have no storage or native side effects", async t => {
  let output = "", asked = 0;
  assert.equal((await runSourceSetup(["--help"], { stdout: text => { output += text; } })).exitCode, 0);
  assert.match(output, /cannot replace an existing policy/);
  const f = await fixture(t), before = readdirSync(f.workspace);
  for (const args of [["--workspace", "relative"], ["--workspace", f.workspace, "--workspace", f.workspace],
    ["--workspace", f.workspace, "--resume-source", TWSE_MONTHLY_SOURCE_ID, "--confirm-local-source-use"]]) {
    assert.equal((await runSourceSetup(args, { stdout: () => {}, ask: () => { asked++; return ""; } })).exitCode, 1);
  }
  assert.equal(asked, 0); assert.deepEqual(readdirSync(f.workspace), before);
});

test("malformed answers and source-auth fields fail before configuration writes", async t => {
  const f = await fixture(t), before = readdirSync(f.workspace);
  for (const answers of [null, undefined, [], "text", { ...held(), authorization: "PRIVATE_KEY_SENTINEL" },
    { ...held(), kind: "https://example.test/source" }, { ...held(), allow_candidate_trials: true }]) {
    await assert.rejects(f.run({ answers }), { code: "SOURCE_SETUP_INPUT_INVALID" });
  }
  assert.deepEqual(readdirSync(f.workspace), before);
});

test("interactive local-use confirmation is separate and cancellation does not save", async t => {
  const f = await fixture(t), responses = ["twse", "ALLOWED", "Synthetic permission", "yes", "no", "yes"];
  const collected = await collectSourceAnswers(async () => responses.shift(), { symbols: f.answers.symbols });
  assert.equal(collected.confirm_local_use, true); assert.equal(collected.answers.allow_candidate_trials, false);
  await assert.rejects(collectSourceAnswers(async () => "/cancel", { symbols: f.answers.symbols }), { code: "SOURCE_SETUP_CANCELLED" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.run({ signal: controller.signal }), { code: "SOURCE_SETUP_CANCELLED" });
});

const secAnswers = () => ({ ...held(), kind: "sec_submissions_api", symbol: "TTMI", cik: "0000000001", user_agent: "SyntheticFixture tests@example.test" });
test("SEC setup defaults to HOLD and a pinned daily detector without financial coverage or execution", async t => {
  const f = await fixture(t), output = await f.run({ answers: secAnswers() });
  assert.equal(output.status, "needs_source_rights"); assert.equal(output.evidence_scope, "filing_index_metadata_only");
  assert.equal(output.source_id, secSourceId("0000000001")); assert.deepEqual(output.configured_symbols, ["TTMI"]);
  assert.equal(output.next_command, null); assert.equal(output.network_called, false); assert.equal(output.model_called, false);
  assert.equal(output.source_authenticity_verified, false); assert.equal(output.issuer_mapping_verified, false);
  assert.doesNotMatch(JSON.stringify(output), /tests@example|SyntheticFixture|PRIVATE_/);
  const snapshot = JSON.parse(readFileSync(join(f.workspace, output.snapshot_file)));
  assert.equal(snapshot.schedule.interval_ms, 86400000); assert.equal(snapshot.schedule.max_runs, 0); assert.equal(snapshot.schedule.runtime_sha256, null);
  assert.equal(snapshot.policy.parser_version, SEC_SUBMISSIONS_VERSION); assert.deepEqual(snapshot.policy.metric_definition_ids, [SEC_SUBMISSIONS_METRIC]);
  assert.deepEqual(snapshot.policy.allowed_evidence_states, ["PROVISIONAL"]); assert.equal(snapshot.schedule.feed.user_agent, secAnswers().user_agent);
});
test("SEC allowed use requires separate confirmation and cannot replace existing HOLD", async t => {
  const f = await fixture(t), answers = { ...secAnswers(), ...allowed(), kind: "sec_submissions_api" };
  await assert.rejects(f.run({ answers }), { code: "SOURCE_SETUP_LOCAL_USE_CONFIRMATION_REQUIRED" });
  await f.run({ answers: secAnswers() });
  await assert.rejects(f.run({ answers, confirm_local_use: true }), { code: "SOURCE_SETUP_STATE_CHANGED" });
  const ledger = f.open(); try { assert.equal(ledger.sourcePolicy(f.setup.watch_id, secSourceId(answers.cik)).policy.rights_status, "HOLD"); }
  finally { ledger.close(); }
});
test("SEC setup can coexist with TWSE and exact resume preserves stopped state", async t => {
  const f = await fixture(t); await f.run();
  const answers = { ...secAnswers(), rights_status: "ALLOWED", rights_reference: "Synthetic local permission only.", allow_candidate_trials: true };
  const first = await f.run({ answers, confirm_local_use: true });
  assert.equal(first.status, "configured_not_running"); assert.ok(first.next_command);
  let ledger = f.open(); ledger.stopSchedule(first.schedule_id); ledger.close();
  const resumed = await setupSource({ workspace: f.workspace, resume_source: first.source_id }, { clock });
  assert.equal(resumed.status, "stopped"); assert.equal(resumed.next_command, null);
  ledger = f.open(); try { assert.equal(ledger.pageSchedules().length, 2); assert.equal(ledger.workspaceStatus().counts.requests, 0); ledger.verifyIntegrity(); }
  finally { ledger.close(); }
});
test("SEC setup refuses an unselected symbol, unsafe identity, custom URL, or missing contact before writes", async t => {
  const f = await fixture(t), before = readdirSync(f.workspace);
  for (const change of [{ symbol: "NVDA" }, { cik: "1" }, { user_agent: "anonymous" }, { url: "https://example.test" }])
    await assert.rejects(f.run({ answers: { ...secAnswers(), ...change } }));
  assert.deepEqual(readdirSync(f.workspace), before);
});
test("interactive SEC setup collects one selected company and leaves local rights held by default", async t => {
  const f = await fixture(t), responses = ["sec", "TTMI", "0000000001", "SyntheticFixture tests@example.test", "HOLD", "yes"];
  const collected = await collectSourceAnswers(async () => responses.shift(), { symbols: f.answers.symbols });
  assert.deepEqual(collected.answers, secAnswers()); assert.equal(collected.confirm_local_use, false);
  assert.equal((await f.run({ answers: collected.answers })).status, "needs_source_rights");
});
