import { canonicalJson, contentHash } from "./run-contract.mjs";
import { ScheduleError } from "./schedule-contract.mjs";

export const WORKER_SCHEMA = `
ALTER TABLE schedule_state ADD COLUMN worker_fence INTEGER NOT NULL DEFAULT 0;
CREATE TABLE schedule_workers(schedule_id TEXT PRIMARY KEY REFERENCES schedule_state(schedule_id),revision INTEGER NOT NULL,
 fence INTEGER NOT NULL,sha256 TEXT NOT NULL,record_json TEXT NOT NULL) STRICT;
CREATE TABLE schedule_worker_ticks(schedule_id TEXT NOT NULL REFERENCES schedule_state(schedule_id),schedule_fence INTEGER NOT NULL,
 worker_fence INTEGER NOT NULL,revision INTEGER NOT NULL,sha256 TEXT NOT NULL,record_json TEXT NOT NULL,
 PRIMARY KEY(schedule_id,schedule_fence)) STRICT;
PRAGMA user_version=10;`;
const fail = () => { throw new ScheduleError("WORKER_STORAGE_INVALID", "Preserve changed worker records before recovery."); };
const text = value => typeof value === "string" && value.trim() && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value);
const number = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
export function validateWorkerRecord(row) {
  try {
    const value = JSON.parse(row.record_json);
    const fields = ["schedule_id", "revision", "config_sha256", "fence", "owner", "started_at", "heartbeat_at", "lease_until", "state", "finished_at", "code"];
    if (Object.keys(value).sort().join() !== fields.sort().join() || canonicalJson(value) !== row.record_json || contentHash(value) !== row.sha256 ||
        value.schedule_id !== row.schedule_id || value.revision !== row.revision || value.fence !== row.fence || !text(value.schedule_id) || !text(value.owner) ||
        !number(value.revision, 1) || !number(value.fence, 1) || !/^[a-f0-9]{64}$/.test(value.config_sha256) ||
        !number(value.started_at) || !number(value.heartbeat_at, value.started_at) || !number(value.lease_until, value.heartbeat_at + 1) ||
        !["running", "stopped", "failed"].includes(value.state) ||
        (value.state === "running" ? value.finished_at !== null || value.code !== null :
          !number(value.finished_at, value.heartbeat_at) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code))) fail();
    return value;
  } catch (error) { if (error instanceof ScheduleError) throw error; fail(); }
}
export function validateWorkerBinding(row) {
  try {
    const value = JSON.parse(row.record_json);
    if (Object.keys(value).sort().join() !== ["schedule_id", "schedule_fence", "worker_fence", "revision", "config_sha256"].sort().join() ||
        canonicalJson(value) !== row.record_json || contentHash(value) !== row.sha256 || !text(value.schedule_id) ||
        !number(value.schedule_fence, 1) || !number(value.worker_fence, 1) || !number(value.revision, 1) || !/^[a-f0-9]{64}$/.test(value.config_sha256) ||
        value.schedule_id !== row.schedule_id || value.schedule_fence !== row.schedule_fence || value.worker_fence !== row.worker_fence || value.revision !== row.revision) fail();
    return value;
  } catch (error) { if (error instanceof ScheduleError) throw error; fail(); }
}
export function verifyWorkers(db) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  for (const state of db.prepare("SELECT schedule_id,fence,worker_fence FROM schedule_state").all()) {
    const binding = get("SELECT worker_fence FROM schedule_worker_ticks WHERE schedule_id=? AND schedule_fence=?", state.schedule_id, state.fence);
    if (!number(state.worker_fence) || Boolean(binding) !== Boolean(state.worker_fence) || binding && binding.worker_fence !== state.worker_fence) fail();
  }
  for (const row of db.prepare("SELECT * FROM schedule_workers").all()) {
    const record = validateWorkerRecord(row);
    const config = get("SELECT sha256 FROM schedule_configs WHERE schedule_id=? AND revision=?", record.schedule_id, record.revision);
    if (config?.sha256 !== record.config_sha256) fail();
  }
  for (const row of db.prepare("SELECT * FROM schedule_worker_ticks").all()) {
    const binding = validateWorkerBinding(row);
    const worker = get("SELECT fence FROM schedule_workers WHERE schedule_id=?", binding.schedule_id);
    const state = get("SELECT fence FROM schedule_state WHERE schedule_id=?", binding.schedule_id);
    const config = get("SELECT sha256 FROM schedule_configs WHERE schedule_id=? AND revision=?", binding.schedule_id, binding.revision);
    if (!worker || binding.worker_fence > worker.fence || !state || binding.schedule_fence > state.fence || config?.sha256 !== binding.config_sha256) fail();
  }
}
