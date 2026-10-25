import { isAbsolute } from "node:path";
import { canonicalJson, contentHash } from "./run-contract.mjs";
import { validateSecFeed, secSourceId } from "./sec-submissions-contract.mjs";

export const SCHEDULE_SCHEMA = `
CREATE TABLE schedule_configs(schedule_id TEXT NOT NULL,revision INTEGER NOT NULL,watch_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,
 sha256 TEXT NOT NULL,config_json TEXT NOT NULL,PRIMARY KEY(schedule_id,revision),
 FOREIGN KEY(watch_id,scope_revision) REFERENCES revisions(watch_id,revision)) STRICT;
CREATE TABLE schedule_state(schedule_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,next_due INTEGER NOT NULL,
 fence INTEGER NOT NULL,owner TEXT,lease_until INTEGER,started_at INTEGER,last_finished_at INTEGER,last_tick_id TEXT,
 FOREIGN KEY(schedule_id,revision) REFERENCES schedule_configs(schedule_id,revision)) STRICT;
CREATE TABLE schedule_ticks(tick_id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,revision INTEGER NOT NULL,fence INTEGER NOT NULL,
 sha256 TEXT NOT NULL,record_json TEXT NOT NULL,FOREIGN KEY(schedule_id,revision) REFERENCES schedule_configs(schedule_id,revision)) STRICT;
PRAGMA user_version=7;`;
export const SCHEDULE_RUN_BINDING_SCHEMA = `
CREATE TABLE schedule_run_leases(run_id TEXT NOT NULL REFERENCES runs(run_id),run_fence INTEGER NOT NULL,
 schedule_id TEXT NOT NULL,schedule_revision INTEGER NOT NULL,schedule_fence INTEGER NOT NULL,
 sha256 TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(run_id,run_fence),
 FOREIGN KEY(schedule_id,schedule_revision) REFERENCES schedule_configs(schedule_id,revision)) STRICT;
PRAGMA user_version=8;`;

export class ScheduleError extends Error {
  constructor(code, message) { super(message); this.name = "ScheduleError"; this.code = code; }
}
const fail = (message) => { throw new ScheduleError("SCHEDULE_CONFIG_INVALID", message); };
const exact = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) {
    fail("Use the required schedule fields only.");
  }
};
const text = (value) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("Use bounded printable schedule identifiers.");
  }
};
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("Use bounded integer schedule limits.");
};
export function validateScheduleConfig(input) {
  const value = JSON.parse(canonicalJson(input));
  exact(value, ["schema_version", "schedule_id", "revision", "watch_id", "scope_revision", "method_sha256", "source_id",
    "budget_window", "feed", "interval_ms", "max_events", "max_runs", "tick_timeout_ms", "run_policy", "runtime_sha256"]);
  if (value.schema_version !== 1) fail("Use schedule schema version one.");
  for (const field of ["schedule_id", "watch_id", "source_id", "budget_window"]) text(value[field]);
  integer(value.revision, 1); integer(value.scope_revision, 1);
  if (!/^[a-f0-9]{64}$/.test(value.method_sha256)) fail("Use an exact retained method hash.");
  if (value.feed?.kind === "twse_monthly_revenue_api") {
    exact(value.feed, ["kind"]);
    if (value.source_id !== "twse_listed_monthly_revenue_v1" || value.interval_ms !== 86400000) fail("Use the approved TWSE source with a daily polling interval.");
  } else if (value.feed?.kind === "sec_submissions_api") {
    try { validateSecFeed(value.feed); }
    catch { fail("Use a fixed SEC issuer feed and identifiable contact header."); }
    if (value.source_id !== secSourceId(value.feed.cik) || value.interval_ms !== 86400000)
      fail("Bind SEC checks to the exact issuer source and a daily interval.");
  } else {
    exact(value.feed, ["kind", "directory"]);
    if (value.feed.kind !== "retained_directory" || typeof value.feed.directory !== "string" || value.feed.directory.length > 4000 ||
        !isAbsolute(value.feed.directory) || /[\u0000-\u001f\u007f]/u.test(value.feed.directory)) fail("Use an absolute retained feed directory.");
  }
  integer(value.interval_ms, 1000, 86_400_000); integer(value.max_events, 1, 100); integer(value.max_runs, 0, 10);
  integer(value.tick_timeout_ms, 1000, 3_600_000);
  if (value.max_runs === 0 ? value.runtime_sha256 !== null : !/^[a-f0-9]{64}$/.test(value.runtime_sha256)) {
    fail("Pin the runtime hash for execution. Use null for observation only.");
  }
  exact(value.run_policy, ["max_attempts", "max_wall_ms", "not_before"]);
  integer(value.run_policy.max_attempts, 1, 10); integer(value.run_policy.max_wall_ms, 1, 86_400_000); integer(value.run_policy.not_before, 0);
  return value;
}

