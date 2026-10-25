#!/usr/bin/env node
import { mkdirSync, lstatSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync } from "node:fs";
import { isAbsolute, dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { connect, endpointUrl } from "./mcp.mjs";
import { canonicalJson, contentHash, publicScope } from "./local/run-contract.mjs";
import { verifyMethodBundle } from "./local/reference-bridge.mjs";
import { ResearchLedger } from "./local/ledger.mjs";
import { readPrivateJson, validateLocalInit, validateLocalRuntime, localOperationCode, runLocal } from "./local-cli.mjs";

const HELP = `EquityLayer first-use setup
  equitylayer setup --session --workspace ABSOLUTE_NEW_PRIVATE_DIRECTORY
  equitylayer setup --workspace ABSOLUTE_NEW_PRIVATE_DIRECTORY
  equitylayer setup --workspace ABSOLUTE_NEW_PRIVATE_DIRECTORY --answers PRIVATE_JSON --allow-public-scope
  equitylayer setup --workspace ABSOLUTE_NEW_PRIVATE_DIRECTORY --answers PRIVATE_JSON --method-bundle PRIVATE_JSON
  equitylayer setup --workspace ABSOLUTE_PRIVATE_DIRECTORY --resume

Optional --allow-native-check runs the trusted caller's management checks only.
Use --session for your existing local stdio AI client. This mode needs no runtime or inference budget.
Session setup cannot use --allow-native-check. Resume uses the saved mode without --session.
Setup never invokes a model, grants source rights, creates a research job, or starts tracking.
Public scope consent shares the theme, company symbols, and a random watch ID only.
The private question, trigger, caller settings, and budget remain local.
Read docs/first-use.md before setup. Never include API keys in setup answers.
`;
const ENDPOINT = "https://equitylayer.io/mcp";
const SNAPSHOT = "setup.local.json", INIT = "init.local.json", RUNTIME = "runtime.local.json";
const ZERO_BUDGET = Object.freeze({ requests: 0, tokens: 0, cost_microusd: 0, wall_ms: 0 });
export class SetupError extends Error { constructor(code) { super(code); this.name = "SetupError"; this.code = code; } }
const fail = code => { throw new SetupError(code); };
const exact = (value, fields) => {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== [...fields].sort().join()) fail("SETUP_INPUT_INVALID");
};
const stopped = signal => { if (signal?.aborted) fail("SETUP_CANCELLED"); };
const privateDirectory = path => {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) fail("SETUP_STORAGE_UNSAFE");
};
const copy = value => JSON.parse(canonicalJson(value));

function abortable(operation, signal, lateValue) {
  stopped(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const remove = () => signal?.removeEventListener("abort", abort);
    const abort = () => { if (!settled) { settled = true; remove(); reject(new SetupError("SETUP_CANCELLED")); } };
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { stopped(signal); return operation(); }).then(value => {
      if (settled) { if (lateValue) Promise.resolve().then(() => lateValue(value)).catch(() => {}); return; }
      settled = true; remove(); resolve(value);
    }, error => { if (!settled) { settled = true; remove(); reject(error); } });
  });
}

