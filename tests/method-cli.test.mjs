import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLocal } from "../client/local-cli.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { contentHash, createRunEnvelope } from "../client/local/run-contract.mjs";
import { scope, context, methodBundle, limits, policy, source, estimate } from "./fixtures/local-research.mjs";
import { sourcePolicy, eventFixture, evaluationAt } from "./fixtures/source-events.mjs";

const entry = fileURLToPath(new URL("../client/local-cli.mjs", import.meta.url));
const privateText = /SECRET_|private_context|origin_record|source_refs|requests|retention_limits|example\.test|Synthetic row/;
function environment() {
  const root = mkdtempSync(join(tmpdir(), "el-method-cli-test-")); const workspace = join(root, "workspace");
  const save = (name, value, mode = 0o600) => {
    const path = join(root, name); writeFileSync(path, JSON.stringify(value), { mode }); return path;
  };
  const outputs = [];
  const call = (args, overrides = {}) => runLocal(args, { stdout: value => outputs.push(value),
    clock: () => Date.parse("2026-10-12T00:00:01Z"), ...overrides });
  const init = save("private-config.json", { scope: scope(), private_context: { ...context(), question: "SECRET_PRIVATE_CONTEXT" },
    method_bundle: methodBundle(), budget: { window_id: "method-window", limits: limits() },
    source_policies: [{ ...sourcePolicy(), rights_status: "HOLD" }] });
  return { root, workspace, save, outputs, call, init };
}
const args = (env, command, ...rest) => [command, "--workspace", env.workspace, ...rest];
async function prepare(env) {
  const initialized = await env.call(args(env, "init", "--input", env.init)); assert.equal(initialized.exitCode, 0);
  const fixture = eventFixture(); const { bytes, ...rest } = fixture;
  const raw = join(env.root, "source.json"); writeFileSync(raw, bytes, { mode: 0o600 });
  const input = env.save("source-event.json", { ...rest, raw_file: raw, watch_id: scope().watch_id,
    method_sha256: initialized.output.method_sha256, evaluation_at: evaluationAt,
    budget_window: "method-window", run_policy: policy() });
  const gate = await env.call(args(env, "intake", "--input", input)); assert.equal(gate.output.gate_code, "SOURCE_RIGHTS_HOLD");
  const request = { case_id: "synthetic-gate", origin: { kind: "source_gate", id: gate.output.decision_id },
    note: "SECRET_CASE_NOTE", author_id: "synthetic-author" };
  return { methodSha: initialized.output.method_sha256, request, path: env.save("case.json", request) };
}
async function capture(env, prepared) {
  const output = await env.call(args(env, "method-capture", "--input", prepared.path)); assert.equal(output.exitCode, 0);
  assert.deepEqual(Object.keys(output.output).sort(), ["artifact_id", "reused", "sha256"]);
  return { case_id: prepared.request.case_id, case_sha256: output.output.sha256 };
}
function candidate(methodSha, ref) {
  const bundle = methodBundle(); delete bundle.content_sha256; bundle.version = "test-2";
  bundle.execution_policy = "SECRET_CANDIDATE_POLICY"; bundle.content_sha256 = contentHash(bundle);
  return { candidate_id: "synthetic-candidate", bundle, parent_method_sha256: methodSha, case_refs: [ref],
    reason: "SECRET_CANDIDATE_REASON", author_id: "synthetic-author" };
}
function plan(methodSha, ref, partition = "regression") {
  return { plan_id: "synthetic-plan", incumbent_method_sha256: methodSha, case_refs: [{ ...ref, partition }],
    rubric: { version: "synthetic-1", criteria: [{ id: "source-boundary", description: "SECRET_RUBRIC_DESCRIPTION", critical: true, weight: 1 }],
      minimum_score_bps: 10000, critical_regression_veto: true, comparison_rule: "paired_incumbent_no_regression" },
    evaluation_at: "2026-10-12T00:00:00.000Z", repetitions: 2, runtime_policy_sha256: "a".repeat(64), author_id: "synthetic-author" };
}

