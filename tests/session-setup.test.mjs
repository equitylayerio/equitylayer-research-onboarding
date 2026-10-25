import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWorkspace, runSetup, collectSetupAnswers, validateSetupSnapshot } from "../client/setup-cli.mjs";
import { setupSource } from "../client/source-setup-cli.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { methodBundle } from "./fixtures/local-research.mjs";
import { contentHash } from "../client/local/run-contract.mjs";

const zero = { requests: 0, tokens: 0, cost_microusd: 0, wall_ms: 0 };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "el-session-setup-")), workspace = join(root, "new workspace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const answers = { focus: "pcb_ccl", symbols: ["NVDA", "2383.TW", "6752.T", "000150.KS"],
    question: "SYNTHETIC_PRIVATE_QUESTION", trigger: "SYNTHETIC_PRIVATE_TRIGGER" };
  const setup = (extra = {}, dependencies = {}) => setupWorkspace({ workspace, answers, session: true, method_bundle: methodBundle(), ...extra }, dependencies);
  return { root, workspace, answers, setup, snapshot: () => JSON.parse(readFileSync(join(workspace, "setup.local.json"), "utf8")) };
}

test("session setup needs no runtime, credentials, or inference budget", async t => {
  const f = fixture(t), output = await f.setup(), snapshot = f.snapshot();
  assert.equal(snapshot.schema_version, 2); assert.equal(snapshot.execution_mode, "external_session"); assert.equal(snapshot.runtime, null);
  assert.deepEqual(snapshot.init.budget.limits, zero); assert.equal(output.research_mode, "external_session");
  assert.equal(output.runtime_file, null); assert.equal(output.accounting, "user_client_unverified");
  assert.equal(output.execution_authorized, false); assert.equal(output.tracking_started, false);
  assert.equal(existsSync(join(f.workspace, "runtime.local.json")), false);
  assert.doesNotMatch(JSON.stringify(output), /SYNTHETIC_PRIVATE_|executable.*node|model_name/);
  for (const file of ["setup.local.json", "init.local.json"]) assert.equal(statSync(join(f.workspace, file)).mode & 0o777, 0o600);
  const ledger = new ResearchLedger(f.workspace); t.after(() => ledger.close());
  assert.deepEqual(ledger.budget(output.watch_id, "initial").limits, zero);
  assert.equal(ledger.workspaceStatus().counts.requests, 0); assert.equal(ledger.workspaceStatus().runs.length, 0);
});

for (const field of ["runtime", "budget", "api_key", "execution_mode"]) test(`session answers reject an unexpected ${field}`, async t => {
  const f = fixture(t);
  await assert.rejects(f.setup({ answers: { ...f.answers, [field]: {} } }), { code: "SETUP_INPUT_INVALID" });
  assert.equal(existsSync(f.workspace), false);
});

test("session setup rejects native inspection before any network or filesystem action", async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(f.setup({ allow_native_check: true, method_bundle: undefined, allow_public_scope: true },
    { connectClient: async () => { calls++; throw Error("Must not connect."); } }), { code: "SETUP_FLAGS_INVALID" });
  assert.equal(calls, 0); assert.equal(existsSync(f.workspace), false);
});

test("session setup sends only public scope with separate method consent", async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(f.setup({ method_bundle: undefined }), { code: "SETUP_PUBLIC_SCOPE_CONSENT_REQUIRED" });
  await f.setup({ method_bundle: undefined, allow_public_scope: true }, { connectClient: async () => ({
    tools: async () => ({ tools: [{ name: "resolve_research_scope" }] }), close: async () => {},
    call: async (name, scope) => { calls++; assert.doesNotMatch(JSON.stringify(scope), /SYNTHETIC_PRIVATE_|runtime|budget/);
      return { schema_version: 1, operation: name, ok: true, scope, method: { evidence_profile_bundle: methodBundle() } }; }
  }) });
  assert.equal(calls, 1);
});

test("session setup resumes its exact snapshot without adding runtime authority", async t => {
  const f = fixture(t);
  await assert.rejects(f.setup({}, { fault: stage => { if (stage === "setup:after_snapshot") throw Error("Synthetic interruption."); } }));
  const before = readFileSync(join(f.workspace, "setup.local.json"));
  const output = await setupWorkspace({ workspace: f.workspace, resume: true });
  assert.equal(output.research_mode, "external_session"); assert.equal(existsSync(join(f.workspace, "runtime.local.json")), false);
  assert.deepEqual(readFileSync(join(f.workspace, "setup.local.json")), before);
  await assert.rejects(setupWorkspace({ workspace: f.workspace, resume: true, allow_native_check: true }), { code: "SETUP_FLAGS_INVALID" });
});