export function validateSetupAnswers(value, { session = false } = {}) {
  const answer = copy(value);
  exact(answer, session ? ["focus", "symbols", "question", "trigger"] : ["focus", "symbols", "question", "trigger", "runtime", "budget"]);
  if (!["ai_compute", "pcb_ccl"].includes(answer.focus) ||
      [answer.question, answer.trigger].some(text => typeof text !== "string" || !text.trim() || text.length > 600)) fail("SETUP_INPUT_INVALID");
  const scope = publicScope({ watch_id: "11111111-1111-4111-8111-111111111111", revision: 1, theme_id: "ai_compute", symbols: answer.symbols });
  const markets = scope.symbols.map(symbol => /\.(TW|TWO)$/.test(symbol) ? "TW" : /\.T$/.test(symbol) ? "JP" : /\.(KS|KQ)$/.test(symbol) ? "KR" : /^[A-Z][A-Z0-9-]*(?:\.[AB])?$/.test(symbol) ? "US" : null);
  if (markets.includes(null) || !markets.includes("US") || !markets.some(market => ["TW", "JP", "KR"].includes(market))) fail("SETUP_CROSS_MARKET_REQUIRED");
  answer.symbols = scope.symbols;
  if (session) return answer;
  exact(answer.budget, ["requests", "tokens", "cost_microusd", "wall_ms"]);
  for (const [key, maximum] of [["requests", 100], ["tokens", 10000000], ["cost_microusd", 100000000], ["wall_ms", 3600000]]) {
    if (!Number.isSafeInteger(answer.budget[key]) || answer.budget[key] < 1 || answer.budget[key] > maximum) fail("SETUP_BUDGET_INVALID");
  }
  exact(answer.runtime, ["native", "execution"]);
  if (!answer.runtime.native || Object.keys(answer.runtime.native.env ?? {}).some(key => !["HOME", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].includes(key))) fail("SETUP_CREDENTIALS_DENIED");
  const parsed = validateLocalRuntime(answer.runtime);
  if (parsed.execution.estimate.wall_ms < (parsed.execution.timeout_ms ?? 30000) ||
      ["tokens", "cost_microusd", "wall_ms"].some(key => parsed.execution.estimate[key] < 1) ||
      ["tokens", "cost_microusd", "wall_ms"].some(key => parsed.execution.estimate[key] > answer.budget[key]) ||
      (answer.runtime.native.claude_limits?.max_budget_microusd ?? 0) > answer.budget.cost_microusd) fail("SETUP_BUDGET_INVALID");
  answer.symbols = scope.symbols;
  return answer;
}

async function readMethod(scope, connectClient, signal) {
  stopped(signal);
  const client = await abortable(() => connectClient(endpointUrl(ENDPOINT), { timeoutMs: 25000, signal }), signal, late => late.close());
  try {
    stopped(signal);
    const listing = await abortable(() => client.tools(), signal);
    stopped(signal);
    if (!listing.tools.some(tool => tool.name === "resolve_research_scope")) fail("SETUP_METHOD_TOOL_MISSING");
    const result = await abortable(() => client.call("resolve_research_scope", scope), signal);
    if (result.schema_version !== 1 || result.operation !== "resolve_research_scope" || result.ok !== true ||
        canonicalJson(publicScope(result.scope)) !== canonicalJson(scope)) fail("SETUP_METHOD_SCOPE_CONFLICT");
    const bundle = copy(result.method?.evidence_profile_bundle); verifyMethodBundle(bundle);
    return bundle;
  } finally {
    if (signal?.aborted) Promise.resolve().then(() => client.close()).catch(() => {});
    else await abortable(() => client.close(), signal);
  }
}

// Publish only a new owned file. An existing file must contain the exact saved input.
function saveInput(directory, name, value) {
  privateDirectory(directory);
  const destination = join(directory, name);
  if (existsSync(destination)) {
    if (canonicalJson(readPrivateJson(destination)) !== canonicalJson(value)) fail("SETUP_STATE_CONFLICT");
    return destination;
  }
  const temporary = join(directory, `.setup-write-${randomUUID()}`); let fd;
  try {
    fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, canonicalJson(value) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, destination);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return destination;
}

function checkSnapshot(value) {
  const record = copy(value);
  if (Buffer.byteLength(canonicalJson(record)) > 1000000) fail("SETUP_INPUT_TOO_LARGE");
  const session = record.schema_version === 2;
  exact(record, ["schema_version", "focus", "init", "runtime", "method_origin", "content_sha256", ...(session ? ["execution_mode"] : [])]);
  const { content_sha256, ...body } = record;
  if (![1, 2].includes(record.schema_version) || contentHash(body) !== content_sha256 || ![ENDPOINT, "caller_file"].includes(record.method_origin) ||
      session && (record.execution_mode !== "external_session" || record.runtime !== null || canonicalJson(record.init?.budget?.limits) !== canonicalJson(ZERO_BUDGET))) fail("SETUP_STATE_CONFLICT");
  validateLocalInit(record.init);
  if (record.init.source_policies.length || record.init.scope.revision !== 1 || record.init.scope.theme_id !== "ai_compute" ||
      record.init.scope.stage_id !== undefined || record.init.budget.window_id !== "initial") fail("SETUP_STATE_CONFLICT");
  exact(record.init.private_context, ["question", "trigger", "component"]);
  const answer = validateSetupAnswers({ focus: record.focus, symbols: record.init.scope.symbols, question: record.init.private_context.question,
    trigger: record.init.private_context.trigger, ...(!session ? { runtime: record.runtime, budget: record.init.budget.limits } : {}) }, { session });
  if (record.init.private_context.component !== (answer.focus === "pcb_ccl" ? "PCB / high-grade CCL" : "AI Compute")) fail("SETUP_STATE_CONFLICT");
  return record;
}