test("method commands retain exact artifacts and emit safe summaries after reopen", async () => {
  const env = environment(); const prepared = await prepare(env); const ref = await capture(env, prepared);
  const candidatePath = env.save("candidate.json", candidate(prepared.methodSha, ref));
  const planPath = env.save("plan.json", plan(prepared.methodSha, ref));
  const firstCandidate = await env.call(args(env, "method-candidate", "--input", candidatePath));
  assert.equal(firstCandidate.exitCode, 0); assert.equal(firstCandidate.output.status, "candidate");
  assert.deepEqual(Object.keys(firstCandidate.output).sort(), ["artifact_id", "reused", "sha256", "status"]);
  const firstPlan = await env.call(args(env, "method-plan", "--input", planPath));
  assert.equal(firstPlan.exitCode, 2); assert.equal(firstPlan.output.status, "gated");
  assert.equal(firstPlan.output.gate_code, "HUMAN_METHOD_APPROVAL_REQUIRED");
  assert.deepEqual(Object.keys(firstPlan.output).sort(), ["artifact_id", "gate_code", "reused", "sha256", "status"]);
  for (const [command, path, first] of [["method-capture", prepared.path, { output: { sha256: ref.case_sha256 } }],
    ["method-candidate", candidatePath, firstCandidate], ["method-plan", planPath, firstPlan]]) {
    const replay = await env.call(args(env, command, "--input", path));
    assert.equal(replay.output.reused, true); assert.equal(replay.output.sha256, first.output.sha256);
  }
  const status = await env.call(args(env, "method-status"));
  assert.equal(status.exitCode, 2); assert.deepEqual(status.output,
    { status: "gated", counts: { case: 1, candidate: 1, plan: 1 }, gate_code: "HUMAN_METHOD_APPROVAL_REQUIRED" });
  const child = spawnSync(process.execPath, [entry, ...args(env, "method-capture", "--input", prepared.path)],
    { encoding: "utf8", timeout: 2000 });
  assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).reused, true);
  assert.doesNotMatch(env.outputs.join("") + child.stdout + child.stderr, privateText);
  const ledger = new ResearchLedger(env.workspace);
  try {
    const retained = ledger.methodArtifact("case:synthetic-gate");
    assert.equal(retained.record.payload.private_context.question, "SECRET_PRIVATE_CONTEXT");
    assert.equal(retained.record.payload.classification, "regression");
    assert.equal(ledger.methodArtifact("plan:synthetic-plan").record.payload.evaluation_status, "not_executed");
    assert.equal(ledger.workspaceStatus().counts.requests, 0);
  } finally { ledger.close(); }
});

test("a gated run retains runtime output without CLI disclosure", async () => {
  const env = environment(); await prepare(env); const ledger = new ResearchLedger(env.workspace);
  let runId;
  try {
    const revision = ledger.watch(scope().watch_id).revisions[0];
    const fixture = source(2); const sourceRef = ledger.retainSource(fixture.event, fixture.artifact, fixture.bytes);
    const envelope = createRunEnvelope({ scope: scope(), method: ledger.retainMethod(methodBundle()), source_refs: [sourceRef],
      baselines: [], evaluation_at: "2026-10-12T00:00:00Z", local_context_sha256: revision.local_context_sha256 });
    ledger.enqueue(envelope, "method-window", policy()); const lease = ledger.claim("synthetic-owner");
    const request = ledger.reserveRequest(lease, "synthetic-analysis", estimate()); ledger.markDispatched(lease, request.request_id);
    ledger.settleRequest(lease, request.request_id, null, { output: "SECRET_RUNTIME_OUTPUT" }); runId = envelope.run_id;
  } finally { ledger.close(); }
  const input = env.save("run-case.json", { case_id: "synthetic-run", origin: { kind: "run", id: runId },
    note: "SECRET_RUNTIME_NOTE", author_id: "synthetic-author" });
  const captured = await env.call(args(env, "method-capture", "--input", input)); assert.equal(captured.exitCode, 0);
  assert.doesNotMatch(env.outputs.join(""), privateText);
  const reopened = new ResearchLedger(env.workspace);
  try { assert.equal(reopened.methodArtifact("case:synthetic-run").record.payload.requests[0].response.output, "SECRET_RUNTIME_OUTPUT"); }
  finally { reopened.close(); }
});

test("method artifact IDs reject conflicting content without private errors", async () => {
  const env = environment(); const prepared = await prepare(env); const ref = await capture(env, prepared);
  const candidateInput = candidate(prepared.methodSha, ref); const planInput = plan(prepared.methodSha, ref);
  for (const [command, input, field] of [["method-capture", prepared.request, "note"],
    ["method-candidate", candidateInput, "reason"], ["method-plan", planInput, "author_id"]]) {
    const original = env.save(`${command}.json`, input); await env.call(args(env, command, "--input", original));
    const changed = env.save(`${command}-conflict.json`, { ...input, [field]: "SECRET_CHANGED_CONTENT" });
    const output = await env.call(args(env, command, "--input", changed));
    assert.deepEqual(output.output, { status: "error", code: "METHOD_ARTIFACT_CONFLICT" }); assert.equal(output.exitCode, 1);
  }
  assert.doesNotMatch(env.outputs.join(""), privateText);
});

