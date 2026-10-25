#!/usr/bin/env node
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { canonicalJson, contentHash } from "./local/run-contract.mjs";
import { validateSourcePolicy } from "./local/source-event-plan.mjs";
import { validateScheduleConfig } from "./local/schedule-contract.mjs";
import { TWSE_MONTHLY_SOURCE_ID, TWSE_LOCAL_VERSION, TWSE_MONTHLY_METRICS } from "./local/twse-monthly-source.mjs";
import { SEC_SUBMISSIONS_VERSION, SEC_SUBMISSIONS_METRIC, SecSourceError, validateSecFeed, secSourceId } from "./local/sec-submissions-contract.mjs";
import { ResearchLedger } from "./local/ledger.mjs";
import { readPrivateJson, localOperationCode } from "./local-cli.mjs";
import { validateSetupSnapshot, saveSetupInput } from "./setup-cli.mjs";

const HELP = `EquityLayer source setup
  equitylayer sources --workspace ABSOLUTE_PRIVATE_DIRECTORY
  equitylayer sources --workspace ABSOLUTE_PRIVATE_DIRECTORY --answers PRIVATE_JSON --confirm-local-source-use
  equitylayer sources --workspace ABSOLUTE_PRIVATE_DIRECTORY --resume-source SOURCE_ID

Complete first-use setup before this command. Keep its watch revision unchanged.
Choose the fixed TWSE monthly API, the local SEC filing index, or an existing private connector feed.
The SEC index detects filings. It does not supply financial statements or values.
ALLOWED requires a rights reference and explicit local-use confirmation.
This command cannot replace an existing policy, remove HOLD, approve commercial reuse, invoke AI, or start tracking.
It saves an observation schedule. Start it separately after review.
Never include credentials in source answers. Read docs/first-use.md.
`;
export class SourceSetupError extends Error { constructor(code) { super(code); this.name = "SourceSetupError"; this.code = code; } }
const fail = code => { throw new SourceSetupError(code); };
const copy = value => {
  try { return JSON.parse(canonicalJson(value)); }
  catch { fail("SOURCE_SETUP_INPUT_INVALID"); }
};
const exact = (value, keys) => {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== [...keys].sort().join()) fail("SOURCE_SETUP_INPUT_INVALID");
};
const stopped = signal => { if (signal?.aborted) fail("SOURCE_SETUP_CANCELLED"); };
const manifestName = (watchId, sourceId) => `source-setup.${contentHash({ watch_id: watchId, source_id: sourceId })}.local.json`;
const sourceIdText = value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)) fail("SOURCE_SETUP_INPUT_INVALID");
  return value;
};

