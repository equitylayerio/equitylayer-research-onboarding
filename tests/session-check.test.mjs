import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readdirSync, chmodSync, symlinkSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { runSession, parseSessionArgs } from "../client/session-cli.mjs";
import { setup, scope } from "./fixtures/local-research.mjs";
import { eventFixture, sourcePolicy } from "./fixtures/source-events.mjs";
import { checkSessionConnection } from "../client/local/session-check.mjs";
import { canonicalJson } from "../client/local/run-contract.mjs";

const flags = ["--allow-private-context", "--allow-candidate-method"];
async function fixture(t, submission = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-session-check-"))), now = Date.now(), ledger = new ResearchLedger(root);
  const envelope = setup(ledger), raw = eventFixture(71);
  raw.artifact.retrieved_at = new Date(now - 1000).toISOString(); raw.event.observed_at = raw.artifact.retrieved_at;
  ledger.retainSource(raw.event, raw.artifact, raw.bytes); ledger.retainSourceFacts(raw.event.source_event_id, raw.facts);
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy()); ledger.close();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let output = "";
  await runSession(["prepare", "--workspace", root, "--watch", scope().watch_id, "--revision", "1", "--method", envelope.method.bundle_sha256,
    "--source-event", raw.event.source_event_id, ...flags, ...(submission ? ["--allow-external-submission"] : [])], { stdout: text => { output += text; } });
  const prepared = JSON.parse(output);
  return { root, prepared, args: ["check", "--workspace", root, "--context", prepared.context_id, ...flags,
    ...(submission ? ["--allow-external-submission"] : [])] };
}

test("session help describes a metadata-only connection check", async () => {
  let output = ""; await runSession(["--help"], { stdout: text => { output += text; } });
  assert.match(output, /session check/); assert.match(output, /does not read the private task/);
});

test("session check parses the fixed context and existing permissions", () => {
  const parsed = parseSessionArgs(["check", "--workspace", "/private/example", "--context", `el-session-context-${"a".repeat(64)}`, ...flags]);
  assert.equal(parsed.command, "check"); assert.equal(parsed.consent.allow_external_submission, false);
});

test("prepare supplies the exact installed check command without private task text", async t => {
  const f = await fixture(t);
  assert.equal(f.prepared.check_command.command, f.prepared.mcp_command.command);
  const expected = [...f.prepared.mcp_command.args]; expected[1] = "check";
  assert.deepEqual(f.prepared.check_command.args, expected);
  assert.doesNotMatch(JSON.stringify(f.prepared.check_command), /Synthetic local|private research question|artifact_sha256/);
});

test("prepare canonicalizes a trailing slash before generating the check command", async t => {
  const f = await fixture(t), ledger = new ResearchLedger(f.root);
  const method = setup(ledger).method.bundle_sha256; ledger.close();
  const prepared = await runSession(["prepare", "--workspace", f.root + "/", "--watch", scope().watch_id,
    "--revision", "1", "--method", method, ...flags], { stdout: () => {} });
  assert.equal(prepared.check_command.args[prepared.check_command.args.indexOf("--workspace") + 1], f.root);
  assert.equal((await runSession(prepared.check_command.args.slice(1), { stdout: () => {} })).status, "connection_ok");
});

function snapshot(root) {
  const db = new DatabaseSync(join(root, "research.sqlite"), { readOnly: true });
  try { return canonicalJson(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) =>
    [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value])))])); }
  finally { db.close(); }
}
const consent = submission => ({ allow_private_context: true, allow_candidate_method: true, allow_external_submission: submission });

for (const submission of [false, true]) test(`actual installed connection checks metadata only; submission=${submission}`, async t => {
  const f = await fixture(t, submission), before = snapshot(f.root);
  const first = await runSession(f.args, { stdout: () => {} }), second = await runSession(f.args, { stdout: () => {} });
  assert.deepEqual(first, second); assert.equal(first.status, "connection_ok");
  assert.equal(first.submission_tool_available, submission); assert.equal(first.tools.length, submission ? 3 : 2);
  for (const field of ["private_task_read", "source_access_checked", "model_checked", "research_checked", "result_submitted", "native_execution"]) assert.equal(first[field], false);
  assert.equal(snapshot(f.root), before);
});

test("unknown context returns a fixed error without disclosing the task", async t => {
  const f = await fixture(t), before = snapshot(f.root);
  await assert.rejects(checkSessionConnection(f.root, `el-session-context-${"b".repeat(64)}`, consent(false)), { code: "SESSION_CHECK_SERVER_FAILED" });
  assert.equal(snapshot(f.root), before);
});

