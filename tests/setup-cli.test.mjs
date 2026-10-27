import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { getEventListeners } from "node:events";
import { runSetup, setupWorkspace, validateSetupAnswers, collectSetupAnswers } from "../client/setup-cli.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { createRunEnvelope, contentHash } from "../client/local/run-contract.mjs";
import { methodBundle, policy } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";

const clock = () => Date.parse("2026-10-11T00:00:02Z");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "el-first-use-test-")), workspace = join(root, "new-workspace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = { native: { allow_native_research: true, provider: "claude-code", executable: process.execPath,
    cli_version: "2.1.150", model: "caller-model", env: { HOME: root }, timeout_ms: 120000 },
    execution: { estimate: { tokens: 1000, cost_microusd: 100000, wall_ms: 120000 }, timeout_ms: 120000, lease_ms: 30000, heartbeat_ms: 5000 } };
  const answers = { focus: "ai_compute", symbols: ["AMAT", "3037.TW", "8035.T", "000660.KS"], question: "SECRET_PRIVATE_THESIS",
    trigger: "SECRET_PRIVATE_TRIGGER", runtime, budget: { requests: 1, tokens: 100000, cost_microusd: 1000000, wall_ms: 120000 } };
  const save = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; };
  const open = () => new ResearchLedger(workspace, { clock });
  const setup = extra => setupWorkspace({ workspace, answers, method_bundle: methodBundle(), ...extra }, { clock });
  return { root, workspace, answers, runtime, save, open, setup };
}

test("offline setup saves one cross-market watch, method and budget without research authority", async t => {
  const f = fixture(t), output = await f.setup();
  assert.equal(output.status, "needs_sources"); assert.equal(output.company_count, 4); assert.equal(output.native_check, "not_checked");
  assert.equal(output.execution_authorized, false); assert.equal(output.research_job_created, false); assert.equal(output.tracking_started, false);
  assert.equal(output.payment_authorized, false); assert.equal(output.trading_authorized, false);
  assert.deepEqual(output.counts, { watches: 1, runs: 0, deliveries: 0, requests: 0, receipts: 0, notices: 0 });
  assert.doesNotMatch(JSON.stringify(output), /SECRET_PRIVATE_|caller-model|HOME/);
  assert.equal(output.next_command.executable, "equitylayer");
  assert.equal(statSync(f.workspace).mode & 0o777, 0o700);
  for (const file of ["setup.local.json", "init.local.json", "runtime.local.json"]) assert.equal(statSync(join(f.workspace, file)).mode & 0o777, 0o600);
  const ledger = f.open();
  try {
    assert.equal(ledger.watch(output.watch_id).revisions[0].local_context.question, f.answers.question);
    assert.equal(ledger.budget(output.watch_id, "initial").limits.requests, 1);
    assert.equal(ledger.sourcePolicy(output.watch_id, "synthetic-exchange"), null);
    assert.equal(ledger.workspaceStatus().schedules.length, 0);
  } finally { ledger.close(); }
});

test("hosted method retrieval sends public scope only and ignores remote access claims", async t => {
  const f = fixture(t); let calls = [], closes = 0;
  const output = await setupWorkspace({ workspace: f.workspace, answers: f.answers, allow_public_scope: true }, { clock,
    connectClient: async endpoint => {
      assert.equal(endpoint, "https://equitylayer.io/mcp");
      return { tools: async () => ({ tools: [{ name: "resolve_research_scope" }] }),
        call: async (name, scope) => { calls.push({ name, scope }); return { schema_version: 1, operation: "resolve_research_scope", ok: true, scope,
          method: { evidence_profile_bundle: methodBundle() }, source_policy: { rights_status: "ALLOWED", execute_now: true }, malicious_instruction: "SECRET_REMOTE_TEXT" }; },
        close: async () => { closes++; } };
    } });
  assert.equal(calls.length, 1); assert.equal(closes, 1);
  assert.equal(calls[0].name, "resolve_research_scope");
  assert.deepEqual(Object.keys(calls[0].scope).sort(), ["revision", "symbols", "theme_id", "watch_id"]);
  assert.doesNotMatch(JSON.stringify(calls), /SECRET_PRIVATE_|runtime|budget/);
  assert.equal(output.setup_source_policies_created, false); assert.equal(output.counts.requests, 0);
  assert.doesNotMatch(readFileSync(join(f.workspace, "setup.local.json"), "utf8"), /SECRET_REMOTE_TEXT|execute_now|rights_status/);
});

