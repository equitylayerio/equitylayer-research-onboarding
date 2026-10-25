import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { contentHash } from "../client/local/run-contract.mjs";
import { executeClaimedRun, validateCallerResponse } from "../client/local/executor.mjs";
import { runLocal } from "../client/local-cli.mjs";
import { createNativeResearchRuntime, parseNativeResearchOutput, buildNativeResearchPrompt, NATIVE_RESULT_SCHEMA, NATIVE_GUIDANCE_SHA256 } from "../client/local/native-runtime.mjs";
import { setup, policy, scope, estimate } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";

const fields = () => ({ result_state: "SOURCE_NEEDED", summary: "Synthetic gap.", sources: [], drivers: [], falsifiers: [], unknowns: ["Missing evidence."], next_check_at: "2026-10-12T00:00:00Z" });
function environment(t, mode = "claude", extra = {}, sourceOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "el-native-test-"));
  const executable = join(root, mode);
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL("./helpers/synthetic-native-cli.mjs", import.meta.url)), { mode: 0o700 });
  const now = Date.parse("2026-10-11T00:00:02Z");
  const ledger = new ResearchLedger(join(root, "workspace"), { clock: () => now });
  const envelope = setup(ledger); ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), ...sourceOverrides });
  ledger.enqueue(envelope, "test-window", policy()); const lease = ledger.claim("synthetic-native", 10000);
  const context = sourceOverrides.rights_status === "HOLD" ? null : ledger.executionContext(lease);
  const input = context ? { schema_version: 1, context_sha256: context.sha256, research_context: context.payload, agent_fields_contract: { response: "Seven fields." } } : null;
  const config = { allow_native_research: true, provider: mode.includes("codex") ? "codex" : "claude-code", executable,
    model: "caller-selected-model", cli_version: mode.includes("codex") ? "0.144.5" : "2.1.150", env: { HOME: root }, timeout_ms: 2000, ...extra };
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { config, input, ledger, lease, now };
}
const claude = (changes = {}) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, structured_output: fields(),
  permission_denials: [], total_cost_usd: 0.000004, modelUsage: { selected: { inputTokens: 7, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 } }, ...changes });
const codex = (items = []) => [...items, { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(fields()) } },
  { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 5 } }].map(item => JSON.stringify(item)).join("\n");

test("native runtime requires explicit consent and exact configuration", t => {
  const { config } = environment(t);
  assert.throws(() => createNativeResearchRuntime({ ...config, allow_native_research: false }), { code: "NATIVE_CONSENT_REQUIRED" });
  for (const patch of [{ executable: "claude" }, { model: "--model" }, { extra: true }, { provider: "unknown" }, { cli_version: "latest" },
    { env: {} }, { env: { HOME: "relative" } }, { env: { HOME: config.env.HOME, CODEX_HOME: "relative" } },
    { env: { EVIL_STARTUP: "script" } }, { timeout_ms: 0 }]) assert.throws(() => createNativeResearchRuntime({ ...config, ...patch }), { code: "NATIVE_CONFIG_INVALID" });
});

function launchFailureFixture(config, stderr, { stdout = "", exit = 2, split = false } = {}) {
  const version = config.provider === "codex" ? "codex-cli 0.144.5" : "2.1.150 (Claude Code)";
  const features = ["shell_tool", "unified_exec", "hooks", "plugins", "apps", "browser_use", "browser_use_external",
    "browser_use_full_cdp_access", "computer_use", "in_app_browser", "image_generation", "multi_agent", "code_mode_host"];
  writeFileSync(config.executable, `#!${process.execPath}\n
import process from 'node:process';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log(${JSON.stringify(version)});
else if (args[0] === 'features') for (const feature of ${JSON.stringify(features)}) console.log(feature+' stable true');
else {
  for await (const chunk of process.stdin) {}
  process.stdout.write(${JSON.stringify(stdout)});
  const text = ${JSON.stringify(stderr)};
  if (${split}) { process.stderr.write(text.slice(0, 17)); await new Promise(resolve => setTimeout(resolve, 20)); process.stderr.write(text.slice(17)); }
  else process.stderr.write(text);
  process.exitCode = ${exit};
}`, { mode: 0o700 });
}
const argumentFailure = "error: unexpected argument '--synthetic-flag' found\n\nUsage: codex exec [OPTIONS] [PROMPT] [COMMAND]\n\nFor more information, try '--help'.\n";