export function sourceSetupPlan(value, setup, confirmLocalUse = false) {
  const answers = copy(value), scope = setup.init.scope;
  if (!answers || Array.isArray(answers) || Object.getPrototypeOf(answers) !== Object.prototype) fail("SOURCE_SETUP_INPUT_INVALID");
  const common = ["kind", "rights_status", "rights_reference", "allow_candidate_trials"];
  if (answers.kind === "twse_monthly_revenue_api") exact(answers, common);
  else if (answers.kind === "sec_submissions_api") exact(answers, [...common, "symbol", "cik", "user_agent"]);
  else if (answers.kind === "retained_directory") exact(answers, [...common, "directory", "source_id", "adapter_version", "parser_version", "issuer_map", "metric_definition_ids", "allowed_evidence_states", "max_source_age_ms", "interval_ms"]);
  else fail("SOURCE_SETUP_INPUT_INVALID");
  if (answers.rights_status === "ALLOWED" && confirmLocalUse !== true) fail("SOURCE_SETUP_LOCAL_USE_CONFIRMATION_REQUIRED");
  if (answers.rights_status !== "ALLOWED" && answers.allow_candidate_trials !== false) fail("SOURCE_SETUP_INPUT_INVALID");
  const twse = answers.kind === "twse_monthly_revenue_api", sec = answers.kind === "sec_submissions_api";
  const secFeed = sec ? validateSecFeed({ kind: answers.kind, symbol: answers.symbol, cik: answers.cik, user_agent: answers.user_agent }) : null;
  const issuerMap = twse ? Object.fromEntries(scope.symbols.filter(symbol => /^\d{4}\.TW$/.test(symbol)).map(symbol => [symbol, symbol.slice(0, 4)]))
    : sec ? { [answers.symbol]: answers.cik } : answers.issuer_map;
  if (!issuerMap || Object.keys(issuerMap).some(symbol => !scope.symbols.includes(symbol))) fail("SOURCE_SETUP_SCOPE_CONFLICT");
  if (twse && !Object.keys(issuerMap).length) fail("SOURCE_SETUP_TWSE_COMPANY_REQUIRED");
  if (!twse && !sec) {
    if (typeof answers.directory !== "string" || !isAbsolute(answers.directory)) fail("SOURCE_SETUP_FEED_UNSAFE");
    const info = lstatSync(answers.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077 || realpathSync(answers.directory) !== answers.directory) fail("SOURCE_SETUP_FEED_UNSAFE");
  }
  const policy = validateSourcePolicy({ schema_version: 1, revision: 1,
    source_id: twse ? TWSE_MONTHLY_SOURCE_ID : sec ? secSourceId(answers.cik) : sourceIdText(answers.source_id),
    rights_status: answers.rights_status, rights_reference: answers.rights_reference,
    allowed_purposes: answers.rights_status === "ALLOWED" ? ["local_research"] : [],
    adapter_version: twse ? TWSE_LOCAL_VERSION : sec ? SEC_SUBMISSIONS_VERSION : answers.adapter_version,
    parser_version: twse ? TWSE_LOCAL_VERSION : sec ? SEC_SUBMISSIONS_VERSION : answers.parser_version,
    issuer_map: issuerMap, metric_definition_ids: twse ? TWSE_MONTHLY_METRICS : sec ? [SEC_SUBMISSIONS_METRIC] : answers.metric_definition_ids,
    allowed_evidence_states: twse || sec ? ["PROVISIONAL"] : answers.allowed_evidence_states, max_source_age_ms: twse || sec ? 3 * 86400000 : answers.max_source_age_ms,
    allow_candidate_trials: answers.allow_candidate_trials });
  const schedule = validateScheduleConfig({ schema_version: 1,
    schedule_id: `el-source-${contentHash({ watch_id: scope.watch_id, source_id: policy.source_id }).slice(0, 24)}`,
    revision: 1, watch_id: scope.watch_id, scope_revision: scope.revision,
    method_sha256: setup.init.method_bundle.content_sha256, source_id: policy.source_id,
    budget_window: setup.init.budget.window_id,
    feed: twse ? { kind: "twse_monthly_revenue_api" } : sec ? secFeed : { kind: "retained_directory", directory: answers.directory },
    interval_ms: twse || sec ? 86400000 : answers.interval_ms, max_events: 20, max_runs: 0, tick_timeout_ms: 30000,
    run_policy: { max_attempts: 1, max_wall_ms: 120000, not_before: 0 }, runtime_sha256: null });
  return { policy, schedule };
}

function validateSnapshot(value, setup) {
  const record = copy(value);
  exact(record, ["schema_version", "setup_sha256", "policy", "schedule", "local_use_confirmed", "content_sha256"]);
  const { content_sha256, ...body } = record;
  if (record.schema_version !== 1 || contentHash(body) !== content_sha256 || record.setup_sha256 !== setup.content_sha256 ||
      typeof record.local_use_confirmed !== "boolean") fail("SOURCE_SETUP_SNAPSHOT_INVALID");
  const policy = validateSourcePolicy(record.policy), schedule = validateScheduleConfig(record.schedule);
  if (policy.revision !== 1 || schedule.revision !== 1 || schedule.max_runs !== 0 || schedule.runtime_sha256 !== null ||
      schedule.watch_id !== setup.init.scope.watch_id || schedule.scope_revision !== setup.init.scope.revision ||
      schedule.method_sha256 !== setup.init.method_bundle.content_sha256 || schedule.source_id !== policy.source_id ||
      schedule.budget_window !== setup.init.budget.window_id || policy.rights_status === "ALLOWED" && !record.local_use_confirmed ||
      Object.keys(policy.issuer_map).some(symbol => !setup.init.scope.symbols.includes(symbol))) fail("SOURCE_SETUP_SNAPSHOT_INVALID");
  const common = { kind: schedule.feed.kind, rights_status: policy.rights_status, rights_reference: policy.rights_reference,
    allow_candidate_trials: policy.allow_candidate_trials };
  const expected = sourceSetupPlan(schedule.feed.kind === "twse_monthly_revenue_api" ? common : schedule.feed.kind === "sec_submissions_api" ? {
    ...common, symbol: schedule.feed.symbol, cik: schedule.feed.cik, user_agent: schedule.feed.user_agent,
  } : {
    ...common, directory: schedule.feed.directory, source_id: policy.source_id, adapter_version: policy.adapter_version,
    parser_version: policy.parser_version, issuer_map: policy.issuer_map, metric_definition_ids: policy.metric_definition_ids,
    allowed_evidence_states: policy.allowed_evidence_states, max_source_age_ms: policy.max_source_age_ms, interval_ms: schedule.interval_ms,
  }, setup, record.local_use_confirmed);
  if (canonicalJson(expected.policy) !== canonicalJson(policy) || canonicalJson(expected.schedule) !== canonicalJson(schedule)) fail("SOURCE_SETUP_SNAPSHOT_INVALID");
  return record;
}

