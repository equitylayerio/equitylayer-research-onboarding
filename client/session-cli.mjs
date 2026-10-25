#!/usr/bin/env node
import { lstatSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ResearchLedger, LedgerError } from "./local/ledger.mjs";
import { ExternalSessionError } from "./local/external-session-contract.mjs";
import { createSessionMcp, serveSessionStdio } from "./local/session-mcp.mjs";
import { sessionConnection } from "./local/session-connection.mjs";
import { checkSessionConnection, SessionCheckError } from "./local/session-check.mjs";

const HELP = `EquityLayer private AI session (Node 22.13+)
  equitylayer session prepare --workspace ABSOLUTE_EXISTING_DIRECTORY --watch UUID --revision NUMBER --method SHA256
    [--source-event EVENT_ID ...] [--preparation-id UUID]
    --allow-private-context --allow-candidate-method [--allow-external-submission]
  equitylayer session serve --workspace ABSOLUTE_EXISTING_DIRECTORY --context CONTEXT_ID
    --allow-private-context --allow-candidate-method [--allow-external-submission]
  equitylayer session check --workspace ABSOLUTE_EXISTING_DIRECTORY --context CONTEXT_ID
    --allow-private-context --allow-candidate-method [--allow-external-submission]

Prepare fixes one watch revision, method, and retained sources. It fetches no source and invokes no model.
Serve uses MCP over stdio. Configure it in your own AI client. Do not paste private data into the hosted MCP.
Without --allow-external-submission, the connection exposes read tools only.
Check starts this installed server and checks protocol, tools, and submission status. It does not read the private task or call AI.
All session commands refuse a workspace that needs migration. Check cannot prove source access or research quality.
External results remain unverified and require human review. No tool can accept research, release budgets, pay, or trade.
`;
export class SessionCliError extends Error { constructor(code) { super(code); this.name = "SessionCliError"; this.code = code; } }
const fail = code => { throw new SessionCliError(code); };
const CONSENT_FLAGS = ["--allow-private-context", "--allow-candidate-method", "--allow-external-submission"];
export function parseSessionArgs(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) fail("SESSION_FLAGS_INVALID");
  if (!args.length || args.length === 1 && args[0] === "--help") return { help: true };
  const command = args[0];
  if (!["prepare", "serve", "check"].includes(command)) fail("SESSION_COMMAND_INVALID");
  const allowed = command === "prepare" ? ["--workspace", "--watch", "--revision", "--method", "--source-event", "--preparation-id", ...CONSENT_FLAGS] :
    ["--workspace", "--context", ...(command === "serve" ? ["--no-migrate"] : []), ...CONSENT_FLAGS];
  const values = {}, seen = new Set(), sources = [];
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (!allowed.includes(flag) || flag !== "--source-event" && seen.has(flag)) fail("SESSION_FLAGS_INVALID");
    seen.add(flag);
    if (CONSENT_FLAGS.includes(flag) || flag === "--no-migrate") { values[flag] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--") || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) fail("SESSION_FLAGS_INVALID");
    if (flag === "--source-event") { if (value.length > 500 || sources.length >= 30 || sources.includes(value)) fail("SESSION_FLAGS_INVALID"); sources.push(value); }
    else values[flag] = value;
  }
  if (!values["--workspace"] || !isAbsolute(values["--workspace"])) fail("SESSION_PATH_INVALID");
  if (!values["--allow-private-context"] || !values["--allow-candidate-method"]) fail("SESSION_CONSENT_REQUIRED");
  if (command !== "prepare" && !/^el-session-context-[a-f0-9]{64}$/.test(values["--context"] ?? "")) fail("SESSION_CONTEXT_INVALID");
  if (command === "prepare" && (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(values["--watch"] ?? "") ||
      !/^[1-9][0-9]*$/.test(values["--revision"] ?? "") || !Number.isSafeInteger(Number(values["--revision"])) ||
      !/^[a-f0-9]{64}$/.test(values["--method"] ?? "") || values["--preparation-id"] !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(values["--preparation-id"]))) fail("SESSION_FLAGS_INVALID");
  return { command, directory: values["--workspace"], values, sources,
    consent: { allow_private_context: true, allow_candidate_method: true, allow_external_submission: values["--allow-external-submission"] === true } };
}

function existingWorkspace(directory) {
  try {
    const root = lstatSync(directory), database = lstatSync(join(directory, "research.sqlite"));
    if (!root.isDirectory() || root.isSymbolicLink() || !database.isFile() || database.isSymbolicLink()) fail("SESSION_WORKSPACE_REQUIRED");
  } catch { fail("SESSION_WORKSPACE_REQUIRED"); }
}

export async function runSession(args, { stdout = value => process.stdout.write(value), input = process.stdin, output = process.stdout, ledgerOptions = {}, signal } = {}) {
  const options = parseSessionArgs(args);
  if (options.help) { stdout(HELP); return { help: true }; }
  existingWorkspace(options.directory);
  if (options.command === "check") {
    const value = await checkSessionConnection(options.directory, options.values["--context"], options.consent, { signal });
    stdout(JSON.stringify(value) + "\n"); return value;
  }
  const ledger = new ResearchLedger(options.directory, { ...ledgerOptions, allow_migration: false, allow_creation: false });
  try {
    if (options.command === "prepare") {
      const prepared = ledger.prepareExternalSession({ preparation_id: options.values["--preparation-id"] ?? randomUUID(),
        watch_id: options.values["--watch"], revision: Number(options.values["--revision"]), method_sha256: options.values["--method"], source_event_ids: options.sources }, options.consent);
      const value = sessionConnection(ledger.directory, prepared, options.consent);
      stdout(JSON.stringify(value) + "\n"); return value;
    }
    const server = createSessionMcp({ ledger, context_id: options.values["--context"], consent: options.consent });
    await serveSessionStdio(server, { input, output, signal });
    return { closed: true };
  } finally { ledger.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(), stop = () => controller.abort();
  let outputTimedOut = false;
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  process.stdout.on("error", () => { controller.abort(); process.exitCode = 1; });
  runSession(process.argv.slice(2), { signal: controller.signal }).catch(error => {
    const safe = error instanceof SessionCliError || error instanceof ExternalSessionError || error instanceof SessionCheckError || error instanceof LedgerError;
    const code = safe && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "SESSION_OPERATION_FAILED";
    try { writeSync(2, `${code}\n`); } catch { /* Do not disclose a raw stderr failure. */ }
    outputTimedOut = error instanceof ExternalSessionError && error.code === "SESSION_OUTPUT_TIMEOUT";
    process.exitCode = 1;
  }).finally(() => {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    // runSession closes SQLite first. A blocked stdout handle must not retain this process.
    if (outputTimedOut || controller.signal.aborted) process.exit(process.exitCode ?? 0);
  });
}
