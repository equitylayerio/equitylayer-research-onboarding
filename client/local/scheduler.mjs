import { randomUUID } from "node:crypto";
import { contentHash } from "./run-contract.mjs";
import { executeClaimedRun } from "./executor.mjs";
import { readRetainedFeed } from "./retained-feed.mjs";
import { ScheduleError } from "./schedule-contract.mjs";
import { readTwseMonthlySource } from "./twse-monthly-source.mjs";
import { readSecSubmissionsSource } from "./sec-submissions-source.mjs";

export function scheduleRuntimeHash(runtime, execution) {
  if (!runtime || typeof runtime.execute !== "function" || typeof runtime.identity !== "string" ||
      !/^[a-f0-9]{64}$/.test(runtime.config_sha256) || !execution || typeof execution !== "object" || Array.isArray(execution) ||
      Object.keys(execution).some(key => !["estimate", "timeout_ms", "heartbeat_ms", "lease_ms", "retry_delay_ms"].includes(key))) {
    throw new ScheduleError("SCHEDULE_RUNTIME_INVALID", "Use a declared caller runtime and bounded execution settings.");
  }
  return contentHash({ runtime: { identity: runtime.identity, config_sha256: runtime.config_sha256 }, execution });
}

// Each tick observes public evidence and optionally invokes the approved caller runtime.
// Method trials never enter this research scheduler.
export async function processScheduleTick(ledger, scheduleId, { owner = `schedule-${randomUUID()}`, clock = Date.now,
  runtime, execution, allow_private_context = false, allow_candidate_method = false, signal, source_fetch_impl, worker_lease } = {}) {
  validateSignal(signal);
  const lease = ledger.claimSchedule(scheduleId, owner, 30_000, { worker_lease });
  if (!lease) return { status: "waiting", schedule: ledger.scheduleStatus(scheduleId) };
  let events = 0, deliveries = 0, timer, heartbeat;
  const codes = new Set(); const controller = new AbortController();
  const stop = () => { codes.add("SCHEDULE_STOP_REQUESTED"); controller.abort(); };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const finish = (status) => ({ status, tick: ledger.finishSchedule(lease, { status, events, deliveries, codes: [...codes] }) });
  try {
    const heartbeatMs = Math.max(1, Math.min(5000, Math.floor((lease.lease_until - clock()) / 3)));
    heartbeat = setInterval(() => {
      try { ledger.heartbeatSchedule(lease); }
      catch { codes.add("SCHEDULE_LEASE_LOST"); controller.abort(); }
    }, heartbeatMs);
    timer = setTimeout(() => { codes.add("SCHEDULE_DEADLINE_EXCEEDED"); controller.abort(); }, lease.config.tick_timeout_ms);
    if (controller.signal.aborted) return finish("failed");
    const records = lease.config.feed.kind === "twse_monthly_revenue_api"
      ? await readTwseMonthlySource(ledger, lease.config, { fetch_impl: source_fetch_impl, signal: controller.signal, clock })
      : lease.config.feed.kind === "sec_submissions_api"
        ? await readSecSubmissionsSource(ledger, lease.config, { fetch_impl: source_fetch_impl, signal: controller.signal, clock })
        : readRetainedFeed(lease.config);
    if (!records.length) { codes.add("SOURCE_FEED_EMPTY"); return finish("gated"); }
    for (const source of records) {
      if (controller.signal.aborted) return finish("failed");
      const observed = ledger.intakeSourceEvent({ ...source, watch_id: lease.config.watch_id, method_sha256: lease.config.method_sha256,
        evaluation_at: new Date(clock()).toISOString(), budget_window: lease.config.budget_window,
        run_policy: lease.config.run_policy, schedule_lease: lease });
      events++;
      if (observed.decision.outcome === "gated") codes.add(observed.decision.gate_code);
    }
    if (lease.config.max_runs > 0) {
      if (!allow_private_context || !allow_candidate_method || !runtime || !execution) codes.add("CALLER_RUNTIME_CONSENT_REQUIRED");
      else if (scheduleRuntimeHash(runtime, execution) !== lease.config.runtime_sha256) codes.add("SCHEDULE_RUNTIME_CHANGED");
      else for (let index = 0; index < lease.config.max_runs; index++) {
        if (controller.signal.aborted) break;
        const runLease = ledger.claim(owner, execution.lease_ms ?? 30_000, { schedule_lease: lease });
        if (!runLease) break;
        const output = await executeClaimedRun(ledger, runLease, runtime, { ...execution, clock,
          allow_private_context: true, allow_candidate_method: true, signal: controller.signal });
        if (output.status === "completed") deliveries++;
        else codes.add(output.code ?? "RESEARCH_EXECUTION_GATED");
      }
    }
    return finish(codes.size ? "gated" : "completed");
  } catch (error) {
    const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "SCHEDULE_OPERATION_FAILED";
    codes.add(code);
    try { return finish("failed"); }
    catch (failure) {
      if (["SCHEDULE_LEASE_LOST", "SCHEDULE_SCOPE_CHANGED"].includes(failure.code)) return { status: "interrupted", code: failure.code };
      throw failure;
    }
  } finally {
    clearTimeout(timer); clearInterval(heartbeat); signal?.removeEventListener("abort", stop); controller.abort();
  }
}

// This finite worker does not install an operating-system service.
export async function runScheduleWorker(ledger, scheduleId, { ticks = 1, signal, onTick = () => {}, ...options } = {}) {
  validateSignal(signal);
  if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 1000) throw new ScheduleError("SCHEDULE_WORKER_LIMIT", "Use one to one thousand worker ticks.");
  const clock = options.clock ?? Date.now; let completed = 0, busy = false;
  while (completed < ticks && !signal?.aborted) {
    const status = ledger.scheduleStatus(scheduleId);
    if (!status) throw new ScheduleError("SCHEDULE_MISSING", "Configure a schedule before starting the worker.");
    if (!status.enabled) break;
    const delay = Math.max(0, Math.min(status.next_due - clock(), 60_000));
    if (delay) {
      await new Promise(resolve => {
        const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); resolve(); };
        const timer = setTimeout(stop, delay); signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
      });
      continue;
    }
    const output = await processScheduleTick(ledger, scheduleId, { ...options, signal });
    if (output.status === "waiting") {
      busy = output.schedule?.state === "running" || ledger.scheduleWorkerStatus(scheduleId).state === "monitoring";
      break;
    }
    completed++; await onTick(output);
  }
  return { ticks: completed, stopped: Boolean(signal?.aborted), busy, schedule: ledger.scheduleStatus(scheduleId) };
}

function validateSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new ScheduleError("SCHEDULE_SIGNAL_INVALID", "Use an AbortSignal for worker cancellation.");
}