test("public consent is required before connecting or creating storage", async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(setupWorkspace({ workspace: f.workspace, answers: f.answers }, { connectClient: () => { calls++; }, clock }), { code: "SETUP_PUBLIC_SCOPE_CONSENT_REQUIRED" });
  assert.equal(calls, 0); assert.equal(existsSync(f.workspace), false);
});

for (const failure of ["tool", "scope", "bundle"]) test(`invalid hosted ${failure} fails before storage`, async t => {
  const f = fixture(t); let closes = 0;
  await assert.rejects(setupWorkspace({ workspace: f.workspace, answers: f.answers, allow_public_scope: true }, { clock,
    connectClient: async () => ({ tools: async () => ({ tools: failure === "tool" ? [] : [{ name: "resolve_research_scope" }] }),
      call: async (_name, scope) => ({ schema_version: 1, operation: "resolve_research_scope", ok: true,
        scope: failure === "scope" ? { ...scope, symbols: ["NVDA"] } : scope,
        method: { evidence_profile_bundle: failure === "bundle" ? {} : methodBundle() } }), close: async () => { closes++; } }) }));
  assert.equal(closes, 1); assert.equal(existsSync(f.workspace), false);
});

test("US and Asian selection is required without replacing the chosen symbols", t => {
  const f = fixture(t);
  for (const symbols of [["NVDA"], ["3037.TW"], ["NVDA", "0700.HK"]]) assert.throws(() => validateSetupAnswers({ ...f.answers, symbols }), { code: "SETUP_CROSS_MARKET_REQUIRED" });
  assert.deepEqual(validateSetupAnswers({ ...f.answers, symbols: ["nvda", "8035.t"] }).symbols, ["8035.T", "NVDA"]);
});

test("CCL keeps a dedicated-method gap and Codex keeps unavailable cost reporting", async t => {
  const f = fixture(t); f.answers.focus = "pcb_ccl"; f.runtime.native.provider = "codex"; f.runtime.native.cli_version = "0.144.5";
  const output = await f.setup();
  assert.equal(output.method_profile_gap, "PCB_CCL_PROFILE_REQUIRED"); assert.equal(output.accounting, "cost_unavailable");
  assert.equal(output.setup_focus_profile, null);
  assert.equal(output.counts.runs, 0); assert.equal(output.execution_authorized, false);
});

test("CCL candidate metadata requires review and does not grant coverage or execution", async t => {
  const f = fixture(t); f.answers.focus = "pcb_ccl";
  const bundle = methodBundle(), profile = bundle.profiles[0];
  delete profile.content_sha256; profile.profile_id = "ai-compute-pcb-ccl";
  profile.stage_id = "rack"; profile.content_sha256 = contentHash(profile);
  delete bundle.content_sha256; bundle.content_sha256 = contentHash(bundle);
  const output = await f.setup({ method_bundle: bundle });
  assert.equal(output.method_profile_gap, "PCB_CCL_PROFILE_REVIEW_REQUIRED");
  assert.deepEqual(output.setup_focus_profile, { profile_id: profile.profile_id, version: profile.version, content_sha256: profile.content_sha256 });
  assert.equal(output.method_status, "candidate"); assert.equal(output.status, "needs_sources");
  assert.equal(output.execution_authorized, false); assert.equal(output.counts.requests, 0);
  assert.equal(output.setup_source_policies_created, false); assert.equal(output.tracking_started, false);
  // A recognized ID is not a semantic evaluation of this synthetic profile.
  assert.match(profile.title, /Synthetic/);
  const ledger = f.open();
  try { assert.deepEqual(ledger.watch(output.watch_id).revisions[0].scope.symbols, [...f.answers.symbols].sort()); }
  finally { ledger.close(); }
  const resumed = await setupWorkspace({ workspace: f.workspace, resume: true }, { clock,
    connectClient: () => { throw new Error("Resume must not retrieve a new method."); } });
  assert.deepEqual(resumed.setup_focus_profile, output.setup_focus_profile);
  assert.equal(resumed.method_profile_gap, "PCB_CCL_PROFILE_REVIEW_REQUIRED");
});