for (const kind of ["file", "dangling_link"]) test(`session resume rejects a stray runtime ${kind} without overwriting it`, async t => {
  const f = fixture(t); await f.setup(); const runtime = join(f.workspace, "runtime.local.json");
  if (kind === "file") writeFileSync(runtime, "SYNTHETIC_UNRELATED_RUNTIME", { mode: 0o600 });
  else symlinkSync(join(f.root, "absent"), runtime);
  await assert.rejects(setupWorkspace({ workspace: f.workspace, resume: true }), { code: "SETUP_STATE_CONFLICT" });
  if (kind === "file") assert.equal(readFileSync(runtime, "utf8"), "SYNTHETIC_UNRELATED_RUNTIME");
});

test("rehashing session snapshots cannot add budget or runtime authority", async t => {
  const f = fixture(t); await f.setup();
  for (const change of [body => { body.runtime = {}; }, body => { body.init.budget.limits.requests = 1; },
    body => { body.execution_mode = "native_runner"; }, body => { body.schema_version = 1; }]) {
    const body = f.snapshot(); delete body.content_sha256; change(body);
    assert.throws(() => validateSetupSnapshot({ ...body, content_sha256: contentHash(body) }));
  }
});

test("session-first source setup retains HOLD and creates no automatic model work", async t => {
  const f = fixture(t); const setup = await f.setup();
  const output = await setupSource({ workspace: f.workspace, answers: { kind: "twse_monthly_revenue_api", rights_status: "HOLD",
    rights_reference: "Synthetic pending local permission", allow_candidate_trials: false } });
  assert.equal(output.status, "needs_source_rights");
  const ledger = new ResearchLedger(f.workspace); t.after(() => ledger.close());
  assert.equal(ledger.workspaceStatus().counts.requests, 0);
  assert.deepEqual(ledger.budget(setup.watch_id, "initial").limits, zero);
  assert.equal(output.max_runs, 0); assert.equal(ledger.pageSchedules()[0].mode, "observation_only");
});

test("session-first watch can prepare an explicit gap task without a runner", async t => {
  const f = fixture(t), setup = await f.setup(), ledger = new ResearchLedger(f.workspace); t.after(() => ledger.close());
  const service = new WorkspaceService(ledger), options = service.sessionOptions({ watch_id: setup.watch_id });
  const prepared = service.prepareSession({ preparation_id: "11111111-2222-4222-8222-111111111111", watch_id: setup.watch_id,
    revision: 1, method_sha256: options.methods.items[0].bundle_sha256, source_event_ids: [], confirm_no_sources: true,
    allow_private_context: true, allow_candidate_method: true, allow_external_submission: true });
  assert.equal(prepared.native_execution, false); assert.equal(prepared.usage, "unverified");
  assert.equal(ledger.workspaceStatus().counts.requests, 0); assert.equal(existsSync(join(f.workspace, "runtime.local.json")), false);
});

test("interactive session setup asks only for the watch and explicit save", async t => {
  const f = fixture(t), answers = ["pcb_ccl", "NVDA,2383.TW", "Synthetic question", "Next issuer result", "yes"], prompts = [];
  const value = await collectSetupAnswers(async prompt => { prompts.push(prompt); return answers.shift(); }, { session: true });
  assert.equal(answers.length, 0); assert.deepEqual(Object.keys(value).sort(), ["focus", "question", "symbols", "trigger"]);
  assert.doesNotMatch(prompts.join("\n"), /executable|version|login|model name|budget|tokens|Maximum requests/);
  const answerFile = join(f.root, "answers.json"), methodFile = join(f.root, "method.json");
  writeFileSync(answerFile, JSON.stringify(f.answers), { mode: 0o600 }); writeFileSync(methodFile, JSON.stringify(methodBundle()), { mode: 0o600 });
  const output = await runSetup(["--session", "--workspace", f.workspace, "--answers", answerFile, "--method-bundle", methodFile], { stdout() {} });
  assert.equal(output.exitCode, 0); assert.equal(output.output.research_mode, "external_session");
});
