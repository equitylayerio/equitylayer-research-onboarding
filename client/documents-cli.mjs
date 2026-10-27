#!/usr/bin/env node
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { ResearchLedger } from "./local/ledger.mjs";
import { DocumentError } from "./local/document-intake.mjs";
import { readPrivateJson, localOperationCode } from "./local-cli.mjs";
import { validateSetupSnapshot } from "./setup-cli.mjs";

const HELP = `EquityLayer local document intake
  equitylayer documents --workspace ABSOLUTE_PRIVATE_DIRECTORY --file ABSOLUTE_RETAINED_FILE
  equitylayer documents --workspace ABSOLUTE_PRIVATE_DIRECTORY --file ABSOLUTE_RETAINED_FILE --answers PRIVATE_JSON
Add --confirm-local-source-use only for documented ALLOWED local use.
Use UTF-8 HTML, text, XML, CSV, or JSON smaller than 2 MB. PDF is not supported.
The command copies exact bytes into SQLite. It cannot fetch, invoke AI, start tracking, pay, or trade.
Source dates, response status, company scope, and local rights remain caller declarations.
It cannot approve commercial reuse, accept research, or replace a changed document or permission.
Read docs/first-use.md. Keep the workspace and output private.
`;
const fail = code => { throw new DocumentError(code); };
const stopped = signal => { if (signal?.aborted) fail("DOCUMENT_CANCELLED"); };
function readDocument(path) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) fail("DOCUMENT_PATH_INVALID");
  let fd;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || before.mode & 0o022 || before.nlink !== 1 || before.size > 2_000_000) fail("DOCUMENT_FILE_UNSAFE");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (info.dev !== before.dev || info.ino !== before.ino || info.mode !== before.mode || info.nlink !== 1 || !info.isFile()) fail("DOCUMENT_FILE_UNSAFE");
    const bytes = Buffer.alloc(2_000_001); let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length))) length += count;
    const after = fstatSync(fd);
    if (length > 2_000_000 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("DOCUMENT_FILE_CHANGED");
    return bytes.subarray(0, length);
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function collectDocumentAnswers(ask, scope, { signal } = {}) {
  const question = async (label, fallback) => {
    stopped(signal); const value = (await ask(`${label}${fallback === undefined ? "" : ` [${fallback}]`}: `)).trim(); stopped(signal);
    if (value === "/cancel") fail("DOCUMENT_CANCELLED");
    if (!value && fallback === undefined) fail("DOCUMENT_METADATA_INVALID");
    return value || fallback;
  };
  const metadata = { canonical_url: await question("Original HTTPS source URL"),
    source_class: await question("Source class: issuer_release, regulatory_filing, issuer_presentation, issuer_call_material, exchange_dataset, consensus_vendor_snapshot", "issuer_release"),
    symbols: (await question(`Covered symbols from ${scope.symbols.join(", ")}`)).split(",").map(value => value.trim()),
    retrieved_at: await question("Original retrieval timestamp with timezone. Do not use the import time"),
    published_at: await question("Known publication timestamp with timezone, or - if unknown", "-"),
    source_period: await question("Source reporting period, or - if unknown", "-"),
    content_type: await question("Content type", "text/html; charset=utf-8"),
    http_status: Number(await question("Original successful HTTP response status. Do not guess")),
    max_source_age_days: Number(await question("Maximum age since original retrieval, in days. This is not a freshness guarantee", "30")),
    rights_status: await question("Your local research rights: HOLD, UNKNOWN, or ALLOWED", "HOLD") };
  if (metadata.published_at === "-") metadata.published_at = null;
  if (metadata.source_period === "-") metadata.source_period = null;
  metadata.rights_reference = metadata.rights_status === "ALLOWED" ? await question("Documented local permission reference. Do not enter credentials") : null;
  const confirm_local_use = metadata.rights_status === "ALLOWED" && await question("Confirm permitted local use only. Type yes", "no") === "yes";
  if (metadata.rights_status === "ALLOWED" && !confirm_local_use) fail("DOCUMENT_CANCELLED");
  metadata.allow_candidate_trials = metadata.rights_status === "ALLOWED" && await question("Permit candidate-method research using this document? Type yes", "no") === "yes";
  if (await question("Retain these bytes and declarations locally? Type yes", "no") !== "yes") fail("DOCUMENT_CANCELLED");
  return { metadata, confirm_local_use };
}

export async function runDocuments(args, { stdout = value => process.stdout.write(value), ask, signal,
  input = process.stdin, promptOutput = process.stderr, clock = Date.now, fault = () => {} } = {}) {
  let readline, cleanup, ledger;
  try {
    if (!args.length || args.length === 1 && args[0] === "--help") { stdout(HELP); return { exitCode: 0 }; }
    if (process.platform === "win32" || typeof process.getuid !== "function") fail("PLATFORM_UNVERIFIED");
    const options = {}, seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (!["--workspace", "--file", "--answers", "--confirm-local-source-use"].includes(flag) || seen.has(flag)) fail("DOCUMENT_FLAGS_INVALID");
      seen.add(flag);
      if (flag === "--confirm-local-source-use") { options.confirm_local_use = true; continue; }
      const value = args[++i];
      if (!value || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) fail("DOCUMENT_PATH_INVALID");
      options[flag.slice(2)] = value;
    }
    if (!options.workspace || !options.file) fail("DOCUMENT_FLAGS_INVALID");
    stopped(signal);
    const setup = validateSetupSnapshot(readPrivateJson(join(options.workspace, "setup.local.json")));
    const bytes = readDocument(options.file);
    let metadata;
    if (options.answers) metadata = readPrivateJson(options.answers);
    else {
      if (options.confirm_local_use) fail("DOCUMENT_FLAGS_INVALID");
      if (!ask && (!input.isTTY || !promptOutput.isTTY)) fail("DOCUMENT_INTERACTIVE_REQUIRED");
      if (!ask) {
        const parent = signal, controller = new AbortController(), cancel = () => controller.abort();
        readline = createInterface({ input, output: promptOutput });
        readline.on("SIGINT", cancel); readline.on("close", cancel); parent?.addEventListener("abort", cancel, { once: true });
        signal = controller.signal; if (parent?.aborted) cancel();
        cleanup = () => { readline.off("SIGINT", cancel); readline.off("close", cancel); parent?.removeEventListener("abort", cancel); };
        ask = prompt => { stopped(signal); return readline.question(prompt, { signal }); };
      }
      const answers = await collectDocumentAnswers(ask, setup.init.scope, { signal });
      metadata = answers.metadata; options.confirm_local_use = answers.confirm_local_use;
    }
    stopped(signal);
    ledger = new ResearchLedger(options.workspace, { clock, fault, allow_creation: false, allow_migration: false });
    const saved = ledger.retainLocalDocument({ watch_id: setup.init.scope.watch_id, scope_revision: setup.init.scope.revision,
      metadata, bytes, confirm_local_use: options.confirm_local_use });
    const output = { status: saved.rights_status !== "ALLOWED" ? "retained_rights_held" : saved.candidate_method_use ? "retained_for_session_selection" : "retained_method_review_required",
      ...saved, provenance: "caller_declared_not_authenticated", normalized_facts_created: 0, source_authenticity_verified: false,
      commercial_reuse_authorized: false, research_accepted: false, model_called: false, network_called: false, tracking_started: false,
      payment_authorized: false, trading_authorized: false,
      next_command: { executable: "equitylayer", args: ["workspace", "--workspace", options.workspace, "--show-link"] } };
    stdout(JSON.stringify(output) + "\n"); return { exitCode: 0, output };
  } catch (error) {
    const code = error instanceof DocumentError ? error.code : signal?.aborted ? "DOCUMENT_CANCELLED" : localOperationCode(error);
    const output = { status: "error", code }; stdout(JSON.stringify(output) + "\n"); return { exitCode: 1, output };
  } finally { cleanup?.(); readline?.close(); ledger?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  runDocuments(process.argv.slice(2), { signal: controller.signal }).then(result => { process.exitCode = result.exitCode; }).finally(() => {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  });
}
