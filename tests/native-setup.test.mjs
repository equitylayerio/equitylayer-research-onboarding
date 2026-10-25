import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createNativeResearchRuntime } from "../client/local/native-runtime.mjs";
import { runLocal } from "../client/local-cli.mjs";

function completedCalls(file) {
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const end = text.lastIndexOf("\n");
  return end < 0 ? [] : text.slice(0, end).split("\n").map(line => JSON.parse(line));
}

function setup(t, mode = "claude", overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "el-native-setup-test-"));
  const executable = join(root, mode);
  const names = ["shell_tool", "unified_exec", "hooks", "plugins", "apps", "browser_use", "browser_use_external",
    "browser_use_full_cdp_access", "computer_use", "in_app_browser", "image_generation", "multi_agent", "code_mode_host"];
  writeFileSync(executable, `#!${process.execPath}\n` + `
import {appendFileSync} from 'node:fs';
import {basename} from 'node:path';
const mode=basename(process.argv[1]), args=process.argv.slice(2);
appendFileSync(process.env.HOME+'/calls.jsonl',JSON.stringify({args,cwd:process.cwd()})+'\\n');
if(mode.endsWith('-hang')) await new Promise(r=>setTimeout(r,60000));
if(mode.includes('oversize')) console.log('PRIVATE_SENTINEL'.repeat(1000));
else if(args.length===1 && args[0]==='--version') {
  console.log(mode.includes('changed')?'PRIVATE_SENTINEL':mode.includes('codex-preview')?'codex-cli 0.162.0-alpha.17.2':mode.includes('codex')?'codex-cli 0.144.5':'2.1.150 (Claude Code)');
} else if(args.join(' ')==='features list' && mode.includes('codex')) {
  for(const name of ${JSON.stringify(names)}) if(!mode.includes('missing') || name!=='shell_tool') console.log(name+' stable false');
} else process.exit(99);
`, { mode: 0o700 });
  const native = { allow_native_research: true, provider: mode.includes("codex") ? "codex" : "claude-code",
    executable, model: "caller-selected-model", cli_version: mode.includes("codex") ? "0.144.5" : "2.1.150",
    env: { HOME: root }, timeout_ms: 2000, ...overrides };
  const file = join(root, "runtime.json");
  writeFileSync(file, JSON.stringify({ native, execution: { estimate: { tokens: 100, cost_microusd: 100, wall_ms: 2000 } } }), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, native, file, calls: () => completedCalls(join(root, "calls.jsonl")) };
}

for (const [label, text, expected] of [
  ["an empty visible file", "", []],
  ["a partial first row", '{"args":["--version"]', []],
  ["a complete row followed by a partial row", '{"args":["--version"],"cwd":"synthetic"}\n{"args":',
    [{ args: ["--version"], cwd: "synthetic" }]]
]) test(`the native setup observer waits for complete JSONL rows: ${label}`, t => {
  const fixture = setup(t); writeFileSync(join(fixture.root, "calls.jsonl"), text);
  assert.deepEqual(fixture.calls(), expected);
});

test("the native setup observer still rejects malformed complete JSONL rows", t => {
  const fixture = setup(t); writeFileSync(join(fixture.root, "calls.jsonl"), '{"args":}\n');
  assert.throws(fixture.calls, SyntaxError);
});

for (const mode of ["claude", "codex"]) test(`${mode} setup runs management commands without research or acceptance`, async t => {
  const fixture = setup(t, mode);
  const runtime = createNativeResearchRuntime(fixture.native);
  const report = await runtime.inspect();
  assert.equal(report.config_sha256, runtime.config_sha256);
  assert.equal(report.version_check, "passed");
  assert.equal(report.authentication, "not_checked"); assert.equal(report.model_access, "not_checked");
  assert.equal(report.model_call_performed, false); assert.equal(report.inbox_delivery_verified, false);
  assert.equal(report.complete_source_documents, false); assert.equal(report.external_tools, false);
  assert.equal(report.accounting, mode === "codex" ? "cost_unavailable" : "provider_report_unverified");
  assert.deepEqual(fixture.calls().map(c => c.args), mode === "codex" ? [["--version"], ["features", "list"]] : [["--version"]]);
  assert.ok(fixture.calls().every(c => !existsSync(c.cwd)));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(fixture.root));
  assert.throws(() => { report.version_check = "changed"; }, TypeError);
});

test("Codex preview setup preserves the complete installed version without inference", async t => {
  const fixture = setup(t, "codex-preview", { cli_version: "0.162.0-alpha.17.2" });
  const runtime = createNativeResearchRuntime(fixture.native), report = await runtime.inspect();
  assert.equal(report.cli_version, "0.162.0-alpha.17.2");
  assert.equal(report.identity, "native:codex:0.162.0-alpha.17.2:caller-selected-model");
  assert.equal(report.model_call_performed, false);
  assert.equal(report.authentication, "not_checked");
  assert.equal(report.model_access, "not_checked");
  assert.equal(report.inbox_delivery_verified, false);
  assert.deepEqual(fixture.calls().map(call => call.args), [["--version"], ["features", "list"]]);
  assert.ok(fixture.calls().every(call => !existsSync(call.cwd)));
  assert.notEqual(runtime.config_sha256, createNativeResearchRuntime({ ...fixture.native, cli_version: "0.162.0-alpha.17.3" }).config_sha256);
});