test("a CCL title without its profile ID does not satisfy the method gap", async t => {
  const f = fixture(t); f.answers.focus = "pcb_ccl";
  const bundle = methodBundle(), profile = bundle.profiles[0];
  delete profile.content_sha256; profile.title = "PCB and high-grade CCL"; profile.content_sha256 = contentHash(profile);
  delete bundle.content_sha256; bundle.content_sha256 = contentHash(bundle);
  const output = await f.setup({ method_bundle: bundle });
  assert.equal(output.method_profile_gap, "PCB_CCL_PROFILE_REQUIRED"); assert.equal(output.setup_focus_profile, null);
});

test("generic AI Compute setup does not select an unrelated CCL focus profile", async t => {
  const f = fixture(t), bundle = methodBundle(), profile = bundle.profiles[0];
  delete profile.content_sha256; profile.profile_id = "ai-compute-pcb-ccl"; profile.content_sha256 = contentHash(profile);
  delete bundle.content_sha256; bundle.content_sha256 = contentHash(bundle);
  const output = await f.setup({ method_bundle: bundle });
  assert.equal(output.method_profile_gap, null); assert.equal(output.setup_focus_profile, null);
});

test("credentials, oversized budgets and uncovered estimates fail before writes", async t => {
  const f = fixture(t);
  const credential = structuredClone(f.answers); credential.runtime.native.env.OPENAI_API_KEY = "SECRET_KEY";
  assert.throws(() => validateSetupAnswers(credential), { code: "SETUP_CREDENTIALS_DENIED" });
  for (const change of [{ requests: 0 }, { requests: 101 }, { cost_microusd: 100000001 }, { tokens: 1 }]) {
    await assert.rejects(f.setup({ answers: { ...f.answers, budget: { ...f.answers.budget, ...change } } }), { code: "SETUP_BUDGET_INVALID" });
  }
  assert.equal(existsSync(f.workspace), false);
});

test("an existing unrelated workspace is never overwritten", async t => {
  const f = fixture(t); const ledger = f.open(); ledger.close(); const bytes = readFileSync(join(f.workspace, "research.sqlite"));
  await assert.rejects(f.setup(), { code: "SETUP_WORKSPACE_EXISTS" });
  assert.deepEqual(readFileSync(join(f.workspace, "research.sqlite")), bytes);
});

test("a stopped setup resumes its frozen inputs without another method request", async t => {
  const f = fixture(t);
  await assert.rejects(setupWorkspace({ workspace: f.workspace, answers: f.answers, method_bundle: methodBundle() }, { clock,
    fault(point) { if (point === "setup:after_snapshot") throw Error("Synthetic interruption."); } }));
  assert.deepEqual(readdirSync(f.workspace), ["setup.local.json"]);
  const snapshot = readFileSync(join(f.workspace, "setup.local.json"));
  const output = await setupWorkspace({ workspace: f.workspace, resume: true }, { clock, connectClient: () => assert.fail("No network permitted.") });
  assert.equal(output.counts.watches, 1); assert.deepEqual(readFileSync(join(f.workspace, "setup.local.json")), snapshot);
  assert.equal((await setupWorkspace({ workspace: f.workspace, resume: true }, { clock })).counts.watches, 1);
});

