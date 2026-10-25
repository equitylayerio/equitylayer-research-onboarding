import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createLocalCommandRuntime } from "../client/local/command-runtime.mjs";

const fixture = fileURLToPath(new URL("./helpers/synthetic-command.mjs", import.meta.url));
const config = (mode = "known", extra = {}) => ({ allow_local_command: true, executable: process.execPath,
  args: [fixture, mode], identity: "synthetic-process-v1", timeout_ms: 2000, ...extra });
const run = (runtime, input = { synthetic: true }, signal) => runtime.execute(input, { request_id: "synthetic-request", signal });

test("local commands require explicit caller authorization", () => {
  assert.throws(() => createLocalCommandRuntime({ ...config(), allow_local_command: false }), { code: "COMMAND_CONSENT_REQUIRED" });
});
test("commands require an absolute executable and an argument array", () => {
  assert.throws(() => createLocalCommandRuntime({ ...config(), executable: "node" }), { code: "COMMAND_CONFIG_INVALID" });
  assert.throws(() => createLocalCommandRuntime({ ...config(), args: "--version" }), { code: "COMMAND_CONFIG_INVALID" });
});
test("commands return measured usage and immutable configuration identity", async () => {
  const original = config(); const runtime = createLocalCommandRuntime(original);
  original.args[1] = "fail";
  const response = await run(runtime);
  assert.deepEqual(response.usage, { tokens: 3, cost_microusd: 4 });
  assert.equal(runtime.config_sha256, createLocalCommandRuntime(config()).config_sha256);
  assert.notEqual(runtime.config_sha256, createLocalCommandRuntime(config("unknown")).config_sha256);
});
test("shell expressions remain literal arguments", async () => {
  const values = ["$(touch /tmp/SHOULD_NOT_EXIST)", "`id`", "; exit 9", "a b"];
  const response = await run(createLocalCommandRuntime(config("known", { args: [fixture, "known", ...values] })));
  assert.deepEqual(response.agent_fields.args, values);
});
test("commands receive private input only through JSON stdin", async () => {
  const response = await run(createLocalCommandRuntime(config()), { private_context: { question: "synthetic question" } });
  assert.deepEqual(response.agent_fields.input, { private_context: { question: "synthetic question" } });
});
test("commands do not inherit caller environment credentials", async () => {
  process.env.SYNTHETIC_SECRET = "synthetic";
  try { assert.equal((await run(createLocalCommandRuntime(config()))).agent_fields.has_key, false); }
  finally { delete process.env.SYNTHETIC_SECRET; }
});
for (const mode of ["unknown", "badusage"]) test(`${mode} usage remains unknown`, async () => {
  assert.equal((await run(createLocalCommandRuntime(config(mode)))).usage, null);
});
for (const mode of ["multiple", "invalid", "array", "missing"]) test(`${mode} command output is invalid`, async () => {
  await assert.rejects(run(createLocalCommandRuntime(config(mode))), { code: "COMMAND_OUTPUT_INVALID" });
});
test("oversized stdout stops the command", async () => {
  await assert.rejects(run(createLocalCommandRuntime(config("oversize", { max_output_bytes: 100 }))), { code: "COMMAND_OUTPUT_LIMIT" });
});
test("bounded stderr is discarded and never enters errors", async () => {
  await assert.rejects(run(createLocalCommandRuntime(config("stderr", { max_stderr_bytes: 100 }))), (error) => {
    assert.equal(error.code, "COMMAND_STDERR_LIMIT"); assert.doesNotMatch(error.message, /SECRET_SENTINEL/); return true;
  });
});
test("command failures return a fixed error without stderr", async () => {
  await assert.rejects(run(createLocalCommandRuntime(config("fail"))), (error) => {
    assert.equal(error.code, "COMMAND_FAILED"); assert.doesNotMatch(error.message, /SECRET_SENTINEL/); return true;
  });
});
test("timeout stops a synthetic child", async () => {
  await assert.rejects(run(createLocalCommandRuntime(config("hang", { timeout_ms: 40 }))), { code: "COMMAND_TIMEOUT" });
});
test("caller abort stops a synthetic child", async () => {
  const controller = new AbortController();
  const task = run(createLocalCommandRuntime(config("hang")), {}, controller.signal);
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(task, { code: "COMMAND_ABORTED" });
});
test("oversized input prevents dispatch", async () => {
  assert.throws(() => run(createLocalCommandRuntime(config("known", { max_input_bytes: 100 })), { text: "x".repeat(200) }), { code: "COMMAND_INPUT_LIMIT" });
});
test("missing executables return a fixed start error", async () => {
  await assert.rejects(run(createLocalCommandRuntime(config("known", { executable: "/synthetic/missing-command" }))), { code: "COMMAND_START_FAILED" });
});
