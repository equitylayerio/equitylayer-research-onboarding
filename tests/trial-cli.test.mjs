import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { runLocal } from "../client/local-cli.mjs";
import { createLocalCommandRuntime } from "../client/local/command-runtime.mjs";
import { contentHash } from "../client/local/run-contract.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { trialFixture } from "./fixtures/method-trials.mjs";

function fixture() {
  const env = trialFixture();
  const command = { allow_local_command: true, executable: process.execPath, identity: "synthetic-cli-pair",
    args: ["--input-type=module", "-e", "let text='';for await(const part of process.stdin)text+=part;const c=JSON.parse(text).input.research_context;process.stdout.write(JSON.stringify({agent_fields:{result_state:'REVIEW_REQUIRED',summary:'SECRET_SYNTHETIC_TRIAL_SUMMARY',sources:[{url:c.sources[0].artifact.canonical_url,date:'2026-10-11',claim:'SECRET_TRIAL_CLAIM',kind:'reported_fact'}],drivers:[],falsifiers:[],unknowns:[],next_check_at:'2026-10-13T00:00:00Z'},usage:{tokens:1,cost_microusd:1}}));"], timeout_ms: 3000 };
  const runtime = createLocalCommandRuntime(command);
  const execution = { estimate: { tokens: 100, cost_microusd: 100, wall_ms: 2000 }, timeout_ms: 1000, lease_ms: 3000, heartbeat_ms: 20, retry_delay_ms: 0 };
  const runtimePolicy = { schema_version: 1, runtime: { identity: runtime.identity, config_sha256: runtime.config_sha256 }, execution };
  const old = env.ledger.methodArtifact("plan:synthetic-plan").record.request;
  env.ledger.freezeMethodPlan({ ...old, plan_id: "cli-plan", runtime_policy_sha256: contentHash(runtimePolicy) });
  const request = { ...env.request, plan_id: "cli-plan", runtime_policy: runtimePolicy };
  const save = (name, data) => { const path = join(env.directory, name); writeFileSync(path, JSON.stringify(data), { mode: 0o600 }); return path; };
  const runtimeFile = save("runtime.json", { command, execution }), requestFile = save("pair-request.json", request);
  env.ledger.close(); const outputs = [];
  const call = args => runLocal(args, { stdout: value => outputs.push(value), clock: env.clock });
  const args = (command, ...flags) => [command, "--workspace", env.directory, ...flags];
  return { ...env, request, runtimeFile, requestFile, outputs, call, args, save, runtimePolicy };
}
const runArgs = (env, runId) => env.args("method-run", "--run-id", runId, "--runtime", env.runtimeFile,
  "--allow-private-context", "--allow-candidate-method", "--allow-method-trial");

test("CLI retains a pair, executes both synthetic child roles, and returns only summary identifiers", async () => {
  const env = fixture();
  const pin = await env.call(env.args("method-runtime-policy", "--runtime", env.runtimeFile)); assert.deepEqual(pin.output.policy, env.runtimePolicy);
  const paired = await env.call(env.args("method-enqueue", "--input", env.requestFile)); assert.equal(paired.exitCode, 0);
  for (const role of ["incumbent", "candidate"]) {
    const runId = paired.output[`${role}_run_id`];
    const output = await env.call(runArgs(env, runId)); assert.equal(output.exitCode, 0); assert.equal(output.output.status, "completed");
    const reused = await env.call(runArgs(env, runId)); assert.equal(reused.exitCode, 0); assert.equal(reused.output.status, "completed");
  }
  const status = await env.call(env.args("method-pair-status", "--pair-id", paired.output.pair_id));
  assert.equal(status.output.outputs.length, 2); assert.equal(status.output.quality_verified, false); assert.equal(status.output.method_release_gate, "HUMAN_METHOD_APPROVAL_REQUIRED");
  assert.doesNotMatch(env.outputs.join(""), /SECRET_SYNTHETIC_TRIAL_SUMMARY|SECRET_TRIAL_CLAIM|private_context|research_context/);
  const ledger = new ResearchLedger(env.directory); assert.equal(ledger.inbox().length, 0); assert.equal(ledger.workspaceStatus().counts.requests, 2); ledger.verifyIntegrity(); ledger.close();
});
test("CLI refuses a missing trial consent flag before a lease or request", async () => {
  const env = fixture(); const pair = await env.call(env.args("method-enqueue", "--input", env.requestFile));
  assert.equal((await env.call(runArgs(env, pair.output.incumbent_run_id).filter(flag => flag !== "--allow-method-trial"))).output.code, "RUN_CONSENT_REQUIRED");
  const ledger = new ResearchLedger(env.directory); assert.equal(ledger.run(pair.output.incumbent_run_id).attempts, 0); assert.equal(ledger.workspaceStatus().counts.requests, 0); ledger.close();
});
test("CLI rejects shared runtime files before a trial lease", async () => {
  const env = fixture(); const pair = await env.call(env.args("method-enqueue", "--input", env.requestFile)); chmodSync(env.runtimeFile, 0o644);
  assert.equal((await env.call(runArgs(env, pair.output.incumbent_run_id))).output.code, "INPUT_FILE_UNSAFE");
  const ledger = new ResearchLedger(env.directory); assert.equal(ledger.run(pair.output.incumbent_run_id).attempts, 0); ledger.close();
});
test("CLI rejects changed declared runtime before acquiring the trial", async () => {
  const env = fixture(); const pair = await env.call(env.args("method-enqueue", "--input", env.requestFile));
  const changed = env.save("other-runtime.json", { command: { allow_local_command: true, executable: process.execPath, args: [], identity: "changed" }, execution: env.runtimePolicy.execution });
  const args = runArgs(env, pair.output.incumbent_run_id); args[args.indexOf("--runtime") + 1] = changed;
  assert.equal((await env.call(args)).output.code, "TRIAL_POLICY_INVALID");
  const ledger = new ResearchLedger(env.directory); assert.equal(ledger.run(pair.output.incumbent_run_id).attempts, 0); ledger.close();
});
test("CLI rejects unknown pair references without private errors", async () => {
  const env = fixture(); const status = await env.call(env.args("method-pair-status", "--pair-id", "absent"));
  assert.equal(status.exitCode, 1); assert.equal(status.output.code, "METHOD_TRIAL_REFERENCE_MISSING");
});
test("CLI resume retains one exact operator decision without disclosing its reason", async () => {
  const env = fixture(); const pair = await env.call(env.args("method-enqueue", "--input", env.requestFile));
  const ledger = new ResearchLedger(env.directory, { clock: env.clock });
  ledger.gateRun(ledger.claimMethodTrial(pair.output.incumbent_run_id, "worker", 1000), "METHOD_TRIAL_CONSENT_REQUIRED"); ledger.close();
  const decision = { run_id: pair.output.incumbent_run_id, decision_id: "cli-resume", reason: "SECRET_PRIVATE_RESUME_REASON" };
  const path = env.save("resume.json", decision);
  const first = await env.call(env.args("method-resume", "--input", path)); assert.equal(first.output.status, "queued"); assert.equal(first.output.reused, false);
  const second = await env.call(env.args("method-resume", "--input", path)); assert.equal(second.output.reused, true);
  const changed = env.save("resume-changed.json", { ...decision, reason: "Different private reason." });
  assert.equal((await env.call(env.args("method-resume", "--input", changed))).output.code, "METHOD_TRIAL_RESUME_CONFLICT");
  assert.doesNotMatch(env.outputs.join(""), /SECRET_PRIVATE_RESUME_REASON|Different private reason/);
});