export function scheduleTickId(scheduleId, revision, fence) {
  return `el-schedule-tick-${contentHash({ schedule_id: scheduleId, revision, fence })}`;
}

export function validateScheduleTick(input, config) {
  const value = JSON.parse(canonicalJson(input));
  exact(value, ["schema_version", "tick_id", "schedule_id", "revision", "fence", "started_at", "finished_at", "status", "events", "deliveries", "codes"]);
  if (value.schema_version !== 1) fail("Use schedule tick schema version one.");
  text(value.schedule_id); integer(value.revision, 1); integer(value.fence, 1);
  integer(value.started_at, 0); integer(value.finished_at, value.started_at);
  if (value.tick_id !== scheduleTickId(value.schedule_id, value.revision, value.fence) ||
      !["completed", "gated", "failed", "interrupted"].includes(value.status)) fail("Use a valid schedule tick identity and outcome.");
  if (!Array.isArray(value.codes) || value.codes.length > 100 ||
      value.codes.some(code => typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) ||
      canonicalJson(value.codes) !== canonicalJson([...new Set(value.codes)].sort()) ||
      (value.status === "completed" ? value.codes.length !== 0 : value.codes.length === 0)) fail("Use unique sorted codes for each incomplete tick.");
  if (value.status === "interrupted") {
    if (value.events !== null || value.deliveries !== null) fail("Keep interrupted tick counts unknown.");
  } else {
    integer(value.events, 0, config?.max_events ?? 100); integer(value.deliveries, 0, config?.max_runs ?? 10);
  }
  if (config && (config.schedule_id !== value.schedule_id || config.revision !== value.revision)) fail("Use the tick configuration revision.");
  return value;
}

export function validateScheduleBinding(row) {
  const record = JSON.parse(row.record_json);
  exact(record, ["run_id", "run_fence", "schedule_id", "revision", "schedule_fence", "owner", "config_sha256"]);
  for (const field of ["run_id", "schedule_id", "owner"]) text(record[field]);
  for (const field of ["run_fence", "revision", "schedule_fence"]) integer(record[field], 1);
  if (!/^[a-f0-9]{64}$/.test(record.config_sha256) || canonicalJson(record) !== row.record_json || contentHash(record) !== row.sha256 ||
      record.run_id !== row.run_id || record.run_fence !== row.run_fence || record.schedule_id !== row.schedule_id ||
      record.revision !== row.schedule_revision || record.schedule_fence !== row.schedule_fence) {
    fail("Use the exact retained research schedule binding.");
  }
  return record;
}