export async function setupWorkspace({ workspace, answers, method_bundle, session = false, allow_public_scope = false, allow_native_check = false, resume = false, signal },
  { connectClient = connect, clock = Date.now, fault = () => {} } = {}) {
  if (process.platform === "win32" || typeof process.getuid !== "function") fail("PLATFORM_UNVERIFIED");
  if (typeof workspace !== "string" || !isAbsolute(workspace) || /[\u0000-\u001f\u007f]/u.test(workspace)) fail("SETUP_PATH_INVALID");
  if (typeof session !== "boolean" || session && (allow_native_check || resume)) fail("SETUP_FLAGS_INVALID");
  stopped(signal);
  let snapshot;
  if (resume) {
    if (answers !== undefined || method_bundle !== undefined || allow_public_scope) fail("SETUP_FLAGS_INVALID");
    privateDirectory(workspace); snapshot = checkSnapshot(readPrivateJson(join(workspace, SNAPSHOT)));
  } else {
    if (existsSync(workspace)) fail("SETUP_WORKSPACE_EXISTS");
    const answer = validateSetupAnswers(answers, { session });
    if (method_bundle === undefined && !allow_public_scope) fail("SETUP_PUBLIC_SCOPE_CONSENT_REQUIRED");
    const scope = publicScope({ watch_id: randomUUID(), revision: 1, theme_id: "ai_compute", symbols: answer.symbols });
    const method = method_bundle === undefined ? await readMethod(scope, connectClient, signal) : copy(method_bundle);
    verifyMethodBundle(method); stopped(signal);
    const body = { schema_version: session ? 2 : 1, ...(session ? { execution_mode: "external_session" } : {}), focus: answer.focus,
      init: { scope, private_context: { question: answer.question, trigger: answer.trigger, component: answer.focus === "pcb_ccl" ? "PCB / high-grade CCL" : "AI Compute" },
        method_bundle: method, budget: { window_id: "initial", limits: session ? ZERO_BUDGET : answer.budget }, source_policies: [] },
      runtime: session ? null : answer.runtime, method_origin: method_bundle === undefined ? ENDPOINT : "caller_file" };
    snapshot = checkSnapshot({ ...body, content_sha256: contentHash(body) });
  }
  const sessionMode = snapshot.schema_version === 2;
  if (sessionMode && allow_native_check) fail("SETUP_FLAGS_INVALID");
  if (sessionMode && resume && lstatSync(join(workspace, RUNTIME), { throwIfNoEntry: false })) fail("SETUP_STATE_CONFLICT");
  let nativeCheck;
  if (allow_native_check) nativeCheck = await validateLocalRuntime(snapshot.runtime).runtime.inspect({ signal });
  stopped(signal);
  if (!resume) {
    mkdirSync(dirname(workspace), { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    saveInput(workspace, SNAPSHOT, snapshot);
  }
  fault("setup:after_snapshot"); stopped(signal);
  if (!sessionMode) saveInput(workspace, RUNTIME, snapshot.runtime);
  const initPath = saveInput(workspace, INIT, snapshot.init);
  fault("setup:before_init"); stopped(signal);
  const initialized = await runLocal(["init", "--workspace", workspace, "--input", initPath], { stdout: () => {}, clock });
  if (initialized.exitCode !== 0) fail(initialized.output?.code === "SCHEMA_UPGRADE_REQUIRED" ? "SCHEMA_UPGRADE_REQUIRED" : "SETUP_INITIALIZATION_FAILED");
  const ledger = new ResearchLedger(workspace, { clock, allow_migration: false, allow_creation: false });
  try {
    const watch = ledger.watch(snapshot.init.scope.watch_id), status = ledger.workspaceStatus();
    // Report the frozen setup candidate only. A recognized ID is not method approval or evidence coverage.
    const focusProfile = snapshot.focus === "pcb_ccl"
      ? snapshot.init.method_bundle.profiles.find(profile => profile.profile_id === "ai-compute-pcb-ccl") : undefined;
    return { status: "needs_sources", watch_id: snapshot.init.scope.watch_id, revision: snapshot.init.scope.revision,
      current_revision: watch.current_revision, focus: snapshot.focus, company_count: snapshot.init.scope.symbols.length,
      method_status: "candidate", method_profile_gap: snapshot.focus === "pcb_ccl"
        ? (focusProfile ? "PCB_CCL_PROFILE_REVIEW_REQUIRED" : "PCB_CCL_PROFILE_REQUIRED") : null,
      setup_focus_profile: focusProfile ? { profile_id: focusProfile.profile_id, version: focusProfile.version, content_sha256: focusProfile.content_sha256 } : null,
      setup_source_policies_created: false, native_check: nativeCheck ? "configuration_checked" : "not_checked",
      research_mode: sessionMode ? "external_session" : "native_runner",
      model_access: "not_checked", accounting: sessionMode ? "user_client_unverified" : snapshot.runtime.native.provider === "codex" ? "cost_unavailable" : "provider_report_unverified",
      counts: status.counts, existing_gates: status.gates.map(gate => gate.gate_code),
      execution_authorized: false, research_job_created: false, tracking_started: false, payment_authorized: false, trading_authorized: false,
      runtime_file: sessionMode ? null : RUNTIME, next_command: { executable: "equitylayer", args: ["workspace", "--workspace", workspace, "--show-link"] } };
  } finally { ledger.close(); }
}

function parse(args) {
  if (!args.length || args.length === 1 && args[0] === "--help") return { help: true };
  const options = {}, seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!["--workspace", "--answers", "--method-bundle", "--session", "--allow-public-scope", "--allow-native-check", "--resume"].includes(flag) || seen.has(flag)) fail("SETUP_FLAGS_INVALID");
    seen.add(flag);
    if (flag.startsWith("--allow-") || flag === "--resume" || flag === "--session") { options[flag.slice(2).replaceAll("-", "_")] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--") || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) fail("SETUP_PATH_INVALID");
    options[flag.slice(2)] = value;
  }
  if (!options.workspace || options.resume && (options.answers || options["method-bundle"] || options.allow_public_scope)) fail("SETUP_FLAGS_INVALID");
  if (options.session && (options.resume || options.allow_native_check)) fail("SETUP_FLAGS_INVALID");
  return options;
}

export async function collectSetupAnswers(ask, { signal, session = false } = {}) {
  const question = async (text, fallback) => {
    stopped(signal); const value = (await ask(`${text}${fallback === undefined ? "" : ` [${fallback}]`}: `)).trim(); stopped(signal);
    if (value === "/cancel") fail("SETUP_CANCELLED");
    if (!value && fallback === undefined) fail("SETUP_INPUT_INVALID");
    return value || fallback;
  };
  const focus = await question("Focus: ai_compute or pcb_ccl", "ai_compute");
  const symbols = (await question("Company symbols: include US and Asian companies")).split(",").map(value => value.trim());
  const privateQuestion = await question("Private research question");
  const trigger = await question("Next evidence or review trigger");
  if (session) {
    if (await question("Save this local setup? Type yes to continue", "no") !== "yes") fail("SETUP_CANCELLED");
    return validateSetupAnswers({ focus, symbols, question: privateQuestion, trigger }, { session: true });
  }
  const provider = await question("AI caller: claude-code or codex", "claude-code");
  const executable = await question("Absolute path to your trusted AI executable");
  const cli_version = await question("Installed CLI version, such as the value from --version");
  const model = await question("Your selected model name");
  const authHome = await question("Approved home for your existing AI login", homedir());
  const requests = Number(await question("Maximum requests in the initial budget", "1"));
  const tokens = Number(await question("Maximum tokens in the initial budget", "100000"));
  const amount = await question("Initial budget in USD; this is not spend authorization", "1.00");
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,6})?$/.test(amount)) fail("SETUP_BUDGET_INVALID");
  const cost_microusd = Math.round(Number(amount) * 1000000), wall_ms = 120000;
  const native = { allow_native_research: true, provider, executable, cli_version, model, env: { HOME: authHome, PATH: "/usr/bin:/bin" }, timeout_ms: wall_ms,
    ...(provider === "claude-code" ? { claude_limits: { max_budget_microusd: Math.min(150000, cost_microusd), max_output_tokens: 2000, max_turns: 2 } } : {}) };
  if (await question("Save this local setup? Type yes to continue", "no") !== "yes") fail("SETUP_CANCELLED");
  return validateSetupAnswers({ focus, symbols, question: privateQuestion, trigger, runtime: { native,
    execution: { estimate: { tokens, cost_microusd, wall_ms }, timeout_ms: wall_ms, lease_ms: 30000, heartbeat_ms: 5000 } },
    budget: { requests, tokens, cost_microusd, wall_ms } });
}