test("captured historical cases cannot become unseen holdouts", async () => {
  const env = environment(); const prepared = await prepare(env); const ref = await capture(env, prepared);
  const output = await env.call(args(env, "method-plan", "--input", env.save("holdout.json", plan(prepared.methodSha, ref, "holdout"))));
  assert.equal(output.exitCode, 1); assert.deepEqual(output.output, { status: "error", code: "METHOD_HOLDOUT_EXPOSED" });
  assert.deepEqual((await env.call(args(env, "method-status"))).output.counts, { case: 1, candidate: 0, plan: 0 });
});

test("method status reports the empty retained stage without execution", async () => {
  const env = environment(); await env.call(args(env, "init", "--input", env.init));
  assert.deepEqual((await env.call(args(env, "method-status"))).output,
    { status: "gated", counts: { case: 0, candidate: 0, plan: 0 }, gate_code: "HUMAN_METHOD_APPROVAL_REQUIRED" });
});

test("method schemas reject extra fields and expose MethodArtifactError codes only", async () => {
  const env = environment(); const prepared = await prepare(env); const ref = await capture(env, prepared);
  for (const [command, input] of [["method-capture", prepared.request], ["method-candidate", candidate(prepared.methodSha, ref)],
    ["method-plan", plan(prepared.methodSha, ref)]]) {
    const output = await env.call(args(env, command, "--input", env.save(`${command}-extra.json`, { ...input, secret: "SECRET_EXTRA" })));
    assert.deepEqual(output.output, { status: "error", code: "METHOD_INPUT_INVALID" }); assert.equal(output.exitCode, 1);
  }
  assert.doesNotMatch(env.outputs.join(""), privateText);
});

test("method commands require exact flags and an existing absolute workspace", async () => {
  const env = environment(); const prepared = await prepare(env);
  for (const command of ["method-capture", "method-candidate", "method-plan"]) {
    for (const rest of [[], ["--input"], ["--input", prepared.path, "--runtime", "SECRET_RUNTIME"],
      ["--input", prepared.path, "--input", prepared.path], ["--input", prepared.path, "--allow-candidate-method"]]) {
      assert.deepEqual((await env.call(args(env, command, ...rest))).output, { status: "error", code: "CLI_FLAGS_INVALID" });
    }
    assert.equal((await env.call([command, "--workspace", "relative", "--input", prepared.path])).output.code, "WORKSPACE_PATH_INVALID");
    assert.equal((await env.call([command, "--workspace", join(env.root, "missing"), "--input", prepared.path])).output.code, "WORKSPACE_MISSING");
  }
  assert.equal((await env.call(args(env, "method-status", "--input", prepared.path))).output.code, "CLI_FLAGS_INVALID");
  assert.equal((await env.call(args(env, "method-promote"))).output.code, "CLI_COMMAND_INVALID");
  assert.doesNotMatch(env.outputs.join(""), privateText);
});

test("method inputs retain private file checks and bounded JSON reads", async () => {
  const env = environment(); const prepared = await prepare(env);
  const shared = env.save("shared.json", prepared.request, 0o644);
  const symlink = join(env.root, "symlink.json"); symlinkSync(prepared.path, symlink);
  const hardlink = join(env.root, "hardlink.json"); linkSync(prepared.path, hardlink);
  const malformed = env.save("malformed.json", {}); writeFileSync(malformed, "SECRET_BAD_JSON{");
  const large = env.save("large.json", {}); writeFileSync(large, " ".repeat(1_000_001));
  const directory = join(env.root, "directory"); mkdirSync(directory, { mode: 0o700 });
  for (const command of ["method-capture", "method-candidate", "method-plan"]) {
    for (const path of [shared, symlink, hardlink, large, directory]) {
      assert.equal((await env.call(args(env, command, "--input", path))).output.code, "INPUT_FILE_UNSAFE");
    }
    assert.equal((await env.call(args(env, command, "--input", malformed))).output.code, "INPUT_JSON_INVALID");
    assert.equal((await env.call(args(env, command, "--input", join(env.root, "missing.json")))).output.code, "INPUT_FILE_ACCESS_FAILED");
  }
  assert.doesNotMatch(env.outputs.join(""), /SECRET_|el-method-cli-test/);
});
