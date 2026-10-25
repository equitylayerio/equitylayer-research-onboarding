import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, createRunEnvelope, validateRunEnvelope, publicBeginArguments } from "../client/local/run-contract.mjs";
import { validateTrialRuntimePolicy, requireTrialRuntimePolicy } from "../client/local/trial-policy.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { executeClaimedRun } from "../client/local/executor.mjs";
import { setup, policy as runPolicy } from "./fixtures/local-research.mjs";

const trial = () => ({ plan_id: "plan-one", plan_sha256: "1".repeat(64), case_id: "case-one", case_sha256: "2".repeat(64),
  candidate_id: "candidate-one", candidate_sha256: "3".repeat(64), role: "incumbent", repetition: 1, runtime_policy_sha256: "4".repeat(64) });
const runtimePolicy = () => ({ schema_version: 1, runtime: { identity: "synthetic-runtime", config_sha256: "a".repeat(64) },
  execution: { estimate: { tokens: 100, cost_microusd: 100, wall_ms: 3000 }, timeout_ms: 3000, lease_ms: 9000, heartbeat_ms: 2000, retry_delay_ms: 100 } });
function environment() {
  const ledger = new ResearchLedger(mkdtempSync(join(tmpdir(), "equitylayer-trial-policy-")));
  const research = setup(ledger);
  const { run_id, delivery_id, contract_version, ...basis } = research;
  return { ledger, research, basis };
}
test("a local trial uses a distinct purpose identity without changing the research basis", () => {
  const env = environment();
  const ordinary = createRunEnvelope(env.basis); assert.deepEqual(ordinary, env.research); assert.equal(ordinary.contract_version, "1.0.0");
  const assessment = createRunEnvelope({ ...env.basis, trial: trial() });
  assert.equal(assessment.contract_version, "1.1.0"); assert.notEqual(assessment.run_id, ordinary.run_id);
  assert.deepEqual(validateRunEnvelope(assessment), assessment); assert.deepEqual(assessment.scope, ordinary.scope);
  assert.throws(() => publicBeginArguments(assessment), { code: "LOCAL_TRIAL_ONLY" }); env.ledger.close();
});
for (const field of ["plan_id", "plan_sha256", "case_id", "case_sha256", "candidate_id", "candidate_sha256", "role", "repetition", "runtime_policy_sha256"]) {
  test(`trial identity changes when ${field} changes, including the incumbent role`, () => {
    const env = environment(); const initial = trial(); const changed = { ...initial,
      [field]: field === "role" ? "candidate" : field === "repetition" ? 2 : field.endsWith("sha256") ? "f".repeat(64) : "another-identity" };
    assert.notEqual(createRunEnvelope({ ...env.basis, trial: initial }).run_id, createRunEnvelope({ ...env.basis, trial: changed }).run_id);
    env.ledger.close();
  });
}
test("contract version cannot conceal, remove, or relabel a trial purpose", () => {
  const env = environment(); const assessment = createRunEnvelope({ ...env.basis, trial: trial() });
  assert.throws(() => validateRunEnvelope({ ...assessment, contract_version: "1.0.0" }), { code: "INVALID_RUN_CONTRACT" });
  const { trial: ignored, ...hidden } = assessment;
  assert.throws(() => validateRunEnvelope(hidden), { code: "INVALID_RUN_CONTRACT" });
  assert.throws(() => createRunEnvelope({ ...env.basis, trial: { ...trial(), repetition: 0 } }), { code: "INVALID_RUN_CONTRACT" });
  assert.throws(() => createRunEnvelope({ ...env.basis, trial: { ...trial(), approved: true } }), { code: "INVALID_RUN_CONTRACT" });
  assert.throws(() => createRunEnvelope({ ...env.basis, trial: { ...trial(), role: "production" } }), { code: "INVALID_RUN_CONTRACT" });
  env.ledger.close();
});
test("generic research enqueue rejects a trial before changing runs, notices, budgets, or cursors", () => {
  const env = environment(), before = env.ledger.workspaceStatus();
  const assessment = createRunEnvelope({ ...env.basis, trial: trial() });
  assert.throws(() => env.ledger.enqueue(assessment, "test-window", runPolicy()), { code: "METHOD_TRIAL_AUTHORITY_REQUIRED" });
  assert.deepEqual(env.ledger.workspaceStatus(), before); assert.deepEqual(env.ledger.cursors(env.basis.scope.watch_id), []);
  assert.equal(env.ledger.claim("research-worker"), null); env.ledger.close();
});
test("the research executor refuses an explicit trial before a runtime call or ledger mutation", async () => {
  let calls = 0;
  const output = await executeClaimedRun({ run() { throw Error("No ledger call expected."); } }, { envelope: { trial: trial() } },
    { execute() { calls++; } }, { allow_private_context: true, allow_candidate_method: true });
  assert.deepEqual(output, { status: "gated", code: "METHOD_TRIAL_EXECUTOR_REQUIRED" }); assert.equal(calls, 0);
});
test("runtime policy hashes fix the exact declared caller and all execution limits", () => {
  const value = runtimePolicy(), retained = validateTrialRuntimePolicy(value);
  const runtime = { ...value.runtime, execute: async () => ({}) };
  assert.equal(requireTrialRuntimePolicy(retained.sha256, value, runtime, value.execution).sha256, retained.sha256);
  const frozen = canonicalJson(retained); value.execution.timeout_ms = 2000;
  assert.notEqual(validateTrialRuntimePolicy(value).sha256, retained.sha256); assert.equal(canonicalJson(retained), frozen);
});
test("trial execution rejects a changed runtime or any changed execution option", () => {
  const value = runtimePolicy(), retained = validateTrialRuntimePolicy(value), runtime = { ...value.runtime, execute: async () => ({}) };
  for (const changes of [{ identity: "other-runtime" }, { config_sha256: "b".repeat(64) }, { execute: undefined }]) {
    assert.throws(() => requireTrialRuntimePolicy(retained.sha256, value, { ...runtime, ...changes }, value.execution), { code: "TRIAL_POLICY_INVALID" });
  }
  for (const field of ["estimate", "timeout_ms", "lease_ms", "heartbeat_ms", "retry_delay_ms"]) {
    const changed = { ...value.execution, [field]: field === "estimate" ? { ...value.execution.estimate, tokens: 101 } : value.execution[field] + 1 };
    assert.throws(() => requireTrialRuntimePolicy(retained.sha256, value, runtime, changed), { code: "TRIAL_POLICY_INVALID" });
  }
  assert.throws(() => requireTrialRuntimePolicy("c".repeat(64), value, runtime, value.execution), { code: "TRIAL_POLICY_INVALID" });
});
test("a runtime policy cannot grant source, payment, trading, or release permission", () => {
  for (const field of ["source_rights", "payment_authorized", "trading_authorized", "approved", "model_secret"]) {
    assert.throws(() => validateTrialRuntimePolicy({ ...runtimePolicy(), [field]: true }), { code: "METHOD_INPUT_INVALID" });
  }
  for (const changes of [{ timeout_ms: 0 }, { heartbeat_ms: 9000 }, { retry_delay_ms: 60001 },
    { estimate: { tokens: 1, cost_microusd: 1, wall_ms: 1 } }]) {
    assert.throws(() => validateTrialRuntimePolicy({ ...runtimePolicy(), execution: { ...runtimePolicy().execution, ...changes } }), { code: "TRIAL_POLICY_INVALID" });
  }
});