export async function runSetup(args, { stdout = value => process.stdout.write(value), ask, signal,
  input = process.stdin, promptOutput = process.stderr, ...dependencies } = {}) {
  let readline, releasePrompt;
  try {
    const options = parse(args);
    if (options.help) { stdout(HELP); return { exitCode: 0 }; }
    let answers;
    if (!options.resume) {
      if (options.answers) answers = readPrivateJson(options.answers);
      else {
        if (!ask && (!input.isTTY || !promptOutput.isTTY)) fail("SETUP_INTERACTIVE_REQUIRED");
        if (!ask) {
          const parentSignal = signal, promptController = new AbortController(), cancel = () => promptController.abort();
          readline = createInterface({ input, output: promptOutput });
          // Readline handles terminal keys separately from process signals.
          readline.on("SIGINT", cancel); readline.on("close", cancel);
          parentSignal?.addEventListener("abort", cancel, { once: true });
          signal = promptController.signal;
          if (parentSignal?.aborted) cancel();
          ask = prompt => { stopped(signal); return readline.question(prompt, { signal }); };
          releasePrompt = () => {
            readline.off("SIGINT", cancel); readline.off("close", cancel);
            parentSignal?.removeEventListener("abort", cancel);
          };
        }
        answers = await collectSetupAnswers(ask, { signal, session: options.session === true });
        if (!options["method-bundle"] && !options.allow_public_scope) {
          if ((await ask("Send the theme and company symbols to equitylayer.io for candidate methods? Type yes: ")).trim() !== "yes") fail("SETUP_CANCELLED");
          options.allow_public_scope = true;
        }
      }
    }
    const result = await setupWorkspace({ workspace: options.workspace, answers,
      ...(options["method-bundle"] ? { method_bundle: readPrivateJson(options["method-bundle"]) } : {}),
      session: options.session === true, allow_public_scope: options.allow_public_scope === true, allow_native_check: options.allow_native_check === true, resume: options.resume === true, signal }, dependencies);
    stdout(JSON.stringify(result) + "\n"); return { exitCode: 0, output: result };
  } catch (error) {
    const operationCode = localOperationCode(error);
    const code = error instanceof SetupError ? error.code : signal?.aborted ? "SETUP_CANCELLED" : operationCode === "LOCAL_OPERATION_FAILED" ? "SETUP_OPERATION_FAILED" : operationCode;
    const output = { status: "error", code }; stdout(JSON.stringify(output) + "\n"); return { exitCode: 1, output };
  } finally { releasePrompt?.(); readline?.close(); }
}

export { checkSnapshot as validateSetupSnapshot, saveInput as saveSetupInput };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  runSetup(process.argv.slice(2), { signal: controller.signal }).then(result => { process.exitCode = result.exitCode; }).finally(() => {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  });
}