export async function setupSource({ workspace, answers, confirm_local_use = false, resume_source, signal },
  { clock = Date.now, fault = () => {} } = {}) {
  if (process.platform === "win32" || typeof process.getuid !== "function") fail("PLATFORM_UNVERIFIED");
  if (typeof workspace !== "string" || !isAbsolute(workspace) || /[\u0000-\u001f\u007f]/u.test(workspace)) fail("SOURCE_SETUP_PATH_INVALID");
  if (!existsSync(join(workspace, "research.sqlite"))) fail("SOURCE_SETUP_WORKSPACE_REQUIRED");
  stopped(signal);
  const setup = validateSetupSnapshot(readPrivateJson(join(workspace, "setup.local.json")));
  let snapshot;
  if (resume_source !== undefined) {
    if (answers !== undefined || confirm_local_use) fail("SOURCE_SETUP_FLAGS_INVALID");
    snapshot = validateSnapshot(readPrivateJson(join(workspace, manifestName(setup.init.scope.watch_id, sourceIdText(resume_source)))), setup);
    if (snapshot.policy.source_id !== resume_source) fail("SOURCE_SETUP_SNAPSHOT_INVALID");
  } else {
    const plan = sourceSetupPlan(answers, setup, confirm_local_use);
    const body = { schema_version: 1, setup_sha256: setup.content_sha256, ...plan, local_use_confirmed: confirm_local_use === true };
    snapshot = validateSnapshot({ ...body, content_sha256: contentHash(body) }, setup);
  }
  const ledger = new ResearchLedger(workspace, { clock, allow_migration: false, allow_creation: false });
  try {
    const watch = ledger.watch(setup.init.scope.watch_id);
    if (!watch || watch.current_revision !== setup.init.scope.revision ||
        canonicalJson(watch.revisions.find(revision => revision.revision === watch.current_revision)?.scope) !== canonicalJson(setup.init.scope)) fail("SOURCE_SETUP_SCOPE_CHANGED");
    ledger.verifyIntegrity(); ledger.budget(watch.watch_id, snapshot.schedule.budget_window);
    const currentPolicy = ledger.sourcePolicy(watch.watch_id, snapshot.policy.source_id), currentSchedule = ledger.scheduleStatus(snapshot.schedule.schedule_id);
    if (currentPolicy && canonicalJson(currentPolicy.policy) !== canonicalJson(snapshot.policy) ||
        currentSchedule && currentSchedule.config_sha256 !== contentHash(snapshot.schedule)) fail("SOURCE_SETUP_STATE_CHANGED");
    stopped(signal);
    const file = manifestName(watch.watch_id, snapshot.policy.source_id);
    saveSetupInput(workspace, file, snapshot); fault("source_setup:after_snapshot"); stopped(signal);
    const assertCurrent = () => {
      const currentWatch = ledger.watch(watch.watch_id), policy = ledger.sourcePolicy(watch.watch_id, snapshot.policy.source_id);
      const schedule = ledger.scheduleStatus(snapshot.schedule.schedule_id);
      if (currentWatch?.current_revision !== snapshot.schedule.scope_revision ||
          policy && canonicalJson(policy.policy) !== canonicalJson(snapshot.policy) ||
          schedule && schedule.config_sha256 !== contentHash(snapshot.schedule)) fail("SOURCE_SETUP_STATE_CHANGED");
    };
    assertCurrent();
    if (!currentPolicy) ledger.configureSourcePolicy(watch.watch_id, snapshot.policy);
    fault("source_setup:after_policy"); stopped(signal);
    assertCurrent();
    if (!currentSchedule) ledger.configureSchedule(snapshot.schedule);
    assertCurrent();
    const status = ledger.workspaceStatus(), scheduled = ledger.scheduleStatus(snapshot.schedule.schedule_id);
    return { status: snapshot.policy.rights_status !== "ALLOWED" ? "needs_source_rights" : scheduled.enabled ? "configured_not_running" : "stopped",
      source_id: snapshot.policy.source_id, rights_status: snapshot.policy.rights_status,
      rights_basis: "caller_declared_local_use_only", source_rights_verified: false, source_authenticity_verified: false, commercial_reuse_authorized: false,
      research_completion_verified: false, evidence_scope: snapshot.schedule.feed.kind === "twse_monthly_revenue_api"
        ? "issuer_total_monthly_revenue_only" : snapshot.schedule.feed.kind === "sec_submissions_api" ? "filing_index_metadata_only" : "caller_feed_declared_not_verified",
      watch_id: watch.watch_id, scope_revision: watch.current_revision,
      configured_symbols: Object.keys(snapshot.policy.issuer_map).sort(),
      missing_source_symbols: setup.init.scope.symbols.filter(symbol => !Object.hasOwn(snapshot.policy.issuer_map, symbol)),
      issuer_mapping_verified: false, candidate_method_use: snapshot.policy.allow_candidate_trials,
      schedule_id: snapshot.schedule.schedule_id, schedule_enabled: scheduled.enabled,
      max_runs: 0, counts: status.counts, existing_gates: status.gates.map(gate => gate.gate_code),
      tracking_started: false, model_called: false, network_called: false, payment_authorized: false, trading_authorized: false,
      snapshot_file: file, next_command: snapshot.policy.rights_status === "ALLOWED" && scheduled.enabled
        ? { executable: "equitylayer", args: ["local", "schedule-observe", "--workspace", workspace,
          "--schedule-id", snapshot.schedule.schedule_id, "--ticks", "1"] } : null };
  } finally { ledger.close(); }
}