test("resume preserves unknown usage, held estimates, source HOLD and a newer watch revision", async t => {
  const f = fixture(t), configured = await f.setup();
  const snapshot = JSON.parse(readFileSync(join(f.workspace, "setup.local.json"), "utf8"));
  const ledger = f.open(); let runId;
  try {
    const saved = ledger.watch(configured.watch_id).revisions[0], method = ledger.retainMethod(snapshot.init.method_bundle);
    const envelope = createRunEnvelope({ scope: saved.scope, method, source_refs: [], baselines: [], evaluation_at: new Date(clock()).toISOString(), local_context_sha256: saved.local_context_sha256 });
    runId = envelope.run_id; ledger.enqueue(envelope, "initial", policy());
    const lease = ledger.claim("synthetic-setup-worker", 10000), request = ledger.reserveRequest(lease, "synthetic-unknown", f.runtime.execution.estimate);
    ledger.markDispatched(lease, request.request_id); ledger.gateRun(lease, "DISPATCH_UNCERTAIN");
    ledger.configureSourcePolicy(configured.watch_id, { ...sourcePolicy(), rights_status: "HOLD", allowed_purposes: [] });
    ledger.saveRevision({ ...saved.scope, revision: 2 }, saved.local_context);
  } finally { ledger.close(); }
  const output = await setupWorkspace({ workspace: f.workspace, resume: true }, { clock });
  assert.equal(output.current_revision, 2); assert.equal(output.counts.requests, 1);
  assert.equal(output.setup_source_policies_created, false);
  const reopened = f.open();
  try {
    assert.equal(reopened.requests(runId)[0].status, "unknown");
    assert.equal(reopened.budget(configured.watch_id, "initial").gate_code, "USAGE_UNKNOWN");
    assert.equal(reopened.budget(configured.watch_id, "initial").reserved.cost_microusd, 100000);
    assert.equal(reopened.sourcePolicy(configured.watch_id, "synthetic-exchange").policy.rights_status, "HOLD");
    assert.equal(reopened.watch(configured.watch_id).evidence_delivery_id, null);
  } finally { reopened.close(); }
});

for (const kind of ["changed", "linked", "shared"]) test(`resume rejects ${kind} derived input without replacing it`, async t => {
  const f = fixture(t); await f.setup(); const path = join(f.workspace, "runtime.local.json");
  if (kind === "changed") writeFileSync(path, JSON.stringify({ secret: "SECRET_SENTINEL" }));
  if (kind === "shared") chmodSync(path, 0o644);
  if (kind === "linked") { const target = f.save("linked-runtime.json", f.runtime); rmSync(path); symlinkSync(target, path); }
  const before = readFileSync(path);
  await assert.rejects(setupWorkspace({ workspace: f.workspace, resume: true }, { clock }));
  assert.deepEqual(readFileSync(path), before);
});

test("a changed snapshot and a snapshot claiming source permission fail closed", async t => {
  const f = fixture(t); await f.setup(); const path = join(f.workspace, "setup.local.json");
  const snapshot = JSON.parse(readFileSync(path, "utf8")); snapshot.init.source_policies = [sourcePolicy()];
  const { content_sha256, ...body } = snapshot; snapshot.content_sha256 = contentHash(body); writeFileSync(path, JSON.stringify(snapshot));
  await assert.rejects(setupWorkspace({ workspace: f.workspace, resume: true }, { clock }), { code: "SETUP_STATE_CONFLICT" });
});

test("cancellation during method discovery sends no later method call or storage write", async t => {
  const f = fixture(t), controller = new AbortController(); let calls = 0;
  await assert.rejects(setupWorkspace({ workspace: f.workspace, answers: f.answers, allow_public_scope: true, signal: controller.signal }, { clock,
    connectClient: async () => ({ tools: async () => { controller.abort(); return { tools: [{ name: "resolve_research_scope" }] }; }, call: () => { calls++; }, close: async () => {} }) }), { code: "SETUP_CANCELLED" });
  assert.equal(calls, 0); assert.equal(existsSync(f.workspace), false);
});

