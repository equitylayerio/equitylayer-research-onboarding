#!/usr/bin/env node
import { constants, existsSync, fstatSync, lstatSync, openSync, closeSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ResearchLedger, LedgerError, restoreResearchLedger } from "./local/ledger.mjs";
import { publicScope, canonicalJson, contentHash, RunContractError } from "./local/run-contract.mjs";
import { verifyMethodBundle, ReferenceBridgeError } from "./local/reference-bridge.mjs";
import { validateSourcePolicy, EventPlanError } from "./local/source-event-plan.mjs";
import { createLocalCommandRuntime, CommandRuntimeError } from "./local/command-runtime.mjs";
import { createNativeResearchRuntime, NativeRuntimeError } from "./local/native-runtime.mjs";
import { executeClaimedRun, executeClaimedMethodTrial, ExecutorError } from "./local/executor.mjs";
import { MethodArtifactError, METHOD_RELEASE_GATE } from "./local/method-artifacts.mjs";
import { validateTrialRuntimePolicy, requireTrialRuntimePolicy } from "./local/trial-policy.mjs";
import { ScheduleError, validateScheduleConfig } from "./local/schedule-contract.mjs";
import { runScheduleWorker, scheduleRuntimeHash } from "./local/scheduler.mjs";
import { runContinuousWorker } from "./local/continuous-worker.mjs";
import { planLaunchAgent } from "./local/launchd-service.mjs";
import { ThesisError, validateThesisProposal, validateThesisReview } from "./local/thesis-contract.mjs";

const THESIS_HELP = "Thesis commands: thesis-propose, thesis-list, thesis-status, thesis-review.\nThesis writes require --input with private JSON. Thesis-status requires --thesis-id.\nThesis-list accepts --after and --limit. Thesis-status also accepts --review-after and --review-limit.\nThesis-review also requires --confirm-human-review. This flag declares the local owner's decision, not authenticated identity.\nProposals cannot accept evidence, approve source rights, invoke AI, pay, or trade.\n";
const THESIS_PAGE_FLAGS = { "thesis-list": ["--after", "--limit"], "thesis-status": ["--after", "--limit", "--review-after", "--review-limit"] };
const CONTINUOUS_HELP = "Continuous commands: schedule-daemon-observe, schedule-daemon-run.\nBoth require --schedule-id, --revision, --config-sha256, and --allow-continuous.\nDaemon-run also requires --runtime, --allow-private-context, and --allow-candidate-method.\nThe process remains active until cancellation or a retained stop. It installs no OS service.\n";
const RESUME_HELP = "Resume source checks: schedule-resume-observe --workspace PRIVATE_DIRECTORY --schedule-id ID --revision STOPPED_REVISION --config-sha256 EXACT_HASH --confirm-resume.\nThis command saves the next revision of the same stopped observation configuration.\nIt does not start a worker, invoke AI, change source permission, or release a budget.\nRequest new start instructions for the returned revision.\n";
const SERVICE_FLAGS = { "schedule-service-plan": ["--node", "--runtime"] };
const RUNTIME_HELP = "Native setup check: runtime-check --runtime PRIVATE_JSON --allow-native-check.\nThis command needs no workspace. It runs version and feature commands only.\nIt does not verify authentication, invoke a model, or authorize research.\n";
const UPGRADE_HELP = "Upgrade: upgrade --backup ABSOLUTE_PRIVATE_BACKUP --workspace NEW_DIRECTORY --allow-schema-upgrade.\nUpgrade restores and migrates a new copy. It does not change the original backup.\nStop workers before creating the backup with the old compatible client.\nNormal commands and restore refuse an older schema. They cannot authorize migration.\nA failed upgrade can retain a partial destination. Preserve it and use a new destination for another attempt.\nUpgrade does not start tracking, accept research, or release reserved budgets.\n";