for (const split of [false, true]) test(`Codex parser stderr retains only a fixed reported code with split=${split}`, async t => {
  const { config, input } = environment(t, "codex-launch-parser"); launchFailureFixture(config, argumentFailure, { split });
  await assert.rejects(createNativeResearchRuntime(config).execute(input), error => {
    assert.equal(error.code, "NATIVE_ARGUMENT_ERROR_REPORTED");
    assert.doesNotMatch(error.message, /synthetic-flag|Usage:|stderr|PRIVATE_SENTINEL/); return true;
  });
});
test("a parser failure after dispatch preserves unknown usage, no result, and the full budget hold", async t => {
  const { config, ledger, lease, now } = environment(t, "codex-launch-parser"); launchFailureFixture(config, argumentFailure);
  const outcome = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true, estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
  assert.equal(outcome.code, "USAGE_UNKNOWN");
  assert.equal(ledger.workspaceStatus().gates[0].execution_failure.failure_code, "NATIVE_ARGUMENT_ERROR_REPORTED");
  assert.equal(ledger.requests(lease.run_id)[0].status, "unknown"); assert.equal(ledger.inbox().length, 0);
  assert.equal(ledger.budget(scope().watch_id, "test-window").reserved.cost_microusd, estimate().cost_microusd);
  assert.equal(ledger.claim("no-retry"), null);
});
for (const stderr of ["PRIVATE_SENTINEL", "error: unexpected argument '--synthetic-flag' found\nPRIVATE_SENTINEL",
  argumentFailure.replace("'--synthetic-flag'", "'PRIVATE_SENTINEL'"), argumentFailure.replace("error:", "source says error:"),
  argumentFailure.replace("codex exec", "other-command"), "\u001b[31m" + argumentFailure]) {
  test(`unrecognized parser stderr does not become a cause: ${JSON.stringify(stderr.slice(0, 25))}`, async t => {
    const { config, input } = environment(t, "codex-launch-other"); launchFailureFixture(config, stderr);
    await assert.rejects(createNativeResearchRuntime(config).execute(input), { code: "NATIVE_COMMAND_FAILED" });
  });
}
test("stdout events and stderr overflow retain their stronger failure boundaries", async t => {
  const { config, input } = environment(t, "codex-launch-other");
  launchFailureFixture(config, argumentFailure, { stdout: JSON.stringify({ type: "turn.failed", error: { message: "PRIVATE_SENTINEL" } }) });
  await assert.rejects(createNativeResearchRuntime(config).execute(input), { code: "NATIVE_TURN_FAILED_REPORTED" });
  launchFailureFixture(config, argumentFailure, { stdout: "PRIVATE_SENTINEL" });
  await assert.rejects(createNativeResearchRuntime(config).execute(input), { code: "NATIVE_COMMAND_FAILED" });
  launchFailureFixture(config, argumentFailure.repeat(10));
  await assert.rejects(createNativeResearchRuntime({ ...config, max_stderr_bytes: 100 }).execute(input), { code: "NATIVE_STDERR_LIMIT" });
});
test("parser-like stderr on a zero exit is not a successful research result or a reported parser failure", async t => {
  const { config, input } = environment(t, "codex-launch-other"); launchFailureFixture(config, argumentFailure, { exit: 0 });
  await assert.rejects(createNativeResearchRuntime(config).execute(input), { code: "NATIVE_OUTPUT_INVALID" });
});
test("Codex parser text does not classify a Claude failure or a management command", async t => {
  const { config, input } = environment(t); launchFailureFixture(config, argumentFailure);
  await assert.rejects(createNativeResearchRuntime(config).execute(input), { code: "NATIVE_COMMAND_FAILED" });
  const codexFixture = environment(t, "codex-management-parser");
  writeFileSync(codexFixture.config.executable, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(argumentFailure)}); process.exitCode=2;`, { mode: 0o700 });
  await assert.rejects(createNativeResearchRuntime(codexFixture.config).inspect(), { code: "NATIVE_COMMAND_FAILED" });
});
for (const mode of ["missing", "denied"]) test(`an OS ${mode} executable gates before any request reservation`, { skip: process.platform === "win32" }, async t => {
  const { config, ledger, lease, now } = environment(t);
  if (mode === "missing") config.executable += "-not-present"; else chmodSync(config.executable, 0o600);
  const outcome = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true, estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
  const code = mode === "missing" ? "NATIVE_EXECUTABLE_MISSING" : "NATIVE_EXECUTABLE_DENIED";
  assert.equal(outcome.code, code); assert.equal(ledger.requests(lease.run_id).length, 0);
  assert.equal(ledger.workspaceStatus().gates[0].execution_failure.failure_code, code);
  assert.equal(ledger.workspaceStatus().gates[0].execution_failure.dispatch_state, "none");
  assert.equal(ledger.budget(scope().watch_id, "test-window").reserved.cost_microusd, 0);
  assert.equal(ledger.inbox().length, 0);
});

test("Codex accepts bounded exact preview identifiers, not channel aliases or command text", t => {
  const { config } = environment(t, "codex");
  for (const cli_version of ["0.162.0-alpha.17.2", "0.162.0-beta.1", "0.162.0-rc.1+desktop.2", "0.162.0+desktop.2"]) {
    assert.doesNotThrow(() => createNativeResearchRuntime({ ...config, cli_version }));
  }
  for (const cli_version of ["alpha", "latest", "0.162.0-", "0.162.0-alpha..1", "0.162.0+", "0.162.0+a..b",
    "0.162.0-alpha.1 extra", "0.162.0-alpha.1\n", "0.162.0-alpha/1", "0.162.0-alpha$(id)", "0.162.0-" + "x".repeat(32)]) {
    assert.throws(() => createNativeResearchRuntime({ ...config, cli_version }), { code: "NATIVE_CONFIG_INVALID" });
  }
  assert.throws(() => createNativeResearchRuntime({ ...config, provider: "claude-code", cli_version: "2.1.150-alpha.1" }),
    { code: "NATIVE_CONFIG_INVALID" });
});
test("Claude cost controls reject incomplete, unbounded, or unsupported configurations", t => {
  const { config } = environment(t);
  const bounds = { max_budget_microusd: 150000, max_output_tokens: 800, max_turns: 2 };
  const configured = { ...config, cli_version: "2.1.217", claude_limits: bounds };
  for (const patch of [{ max_budget_microusd: 0 }, { max_budget_microusd: 100_000_001 }, { max_budget_microusd: 1.5 },
    { max_output_tokens: 0 }, { max_output_tokens: 32001 }, { max_turns: 0 }, { max_turns: 7 }, { extra: true }]) {
    assert.throws(() => createNativeResearchRuntime({ ...configured, claude_limits: { ...bounds, ...patch } }), { code: "NATIVE_CONFIG_INVALID" });
  }
  assert.throws(() => createNativeResearchRuntime({ ...configured, claude_limits: { max_turns: 2 } }), { code: "NATIVE_CONFIG_INVALID" });
  assert.throws(() => createNativeResearchRuntime({ ...configured, provider: "codex" }), { code: "NATIVE_CONFIG_INVALID" });
  assert.doesNotThrow(() => createNativeResearchRuntime({ ...config, claude_limits: bounds }));
  assert.notEqual(createNativeResearchRuntime(configured).config_sha256,
    createNativeResearchRuntime({ ...configured, claude_limits: { ...bounds, max_turns: 1 } }).config_sha256);
});
test("Claude cost controls require advertised flags, not a guessed minimum version", async t => {
  const { config } = environment(t, "claude-no-cost-controls", {
    claude_limits: { max_budget_microusd: 150000, max_output_tokens: 800, max_turns: 2 } });
  await assert.rejects(createNativeResearchRuntime(config).inspect(), { code: "NATIVE_COST_CONTROL_UNVERIFIED" });
});
test("similarly named flags cannot satisfy the exact Claude control check", async t => {
  const { config, input } = environment(t, "claude-near-cost-controls", {
    claude_limits: { max_budget_microusd: 150000, max_output_tokens: 800, max_turns: 2 } });
  await assert.rejects(createNativeResearchRuntime(config).execute(input), { code: "NATIVE_COST_CONTROL_UNVERIFIED" });
});
test("a documented hidden turn flag does not require a help listing", async t => {
  const { config, input } = environment(t, "claude-budget-only", {
    claude_limits: { max_budget_microusd: 150000, max_output_tokens: 800, max_turns: 2 } });
  assert.equal((await createNativeResearchRuntime(config).inspect()).cost_control, "client_estimate_only");
  assert.equal((await createNativeResearchRuntime(config).execute(input)).agent_fields.result_state, "SOURCE_NEEDED");
});
test("native configuration is detached before cost controls are validated", t => {
  const { config } = environment(t); let reads = 0;
  Object.defineProperty(config, "claude_limits", { enumerable: true, get() {
    reads++; return { max_budget_microusd: reads === 1 ? 150000 : 100_000_001, max_output_tokens: 800, max_turns: 2 };
  } });
  assert.doesNotThrow(() => createNativeResearchRuntime(config)); assert.equal(reads, 1);
});
test("synthetic Claude receives cost, token, turn, and retry controls only for the invocation", async t => {
  const { config, input } = environment(t, "claude-bounded", { cli_version: "2.1.217",
    claude_limits: { max_budget_microusd: 150000, max_output_tokens: 800, max_turns: 2 } });
  const envBefore = { ...config.env }, runtime = createNativeResearchRuntime(config);
  const inspection = await runtime.inspect();
  assert.equal(inspection.cost_control, "client_estimate_only"); assert.equal(inspection.billing_ceiling_verified, false);
  assert.equal((await runtime.execute(input)).agent_fields.result_state, "SOURCE_NEEDED");
  assert.deepEqual(config.env, envBefore);
});
test("shared guidance and schema are pinned without rewriting the executor input", t => {
  const { config, input } = environment(t); const before = JSON.stringify(input);
  const prompt = buildNativeResearchPrompt(input);
  assert.match(prompt, /higher-grade material/); assert.match(prompt, /counterevidence/); assert.match(prompt, /No external tool is available/);
  assert.equal(JSON.stringify(input), before); assert.match(NATIVE_GUIDANCE_SHA256, /^[a-f0-9]{64}$/);
  assert.throws(() => NATIVE_RESULT_SCHEMA.required.push("usage"), TypeError);
  const runtime = createNativeResearchRuntime(config); config.env.HOME = "/different";
  assert.notEqual(runtime.config_sha256, createNativeResearchRuntime(config).config_sha256);
});
test("input corruption fails before process execution", t => {
  const { input } = environment(t); input.research_context.private_context.question = "Changed";
  assert.throws(() => buildNativeResearchPrompt(input), { code: "NATIVE_INPUT_INVALID" });
});
test("Claude usage comes from provider metadata, not generated research", t => {
  const { input } = environment(t);
  assert.deepEqual(parseNativeResearchOutput("claude-code", JSON.stringify(claude()), input).usage, { tokens: 17, cost_microusd: 4 });
  assert.equal(parseNativeResearchOutput("claude-code", JSON.stringify(claude({ modelUsage: {} })), input).usage, null);
  assert.equal(parseNativeResearchOutput("claude-code", JSON.stringify(claude({ total_cost_usd: -1 })), input).usage, null);
});
test("Codex token counts do not establish a measured dollar cost", t => {
  const { input } = environment(t);
  assert.equal(parseNativeResearchOutput("codex", codex(), input).usage, null);
});

for (const [type, code] of [["turn.failed", "NATIVE_TURN_FAILED_REPORTED"], ["error", "NATIVE_CALLER_ERROR_REPORTED"]]) {
  test(`Codex ${type} retains a fixed failure without guessing its cause`, t => {
    const { input } = environment(t);
    const terminal = type === "turn.failed" ? { type, error: { message: "PRIVATE_SENTINEL OAuth model MCP" } } : { type, message: "PRIVATE_SENTINEL OAuth model MCP" };
    const text = [{ type: "thread.started", thread_id: "synthetic" }, { type: "turn.started" }, terminal].map(row => JSON.stringify(row)).join("\n");
    assert.throws(() => parseNativeResearchOutput("codex", text, input), error => {
      assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|OAuth|MCP/); return true;
    });
  });
}

test("Codex source text, malformed events and mixed outcomes cannot spoof a failure category", t => {
  const { input } = environment(t);
  for (const events of [
    [{ type: "turn.failed", error: { message: 1 } }],
    [{ type: "turn.failed", error: { message: "" } }],
    [{ type: "turn.failed", error: { message: "x".repeat(16001) } }],
    [{ type: "turn.failed", error: "PRIVATE_SENTINEL" }],
    [{ type: "turn.failed", error: { message: "one" } }, { type: "turn.failed", error: { message: "two" } }],
    [{ type: "turn.completed" }, { type: "turn.failed", error: { message: "one" } }],
    [{ type: "turn.failed", error: { message: "one" } }, { type: "turn.completed" }],
    [{ type: "error", message: "PRIVATE_SENTINEL" }, { type: "turn.completed" }],
    [{ type: "error", message: "PRIVATE_SENTINEL" }, null],
    [{ type: "error", message: 42 }, { type: "turn.failed", error: { message: "one" } }],
    [{ type: "item.completed", item: null }, { type: "turn.failed", error: { message: "one" } }],
    [{ type: "thread.started", thread_id: 42 }, { type: "error", message: "one" }],
    [{ type: "item.completed", item: { id: "one", type: "agent_message", text: 42 } }, { type: "error", message: "one" }],
    [{ type: "turn.started", message: "unexpected" }, { type: "error", message: "one" }],
    [{ type: "unknown", message: "authentication_error PRIVATE_SENTINEL" }]
  ]) assert.throws(() => parseNativeResearchOutput("codex", events.map(row => JSON.stringify(row)).join("\n"), input), { code: "NATIVE_OUTPUT_INVALID" });
  const text = codex([{ type: "item.completed", item: { type: "agent_message", text: "turn.failed authentication_error PRIVATE_SENTINEL" } }]);
  assert.equal(parseNativeResearchOutput("codex", text, input).agent_fields.result_state, "SOURCE_NEEDED");
});

test("a real synthetic Codex process preserves failed-turn accounting and never delivers", async t => {
  const { config, input, ledger, lease, now } = environment(t, "codex-failed-turn");
  const source = `#!${process.execPath}\nimport { readFileSync } from 'node:fs';\nif(process.argv.includes('--version')) console.log('codex-cli 0.144.5');\nelse if(process.argv[2]==='features') for(const name of ['shell_tool','unified_exec','hooks','plugins','apps','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','in_app_browser','image_generation','multi_agent','code_mode_host']) console.log(name+' stable true');\nelse { for await (const chunk of process.stdin) {} console.log(JSON.stringify({type:'turn.started'})); console.log(JSON.stringify({type:'turn.failed',error:{message:'PRIVATE_SENTINEL'}})); process.exitCode=1; }`;
  writeFileSync(config.executable, source, { mode: 0o700 });
  await assert.rejects(createNativeResearchRuntime(config).execute(input), { code: "NATIVE_TURN_FAILED_REPORTED" });
  const outcome = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true, estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
  assert.equal(outcome.code, "USAGE_UNKNOWN");
  assert.equal(ledger.workspaceStatus().gates[0].execution_failure.failure_code, "NATIVE_TURN_FAILED_REPORTED");
  assert.equal(ledger.requests(lease.run_id)[0].status, "unknown"); assert.equal(ledger.claim("no-retry"), null);
  assert.equal(ledger.inbox().length, 0); assert.equal(ledger.budget(scope().watch_id, "test-window").reserved.cost_microusd, estimate().cost_microusd);
});
test("failed authentication and denied actions never become successful research", t => {
  const { input } = environment(t);
  for (const changes of [{ is_error: true, result: "PRIVATE_SENTINEL OAuth expired" }, { subtype: "error_max_turns" },
    { permission_denials: [{ tool: "Bash" }] }, { num_turns: 7 }]) {
    assert.throws(() => parseNativeResearchOutput("claude-code", JSON.stringify(claude(changes)), input), error => {
      assert.equal(error.code, "NATIVE_OUTPUT_INVALID");
      assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/); return true;
    });
  }
});