test("check refuses an old schema without migration, backup, or spawn", async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.root, "research.sqlite")); db.exec("PRAGMA user_version=11"); db.close();
  const before = snapshot(f.root), files = readdirSync(f.root).sort(); let spawned = false;
  await assert.rejects(checkSessionConnection(f.root, f.prepared.context_id, consent(false), { spawnProcess() { spawned = true; } }), { code: "SESSION_CHECK_UPGRADE_REQUIRED" });
  assert.equal(spawned, false); assert.equal(snapshot(f.root), before); assert.deepEqual(readdirSync(f.root).sort(), files);
  assert.throws(() => new ResearchLedger(f.root, { allow_migration: false }), { code: "SCHEMA_UPGRADE_REQUIRED" });
  assert.equal(snapshot(f.root), before);
});

test("no-migration ledger does not initialize missing storage", async t => {
  const f = await fixture(t), missing = join(f.root, "missing");
  assert.throws(() => new ResearchLedger(missing, { allow_migration: false })); assert.equal(existsSync(missing), false);
});

test("check refuses unsafe permissions and symlink aliases before spawn", async t => {
  const f = await fixture(t), alias = join(f.root, "alias"); symlinkSync(f.root, alias);
  await assert.rejects(checkSessionConnection(alias, f.prepared.context_id, consent(false)), { code: "SESSION_CHECK_PATH_INVALID" });
  chmodSync(f.root, 0o755);
  await assert.rejects(checkSessionConnection(f.root, f.prepared.context_id, consent(false)), { code: "SESSION_CHECK_PATH_INVALID" });
  chmodSync(f.root, 0o700);
});

function fakeServer(context, change = () => {}, behavior = "normal") {
  const calls = [], child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("close", 1)); return true; }; child.unref = () => {};
  child.stdin.on("finish", () => { if (behavior === "normal") queueMicrotask(() => child.emit("close", 0)); });
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line); calls.push(request);
      if (!request.id || behavior === "silent") continue;
      const response = { jsonrpc: "2.0", id: request.id, result: request.id === 1 ? {
        protocolVersion: "2025-06-18", serverInfo: { name: "equitylayer-local-research" }, capabilities: { tools: {} }
      } : request.id === 2 ? { tools: ["get_research_task", "get_submission_status"].map(name => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })) }
        : { structuredContent: { context_id: context, state: "awaiting_submission", usage: "unverified", native_execution: false, accepted_evidence: false, accepted_interpretation: false } } };
      change(response, request);
      queueMicrotask(() => child.stdout.write(JSON.stringify(response) + "\n"));
    }
  });
  return { child, calls };
}