const HELP = "Local research commands: init, intake, run, status, reconcile, backup, restore.\nRestore requires --backup with an absolute backup path and --workspace with a new directory.\nRestore does not overwrite an existing workspace.\nSchedule commands: schedule-configure, schedule-runtime, schedule-status, schedule-stop, schedule-observe, schedule-run.\nUse --schedule-id and --ticks for a finite schedule worker.\nSchedule-run requires runtime and private-input consent. Schedule-observe cannot invoke AI.\nMethod artifact commands: method-capture, method-candidate, method-plan, method-status.\nMethod trial commands: method-runtime-policy, method-enqueue, method-run, method-pair-status, method-resume.\nUse --workspace with an absolute private workspace path.\nMethod writes require --input with a private JSON file.\nMethod artifacts do not approve methods.\nRun requires --runtime, --allow-private-context, and --allow-candidate-method.\nMethod-run also requires --run-id and --allow-method-trial.\nThe local command adapter does not verify a model connection.\n";
class LocalCliError extends Error {
  constructor(code) { super(code); this.name = "LocalCliError"; this.code = code; }
}
const fail = (code) => { throw new LocalCliError(code); };
const exact = (value, required, optional = []) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) fail("INPUT_SCHEMA_INVALID");
};
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const boundedId = (value, max = 500) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const FLAG_SETS = {
  "runtime-check": ["--runtime", "--allow-native-check"],
  "thesis-propose": ["--workspace", "--input"], "thesis-list": ["--workspace"], "thesis-status": ["--workspace", "--thesis-id"],
  "thesis-review": ["--workspace", "--input", "--confirm-human-review"],
  init: ["--workspace", "--input"], intake: ["--workspace", "--input"],
  run: ["--workspace", "--runtime", "--allow-private-context", "--allow-candidate-method"],
  status: ["--workspace"], reconcile: ["--workspace", "--input"], backup: ["--workspace", "--name"],
  restore: ["--workspace", "--backup"], upgrade: ["--workspace", "--backup", "--allow-schema-upgrade"],
  "method-capture": ["--workspace", "--input"], "method-candidate": ["--workspace", "--input"],
  "method-plan": ["--workspace", "--input"], "method-status": ["--workspace"],
  "method-runtime-policy": ["--workspace", "--runtime"], "method-enqueue": ["--workspace", "--input"],
  "method-run": ["--workspace", "--run-id", "--runtime", "--allow-private-context", "--allow-candidate-method", "--allow-method-trial"],
  "method-pair-status": ["--workspace", "--pair-id"], "method-resume": ["--workspace", "--input"],
  "schedule-configure": ["--workspace", "--input"], "schedule-runtime": ["--workspace", "--runtime"],
  "schedule-status": ["--workspace", "--schedule-id"], "schedule-stop": ["--workspace", "--schedule-id"],
  "schedule-resume-observe": ["--workspace", "--schedule-id", "--revision", "--config-sha256", "--confirm-resume"],
  "schedule-observe": ["--workspace", "--schedule-id", "--ticks"],
  "schedule-daemon-observe": ["--workspace", "--schedule-id", "--revision", "--config-sha256", "--allow-continuous"],
  "schedule-daemon-run": ["--workspace", "--schedule-id", "--revision", "--config-sha256", "--allow-continuous", "--runtime", "--allow-private-context", "--allow-candidate-method"],
  "schedule-service-plan": ["--workspace", "--schedule-id", "--revision", "--config-sha256", "--node"],
  "schedule-run": ["--workspace", "--schedule-id", "--ticks", "--runtime", "--allow-private-context", "--allow-candidate-method"]
};
function parse(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("CLI_ARGUMENTS_INVALID");
  if (!args.length || args.length === 1 && args[0] === "--help") return { help: true };
  const [command, ...rest] = args;
  if (!Object.hasOwn(FLAG_SETS, command)) fail("CLI_COMMAND_INVALID");
  const options = { command }; const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (![...FLAG_SETS[command], ...(THESIS_PAGE_FLAGS[command] ?? []), ...(SERVICE_FLAGS[command] ?? [])].includes(flag) || seen.has(flag)) fail("CLI_FLAGS_INVALID");
    seen.add(flag);
    if (flag.startsWith("--allow-") || flag === "--confirm-human-review" || flag === "--confirm-resume") { options[flag.slice(2)] = true; continue; }
    const value = rest[++index];
    if (!value || value.startsWith("--") || value.includes("\0")) fail("CLI_FLAGS_INVALID");
    options[flag.slice(2)] = value;
  }
  if (FLAG_SETS[command].some((flag) => !seen.has(flag))) fail(command === "upgrade" && !seen.has("--allow-schema-upgrade") ? "SCHEMA_UPGRADE_CONSENT_REQUIRED" : command === "thesis-review" && !seen.has("--confirm-human-review") ? "THESIS_HUMAN_REVIEW_REQUIRED" : ["run", "method-run", "schedule-run"].includes(command) ? "RUN_CONSENT_REQUIRED" : "CLI_FLAGS_INVALID");
  if (command !== "runtime-check" && !isAbsolute(options.workspace)) fail("WORKSPACE_PATH_INVALID");
  if (command === "backup" && (!/^[a-zA-Z0-9_-]{1,100}\.sqlite$/.test(options.name) || options.name === "research.sqlite")) fail("BACKUP_NAME_INVALID");
  if (["restore", "upgrade"].includes(command) && !isAbsolute(options.backup)) fail("BACKUP_PATH_INVALID");
  if (options.ticks !== undefined && (!/^[1-9][0-9]{0,3}$/.test(options.ticks) || Number(options.ticks) > 1000)) fail("CLI_FLAGS_INVALID");
  if (options.revision !== undefined && (!/^[1-9][0-9]*$/.test(options.revision) || !Number.isSafeInteger(Number(options.revision)))) fail("CLI_FLAGS_INVALID");
  if (options["config-sha256"] !== undefined && !/^[a-f0-9]{64}$/.test(options["config-sha256"])) fail("CLI_FLAGS_INVALID");
  for (const field of ["after", "limit", "review-after", "review-limit"]) if (options[field] !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(options[field]) || !Number.isSafeInteger(Number(options[field])) ||
        field.endsWith("limit") && (Number(options[field]) < 1 || Number(options[field]) > 100)) fail("CLI_FLAGS_INVALID");
  }
  return options;
}