const errorSubtypes = [
  ["turn", "error_max_turns", "NATIVE_TURN_LIMIT_REPORTED"],
  ["budget", "error_max_budget_usd", "NATIVE_BUDGET_LIMIT_REPORTED"],
  ["execution", "error_during_execution", "NATIVE_EXECUTION_ERROR_REPORTED"],
  ["structured", "error_max_structured_output_retries", "NATIVE_STRUCTURE_LIMIT_REPORTED"]
];
for (const [mode, subtype, code] of errorSubtypes) test(`nonzero ${mode} terminal retains its safe classification`, async t => {
  const { config, input } = environment(t, `claude-failure-${mode}`);
  await assert.rejects(createNativeResearchRuntime(config).execute(input), error => {
    assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|provider detail/); return true;
  });
  assert.throws(() => parseNativeResearchOutput("claude-code", JSON.stringify({ type: "result", subtype,
    is_error: true, num_turns: 1, errors: ["PRIVATE_SENTINEL"] }), input), error => {
    assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/); return true;
  });
});

test("structured API errors expose a fixed reported category, not provider messages", t => {
  const { input } = environment(t);
  for (const [type, code] of [["authentication_error", "NATIVE_AUTH_ERROR_REPORTED"], ["permission_error", "NATIVE_PERMISSION_ERROR_REPORTED"],
    ["not_found_error", "NATIVE_RESOURCE_ERROR_REPORTED"], ["rate_limit_error", "NATIVE_RATE_LIMIT_REPORTED"],
    ["overloaded_error", "NATIVE_OVERLOAD_REPORTED"], ["invalid_request_error", "NATIVE_REQUEST_ERROR_REPORTED"], ["api_error", "NATIVE_API_ERROR_REPORTED"]]) {
    assert.throws(() => parseNativeResearchOutput("claude-code", JSON.stringify({ type: "error", error: { type, message: "PRIVATE_SENTINEL" } }), input), error => {
      assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/); return true;
    });
  }
});

