import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { runSession, parseSessionArgs } from "../client/session-cli.mjs";
import { setup, scope } from "./fixtures/local-research.mjs";
import { eventFixture, sourcePolicy } from "./fixtures/source-events.mjs";

const flags = ["--allow-private-context", "--allow-candidate-method"];
function fixture(t, { large = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-session-cli-"))), now = Date.now(), ledger = new ResearchLedger(root);
  const envelope = setup(ledger), raw = eventFixture(21);
  raw.artifact.retrieved_at = new Date(now - 1000).toISOString(); raw.event.observed_at = raw.artifact.retrieved_at;
  if (large) {
    raw.bytes = Buffer.from(JSON.stringify({ synthetic: "x".repeat(300000) }));
    raw.artifact.byte_length = raw.bytes.length; raw.artifact.artifact_sha256 = createHash("sha256").update(raw.bytes).digest("hex");
    raw.facts.forEach(fact => { fact.source_artifact_sha256 = raw.artifact.artifact_sha256; });
  }
  ledger.retainSource(raw.event, raw.artifact, raw.bytes); ledger.retainSourceFacts(raw.event.source_event_id, raw.facts);
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy()); ledger.close();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, now, envelope, raw, args: ["prepare", "--workspace", root, "--watch", scope().watch_id, "--revision", "1",
    "--method", envelope.method.bundle_sha256, "--source-event", raw.event.source_event_id,
    "--preparation-id", "22222222-2222-4222-8222-222222222222", ...flags] };
}
async function prepare(f, extra = []) {
  let text = ""; await runSession([...f.args, ...extra], { stdout: value => { text += value; } }); return JSON.parse(text);
}
const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
const init = rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } });
const ready = { jsonrpc: "2.0", method: "notifications/initialized" };

test("session help starts no workspace, model, network, or server", async () => {
  let output = ""; assert.deepEqual(await runSession(["--help"], { stdout: text => { output += text; } }), { help: true });
  assert.match(output, /MCP over stdio/); assert.match(output, /invokes no model/);
});

for (const args of [["serve", "--workspace", "relative", "--context", "x", ...flags],
  ["serve", "--workspace", "/not-created", "--context", "x", ...flags],
  ["serve", "--workspace", "/not-created", "--context", `el-session-context-${"a".repeat(64)}`],
  ["prepare", "--workspace", "/not-created", "--watch", "x", ...flags],
  ["serve", "--workspace", "/not-created", "--workspace", "/different", ...flags],
  ["serve", "--help"], ["serve", "--workspace", "/not-created", "--context", "x", "--allow-review", ...flags]]) {
  test(`invalid session flags fail before opening storage: ${args[0]} ${args.length}`, async () => {
    await assert.rejects(runSession(args), error => /^SESSION_/.test(error.code));
  });
}

test("session refuses an empty directory instead of creating a new workspace", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-session-cli-empty-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(runSession(["serve", "--workspace", root, "--context", `el-session-context-${"a".repeat(64)}`, ...flags]), { code: "SESSION_WORKSPACE_REQUIRED" });
  assert.deepEqual(readdirSync(root), []);
});

test("prepare emits connection arguments without printing private task content", async t => {
  const f = fixture(t), value = await prepare(f);
  assert.equal(value.native_execution, false); assert.equal(value.usage, "unverified");
  assert.equal(value.mcp_command.command, process.execPath); assert.match(value.mcp_command.args[0], /\/client\/session-cli\.mjs$/);
  assert.equal(value.mcp_command.args.includes("--allow-external-submission"), false);
  assert.doesNotMatch(JSON.stringify(value), /Synthetic private|question|sources|artifact_sha256/);
  const replay = await prepare(f); assert.equal(replay.context_id, value.context_id); assert.equal(replay.reused, true);
});

test("submission permission enters connection arguments only through an explicit flag", async t => {
  const f = fixture(t), value = await prepare(f, ["--allow-external-submission"]);
  assert.equal(value.mcp_command.args.includes("--allow-external-submission"), true);
  assert.equal(parseSessionArgs(value.mcp_command.args.slice(1)).consent.allow_external_submission, true);
});

test("a generated read-only connection serves protocol lines and closes the database on EOF", async t => {
  const f = fixture(t), value = await prepare(f); let output = "";
  const messages = [init, ready, rpc(2, "tools/list"), rpc(3, "tools/call", { name: "get_research_task" })];
  await runSession(value.mcp_command.args.slice(1), { input: Readable.from(messages.map(message => Buffer.from(JSON.stringify(message) + "\n"))),
    output: new Writable({ write(chunk, _, done) { output += chunk; done(); } }) });
  const lines = output.trim().split("\n").map(line => JSON.parse(line)); assert.equal(lines.length, 3);
  assert.equal(lines[1].result.tools.length, 2); assert.equal(lines[2].result.structuredContent.context.context_id, value.context_id);
  const reopened = new ResearchLedger(f.root);
  try { assert.equal(reopened.workspaceStatus().counts.requests, 0); reopened.verifyIntegrity(); } finally { reopened.close(); }
});