export async function collectSourceAnswers(ask, scope, { signal } = {}) {
  const question = async (text, fallback) => {
    stopped(signal); const value = (await ask(`${text}${fallback === undefined ? "" : ` [${fallback}]`}: `)).trim(); stopped(signal);
    if (value === "/cancel") fail("SOURCE_SETUP_CANCELLED");
    if (!value && fallback === undefined) fail("SOURCE_SETUP_INPUT_INVALID");
    return value || fallback;
  };
  const kind = await question("Source: twse, sec, or retained", "twse");
  if (!["twse", "sec", "retained"].includes(kind)) fail("SOURCE_SETUP_INPUT_INVALID");
  const answers = { kind: kind === "twse" ? "twse_monthly_revenue_api" : kind === "sec" ? "sec_submissions_api" : "retained_directory" };
  if (kind === "sec") {
    answers.symbol = await question(`Selected US-listed symbol (${scope.symbols.join(", ")})`);
    answers.cik = await question("Issuer ten-digit SEC CIK, including leading zeros");
    answers.user_agent = await question("Your application name and contact email for SEC requests. Do not enter credentials");
  }
  if (kind === "retained") {
    answers.directory = await question("Absolute private directory from your existing connector");
    answers.source_id = await question("Connector source ID");
    answers.adapter_version = await question("Connector adapter version");
    answers.parser_version = await question("Connector parser version");
    answers.metric_definition_ids = (await question("Exact metric IDs, separated by commas")).split(",").map(value => value.trim());
    answers.allowed_evidence_states = (await question("Permitted evidence labels: PROVISIONAL, VERIFIED. Labels do not prove verification", "PROVISIONAL")).split(",").map(value => value.trim());
    answers.issuer_map = {};
    for (const symbol of scope.symbols) {
      const issuer = await question(`Issuer ID for ${symbol}, or - if this source does not cover it`, "-");
      if (issuer !== "-") answers.issuer_map[symbol] = issuer;
    }
    answers.max_source_age_ms = Number(await question("Maximum source age in milliseconds", "259200000"));
    answers.interval_ms = Number(await question("Polling interval in milliseconds", "86400000"));
  }
  answers.rights_status = await question("Local research rights: ALLOWED, HOLD, or UNKNOWN", "HOLD");
  answers.rights_reference = answers.rights_status === "ALLOWED" ? await question("Documented permission reference for your local use. Do not enter credentials") : null;
  const confirm_local_use = answers.rights_status === "ALLOWED"
    ? await question("Confirm your permitted local use. Type yes. This does not permit commercial redistribution", "no") === "yes" : false;
  if (answers.rights_status === "ALLOWED" && !confirm_local_use) fail("SOURCE_SETUP_CANCELLED");
  answers.allow_candidate_trials = answers.rights_status === "ALLOWED"
    ? await question("Permit candidate-method jobs from this source? Observation still cannot invoke AI. Type yes", "no") === "yes" : false;
  if (await question("Save this observation configuration? Type yes", "no") !== "yes") fail("SOURCE_SETUP_CANCELLED");
  return { answers, confirm_local_use };
}

