#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { ResearchLedger, LedgerError } from "./local/ledger.mjs";
import { WorkspaceService } from "./local/workspace-service.mjs";
import { startWorkspaceServer, WorkspaceServerError } from "./local/workspace-server.mjs";
import { loadWorkspaceAssets } from "./local/workspace-ui.mjs";

const HELP = `EquityLayer local workspace (Node 22.13+)
  node client/workspace-cli.mjs --workspace ABSOLUTE_PRIVATE_DIRECTORY [--port 0] [--show-link]

The server binds 127.0.0.1 only. It reads and reviews caller-owned SQLite records.
Use --show-link to display the private session link. Do not share that link.
This entry cannot invoke AI, pay, trade, or approve source rights.
`;
export class WorkspaceCliError extends Error {
  constructor(code) { super(code); this.name = "WorkspaceCliError"; this.code = code; }
}
const fail = (code) => { throw new WorkspaceCliError(code); };
function parse(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("WORKSPACE_ARGUMENTS_INVALID");
  if (!args.length || args.length === 1 && args[0] === "--help") return { help: true };
  const parsed = { port: 0, show_link: false }; const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!["--workspace", "--port", "--show-link"].includes(flag) || seen.has(flag)) fail("WORKSPACE_FLAGS_INVALID");
    seen.add(flag);
    if (flag === "--show-link") { parsed.show_link = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--") || /[\u0000-\u001f\u007f]/u.test(value)) fail("WORKSPACE_FLAGS_INVALID");
    if (flag === "--workspace") parsed.directory = value;
    else {
      if (!/^(?:0|[1-9][0-9]*)$/.test(value) || Number(value) > 65535) fail("WORKSPACE_PORT_INVALID");
      parsed.port = Number(value);
    }
  }
  if (!parsed.directory || !isAbsolute(parsed.directory)) fail("WORKSPACE_PATH_INVALID");
  return parsed;
}

// The caller owns the returned lifecycle. No browser opens automatically.
export async function openWorkspace(args, { stdout = (value) => process.stdout.write(value), ledgerOptions = {} } = {}) {
  const options = parse(args);
  if (options.help) { stdout(HELP); return { help: true }; }
  let ledger, server;
  try {
    const assets = await loadWorkspaceAssets();
    ledger = new ResearchLedger(options.directory, { ...ledgerOptions, allow_migration: false, allow_creation: true });
    server = await startWorkspaceServer({ service: new WorkspaceService(ledger), port: options.port, assets });
    let closing;
    const close = () => {
      if (!closing) closing = (async () => { try { await server.close(); } finally { ledger.close(); } })();
      return closing;
    };
    try {
      stdout(`${JSON.stringify({ status: "local_workspace", origin: server.origin, ...(options.show_link ? { private_session_link: server.bootstrap_url } : {}),
        ai_execution_authorized: false, payment_authorized: false, trading_authorized: false })}\n`);
    } catch (error) { await close(); throw error; }
    return { server, ledger, close };
  } catch (error) {
    if (server) { try { await server.close(); } catch { /* Preserve the startup failure. */ } }
    if (ledger) { try { ledger.close(); } catch { /* Preserve the startup failure. */ } }
    if (error instanceof LedgerError || error instanceof WorkspaceServerError || error instanceof WorkspaceCliError) throw error;
    throw new WorkspaceCliError("WORKSPACE_START_FAILED");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  openWorkspace(process.argv.slice(2)).then((workspace) => {
    if (workspace.help) return;
    const stop = () => {
      process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
      workspace.close().catch(() => { process.stderr.write("WORKSPACE_CLOSE_FAILED\n"); process.exitCode = 1; });
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }).catch((error) => {
    const code = [LedgerError, WorkspaceServerError, WorkspaceCliError].some((type) => error instanceof type) && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code : "WORKSPACE_START_FAILED";
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  });
}
