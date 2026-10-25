import { randomUUID } from "node:crypto";
import { processScheduleTick, scheduleRuntimeHash } from "./scheduler.mjs";
import { ScheduleError } from "./schedule-contract.mjs";

const safeCode = error => typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "WORKER_OPERATION_FAILED";
function wait(ms, signal) {
  return new Promise(resolve => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(); };
    const timer = setTimeout(stop, ms); signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

// A supervisor can run this process. It does not install or enable an OS service.
export async function runContinuousWorker(ledger, scheduleId, { expected, signal, owner = `continuous-${randomUUID()}`,
  clock = Date.now, lease_ms = 15_000, heartbeat_ms = 3000, poll_ms = 1000, acquire_timeout_ms = 60_000, onTick = () => {},
  runtime, execution, allow_private_context = false, allow_candidate_method = false, source_fetch_impl } = {}) {
  if (!(signal instanceof AbortSignal) || !Number.isSafeInteger(heartbeat_ms) || heartbeat_ms < 1 ||
      !Number.isSafeInteger(lease_ms) || lease_ms < 1000 || lease_ms > 60_000 || heartbeat_ms * 3 > lease_ms ||
      !Number.isSafeInteger(poll_ms) || poll_ms < 1 || poll_ms > 5000 || !Number.isSafeInteger(acquire_timeout_ms) ||
      acquire_timeout_ms < 0 || acquire_timeout_ms > 60_000 || typeof onTick !== "function") {
    throw new ScheduleError("WORKER_OPTIONS_INVALID", "Use cancellation and bounded heartbeat and polling intervals.");
  }
  if (signal.aborted) return { status: "stopped", code: "WORKER_PROCESS_STOPPED", ticks: 0 };
  const acquisitionDeadline = Date.now() + acquire_timeout_ms;
  let lease;
  while (!signal.aborted) {
    lease = ledger.claimScheduleWorker(scheduleId, owner, expected, lease_ms);
    if (lease || Date.now() >= acquisitionDeadline) break;
    await wait(Math.min(poll_ms, acquisitionDeadline - Date.now()), signal);
  }
  if (!lease) return { status: signal.aborted ? "stopped" : "busy", code: signal.aborted ? "WORKER_PROCESS_STOPPED" : "WORKER_ALREADY_RUNNING", ticks: 0 };
  const controller = new AbortController(); let code = "WORKER_PROCESS_STOPPED", failed = false, ticks = 0;
  const stop = () => controller.abort(); signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const heartbeat = setInterval(() => {
    try { ledger.heartbeatScheduleWorker(lease, lease_ms); }
    catch (error) { code = safeCode(error); failed = !["WORKER_SCHEDULE_STOPPED", "WORKER_CONFIG_CHANGED", "WORKER_SCOPE_CHANGED"].includes(code); controller.abort(); }
  }, heartbeat_ms);
  try {
    if (lease.config.max_runs > 0 && (!allow_private_context || !allow_candidate_method || !runtime || !execution)) {
      throw new ScheduleError("CALLER_RUNTIME_CONSENT_REQUIRED", "Approve the exact caller runtime before continuous research execution.");
    }
    if (lease.config.max_runs > 0 && scheduleRuntimeHash(runtime, execution) !== lease.config.runtime_sha256) {
      throw new ScheduleError("SCHEDULE_RUNTIME_CHANGED", "Start continuous research with the pinned runtime only.");
    }
    while (!controller.signal.aborted) {
      const status = ledger.scheduleStatus(scheduleId);
      if (!status?.enabled) { code = "WORKER_SCHEDULE_STOPPED"; break; }
      if (status.revision !== lease.revision || status.config_sha256 !== lease.config_sha256) { code = "WORKER_CONFIG_CHANGED"; break; }
      if (status.next_due > clock()) { await wait(Math.min(poll_ms, status.next_due - clock()), controller.signal); continue; }
      const output = await processScheduleTick(ledger, scheduleId, { owner, clock, worker_lease: lease, signal: controller.signal,
        runtime, execution, allow_private_context, allow_candidate_method, source_fetch_impl });
      if (output.status === "interrupted") {
        const current = ledger.scheduleStatus(scheduleId);
        if (!current?.enabled) { code = "WORKER_SCHEDULE_STOPPED"; failed = false; }
        else if (current.revision !== lease.revision || current.config_sha256 !== lease.config_sha256) { code = "WORKER_CONFIG_CHANGED"; failed = false; }
        else if (ledger.watch(lease.config.watch_id).current_revision !== lease.config.scope_revision) { code = "WORKER_SCOPE_CHANGED"; failed = false; }
        else if (!controller.signal.aborted) { code = output.code; failed = true; }
        break;
      }
      if (output.status === "waiting") { await wait(poll_ms, controller.signal); continue; }
      ticks++; await onTick(output);
    }
  } catch (error) { code = safeCode(error); failed = true; }
  finally {
    clearInterval(heartbeat); signal.removeEventListener("abort", stop); controller.abort();
    try { ledger.finishScheduleWorker(lease, code, failed); }
    catch (error) { if (safeCode(error) !== "WORKER_LEASE_LOST") { code = safeCode(error); failed = true; } }
  }
  return { status: failed ? "failed" : "stopped", code, ticks };
}