function readBounded(path, maximum, privateFile) {
  let descriptor;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || before.size > maximum ||
        (privateFile ? before.nlink !== 1 || (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0)) fail("INPUT_FILE_UNSAFE");
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = fstatSync(descriptor);
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.uid !== before.uid ||
        current.mode !== before.mode || current.nlink !== before.nlink || current.size > maximum) fail("INPUT_FILE_UNSAFE");
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) {
      const amount = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!amount) break;
      length += amount;
    }
    if (length > maximum) fail("INPUT_FILE_LIMIT");
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof LocalCliError) throw error;
    fail("INPUT_FILE_ACCESS_FAILED");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function readJson(path) {
  const bytes = readBounded(path, 1_000_000, true);
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); canonicalJson(value); }
  catch { fail("INPUT_JSON_INVALID"); }
  return value;
}
function initConfig(value) {
  exact(value, ["scope", "private_context", "method_bundle", "budget", "source_policies"]);
  publicScope(value.scope); verifyMethodBundle(value.method_bundle);
  if (!value.private_context || typeof value.private_context !== "object" || Array.isArray(value.private_context)) fail("INPUT_SCHEMA_INVALID");
  exact(value.budget, ["window_id", "limits"]); exact(value.budget.limits, ["requests", "tokens", "cost_microusd", "wall_ms"]);
  if (!boundedId(value.budget.window_id) || !Object.values(value.budget.limits).every(nonnegative) ||
      !Array.isArray(value.source_policies) || value.source_policies.length > 100) fail("INPUT_SCHEMA_INVALID");
  value.source_policies.forEach(validateSourcePolicy);
  if (new Set(value.source_policies.map((policy) => policy.source_id)).size !== value.source_policies.length) fail("INPUT_SCHEMA_INVALID");
  return value;
}
function runtimeConfig(value) {
  const native = Object.hasOwn(value ?? {}, "native");
  exact(value, [native ? "native" : "command", "execution"]);
  if (!native) exact(value.command, ["allow_local_command", "executable", "args", "identity"],
    ["env", "timeout_ms", "max_input_bytes", "max_output_bytes", "max_stderr_bytes"]);
  exact(value.execution, ["estimate"], ["timeout_ms", "heartbeat_ms", "lease_ms", "retry_delay_ms"]);
  exact(value.execution.estimate, ["tokens", "cost_microusd", "wall_ms"]);
  if (!Object.values(value.execution.estimate).every(nonnegative)) fail("INPUT_SCHEMA_INVALID");
  for (const [key, maximum] of [["timeout_ms", 3_600_000], ["heartbeat_ms", 60_000], ["lease_ms", 3_600_000], ["retry_delay_ms", 60_000]]) {
    const number = value.execution[key];
    if (number !== undefined && (!Number.isSafeInteger(number) || number < (key === "retry_delay_ms" ? 0 : 1) || number > maximum)) fail("INPUT_SCHEMA_INVALID");
  }
  return { runtime: native ? createNativeResearchRuntime(value.native) : createLocalCommandRuntime(value.command), execution: value.execution };
}
// Setup reuses these contracts. It does not define a second runtime or init format.
export { readJson as readPrivateJson, initConfig as validateLocalInit, runtimeConfig as validateLocalRuntime };
function decision(value) {
  exact(value, ["request_id", "receipt_sha256", "reason", "reconciliation_id", "resume"]);
  if (!boundedId(value.request_id) || !boundedId(value.reconciliation_id) || !boundedId(value.reason, 1200) ||
      !/^[a-f0-9]{64}$/.test(value.receipt_sha256) || typeof value.resume !== "boolean") fail("INPUT_SCHEMA_INVALID");
  return value;
}
const safeCode = (error) => [LocalCliError, LedgerError, RunContractError, ReferenceBridgeError, EventPlanError,
  CommandRuntimeError, NativeRuntimeError, ExecutorError, MethodArtifactError, ScheduleError, ThesisError].some((type) => error instanceof type) && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ? error.code : "LOCAL_OPERATION_FAILED";