async function childSession(t, args) {
  const child = spawn(process.execPath, ["client/session-cli.mjs", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close"), pending = new Map(); let buffer = "", errors = "";
  child.stderr.on("data", bytes => { errors += bytes; });
  child.stdout.on("data", bytes => {
    buffer += bytes.toString("utf8"); let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const entry = pending.get(value.id); if (entry) { clearTimeout(entry.timer); pending.delete(value.id); entry.resolve(value); }
    }
  });
  child.on("close", () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error("Synthetic MCP child stopped.")); } pending.clear(); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(Error("Synthetic MCP request timed out.")); }, 10000);
    pending.set(key, { timer, resolve, reject }); child.stdin.write(JSON.stringify(rpc(key, method, params)) + "\n");
  });
  await request("initialize", init.params); child.stdin.write(JSON.stringify(ready) + "\n");
  return { child, closed, request, errors: () => errors };
}

test("a real stdio child submits once, reconnects, and preserves unverified external provenance", async t => {
  const f = fixture(t), value = await prepare(f, ["--allow-external-submission"]), args = value.mcp_command.args.slice(1);
  const first = await childSession(t, args), task = await first.request("tools/call", { name: "get_research_task" });
  assert.equal(task.result.structuredContent.context.context_id, value.context_id);
  const input = { submission_id: "11111111-1111-4111-8111-111111111111", session: { client: "Synthetic stdio child", model: "declared", session_reference: "opaque" },
    agent_fields: { result_state: "SOURCE_NEEDED", summary: "Synthetic demonstration requires real financial evidence.", sources: [], drivers: [], falsifiers: [],
      unknowns: ["Synthetic data is not financial evidence."], next_check_at: new Date(f.now + 86400000).toISOString() } };
  const submitted = await first.request("tools/call", { name: "submit_research", arguments: input });
  assert.equal(submitted.result.structuredContent.reused, false); first.child.stdin.end(); assert.deepEqual(await first.closed, [0, null]);
  const second = await childSession(t, args), status = await second.request("tools/call", { name: "get_submission_status" });
  assert.equal(status.result.structuredContent.state, "retained_for_review"); assert.equal(status.result.structuredContent.usage, "unverified");
  const replay = await second.request("tools/call", { name: "submit_research", arguments: input }); assert.equal(replay.result.structuredContent.reused, true);
  second.child.stdin.end(); assert.deepEqual(await second.closed, [0, null]);
  assert.doesNotMatch(first.errors() + second.errors(), /Synthetic private|\.sqlite|SESSION_OPERATION_FAILED/);
  const ledger = new ResearchLedger(f.root);
  try { assert.equal(ledger.pageExternalSessionRecords().length, 1); assert.equal(ledger.notices().length, 1); assert.equal(ledger.workspaceStatus().counts.requests, 0); }
  finally { ledger.close(); }
});

test("a real stdio child closes cleanly on SIGTERM without a model request", async t => {
  const f = fixture(t), value = await prepare(f), session = await childSession(t, value.mcp_command.args.slice(1));
  session.child.kill("SIGTERM"); assert.deepEqual(await session.closed, [0, null]);
  const ledger = new ResearchLedger(f.root); try { assert.equal(ledger.workspaceStatus().counts.requests, 0); ledger.verifyIntegrity(); } finally { ledger.close(); }
});

test("an unread real stdout pipe cannot retain the process after output timeout", async t => {
  const f = fixture(t, { large: true }), value = await prepare(f), args = value.mcp_command.args;
  const child = spawn(value.mcp_command.command, args, { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit"), closed = once(child, "close"); let errors = "";
  const inputErrors = [];
  // The expected output-timeout exit can close stdin while the fixture is still writing.
  child.stdin.on("error", error => { inputErrors.push(error.code); });
  child.stderr.on("data", bytes => { errors += bytes; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); child.stdout.resume(); });
  // Bounded manifests need more requests than the old inline source response to fill the unread OS pipe.
  const messages = [init, ready, ...Array.from({ length: 2000 }, (_, index) => rpc(index + 2, "tools/call", { name: "get_research_task" }))];
  child.stdin.write(messages.map(message => JSON.stringify(message) + "\n").join(""));
  let timer;
  try {
    const outcome = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Synthetic MCP child exceeded the output deadline.")), 4000); })]);
    assert.deepEqual(outcome, [1, null]); assert.match(errors, /SESSION_OUTPUT_TIMEOUT/);
  } finally { clearTimeout(timer); child.stdout.resume(); }
  await closed;
  assert.ok(inputErrors.every(code => code === "EPIPE"), "Only the expected closed input pipe is allowed.");
  const ledger = new ResearchLedger(f.root); try { assert.equal(ledger.workspaceStatus().counts.requests, 0); ledger.verifyIntegrity(); } finally { ledger.close(); }
});
