import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEDGER_SCHEMA_VERSION } from "./ledger.mjs";
import { SESSION_MCP_PROTOCOL } from "./session-mcp.mjs";

export class SessionCheckError extends Error {
  constructor(code) { super(code); this.name = "SessionCheckError"; this.code = code; }
}
const fail = code => { throw new SessionCheckError(code); };
const object = value => value !== null && Object.getPrototypeOf(value) === Object.prototype;
const MAX_OUTPUT = 64_000;

// Refuse a migration before starting the normal server. Do not initialize storage.
function inspectWorkspace(directory) {
  if (process.platform === "win32" || typeof process.getuid !== "function") fail("SESSION_CHECK_PLATFORM_UNVERIFIED");
  try {
    let path = directory;
    while (true) {
      if (lstatSync(path).isSymbolicLink()) fail("SESSION_CHECK_PATH_INVALID");
      const parent = dirname(path); if (path === parent) break; path = parent;
    }
    if (realpathSync(directory) !== directory) fail("SESSION_CHECK_PATH_INVALID");
    const database = join(directory, "research.sqlite");
    for (const [path, folder] of [[directory, true], [database, false],
      ...["-wal", "-shm"].filter(suffix => existsSync(database + suffix)).map(suffix => [database + suffix, false])]) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (folder ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid() ||
        info.mode & 0o077 || !folder && info.nlink !== 1) fail("SESSION_CHECK_PATH_INVALID");
    }
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=100");
      if (db.prepare("PRAGMA application_id").get().application_id !== 1162955825) fail("SESSION_CHECK_WORKSPACE_INVALID");
      if (db.prepare("PRAGMA user_version").get().user_version !== LEDGER_SCHEMA_VERSION) fail("SESSION_CHECK_UPGRADE_REQUIRED");
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof SessionCheckError) throw error;
    fail("SESSION_CHECK_WORKSPACE_INVALID");
  }
}