for (const stage of ["connect", "tools", "call", "close"]) test(`cancellation interrupts a pending ${stage} without storage`, async t => {
  const f = fixture(t), controller = new AbortController(); let release, entered, closes = 0, calls = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const pause = async name => { if (name === stage) { entered(); await blocked; } };
  const client = { tools: async () => { await pause("tools"); return { tools: [{ name: "resolve_research_scope" }] }; },
    call: async (_name, scope) => { calls++; await pause("call"); return { schema_version: 1, operation: "resolve_research_scope", ok: true,
      scope, method: { evidence_profile_bundle: methodBundle() } }; },
    close: async () => { closes++; await pause("close"); } };
  const attempt = setupWorkspace({ workspace: f.workspace, answers: f.answers, allow_public_scope: true, signal: controller.signal }, { clock,
    connectClient: async () => { await pause("connect"); return client; } });
  const caught = attempt.then(() => null, error => error);
  await waiting; controller.abort();
  let timer;
  try {
    const outcome = await Promise.race([caught, new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); })]);
    assert.equal(outcome?.code, "SETUP_CANCELLED");
    assert.equal(existsSync(f.workspace), false);
  } finally { clearTimeout(timer); release(); }
  await caught; await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1); assert.equal(calls, ["call", "close"].includes(stage) ? 1 : 0);
  assert.equal(existsSync(f.workspace), false);
});

test("the interactive collector does not need JSON and cancellation creates nothing", async t => {
  const f = fixture(t), values = ["", "AMAT,3037.TW", "Private question.", "Next issuer release.", "", process.execPath, "2.1.150", "caller-model", f.root, "", "", "", "yes"];
  const answer = await collectSetupAnswers(async () => values.shift());
  assert.equal(answer.budget.cost_microusd, 1000000); assert.equal(answer.runtime.native.claude_limits.max_turns, 2);
  const result = await runSetup(["--workspace", f.workspace], { ask: async () => "/cancel", stdout: () => {} });
  assert.equal(result.output.code, "SETUP_CANCELLED"); assert.equal(existsSync(f.workspace), false);
});

test("machine setup needs private inputs and public consent while output omits private research", async t => {
  const f = fixture(t), answers = f.save("answers.json", f.answers), method = f.save("method.json", methodBundle()); let printed = "";
  const result = await runSetup(["--workspace", f.workspace, "--answers", answers, "--method-bundle", method], { clock, stdout: value => { printed += value; } });
  assert.equal(result.exitCode, 0); assert.doesNotMatch(printed, /SECRET_PRIVATE_|caller-model|HOME/);
  const unshared = f.save("shared-answers.json", f.answers); chmodSync(unshared, 0o644);
  assert.equal((await runSetup(["--workspace", join(f.root, "other"), "--answers", unshared], { stdout: () => {} })).output.code, "INPUT_FILE_UNSAFE");
});