test("probe uses only the installed server, empty environment, and three metadata requests", async t => {
  const f = await fixture(t), fake = fakeServer(f.prepared.context_id); let invocation;
  await checkSessionConnection(f.root, f.prepared.context_id, consent(false), { spawnProcess(command, args, options) { invocation = { command, args, options }; return fake.child; } });
  assert.equal(invocation.command, process.execPath); assert.equal(invocation.args[0], f.prepared.mcp_command.args[0]);
  assert.ok(invocation.args.includes("--no-migrate")); assert.deepEqual(invocation.options.env, {}); assert.equal(invocation.options.shell, false);
  assert.deepEqual(fake.calls.map(row => row.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.equal(fake.calls.at(-1).params.name, "get_submission_status"); assert.doesNotMatch(JSON.stringify(fake.calls), /private research|submit_research/);
});

for (const [label, mutate, code] of [
  ["wrong response identity", row => { row.id = 99; }, "SESSION_CHECK_PROTOCOL_INVALID"],
  ["wrong protocol", (row, request) => { if (request.id === 1) row.result.protocolVersion = "unknown"; }, "SESSION_CHECK_PROTOCOL_INVALID"],
  ["missing tool", (row, request) => { if (request.id === 2) row.result.tools.pop(); }, "SESSION_CHECK_TOOLS_INVALID"],
  ["duplicate tool", (row, request) => { if (request.id === 2) row.result.tools[1] = row.result.tools[0]; }, "SESSION_CHECK_TOOLS_INVALID"],
  ["write annotation", (row, request) => { if (request.id === 2) row.result.tools[0].annotations.readOnlyHint = false; }, "SESSION_CHECK_TOOLS_INVALID"],
  ["wrong context", (row, request) => { if (request.id === 3) row.result.structuredContent.context_id = "other"; }, "SESSION_CHECK_STATUS_INVALID"],
  ["verified usage", (row, request) => { if (request.id === 3) row.result.structuredContent.usage = "verified"; }, "SESSION_CHECK_STATUS_INVALID"],
  ["native execution", (row, request) => { if (request.id === 3) row.result.structuredContent.native_execution = true; }, "SESSION_CHECK_STATUS_INVALID"]
]) test(`check rejects ${label}`, async t => {
  const f = await fixture(t), fake = fakeServer(f.prepared.context_id, mutate);
  await assert.rejects(checkSessionConnection(f.root, f.prepared.context_id, consent(false), { spawnProcess: () => fake.child }), { code });
});

test("timeout stops the child and emits no child diagnostics", async t => {
  const f = await fixture(t), fake = fakeServer(f.prepared.context_id, () => {}, "silent");
  fake.child.stderr.write("PRIVATE_CHILD_DIAGNOSTIC");
  await assert.rejects(checkSessionConnection(f.root, f.prepared.context_id, consent(false), { spawnProcess: () => fake.child, timeout_ms: 20 }), { code: "SESSION_CHECK_TIMEOUT" });
});

test("pre-aborted check never starts a process", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(); let spawned = false;
  await assert.rejects(checkSessionConnection(f.root, f.prepared.context_id, consent(false), { signal: controller.signal, spawnProcess() { spawned = true; } }), { code: "SESSION_CHECK_STOPPED" });
  assert.equal(spawned, false);
});

test("a spawn failure has a fixed code", async t => {
  const f = await fixture(t);
  await assert.rejects(checkSessionConnection(f.root, f.prepared.context_id, consent(false), { spawnProcess() { throw Error("PRIVATE_START_ERROR"); } }), { code: "SESSION_CHECK_START_FAILED" });
});

test("no-migrate is internal to serve, not accepted by prepare or check", () => {
  for (const command of ["prepare", "check"]) assert.throws(() => parseSessionArgs([command, "--workspace", "/private/example", "--no-migrate", ...flags]), { code: "SESSION_FLAGS_INVALID" });
});

for (const [label, bytes, code] of [
  ["invalid UTF-8", Buffer.from([0xff, 10]), "SESSION_CHECK_PROTOCOL_INVALID"],
  ["invalid JSON", Buffer.from("PRIVATE_NOT_JSON\n"), "SESSION_CHECK_PROTOCOL_INVALID"],
  ["oversized output", Buffer.alloc(64001, 65), "SESSION_CHECK_OUTPUT_LIMIT"]
]) test(`check rejects ${label} without retaining child output`, async t => {
  const f = await fixture(t), fake = fakeServer(f.prepared.context_id, () => {}, "silent");
  const promise = checkSessionConnection(f.root, f.prepared.context_id, consent(false), { spawnProcess: () => fake.child });
  fake.child.stdout.write(bytes); await assert.rejects(promise, { code });
});

test("abort after spawn waits for child close", async t => {
  const f = await fixture(t), fake = fakeServer(f.prepared.context_id, () => {}, "silent"), controller = new AbortController(); let stopped = false;
  fake.child.once("close", () => { stopped = true; });
  const promise = checkSessionConnection(f.root, f.prepared.context_id, consent(false), { signal: controller.signal, spawnProcess: () => fake.child });
  controller.abort(); await assert.rejects(promise, { code: "SESSION_CHECK_STOPPED" }); assert.equal(stopped, true);
});

test("unconfirmed child termination is distinct from a confirmed timeout", async t => {
  const f = await fixture(t), fake = fakeServer(f.prepared.context_id, () => {}, "silent"); fake.child.kill = () => false;
  await assert.rejects(checkSessionConnection(f.root, f.prepared.context_id, consent(false), { spawnProcess: () => fake.child, timeout_ms: 10 }), { code: "SESSION_CHECK_STOP_UNCONFIRMED" });
});

test("child no-migration guard rechecks schema after the parent preflight", async t => {
  const f = await fixture(t);
  const { spawn } = await import("node:child_process");
  await assert.rejects(checkSessionConnection(f.root, f.prepared.context_id, consent(false), { spawnProcess(command, args, options) {
    const db = new DatabaseSync(join(f.root, "research.sqlite")); db.exec("PRAGMA user_version=11"); db.close(); return spawn(command, args, options);
  } }), { code: "SESSION_CHECK_SERVER_FAILED" });
  const db = new DatabaseSync(join(f.root, "research.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, 11); } finally { db.close(); }
  assert.equal(readdirSync(f.root).some(name => name.includes("backup")), false);
});