/** Check one installed stdio server. Never request task content or submit research. */
export async function checkSessionConnection(directory, contextId, consent, { signal, timeout_ms = 5000, spawnProcess = spawn } = {}) {
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(directory) ||
    !/^el-session-context-[a-f0-9]{64}$/.test(contextId ?? "") || consent?.allow_private_context !== true ||
    consent?.allow_candidate_method !== true || typeof consent?.allow_external_submission !== "boolean" ||
    !Number.isSafeInteger(timeout_ms) || timeout_ms < 10 || timeout_ms > 10000) fail("SESSION_CHECK_CONFIG_INVALID");
  if (signal?.aborted) fail("SESSION_CHECK_STOPPED");
  inspectWorkspace(directory);
  if (signal?.aborted) fail("SESSION_CHECK_STOPPED");
  const entry = fileURLToPath(new URL("../session-cli.mjs", import.meta.url));
  const args = [entry, "serve", "--workspace", directory, "--context", contextId,
    "--allow-private-context", "--allow-candidate-method", "--no-migrate", ...(consent.allow_external_submission ? ["--allow-external-submission"] : [])];
  const expectedTools = ["get_research_task", "get_submission_status", ...(consent.allow_external_submission ? ["submit_research"] : [])];
  return new Promise((resolve, reject) => {
    let child, timer, terminateTimer, stopTimer, finished = false, failure = null;
    let buffer = Buffer.alloc(0), bytesRead = 0, expectedId = 1, summary = null;
    const abort = () => stop("SESSION_CHECK_STOPPED");
    function finish(error) {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(terminateTimer); clearTimeout(stopTimer);
      signal?.removeEventListener("abort", abort); buffer = Buffer.alloc(0);
      error ? reject(new SessionCheckError(error)) : resolve(summary);
    }
    function stop(code) {
      if (finished || failure) return;
      failure = code; buffer = Buffer.alloc(0);
      try { child?.stdin.end(); child?.kill("SIGTERM"); } catch { /* A concurrent exit still needs its close event. */ }
      terminateTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* Retain the unconfirmed stop state. */ } }, 250);
      stopTimer = setTimeout(() => {
        child?.unref?.(); finish("SESSION_CHECK_STOP_UNCONFIRMED");
      }, 500);
    }
    const send = value => {
      try { child.stdin.write(JSON.stringify(value) + "\n"); } catch { stop("SESSION_CHECK_IO_FAILED"); }
    };
    function receive(value) {
      if (!object(value) || value.jsonrpc !== "2.0" || value.id !== expectedId || !object(value.result) || value.error !== undefined) {
        stop("SESSION_CHECK_PROTOCOL_INVALID"); return;
      }
      if (expectedId === 1) {
        if (value.result.protocolVersion !== SESSION_MCP_PROTOCOL || value.result.serverInfo?.name !== "equitylayer-local-research" ||
          !object(value.result.capabilities?.tools)) { stop("SESSION_CHECK_PROTOCOL_INVALID"); return; }
        send({ jsonrpc: "2.0", method: "notifications/initialized" }); expectedId = 2;
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (expectedId === 2) {
        const tools = value.result.tools;
        if (!Array.isArray(tools) || tools.length !== expectedTools.length ||
          new Set(tools.map(tool => tool?.name)).size !== expectedTools.length ||
          expectedTools.some(name => !tools.some(tool => tool?.name === name && object(tool.inputSchema) &&
            tool.annotations?.readOnlyHint === (name !== "submit_research")))) { stop("SESSION_CHECK_TOOLS_INVALID"); return; }
        expectedId = 3; send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_submission_status", arguments: {} } });
      } else if (expectedId === 3) {
        const status = value.result.structuredContent;
        if (value.result.isError === true || !object(status) || status.context_id !== contextId ||
          !["awaiting_submission", "retained_for_review"].includes(status.state) || status.usage !== "unverified" ||
          status.native_execution !== false || typeof status.accepted_evidence !== "boolean" || typeof status.accepted_interpretation !== "boolean") {
          stop("SESSION_CHECK_STATUS_INVALID"); return;
        }
        summary = { status: "connection_ok", protocol: SESSION_MCP_PROTOCOL, tools: expectedTools, submission_tool_available: consent.allow_external_submission,
          submission_state: status.state, private_task_read: false, source_access_checked: false, model_checked: false,
          research_checked: false, result_submitted: false, native_execution: false, usage: "unverified" };
        expectedId = null; child.stdin.end();
      } else stop("SESSION_CHECK_PROTOCOL_INVALID");
    }
    try {
      // Do not inherit model keys, user preloads, startup hooks, or a caller-supplied command.
      child = spawnProcess(process.execPath, args, { shell: false, env: {}, stdio: ["pipe", "pipe", "pipe"] });
      child.once("error", () => stop("SESSION_CHECK_START_FAILED"));
      child.once("close", code => {
        if (failure) finish(failure);
        else if (code !== 0) finish("SESSION_CHECK_SERVER_FAILED");
        else if (!summary || buffer.length) finish("SESSION_CHECK_PROTOCOL_INVALID");
        else finish();
      });
      child.stdin.on("error", () => stop("SESSION_CHECK_IO_FAILED"));
      child.stdout.on("error", () => stop("SESSION_CHECK_IO_FAILED"));
      child.stderr.on("error", () => stop("SESSION_CHECK_IO_FAILED"));
      child.stderr.on("data", () => { /* Drain diagnostics. Never retain or print private child output. */ });
      child.stdout.on("data", chunk => {
        if (finished || failure) return;
        bytesRead += chunk.length;
        if (bytesRead > MAX_OUTPUT) { stop("SESSION_CHECK_OUTPUT_LIMIT"); return; }
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        let newline;
        while ((newline = buffer.indexOf(10)) !== -1 && !failure) {
          const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
          try { receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))); }
          catch { stop("SESSION_CHECK_PROTOCOL_INVALID"); }
        }
      });
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => stop("SESSION_CHECK_TIMEOUT"), timeout_ms);
      if (signal?.aborted) abort();
      else send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: SESSION_MCP_PROTOCOL,
        capabilities: {}, clientInfo: { name: "equitylayer-connection-check", version: "1" } } });
    } catch { finish("SESSION_CHECK_START_FAILED"); }
  });
}