async function terminalSetup(t, { boundary = 'focus', action = 'SIGINT', success = false } = {}) {
  const f = fixture(t), input = new PassThrough(), promptOutput = new PassThrough(), controller = new AbortController();
  input.isTTY = true; promptOutput.isTTY = true; promptOutput.columns = 80;
  let displayed = '', printed = '', calls = 0, released = false, release;
  const ready = new Promise(resolve => { release = resolve; });
  const steps = [
    ['Focus: ai_compute or pcb_ccl', 'ai_compute'],
    ['Company symbols: include US and Asian companies', 'TTMI,2383.TW'],
    ['Private research question', 'Synthetic private question.'],
    ['Next evidence or review trigger', 'Synthetic issuer update.'],
    ['Save this local setup? Type yes to continue', 'yes'],
    ['Send the theme and company symbols to equitylayer.io', 'yes']
  ];
  let step = 0;
  promptOutput.on('data', bytes => {
    displayed += bytes;
    if (!released && displayed.includes(boundary === 'focus' ? steps[0][0] : steps[5][0])) { released = true; release(); }
    if (step < steps.length && displayed.includes(steps[step][0])) {
      const [prompt, answer] = steps[step++];
      if (!success && prompt === (boundary === 'focus' ? steps[0][0] : steps[5][0])) return;
      queueMicrotask(() => input.write(`${answer}\n`));
    }
  });
  t.after(() => { input.destroy(); promptOutput.destroy(); });
  let timer;
  const limit = promise => Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Synthetic terminal exceeded the test deadline.')), 1500);
  })]).finally(() => clearTimeout(timer));
  const baselineListeners = getEventListeners(controller.signal, 'abort').length;
  const attempt = runSetup(['--session', '--workspace', f.workspace,
    ...(success ? ['--method-bundle', f.save('terminal-method.json', methodBundle())] : [])], {
    clock, input, promptOutput, signal: controller.signal, stdout: value => { printed += value; },
    connectClient: async () => { calls++; throw Error('Synthetic connection must not start.'); }
  });
  if (!success) {
    await limit(ready);
    if (action === 'SIGINT') input.write('\u0003');
    else if (action === 'EOF') input.end();
    else controller.abort();
  }
  const outcome = await limit(attempt);
  assert.equal(calls, 0);
  if (success) {
    assert.equal(outcome.exitCode, 0); assert.equal(outcome.output.research_mode, 'external_session');
    assert.equal(outcome.output.counts.requests, 0); assert.equal(outcome.output.tracking_started, false);
  } else {
    assert.deepEqual(outcome, { exitCode: 1, output: { status: 'error', code: 'SETUP_CANCELLED' } });
    assert.equal(printed, '{"status":"error","code":"SETUP_CANCELLED"}\n');
    assert.equal(existsSync(f.workspace), false);
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, baselineListeners);
  return { input, promptOutput, printed, displayed, controller };
}

for (const boundary of ['focus', 'public consent']) for (const action of ['SIGINT', 'EOF', 'external abort']) {
  test(`interactive ${action} at ${boundary} cancels without storage or connection`, { timeout: 6000 }, async t => {
    await terminalSetup(t, { boundary, action });
  });
}

test('interactive completion preserves explicit offline session setup and removes listeners', { timeout: 6000 }, async t => {
  await terminalSetup(t, { success: true });
});

test('interactive cancellation releases input listeners before a second setup', { timeout: 6000 }, async t => {
  const first = await terminalSetup(t);
  assert.equal(first.input.listenerCount('keypress'), 0);
  assert.equal(first.input.listenerCount('end'), 0);
  await terminalSetup(t, { boundary: 'public consent', action: 'EOF' });
});

test('non-terminal setup still requires explicit machine inputs', async t => {
  const f = fixture(t), input = new PassThrough(), promptOutput = new PassThrough();
  t.after(() => { input.destroy(); promptOutput.destroy(); });
  const output = await runSetup(['--session', '--workspace', f.workspace], { input, promptOutput, stdout() {} });
  assert.equal(output.output.code, 'SETUP_INTERACTIVE_REQUIRED'); assert.equal(existsSync(f.workspace), false);
});

test('an unrelated injected AbortError remains an operation failure', async t => {
  const f = fixture(t);
  const output = await runSetup(['--session', '--workspace', f.workspace], {
    ask: async () => { const error = Error('Synthetic unrelated failure.'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; throw error; }, stdout() {}
  });
  assert.equal(output.output.code, 'SETUP_OPERATION_FAILED'); assert.equal(existsSync(f.workspace), false);
});

test('an already cancelled terminal setup displays no prompt and creates nothing', async t => {
  const f = fixture(t), input = new PassThrough(), promptOutput = new PassThrough(), controller = new AbortController();
  input.isTTY = true; promptOutput.isTTY = true; let displayed = '';
  promptOutput.on('data', bytes => { displayed += bytes; }); controller.abort();
  t.after(() => { input.destroy(); promptOutput.destroy(); });
  const outcome = await runSetup(['--session', '--workspace', f.workspace], { input, promptOutput, signal: controller.signal, stdout() {} });
  assert.equal(outcome.output.code, 'SETUP_CANCELLED'); assert.equal(displayed, ''); assert.equal(existsSync(f.workspace), false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