// These checks detect changed records. They do not authenticate a source or model.
export function verifySchedules(db, { runBindings = false } = {}) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const check = (condition) => { if (!condition) throw new ScheduleError("SCHEDULE_STORAGE_INVALID", "Preserve changed schedule records before recovery."); };
  for (const row of all("SELECT * FROM schedule_configs")) {
    const config = validateScheduleConfig(JSON.parse(row.config_json));
    check(canonicalJson(config) === row.config_json && contentHash(config) === row.sha256 && config.schedule_id === row.schedule_id &&
      config.revision === row.revision && config.watch_id === row.watch_id && config.scope_revision === row.scope_revision &&
      get("SELECT bundle_sha256 FROM methods WHERE bundle_sha256=?", config.method_sha256));
  }
  for (const row of all("SELECT * FROM schedule_ticks")) {
    const config = JSON.parse(get("SELECT config_json FROM schedule_configs WHERE schedule_id=? AND revision=?", row.schedule_id, row.revision).config_json);
    const record = validateScheduleTick(JSON.parse(row.record_json), config);
    check(contentHash(record) === row.sha256 && canonicalJson(record) === row.record_json &&
      record.tick_id === row.tick_id && record.schedule_id === row.schedule_id && record.revision === row.revision && record.fence === row.fence &&
      row.tick_id === scheduleTickId(row.schedule_id, row.revision, row.fence) &&
      ["completed", "gated", "failed", "interrupted"].includes(record.status) &&
      Number.isSafeInteger(record.started_at) && Number.isSafeInteger(record.finished_at) && record.finished_at >= record.started_at &&
      (record.status === "interrupted" ? record.events === null && record.deliveries === null
        : Number.isSafeInteger(record.events) && record.events >= 0 && Number.isSafeInteger(record.deliveries) && record.deliveries >= 0) &&
      Array.isArray(record.codes) && record.codes.every(code => /^[A-Z][A-Z0-9_]{0,63}$/.test(code)));
  }
  for (const row of all("SELECT * FROM schedule_state")) {
    check([0, 1].includes(row.enabled) && Number.isSafeInteger(row.next_due) && row.next_due >= 0 && Number.isSafeInteger(row.fence) && row.fence >= 0 &&
      (row.owner === null) === (row.lease_until === null) && (row.owner === null || typeof row.owner === "string" &&
        Number.isSafeInteger(row.lease_until) && row.lease_until > row.started_at) &&
      get("SELECT revision FROM schedule_configs WHERE schedule_id=? AND revision=?", row.schedule_id, row.revision));
    if (row.last_tick_id !== null) {
      const tick = get("SELECT record_json FROM schedule_ticks WHERE tick_id=? AND schedule_id=?", row.last_tick_id, row.schedule_id);
      check(tick && JSON.parse(tick.record_json).finished_at === row.last_finished_at);
    } else check(row.last_finished_at === null);
    const configs = all("SELECT revision FROM schedule_configs WHERE schedule_id=? ORDER BY revision", row.schedule_id);
    check(configs.length === row.revision && configs.every((config, index) => config.revision === index + 1));
    const ticks = all("SELECT fence FROM schedule_ticks WHERE schedule_id=? ORDER BY fence", row.schedule_id);
    check(ticks.length === row.fence - (row.owner === null ? 0 : 1) && ticks.every((tick, index) => tick.fence === index + 1));
  }
  for (const row of all("SELECT DISTINCT schedule_id FROM schedule_configs")) check(get("SELECT schedule_id FROM schedule_state WHERE schedule_id=?", row.schedule_id));
  if (runBindings) for (const row of all("SELECT * FROM schedule_run_leases")) {
    const record = validateScheduleBinding(row);
    const checkpoint = get("SELECT sha256,payload_json FROM checkpoints WHERE run_id=? AND checkpoint_key=?", row.run_id, `schedule-binding:${row.run_fence}`);
    check(checkpoint && checkpoint.sha256 === row.sha256 && checkpoint.payload_json === row.record_json);
    const configRow = get("SELECT config_json FROM schedule_configs WHERE schedule_id=? AND revision=?", row.schedule_id, row.schedule_revision);
    const run = get("SELECT watch_id,revision,envelope_json,window_id,fence FROM runs WHERE run_id=?", row.run_id);
    const config = JSON.parse(configRow.config_json);
    check(contentHash(record) === row.sha256 && canonicalJson(record) === row.record_json &&
      record.run_id === row.run_id && record.run_fence === row.run_fence && record.schedule_id === row.schedule_id &&
      record.revision === row.schedule_revision && record.schedule_fence === row.schedule_fence &&
      record.config_sha256 === contentHash(config) && run.watch_id === config.watch_id && run.revision === config.scope_revision &&
      run.window_id === config.budget_window && JSON.parse(run.envelope_json).method.bundle_sha256 === config.method_sha256 &&
      Number.isSafeInteger(row.run_fence) && row.run_fence > 0 && row.run_fence <= run.fence &&
      Number.isSafeInteger(row.schedule_fence) && row.schedule_fence > 0 &&
      typeof record.owner === "string" && record.owner.length > 0);
  }
  if (runBindings) for (const row of all("SELECT run_id,checkpoint_key,sha256,payload_json FROM checkpoints WHERE checkpoint_key LIKE 'schedule-binding:%'")) {
    const record = JSON.parse(row.payload_json);
    const binding = get("SELECT * FROM schedule_run_leases WHERE run_id=? AND run_fence=?", row.run_id, record.run_fence);
    check(binding && row.checkpoint_key === `schedule-binding:${record.run_fence}` && row.sha256 === binding.sha256 && row.payload_json === binding.record_json);
  }
}