export { safeCode as localOperationCode };

// This entry performs local work only. It does not authorize payments or trades.
export async function runLocal(args, { stdout = (value) => process.stdout.write(value), clock = Date.now,
  owner = `local-cli-${randomUUID()}`, ledgerOptions = {}, signal } = {}) {
  let ledger;
  const emit = (value, exitCode = 0) => { stdout(`${JSON.stringify(value)}\n`); return { exitCode, output: value }; };
  try {
    const options = parse(args);
    if (options.help) { stdout(HELP + UPGRADE_HELP + RUNTIME_HELP + CONTINUOUS_HELP + RESUME_HELP + THESIS_HELP); return { exitCode: 0 }; }
    let input, commandRuntime;
    if (options.input) input = readJson(options.input);
    if (options.command === "init") initConfig(input);
    if (options.command === "intake") {
      exact(input, ["event", "artifact", "facts", "watch_id", "method_sha256", "evaluation_at", "budget_window", "run_policy", "raw_file"]);
      if (typeof input.raw_file !== "string" || !isAbsolute(input.raw_file)) fail("RAW_FILE_PATH_INVALID");
      const { raw_file, ...rest } = input; input = { ...rest, bytes: readBounded(raw_file, 2_000_000, false) };
    }
    if (options.runtime) commandRuntime = runtimeConfig(readJson(options.runtime));
    if (options.command === "runtime-check") {
      if (typeof commandRuntime.runtime.inspect !== "function") fail("NATIVE_CHECK_UNSUPPORTED");
      return emit({ status: "configuration_checked", ...await commandRuntime.runtime.inspect({ signal }),
        runtime_sha256: scheduleRuntimeHash(commandRuntime.runtime, commandRuntime.execution), execution_authorized: false });
    }
    if (["restore", "upgrade"].includes(options.command)) {
      ledger = restoreResearchLedger(options.backup, options.workspace, { ...ledgerOptions, clock,
        allow_creation: false, allow_migration: options.command === "upgrade" });
      return emit({ status: options.command === "upgrade" ? "upgraded_copy" : "restored", schema_version: ledger.verifyIntegrity().schema_version,
        counts: ledger.workspaceStatus().counts,
        execution_authorized: false, accepted_new_evidence: false, accepted_new_interpretation: false });
    }
    if (options.command === "reconcile") decision(input);
    if (options.command === "schedule-configure") validateScheduleConfig(input);
    if (options.command === "thesis-propose") validateThesisProposal(input);
    if (options.command === "thesis-review") validateThesisReview(input);
    if (options.command !== "init" && !existsSync(join(options.workspace, "research.sqlite"))) fail("WORKSPACE_MISSING");
    ledger = new ResearchLedger(options.workspace, { ...ledgerOptions, clock,
      allow_migration: false, allow_creation: options.command === "init" });
    if (options.command === "thesis-propose") return emit({ status: "candidate", ...ledger.proposeThesis(input), quality_verified: false });
    const thesisPage = { after: Number(options.after ?? 0), limit: Number(options.limit ?? 20) };
    if (options.command === "thesis-list") {
      const items = ledger.pageTheses(thesisPage);
      return emit({ items, next_after: items.at(-1)?.sequence ?? thesisPage.after, has_more: items.length === thesisPage.limit, quality_verified: false });
    }
    if (options.command === "thesis-status") {
      const current = ledger.thesis(options["thesis-id"], { ...thesisPage, review_after: Number(options["review-after"] ?? 0), review_limit: Number(options["review-limit"] ?? 20) });
      if (!current) fail("THESIS_REFERENCE_MISSING");
      return emit(current);
    }
    if (options.command === "thesis-review") return emit(ledger.reviewThesis(input, { confirm_human_review: options["confirm-human-review"] }));
    if (options.command === "schedule-configure") return emit({ status: "configured", ...ledger.configureSchedule(input), research_completion_verified: false });
    if (options.command === "schedule-runtime") return emit({ runtime_sha256: scheduleRuntimeHash(commandRuntime.runtime, commandRuntime.execution),
      execution_authorized: false, model_connection_verified: false });
    if (options.command === "schedule-status") {
      const current = ledger.scheduleStatus(options["schedule-id"]);
      if (!current) fail("SCHEDULE_MISSING");
      return emit(current);
    }
    if (options.command === "schedule-stop") return emit(ledger.stopSchedule(options["schedule-id"]));
    if (options.command === "schedule-resume-observe") return emit({ status: "configuration_saved",
      ...ledger.resumeObservationSchedule(options["schedule-id"], { revision: Number(options.revision),
        config_sha256: options["config-sha256"], confirm_resume: options["confirm-resume"] }) });
    if (options.command === "schedule-service-plan") {
      const current = ledger.scheduleStatus(options["schedule-id"]);
      if (!current?.enabled || current.revision !== Number(options.revision) || current.config_sha256 !== options["config-sha256"]) fail("WORKER_CONFIG_CHANGED");
      return emit(planLaunchAgent({ workspace: options.workspace, node: options.node, schedule_id: options["schedule-id"],
        revision: Number(options.revision), config_sha256: options["config-sha256"], ...(options.runtime ? { runtime: options.runtime } : {}) }));
    }
    if (["schedule-daemon-observe", "schedule-daemon-run"].includes(options.command)) {
      const output = await runContinuousWorker(ledger, options["schedule-id"], { owner, clock, signal,
        expected: { revision: Number(options.revision), config_sha256: options["config-sha256"] },
        ...(commandRuntime ? { runtime: commandRuntime.runtime, execution: commandRuntime.execution,
          allow_private_context: true, allow_candidate_method: true } : {}), onTick: tick => emit(tick) });
      return emit({ ...output, background_service_installed: false }, output.status === "failed" ? 1 : output.status === "busy" ? 2 : 0);
    }
    if (["schedule-observe", "schedule-run"].includes(options.command)) {
      let gated = false;
      const output = await runScheduleWorker(ledger, options["schedule-id"], { owner, clock, signal, ticks: Number(options.ticks),
        ...(commandRuntime ? { runtime: commandRuntime.runtime, execution: commandRuntime.execution,
          allow_private_context: true, allow_candidate_method: true } : {}),
        onTick: (tick) => { if (tick.status !== "completed") gated = true; emit(tick); } });
      return emit({ status: "worker_finished", ...output, background_service_installed: false }, gated || output.busy || output.stopped ? 2 : 0);
    }
    if (options.command === "method-runtime-policy") {
      const retained = validateTrialRuntimePolicy({ schema_version: 1, runtime: { identity: commandRuntime.runtime.identity,
        config_sha256: commandRuntime.runtime.config_sha256 }, execution: commandRuntime.execution });
      return emit({ status: "declared", policy: retained.policy, sha256: retained.sha256 });
    }
    if (options.command === "method-enqueue") return emit({ status: "queued", ...ledger.enqueueMethodTrialPair(input) });
    if (options.command === "method-resume") return emit(ledger.resumeMethodTrial(input));
    if (options.command === "method-pair-status") {
      const pair = ledger.methodTrialPair(options["pair-id"]);
      if (!pair) fail("METHOD_TRIAL_REFERENCE_MISSING");
      return emit({ pair_id: pair.pair_id, sha256: pair.sha256, outputs: pair.outputs.map(output => ({ run_id: output.run_id, sha256: output.sha256 })),
        roles: ["incumbent", "candidate"].map(role => ({ role, run_id: pair[role].run_id, status: pair[role].status, gate_code: pair[role].gate_code })),
        method_release_gate: METHOD_RELEASE_GATE, quality_verified: false });
    }
    if (options.command === "method-run") {
      const runId = options["run-id"], run = ledger.run(runId);
      if (!run?.envelope.trial) fail("METHOD_TRIAL_REQUIRED");
      const retained = ledger.methodTrialRuntimePolicy(runId);
      const execution = { ...commandRuntime.execution, runtime_policy: retained.policy, clock,
        allow_private_context: true, allow_candidate_method: true, allow_method_trial: true };
      requireTrialRuntimePolicy(retained.sha256, retained.policy, commandRuntime.runtime, execution);
      const lease = ledger.claimMethodTrial(runId, owner, execution.lease_ms);
      if (!lease) {
        const current = ledger.run(runId);
        return emit({ status: current.status, run_id: runId, gate_code: current.gate_code }, current.status === "completed" ? 0 : 2);
      }
      const output = await executeClaimedMethodTrial(ledger, lease, commandRuntime.runtime, execution);
      return emit({ status: output.status, run_id: runId, ...(output.code ? { code: output.code } : {}),
        ...(output.trial_output ? { output_sha256: output.trial_output.sha256 } : {}) }, output.status === "completed" ? 0 : 2);
    }
    if (options.command === "init") {
      const saved = ledger.saveRevision(input.scope, input.private_context); const method = ledger.retainMethod(input.method_bundle);
      ledger.configureBudget(saved.scope.watch_id, input.budget.window_id, input.budget.limits);
      input.source_policies.forEach((policy) => ledger.configureSourcePolicy(saved.scope.watch_id, policy));
      return emit({ status: "initialized", watch_id: saved.scope.watch_id, revision: saved.scope.revision, method_sha256: method.bundle_sha256 });
    }
    if (options.command === "intake") {
      const accepted = ledger.intakeSourceEvent(input);
      return emit({ status: accepted.decision.outcome, run_id: accepted.run?.run_id ?? null,
        decision_id: `el-event-decision-${contentHash(accepted.decision)}`, gate_code: accepted.decision.gate_code ?? null, reused: accepted.reused }, accepted.decision.outcome === "gated" ? 2 : 0);
    }
    if (options.command === "run") {
      const lease = ledger.claim(owner, commandRuntime.execution.lease_ms ?? 30_000);
      if (!lease) {
        const gates = [...new Set((ledger.workspaceStatus().gates ?? []).map((gate) => gate.gate_code))];
        return gates.length ? emit({ status: "gated", gates }, 2) : emit({ status: "idle" });
      }
      const output = await executeClaimedRun(ledger, lease, commandRuntime.runtime, { ...commandRuntime.execution, clock,
        allow_private_context: true, allow_candidate_method: true });
      return emit({ status: output.status, run_id: lease.run_id, ...(output.code ? { code: output.code } : {}),
        ...(output.result ? { result_id: output.result.result_id } : {}), ...(output.delivery ? { delivery_id: output.delivery.delivery_id } : {}) }, output.status === "completed" ? 0 : 2);
    }
    if (options.command === "status") return emit(ledger.workspaceStatus());
    if (options.command === "method-status") {
      const status = ledger.methodImprovementStatus();
      return emit({ status: "gated", counts: status.counts, gate_code: status.release_gate }, 2);
    }
    if (["method-capture", "method-candidate", "method-plan"].includes(options.command)) {
      const artifact = options.command === "method-capture" ? ledger.captureMethodCase(input)
        : options.command === "method-candidate" ? ledger.retainMethodCandidate(input) : ledger.freezeMethodPlan(input);
      const summary = { artifact_id: artifact.artifact_id, sha256: artifact.sha256, reused: artifact.reused };
      if (options.command === "method-candidate") return emit({ ...summary, status: "candidate" });
      if (options.command === "method-plan") return emit({ ...summary, status: "gated", gate_code: METHOD_RELEASE_GATE }, 2);
      return emit(summary);
    }
    if (options.command === "reconcile") {
      const reconciled = ledger.reconcileRequestUsage(input.request_id, input.receipt_sha256, input.reason, input.reconciliation_id, { resume: input.resume });
      return emit({ status: reconciled.status ?? "reused", request_id: reconciled.request_id, reused: reconciled.reused, budget_gate: reconciled.budget_gate ?? null });
    }
    ledger.backup(options.name);
    return emit({ status: "backed_up", name: options.name });
  } catch (error) { return emit({ status: "error", code: safeCode(error) }, 1); }
  finally { if (ledger) { try { ledger.close(); } catch { /* Preserve the reported operation result. */ } } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  runLocal(process.argv.slice(2), { signal: controller.signal }).then((result) => { process.exitCode = result.exitCode; }).catch(() => {
    process.stderr.write("LOCAL_OPERATION_FAILED\n"); process.exitCode = 1;
  }).finally(() => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); });
}