export async function runSourceSetup(args, { stdout = text => process.stdout.write(text), ask, signal,
  input = process.stdin, promptOutput = process.stderr, ...dependencies } = {}) {
  let readline, releasePrompt;
  try {
    if (!args.length || args.length === 1 && args[0] === "--help") { stdout(HELP); return { exitCode: 0 }; }
    const options = {}, seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (!["--workspace", "--answers", "--confirm-local-source-use", "--resume-source"].includes(flag) || seen.has(flag)) fail("SOURCE_SETUP_FLAGS_INVALID");
      seen.add(flag);
      if (flag === "--confirm-local-source-use") { options.confirm_local_use = true; continue; }
      const value = args[++index];
      if (!value || value.startsWith("--")) fail("SOURCE_SETUP_FLAGS_INVALID");
      options[flag.slice(2)] = value;
    }
    if (!options.workspace || options["resume-source"] && (options.answers || options.confirm_local_use)) fail("SOURCE_SETUP_FLAGS_INVALID");
    if (!isAbsolute(options.workspace) || /[\u0000-\u001f\u007f]/u.test(options.workspace)) fail("SOURCE_SETUP_PATH_INVALID");
    if (options.answers && !isAbsolute(options.answers)) fail("SOURCE_SETUP_PATH_INVALID");
    let answers;
    if (!options["resume-source"]) {
      if (options.answers) answers = readPrivateJson(options.answers);
      else {
        if (!ask && (!input.isTTY || !promptOutput.isTTY)) fail("SOURCE_SETUP_INTERACTIVE_REQUIRED");
        if (!ask) {
          const parentSignal = signal, promptController = new AbortController(), cancel = () => promptController.abort();
          readline = createInterface({ input, output: promptOutput });
          // Terminal keys and EOF must cancel the same operation as a parent signal.
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
        const setup = validateSetupSnapshot(readPrivateJson(join(options.workspace, "setup.local.json")));
        const collected = await collectSourceAnswers(ask, setup.init.scope, { signal });
        answers = collected.answers; options.confirm_local_use = collected.confirm_local_use;
      }
    }
    const output = await setupSource({ workspace: options.workspace, answers, confirm_local_use: options.confirm_local_use,
      resume_source: options["resume-source"], signal }, dependencies);
    stdout(JSON.stringify(output) + "\n"); return { exitCode: 0, output };
  } catch (error) {
    const operationCode = localOperationCode(error);
    const code = error instanceof SourceSetupError || error instanceof SecSourceError ? error.code : signal?.aborted ? "SOURCE_SETUP_CANCELLED" : operationCode === "LOCAL_OPERATION_FAILED" ? "SOURCE_SETUP_OPERATION_FAILED" : operationCode;
    const output = { status: "error", code }; stdout(JSON.stringify(output) + "\n"); return { exitCode: 1, output };
  } finally { releasePrompt?.(); readline?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  runSourceSetup(process.argv.slice(2), { signal: controller.signal }).then(result => { process.exitCode = result.exitCode; }).finally(() => {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  });
}