test("Codex preview drift fails before feature inspection or inference", async t => {
  const fixture = setup(t, "codex-preview", { cli_version: "0.162.0-alpha.17.3" });
  await assert.rejects(createNativeResearchRuntime(fixture.native).inspect(), { code: "NATIVE_VERSION_CHANGED" });
  assert.deepEqual(fixture.calls().map(call => call.args), [["--version"]]);
  assert.ok(fixture.calls().every(call => !existsSync(call.cwd)));
});

for (const [mode, code, overrides] of [["changed", "NATIVE_VERSION_CHANGED", {}], ["codex-missing", "NATIVE_CAPABILITY_UNVERIFIED", {}],
  ["claude-hang", "NATIVE_TIMEOUT", { timeout_ms: 150 }], ["claude-oversize", "NATIVE_OUTPUT_LIMIT", { max_output_bytes: 100 }]]) {
  test(`${mode} setup fails before model invocation with a safe code`, async t => {
    const fixture = setup(t, mode, overrides);
    await assert.rejects(createNativeResearchRuntime(fixture.native).inspect(), error => {
      assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/); return true;
    });
    assert.ok(fixture.calls().every(c => ["--version", "features list"].includes(c.args.join(" "))));
    assert.ok(fixture.calls().every(c => !existsSync(c.cwd)));
  });
}

test("setup cancellation prevents any process or terminates an in-flight check", { timeout: 5000 }, async t => {
  const fixture = setup(t, "claude-hang"); const runtime = createNativeResearchRuntime(fixture.native);
  const stopped = new AbortController(); stopped.abort();
  const controller = new AbortController();
  const originalSpawn = childProcess.spawn;
  let owned, closed, started = false, observed, spawnCount = 0;
  try {
    childProcess.spawn = (...args) => {
      assert.equal(args[0], fixture.native.executable); assert.deepEqual(args[1], ["--version"]);
      spawnCount++;
      observed = { args: args[1], cwd: args[2].cwd };
      owned = originalSpawn(...args);
      closed = new Promise(resolve => owned.once("close", resolve));
      owned.once("spawn", () => { started = true; controller.abort(); });
      return owned;
    };
    syncBuiltinESMExports();
    await assert.rejects(runtime.inspect({ signal: stopped.signal }), { code: "NATIVE_ABORTED" });
    assert.equal(spawnCount, 0); assert.equal(existsSync(join(fixture.root, "calls.jsonl")), false);
    // Observe the actual spawn event, not a child-written file that can be partial or late.
    await assert.rejects(runtime.inspect({ signal: controller.signal }), { code: "NATIVE_ABORTED" });
    assert.equal(spawnCount, 1); assert.equal(started, true); assert.ok(Number.isSafeInteger(owned.pid) && owned.pid > 1);
    await closed;
    assert.throws(() => process.kill(process.platform === "win32" ? owned.pid : -owned.pid, 0), { code: "ESRCH" });
    assert.deepEqual(observed.args, ["--version"]); assert.equal(existsSync(observed.cwd), false);
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    if (closed) await closed;
  }
  assert.ok(fixture.calls().every(c => !existsSync(c.cwd)));
});

test("invalid cancellation objects fail before inspection or research can start a process", async t => {
  const fixture = setup(t); const runtime = createNativeResearchRuntime(fixture.native);
  for (const signal of [null, {}, { aborted: false }, Object.create(AbortSignal.prototype)]) {
    await assert.rejects(runtime.inspect({ signal }), { code: "NATIVE_SIGNAL_INVALID" });
    await assert.rejects(runtime.execute(null, { signal }), { code: "NATIVE_SIGNAL_INVALID" });
  }
  assert.equal(existsSync(join(fixture.root, "calls.jsonl")), false);
});

test("runtime-check needs explicit consent and a private native file, not a workspace", async t => {
  const fixture = setup(t);
  const call = args => runLocal(args, { stdout: () => {} });
  assert.equal((await call(["runtime-check", "--runtime", fixture.file])).output.code, "CLI_FLAGS_INVALID");
  assert.equal(existsSync(join(fixture.root, "calls.jsonl")), false);
  const report = await call(["runtime-check", "--runtime", fixture.file, "--allow-native-check"]);
  assert.equal(report.exitCode, 0); assert.equal(report.output.status, "configuration_checked");
  assert.equal(report.output.execution_authorized, false); assert.match(report.output.runtime_sha256, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(fixture.root, "research.sqlite")), false);
  assert.equal(fixture.calls().length, 1);
  chmodSync(fixture.file, 0o644);
  assert.equal((await call(["runtime-check", "--runtime", fixture.file, "--allow-native-check"])).output.code, "INPUT_FILE_UNSAFE");
  assert.equal(fixture.calls().length, 1);
});

test("generic commands cannot use the native check to invoke arbitrary runtime arguments", async t => {
  const fixture = setup(t);
  writeFileSync(fixture.file, JSON.stringify({ command: { allow_local_command: true, executable: fixture.native.executable,
    args: ["model-call"], identity: "synthetic-command" }, execution: { estimate: { tokens: 0, cost_microusd: 0, wall_ms: 2000 } } }), { mode: 0o600 });
  const result = await runLocal(["runtime-check", "--runtime", fixture.file, "--allow-native-check"], { stdout: () => {} });
  assert.equal(result.output.code, "NATIVE_CHECK_UNSUPPORTED");
  assert.equal(existsSync(join(fixture.root, "calls.jsonl")), false);
});