test("malformed, unknown and source-field error text cannot spoof a reported category", t => {
  const { input } = environment(t);
  for (const terminal of [
    { type: "result", subtype: "error_max_turns", is_error: false, num_turns: 1 },
    { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 7, errors: [] },
    { type: "result", subtype: "SECRET_CODE", is_error: true, num_turns: 1, errors: [] },
    { type: "result", subtype: { toString: "PRIVATE_SENTINEL" }, is_error: true, num_turns: 1, errors: [] },
    { type: "error", error: { type: "SECRET_CODE" } },
    { type: "error", error: { type: { toString: "PRIVATE_SENTINEL" } } },
    { type: "error", error: { message: "authentication_error PRIVATE_SENTINEL" } }
  ]) assert.throws(() => parseNativeResearchOutput("claude-code", JSON.stringify(terminal), input), { code: "NATIVE_OUTPUT_INVALID" });
  const terminal = claude({ structured_output: { ...fields(), summary: "authentication_error PRIVATE_SENTINEL" } });
  assert.equal(parseNativeResearchOutput("claude-code", JSON.stringify(terminal), input).agent_fields.summary, terminal.structured_output.summary);
});

test("reported native limits retain unknown accounting and never become deliveries", async t => {
  const { config, ledger, lease, now } = environment(t, "claude-failure-budget");
  const before = ledger.budget(scope().watch_id, "test-window");
  const result = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true, estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
  assert.equal(result.code, "USAGE_UNKNOWN");
  const diagnostic = ledger.workspaceStatus().gates[0].execution_failure;
  assert.equal(diagnostic.failure_code, "NATIVE_BUDGET_LIMIT_REPORTED");
  assert.equal(ledger.requests(lease.run_id)[0].status, "unknown");
  assert.equal(ledger.budget(scope().watch_id, "test-window").reserved.cost_microusd, estimate().cost_microusd);
  assert.equal(ledger.budget(scope().watch_id, "test-window").spent.cost_microusd, before.spent.cost_microusd);
  assert.equal(ledger.inbox().length, 0); assert.equal(ledger.claim("must-not-retry"), null);
  assert.equal(ledger.requestReceipts(diagnostic.request_id).length, 0);
  const reopened = new ResearchLedger(ledger.directory, { clock: () => now });
  try { reopened.verifyIntegrity(); assert.equal(reopened.workspaceStatus().gates[0].execution_failure.failure_code, diagnostic.failure_code); }
  finally { reopened.close(); }
});
test("missing structured fields retain known usage as an invalid JSON-safe receipt", t => {
  const { input } = environment(t);
  const response = parseNativeResearchOutput("claude-code", JSON.stringify(claude({ structured_output: undefined })), input);
  assert.equal(response.agent_fields, null); assert.deepEqual(response.usage, { tokens: 17, cost_microusd: 4 });
  assert.throws(() => validateCallerResponse(response, input.research_context, input.context_sha256), { code: "AGENT_FIELDS_INVALID" });
});
test("existing validator rejects invented sources, extra fields, advice, and bad periods", t => {
  const { input } = environment(t);
  for (const patch of [{ usage: { tokens: 0 } }, { summary: "Buy now." }, { next_check_at: "2026-01-01T00:00:00Z" },
    { result_state: "NO_NEW_EVIDENCE", sources: [] }, { sources: [{ url: "https://evil.test/", date: "2026-10-11", kind: "reported_fact", claim: "Unretained" }] }]) {
    const response = parseNativeResearchOutput("claude-code", JSON.stringify(claude({ structured_output: { ...fields(), ...patch } })), input);
    assert.throws(() => validateCallerResponse(response, input.research_context, input.context_sha256));
    assert.deepEqual(response.usage, { tokens: 17, cost_microusd: 4 });
  }
});
test("Codex errors, tool traces, and duplicate completion fail closed", t => {
  const { input } = environment(t);
  for (const prefix of [[{ type: "turn.failed" }], [{ type: "item.completed", item: { type: "command_execution" } }], [{ type: "turn.completed" }]])
    assert.throws(() => parseNativeResearchOutput("codex", codex(prefix), input), { code: "NATIVE_OUTPUT_INVALID" });
});
for (const mode of ["claude", "codex"]) test(`synthetic ${mode} process returns bounded structured research`, async t => {
  const { config, input } = environment(t, mode);
  const response = await createNativeResearchRuntime(config).execute(input);
  assert.equal(response.agent_fields.result_state, "SOURCE_NEEDED");
  assert.equal(response.usage === null, mode === "codex");
});
test("synthetic native output enters the existing durable Inbox without acceptance", async t => {
  const { config, ledger, lease, now } = environment(t);
  const output = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true, estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now,
    timeout_ms: 5000, lease_ms: 10000, heartbeat_ms: 1000 });
  assert.equal(output.status, "completed"); assert.equal(ledger.inbox().length, 1);
  assert.equal(ledger.inbox()[0].result.result_state, "SOURCE_NEEDED");
  assert.equal(ledger.reviews(scope().watch_id).length, 0);
});
test("the local CLI accepts a private native runtime without manual result-file import", async t => {
  const { config, ledger, lease, now } = environment(t);
  // Release the fixture's lease before exercising the actual CLI claim path.
  ledger.retryRun(lease, now);
  const file = join(mkdtempSync(join(tmpdir(), "el-native-config-test-")), "runtime.json");
  t.after(() => rmSync(file.substring(0, file.lastIndexOf("/")), { recursive: true, force: true }));
  writeFileSync(file, JSON.stringify({ native: config, execution: { estimate: { ...estimate(), wall_ms: 5000 }, timeout_ms: 5000, lease_ms: 10000 } }), { mode: 0o600 });
  const out = await runLocal(["run", "--workspace", ledger.directory, "--runtime", file, "--allow-private-context", "--allow-candidate-method"], {
    clock: () => now, stdout: () => {} });
  assert.equal(out.output.status, "completed"); assert.equal(ledger.inbox().length, 1);
});
test("unknown Codex cost keeps the accounting gate and does not deliver to Inbox", async t => {
  const { config, ledger, lease, now } = environment(t, "codex");
  const out = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true, estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
  assert.equal(out.status, "gated"); assert.equal(out.code, "USAGE_UNKNOWN"); assert.equal(ledger.inbox().length, 0);
});
test("invalid native research retains measured usage without delivery or another request", async t => {
  const { config, ledger, lease, now } = environment(t, "claude-advice");
  const runtime = createNativeResearchRuntime(config);
  const options = { allow_private_context: true, allow_candidate_method: true, estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 };
  const out = await executeClaimedRun(ledger, lease, runtime, options);
  assert.equal(out.code, "RESEARCH_ADVICE_BLOCKED"); assert.equal(ledger.inbox().length, 0);
  const requests = ledger.requests(lease.run_id);
  assert.equal(requests.length, 1); assert.equal(requests[0].status, "settled");
  assert.equal(requests[0].usage.tokens, 17); assert.equal(requests[0].usage.cost_microusd, 4);
});
test("source HOLD prevents any native request reservation", async t => {
  const { config, ledger, lease, now } = environment(t, "claude", {}, { rights_status: "HOLD" });
  const out = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true, estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
  assert.equal(out.code, "SOURCE_RIGHTS_GATED"); assert.equal(ledger.requests(lease.run_id).length, 0);
});
test("native preflight cannot gate another controller's dispatched request", async t => {
  const { config, ledger, lease, now } = environment(t, "version");
  const request = ledger.reserveRequest(lease, "existing-in-flight-operation", estimate());
  ledger.markDispatched(lease, request.request_id);
  const second = new ResearchLedger(ledger.directory, { clock: () => now });
  try {
    const out = await executeClaimedRun(second, lease, createNativeResearchRuntime(config), {
      allow_private_context: true, allow_candidate_method: true,
      estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
    assert.equal(out.status, "busy");
    assert.equal(out.code, "EXECUTOR_BUSY");
    assert.equal(second.requests(lease.run_id)[0].status, "dispatched");
    assert.equal(second.run(lease.run_id).status, "running");
  } finally { second.close(); }
});
for (const [mode, expected, extra] of [
  ["version", "NATIVE_VERSION_CHANGED", {}],
  ["codex-capability", "NATIVE_CAPABILITY_UNVERIFIED", {}],
  ["claude-no-cost-controls", "NATIVE_COST_CONTROL_UNVERIFIED", {
    claude_limits: { max_budget_microusd: 150000, max_output_tokens: 800, max_turns: 2 } }],
]) test(`setup failure ${mode} gates before model reservation`, async t => {
  const { config, ledger, lease, now } = environment(t, mode, extra);
  const before = ledger.budget(scope().watch_id, "test-window");
  const out = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true,
    estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
  assert.equal(out.code, expected);
  assert.equal(ledger.requests(lease.run_id).length, 0);
  const after = ledger.budget(scope().watch_id, "test-window");
  assert.deepEqual(after.spent, before.spent);
  assert.deepEqual(after.reserved, before.reserved);
  const failure = ledger.workspaceStatus().gates[0].execution_failure;
  assert.equal(failure.failure_code, expected);
  assert.equal(failure.request_id, null);
  assert.equal(failure.dispatch_state, "none");
  assert.equal(ledger.inbox().length, 0);
  const reopened = new ResearchLedger(ledger.directory, { clock: () => now });
  try {
    reopened.verifyIntegrity();
    assert.equal(reopened.requests(lease.run_id).length, 0);
    assert.equal(reopened.workspaceStatus().gates[0].execution_failure.dispatch_state, "none");
  } finally { reopened.close(); }
});
test("native management timeout does not reserve a model request", async t => {
  const { config, ledger, lease, now } = environment(t, "claude-check-hang", { timeout_ms: 100 });
  const out = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true,
    estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
  assert.equal(out.code, "NATIVE_TIMEOUT");
  assert.equal(ledger.requests(lease.run_id).length, 0);
  assert.equal(ledger.workspaceStatus().gates[0].execution_failure.dispatch_state, "none");
  assert.equal(ledger.inbox().length, 0);
});
test("runtime drift after preflight preserves dispatched unknown usage", async t => {
  const { config, ledger, lease, now } = environment(t, "claude-drift");
  const out = await executeClaimedRun(ledger, lease, createNativeResearchRuntime(config), {
    allow_private_context: true, allow_candidate_method: true,
    estimate: { ...estimate(), wall_ms: 5000 }, clock: () => now, timeout_ms: 5000 });
  assert.equal(out.code, "USAGE_UNKNOWN");
  assert.equal(ledger.requests(lease.run_id)[0].status, "unknown");
  assert.equal(ledger.workspaceStatus().gates[0].execution_failure.failure_code, "NATIVE_VERSION_CHANGED");
  assert.equal(ledger.budget(scope().watch_id, "test-window").reserved.cost_microusd, estimate().cost_microusd);
  assert.equal(ledger.inbox().length, 0);
  assert.equal(ledger.claim("must-not-retry"), null);
});
for (const [mode, code, extra] of [["version", "NATIVE_VERSION_CHANGED", {}], ["codex-capability", "NATIVE_CAPABILITY_UNVERIFIED", {}],
  ["claude-hang", "NATIVE_TIMEOUT", { timeout_ms: 100 }], ["claude-stderr", "NATIVE_STDERR_LIMIT", { max_stderr_bytes: 100 }],
  ["claude-oversize", "NATIVE_OUTPUT_LIMIT", { max_output_bytes: 100 }]]) test(`${mode} has a named safe failure`, async t => {
  const { config, input } = environment(t, mode, extra);
  await assert.rejects(createNativeResearchRuntime(config).execute(input), error => {
    assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/); return true;
  });
});
test("cancellation and full-input limits stop native execution", async t => {
  const { config, input } = environment(t, "claude-hang"); const controller = new AbortController();
  const running = createNativeResearchRuntime(config).execute(input, { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(running, { code: "NATIVE_ABORTED" });
  await assert.rejects(createNativeResearchRuntime({ ...config, max_prompt_bytes: 10 }).execute(input), { code: "NATIVE_INPUT_LIMIT" });
});
test("successful completion removes a TERM-resistant same-group descendant", { skip: process.platform === "win32" }, async t => {
  const { config, input } = environment(t, "claude-success-tree");
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Own fixture can already be gone. */ } } });
  await createNativeResearchRuntime(config).execute(input);
  pid = Number(readFileSync(join(config.env.HOME, "native-child.pid"), "utf8"));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
