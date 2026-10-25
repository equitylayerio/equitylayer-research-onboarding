import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalJson, contentHash, createRunEnvelope, publicScope, validateRunEnvelope } from "./run-contract.mjs";
import { ReferenceBridgeError, verifyMethodBundle, verifySourceReference } from "./reference-bridge.mjs";
import { ResultFileError, validateResearchResultFile } from "./result-file.mjs";
import { LegacyWorkspaceError, parseLegacyWorkspace } from "./legacy-workspace.mjs";
import { EventPlanError, planSourceEvent, validateSourcePolicy, verifyEventFacts } from "./source-event-plan.mjs";
import { NormalizedFactError, validateNormalizedFact } from "./normalized-fact.mjs";
import { isSecSubmissionsEvent } from "./sec-submissions-contract.mjs";
import { TWSE_MONTHLY_SOURCE_ID, twseExpectedReportingPeriod } from "./twse-monthly-contract.mjs";
import { METHOD_ARTIFACT_SCHEMA, MethodArtifactError, validateCaseRequest, validateCandidateRequest, validatePlanRequest,
  validateMethodArtifact, verifyMethodArtifacts, METHOD_RELEASE_GATE } from "./method-artifacts.mjs";
import { METHOD_TRIAL_SCHEMA, validateTrialPairRequest, verifyMethodTrials } from "./method-trials.mjs";
import { validateTrialRuntimePolicy } from "./trial-policy.mjs";
import { SCHEDULE_SCHEMA, SCHEDULE_RUN_BINDING_SCHEMA, ScheduleError, validateScheduleConfig, validateScheduleTick, validateScheduleBinding, scheduleTickId, verifySchedules } from "./schedule-contract.mjs";
import { THESIS_SCHEMA, ThesisError, validateThesisProposal, validateThesisReview, checkThesisReferences, verifyTheses, thesisManifestHash, thesisFail, thesisDelta } from "./thesis-contract.mjs";
import { WORKER_SCHEMA, validateWorkerRecord, validateWorkerBinding, verifyWorkers } from "./worker-contract.mjs";
import { buildRetainedSourceContent, SOURCE_CONTENT_RENDERER_SHA256 } from "./source-content.mjs";
import { isExecutionFailureCode, executionFailureSummary } from "./execution-diagnostics.mjs";
import { ExternalSessionError } from "./external-session-contract.mjs";
import { EXTERNAL_SESSION_SCHEMA, verifyExternalSessions, prepareExternalSession, externalSessionTask,
  submitExternalSession, externalSessionRecord, externalSessionStatus, checkExternalAcceptance, externalSessionOptions } from "./external-session-store.mjs";
import { EXTERNAL_REVIEW_SCHEMA, verifyExternalReviews, reviewExternalSession } from "./external-session-review.mjs";
import { researchSelection, selectedResearchBaseline, researchBaselineContext, researchTarget, checkResearchRights } from "./research-selection.mjs";

const MAX_JSON_BYTES = 2_000_000;
const APPLICATION_ID = 1162955825;
export const LEDGER_SCHEMA_VERSION = 12;
const SCHEMA_VERSION = LEDGER_SCHEMA_VERSION;
const DIMENSIONS = ["requests", "tokens", "cost_microusd", "wall_ms"];
const SCHEMA = `
CREATE TABLE watches(watch_id TEXT PRIMARY KEY, current_revision INTEGER NOT NULL, review_revision INTEGER NOT NULL DEFAULT 0,
 evidence_delivery_id TEXT, interpretation_delivery_id TEXT) STRICT;
CREATE TABLE revisions(watch_id TEXT NOT NULL REFERENCES watches(watch_id), revision INTEGER NOT NULL,
 scope_json TEXT NOT NULL, context_json TEXT NOT NULL, context_sha256 TEXT NOT NULL, PRIMARY KEY(watch_id, revision)) STRICT;
CREATE TABLE methods(bundle_sha256 TEXT PRIMARY KEY, bundle_json TEXT NOT NULL) STRICT;
CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, metadata_json TEXT NOT NULL, bytes BLOB NOT NULL) STRICT;
CREATE TABLE source_events(event_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, event_json TEXT NOT NULL,
 artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id)) STRICT;
CREATE TABLE cursors(watch_id TEXT NOT NULL REFERENCES watches(watch_id),source_id TEXT NOT NULL,
 observed_event_id TEXT REFERENCES source_events(event_id),queued_event_id TEXT REFERENCES source_events(event_id),
 completed_event_id TEXT REFERENCES source_events(event_id),PRIMARY KEY(watch_id,source_id)) STRICT;
CREATE TABLE budgets(watch_id TEXT NOT NULL REFERENCES watches(watch_id), window_id TEXT NOT NULL,
 limits_json TEXT NOT NULL, spent_json TEXT NOT NULL, reserved_json TEXT NOT NULL, gate_code TEXT,
 PRIMARY KEY(watch_id,window_id)) STRICT;
CREATE TABLE runs(run_id TEXT PRIMARY KEY, envelope_json TEXT NOT NULL, watch_id TEXT NOT NULL, revision INTEGER NOT NULL,
 window_id TEXT NOT NULL, policy_json TEXT NOT NULL, status TEXT NOT NULL, not_before INTEGER NOT NULL, deadline INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, fence INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER, gate_code TEXT,
 FOREIGN KEY(watch_id,revision) REFERENCES revisions(watch_id,revision),
 FOREIGN KEY(watch_id,window_id) REFERENCES budgets(watch_id,window_id)) STRICT;
CREATE INDEX due_runs ON runs(status,not_before,lease_until);
CREATE TABLE checkpoints(run_id TEXT NOT NULL REFERENCES runs(run_id), checkpoint_key TEXT NOT NULL,
 sha256 TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id,checkpoint_key)) STRICT;
CREATE TABLE requests(request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), operation_id TEXT NOT NULL,
 fence INTEGER NOT NULL, owner TEXT NOT NULL, estimate_json TEXT NOT NULL, status TEXT NOT NULL, dispatched_at INTEGER,
 usage_json TEXT, response_json TEXT) STRICT;
CREATE INDEX run_requests ON requests(run_id,operation_id);
CREATE TABLE deliveries(sequence INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id), sha256 TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE reviews(review_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
 action TEXT NOT NULL, note TEXT NOT NULL, request_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE outbox(notice_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, acknowledged_at INTEGER) STRICT;
PRAGMA application_id=1162955825;
PRAGMA user_version=1;`;
const MIGRATION_TWO = `
ALTER TABLE reviews ADD COLUMN expected_revision INTEGER;
ALTER TABLE reviews ADD COLUMN record_sha256 TEXT;
CREATE TABLE legacy_archives(archive_sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL, imported_at INTEGER NOT NULL) STRICT;
CREATE TABLE legacy_imports(archive_sha256 TEXT NOT NULL REFERENCES legacy_archives(archive_sha256),
 watch_id TEXT NOT NULL REFERENCES watches(watch_id), revision INTEGER NOT NULL, saved_at TEXT NOT NULL,
 accepted_result_id TEXT, legacy_watch_json TEXT, PRIMARY KEY(archive_sha256,watch_id)) STRICT;
CREATE TABLE legacy_results(sequence INTEGER PRIMARY KEY AUTOINCREMENT, result_id TEXT NOT NULL UNIQUE,
 watch_id TEXT NOT NULL REFERENCES watches(watch_id), sha256 TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
CREATE TABLE legacy_archive_results(archive_sha256 TEXT NOT NULL,watch_id TEXT NOT NULL,
 result_id TEXT NOT NULL REFERENCES legacy_results(result_id), position INTEGER NOT NULL,
 PRIMARY KEY(archive_sha256,watch_id,result_id),
 FOREIGN KEY(archive_sha256,watch_id) REFERENCES legacy_imports(archive_sha256,watch_id)) STRICT;
CREATE TABLE legacy_reviews(archive_sha256 TEXT NOT NULL,watch_id TEXT NOT NULL,
 result_id TEXT NOT NULL REFERENCES legacy_results(result_id),review_json TEXT NOT NULL,
 PRIMARY KEY(archive_sha256,watch_id,result_id),
 FOREIGN KEY(archive_sha256,watch_id) REFERENCES legacy_imports(archive_sha256,watch_id)) STRICT;
PRAGMA user_version=2;`;
const MIGRATION_THREE = `
CREATE TABLE normalized_facts(source_event_id TEXT NOT NULL REFERENCES source_events(event_id),fact_key TEXT NOT NULL,
 sha256 TEXT NOT NULL,fact_json TEXT NOT NULL,PRIMARY KEY(source_event_id,fact_key)) STRICT;
CREATE TABLE source_fact_sets(source_event_id TEXT PRIMARY KEY REFERENCES source_events(event_id),refs_json TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT;
CREATE TABLE source_policies(watch_id TEXT NOT NULL REFERENCES watches(watch_id),source_id TEXT NOT NULL,revision INTEGER NOT NULL,
 sha256 TEXT NOT NULL,policy_json TEXT NOT NULL,PRIMARY KEY(watch_id,source_id,revision)) STRICT;
CREATE TABLE event_decisions(decision_id TEXT PRIMARY KEY,task_key TEXT NOT NULL,watch_id TEXT NOT NULL,revision INTEGER NOT NULL,
 source_event_id TEXT NOT NULL REFERENCES source_events(event_id),method_sha256 TEXT NOT NULL REFERENCES methods(bundle_sha256),
 sha256 TEXT NOT NULL,decision_json TEXT NOT NULL,run_id TEXT REFERENCES runs(run_id),
 FOREIGN KEY(watch_id,revision) REFERENCES revisions(watch_id,revision)) STRICT;
CREATE TABLE event_jobs(task_key TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
 decision_id TEXT NOT NULL REFERENCES event_decisions(decision_id)) STRICT;
PRAGMA user_version=3;`;
const MIGRATION_FOUR = `
ALTER TABLE requests ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN receipt_set_sha256 TEXT;
ALTER TABLE requests ADD COLUMN selected_receipt_sha256 TEXT;
ALTER TABLE requests ADD COLUMN reconciliation_sha256 TEXT;
CREATE TABLE request_receipts(receipt_sha256 TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(request_id),
 content_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,UNIQUE(request_id,content_sha256)) STRICT;
CREATE TABLE usage_reconciliations(reconciliation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES requests(request_id),
 receipt_sha256 TEXT NOT NULL REFERENCES request_receipts(receipt_sha256),sha256 TEXT NOT NULL,record_json TEXT NOT NULL) STRICT;
PRAGMA user_version=4;`;

export class LedgerError extends Error {
  constructor(code, message, options) { super(message, options); this.name = "LedgerError"; this.code = code; }
}
const fail = (code, message) => { throw new LedgerError(code, message); };
const id = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    fail("INVALID_INPUT", "Use a bounded printable identifier.");
  }
  return value;
};
const integer = (value, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) fail("INVALID_INPUT", "Use a bounded nonnegative integer.");
  return value;
};
const json = (value) => {
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized) > MAX_JSON_BYTES) fail("INVALID_INPUT", "The local record exceeds the size limit.");
  return serialized;
};
const pageOrder = (value) => {
  if (value !== "oldest" && value !== "newest") fail("INVALID_INPUT", "Use oldest or newest for the page order.");
  return value === "newest" ? { comparison: "<", direction: "DESC" } : { comparison: ">", direction: "ASC" };
};
const zero = () => Object.fromEntries(DIMENSIONS.map((key) => [key, 0]));
const quantities = (value, requests = true) => {
  const keys = requests ? DIMENSIONS : DIMENSIONS.slice(1);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail("INVALID_INPUT", "Use the required budget dimensions only.");
  }
  return Object.fromEntries(keys.map((key) => [key, integer(value[key])]));
};
const add = (left, right, sign = 1) => Object.fromEntries(DIMENSIONS.map((key) => [key, integer(left[key] + sign * right[key])]));
const privatePath = (path, directory) => {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || (!directory && info.nlink !== 1)) {
    fail("UNSAFE_STORAGE_PATH", "Use a private owned path without links or shared permissions.");
  }
};
const startupRetry = (action) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return action(); } catch (error) {
      if (![5, 6].includes(error.errcode)) throw error;
      if (attempt === 9) throw new LedgerError("STORAGE_BUSY", "Another worker holds storage. Retry startup after it closes.", { cause: error });
      // The WAL mode transition can return SQLITE_BUSY without honoring busy_timeout.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10 * 2 ** attempt, 100));
    }
  }
};
const reviewContent = (row, expectedRevision) => ({ review_id: row.review_id, delivery_id: row.delivery_id, action: row.action,
  note: row.note, request_sha256: row.request_sha256, created_at: row.created_at, expected_revision: expectedRevision });
const measuredUsage = (value) => {
  if (value === null) return null;
  if (!value || Object.keys(value).sort().join() !== "cost_microusd,tokens") fail("INVALID_INPUT", "Record measured tokens and cost, or unknown usage.");
  return { tokens: integer(value.tokens), cost_microusd: integer(value.cost_microusd) };
};
const requestFingerprint = (row) => contentHash({ request_id: row.request_id, run_id: row.run_id, operation_id: row.operation_id,
  fence: row.fence, owner: row.owner, estimate: JSON.parse(row.estimate_json), dispatched_at: row.dispatched_at });

// Hash checks detect changed retained content. They do not establish source authenticity.
function verifyRetainedIntegrity(db) {
  let snapshot = false;
  try {
    db.exec("BEGIN"); snapshot = true;
    const result = verifyRetainedSnapshot(db);
    db.exec("COMMIT"); snapshot = false;
    return result;
  } catch (error) {
    if (snapshot) { try { db.exec("ROLLBACK"); } catch { /* Preserve the original verification failure. */ } }
    if ([5, 6].includes(error.errcode)) throw new LedgerError("STORAGE_BUSY", "Another worker holds storage. Retry verification after it releases storage.", { cause: error });
    throw error;
  }
}
function retainedExecutionFailure(get, row) {
  const payload = JSON.parse(row.payload_json), diagnostic = executionFailureSummary(payload);
  const match = /^executor:failure:([1-9][0-9]*)$/.exec(row.checkpoint_key);
  const fence = match ? Number(match[1]) : NaN;
  const run = get("SELECT fence FROM runs WHERE run_id=?", row.run_id);
  if (!diagnostic || contentHash(payload) !== row.sha256 || !Number.isSafeInteger(fence) || !run || fence > run.fence) {
    fail("STORAGE_CORRUPT", "The retained execution failure or attempt changed.");
  }
  const request = get("SELECT request_id,run_id,fence,status,dispatched_at FROM requests WHERE run_id=? AND fence=? ORDER BY rowid DESC LIMIT 1", row.run_id, fence);
  let bound = false;
  if (diagnostic.dispatch_state === "none") bound = !request && diagnostic.request_id === null;
  else if (request && request.request_id === diagnostic.request_id) {
    const states = { reserved: ["reserved", "abandoned"], dispatched: ["dispatched", "unknown", "settled"],
      unknown: ["unknown", "settled"], settled: ["settled"] };
    bound = states[diagnostic.dispatch_state]?.includes(request.status) &&
      (diagnostic.dispatch_state === "reserved" ? request.dispatched_at === null : request.dispatched_at !== null);
  }
  if (!bound) {
    fail("STORAGE_CORRUPT", "The retained execution failure or request binding changed.");
  }
  return diagnostic;
}
function verifyRetainedSnapshot(db) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const check = (condition) => { if (!condition) fail("STORAGE_CORRUPT", "Retained content or references changed. Preserve the workspace before recovery."); };
  try {
    check(get("PRAGMA quick_check").quick_check === "ok" && !get("PRAGMA foreign_key_check"));
    for (const row of all("SELECT * FROM revisions")) {
      const scope = publicScope(JSON.parse(row.scope_json));
      check(scope.watch_id === row.watch_id && scope.revision === row.revision && canonicalJson(scope) === row.scope_json);
      check(contentHash(JSON.parse(row.context_json)) === row.context_sha256);
    }
    for (const row of all("SELECT * FROM watches")) check(get("SELECT revision FROM revisions WHERE watch_id=? AND revision=?", row.watch_id, row.current_revision));
    for (const row of all("SELECT * FROM methods")) check(verifyMethodBundle(JSON.parse(row.bundle_json)).bundle_sha256 === row.bundle_sha256);
    for (const row of all("SELECT * FROM artifacts")) {
      const metadata = JSON.parse(row.metadata_json);
      check(metadata.source_artifact_id === row.artifact_id && metadata.artifact_sha256 === row.sha256 &&
        metadata.byte_length === row.bytes.length && createHash("sha256").update(row.bytes).digest("hex") === row.sha256);
    }
    for (const row of all("SELECT * FROM source_events")) {
      const artifact = get("SELECT * FROM artifacts WHERE artifact_id=?", row.artifact_id);
      const reference = verifySourceReference(JSON.parse(row.event_json), JSON.parse(artifact.metadata_json), artifact.bytes);
      check(reference.source_event_id === row.event_id && reference.source_event_sha256 === row.sha256);
    }
    for (const row of all("SELECT * FROM runs")) {
      const envelope = validateRunEnvelope(JSON.parse(row.envelope_json));
      const revision = get("SELECT * FROM revisions WHERE watch_id=? AND revision=?", row.watch_id, row.revision);
      check(envelope.run_id === row.run_id && canonicalJson(envelope.scope) === revision.scope_json && envelope.local_context_sha256 === revision.context_sha256);
      const method = get("SELECT * FROM methods WHERE bundle_sha256=?", envelope.method.bundle_sha256);
      check(method); verifyMethodBundle(JSON.parse(method.bundle_json), envelope.method);
      for (const reference of envelope.source_refs) {
        const event = get("SELECT * FROM source_events WHERE event_id=?", reference.source_event_id);
        check(event); const artifact = get("SELECT * FROM artifacts WHERE artifact_id=?", event.artifact_id);
        check(artifact); verifySourceReference(JSON.parse(event.event_json), JSON.parse(artifact.metadata_json), artifact.bytes, reference);
      }
    }
    for (const row of all("SELECT * FROM checkpoints")) {
      check(contentHash(JSON.parse(row.payload_json)) === row.sha256);
      if (row.checkpoint_key.startsWith("executor:failure:")) retainedExecutionFailure(get, row);
    }
    for (const row of all("SELECT * FROM deliveries")) {
      const result = validateResearchResultFile(JSON.parse(row.result_json));
      const run = get("SELECT * FROM runs WHERE run_id=?", row.run_id); const envelope = validateRunEnvelope(JSON.parse(run.envelope_json));
      check(contentHash(result) === row.sha256 && row.delivery_id === envelope.delivery_id &&
        canonicalJson(publicScope({ watch_id: result.watch_id, revision: result.scope_revision, theme_id: result.theme_id,
          symbols: result.symbols, ...(result.stage_id === undefined ? {} : { stage_id: result.stage_id }) })) === canonicalJson(envelope.scope));
    }
    const reviewCounts = new Map(); const schemaVersion = get("PRAGMA user_version").user_version;
    for (const row of all("SELECT v.*,r.watch_id FROM reviews v JOIN deliveries d USING(delivery_id) JOIN runs r USING(run_id) ORDER BY v.rowid")) {
      const expectedRevision = schemaVersion >= 12 ? row.expected_revision : reviewCounts.get(row.watch_id) ?? 0;
      reviewCounts.set(row.watch_id, expectedRevision + 1);
      check(["received", "accept_evidence", "accept_interpretation", "revisit", "reject"].includes(row.action) && typeof row.note === "string" && row.note.trim() && row.note.length <= 1200);
      check(row.request_sha256 === contentHash({ deliveryId: row.delivery_id, action: row.action, note: row.note, expectedRevision }));
      if (schemaVersion >= 2) check(row.expected_revision === expectedRevision && row.record_sha256 === contentHash(reviewContent(row, expectedRevision)));
    }
    for (const watch of all("SELECT * FROM watches")) {
      if (schemaVersion < 12) check(watch.review_revision === (reviewCounts.get(watch.watch_id) ?? 0));
      for (const [field, action] of [["evidence_delivery_id", "accept_evidence"], ["interpretation_delivery_id", "accept_interpretation"]]) {
        if (!watch[field]) continue;
        const delivery = get("SELECT d.result_json,r.watch_id FROM deliveries d JOIN runs r USING(run_id) WHERE delivery_id=?", watch[field]);
        check(delivery && delivery.watch_id === watch.watch_id && JSON.parse(delivery.result_json).result_state !== "SOURCE_NEEDED" &&
          get("SELECT review_id FROM reviews WHERE delivery_id=? AND action=?", watch[field], action));
      }
    }
    if (schemaVersion >= 2) {
      for (const row of all("SELECT * FROM legacy_results")) {
        const result = validateResearchResultFile(JSON.parse(row.result_json));
        check(result.result_id === row.result_id && result.watch_id === row.watch_id && contentHash(result) === row.sha256);
      }
      for (const archive of all("SELECT * FROM legacy_archives")) {
        const parsed = parseLegacyWorkspace(archive.bytes); check(parsed.raw_sha256 === archive.archive_sha256);
        const imports = all("SELECT * FROM legacy_imports WHERE archive_sha256=?", archive.archive_sha256); check(imports.length === parsed.watches.length);
        for (const watch of parsed.watches) {
          const retained = imports.find((row) => row.watch_id === watch.scope.watch_id);
          check(retained && retained.revision === watch.scope.revision && retained.saved_at === watch.saved_at &&
            retained.accepted_result_id === watch.accepted_result_id && retained.legacy_watch_json === (watch.legacy_watch === undefined ? null : canonicalJson(watch.legacy_watch)));
          const results = all("SELECT l.result_json,a.position FROM legacy_archive_results a JOIN legacy_results l USING(result_id) WHERE a.archive_sha256=? AND a.watch_id=? ORDER BY a.position", archive.archive_sha256, watch.scope.watch_id);
          check(results.length === watch.results.length && results.every((row, index) => row.position === index && row.result_json === canonicalJson(watch.results[index])));
          const reviews = all("SELECT * FROM legacy_reviews WHERE archive_sha256=? AND watch_id=? ORDER BY rowid", archive.archive_sha256, watch.scope.watch_id);
          check(reviews.length === watch.reviews.length && reviews.every((row, index) => row.result_id === watch.reviews[index].result_id && row.review_json === canonicalJson(watch.reviews[index])));
          const revision = get("SELECT * FROM revisions WHERE watch_id=? AND revision=?", watch.scope.watch_id, watch.scope.revision);
          check(revision && revision.scope_json === canonicalJson(watch.scope) && revision.context_json === canonicalJson(watch.private_context));
        }
      }
    }
    if (schemaVersion >= 3) {
      for (const row of all("SELECT * FROM normalized_facts")) {
        const fact = validateNormalizedFact(JSON.parse(row.fact_json));
        const source = get("SELECT e.event_json,a.metadata_json FROM source_events e JOIN artifacts a ON a.artifact_id=e.artifact_id WHERE e.event_id=?", row.source_event_id);
        check(contentHash(fact) === row.sha256 && fact.fact_key === row.fact_key);
        verifyEventFacts(JSON.parse(source.event_json), JSON.parse(source.metadata_json), [fact]);
        check(get("SELECT source_event_id FROM source_fact_sets WHERE source_event_id=?", row.source_event_id));
      }
      for (const row of all("SELECT * FROM source_fact_sets")) {
        const refs = all("SELECT fact_key,sha256 FROM normalized_facts WHERE source_event_id=? ORDER BY fact_key", row.source_event_id);
        check(canonicalJson(refs.map((ref) => ({ ...ref }))) === row.refs_json && contentHash(refs.map((ref) => ({ ...ref }))) === row.sha256);
      }
      for (const row of all("SELECT * FROM source_policies")) {
        const policy = validateSourcePolicy(JSON.parse(row.policy_json));
        check(policy.source_id === row.source_id && policy.revision === row.revision && contentHash(policy) === row.sha256);
      }
      for (const row of all("SELECT * FROM event_decisions")) {
        const decision = JSON.parse(row.decision_json);
        check(contentHash(decision) === row.sha256 && row.decision_id === `el-event-decision-${row.sha256}` &&
          decision.task_key === row.task_key && decision.scope.watch_id === row.watch_id && decision.scope.revision === row.revision &&
          decision.source_ref.source_event_id === row.source_event_id && decision.method.bundle_sha256 === row.method_sha256 &&
          (decision.run_id ?? null) === row.run_id);
        const revision = get("SELECT scope_json FROM revisions WHERE watch_id=? AND revision=?", row.watch_id, row.revision);
        check(revision && canonicalJson(decision.scope) === revision.scope_json);
        const event = get("SELECT * FROM source_events WHERE event_id=?", row.source_event_id);
        check(event && decision.source_ref.source_event_sha256 === event.sha256);
        if (decision.policy_sha256 !== null) check(get("SELECT revision FROM source_policies WHERE watch_id=? AND sha256=?", row.watch_id, decision.policy_sha256));
        check(decision.task_key === `el-event-task-${contentHash({ scope: decision.scope, method: decision.method, source_ref: decision.source_ref })}`);
        const storedMethod = get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", row.method_sha256);
        check(storedMethod); verifyMethodBundle(JSON.parse(storedMethod.bundle_json), decision.method);
        const sourceArtifact = get("SELECT * FROM artifacts WHERE artifact_id=?", event.artifact_id);
        check(sourceArtifact); verifySourceReference(JSON.parse(event.event_json), JSON.parse(sourceArtifact.metadata_json), sourceArtifact.bytes, decision.source_ref);
        check(Array.isArray(decision.fact_refs));
        for (const ref of decision.fact_refs) {
          const fact = get("SELECT sha256 FROM normalized_facts WHERE source_event_id=? AND fact_key=?", ref.source_event_id, ref.fact_key);
          check(fact && fact.sha256 === ref.sha256);
        }
        if (row.run_id !== null) check(get("SELECT task_key FROM event_jobs WHERE task_key=? AND run_id=?", row.task_key, row.run_id));
      }
      for (const row of all("SELECT * FROM event_jobs")) {
        const decision = get("SELECT * FROM event_decisions WHERE decision_id=?", row.decision_id);
        check(decision && decision.task_key === row.task_key && decision.run_id === row.run_id && JSON.parse(decision.decision_json).outcome === "queued");
      }
    }
    if (schemaVersion >= 4) {
      for (const row of all("SELECT * FROM request_receipts")) {
        const receipt = JSON.parse(row.receipt_json);
        check(contentHash(receipt) === row.receipt_sha256 && receipt.request_id === row.request_id);
        check(receipt.request_sha256 === requestFingerprint(get("SELECT * FROM requests WHERE request_id=?", row.request_id)));
        check(contentHash({ request_id: receipt.request_id, usage: receipt.usage, response: receipt.response }) === row.content_sha256);
        measuredUsage(receipt.usage); integer(receipt.recorded_at);
      }
      for (const row of all("SELECT * FROM requests")) {
        check([0, 1].includes(row.accounting_version));
        if (row.accounting_version === 0) continue; // Older request accounting has no receipt manifest.
        const receipts = all("SELECT receipt_sha256 FROM request_receipts WHERE request_id=? ORDER BY receipt_sha256", row.request_id).map((item) => item.receipt_sha256);
        check(row.receipt_set_sha256 === contentHash(receipts));
        if (row.selected_receipt_sha256 !== null) {
          const selected = get("SELECT receipt_json FROM request_receipts WHERE receipt_sha256=? AND request_id=?", row.selected_receipt_sha256, row.request_id);
          check(selected); const receipt = JSON.parse(selected.receipt_json);
          check(row.response_json === canonicalJson(receipt.response));
          if (row.status === "settled") {
            const actual = JSON.parse(row.usage_json);
            check(receipt.usage !== null && actual.tokens === receipt.usage.tokens && actual.cost_microusd === receipt.usage.cost_microusd &&
              actual.requests === 0 && actual.wall_ms === receipt.recorded_at - row.dispatched_at && actual.wall_ms >= 0);
          }
        }
        if (row.status === "settled") check(row.selected_receipt_sha256 !== null);
        if (row.reconciliation_sha256 !== null) {
          const decision = get("SELECT sha256 FROM usage_reconciliations WHERE request_id=?", row.request_id);
          check(decision && decision.sha256 === row.reconciliation_sha256);
        }
      }
      for (const row of all("SELECT * FROM usage_reconciliations")) {
        const record = JSON.parse(row.record_json);
        const request = get("SELECT * FROM requests WHERE request_id=?", row.request_id);
        check(contentHash(record) === row.sha256 && record.reconciliation_id === row.reconciliation_id && record.request_id === row.request_id &&
          record.receipt_sha256 === row.receipt_sha256 && request.status === "settled" && request.selected_receipt_sha256 === row.receipt_sha256 && request.reconciliation_sha256 === row.sha256);
        check(typeof record.reason === "string" && record.reason.trim() && record.reason.length <= 1200);
      }
      for (const row of all("SELECT * FROM budgets")) {
        let spent = zero(), reserved = zero();
        quantities(JSON.parse(row.limits_json));
        for (const request of all("SELECT q.* FROM requests q JOIN runs r USING(run_id) WHERE r.watch_id=? AND r.window_id=?", row.watch_id, row.window_id)) {
          const estimate = quantities(JSON.parse(request.estimate_json));
          check(estimate.requests === 1 && ["reserved", "dispatched", "unknown", "settled", "abandoned"].includes(request.status));
          if (request.status === "reserved") reserved = add(reserved, estimate);
          if (["dispatched", "unknown", "settled"].includes(request.status)) spent = add(spent, { ...zero(), requests: 1 });
          if (["dispatched", "unknown"].includes(request.status)) reserved = add(reserved, { ...estimate, requests: 0 });
          if (request.status === "settled") {
            const usage = quantities(JSON.parse(request.usage_json)); check(usage.requests === 0);
            spent = add(spent, usage);
          }
        }
        check(canonicalJson(spent) === row.spent_json && canonicalJson(reserved) === row.reserved_json);
      }
    }
    if (schemaVersion >= 5) verifyMethodArtifacts(db);
    if (schemaVersion >= 6) verifyMethodTrials(db);
    if (schemaVersion >= 7) verifySchedules(db, { runBindings: schemaVersion >= 8 });
    if (schemaVersion >= 9) verifyTheses(db);
    if (schemaVersion >= 10) verifyWorkers(db);
    if (schemaVersion >= 11) verifyExternalSessions(db);
    if (schemaVersion >= 12) verifyExternalReviews(db);
    return { schema_version: get("PRAGMA user_version").user_version, retained_hashes: "checked", source_authenticity: "not_verified" };
  } catch (error) {
    if ([5, 6].includes(error.errcode)) throw error;
    if (error instanceof LedgerError && error.code === "STORAGE_CORRUPT") throw error;
    throw new LedgerError("STORAGE_CORRUPT", "Retained content failed verification. Preserve the workspace before recovery.", { cause: error });
  }
}

export class ResearchLedger {
  #db;
  #clock;
  #fault;
  constructor(directory, { clock = Date.now, fault = () => {}, allow_migration = true, allow_creation = allow_migration } = {}) {
    if (process.platform === "win32" || typeof process.getuid !== "function") fail("PLATFORM_UNVERIFIED", "Private storage permissions need a verified platform policy.");
    if (typeof directory !== "string" || !isAbsolute(directory)) fail("UNSAFE_STORAGE_PATH", "Use an absolute workspace directory.");
    if (typeof allow_migration !== "boolean" || typeof allow_creation !== "boolean") fail("INVALID_INPUT", "Use explicit creation and migration settings.");
    if (allow_creation) mkdirSync(directory, { recursive: true, mode: 0o700 });
    privatePath(directory, true);
    this.directory = realpathSync(directory);
    this.path = join(this.directory, "research.sqlite");
    if (allow_creation) {
      try { closeSync(openSync(this.path, "wx", 0o600)); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    privatePath(this.path, false);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(this.path + suffix)) privatePath(this.path + suffix, false);
    this.#clock = clock; this.#fault = fault;
    this.#db = new DatabaseSync(this.path);
    try {
      this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      const version = startupRetry(() => this.#db.prepare("PRAGMA user_version").get().user_version);
      const application = startupRetry(() => this.#get("PRAGMA application_id").application_id);
      if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, SCHEMA_VERSION].includes(version)) fail("SCHEMA_UNSUPPORTED", "This workspace requires a supported schema version.");
      if (application !== 0 && application !== APPLICATION_ID || version !== 0 && application !== APPLICATION_ID) fail("SCHEMA_UNSUPPORTED", "Open an EquityLayer research workspace only.");
      if (!allow_migration && version !== SCHEMA_VERSION && !(version === 0 && allow_creation)) {
        fail("SCHEMA_UPGRADE_REQUIRED", "Use an explicit upgrade from a private backup into a new workspace.");
      }
      startupRetry(() => this.#db.exec("PRAGMA journal_mode=WAL"));
      this.#db.exec("PRAGMA synchronous=FULL;");
      if (version === 0) this.#transaction("schema", () => {
        if (!allow_creation) fail("SCHEMA_UPGRADE_REQUIRED", "Use an explicit upgrade from a private backup into a new workspace.");
        // Another process can finish schema creation while this connection waits for its lock.
        const lockedVersion = this.#get("PRAGMA user_version").user_version;
        if ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, SCHEMA_VERSION].includes(lockedVersion) && this.#get("PRAGMA application_id").application_id === APPLICATION_ID) return;
        const lockedApplication = this.#get("PRAGMA application_id").application_id;
        if (lockedVersion !== 0 || lockedApplication !== 0 && lockedApplication !== APPLICATION_ID || this.#get("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
          fail("SCHEMA_UNSUPPORTED", "Do not initialize an unrelated or unsupported database.");
        }
        this.#db.exec(SCHEMA + MIGRATION_TWO + MIGRATION_THREE + MIGRATION_FOUR + METHOD_ARTIFACT_SCHEMA + METHOD_TRIAL_SCHEMA + SCHEDULE_SCHEMA + SCHEDULE_RUN_BINDING_SCHEMA + THESIS_SCHEMA + WORKER_SCHEMA + EXTERNAL_SESSION_SCHEMA + EXTERNAL_REVIEW_SCHEMA);
      });
      verifyRetainedIntegrity(this.#db);
      if ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(this.#get("PRAGMA user_version").user_version)) {
        if (!allow_migration) fail("SCHEMA_UPGRADE_REQUIRED", "Use an explicit upgrade from a private backup into a new workspace.");
        // Preserve a private snapshot before changing an existing workspace schema.
        this.backup(`before-schema-${this.#get("PRAGMA user_version").user_version + 1}-${randomUUID()}.sqlite`);
        this.#transaction("schema_upgrade", () => {
          if (this.#get("PRAGMA user_version").user_version === SCHEMA_VERSION) return;
          if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(this.#get("PRAGMA user_version").user_version) || this.#get("PRAGMA application_id").application_id !== APPLICATION_ID) fail("SCHEMA_UNSUPPORTED", "Upgrade a supported EquityLayer workspace only.");
          if (this.#get("PRAGMA user_version").user_version === 1) {
            this.#db.exec(MIGRATION_TWO);
          // Version one increments each watch review counter exactly once per retained review.
          const counters = new Map();
          for (const row of this.#all("SELECT v.*,r.watch_id FROM reviews v JOIN deliveries d USING(delivery_id) JOIN runs r USING(run_id) ORDER BY v.rowid")) {
            const expected = counters.get(row.watch_id) ?? 0; counters.set(row.watch_id, expected + 1);
            this.#write("UPDATE reviews SET expected_revision=?,record_sha256=? WHERE review_id=?", expected, contentHash(reviewContent(row, expected)), row.review_id);
          }
          }
          if (this.#get("PRAGMA user_version").user_version === 2) this.#db.exec(MIGRATION_THREE);
          if (this.#get("PRAGMA user_version").user_version === 3) this.#db.exec(MIGRATION_FOUR);
          if (this.#get("PRAGMA user_version").user_version === 4) this.#db.exec(METHOD_ARTIFACT_SCHEMA);
          if (this.#get("PRAGMA user_version").user_version === 5) this.#db.exec(METHOD_TRIAL_SCHEMA);
          if (this.#get("PRAGMA user_version").user_version === 6) this.#db.exec(SCHEDULE_SCHEMA);
          if (this.#get("PRAGMA user_version").user_version === 7) this.#db.exec(SCHEDULE_RUN_BINDING_SCHEMA);
          if (this.#get("PRAGMA user_version").user_version === 8) this.#db.exec(THESIS_SCHEMA);
          if (this.#get("PRAGMA user_version").user_version === 9) this.#db.exec(WORKER_SCHEMA);
          if (this.#get("PRAGMA user_version").user_version === 10) this.#db.exec(EXTERNAL_SESSION_SCHEMA);
          if (this.#get("PRAGMA user_version").user_version === 11) this.#db.exec(EXTERNAL_REVIEW_SCHEMA);
        });
      }
      verifyRetainedIntegrity(this.#db);
    } catch (error) { this.#db.close(); throw error; }
  }
  close() { this.#db.close(); }
  #now() { return integer(this.#clock()); }
  #get(sql, ...args) { return this.#db.prepare(sql).get(...args); }
  #all(sql, ...args) { return this.#db.prepare(sql).all(...args); }
  #write(sql, ...args) { return this.#db.prepare(sql).run(...args); }
  #readView(action) {
    let active = false;
    try {
      this.#db.exec("BEGIN"); active = true;
      const value = action(); this.#db.exec("COMMIT"); active = false;
      return value;
    } catch (error) {
      if (active) { try { this.#db.exec("ROLLBACK"); } catch { /* Preserve the original read failure. */ } }
      if (error instanceof LedgerError || error instanceof ExternalSessionError || error instanceof MethodArtifactError || error instanceof ScheduleError || error instanceof ThesisError || error.name === "RunContractError") throw error;
      throw new LedgerError("STORAGE_READ_FAILED", "Read the workspace again after checking storage.", { cause: error });
    }
  }
  #transaction(label, action) {
    let committed = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const output = action();
      this.#fault(`${label}:before_commit`);
      this.#db.exec("COMMIT"); committed = true;
      this.#fault(`${label}:after_commit`);
      return output;
    } catch (error) {
      if (!committed) { try { this.#db.exec("ROLLBACK"); } catch { /* The caller must inspect durable state after a storage error. */ } }
      if (error instanceof LedgerError || error instanceof ExternalSessionError || error instanceof ReferenceBridgeError || error instanceof ResultFileError || error instanceof LegacyWorkspaceError || error instanceof EventPlanError || error instanceof NormalizedFactError || error instanceof MethodArtifactError || error instanceof ScheduleError || error instanceof ThesisError || error.name === "RunContractError") throw error;
      throw new LedgerError("STORAGE_WRITE_UNCERTAIN", "Read durable state before retrying the local operation.", { cause: error });
    }
  }
  #notice(noticeId, payload) {
    this.#write("INSERT OR IGNORE INTO outbox(notice_id,payload_json) VALUES(?,?)", noticeId, json(payload));
  }
  prepareExternalSession(input, consent = {}) {
    return this.#transaction("external_prepare", () => {
      verifyRetainedSnapshot(this.#db);
      return prepareExternalSession(this.#db, input, this.#now(), consent, eventId => this.#lineageContext(eventId));
    });
  }
  workspaceSessionOptions(watchId, options = {}) {
    id(watchId);
    if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
        Object.keys(options).some(key => !["methods_after", "sources_after", "preparations_after", "limit", "source_event_id", "method_sha256"].includes(key))) fail("INVALID_INPUT", "Use the supported session page fields.");
    if (Object.hasOwn(options, "source_event_id") !== Object.hasOwn(options, "method_sha256")) fail("INVALID_INPUT", "Use both update references.");
    if (Object.hasOwn(options, "source_event_id")) {
      id(options.source_event_id);
      if (!/^[a-f0-9]{64}$/.test(options.method_sha256 ?? "")) fail("INVALID_INPUT", "Use the exact method hash.");
    }
    for (const key of ["methods_after", "sources_after", "preparations_after"]) if (Object.hasOwn(options, key)) integer(options[key]);
    if (Object.hasOwn(options, "limit")) integer(options.limit, 1);
    if ((options.limit ?? 20) > 50) fail("INVALID_INPUT", "Read at most 50 session options per page.");
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      return externalSessionOptions(this.#db, watchId, options, this.#now(), eventId => this.#lineageContext(eventId));
    });
  }
  externalSessionTask(contextId, consent = {}) {
    id(contextId);
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      return externalSessionTask(this.#db, contextId, this.#now(), consent, eventId => this.#lineageContext(eventId));
    });
  }
  submitExternalSession(input, consent = {}) {
    return this.#transaction("external_submit", () => {
      verifyRetainedSnapshot(this.#db);
      return submitExternalSession(this.#db, input, this.#now(), consent, eventId => this.#lineageContext(eventId));
    });
  }
  externalSessionRecord(recordId) {
    id(recordId);
    return this.#readView(() => { verifyRetainedSnapshot(this.#db); return externalSessionRecord(this.#db, recordId); });
  }
  externalSessionStatus(contextId) {
    id(contextId);
    return this.#readView(() => { verifyRetainedSnapshot(this.#db); return externalSessionStatus(this.#db, contextId); });
  }
  pageExternalSessionRecords({ after = 0, limit = 50, watch_id = null } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 external records per page.");
    if (watch_id !== null) id(watch_id);
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      return this.#all("SELECT r.record_id FROM external_session_records r JOIN external_session_contexts c USING(context_id) WHERE r.sequence>? AND (? IS NULL OR c.watch_id=?) ORDER BY r.sequence LIMIT ?", after, watch_id, watch_id, limit)
        .map(row => externalSessionRecord(this.#db, row.record_id));
    });
  }
  reviewExternalSession(input, consent = {}) {
    return this.#transaction("external_review", () => {
      verifyRetainedSnapshot(this.#db);
      return reviewExternalSession(this.#db, input, this.#now(), consent,
        id => checkExternalAcceptance(this.#db, id, this.#now(), eventId => this.#lineageContext(eventId)));
    });
  }
  workspaceExternalSessionRecord(recordId) {
    id(recordId);
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      return this.#externalResearchDetail(recordId);
    });
  }
  #externalResearchDetail(recordId) {
    const saved = externalSessionRecord(this.#db, recordId); if (!saved) return null;
    const watch = this.#get("SELECT * FROM watches WHERE watch_id=?", saved.context.scope.watch_id);
    let gate = null;
    try { checkExternalAcceptance(this.#db, recordId, this.#now(), eventId => this.#lineageContext(eventId)); }
    catch (error) { if (error instanceof ExternalSessionError) gate = error.code; else throw error; }
    return { kind: "external", sequence: saved.sequence, external_record_id: recordId, result: saved.record.result,
        received_at: saved.created_at,
        sha256: saved.record.content_sha256, session: saved.record.session, verification: saved.record.verification,
        current_revision: watch.current_revision, review_revision: watch.review_revision, is_current_revision: watch.current_revision === saved.context.scope.revision,
        accepted_evidence: researchSelection(this.#db, watch.watch_id, "accept_evidence")?.id === recordId,
        accepted_interpretation: researchSelection(this.#db, watch.watch_id, "accept_interpretation")?.id === recordId,
        evidence_reference: researchSelection(this.#db, watch.watch_id, "accept_evidence"),
        interpretation_reference: researchSelection(this.#db, watch.watch_id, "accept_interpretation"), acceptance_gate: gate,
        private_context: JSON.parse(this.#get("SELECT context_json FROM revisions WHERE watch_id=? AND revision=?", watch.watch_id, saved.context.scope.revision).context_json),
        provenance: { context_id: saved.context.context_id, method_bundle: saved.context.method_bundle, source_records: saved.context.source_records,
          baselines: saved.context.baselines, evaluation_at: saved.context.evaluation_at, verification: saved.record.verification,
          ...(saved.record.schema_version === 2 ? { source_dates: saved.record.source_dates } : {}) },
        review_count: this.#get("SELECT COUNT(*) AS count FROM external_session_reviews WHERE record_id=?", recordId).count,
        reviews: this.#all("SELECT sequence,review_id,action,note,created_at,expected_revision FROM external_session_reviews WHERE record_id=? ORDER BY sequence DESC LIMIT 10", recordId).reverse().map(row => ({ ...row })) };
  }
  pageExternalResearch({ after = 0, limit = 50, watch_id = null, order = "oldest" } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 external records per page.");
    const { comparison, direction } = pageOrder(order);
    if (watch_id !== null) id(watch_id);
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      return this.#all(`SELECT r.record_id FROM external_session_records r JOIN external_session_contexts c USING(context_id) WHERE (?=0 OR r.sequence${comparison}?) AND (? IS NULL OR c.watch_id=?) ORDER BY r.sequence ${direction} LIMIT ?`, after, after, watch_id, watch_id, limit).map(row => {
        const detail = this.#externalResearchDetail(row.record_id);
        const { private_context, provenance, reviews, ...summary } = detail;
        return { ...summary, result: Object.fromEntries(Object.entries(detail.result).filter(([key]) => !["sources", "drivers", "falsifiers", "unknowns"].includes(key))),
          source_count: detail.result.sources.length };
      });
    });
  }
  pageExternalReviews(recordId, { after = 0, limit = 50 } = {}) {
    id(recordId); integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 external reviews per page.");
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      if (!this.#get("SELECT record_id FROM external_session_records WHERE record_id=?", recordId)) fail("EXTERNAL_RECORD_MISSING", "Read reviews for retained research only.");
      return this.#all("SELECT sequence,review_id,action,note,created_at,expected_revision FROM external_session_reviews WHERE record_id=? AND sequence>? ORDER BY sequence LIMIT ?", recordId, after, limit).map(row => ({ ...row }));
    });
  }
  #updateThesisManifest() { this.#write("UPDATE thesis_manifest SET sha256=? WHERE singleton=1", thesisManifestHash(this.#db)); }
  proposeThesis(input) {
    const p = validateThesisProposal(input), payload = json(p), sha256 = contentHash(p);
    return this.#transaction("thesis_propose", () => {
      verifyRetainedSnapshot(this.#db);
      const existing = this.#get("SELECT sha256,proposal_json FROM thesis_proposals WHERE thesis_id=? AND revision=?", p.thesis_id, p.revision);
      if (existing) {
        if (existing.sha256 !== sha256 || existing.proposal_json !== payload) thesisFail("THESIS_REVISION_CONFLICT", "The retained thesis revision has different content.");
        return { thesis_id: p.thesis_id, revision: p.revision, sha256, reused: true, adopted: false };
      }
      checkThesisReferences(this.#db, p);
      const watch = this.#get("SELECT current_revision FROM watches WHERE watch_id=?", p.scope.watch_id);
      if (watch.current_revision !== p.scope.revision) thesisFail("THESIS_SCOPE_CHANGED", "Use the current watch scope for a new proposal.");
      const head = this.#get("SELECT * FROM thesis_heads WHERE thesis_id=?", p.thesis_id);
      const prior = head && this.#get("SELECT sha256,proposal_json FROM thesis_proposals WHERE thesis_id=? AND revision=?", p.thesis_id, head.current_revision);
      const previous = prior && JSON.parse(prior.proposal_json);
      if (head ? p.revision !== head.current_revision + 1 || p.parent_sha256 !== prior.sha256 || p.scope.watch_id !== head.watch_id ||
          previous.research_topic !== p.research_topic : p.revision !== 1) thesisFail("THESIS_REVISION_CONFLICT", "Pin the exact previous thesis revision without replacing history.");
      if (previous?.claims.some(claim => !p.claims.some(next => next.claim_id === claim.claim_id))) thesisFail("THESIS_CLAIM_REMOVED", "Retire prior claims explicitly instead of deleting their identities.");
      const delta = thesisDelta(previous ?? null, p);
      if (!head) this.#write("INSERT INTO thesis_heads VALUES(?,?,?,0,NULL,NULL)", p.thesis_id, p.scope.watch_id, p.revision);
      this.#write("INSERT INTO thesis_proposals(thesis_id,revision,sha256,proposal_json,created_at) VALUES(?,?,?,?,?)", p.thesis_id, p.revision, sha256, payload, this.#now());
      this.#write("UPDATE thesis_heads SET current_revision=? WHERE thesis_id=?", p.revision, p.thesis_id);
      if (delta.has_research_change) this.#notice(`thesis:${p.thesis_id}:${p.revision}`, { kind: "thesis_candidate", thesis_id: p.thesis_id, revision: p.revision, proposal_sha256: sha256 });
      this.#updateThesisManifest();
      return { thesis_id: p.thesis_id, revision: p.revision, sha256, reused: false, adopted: false, delta };
    });
  }
  thesis(thesisId, { after = 0, limit = 20, review_after = 0, review_limit = 20 } = {}) {
    id(thesisId); integer(after); integer(limit, 1); integer(review_after); integer(review_limit, 1);
    if (limit > 100 || review_limit > 100) fail("INVALID_INPUT", "Read at most 100 thesis records per page.");
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      const head = this.#get("SELECT * FROM thesis_heads WHERE thesis_id=?", thesisId);
      if (!head) return null;
      const proposals = this.#all("SELECT revision,sha256,proposal_json,created_at FROM thesis_proposals WHERE thesis_id=? AND revision>? ORDER BY revision LIMIT ?", thesisId, after, limit)
        .map(row => {
          const p = JSON.parse(row.proposal_json), previous = row.revision > 1 ? JSON.parse(this.#get("SELECT proposal_json FROM thesis_proposals WHERE thesis_id=? AND revision=?", thesisId, row.revision - 1).proposal_json) : null;
          return { revision: row.revision, sha256: row.sha256, proposal: p, delta: thesisDelta(previous, p), created_at: row.created_at };
        });
      const reviews = this.#all("SELECT sequence,review_json,created_at FROM thesis_reviews WHERE thesis_id=? AND sequence>? ORDER BY sequence LIMIT ?", thesisId, review_after, review_limit)
        .map(row => ({ ...JSON.parse(row.review_json), sequence: row.sequence, created_at: row.created_at }));
      return { ...head, proposals, reviews, next_revision: proposals.at(-1)?.revision ?? after, proposals_has_more: proposals.length === limit,
        next_review_after: reviews.at(-1)?.sequence ?? review_after, reviews_has_more: reviews.length === review_limit,
        verification: "structural_only", source_authenticity: "not_verified", author_authenticity: "not_verified" };
    });
  }
  pageTheses({ after = 0, limit = 50, watch_id = null, order = "oldest" } = {}) {
    integer(after); integer(limit, 1);
    const { comparison, direction } = pageOrder(order);
    if (watch_id !== null) id(watch_id);
    if (limit > 100) fail("INVALID_INPUT", "Read at most 100 thesis candidates per page.");
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      return this.#all(`SELECT p.sequence,p.thesis_id,p.revision,p.sha256,p.proposal_json,p.created_at,h.current_revision,h.review_revision,h.evidence_revision,h.interpretation_revision,w.current_revision AS current_scope_revision FROM thesis_proposals p JOIN thesis_heads h USING(thesis_id) JOIN watches w ON w.watch_id=h.watch_id WHERE (?=0 OR p.sequence${comparison}?) AND (? IS NULL OR h.watch_id=?) ORDER BY p.sequence ${direction} LIMIT ?`, after, after, watch_id, watch_id, limit)
        .map(row => { const p = JSON.parse(row.proposal_json); const { proposal_json, ...metadata } = row;
          return { ...metadata, title: p.title, watch_id: p.scope.watch_id, scope: p.scope, research_topic: p.research_topic, origin_kind: p.origin.kind,
            is_current_revision: row.current_revision === p.revision && row.current_scope_revision === p.scope.revision,
            review_count: row.review_revision, accepted_evidence: row.evidence_revision === p.revision, accepted_interpretation: row.interpretation_revision === p.revision }; });
    });
  }
  #thesisByHash(sha256) {
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) fail("INVALID_INPUT", "Use an exact thesis hash.");
    const row = this.#get("SELECT * FROM thesis_proposals WHERE sha256=?", sha256);
    if (!row) thesisFail("THESIS_REFERENCE_MISSING", "The local thesis revision does not exist.");
    return row;
  }
  #requireThesisAcceptance(p, head, action) {
    const watch = this.#get("SELECT current_revision FROM watches WHERE watch_id=?", head.watch_id);
    if (head.current_revision !== p.revision || watch.current_revision !== p.scope.revision || p.counterevidence_search === "not_started" ||
        p.claims.some(claim => claim.status === "conflict") || !p.claims.some(claim => claim.status !== "retired") ||
        !p.claims.some(claim => claim.evidence_refs.length)) thesisFail("THESIS_ACCEPTANCE_GATED", "Resolve scope, source gaps, conflicts, and counterevidence review before acceptance.");
    for (const claim of p.claims) for (const evidence of claim.evidence_refs) {
      const source = this.source(evidence.source_ref.source_event_id);
      const policy = this.sourcePolicy(head.watch_id, source.artifact.source_id)?.policy;
      if (!policy || policy.rights_status !== "ALLOWED" || !policy.allowed_purposes.includes("local_research")) thesisFail("THESIS_ACCEPTANCE_GATED", "Resolve local source rights before accepting a thesis baseline.");
      if (policy.parser_version !== source.event.parser_version || policy.adapter_version !== source.event.adapter_version) thesisFail("THESIS_ACCEPTANCE_GATED", "Review changed source schemas before accepting a thesis baseline.");
      if ((source.event.event_kind === "CORRECTED_PERIOD" || source.event.supersedes_source_event_id !== null) &&
          !this.#get("SELECT decision_id FROM event_decisions WHERE source_event_id=? AND watch_id=? AND revision=? AND json_extract(decision_json,'$.outcome')='queued'", source.event.source_event_id, head.watch_id, p.scope.revision)) thesisFail("THESIS_ACCEPTANCE_GATED", "Resolve correction lineage through source intake before accepting a thesis baseline.");
      if (this.#now() < Date.parse(source.artifact.retrieved_at) || this.#now() - Date.parse(source.artifact.retrieved_at) > policy.max_source_age_ms ||
          this.#get("SELECT event_id FROM source_events WHERE json_extract(event_json,'$.event_kind')='CORRECTED_PERIOD' AND json_extract(event_json,'$.supersedes_source_event_id')=?", evidence.source_ref.source_event_id)) thesisFail("THESIS_ACCEPTANCE_GATED", "Review stale or corrected source evidence before acceptance.");
    }
    if (action === "accept_interpretation" && head.evidence_revision !== p.revision) thesisFail("THESIS_ACCEPTANCE_GATED", "Accept this revision's evidence before its interpretation.");
  }
  #thesisSourceRows(p) {
    const refs = new Map(p.claims.flatMap(claim => claim.evidence_refs.map(evidence => [evidence.source_ref.source_event_id, evidence.source_ref])));
    return [...refs.values()].sort((a, b) => a.source_event_id < b.source_event_id ? -1 : a.source_event_id > b.source_event_id ? 1 : 0)
      .map((ref, index) => {
        const source = this.source(ref.source_event_id), policy = this.sourcePolicy(p.scope.watch_id, source.artifact.source_id);
        return { sequence: index + 1, ...ref, url: source.artifact.canonical_url, published_at: source.artifact.published_at,
          retrieved_at: source.artifact.retrieved_at, source_period: source.artifact.source_period, source_class: source.artifact.source_class,
          local_rights_status: policy?.policy.rights_status ?? "UNKNOWN" };
      });
  }
  workspaceThesis(sha256) {
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      const row = this.#thesisByHash(sha256), p = JSON.parse(row.proposal_json);
      const head = this.#get("SELECT * FROM thesis_heads WHERE thesis_id=?", p.thesis_id);
      const watch = this.#get("SELECT current_revision FROM watches WHERE watch_id=?", head.watch_id);
      const gates = {};
      for (const action of ["accept_evidence", "accept_interpretation"]) {
        try { this.#requireThesisAcceptance(p, head, action); gates[action] = null; }
        catch (error) { if (!(error instanceof ThesisError) || error.code !== "THESIS_ACCEPTANCE_GATED") throw error;
          gates[action] = { code: error.code, message: error.message }; }
      }
      const previous = p.revision > 1 ? JSON.parse(this.#get("SELECT proposal_json FROM thesis_proposals WHERE thesis_id=? AND revision=?", p.thesis_id, p.revision - 1).proposal_json) : null;
      const sources = this.#thesisSourceRows(p);
      const reviews = this.#all("SELECT sequence,review_json,created_at FROM thesis_reviews WHERE thesis_id=? ORDER BY sequence DESC LIMIT 10", p.thesis_id)
        .reverse().map(item => ({ ...JSON.parse(item.review_json), sequence: item.sequence, created_at: item.created_at }));
      const baseline = revision => revision === null ? null : this.#get("SELECT sha256 FROM thesis_proposals WHERE thesis_id=? AND revision=?", p.thesis_id, revision).sha256;
      return { kind: "thesis", ...head, revision: p.revision, sha256: row.sha256, proposal: p, delta: thesisDelta(previous, p), created_at: row.created_at,
        current_scope_revision: watch.current_revision, is_current_revision: head.current_revision === p.revision && watch.current_revision === p.scope.revision,
        accepted_evidence: head.evidence_revision === p.revision, accepted_interpretation: head.interpretation_revision === p.revision,
        evidence_sha256: baseline(head.evidence_revision), interpretation_sha256: baseline(head.interpretation_revision),
        acceptance_gates: gates, sources: sources.slice(0, 20), source_count: sources.length, sources_has_more: sources.length > 20,
        sources_next_after: Math.min(sources.length, 20), reviews, review_count: head.review_revision,
        verification: "structural_only", source_authenticity: "not_verified", author_authenticity: "not_verified" };
    });
  }
  pageThesisSources(sha256, { after = 0, limit = 50 } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 source references per page.");
    return this.#readView(() => { verifyRetainedSnapshot(this.#db); const row = this.#thesisByHash(sha256);
      return this.#thesisSourceRows(JSON.parse(row.proposal_json)).slice(after, after + limit); });
  }
  pageThesisReviews(sha256, { after = 0, limit = 50 } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 reviews per page.");
    return this.#readView(() => { verifyRetainedSnapshot(this.#db); const row = this.#thesisByHash(sha256);
      return this.#all("SELECT sequence,review_json,created_at FROM thesis_reviews WHERE thesis_id=? AND sequence>? ORDER BY sequence LIMIT ?", row.thesis_id, after, limit)
        .map(item => ({ ...JSON.parse(item.review_json), sequence: item.sequence, created_at: item.created_at })); });
  }
  reviewThesis(input, { confirm_human_review = false } = {}) {
    if (confirm_human_review !== true) thesisFail("THESIS_HUMAN_REVIEW_REQUIRED", "Confirm the local owner's human review outside the proposal record.");
    const r = validateThesisReview(input);
    return this.#transaction("thesis_review", () => {
      verifyRetainedSnapshot(this.#db);
      const prior = this.#get("SELECT review_json FROM thesis_reviews WHERE review_id=?", r.review_id);
      if (prior) {
        if (prior.review_json !== json(r)) thesisFail("THESIS_REVIEW_CONFLICT", "The review ID already identifies a different decision.");
        return { review_id: r.review_id, reused: true };
      }
      const head = this.#get("SELECT * FROM thesis_heads WHERE thesis_id=?", r.thesis_id);
      const row = this.#get("SELECT sha256,proposal_json FROM thesis_proposals WHERE thesis_id=? AND revision=?", r.thesis_id, r.revision);
      if (!head || !row || row.sha256 !== r.proposal_sha256) thesisFail("THESIS_REFERENCE_MISSING", "Review the exact retained thesis hash.");
      if (head.review_revision !== r.expected_review_revision) thesisFail("THESIS_REVIEW_CONFLICT", "Reload the current review revision before deciding.");
      if (r.action.startsWith("accept_")) this.#requireThesisAcceptance(JSON.parse(row.proposal_json), head, r.action);
      const now = this.#now();
      this.#write("INSERT INTO thesis_reviews(review_id,thesis_id,revision,sha256,review_json,created_at) VALUES(?,?,?,?,?,?)", r.review_id, r.thesis_id, r.revision, contentHash({ review: r, created_at: now }), json(r), now);
      const field = r.action === "accept_evidence" ? "evidence_revision" : r.action === "accept_interpretation" ? "interpretation_revision" : null;
      if (field) this.#write(`UPDATE thesis_heads SET ${field}=? WHERE thesis_id=?`, r.revision, r.thesis_id);
      this.#write("UPDATE thesis_heads SET review_revision=review_revision+1 WHERE thesis_id=?", r.thesis_id);
      this.#write("UPDATE outbox SET acknowledged_at=? WHERE notice_id=? AND acknowledged_at IS NULL", now, `thesis:${r.thesis_id}:${r.revision}`);
      this.#updateThesisManifest();
      return { review_id: r.review_id, reused: false };
    });
  }
  configureSchedule(input) {
    const config = validateScheduleConfig(input);
    return this.#transaction("schedule_config", () => this.#configureSchedule(config));
  }
  #configureSchedule(config) {
      const payload = json(config), sha256 = contentHash(config);
      const existing = this.#get("SELECT * FROM schedule_configs WHERE schedule_id=? AND revision=?", config.schedule_id, config.revision);
      if (existing) {
        this.#scheduleRecord({ schedule_id: config.schedule_id, revision: config.revision });
        if (existing.sha256 !== sha256) fail("SCHEDULE_CONFIG_CONFLICT", "A retained schedule revision is immutable.");
        return { schedule_id: config.schedule_id, revision: config.revision, sha256, reused: true };
      }
      const prior = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", config.schedule_id);
      if (prior) this.#scheduleRecord(prior);
      if (config.revision !== (prior?.revision ?? 0) + 1) fail("SCHEDULE_CONFIG_CONFLICT", "Save the next schedule revision without replacing history.");
      const watch = this.#get("SELECT current_revision FROM watches WHERE watch_id=?", config.watch_id);
      if (!watch || watch.current_revision !== config.scope_revision) fail("SCHEDULE_SCOPE_CHANGED", "Configure the current watch revision.");
      if (!this.#get("SELECT bundle_sha256 FROM methods WHERE bundle_sha256=?", config.method_sha256)) fail("REFERENCE_MISSING", "Retain the scheduled method first.");
      if (prior?.owner) this.#interruptSchedule(prior, "SCHEDULE_CONFIG_CHANGED");
      this.#write("INSERT INTO schedule_configs VALUES(?,?,?,?,?,?)", config.schedule_id, config.revision, config.watch_id, config.scope_revision, sha256, payload);
      if (prior) this.#write("UPDATE schedule_state SET revision=?,enabled=1,next_due=?,owner=NULL,lease_until=NULL WHERE schedule_id=?", config.revision, this.#now(), config.schedule_id);
      else this.#write("INSERT INTO schedule_state(schedule_id,revision,enabled,next_due,fence,owner,lease_until,started_at,last_finished_at,last_tick_id) VALUES(?,?,1,?,0,NULL,NULL,NULL,NULL,NULL)", config.schedule_id, config.revision, this.#now());
      return { schedule_id: config.schedule_id, revision: config.revision, sha256, reused: false };
  }
  resumeObservationSchedule(scheduleId, expected) {
    id(scheduleId);
    if (!expected || Object.getPrototypeOf(expected) !== Object.prototype ||
        Object.keys(expected).some(key => !["revision", "config_sha256", "confirm_resume"].includes(key)) ||
        !Number.isSafeInteger(expected.revision) || expected.revision < 1 || !/^[a-f0-9]{64}$/.test(expected.config_sha256 ?? "") ||
        expected.confirm_resume !== true) fail("INVALID_INPUT", "Confirm the exact stopped source-check configuration.");
    return this.#transaction("schedule_resume_observe", () => {
      const state = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", scheduleId);
      if (!state) fail("SCHEDULE_MISSING", "Configure source checks before resuming them.");
      const saved = this.#scheduleRecord(state);
      const prior = this.#get("SELECT revision FROM schedule_configs WHERE schedule_id=? AND revision=?", scheduleId, expected.revision);
      if (!prior) fail("SCHEDULE_CONFLICT", "Read the current stopped configuration before resuming source checks.");
      const original = this.#scheduleRecord({ schedule_id: scheduleId, revision: prior.revision });
      if (original.config_sha256 !== expected.config_sha256) fail("SCHEDULE_CONFLICT", "Read the exact stopped configuration before resuming source checks.");
      if (original.config.max_runs !== 0 || original.config.runtime_sha256 !== null)
        fail("OBSERVATION_SCHEDULE_REQUIRED", "This command cannot resume an AI execution schedule.");
      const next = validateScheduleConfig({ ...original.config, revision: original.config.revision + 1 });
      const outcome = reused => ({ schedule: this.scheduleStatus(scheduleId), reused, worker_started: false,
        ai_execution_authorized: false, research_completion_verified: false });
      // Exact replay acknowledges the saved revision. It never enables a later stop again.
      if (state.revision === next.revision && saved.config_sha256 === contentHash(next)) return outcome(true);
      if (state.revision !== expected.revision || saved.config_sha256 !== expected.config_sha256 || state.enabled)
        fail("SCHEDULE_CONFLICT", "Resume only the exact stopped configuration.");
      if (this.#get("SELECT current_revision FROM watches WHERE watch_id=?", original.config.watch_id)?.current_revision !== original.config.scope_revision)
        fail("SCHEDULE_SCOPE_CHANGED", "Review the changed watch before configuring source checks.");
      const source = this.sourcePolicy(original.config.watch_id, original.config.source_id)?.policy;
      if (source?.rights_status !== "ALLOWED" || !source.allowed_purposes.includes("local_research"))
        fail("SOURCE_RIGHTS_GATED", "Resolve current local source permission before resuming source checks.");
      this.#configureSchedule(next);
      return outcome(false);
    });
  }
  #scheduleRecord(state) {
    const row = this.#get("SELECT * FROM schedule_configs WHERE schedule_id=? AND revision=?", state.schedule_id, state.revision);
    if (!row) fail("STORAGE_CORRUPT", "The retained schedule configuration is missing.");
    const config = validateScheduleConfig(JSON.parse(row.config_json));
    if (contentHash(config) !== row.sha256 || canonicalJson(config) !== row.config_json || config.schedule_id !== row.schedule_id ||
        config.revision !== row.revision || config.watch_id !== row.watch_id || config.scope_revision !== row.scope_revision) {
      fail("STORAGE_CORRUPT", "The retained schedule configuration changed.");
    }
    return { ...state, config, config_sha256: row.sha256 };
  }
  #writeScheduleTick(state, status, events, deliveries, codes) {
    const finished = Math.max(this.#now(), state.started_at);
    const record = validateScheduleTick({ schema_version: 1, tick_id: scheduleTickId(state.schedule_id, state.revision, state.fence),
      schedule_id: state.schedule_id, revision: state.revision, fence: state.fence, started_at: state.started_at, finished_at: finished,
      status, events, deliveries, codes: [...new Set(codes)].sort() }, this.#scheduleRecord(state).config);
    this.#write("INSERT INTO schedule_ticks VALUES(?,?,?,?,?,?)", record.tick_id, state.schedule_id, state.revision, state.fence, contentHash(record), json(record));
    this.#write("UPDATE schedule_state SET last_tick_id=?,last_finished_at=? WHERE schedule_id=?", record.tick_id, finished, state.schedule_id);
    for (const code of record.codes) this.#notice(`schedule:${state.schedule_id}:${state.revision}:${code}`,
      { kind: "schedule_gate", schedule_id: state.schedule_id, revision: state.revision, gate_code: code });
    return record;
  }
  #interruptSchedule(state, code) {
    for (const run of this.#all("SELECT r.* FROM runs r JOIN schedule_run_leases l ON l.run_id=r.run_id AND l.run_fence=r.fence WHERE l.schedule_id=? AND l.schedule_revision=? AND l.schedule_fence=? AND r.status='running'",
      state.schedule_id, state.revision, state.fence)) {
      const budgetGate = this.#releaseUndispatched(run); const gate = budgetGate ?? code;
      this.#write("UPDATE runs SET status='gated',gate_code=?,owner=NULL,lease_until=NULL WHERE run_id=?", gate, run.run_id);
      this.#notice(`gate:${run.run_id}:${gate}`, { run_id: run.run_id, gate_code: gate });
    }
    return this.#writeScheduleTick(state, "interrupted", null, null, [code]);
  }
  #activeSchedule(lease) {
    const state = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", id(lease.schedule_id));
    if (!state || !state.enabled || state.revision !== lease.revision || state.owner !== lease.owner || state.fence !== lease.fence ||
        state.lease_until === null || state.lease_until <= this.#now()) fail("SCHEDULE_LEASE_LOST", "Acquire a current schedule lease before processing sources.");
    const record = this.#scheduleRecord(state);
    const workerBinding = this.#get("SELECT * FROM schedule_worker_ticks WHERE schedule_id=? AND schedule_fence=?", state.schedule_id, state.fence);
    if (Boolean(workerBinding) !== Boolean(state.worker_fence)) fail("STORAGE_CORRUPT", "The continuous check binding is incomplete.");
    if (workerBinding) {
      const bound = validateWorkerBinding(workerBinding), worker = this.#workerRecord(state.schedule_id);
      if (!worker || bound.worker_fence !== state.worker_fence || worker.state !== "running" || worker.fence !== bound.worker_fence || worker.revision !== state.revision ||
          worker.config_sha256 !== record.config_sha256 || worker.lease_until <= this.#now()) {
        fail("SCHEDULE_LEASE_LOST", "The continuous worker no longer authorizes this check.");
      }
    }
    const watch = this.#get("SELECT current_revision FROM watches WHERE watch_id=?", record.config.watch_id);
    if (watch.current_revision !== record.config.scope_revision) fail("SCHEDULE_SCOPE_CHANGED", "Review the changed scope before the next scheduled run.");
    if (record.config_sha256 !== lease.config_sha256) fail("SCHEDULE_CONFIG_CONFLICT", "Use the exact configured schedule hash.");
    return record;
  }
  claimSchedule(scheduleId, owner, leaseMs = 30_000, { worker_lease } = {}) {
    id(scheduleId); id(owner); integer(leaseMs, 1);
    return this.#transaction("schedule_claim", () => {
      const state = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", scheduleId);
      if (!state) fail("SCHEDULE_MISSING", "Configure a schedule before starting its worker.");
      const now = this.#now();
      const worker = this.#workerRecord(scheduleId);
      if (worker_lease) {
        this.#activeWorker(worker_lease);
        if (worker_lease.owner !== owner || worker_lease.schedule_id !== scheduleId) fail("WORKER_LEASE_LOST", "Use the current continuous worker identity and schedule.");
      } else if (worker?.state === "running" && worker.lease_until > now) return null;
      if (!state.enabled || state.owner && state.lease_until > now || state.next_due > now) return null;
      const saved = this.#scheduleRecord(state);
      if (state.owner) this.#interruptSchedule(state, "SCHEDULE_WORKER_INTERRUPTED");
      const watch = this.#get("SELECT current_revision FROM watches WHERE watch_id=?", saved.config.watch_id);
      if (watch.current_revision !== saved.config.scope_revision) {
        this.#write("UPDATE schedule_state SET enabled=0,owner=NULL,lease_until=NULL WHERE schedule_id=?", scheduleId);
        this.#notice(`schedule:${scheduleId}:${state.revision}:SCHEDULE_SCOPE_CHANGED`, { kind: "schedule_gate", schedule_id: scheduleId, gate_code: "SCHEDULE_SCOPE_CHANGED" });
        return null;
      }
      const until = integer(Math.min(now + leaseMs, now + saved.config.tick_timeout_ms));
      this.#write("UPDATE schedule_state SET owner=?,fence=fence+1,lease_until=?,started_at=?,worker_fence=? WHERE schedule_id=?", owner, until, now, worker_lease?.fence ?? 0, scheduleId);
      if (worker_lease) {
        const binding = { schedule_id: scheduleId, schedule_fence: state.fence + 1, worker_fence: worker_lease.fence,
          revision: state.revision, config_sha256: saved.config_sha256 };
        this.#write("INSERT INTO schedule_worker_ticks VALUES(?,?,?,?,?,?)", scheduleId, binding.schedule_fence, binding.worker_fence,
          binding.revision, contentHash(binding), json(binding));
      }
      return this.#scheduleRecord(this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", scheduleId));
    });
  }
  #workerRecord(scheduleId) {
    const row = this.#get("SELECT * FROM schedule_workers WHERE schedule_id=?", id(scheduleId));
    if (!row) return null;
    const value = validateWorkerRecord(row);
    if (this.#scheduleRecord(value).config_sha256 !== value.config_sha256) fail("STORAGE_CORRUPT", "The continuous worker configuration changed.");
    return value;
  }
  #saveWorker(value) {
    const payload = json(value), sha256 = contentHash(value);
    validateWorkerRecord({ schedule_id: value.schedule_id, revision: value.revision, fence: value.fence, sha256, record_json: payload });
    this.#write("INSERT INTO schedule_workers VALUES(?,?,?,?,?) ON CONFLICT(schedule_id) DO UPDATE SET revision=excluded.revision,fence=excluded.fence,sha256=excluded.sha256,record_json=excluded.record_json",
      value.schedule_id, value.revision, value.fence, sha256, payload);
    return value;
  }
  #activeWorker(lease) {
    const worker = this.#workerRecord(lease?.schedule_id);
    if (!worker || worker.state !== "running" || worker.owner !== lease.owner || worker.fence !== lease.fence || worker.revision !== lease.revision ||
        worker.config_sha256 !== lease.config_sha256 || worker.lease_until <= this.#now()) fail("WORKER_LEASE_LOST", "Acquire a current continuous worker lease.");
    const state = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", worker.schedule_id);
    if (!state.enabled) fail("WORKER_SCHEDULE_STOPPED", "The retained schedule is stopped.");
    if (state.revision !== worker.revision || this.#scheduleRecord(state).config_sha256 !== worker.config_sha256) fail("WORKER_CONFIG_CHANGED", "Restart explicitly for the changed schedule configuration.");
    const config = this.#scheduleRecord(state).config;
    if (this.#get("SELECT current_revision FROM watches WHERE watch_id=?", config.watch_id).current_revision !== config.scope_revision) fail("WORKER_SCOPE_CHANGED", "Review the changed watch before restarting tracking.");
    return worker;
  }
  claimScheduleWorker(scheduleId, owner, expected, leaseMs = 15_000) {
    id(scheduleId); id(owner); integer(leaseMs, 1000); if (leaseMs > 60_000) fail("INVALID_INPUT", "Use a worker lease of at most one minute.");
    if (!expected || !Number.isSafeInteger(expected.revision) || expected.revision < 1 || !/^[a-f0-9]{64}$/.test(expected.config_sha256 ?? "")) fail("INVALID_INPUT", "Pin the schedule revision and configuration hash.");
    return this.#transaction("worker_claim", () => {
      const state = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", scheduleId);
      if (!state) fail("SCHEDULE_MISSING", "Configure a schedule before starting tracking.");
      const saved = this.#scheduleRecord(state), prior = this.#workerRecord(scheduleId), now = this.#now();
      if (!state.enabled) fail("WORKER_SCHEDULE_STOPPED", "The retained schedule is stopped.");
      if (state.revision !== expected.revision || saved.config_sha256 !== expected.config_sha256) fail("WORKER_CONFIG_CHANGED", "Start only the exact reviewed schedule configuration.");
      if (this.#get("SELECT current_revision FROM watches WHERE watch_id=?", saved.config.watch_id).current_revision !== saved.config.scope_revision) fail("WORKER_SCOPE_CHANGED", "Review the changed watch before starting tracking.");
      if (prior?.state === "running" && prior.lease_until > now) return null;
      if (state.owner) {
        if (state.worker_fence === 0 && state.lease_until > now) return null;
        this.#interruptSchedule(state, "SCHEDULE_WORKER_INTERRUPTED");
        this.#write("UPDATE schedule_state SET owner=NULL,lease_until=NULL WHERE schedule_id=?", scheduleId);
      }
      const worker = this.#saveWorker({ schedule_id: scheduleId, revision: state.revision, config_sha256: saved.config_sha256, fence: (prior?.fence ?? 0) + 1,
        owner, started_at: now, heartbeat_at: now, lease_until: integer(now + leaseMs), state: "running", finished_at: null, code: null });
      return { ...worker, config: saved.config };
    });
  }
  heartbeatScheduleWorker(lease, leaseMs = 15_000) {
    integer(leaseMs, 1000); if (leaseMs > 60_000) fail("INVALID_INPUT", "Use a worker lease of at most one minute.");
    return this.#transaction("worker_heartbeat", () => {
      const worker = this.#activeWorker(lease), now = this.#now();
      return this.#saveWorker({ ...worker, heartbeat_at: Math.max(worker.heartbeat_at, now), lease_until: integer(Math.max(worker.lease_until, now + leaseMs)) });
    });
  }
  finishScheduleWorker(lease, code = "WORKER_PROCESS_STOPPED", failed = false) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code) || typeof failed !== "boolean") fail("INVALID_INPUT", "Use a worker outcome and bounded error code.");
    return this.#transaction("worker_finish", () => {
      const worker = this.#workerRecord(lease?.schedule_id);
      if (!worker || worker.owner !== lease.owner || worker.fence !== lease.fence || worker.revision !== lease.revision || worker.config_sha256 !== lease.config_sha256) fail("WORKER_LEASE_LOST", "A replacement worker owns this tracking record.");
      if (worker.state !== "running") return worker;
      const state = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", worker.schedule_id);
      if (state.owner && state.worker_fence === worker.fence) {
        this.#interruptSchedule(state, "SCHEDULE_WORKER_INTERRUPTED");
        this.#write("UPDATE schedule_state SET owner=NULL,lease_until=NULL WHERE schedule_id=?", worker.schedule_id);
      }
      return this.#saveWorker({ ...worker, state: failed ? "failed" : "stopped", finished_at: Math.max(worker.heartbeat_at, this.#now()), code });
    });
  }
  scheduleWorkerStatus(scheduleId) {
    const value = this.#workerRecord(scheduleId);
    if (!value) return { state: "not_verified", last_seen_at: null, code: null };
    const state = this.#get("SELECT revision,enabled FROM schedule_state WHERE schedule_id=?", scheduleId);
    return { state: value.state === "running" && value.lease_until > this.#now() && state.enabled && state.revision === value.revision ? "monitoring" : "offline",
      last_seen_at: value.heartbeat_at, code: value.code, revision: value.revision, fence: value.fence };
  }
  heartbeatSchedule(lease, leaseMs = 30_000) {
    integer(leaseMs, 1);
    return this.#transaction("schedule_heartbeat", () => {
      const state = this.#activeSchedule(lease);
      const until = Math.min(Math.max(state.lease_until, this.#now() + leaseMs), state.started_at + state.config.tick_timeout_ms);
      this.#write("UPDATE schedule_state SET lease_until=? WHERE schedule_id=?", integer(until), state.schedule_id);
      return { ...state, lease_until: until };
    });
  }
  finishSchedule(lease, { status, events, deliveries, codes }) {
    if (!["completed", "gated", "failed"].includes(status) || !Array.isArray(codes) || codes.length > 100 ||
        codes.some(code => typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code))) fail("INVALID_INPUT", "Use bounded schedule outcomes and error codes.");
    integer(events); integer(deliveries);
    return this.#transaction("schedule_finish", () => {
      const state = this.#activeSchedule(lease);
      const record = this.#writeScheduleTick(state, status, events, deliveries, codes);
      this.#write("UPDATE schedule_state SET owner=NULL,lease_until=NULL,next_due=? WHERE schedule_id=?",
        integer(record.finished_at + state.config.interval_ms), state.schedule_id);
      return record;
    });
  }
  stopSchedule(scheduleId, expected = null) {
    if (expected !== null && (!Number.isSafeInteger(expected.revision) || expected.revision < 1 ||
        typeof expected.config_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.config_sha256))) {
      fail("INVALID_INPUT", "Use the exact schedule revision and configuration hash.");
    }
    return this.#transaction("schedule_stop", () => {
      const state = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", id(scheduleId));
      if (!state) fail("SCHEDULE_MISSING", "Configure a schedule before stopping it.");
      if (expected && (state.revision !== expected.revision || this.#scheduleRecord(state).config_sha256 !== expected.config_sha256)) {
        fail("SCHEDULE_CONFLICT", "The tracking setup changed. Read its current status before stopping it.");
      }
      if (state.owner) this.#interruptSchedule(state, "SCHEDULE_STOPPED");
      this.#write("UPDATE schedule_state SET enabled=0,owner=NULL,lease_until=NULL WHERE schedule_id=?", scheduleId);
      return { schedule_id: scheduleId, enabled: false };
    });
  }
  scheduleStatus(scheduleId) {
    const state = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", id(scheduleId));
    if (!state) return null;
    const saved = this.#scheduleRecord(state);
    const tick = state.last_tick_id ? this.#readScheduleTick(this.#get("SELECT * FROM schedule_ticks WHERE tick_id=?", state.last_tick_id)) : null;
    return { schedule_id: scheduleId, revision: state.revision, config_sha256: saved.config_sha256, enabled: Boolean(state.enabled),
      next_due: state.next_due, started_at: state.started_at, last_finished_at: state.last_finished_at, last_tick: tick,
      state: !state.enabled ? "stopped" : state.owner ? state.lease_until > this.#now() ? "running" : "interrupted"
        : tick ? state.next_due <= this.#now() ? "due" : "waiting" : "configured",
      research_completion_verified: false };
  }
  scheduleObservationPlan(scheduleId, expected) {
    id(scheduleId);
    if (!expected || !Number.isSafeInteger(expected.revision) || expected.revision < 1 ||
        !/^[a-f0-9]{64}$/.test(expected.config_sha256 ?? "")) fail("INVALID_INPUT", "Use the exact tracking revision and configuration hash.");
    return this.#readView(() => {
      const row = this.#get("SELECT * FROM schedule_state WHERE schedule_id=?", scheduleId);
      if (!row) fail("SCHEDULE_MISSING", "Configure tracking before requesting its start instructions.");
      const { config, config_sha256 } = this.#scheduleRecord(row);
      if (row.revision !== expected.revision || config_sha256 !== expected.config_sha256)
        fail("SCHEDULE_CONFLICT", "Tracking changed. Refresh before requesting start instructions.");
      const watch = this.watch(config.watch_id), source = this.sourcePolicy(config.watch_id, config.source_id)?.policy;
      const worker = this.scheduleWorkerStatus(scheduleId);
      const code = !row.enabled ? "SCHEDULE_STOPPED" : watch.current_revision !== config.scope_revision ? "SCHEDULE_SCOPE_CHANGED"
        : config.max_runs !== 0 ? "OBSERVATION_SCHEDULE_REQUIRED"
        : source?.rights_status !== "ALLOWED" || !source.allowed_purposes.includes("local_research") ? "SOURCE_RIGHTS_GATED"
        : worker.state === "monitoring" ? "WORKER_ALREADY_RUNNING" : row.owner && row.lease_until > this.#now() ? "SOURCE_CHECK_RUNNING" : null;
      return { schedule_id: scheduleId, revision: row.revision, config_sha256, watch_id: config.watch_id,
        scope_revision: config.scope_revision, source_id: config.source_id, available: code === null, code };
    });
  }
  pageSchedules({ after = 0, limit = 50, watch_id } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Use at most one hundred tracking records per page.");
    const params = [after]; let filter = "";
    if (watch_id !== undefined) { filter = " AND c.watch_id=?"; params.push(id(watch_id)); }
    params.push(limit);
    return this.#readView(() => this.#all(`SELECT s.rowid AS sequence,s.*,c.watch_id FROM schedule_state s JOIN schedule_configs c ON c.schedule_id=s.schedule_id AND c.revision=s.revision WHERE s.rowid>?${filter} ORDER BY s.rowid LIMIT ?`, ...params)
      .map(row => {
        const saved = this.#scheduleRecord(row); const status = this.scheduleStatus(row.schedule_id), worker = this.scheduleWorkerStatus(row.schedule_id);
        const watch = this.watch(saved.config.watch_id); const scope = watch.revisions.find(r => r.revision === saved.config.scope_revision)?.scope;
        if (!scope) fail("STORAGE_CORRUPT", "The tracking scope is missing. Preserve the workspace before recovery.");
        return { sequence: row.sequence, ...status, watch_id: saved.config.watch_id, theme_id: scope.theme_id, symbols: scope.symbols,
          source_id: saved.config.source_id, scope_revision: saved.config.scope_revision,
          is_current_scope: watch.current_revision === saved.config.scope_revision,
          mode: saved.config.max_runs > 0 ? "research_configured" : "observation_only",
          source_rights_status: this.sourcePolicy(saved.config.watch_id, saved.config.source_id)?.policy.rights_status ?? "MISSING",
          worker_state: row.owner && row.lease_until > this.#now() && (!row.worker_fence || worker.state === "monitoring") ? "checking"
            : worker.state === "offline" ? "offline" : row.owner ? "interrupted" : worker.state,
          last_worker_seen_at: worker.last_seen_at, worker_code: worker.code };
      }));
  }
  scheduleHistory(scheduleId, { after = 0, limit = 50 } = {}) {
    id(scheduleId); integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Use at most one hundred schedule records per page.");
    return this.#all("SELECT rowid AS sequence,* FROM schedule_ticks WHERE schedule_id=? AND rowid>? ORDER BY rowid LIMIT ?", scheduleId, after, limit)
      .map(row => ({ sequence: row.sequence, ...this.#readScheduleTick(row) }));
  }
  #readScheduleTick(row) {
    try {
      if (!row) throw new Error();
      const record = validateScheduleTick(JSON.parse(row.record_json), this.#scheduleRecord(row).config);
      if (canonicalJson(record) !== row.record_json || contentHash(record) !== row.sha256 || record.tick_id !== row.tick_id ||
          record.schedule_id !== row.schedule_id || record.revision !== row.revision || record.fence !== row.fence) throw new Error();
      return record;
    } catch { fail("STORAGE_CORRUPT", "The retained schedule tick changed."); }
  }
  saveRevision(scopeValue, localContext) {
    const scope = publicScope(scopeValue); const scopeJson = json(scope); const contextJson = json(localContext);
    return this.#transaction("revision", () => this.#saveRevision(scope, scopeJson, localContext, contextJson));
  }
  #saveRevision(scope, scopeJson, localContext, contextJson) {
      const existing = this.#get("SELECT * FROM revisions WHERE watch_id=? AND revision=?", scope.watch_id, scope.revision);
      if (existing) {
        if (existing.scope_json !== scopeJson || existing.context_json !== contextJson) fail("REVISION_CONFLICT", "A retained watch revision is immutable.");
        return { scope, local_context_sha256: existing.context_sha256 };
      }
      const watch = this.#get("SELECT * FROM watches WHERE watch_id=?", scope.watch_id);
      if (watch && scope.revision !== watch.current_revision + 1) fail("REVISION_CONFLICT", "Save the next watch revision without replacing history.");
      if (!watch) this.#write("INSERT INTO watches(watch_id,current_revision) VALUES(?,?)", scope.watch_id, scope.revision);
      this.#write("INSERT INTO revisions VALUES(?,?,?,?,?)", scope.watch_id, scope.revision, scopeJson, contextJson, contentHash(localContext));
      this.#write("UPDATE watches SET current_revision=? WHERE watch_id=?", scope.revision, scope.watch_id);
      for (const run of this.#all("SELECT * FROM runs WHERE watch_id=? AND revision<>? AND json_extract(envelope_json,'$.trial') IS NULL AND status IN ('queued','running','gated')", scope.watch_id, scope.revision)) {
        this.#releaseUndispatched(run);
        this.#write("UPDATE runs SET status='cancelled',gate_code='SCOPE_CHANGED',owner=NULL,lease_until=NULL WHERE run_id=?", run.run_id);
      }
      return { scope, local_context_sha256: contentHash(localContext) };
  }
  verifyIntegrity() { return verifyRetainedIntegrity(this.#db); }
  importLegacyWorkspace(rawBytes) {
    const parsed = parseLegacyWorkspace(rawBytes);
    return this.#transaction("legacy_import", () => {
      const prior = this.#get("SELECT * FROM legacy_archives WHERE archive_sha256=?", parsed.raw_sha256);
      if (prior) {
        if (!Buffer.from(prior.bytes).equals(parsed.raw_bytes)) fail("LEGACY_IMPORT_CONFLICT", "The archive hash has conflicting bytes.");
        return { archive_sha256: parsed.raw_sha256, reused: true, watches: parsed.watches.length };
      }
      this.#write("INSERT INTO legacy_archives VALUES(?,?,?)", parsed.raw_sha256, parsed.raw_bytes, this.#now());
      for (const watch of parsed.watches) {
        const current = this.#get("SELECT current_revision FROM watches WHERE watch_id=?", watch.scope.watch_id);
        if (current && current.current_revision !== watch.scope.revision) fail("LEGACY_IMPORT_CONFLICT", "Import into an empty or matching current watch revision only.");
        this.#saveRevision(watch.scope, json(watch.scope), watch.private_context, json(watch.private_context));
        this.#write("INSERT INTO legacy_imports VALUES(?,?,?,?,?,?)", parsed.raw_sha256, watch.scope.watch_id, watch.scope.revision,
          watch.saved_at, watch.accepted_result_id, watch.legacy_watch === undefined ? null : json(watch.legacy_watch));
        for (const [position, result] of watch.results.entries()) {
          const payload = json(result); const sha = contentHash(result);
          const previous = this.#get("SELECT * FROM legacy_results WHERE result_id=?", result.result_id);
          if (previous && (previous.watch_id !== watch.scope.watch_id || previous.sha256 !== sha || previous.result_json !== payload)) fail("LEGACY_IMPORT_CONFLICT", "A retained legacy result has different content.");
          this.#write("INSERT OR IGNORE INTO legacy_results(result_id,watch_id,sha256,result_json) VALUES(?,?,?,?)", result.result_id, watch.scope.watch_id, sha, payload);
          this.#write("INSERT INTO legacy_archive_results VALUES(?,?,?,?)", parsed.raw_sha256, watch.scope.watch_id, result.result_id, position);
        }
        for (const review of watch.reviews) this.#write("INSERT INTO legacy_reviews VALUES(?,?,?,?)", parsed.raw_sha256, watch.scope.watch_id, review.result_id, json(review));
      }
      if (parsed.watches.length) this.#notice(`legacy-${parsed.raw_sha256}`, { kind: "legacy_review", archive_sha256: parsed.raw_sha256, watches: parsed.watches.length });
      return { archive_sha256: parsed.raw_sha256, reused: false, watches: parsed.watches.length };
    });
  }
  legacyWorkspace(archiveSha) {
    const archive = this.#get("SELECT * FROM legacy_archives WHERE archive_sha256=?", id(archiveSha));
    if (!archive) return null;
    const parsed = parseLegacyWorkspace(archive.bytes);
    if (parsed.raw_sha256 !== archive.archive_sha256) fail("STORAGE_CORRUPT", "The legacy archive bytes changed. Preserve the workspace before recovery.");
    return parsed;
  }
  legacyHistory(watchId, { after = 0, limit = 50 } = {}) {
    id(watchId); integer(after); integer(limit, 1);
    if (limit > 100) fail("INVALID_INPUT", "Read at most 100 legacy results per page.");
    return this.#all("SELECT * FROM legacy_results WHERE watch_id=? AND sequence>? ORDER BY sequence LIMIT ?", watchId, after, limit)
      .map((row) => ({ sequence: row.sequence, result: JSON.parse(row.result_json), sha256: row.sha256,
        provenance: { status: "unknown", run_id: null, method: null, source_refs: null } }));
  }
  retainMethod(bundle) {
    const method = verifyMethodBundle(bundle); const payload = json(bundle);
    return this.#transaction("method", () => {
      const prior = this.#get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", method.bundle_sha256);
      if (prior && prior.bundle_json !== payload) fail("REFERENCE_CONFLICT", "The method hash has conflicting retained content.");
      this.#write("INSERT OR IGNORE INTO methods VALUES(?,?)", method.bundle_sha256, payload);
      return method;
    });
  }
  #methodArtifact(kind, input, createPayload) {
    const artifactId = `${kind}:${input[`${kind}_id`]}`;
    const requestSha = contentHash(input);
    return this.#transaction(`method_${kind}`, () => {
      // Check the existing manifest before a write can replace it.
      verifyMethodArtifacts(this.#db);
      const prior = this.#get("SELECT * FROM method_artifacts WHERE artifact_id=?", artifactId);
      if (prior) {
        const record = validateMethodArtifact(kind, JSON.parse(prior.record_json));
        if (record.request_sha256 !== requestSha) fail("METHOD_ARTIFACT_CONFLICT", "The method artifact ID has different content.");
        return { artifact_id: artifactId, sha256: prior.sha256, record, reused: true };
      }
      const record = validateMethodArtifact(kind, { schema_version: 1, request: input, request_sha256: requestSha,
        captured_at: this.#now(), payload: createPayload() });
      const payload = json(record), sha = contentHash(record);
      this.#write("INSERT INTO method_artifacts(artifact_id,kind,sha256,record_json) VALUES(?,?,?,?)", artifactId, kind, sha, payload);
      const manifest = this.#all("SELECT artifact_id,kind,sha256 FROM method_artifacts ORDER BY sequence").map(row => ({ ...row }));
      this.#write("UPDATE method_artifact_manifest SET sha256=? WHERE singleton=1", contentHash(manifest));
      verifyMethodArtifacts(this.#db);
      return { artifact_id: artifactId, sha256: sha, record, reused: false };
    });
  }
  captureMethodCase(value) {
    const input = validateCaseRequest(value);
    return this.#methodArtifact("case", input, () => {
      let run, scope, privateContext, sourceRefs, methodSha, origin;
      if (input.origin.kind === "source_gate") {
        const decision = this.#get("SELECT * FROM event_decisions WHERE decision_id=?", input.origin.id);
        if (!decision) fail("METHOD_ORIGIN_MISSING", "Capture a retained source decision only.");
        origin = JSON.parse(decision.decision_json);
        if (origin.outcome !== "gated") fail("METHOD_ORIGIN_INVALID", "Capture a gated source decision only.");
        const revision = this.#get("SELECT * FROM revisions WHERE watch_id=? AND revision=?", decision.watch_id, decision.revision);
        scope = JSON.parse(revision.scope_json); privateContext = JSON.parse(revision.context_json); methodSha = decision.method_sha256;
        const source = this.source(decision.source_event_id);
        sourceRefs = [verifySourceReference(source.event, source.artifact, source.bytes)];
      } else {
        if (input.origin.kind === "review") {
          const review = this.#get("SELECT * FROM reviews WHERE review_id=?", input.origin.id);
          if (!review) fail("METHOD_ORIGIN_MISSING", "Capture a retained review only.");
          if (!["revisit", "reject"].includes(review.action)) fail("METHOD_ORIGIN_INVALID", "Capture an explicit revisit or rejection for a correction case.");
          origin = { ...review };
          run = this.#get("SELECT r.* FROM runs r JOIN deliveries d USING(run_id) WHERE d.delivery_id=?", review.delivery_id);
        } else {
          run = this.#get("SELECT * FROM runs WHERE run_id=?", input.origin.id);
          if (!run) fail("METHOD_ORIGIN_MISSING", "Capture a retained run only.");
          if (!["gated", "cancelled"].includes(run.status)) fail("METHOD_ORIGIN_INVALID", "Capture a gated or cancelled run as failure evidence.");
          origin = { run_id: run.run_id, status: run.status, gate_code: run.gate_code, attempts: run.attempts, fence: run.fence };
        }
        const envelope = validateRunEnvelope(JSON.parse(run.envelope_json)); scope = envelope.scope;
        if (envelope.trial) fail("METHOD_ORIGIN_INVALID", "Use original research cases, not evaluation trials.");
        const revision = this.#get("SELECT context_json FROM revisions WHERE watch_id=? AND revision=?", scope.watch_id, scope.revision);
        privateContext = JSON.parse(revision.context_json); sourceRefs = envelope.source_refs; methodSha = envelope.method.bundle_sha256;
      }
      const envelope = run ? validateRunEnvelope(JSON.parse(run.envelope_json)) : null;
      const checkpoints = run ? this.#all("SELECT checkpoint_key,sha256,payload_json FROM checkpoints WHERE run_id=? ORDER BY checkpoint_key", run.run_id)
        .map(row => ({ key: row.checkpoint_key, sha256: row.sha256, payload: JSON.parse(row.payload_json) })) : [];
      const requests = run ? this.requests(run.run_id).map(request => ({ request_id: request.request_id, operation_id: request.operation_id,
        fence: request.fence, owner: request.owner, status: request.status, estimate: request.estimate, dispatched_at: request.dispatched_at,
        usage: request.usage, response: request.response, receipts: this.requestReceipts(request.request_id) })) : [];
      const delivered = run ? this.#get("SELECT delivery_id,sha256,result_json FROM deliveries WHERE run_id=?", run.run_id) : null;
      return { classification: "regression", curation_status: "founder_review_required",
        family_sha256: contentHash({ scope, sources: sourceRefs.map(ref => ref.artifact_sha256), private_context: privateContext }),
        scope, private_context: privateContext, envelope, method_sha256: methodSha, source_refs: sourceRefs,
        origin_record: origin, checkpoints, requests, delivery: delivered ? { delivery_id: delivered.delivery_id, sha256: delivered.sha256, result: JSON.parse(delivered.result_json) } : null,
        retention_limits: "Retained JSON and immutable source references only. Invalid raw model output may be unavailable. Missing execution snapshots remain missing. This case is not unseen evaluation evidence." };
    });
  }
  #checkMethodCaseRefs(refs) {
    for (const ref of refs) {
      const row = this.#get("SELECT kind,sha256,record_json FROM method_artifacts WHERE artifact_id=?", `case:${ref.case_id}`);
      if (!row || row.kind !== "case" || row.sha256 !== ref.case_sha256) fail("METHOD_CASE_MISSING", "Pin a retained case and its exact hash.");
    }
  }
  retainMethodCandidate(value) {
    const input = validateCandidateRequest(value);
    return this.#methodArtifact("candidate", input, () => {
      const method = verifyMethodBundle(input.bundle);
      const parent = this.#get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", input.parent_method_sha256);
      if (!parent) fail("METHOD_PARENT_MISSING", "Retain the parent method before the candidate.");
      if (JSON.parse(parent.bundle_json).version === input.bundle.version) fail("METHOD_VERSION_CONFLICT", "Give a changed candidate a new bundle version.");
      const parentProfiles = new Map(JSON.parse(parent.bundle_json).profiles.map(profile => [profile.profile_id, profile]));
      for (const profile of input.bundle.profiles) {
        const prior = parentProfiles.get(profile.profile_id);
        if (prior && profile.content_sha256 !== prior.content_sha256 && profile.version === prior.version) {
          fail("METHOD_VERSION_CONFLICT", "Give each changed evidence profile a new version.");
        }
      }
      this.#checkMethodCaseRefs(input.case_refs);
      const links = new Map(this.#all("SELECT record_json FROM method_artifacts WHERE kind='candidate'").map(row => {
        const record = JSON.parse(row.record_json); return [record.payload.method_sha256, record.request.parent_method_sha256];
      }));
      if (links.has(method.bundle_sha256)) fail("METHOD_PARENT_CONFLICT", "A candidate method has one retained parent.");
      let ancestor = input.parent_method_sha256; const seen = new Set();
      while (ancestor) {
        if (ancestor === method.bundle_sha256 || seen.has(ancestor)) fail("METHOD_PARENT_CONFLICT", "A candidate parent chain cannot contain a cycle.");
        seen.add(ancestor); ancestor = links.get(ancestor);
      }
      this.#write("INSERT OR IGNORE INTO methods VALUES(?,?)", method.bundle_sha256, json(input.bundle));
      return { method_sha256: method.bundle_sha256, serialized_sha256: contentHash(input.bundle),
        curation_status: "founder_review_required", release_status: "candidate" };
    });
  }
  freezeMethodPlan(value) {
    const input = validatePlanRequest(value);
    return this.#methodArtifact("plan", input, () => {
      if (!this.#get("SELECT bundle_sha256 FROM methods WHERE bundle_sha256=?", input.incumbent_method_sha256)) fail("METHOD_PARENT_MISSING", "Retain the comparison incumbent before the plan.");
      this.#checkMethodCaseRefs(input.case_refs);
      // Historical observations are exposed. They cannot become an unseen holdout by relabeling.
      if (input.case_refs.some(ref => ref.partition !== "regression")) fail("METHOD_HOLDOUT_EXPOSED", "Captured historical cases cannot count as unseen holdouts.");
      const families = input.case_refs.map(ref => JSON.parse(this.#get("SELECT record_json FROM method_artifacts WHERE artifact_id=?", `case:${ref.case_id}`).record_json).payload.family_sha256);
      if (new Set(families).size !== families.length) fail("METHOD_CASE_DUPLICATE", "Do not count the same input family twice in an evaluation corpus.");
      return { corpus_sha256: contentHash(input.case_refs), rubric_sha256: contentHash(input.rubric),
        release_gate: METHOD_RELEASE_GATE, evaluation_status: "not_executed" };
    });
  }
  methodArtifacts({ after = 0, limit = 50 } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 method records per page.");
    return this.#readView(() => { verifyMethodArtifacts(this.#db);
      return this.#all("SELECT sequence,artifact_id,kind,sha256 FROM method_artifacts WHERE sequence>? ORDER BY sequence LIMIT ?", after, limit).map(row => ({ ...row })); });
  }
  methodArtifact(artifactId) {
    id(artifactId);
    return this.#readView(() => { verifyMethodArtifacts(this.#db);
      const row = this.#get("SELECT * FROM method_artifacts WHERE artifact_id=?", artifactId);
      return row ? { artifact_id: row.artifact_id, sha256: row.sha256, record: validateMethodArtifact(row.kind, JSON.parse(row.record_json)) } : null; });
  }
  methodImprovementStatus() {
    return this.#readView(() => { verifyMethodArtifacts(this.#db);
      return { counts: Object.fromEntries(["case", "candidate", "plan"].map(kind => [kind, this.#get("SELECT COUNT(*) AS total FROM method_artifacts WHERE kind=?", kind).total])),
        release_gate: METHOD_RELEASE_GATE, evaluation_status: "not_verified", active_method_changed: false }; });
  }
  retainSource(event, artifact, bytes) {
    const reference = verifySourceReference(event, artifact, bytes); const eventJson = json(event); const artifactJson = json(artifact);
    return this.#transaction("source", () => this.#retainSource(reference, eventJson, artifactJson, bytes));
  }
  #retainSource(reference, eventJson, artifactJson, bytes) {
      const priorArtifact = this.#get("SELECT * FROM artifacts WHERE artifact_id=?", reference.source_artifact_id);
      const priorEvent = this.#get("SELECT * FROM source_events WHERE event_id=?", reference.source_event_id);
      if ((priorArtifact && (priorArtifact.metadata_json !== artifactJson || priorArtifact.sha256 !== reference.artifact_sha256)) ||
          (priorEvent && (priorEvent.event_json !== eventJson || priorEvent.sha256 !== reference.source_event_sha256))) {
        fail("REFERENCE_CONFLICT", "A retained source identity has conflicting content.");
      }
      this.#write("INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?)", reference.source_artifact_id, reference.artifact_sha256, artifactJson, bytes);
      this.#write("INSERT OR IGNORE INTO source_events VALUES(?,?,?,?)", reference.source_event_id, reference.source_event_sha256, eventJson, reference.source_artifact_id);
      return reference;
  }
  source(eventId) {
    const row = this.#get("SELECT e.event_json,a.metadata_json,a.bytes FROM source_events e JOIN artifacts a ON a.artifact_id=e.artifact_id WHERE e.event_id=?", id(eventId));
    return row ? { event: JSON.parse(row.event_json), artifact: JSON.parse(row.metadata_json), bytes: Buffer.from(row.bytes) } : null;
  }
  #retainFacts(source, values) {
    const facts = verifyEventFacts(source.event, source.artifact, values);
    for (const fact of facts) {
      const payload = json(fact); const hash = contentHash(fact);
      const prior = this.#get("SELECT sha256,fact_json FROM normalized_facts WHERE source_event_id=? AND fact_key=?", fact.source_event_id, fact.fact_key);
      if (prior && (prior.sha256 !== hash || prior.fact_json !== payload)) fail("REFERENCE_CONFLICT", "A retained event fact cannot change. Use a source correction event.");
      this.#write("INSERT OR IGNORE INTO normalized_facts VALUES(?,?,?,?)", fact.source_event_id, fact.fact_key, hash, payload);
    }
    const refs = this.#all("SELECT fact_key,sha256 FROM normalized_facts WHERE source_event_id=? ORDER BY fact_key", source.event.source_event_id).map((row) => ({ ...row }));
    this.#write("INSERT INTO source_fact_sets VALUES(?,?,?) ON CONFLICT(source_event_id) DO UPDATE SET refs_json=excluded.refs_json,sha256=excluded.sha256",
      source.event.source_event_id, json(refs), contentHash(refs));
    return facts;
  }
  retainSourceFacts(eventId, values) {
    return this.#transaction("source_facts", () => {
      const source = this.source(eventId);
      if (!source) fail("REFERENCE_MISSING", "Retain the event and artifact before its facts.");
      return this.#retainFacts(source, values);
    });
  }
  sourceFacts(eventId) {
    return this.#all("SELECT fact_json FROM normalized_facts WHERE source_event_id=? ORDER BY fact_key", id(eventId)).map((row) => validateNormalizedFact(JSON.parse(row.fact_json)));
  }
  configureSourcePolicy(watchId, input) {
    id(watchId); const policy = validateSourcePolicy(input); const payload = json(policy); const hash = contentHash(policy);
    return this.#transaction("source_policy", () => {
      if (!this.#get("SELECT watch_id FROM watches WHERE watch_id=?", watchId)) fail("REVISION_CONFLICT", "Save the watch before its source policy.");
      const prior = this.#get("SELECT * FROM source_policies WHERE watch_id=? AND source_id=? AND revision=?", watchId, policy.source_id, policy.revision);
      if (prior) {
        if (prior.policy_json !== payload) fail("SOURCE_POLICY_CONFLICT", "A retained source policy revision is immutable.");
        return { policy, sha256: hash, reused: true };
      }
      const current = this.sourcePolicy(watchId, policy.source_id);
      if (policy.revision !== (current?.policy.revision ?? 0) + 1) fail("SOURCE_POLICY_CONFLICT", "Save the next source policy revision without replacing history.");
      this.#write("INSERT INTO source_policies VALUES(?,?,?,?,?)", watchId, policy.source_id, policy.revision, hash, payload);
      // A changed authority stops pending work. It does not erase results or accept a new baseline.
      if (current) for (const run of this.#all("SELECT r.* FROM runs r WHERE r.watch_id=? AND r.status IN ('queued','running','gated')", watchId)) {
        const envelope = validateRunEnvelope(JSON.parse(run.envelope_json));
        if (!envelope.source_refs.some((ref) => this.source(ref.source_event_id).artifact.source_id === policy.source_id)) continue;
        this.#releaseUndispatched(run);
        this.#write("UPDATE runs SET status='gated',gate_code='SOURCE_POLICY_CHANGED',owner=NULL,lease_until=NULL WHERE run_id=?", run.run_id);
        this.#notice(`policy:${run.run_id}:${hash}`, { run_id: run.run_id, gate_code: "SOURCE_POLICY_CHANGED" });
      }
      return { policy, sha256: hash, reused: false };
    });
  }
  sourcePolicy(watchId, sourceId) {
    const row = this.#get("SELECT * FROM source_policies WHERE watch_id=? AND source_id=? ORDER BY revision DESC LIMIT 1", id(watchId), id(sourceId));
    if (!row) return null;
    let policy;
    try { policy = validateSourcePolicy(JSON.parse(row.policy_json)); }
    catch { fail("STORAGE_CORRUPT", "The retained source policy changed. Preserve the workspace before recovery."); }
    if (row.watch_id !== watchId || row.source_id !== sourceId || policy.source_id !== row.source_id || policy.revision !== row.revision ||
        canonicalJson(policy) !== row.policy_json || contentHash(policy) !== row.sha256) {
      fail("STORAGE_CORRUPT", "The retained source policy changed. Preserve the workspace before recovery.");
    }
    return { policy, sha256: row.sha256 };
  }
  #lineageContext(eventId) {
    const events = this.#all("SELECT event_json FROM source_events").map((row) => JSON.parse(row.event_json));
    const adjacent = new Map();
    for (const event of events) {
      if (!adjacent.has(event.source_event_id)) adjacent.set(event.source_event_id, new Set());
      const parent = event.supersedes_source_event_id;
      if (parent) {
        if (!adjacent.has(parent)) adjacent.set(parent, new Set());
        adjacent.get(event.source_event_id).add(parent); adjacent.get(parent).add(event.source_event_id);
      }
    }
    const related = new Set([eventId]); const pending = [eventId];
    for (let index = 0; index < pending.length; index++) {
      for (const next of adjacent.get(pending[index]) ?? []) if (!related.has(next)) { related.add(next); pending.push(next); }
      if (related.size > 1000) fail("EVENT_INPUT_TOO_LARGE", "The correction context requires a bounded review.");
    }
    const connected = events.filter((event) => related.has(event.source_event_id)); const artifacts = new Map(); const facts = [];
    for (const event of connected) {
      const source = this.source(event.source_event_id); artifacts.set(source.artifact.source_artifact_id, source.artifact);
      facts.push(...this.sourceFacts(event.source_event_id));
    }
    return { retained_events: connected, lineage_context: { artifacts: [...artifacts.values()], facts } };
  }
  intakeSourceEvent({ watch_id, event, artifact, bytes, facts, method_sha256, baselines = [], evaluation_at, budget_window, run_policy, schedule_lease }) {
    id(watch_id); id(method_sha256); id(budget_window);
    const reference = verifySourceReference(event, artifact, bytes); const eventJson = json(event); const artifactJson = json(artifact);
    verifyEventFacts(event, artifact, facts);
    return this.#transaction("event_intake", () => {
      let observationOnly = false;
      if (schedule_lease) {
        const scheduled = this.#activeSchedule(schedule_lease).config;
        observationOnly = scheduled.max_runs === 0;
        if (scheduled.watch_id !== watch_id || scheduled.source_id !== artifact.source_id || scheduled.method_sha256 !== method_sha256 ||
            scheduled.budget_window !== budget_window || canonicalJson(scheduled.run_policy) !== canonicalJson(run_policy)) {
          fail("SCHEDULE_INPUT_CONFLICT", "Use the pinned schedule scope, method, source, and run policy.");
        }
      }
      const watch = this.watch(watch_id); if (!watch) fail("REVISION_CONFLICT", "Save a current watch before event intake.");
      const revision = watch.revisions.find((entry) => entry.revision === watch.current_revision);
      if (schedule_lease) {
        // Select only accepted evidence in the same transaction as queue creation.
        baselines = selectedResearchBaseline(this.#db, watch_id, watch.current_revision);
      }
      const bundle = this.#get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", method_sha256);
      if (!bundle) fail("REFERENCE_MISSING", "Retain the method before event intake.");
      const priorJob = this.#get("SELECT d.source_event_id FROM event_jobs j JOIN runs r USING(run_id) JOIN event_decisions d USING(decision_id) JOIN source_events e ON e.event_id=d.source_event_id JOIN artifacts a ON a.artifact_id=e.artifact_id WHERE r.watch_id=? AND r.revision=? AND d.method_sha256=? AND json_extract(a.metadata_json,'$.source_id')=? AND r.status IN ('queued','running','completed') ORDER BY e.rowid DESC LIMIT 1",
        watch_id, watch.current_revision, method_sha256, artifact.source_id);
      const previous = priorJob ? { ...this.source(priorJob.source_event_id), facts: this.sourceFacts(priorJob.source_event_id) } : null;
      // Regression uses the retained SEC index head, even when its earlier intake created no research job.
      const indexHead = isSecSubmissionsEvent(event, artifact) ? this.sourceChangeHead(watch_id, artifact.source_id) : null;
      const secIndexHead = indexHead ? { ...indexHead, facts: this.sourceFacts(indexHead.event.source_event_id) } : null;
      this.#retainSource(reference, eventJson, artifactJson, bytes);
      const source = this.source(event.source_event_id); this.#retainFacts(source, facts);
      const policy = this.sourcePolicy(watch_id, artifact.source_id);
      let context; let plan;
      try {
        context = event.event_kind === "CORRECTED_PERIOD" ? this.#lineageContext(event.source_event_id) : { retained_events: [], lineage_context: null };
        plan = planSourceEvent({ scope: revision.scope, method_bundle: JSON.parse(bundle.bundle_json), ...source,
          facts: this.sourceFacts(event.source_event_id), ...context, policy: policy?.policy ?? null, previous_source: previous,
          ...(isSecSubmissionsEvent(event, artifact) ? { sec_index_head: secIndexHead } : {}), evaluation_at });
      } catch (error) {
        if (error.code !== "EVENT_INPUT_TOO_LARGE") throw error;
        plan = planSourceEvent({ scope: revision.scope, method_bundle: JSON.parse(bundle.bundle_json), ...source,
          facts: this.sourceFacts(event.source_event_id), policy: null, evaluation_at });
        plan = { ...plan, gate_code: "CORRECTION_CONTEXT_TOO_LARGE", policy_sha256: policy?.sha256 ?? null };
      }
      this.#advanceCursor(watch_id, artifact.source_id, event.source_event_id, "observed");
      const previousJob = this.#get("SELECT j.run_id,d.decision_json FROM event_jobs j JOIN event_decisions d USING(decision_id) WHERE j.task_key=?", plan.task_key);
      let run = previousJob ? this.run(previousJob.run_id) : null;
      if (previousJob) {
        if (plan.outcome === "gated") plan = { ...plan, run_id: run.run_id };
        else if (run.status === "gated") {
          const budgetGate = this.budget(watch_id, run.window_id).gate_code;
          const unresolved = this.#get("SELECT request_id FROM requests WHERE run_id=? AND status IN ('dispatched','unknown')", run.run_id);
          const canResume = run.gate_code === "SOURCE_POLICY_CHANGED" && plan.outcome === "queue" && !budgetGate && !unresolved &&
            run.deadline > this.#now() && run.attempts < run.policy.max_attempts;
          if (canResume) {
            this.#write("UPDATE runs SET status='queued',gate_code=NULL WHERE run_id=?", run.run_id);
            run = this.run(run.run_id); plan = { ...plan, outcome: "queued", run_id: run.run_id };
          } else plan = { ...plan, outcome: "gated", gate_code: budgetGate ?? (unresolved ? "USAGE_UNKNOWN" : run.deadline <= this.#now() ? "DEADLINE_EXCEEDED" : run.attempts >= run.policy.max_attempts ? "ATTEMPTS_EXCEEDED" : run.gate_code), run_id: run.run_id };
        } else plan = { ...plan, outcome: "queued", run_id: run.run_id };
      } else if (plan.outcome === "queue") {
        const budget = this.#get("SELECT gate_code FROM budgets WHERE watch_id=? AND window_id=?", watch_id, budget_window);
        if (!budget || budget.gate_code) plan = { ...plan, outcome: "gated", gate_code: budget?.gate_code ?? "BUDGET_MISSING" };
        else {
          const envelope = createRunEnvelope({ scope: revision.scope, method: plan.method, source_refs: [reference], baselines,
            evaluation_at, local_context_sha256: revision.local_context_sha256 });
          run = this.#enqueue(envelope, budget_window, this.#runPolicy(run_policy));
          plan = { ...plan, outcome: "queued", run_id: run.run_id };
        }
      }
      if (plan.outcome === "queued" && Object.hasOwn(plan, "reason")) {
        const { reason: ignoredReason, ...queuedPlan } = plan; plan = queuedPlan;
      }
      const payload = json(plan); const hash = contentHash(plan); const decisionId = `el-event-decision-${hash}`;
      const existing = this.#get("SELECT decision_json FROM event_decisions WHERE decision_id=?", decisionId);
      if (existing && existing.decision_json !== payload) fail("REFERENCE_CONFLICT", "The event decision hash has conflicting content.");
      this.#write("INSERT OR IGNORE INTO event_decisions VALUES(?,?,?,?,?,?,?,?,?)", decisionId, plan.task_key, watch_id, revision.revision,
        event.source_event_id, method_sha256, hash, payload, run?.run_id ?? null);
      if (run && !previousJob) this.#write("INSERT INTO event_jobs VALUES(?,?,?)", plan.task_key, run.run_id, decisionId);
      if (observationOnly && plan.outcome === "queued" && !previousJob) {
        verifyExternalSessions(this.#db);
        const returned = this.#get("SELECT 1 AS found FROM external_session_records r JOIN external_session_contexts c ON c.context_id=r.context_id JOIN json_each(c.payload_json,'$.context.source_records') s WHERE c.watch_id=? AND c.revision=? AND c.method_sha256=? AND json_extract(s.value,'$.event.source_event_id')=? LIMIT 1",
          watch_id, revision.revision, method_sha256, event.source_event_id);
        if (!returned) this.#notice(`research-needed:${run.run_id}`, { kind: "research_needed", watch_id, scope_revision: revision.revision,
          method_sha256, run_id: run.run_id, source_event_id: event.source_event_id,
          source_id: artifact.source_id, source_period: artifact.source_period });
      }
      if (plan.outcome === "gated") this.#notice(`source-gate:${contentHash({ watch_id, revision: revision.revision, method_sha256,
        source_id: artifact.source_id, artifact_sha256: artifact.artifact_sha256, policy_sha256: plan.policy_sha256,
        parent: event.supersedes_source_event_id, gate_code: plan.gate_code })}`,
      { kind: "source_gate", task_key: plan.task_key, source_event_id: event.source_event_id, gate_code: plan.gate_code });
      return { decision: plan, run, reused: Boolean(existing || previousJob) };
    });
  }
  eventDecisions(watchId) {
    return this.#all("SELECT decision_id,decision_json FROM event_decisions WHERE watch_id=? ORDER BY rowid", id(watchId))
      .map((row) => ({ decision_id: row.decision_id, ...JSON.parse(row.decision_json) }));
  }
  sourceChangeHead(watchId, sourceId) {
    // Ignored corrections still belong to the graph. Plain repeated observations do not replace its head.
    const maxPeriod = sourceId === TWSE_MONTHLY_SOURCE_ID ? twseExpectedReportingPeriod(this.#now()) : null;
    const row = this.#get("SELECT e.event_id FROM source_events e JOIN artifacts a ON a.artifact_id=e.artifact_id JOIN event_decisions d ON d.source_event_id=e.event_id WHERE d.watch_id=? AND json_extract(a.metadata_json,'$.source_id')=? AND (? IS NULL OR (json_extract(a.metadata_json,'$.source_period')<=? AND json_extract(a.metadata_json,'$.source_period')<=strftime('%Y-%m',datetime(json_extract(a.metadata_json,'$.retrieved_at'),'+8 hours','start of month','-1 month')))) AND COALESCE(json_extract(d.decision_json,'$.gate_code'),'') NOT IN ('SOURCE_TIME_CONFLICT','STALE_REPORTING_PERIOD','SOURCE_SCHEMA_CHANGED','FACT_PARSE_CONFLICT') AND (json_extract(e.event_json,'$.event_kind')='CORRECTED_PERIOD' OR (json_extract(e.event_json,'$.event_kind')='NEW_PERIOD' AND json_extract(d.decision_json,'$.outcome')!='ignored')) ORDER BY e.rowid DESC LIMIT 1", id(watchId), id(sourceId), maxPeriod, maxPeriod);
    return row ? this.source(row.event_id) : null;
  }
  #advanceCursor(watchId, sourceId, eventId, phase) {
    const event = this.#get("SELECT e.rowid AS sequence,a.metadata_json FROM source_events e JOIN artifacts a ON a.artifact_id=e.artifact_id WHERE event_id=?", eventId);
    if (!event || JSON.parse(event.metadata_json).source_id !== sourceId) fail("REFERENCE_CONFLICT", "The cursor event must belong to this retained source.");
    this.#write("INSERT OR IGNORE INTO cursors(watch_id,source_id) VALUES(?,?)", watchId, sourceId);
    const cursor = this.#get("SELECT * FROM cursors WHERE watch_id=? AND source_id=?", watchId, sourceId);
    const fields = phase === "observed" ? ["observed_event_id"] : phase === "queued" ? ["observed_event_id", "queued_event_id"] : ["completed_event_id"];
    for (const field of fields) {
      const prior = cursor[field] ? this.#get("SELECT rowid AS sequence FROM source_events WHERE event_id=?", cursor[field]) : null;
      if (!prior || prior.sequence < event.sequence) this.#write(`UPDATE cursors SET ${field}=? WHERE watch_id=? AND source_id=?`, eventId, watchId, sourceId);
    }
  }
  observeSource(watchId, sourceId, eventId) {
    id(watchId); id(sourceId); id(eventId);
    return this.#transaction("observe", () => this.#advanceCursor(watchId, sourceId, eventId, "observed"));
  }
  cursors(watchId) { return this.#all("SELECT * FROM cursors WHERE watch_id=? ORDER BY source_id", id(watchId)); }
  configureBudget(watchId, windowId, limitsValue) {
    id(watchId); id(windowId); const limits = json(quantities(limitsValue));
    return this.#transaction("budget", () => {
      const prior = this.#get("SELECT * FROM budgets WHERE watch_id=? AND window_id=?", watchId, windowId);
      if (prior && prior.limits_json !== limits) fail("BUDGET_POLICY_CONFLICT", "A configured budget window is immutable.");
      this.#write("INSERT OR IGNORE INTO budgets VALUES(?,?,?,?,?,NULL)", watchId, windowId, limits, json(zero()), json(zero()));
      return this.budget(watchId, windowId);
    });
  }
  budget(watchId, windowId) {
    const row = this.#get("SELECT * FROM budgets WHERE watch_id=? AND window_id=?", watchId, windowId);
    if (!row) fail("BUDGET_MISSING", "Configure the watch budget before execution.");
    return { limits: JSON.parse(row.limits_json), spent: JSON.parse(row.spent_json), reserved: JSON.parse(row.reserved_json), gate_code: row.gate_code };
  }
  enqueue(envelopeValue, windowId, policy) {
    const envelope = validateRunEnvelope(envelopeValue); id(windowId); const parsedPolicy = this.#runPolicy(policy);
    if (envelope.trial) fail("METHOD_TRIAL_AUTHORITY_REQUIRED", "Use the dedicated paired trial entry.");
    return this.#transaction("enqueue", () => this.#enqueue(envelope, windowId, parsedPolicy));
  }
  #trialInput(caseRecord, evaluationAt) {
    const captured = caseRecord.payload;
    const snapshots = captured.checkpoints.filter(item => ["execution-context:v1", "execution-context:v2"].includes(item.key));
    if (snapshots.length > 1) fail("METHOD_CASE_INPUT_MISSING", "Use one original retained execution snapshot.");
    const snapshot = snapshots[0];
    let sources, baselines;
    if (snapshot) {
      const original = snapshot.payload;
      if (contentHash(original) !== snapshot.sha256 || json(original.envelope) !== json(captured.envelope) ||
          json(original.private_context) !== json(captured.private_context)) fail("METHOD_CASE_INPUT_MISSING", "Use the original retained execution snapshot.");
      sources = original.sources; baselines = original.envelope.baselines;
    } else if (caseRecord.request.origin.kind === "source_gate") {
      const refs = captured.origin_record.fact_refs;
      if (!Array.isArray(refs)) fail("METHOD_CASE_INPUT_MISSING", "The original source decision needs exact fact references.");
      sources = captured.source_refs.map(reference => {
        const source = this.source(reference.source_event_id);
        const facts = refs.filter(ref => ref.source_event_id === reference.source_event_id).map(ref => {
          const fact = this.sourceFacts(reference.source_event_id).find(item => item.fact_key === ref.fact_key);
          if (!fact || contentHash(fact) !== ref.sha256) fail("METHOD_CASE_INPUT_MISSING", "The original selected fact is missing or changed.");
          return fact;
        });
        return { reference, event: source.event, artifact: source.artifact, facts };
      });
      if (refs.length !== sources.reduce((count, source) => count + source.facts.length, 0)) fail("METHOD_CASE_INPUT_MISSING", "The source decision has unretained fact references.");
      baselines = [];
    } else fail("METHOD_CASE_INPUT_MISSING", "This historical case has no retained execution snapshot.");
    if (!Array.isArray(sources) || json(sources.map(source => source.reference)) !== json(captured.source_refs)) {
      fail("METHOD_CASE_INPUT_MISSING", "The original input must contain the pinned sources only.");
    }
    for (const source of sources) {
      const retained = this.source(source.reference.source_event_id);
      verifySourceReference(source.event, source.artifact, retained.bytes, source.reference);
      if (json(source.event) !== json(retained.event) || json(source.artifact) !== json(retained.artifact)) fail("METHOD_CASE_INPUT_MISSING", "The original source metadata changed.");
      for (const fact of source.facts) {
        const retainedFact = this.sourceFacts(source.reference.source_event_id).find(item => item.fact_key === fact.fact_key);
        if (!retainedFact || contentHash(retainedFact) !== contentHash(fact)) fail("METHOD_CASE_INPUT_MISSING", "The original selected fact changed.");
      }
    }
    return { schema_version: 1, scope: captured.scope, private_context: captured.private_context, sources, baselines, evaluation_at: evaluationAt };
  }
  enqueueMethodTrialPair(value) {
    const input = validateTrialPairRequest(value), requestSha = contentHash(input);
    const pairId = `el-method-pair-${contentHash({ request_sha256: requestSha })}`;
    return this.#transaction("method_trial_pair", () => {
      verifyMethodArtifacts(this.#db); verifyMethodTrials(this.#db);
      const prior = this.#get("SELECT * FROM method_trial_pairs WHERE pair_id=?", pairId);
      if (prior) return { pair_id: pairId, incumbent_run_id: prior.incumbent_run_id, candidate_run_id: prior.candidate_run_id, reused: true };
      const artifact = (kind, name) => {
        const row = this.#get("SELECT * FROM method_artifacts WHERE artifact_id=? AND kind=?", `${kind}:${name}`, kind);
        if (!row) fail("METHOD_TRIAL_REFERENCE_MISSING", "Retain the exact plan, case, and candidate before execution.");
        return { sha256: row.sha256, record: validateMethodArtifact(kind, JSON.parse(row.record_json)) };
      };
      const plan = artifact("plan", input.plan_id), captured = artifact("case", input.case_id), candidate = artifact("candidate", input.candidate_id);
      const frozen = plan.record.request;
      if (!frozen.case_refs.some(ref => ref.case_id === input.case_id && ref.case_sha256 === captured.sha256 && ref.partition === "regression") ||
          input.repetition > frozen.repetitions || candidate.record.request.parent_method_sha256 !== frozen.incumbent_method_sha256 ||
          validateTrialRuntimePolicy(input.runtime_policy).sha256 !== frozen.runtime_policy_sha256) {
        fail("METHOD_TRIAL_PLAN_CONFLICT", "Use the frozen corpus, incumbent, repetition, and runtime policy.");
      }
      const base = this.#trialInput(captured.record, frozen.evaluation_at);
      const record = { schema_version: 1, request: input, request_sha256: requestSha, created_at: this.#now(),
        plan_sha256: plan.sha256, case_sha256: captured.sha256, candidate_sha256: candidate.sha256,
        input_sha256: contentHash(base), input_json: json(base) };
      const trial = { plan_id: input.plan_id, plan_sha256: plan.sha256, case_id: input.case_id, case_sha256: captured.sha256,
        candidate_id: input.candidate_id, candidate_sha256: candidate.sha256, repetition: input.repetition, runtime_policy_sha256: frozen.runtime_policy_sha256 };
      const runs = ["incumbent", "candidate"].map(role => {
        const sha = role === "incumbent" ? frozen.incumbent_method_sha256 : candidate.record.payload.method_sha256;
        const bundle = JSON.parse(this.#get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", sha).bundle_json);
        const envelope = createRunEnvelope({ scope: base.scope, method: verifyMethodBundle(bundle), source_refs: base.sources.map(source => source.reference),
          baselines: base.baselines, evaluation_at: base.evaluation_at, local_context_sha256: contentHash(base.private_context), trial: { ...trial, role } });
        return this.#enqueue(envelope, input.budget_window, this.#runPolicy(input.run_policy));
      });
      this.#write("INSERT INTO method_trial_pairs VALUES(?,?,?,?,?)", pairId, contentHash(record), json(record), runs[0].run_id, runs[1].run_id);
      const manifest = this.#all("SELECT pair_id,sha256,incumbent_run_id,candidate_run_id FROM method_trial_pairs ORDER BY pair_id").map(row => ({ ...row }));
      this.#write("UPDATE method_trial_manifest SET sha256=? WHERE singleton=1", contentHash(manifest));
      verifyMethodTrials(this.#db);
      return { pair_id: pairId, incumbent_run_id: runs[0].run_id, candidate_run_id: runs[1].run_id, reused: false };
    });
  }
  methodTrialPair(pairId) {
    id(pairId);
    return this.#readView(() => {
      verifyMethodArtifacts(this.#db); verifyMethodTrials(this.#db);
      const row = this.#get("SELECT * FROM method_trial_pairs WHERE pair_id=?", pairId);
      if (!row) return null;
      return { pair_id: row.pair_id, sha256: row.sha256, record: JSON.parse(row.record_json),
        incumbent: this.run(row.incumbent_run_id), candidate: this.run(row.candidate_run_id),
        outputs: this.#all("SELECT * FROM method_trial_outputs WHERE run_id IN (?,?) ORDER BY run_id", row.incumbent_run_id, row.candidate_run_id)
          .map(output => ({ run_id: output.run_id, sha256: output.sha256, result: JSON.parse(output.result_json) })) };
    });
  }
  #trialPairForRun(runId) {
    const row = this.#get("SELECT * FROM method_trial_pairs WHERE incumbent_run_id=? OR candidate_run_id=?", runId, runId);
    if (!row) fail("METHOD_TRIAL_REFERENCE_MISSING", "The trial run needs a retained pair.");
    return JSON.parse(row.record_json);
  }
  methodTrialRuntimePolicy(runId) {
    id(runId);
    return this.#readView(() => {
      verifyMethodArtifacts(this.#db); verifyMethodTrials(this.#db);
      return validateTrialRuntimePolicy(this.#trialPairForRun(runId).request.runtime_policy);
    });
  }
  resumeMethodTrial(value) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== "decision_id,reason,run_id" ||
        typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 1200 || /[\u0000-\u001f\u007f]/u.test(value.reason) ||
        typeof value.decision_id !== "string" || value.decision_id.length > 160) {
      fail("INVALID_INPUT", "Record a trial run, decision ID, and explicit resume reason.");
    }
    id(value.run_id); id(value.decision_id); const requestSha = contentHash(value), key = `trial-resume:${value.decision_id}`;
    return this.#transaction("resume_method_trial", () => {
      verifyMethodArtifacts(this.#db); verifyMethodTrials(this.#db);
      const run = this.run(value.run_id);
      if (!run?.envelope.trial) fail("METHOD_TRIAL_REQUIRED", "Resume a retained method trial only.");
      const prior = this.#get("SELECT sha256,payload_json FROM checkpoints WHERE run_id=? AND checkpoint_key=?", run.run_id, key);
      if (prior) {
        const retained = JSON.parse(prior.payload_json);
        if (json(retained) !== prior.payload_json || contentHash(retained) !== prior.sha256 || !retained.request ||
            contentHash(retained.request) !== retained.request_sha256 || retained.request.run_id !== run.run_id ||
            `trial-resume:${retained.request.decision_id}` !== key) {
          fail("STORAGE_CORRUPT", "The retained trial resume decision changed.");
        }
        if (retained.request_sha256 !== requestSha) fail("METHOD_TRIAL_RESUME_CONFLICT", "The resume decision ID has different content.");
        return { run_id: run.run_id, status: run.status, reused: true };
      }
      if (run.status !== "gated" || this.budget(run.watch_id, run.window_id).gate_code ||
          this.#get("SELECT request_id FROM requests WHERE run_id=? AND status IN ('reserved','dispatched','unknown')", run.run_id)) {
        fail("METHOD_TRIAL_RESUME_GATED", "Resolve outstanding usage and budget gates before explicit resume.");
      }
      if (this.#now() >= run.deadline) fail("DEADLINE_EXCEEDED", "The original trial deadline expired.");
      if (run.attempts >= run.policy.max_attempts) fail("ATTEMPTS_EXCEEDED", "The original trial attempt limit expired.");
      this.#trialAuthority(run);
      const record = { request_sha256: requestSha, request: value, previous_gate: run.gate_code, recorded_at: this.#now() };
      this.#write("INSERT INTO checkpoints VALUES(?,?,?,?)", run.run_id, key, contentHash(record), json(record));
      this.#write("UPDATE runs SET status='queued',gate_code=NULL,owner=NULL,lease_until=NULL WHERE run_id=?", run.run_id);
      return { run_id: run.run_id, status: "queued", reused: false };
    });
  }
  #trialAuthority(run) {
    verifyMethodArtifacts(this.#db); verifyMethodTrials(this.#db);
    const envelope = validateRunEnvelope(JSON.parse(run.envelope_json));
    if (!envelope.trial) fail("METHOD_TRIAL_REQUIRED", "Use a retained method trial run.");
    const pair = this.#trialPairForRun(run.run_id), base = JSON.parse(pair.input_json);
    for (const reference of envelope.source_refs) {
      const source = this.source(reference.source_event_id), policy = this.sourcePolicy(run.watch_id, source.artifact.source_id)?.policy;
      if (!policy) fail("SOURCE_POLICY_MISSING", "Configure the source policy before trial execution.");
      if (policy.rights_status !== "ALLOWED" || !policy.allowed_purposes.includes("local_research")) fail("SOURCE_RIGHTS_GATED", "Resolve source rights and purpose before trial execution.");
      if (policy.adapter_version !== source.event.adapter_version || policy.parser_version !== source.event.parser_version) fail("SOURCE_SCHEMA_CHANGED", "Review changed source versions before trial execution.");
      if (Date.parse(source.artifact.retrieved_at) > this.#now()) fail("SOURCE_TIME_INVALID", "Check the future source retrieval time.");
      if (this.#now() - Date.parse(source.artifact.retrieved_at) > policy.max_source_age_ms) fail("STALE_SOURCE", "The retained source exceeds the current permitted age.");
      if (!policy.allow_candidate_trials) fail("METHOD_CURATION_REQUIRED", "Approve the local candidate trial before execution.");
      const facts = base.sources.find(item => item.reference.source_event_id === reference.source_event_id)?.facts ?? [];
      for (const fact of facts) {
        if (!policy.metric_definition_ids.includes(fact.identity.metric_definition_id) || !policy.allowed_evidence_states.includes(fact.evidence_state) ||
            !envelope.scope.symbols.some(symbol => policy.issuer_map[symbol] === fact.identity.issuer_id)) {
          fail("SOURCE_POLICY_CHANGED", "The current policy does not permit the retained fact scope.");
        }
      }
    }
    return envelope;
  }
  methodTrialExecutionContext(lease) {
    return this.#transaction("method_trial_context", () => {
      const run = this.#active(lease), envelope = this.#trialAuthority(run), pair = this.#trialPairForRun(run.run_id);
      const base = JSON.parse(pair.input_json);
      const payload = { schema_version: 1, envelope, private_context: base.private_context,
        method_bundle: JSON.parse(this.#get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", envelope.method.bundle_sha256).bundle_json),
        sources: base.sources, created_at: base.evaluation_at };
      const sha = contentHash(payload), prior = this.#get("SELECT * FROM checkpoints WHERE run_id=? AND checkpoint_key='trial-context:v1'", run.run_id);
      if (prior && prior.sha256 !== sha) fail("CHECKPOINT_CONFLICT", "The retained trial context changed.");
      this.#write("INSERT OR IGNORE INTO checkpoints VALUES(?,?,?,?)", run.run_id, "trial-context:v1", sha, json(payload));
      return { sha256: sha, payload };
    });
  }
  claimMethodTrial(runId, owner, leaseMs = 30_000) {
    id(runId); id(owner); integer(leaseMs, 1);
    return this.#transaction("claim_method_trial", () => {
      verifyMethodArtifacts(this.#db); verifyMethodTrials(this.#db);
      let run = this.run(runId);
      if (!run?.envelope.trial) fail("METHOD_TRIAL_REQUIRED", "Claim a retained method trial only.");
      const now = this.#now();
      if (run.status === "running" && (run.lease_until <= now || run.deadline <= now)) {
        const gate = this.#releaseUndispatched(run);
        this.#write("UPDATE runs SET status=?,gate_code=?,owner=NULL,lease_until=NULL WHERE run_id=?", gate ? "gated" : "queued", gate, runId);
        run = this.run(runId);
      }
      if (run.status !== "queued" || run.not_before > now) return null;
      const gate = this.budget(run.watch_id, run.window_id).gate_code ?? (run.deadline <= now ? "DEADLINE_EXCEEDED" :
        run.attempts >= run.policy.max_attempts ? "ATTEMPTS_EXCEEDED" : null);
      if (gate) { this.#write("UPDATE runs SET status='gated',gate_code=? WHERE run_id=?", gate, runId); return null; }
      const fence = run.fence + 1, until = Math.min(integer(now + leaseMs), run.deadline);
      this.#write("UPDATE runs SET status='running',owner=?,fence=?,lease_until=?,attempts=attempts+1 WHERE run_id=?", owner, fence, until, runId);
      return { run_id: runId, owner, fence, lease_until: until, envelope: run.envelope };
    });
  }
  finishMethodTrial(lease, value) {
    const result = validateResearchResultFile(value), payload = json(result), sha = contentHash(result);
    return this.#transaction("finish_method_trial", () => {
      verifyMethodArtifacts(this.#db); verifyMethodTrials(this.#db);
      const retained = this.run(lease.run_id);
      if (!retained?.envelope.trial) fail("METHOD_TRIAL_REQUIRED", "Finish a retained method trial only.");
      const prior = this.#get("SELECT * FROM method_trial_outputs WHERE run_id=?", lease.run_id);
      if (prior) {
        if (prior.sha256 !== sha) fail("METHOD_TRIAL_OUTPUT_CONFLICT", "A trial retains one immutable output only.");
        return { run_id: lease.run_id, sha256: sha, reused: true };
      }
      const run = this.#active(lease), envelope = this.#trialAuthority(run), scope = envelope.scope;
      if (result.watch_id !== scope.watch_id || result.scope_revision !== scope.revision || result.theme_id !== scope.theme_id ||
          result.stage_id !== scope.stage_id || json(result.symbols) !== json(scope.symbols) || result.created_at !== envelope.evaluation_at) {
        fail("RESULT_SCOPE_CONFLICT", "The trial output must match the frozen scope and time.");
      }
      const validated = this.#get("SELECT sha256 FROM checkpoints WHERE run_id=? AND checkpoint_key='executor:validated-result'", run.run_id);
      const context = this.#get("SELECT sha256 FROM checkpoints WHERE run_id=? AND checkpoint_key='trial-context:v1'", run.run_id);
      if (!validated || validated.sha256 !== sha || !context) fail("METHOD_TRIAL_OUTPUT_INVALID", "Validate the pinned trial input and output before completion.");
      if (this.#get("SELECT request_id FROM requests WHERE run_id=? AND status IN ('reserved','dispatched','unknown')", run.run_id)) fail("REQUEST_UNRESOLVED", "Resolve request usage before trial completion.");
      this.#write("INSERT INTO method_trial_outputs VALUES(?,?,?,?)", run.run_id, sha, payload, this.#now());
      this.#write("UPDATE runs SET status='completed',owner=NULL,lease_until=NULL WHERE run_id=?", run.run_id);
      verifyMethodTrials(this.#db);
      return { run_id: run.run_id, sha256: sha, reused: false };
    });
  }
  #runPolicy(policy) {
    if (!policy || Object.keys(policy).sort().join() !== "max_attempts,max_wall_ms,not_before") fail("INVALID_INPUT", "Use the required run policy fields only.");
    return { max_attempts: integer(policy.max_attempts, 1), max_wall_ms: integer(policy.max_wall_ms, 1), not_before: integer(policy.not_before) };
  }
  #enqueue(envelope, windowId, parsedPolicy) {
      const payload = json(envelope);
      const existing = this.#get("SELECT * FROM runs WHERE run_id=?", envelope.run_id);
      if (existing) {
        if (existing.envelope_json !== payload || existing.policy_json !== json(parsedPolicy) || existing.window_id !== windowId) fail("RUN_IDENTITY_CONFLICT", "The retained run has different inputs or policy.");
        return this.run(envelope.run_id);
      }
      const revision = this.#get("SELECT * FROM revisions WHERE watch_id=? AND revision=?", envelope.scope.watch_id, envelope.scope.revision);
      const watch = this.#get("SELECT current_revision FROM watches WHERE watch_id=?", envelope.scope.watch_id);
      if (!revision || !watch || !envelope.trial && watch.current_revision !== envelope.scope.revision || revision.scope_json !== json(envelope.scope) || revision.context_sha256 !== envelope.local_context_sha256) {
        fail("REVISION_CONFLICT", "The run requires the current retained watch revision and context.");
      }
      const retainedMethod = this.#get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", envelope.method.bundle_sha256);
      if (!retainedMethod) fail("REFERENCE_MISSING", "Retain the pinned method before execution.");
      verifyMethodBundle(JSON.parse(retainedMethod.bundle_json), envelope.method);
      for (const reference of envelope.source_refs) {
        const retained = this.#get("SELECT e.event_json,a.metadata_json,a.bytes FROM source_events e JOIN artifacts a ON a.artifact_id=e.artifact_id WHERE e.event_id=?", reference.source_event_id);
        if (!retained) fail("REFERENCE_MISSING", "Retain each pinned source before execution.");
        verifySourceReference(JSON.parse(retained.event_json), JSON.parse(retained.metadata_json), retained.bytes, reference);
      }
      this.budget(envelope.scope.watch_id, windowId);
      const deadline = integer(this.#now() + parsedPolicy.max_wall_ms);
      if (parsedPolicy.not_before >= deadline) fail("INVALID_INPUT", "The run must be due before its deadline.");
      this.#write("INSERT INTO runs(run_id,envelope_json,watch_id,revision,window_id,policy_json,status,not_before,deadline) VALUES(?,?,?,?,?,?,'queued',?,?)",
        envelope.run_id, payload, envelope.scope.watch_id, envelope.scope.revision, windowId, json(parsedPolicy), parsedPolicy.not_before, deadline);
      for (const ref of envelope.trial ? [] : envelope.source_refs) {
        const artifact = this.#get("SELECT metadata_json FROM artifacts WHERE artifact_id=?", ref.source_artifact_id);
        this.#advanceCursor(envelope.scope.watch_id, JSON.parse(artifact.metadata_json).source_id, ref.source_event_id, "queued");
      }
      return this.run(envelope.run_id);
  }
  run(runId) {
    const row = this.#get("SELECT * FROM runs WHERE run_id=?", id(runId));
    return row ? { ...row, envelope: validateRunEnvelope(JSON.parse(row.envelope_json)), policy: JSON.parse(row.policy_json) } : null;
  }
  #updateBudget(run, spent, reserved, gateCode = null) {
    this.#write("UPDATE budgets SET spent_json=?,reserved_json=?,gate_code=COALESCE(?,gate_code) WHERE watch_id=? AND window_id=?", json(spent), json(reserved), gateCode, run.watch_id, run.window_id);
  }
  #releaseUndispatched(run) {
    let budget = this.budget(run.watch_id, run.window_id);
    for (const request of this.#all("SELECT * FROM requests WHERE run_id=? AND status IN ('reserved','dispatched')", run.run_id)) {
      if (request.status === "reserved") {
        budget.reserved = add(budget.reserved, JSON.parse(request.estimate_json), -1);
        this.#write("UPDATE requests SET status='abandoned' WHERE request_id=?", request.request_id);
      } else {
        budget.gate_code = "USAGE_UNKNOWN";
        this.#write("UPDATE requests SET status='unknown' WHERE request_id=?", request.request_id);
      }
    }
    this.#updateBudget(run, budget.spent, budget.reserved, budget.gate_code);
    return budget.gate_code;
  }
  claim(owner, leaseMs = 30_000, { schedule_lease } = {}) {
    id(owner); integer(leaseMs, 1);
    return this.#transaction("claim", () => {
      const scheduled = schedule_lease ? this.#activeSchedule(schedule_lease).config : null;
      const matchesSchedule = (run) => {
        if (!scheduled) return true;
        const envelope = JSON.parse(run.envelope_json);
        return run.watch_id === scheduled.watch_id && run.revision === scheduled.scope_revision && run.window_id === scheduled.budget_window &&
          envelope.method.bundle_sha256 === scheduled.method_sha256 &&
          envelope.source_refs.every(ref => this.source(ref.source_event_id).artifact.source_id === scheduled.source_id) &&
          Boolean(this.#get("SELECT task_key FROM event_jobs WHERE run_id=?", run.run_id));
      };
      const now = this.#now();
      for (const run of this.#all("SELECT * FROM runs WHERE json_extract(envelope_json,'$.trial') IS NULL AND status='running' AND (lease_until<=? OR deadline<=?)", now, now)) {
        if (!matchesSchedule(run)) continue;
        const gate = this.#releaseUndispatched(run);
        this.#write("UPDATE runs SET status=?,gate_code=?,owner=NULL,lease_until=NULL WHERE run_id=?", gate ? "gated" : "queued", gate, run.run_id);
        if (gate) this.#notice(`gate:${run.run_id}:${gate}`, { run_id: run.run_id, gate_code: gate });
      }
      for (const run of this.#all("SELECT * FROM runs WHERE json_extract(envelope_json,'$.trial') IS NULL AND status='queued' ORDER BY not_before,rowid")) {
        if (!matchesSchedule(run)) continue;
        if (run.not_before > now) continue;
        const budgetGate = this.budget(run.watch_id, run.window_id).gate_code;
        const gate = budgetGate ?? (run.deadline <= now ? "DEADLINE_EXCEEDED" : run.attempts >= JSON.parse(run.policy_json).max_attempts ? "ATTEMPTS_EXCEEDED" : null);
        if (gate) {
          this.#write("UPDATE runs SET status='gated',gate_code=? WHERE run_id=?", gate, run.run_id);
          this.#notice(`gate:${run.run_id}:${gate}`, { run_id: run.run_id, gate_code: gate });
          continue;
        }
        const fence = run.fence + 1; const until = Math.min(integer(now + leaseMs), run.deadline);
        this.#write("UPDATE runs SET status='running',owner=?,fence=?,lease_until=?,attempts=attempts+1 WHERE run_id=?", owner, fence, until, run.run_id);
        if (schedule_lease) {
          const binding = { run_id: run.run_id, run_fence: fence, schedule_id: schedule_lease.schedule_id, revision: schedule_lease.revision,
            schedule_fence: schedule_lease.fence, owner: schedule_lease.owner, config_sha256: schedule_lease.config_sha256 };
          this.#write("INSERT INTO schedule_run_leases VALUES(?,?,?,?,?,?,?)", run.run_id, fence, binding.schedule_id, binding.revision,
            binding.schedule_fence, contentHash(binding), json(binding));
          this.#write("INSERT INTO checkpoints VALUES(?,?,?,?)", run.run_id, `schedule-binding:${fence}`, contentHash(binding), json(binding));
        }
        return { run_id: run.run_id, owner, fence, lease_until: until, envelope: this.run(run.run_id).envelope };
      }
      return null;
    });
  }
  #active(lease) {
    const run = this.#get("SELECT * FROM runs WHERE run_id=?", id(lease.run_id));
    if (!run || run.status !== "running" || run.owner !== lease.owner || run.fence !== lease.fence || run.lease_until <= this.#now() || run.deadline <= this.#now()) {
      fail("LEASE_LOST", "Acquire a current lease before changing run state.");
    }
    const binding = this.#get("SELECT * FROM schedule_run_leases WHERE run_id=? AND run_fence=?", run.run_id, run.fence);
    const manifest = this.#get("SELECT sha256,payload_json FROM checkpoints WHERE run_id=? AND checkpoint_key=?", run.run_id, `schedule-binding:${run.fence}`);
    if (Boolean(binding) !== Boolean(manifest)) fail("STORAGE_CORRUPT", "The research schedule binding is incomplete.");
    if (binding) {
      let record;
      try { record = validateScheduleBinding(binding); }
      catch { fail("STORAGE_CORRUPT", "The research schedule binding changed."); }
      if (manifest.sha256 !== binding.sha256 || manifest.payload_json !== binding.record_json) fail("STORAGE_CORRUPT", "The research schedule binding changed.");
      try { this.#activeSchedule({ ...record, fence: record.schedule_fence }); }
      catch (error) {
        if (["SCHEDULE_LEASE_LOST", "SCHEDULE_SCOPE_CHANGED"].includes(error.code)) fail("LEASE_LOST", "The parent schedule no longer authorizes research delivery.");
        throw error;
      }
    }
    return run;
  }
  heartbeat(lease, leaseMs = 30_000) {
    integer(leaseMs, 1);
    return this.#transaction("heartbeat", () => {
      const run = this.#active(lease); const until = Math.min(Math.max(run.lease_until, integer(this.#now() + leaseMs)), run.deadline);
      this.#write("UPDATE runs SET lease_until=? WHERE run_id=?", until, run.run_id);
      return { ...lease, lease_until: until };
    });
  }
  checkpoint(lease, key, value) {
    id(key); const payload = json(value); const sha = contentHash(value);
    return this.#transaction("checkpoint", () => {
      this.#active(lease);
      const prior = this.#get("SELECT * FROM checkpoints WHERE run_id=? AND checkpoint_key=?", lease.run_id, key);
      if (prior && prior.sha256 !== sha) fail("CHECKPOINT_CONFLICT", "A retained checkpoint is immutable.");
      this.#write("INSERT OR IGNORE INTO checkpoints VALUES(?,?,?,?)", lease.run_id, key, sha, payload);
      return { sha256: sha, payload: JSON.parse(payload) };
    });
  }
  checkpoints(runId) {
    return this.#all("SELECT checkpoint_key,sha256,payload_json FROM checkpoints WHERE run_id=? ORDER BY checkpoint_key", id(runId))
      .map((row) => ({ key: row.checkpoint_key, sha256: row.sha256, payload: JSON.parse(row.payload_json) }));
  }
  executionContext(lease) {
    return this.#transaction("execution_context", () => {
      verifyRetainedSnapshot(this.#db);
      const run = this.#active(lease);
      const envelope = validateRunEnvelope(JSON.parse(run.envelope_json));
      if (envelope.trial) fail("METHOD_TRIAL_CONTEXT_REQUIRED", "Use the exact retained trial case input.");
      const job = this.#get("SELECT d.decision_json FROM event_decisions d JOIN event_jobs j ON j.run_id=d.run_id WHERE d.run_id=? AND json_extract(d.decision_json,'$.outcome')='queued' ORDER BY d.rowid DESC LIMIT 1", run.run_id);
      for (const reference of envelope.source_refs) {
        const source = this.source(reference.source_event_id); const configured = this.sourcePolicy(run.watch_id, source.artifact.source_id);
        if (!configured) fail("SOURCE_POLICY_MISSING", "Configure the source policy before AI execution.");
        const policy = configured.policy;
        if (policy.rights_status !== "ALLOWED" || !policy.allowed_purposes.includes("local_research")) fail("SOURCE_RIGHTS_GATED", "Resolve source rights and purpose before AI execution.");
        if (policy.adapter_version !== source.event.adapter_version || policy.parser_version !== source.event.parser_version) fail("SOURCE_SCHEMA_CHANGED", "Review the source adapter and parser versions before AI execution.");
        if (Date.parse(source.artifact.retrieved_at) > this.#now()) fail("SOURCE_TIME_INVALID", "Check the future source retrieval time before AI execution.");
        if (this.#now() - Date.parse(source.artifact.retrieved_at) > policy.max_source_age_ms) fail("STALE_SOURCE", "Refresh the permitted source before AI execution.");
        if (!policy.allow_candidate_trials) fail("METHOD_CURATION_REQUIRED", "Approve the local candidate method trial before AI execution.");
        if (job && JSON.parse(job.decision_json).policy_sha256 !== configured.sha256) fail("SOURCE_POLICY_CHANGED", "Process the source event under the current source policy before execution.");
      }
      const baseline_context = envelope.baselines.map(reference => {
        if (reference.owner !== "caller_local" || reference.pack_id !== `local-evidence:${run.watch_id}`) return { reference, status: "unavailable" };
        return researchBaselineContext(this.#db, run.watch_id, run.revision, reference);
      });
      const contexts = this.#all("SELECT * FROM checkpoints WHERE run_id=? AND checkpoint_key IN ('execution-context:v1','execution-context:v2')", run.run_id);
      if (contexts.length > 1) fail("STORAGE_CORRUPT", "The run contains conflicting execution snapshots.");
      const existing = contexts[0];
      if (existing) {
        const payload = JSON.parse(existing.payload_json);
        if (contentHash(payload) !== existing.sha256) fail("STORAGE_CORRUPT", "The retained execution context changed.");
        return { sha256: existing.sha256, payload };
      }
      const revision = this.#get("SELECT * FROM revisions WHERE watch_id=? AND revision=?", run.watch_id, run.revision);
      const bundle = JSON.parse(this.#get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", envelope.method.bundle_sha256).bundle_json);
      verifyMethodBundle(bundle, envelope.method);
      if (contentHash(JSON.parse(revision.context_json)) !== envelope.local_context_sha256) fail("STORAGE_CORRUPT", "The pinned private context changed.");
      const selectedRefs = job ? JSON.parse(job.decision_json).fact_refs : null;
      const sources = envelope.source_refs.map((reference) => {
        const source = this.source(reference.source_event_id);
        verifySourceReference(source.event, source.artifact, source.bytes, reference);
        const facts = this.sourceFacts(reference.source_event_id).filter((fact) => selectedRefs === null || selectedRefs.some((ref) =>
          ref.source_event_id === fact.source_event_id && ref.fact_key === fact.fact_key && ref.sha256 === contentHash(fact)));
        if (selectedRefs !== null && selectedRefs.filter((ref) => ref.source_event_id === reference.source_event_id).length !== facts.length) fail("STORAGE_CORRUPT", "The pinned source facts changed.");
        return { reference, event: source.event, artifact: source.artifact, facts,
          source_content: buildRetainedSourceContent({ ...source, reference }) };
      });
      const payload = { schema_version: 2, source_content_renderer_sha256: SOURCE_CONTENT_RENDERER_SHA256,
        envelope, private_context: JSON.parse(revision.context_json), method_bundle: bundle,
        sources, baseline_context, created_at: new Date(this.#now()).toISOString() };
      const serialized = canonicalJson(payload);
      if (Buffer.byteLength(serialized) > MAX_JSON_BYTES) fail("SOURCE_CONTEXT_LIMIT", "Reduce the retained source scope before research.");
      const hash = contentHash(payload);
      this.#write("INSERT INTO checkpoints VALUES(?,?,?,?)", run.run_id, "execution-context:v2", hash, serialized);
      return { sha256: hash, payload: JSON.parse(serialized) };
    });
  }
  gateRun(lease, code, failureCode = null) {
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) fail("INVALID_INPUT", "Use a bounded gate code.");
    if (failureCode !== null && (!isExecutionFailureCode(failureCode) || failureCode !== code)) fail("INVALID_INPUT", "Use a known execution failure code.");
    return this.#transaction("gate_run", () => {
      const run = this.#active(lease);
      if (failureCode !== null) {
        const request = this.#get("SELECT request_id,status FROM requests WHERE run_id=? AND fence=? AND owner=? ORDER BY rowid DESC LIMIT 1", run.run_id, run.fence, run.owner);
        const diagnostic = { schema_version: 1, failure_code: failureCode, request_id: request?.request_id ?? null,
          dispatch_state: request?.status ?? "none" };
        const key = `executor:failure:${run.fence}`, sha = contentHash(diagnostic);
        const prior = this.#get("SELECT sha256 FROM checkpoints WHERE run_id=? AND checkpoint_key=?", run.run_id, key);
        if (prior && prior.sha256 !== sha) fail("CHECKPOINT_CONFLICT", "A retained execution failure is immutable.");
        this.#write("INSERT OR IGNORE INTO checkpoints VALUES(?,?,?,?)", run.run_id, key, sha, json(diagnostic));
      }
      const budgetGate = this.#releaseUndispatched(run);
      const gate = budgetGate ?? code;
      this.#write("UPDATE runs SET status='gated',gate_code=?,owner=NULL,lease_until=NULL WHERE run_id=?", gate, run.run_id);
      this.#notice(`gate:${run.run_id}:${gate}`, { run_id: run.run_id, gate_code: gate });
      return { status: "gated", code: gate };
    });
  }
  retryRun(lease, notBefore) {
    integer(notBefore);
    return this.#transaction("retry_run", () => {
      const run = this.#active(lease); const budgetGate = this.#releaseUndispatched(run);
      const gate = budgetGate ?? (Math.max(notBefore, this.#now()) >= run.deadline ? "DEADLINE_EXCEEDED" :
        run.attempts >= JSON.parse(run.policy_json).max_attempts ? "ATTEMPTS_EXCEEDED" : null);
      this.#write("UPDATE runs SET status=?,gate_code=?,not_before=?,owner=NULL,lease_until=NULL WHERE run_id=?",
        gate ? "gated" : "queued", gate, Math.max(notBefore, this.#now()), run.run_id);
      if (gate) this.#notice(`gate:${run.run_id}:${gate}`, { run_id: run.run_id, gate_code: gate });
      return { status: gate ? "gated" : "queued", ...(gate ? { code: gate } : {}) };
    });
  }
  reserveRequest(lease, operationId, estimateValue) {
    id(operationId); const estimate = { requests: 1, ...quantities(estimateValue, false) };
    return this.#transaction("reserve", () => {
      const run = this.#active(lease); const budget = this.budget(run.watch_id, run.window_id);
      if (budget.gate_code) fail("BUDGET_GATED", "Resolve the recorded budget gate before another request.");
      const settled = this.#get("SELECT * FROM requests WHERE run_id=? AND operation_id=? AND status='settled'", run.run_id, operationId);
      if (settled) return { ...settled, reused: true, response: JSON.parse(settled.response_json) };
      const requestId = `el-request-${contentHash({ run_id: run.run_id, operation_id: operationId, fence: run.fence })}`;
      const prior = this.#get("SELECT * FROM requests WHERE request_id=?", requestId);
      if (prior) {
        if (prior.estimate_json !== json(estimate)) fail("REQUEST_CONFLICT", "The request reservation has another estimate.");
        return { ...prior, reused: true };
      }
      const reserved = add(budget.reserved, estimate); const total = add(budget.spent, reserved);
      if (DIMENSIONS.some((key) => total[key] > budget.limits[key])) fail("BUDGET_EXHAUSTED", "The request exceeds the remaining watch budget.");
      this.#write("INSERT INTO requests(request_id,run_id,operation_id,fence,owner,estimate_json,status,accounting_version,receipt_set_sha256) VALUES(?,?,?,?,?,?,'reserved',1,?)", requestId, run.run_id, operationId, run.fence, run.owner, json(estimate), contentHash([]));
      this.#updateBudget(run, budget.spent, reserved);
      return { request_id: requestId, status: "reserved", reused: false };
    });
  }
  markDispatched(lease, requestId) {
    return this.#transaction("dispatch", () => {
      const run = this.#active(lease); const request = this.#get("SELECT * FROM requests WHERE request_id=?", id(requestId));
      if (JSON.parse(run.envelope_json).trial) this.#trialAuthority(run);
      if (!request || request.run_id !== run.run_id || request.fence !== run.fence || request.owner !== run.owner || request.status !== "reserved") fail("REQUEST_CONFLICT", "Dispatch only the current reserved request once.");
      const budget = this.budget(run.watch_id, run.window_id);
      if (budget.gate_code) fail("BUDGET_GATED", "Resolve the recorded budget gate before dispatch.");
      const one = { ...zero(), requests: 1 };
      this.#updateBudget(run, add(budget.spent, one), add(budget.reserved, one, -1));
      this.#write("UPDATE requests SET status='dispatched',dispatched_at=? WHERE request_id=?", this.#now(), requestId);
      return { request_id: requestId, status: "dispatched" };
    });
  }
  settleRequest(lease, requestId, usageValue, response) {
    const responseJson = json(response);
    const usage = measuredUsage(usageValue);
    return this.#transaction("settle", () => {
      const run = this.#active(lease); const request = this.#get("SELECT * FROM requests WHERE request_id=?", id(requestId));
      if (!request || request.run_id !== run.run_id || request.fence !== run.fence || request.status !== "dispatched") fail("REQUEST_CONFLICT", "Settle only the current dispatched request.");
      const budget = this.budget(run.watch_id, run.window_id);
      const receipt = this.#retainRequestReceipt(request, usage, JSON.parse(responseJson));
      if (usage === null) {
        this.#write("UPDATE requests SET status='unknown',response_json=?,selected_receipt_sha256=? WHERE request_id=?", responseJson, receipt.receipt_sha256, requestId);
        this.#updateBudget(run, budget.spent, budget.reserved, "USAGE_UNKNOWN");
        this.#write("UPDATE runs SET status='gated',gate_code='USAGE_UNKNOWN',owner=NULL,lease_until=NULL WHERE run_id=?", run.run_id);
        this.#notice(`gate:${run.run_id}:USAGE_UNKNOWN`, { run_id: run.run_id, gate_code: "USAGE_UNKNOWN" });
        return { status: "unknown" };
      }
      const actual = { requests: 0, ...usage, wall_ms: integer(receipt.record.recorded_at - request.dispatched_at) };
      const held = { ...JSON.parse(request.estimate_json), requests: 0 };
      const spent = add(budget.spent, actual); const reserved = add(budget.reserved, held, -1);
      const exceeded = DIMENSIONS.some((key) => actual[key] > held[key] || spent[key] + reserved[key] > budget.limits[key]);
      this.#updateBudget(run, spent, reserved, exceeded ? "BUDGET_EXCEEDED" : null);
      this.#write("UPDATE requests SET status='settled',usage_json=?,response_json=?,selected_receipt_sha256=? WHERE request_id=?", json(actual), responseJson, receipt.receipt_sha256, requestId);
      if (exceeded) {
        this.#write("UPDATE runs SET status='gated',gate_code='BUDGET_EXCEEDED',owner=NULL,lease_until=NULL WHERE run_id=?", run.run_id);
        this.#notice(`gate:${run.run_id}:BUDGET_EXCEEDED`, { run_id: run.run_id, gate_code: "BUDGET_EXCEEDED" });
      }
      return { status: exceeded ? "gated" : "settled" };
    });
  }
  #retainRequestReceipt(request, usage, response) {
    const content = { request_id: request.request_id, usage, response }; const sha = contentHash(content);
    const prior = this.#get("SELECT * FROM request_receipts WHERE request_id=? AND content_sha256=?", request.request_id, sha);
    if (prior) return { receipt_sha256: prior.receipt_sha256, reused: true, record: JSON.parse(prior.receipt_json) };
    const record = { ...content, request_sha256: requestFingerprint(request), recorded_at: this.#now() }; const receiptSha = contentHash(record);
    this.#write("INSERT INTO request_receipts VALUES(?,?,?,?)", receiptSha, request.request_id, sha, json(record));
    const hashes = this.#all("SELECT receipt_sha256 FROM request_receipts WHERE request_id=? ORDER BY receipt_sha256", request.request_id).map((row) => row.receipt_sha256);
    this.#write("UPDATE requests SET receipt_set_sha256=? WHERE request_id=?", contentHash(hashes), request.request_id);
    return { receipt_sha256: receiptSha, reused: false, record };
  }
  recordRequestReceipt(requestId, usageValue, response) {
    const usage = measuredUsage(usageValue); const parsed = JSON.parse(json(response));
    return this.#transaction("request_receipt", () => {
      const request = this.#get("SELECT * FROM requests WHERE request_id=?", id(requestId));
      if (!request || !["dispatched", "unknown", "settled"].includes(request.status) || request.dispatched_at === null) fail("REQUEST_CONFLICT", "Retain a receipt for a dispatched request only.");
      const receipt = this.#retainRequestReceipt(request, usage, parsed);
      return { receipt_sha256: receipt.receipt_sha256, reused: receipt.reused };
    });
  }
  requests(runId) {
    return this.#all("SELECT * FROM requests WHERE run_id=? ORDER BY rowid", id(runId)).map((row) => ({ ...row,
      estimate: JSON.parse(row.estimate_json), usage: row.usage_json === null ? null : JSON.parse(row.usage_json),
      response: row.response_json === null ? null : JSON.parse(row.response_json) }));
  }
  requestReceipts(requestId) {
    return this.#all("SELECT receipt_sha256,receipt_json FROM request_receipts WHERE request_id=? ORDER BY rowid", id(requestId))
      .map((row) => ({ receipt_sha256: row.receipt_sha256, record: JSON.parse(row.receipt_json) }));
  }
  workspaceStatus() {
    const runs = this.#all("SELECT run_id,watch_id,revision,status,gate_code,attempts,deadline,CASE WHEN json_extract(envelope_json,'$.trial') IS NULL THEN 'research' ELSE 'method_trial' END AS purpose FROM runs ORDER BY rowid").map((row) => ({ ...row }));
    const gates = runs.filter((run) => run.status === "gated").map((run) => {
      const current = this.#get("SELECT fence FROM runs WHERE run_id=?", run.run_id);
      const failure = this.#get("SELECT sha256,payload_json FROM checkpoints WHERE run_id=? AND checkpoint_key=?", run.run_id, `executor:failure:${current.fence}`);
      let diagnostic;
      if (failure) {
        diagnostic = retainedExecutionFailure((sql, ...args) => this.#get(sql, ...args),
          { ...failure, run_id: run.run_id, checkpoint_key: `executor:failure:${current.fence}` });
      }
      return { notice_id: `gate:${run.run_id}:${run.gate_code}`, gate_code: run.gate_code, run_id: run.run_id, purpose: run.purpose,
        ...(diagnostic ? { execution_failure: diagnostic } : {}) };
    });
    const seen = new Set();
    for (const row of this.#all("SELECT d.* FROM event_decisions d JOIN watches w USING(watch_id) WHERE d.revision=w.current_revision ORDER BY d.rowid DESC")) {
      if (seen.has(row.task_key)) continue; seen.add(row.task_key);
      const decision = JSON.parse(row.decision_json);
      if (decision.outcome !== "gated") continue;
      const source = this.source(row.source_event_id); const currentPolicy = this.sourcePolicy(row.watch_id, source.artifact.source_id);
      gates.push({ notice_id: row.decision_id, gate_code: currentPolicy && currentPolicy.sha256 !== decision.policy_sha256 ? "SOURCE_POLICY_CHANGED" : decision.gate_code,
        source_event_id: row.source_event_id, task_key: row.task_key });
    }
    return { schema_version: 1, counts: Object.fromEntries([
      ["watches", "watches"], ["runs", "runs"], ["deliveries", "deliveries"], ["requests", "requests"],
      ["receipts", "request_receipts"], ["notices", "outbox"],
    ].map(([name, table]) => [name, this.#get(`SELECT COUNT(*) AS total FROM ${table}`).total])),
    runs, gates, schedules: this.#all("SELECT schedule_id FROM schedule_state ORDER BY rowid").map(row => this.scheduleStatus(row.schedule_id)),
    requests: this.#all("SELECT request_id,run_id,status FROM requests ORDER BY rowid").map((row) => ({ ...row,
      receipt_sha256s: this.#all("SELECT receipt_sha256 FROM request_receipts WHERE request_id=? ORDER BY rowid", row.request_id).map((item) => item.receipt_sha256) })) };
  }
  #resumeReconciledRun(run) {
    if (run.status !== "gated" || run.gate_code !== "USAGE_UNKNOWN" || this.budget(run.watch_id, run.window_id).gate_code ||
        this.#get("SELECT request_id FROM requests WHERE run_id=? AND status IN ('reserved','dispatched','unknown')", run.run_id)) return run.status;
    const current = this.#get("SELECT current_revision FROM watches WHERE watch_id=?", run.watch_id);
    let gate = !run.envelope.trial && current.current_revision !== run.revision ? "SCOPE_CHANGED" : this.#now() >= run.deadline ? "DEADLINE_EXCEEDED" :
      run.attempts >= run.policy.max_attempts ? "ATTEMPTS_EXCEEDED" : null;
    if (!gate && run.envelope.trial) {
      try { this.#trialAuthority(run); } catch (error) { gate = error.code ?? "METHOD_TRIAL_INVALID"; }
    }
    for (const reference of run.envelope.source_refs) {
      if (gate) break;
      const source = this.source(reference.source_event_id); const policy = this.sourcePolicy(run.watch_id, source.artifact.source_id)?.policy;
      gate = !policy ? "SOURCE_POLICY_MISSING" : policy.rights_status !== "ALLOWED" || !policy.allowed_purposes.includes("local_research") ? "SOURCE_RIGHTS_GATED" :
        policy.parser_version !== source.event.parser_version || policy.adapter_version !== source.event.adapter_version ? "SOURCE_SCHEMA_CHANGED" :
          Date.parse(source.artifact.retrieved_at) > this.#now() ? "SOURCE_TIME_INVALID" :
            this.#now() - Date.parse(source.artifact.retrieved_at) > policy.max_source_age_ms ? "STALE_SOURCE" : !policy.allow_candidate_trials ? "METHOD_CURATION_REQUIRED" : null;
    }
    const status = gate ? "gated" : "queued";
    this.#write("UPDATE runs SET status=?,gate_code=?,owner=NULL,lease_until=NULL WHERE run_id=?", status, gate, run.run_id);
    if (gate) this.#notice(`gate:${run.run_id}:${gate}`, { run_id: run.run_id, gate_code: gate });
    return status;
  }
  reconcileRequestUsage(requestId, receiptSha, reason, reconciliationId, { resume = false } = {}) {
    id(requestId); id(receiptSha); id(reconciliationId);
    if (typeof reason !== "string" || !reason.trim() || reason.length > 1200 || typeof resume !== "boolean") fail("INVALID_INPUT", "Record an explicit reconciliation reason and resume choice.");
    return this.#transaction("reconcile_usage", () => {
      const prior = this.#get("SELECT record_json FROM usage_reconciliations WHERE reconciliation_id=?", reconciliationId);
      if (prior) {
        const record = JSON.parse(prior.record_json);
        if (record.request_id !== requestId || record.receipt_sha256 !== receiptSha || record.reason !== reason || record.resume !== resume) fail("RECONCILIATION_CONFLICT", "The reconciliation ID has another decision.");
        const request = this.#get("SELECT run_id FROM requests WHERE request_id=?", requestId);
        const run = this.run(request.run_id);
        // Replay the exact resume approval after another unknown request clears the shared window gate.
        const status = resume ? this.#resumeReconciledRun(run) : run.status;
        return { reused: true, request_id: requestId, status };
      }
      const request = this.#get("SELECT * FROM requests WHERE request_id=?", requestId);
      const receiptRow = this.#get("SELECT receipt_json FROM request_receipts WHERE request_id=? AND receipt_sha256=?", requestId, receiptSha);
      if (!request || request.status !== "unknown" || !receiptRow) fail("RECONCILIATION_CONFLICT", "Reconcile an unresolved request with its retained receipt only.");
      const receipt = JSON.parse(receiptRow.receipt_json); const usage = measuredUsage(receipt.usage);
      if (usage === null) fail("USAGE_UNKNOWN", "Retain measured usage before reconciliation. Do not estimate unknown usage.");
      const run = this.run(request.run_id); const budget = this.budget(run.watch_id, run.window_id);
      const actual = { requests: 0, ...usage, wall_ms: integer(receipt.recorded_at - request.dispatched_at) };
      const held = { ...JSON.parse(request.estimate_json), requests: 0 };
      const spent = add(budget.spent, actual); const reserved = add(budget.reserved, held, -1);
      const exceeded = DIMENSIONS.some((key) => actual[key] > held[key] || spent[key] + reserved[key] > budget.limits[key]);
      this.#write("UPDATE requests SET status='settled',usage_json=?,response_json=?,selected_receipt_sha256=? WHERE request_id=?", json(actual), json(receipt.response), receiptSha, requestId);
      const remainingUnknown = this.#get("SELECT q.request_id FROM requests q JOIN runs r USING(run_id) WHERE r.watch_id=? AND r.window_id=? AND q.status='unknown'", run.watch_id, run.window_id);
      const gate = exceeded ? "BUDGET_EXCEEDED" : budget.gate_code === "USAGE_UNKNOWN" && !remainingUnknown ? null : budget.gate_code;
      // Reconciliation can clear unknown usage only. It cannot clear a source or budget gate.
      this.#write("UPDATE budgets SET spent_json=?,reserved_json=?,gate_code=? WHERE watch_id=? AND window_id=?", json(spent), json(reserved), gate, run.watch_id, run.window_id);
      let status = run.status;
      if (resume && !gate) status = this.#resumeReconciledRun(run);
      if (exceeded && run.status !== "cancelled") {
        status = "gated";
        this.#write("UPDATE runs SET status='gated',gate_code='BUDGET_EXCEEDED',owner=NULL,lease_until=NULL WHERE run_id=?", run.run_id);
        this.#notice(`gate:${run.run_id}:BUDGET_EXCEEDED`, { run_id: run.run_id, gate_code: "BUDGET_EXCEEDED" });
      }
      const record = { reconciliation_id: reconciliationId, request_id: requestId, receipt_sha256: receiptSha, reason, resume, recorded_at: this.#now() };
      this.#write("INSERT INTO usage_reconciliations VALUES(?,?,?,?,?)", reconciliationId, requestId, receiptSha, contentHash(record), json(record));
      this.#write("UPDATE requests SET reconciliation_sha256=? WHERE request_id=?", contentHash(record), requestId);
      return { reused: false, request_id: requestId, status, budget_gate: gate };
    });
  }
  finish(lease, input) {
    if (this.run(lease.run_id)?.envelope.trial) fail("METHOD_TRIAL_FINISH_REQUIRED", "Trial outputs cannot become research deliveries.");
    const result = validateResearchResultFile(input);
    const payload = json(result); const sha = contentHash(result);
    return this.#transaction("finish", () => {
      const prior = this.#get("SELECT * FROM deliveries WHERE run_id=?", id(lease.run_id));
      if (prior) {
        if (prior.sha256 !== sha) fail("DELIVERY_CONFLICT", "A run can retain one immutable delivery only.");
        return { delivery_id: prior.delivery_id, reused: true };
      }
      const run = this.#active(lease); const envelope = validateRunEnvelope(JSON.parse(run.envelope_json));
      const scope = envelope.scope;
      if (!result || result.watch_id !== scope.watch_id || result.scope_revision !== scope.revision || result.theme_id !== scope.theme_id || result.stage_id !== scope.stage_id ||
          json(result.symbols) !== json(scope.symbols) || !["INITIAL_RESEARCH", "NO_NEW_EVIDENCE", "REVIEW_REQUIRED", "SOURCE_NEEDED"].includes(result.result_state)) {
        fail("RESULT_SCOPE_CONFLICT", "The delivery must match the pinned research scope and result state.");
      }
      if (!Array.isArray(result.sources) || (result.result_state !== "SOURCE_NEEDED" && result.sources.length === 0)) fail("RESULT_INVALID", "Use SOURCE_NEEDED when the result has no sources.");
      if (this.#get("SELECT request_id FROM requests WHERE run_id=? AND status IN ('reserved','dispatched','unknown')", run.run_id)) fail("REQUEST_UNRESOLVED", "Resolve request usage before delivery.");
      this.#write("INSERT INTO deliveries(delivery_id,run_id,sha256,result_json,created_at) VALUES(?,?,?,?,?)", envelope.delivery_id, run.run_id, sha, payload, this.#now());
      this.#write("UPDATE runs SET status='completed',owner=NULL,lease_until=NULL WHERE run_id=?", run.run_id);
      this.#write("UPDATE outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE notice_id=?", this.#now(), `research-needed:${run.run_id}`);
      for (const ref of envelope.source_refs) {
        const artifact = this.#get("SELECT metadata_json FROM artifacts WHERE artifact_id=?", ref.source_artifact_id);
        this.#advanceCursor(run.watch_id, JSON.parse(artifact.metadata_json).source_id, ref.source_event_id, "completed");
      }
      this.#notice(envelope.delivery_id, { delivery_id: envelope.delivery_id, run_id: run.run_id, kind: "research_review" });
      return { delivery_id: envelope.delivery_id, reused: false };
    });
  }
  inbox({ after = 0, limit = 50 } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 deliveries per page.");
    return this.#all("SELECT * FROM deliveries WHERE sequence>? ORDER BY sequence LIMIT ?", after, limit)
      .map((row) => ({ sequence: row.sequence, delivery_id: row.delivery_id, run_id: row.run_id, sha256: row.sha256, result: JSON.parse(row.result_json) }));
  }
  review(deliveryId, action, note, reviewId, expectedRevision, { acknowledge_notice = false } = {}) {
    id(deliveryId); id(reviewId); integer(expectedRevision);
    if (typeof acknowledge_notice !== "boolean") fail("INVALID_INPUT", "Use an explicit notice acknowledgement choice.");
    if (!["received", "accept_evidence", "accept_interpretation", "revisit", "reject"].includes(action) || typeof note !== "string" || !note.trim() || note.length > 1200) fail("INVALID_INPUT", "Use an explicit review action and a bounded reason.");
    const requestSha = contentHash({ deliveryId, action, note, expectedRevision });
    return this.#transaction("review", () => {
      verifyRetainedSnapshot(this.#db);
      if (this.#get("SELECT review_id FROM external_session_reviews WHERE review_id=?", reviewId)) fail("REVIEW_CONFLICT", "This review ID belongs to another request.");
      const prior = this.#get("SELECT * FROM reviews WHERE review_id=?", reviewId);
      if (prior) {
        if (prior.request_sha256 !== requestSha) fail("REVIEW_CONFLICT", "The review ID has different content.");
        if (acknowledge_notice) this.#write("UPDATE outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE notice_id=?", this.#now(), deliveryId);
        return { review_id: reviewId, reused: true };
      }
      const delivery = this.#get("SELECT d.*,r.watch_id,r.revision FROM deliveries d JOIN runs r USING(run_id) WHERE delivery_id=?", deliveryId);
      if (!delivery) fail("DELIVERY_MISSING", "Review a retained delivery only.");
      const watch = this.#get("SELECT * FROM watches WHERE watch_id=?", delivery.watch_id);
      if (watch.review_revision !== expectedRevision) fail("REVIEW_CONFLICT", "Read the current review state before saving another decision.");
      if (action.startsWith("accept_")) {
        if (watch.current_revision !== delivery.revision || JSON.parse(delivery.result_json).result_state === "SOURCE_NEEDED") fail("ACCEPTANCE_GATED", "Accept only sourced evidence for the current watch revision.");
        checkResearchRights(this.#db, researchTarget(this.#db, "native", deliveryId));
        const field = action === "accept_evidence" ? "evidence_delivery_id" : "interpretation_delivery_id";
        this.#write(`UPDATE watches SET ${field}=? WHERE watch_id=?`, deliveryId, delivery.watch_id);
      }
      const createdAt = this.#now();
      const record = reviewContent({ review_id: reviewId, delivery_id: deliveryId, action, note, request_sha256: requestSha, created_at: createdAt }, expectedRevision);
      this.#write("INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?)", reviewId, deliveryId, action, note, requestSha, createdAt, expectedRevision, contentHash(record));
      this.#write("UPDATE watches SET review_revision=review_revision+1 WHERE watch_id=?", delivery.watch_id);
      if (acknowledge_notice) this.#write("UPDATE outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE notice_id=?", this.#now(), deliveryId);
      return { review_id: reviewId, reused: false };
    });
  }
  watch(watchId) {
    const value = this.#get("SELECT * FROM watches WHERE watch_id=?", id(watchId));
    if (!value) return null;
    const revisions = this.#all("SELECT * FROM revisions WHERE watch_id=? ORDER BY revision", watchId);
    return { ...value, revisions: revisions.map((row) => ({ revision: row.revision, scope: JSON.parse(row.scope_json), local_context: JSON.parse(row.context_json), local_context_sha256: row.context_sha256 })) };
  }
  reviews(watchId) {
    return this.#all("SELECT v.* FROM reviews v JOIN deliveries d USING(delivery_id) JOIN runs r USING(run_id) WHERE r.watch_id=? ORDER BY v.rowid", id(watchId));
  }
  pageWatches({ after = 0, limit = 50 } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 watches per page.");
    return this.#readView(() => this.#all("SELECT w.rowid AS sequence,w.*,v.scope_json,v.context_json,v.context_sha256 FROM watches w JOIN revisions v ON v.watch_id=w.watch_id AND v.revision=w.current_revision WHERE w.rowid>? ORDER BY w.rowid LIMIT ?", after, limit)
      .map((row) => ({ sequence: row.sequence, watch_id: row.watch_id, current_revision: row.current_revision, review_revision: row.review_revision,
        scope: publicScope(JSON.parse(row.scope_json)), private_context: JSON.parse(row.context_json), local_context_sha256: row.context_sha256,
        evidence_delivery_id: row.evidence_delivery_id, interpretation_delivery_id: row.interpretation_delivery_id,
        evidence_reference: researchSelection(this.#db, row.watch_id, "accept_evidence"), interpretation_reference: researchSelection(this.#db, row.watch_id, "accept_interpretation"),
        latest_delivery_id: this.#get("SELECT d.delivery_id FROM deliveries d JOIN runs r USING(run_id) WHERE r.watch_id=? ORDER BY d.sequence DESC LIMIT 1", row.watch_id)?.delivery_id ?? null,
        result_count: this.#get("SELECT COUNT(*) AS total FROM deliveries d JOIN runs r USING(run_id) WHERE r.watch_id=?", row.watch_id).total,
        legacy_result_count: this.#get("SELECT COUNT(*) AS total FROM legacy_results WHERE watch_id=?", row.watch_id).total })));
  }
  pageInbox({ after = 0, limit = 50, watch_id = null, order = "oldest" } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 results per page.");
    const { comparison, direction } = pageOrder(order);
    if (watch_id !== null) id(watch_id);
    return this.#readView(() => this.#all(`SELECT d.*,r.watch_id,r.revision,w.current_revision,w.review_revision,w.evidence_delivery_id,w.interpretation_delivery_id FROM deliveries d JOIN runs r USING(run_id) JOIN watches w ON w.watch_id=r.watch_id WHERE (?=0 OR d.sequence${comparison}?) AND (? IS NULL OR r.watch_id=?) ORDER BY d.sequence ${direction} LIMIT ?`, after, after, watch_id, watch_id, limit)
      .map((row) => ({ sequence: row.sequence, delivery_id: row.delivery_id, run_id: row.run_id, sha256: row.sha256,
        result: ((value) => ({ result_id: value.result_id, watch_id: value.watch_id, scope_revision: value.scope_revision,
          theme_id: value.theme_id, ...(value.stage_id ? { stage_id: value.stage_id } : {}), symbols: value.symbols,
          created_at: value.created_at, result_state: value.result_state, summary: value.summary, next_check_at: value.next_check_at }))(JSON.parse(row.result_json)),
        source_count: JSON.parse(row.result_json).sources.length, current_revision: row.current_revision, review_revision: row.review_revision,
        is_current_revision: row.current_revision === row.revision, accepted_evidence: row.evidence_delivery_id === row.delivery_id,
        accepted_interpretation: row.interpretation_delivery_id === row.delivery_id,
        review_count: this.#get("SELECT COUNT(*) AS total FROM reviews WHERE delivery_id=?", row.delivery_id).total,
        latest_review: ((review) => review ? { ...review } : null)(this.#get("SELECT review_id,action,note,created_at,expected_revision FROM reviews WHERE delivery_id=? ORDER BY rowid DESC LIMIT 1", row.delivery_id)) })));
  }
  workspaceDelivery(deliveryId) {
    id(deliveryId);
    return this.#readView(() => {
      verifyRetainedSnapshot(this.#db);
      const row = this.#get("SELECT d.*,r.envelope_json,r.watch_id,r.revision,w.current_revision,w.review_revision,w.evidence_delivery_id,w.interpretation_delivery_id FROM deliveries d JOIN runs r USING(run_id) JOIN watches w ON w.watch_id=r.watch_id WHERE d.delivery_id=?", deliveryId);
      if (!row) return null;
      const envelope = validateRunEnvelope(JSON.parse(row.envelope_json));
      const revision = this.#get("SELECT context_json FROM revisions WHERE watch_id=? AND revision=?", row.watch_id, row.revision);
      let acceptance_gate = null;
      try { checkResearchRights(this.#db, researchTarget(this.#db, "native", deliveryId)); }
      catch (error) { if (error instanceof ExternalSessionError) acceptance_gate = error.code; else throw error; }
      return { sequence: row.sequence, delivery_id: row.delivery_id, run_id: row.run_id, sha256: row.sha256, result: JSON.parse(row.result_json),
        acceptance_gate,
        current_revision: row.current_revision, review_revision: row.review_revision, is_current_revision: row.current_revision === row.revision,
        accepted_evidence: row.evidence_delivery_id === row.delivery_id, accepted_interpretation: row.interpretation_delivery_id === row.delivery_id,
        evidence_delivery_id: row.evidence_delivery_id, interpretation_delivery_id: row.interpretation_delivery_id,
        evidence_reference: researchSelection(this.#db, row.watch_id, "accept_evidence"), interpretation_reference: researchSelection(this.#db, row.watch_id, "accept_interpretation"),
        private_context: JSON.parse(revision.context_json), provenance: { method: envelope.method, source_refs: envelope.source_refs,
          baselines: envelope.baselines, evaluation_at: envelope.evaluation_at, local_context_sha256: envelope.local_context_sha256 },
        review_count: this.#get("SELECT COUNT(*) AS total FROM reviews WHERE delivery_id=?", deliveryId).total,
        reviews: this.#all("SELECT rowid AS sequence,review_id,action,note,created_at,expected_revision FROM reviews WHERE delivery_id=? ORDER BY rowid DESC LIMIT 10", deliveryId).reverse().map((review) => ({ ...review })) };
    });
  }
  pageNotices({ after = 0, limit = 50 } = {}) {
    integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 notices per page.");
    return this.#all("SELECT rowid AS sequence,notice_id,payload_json FROM outbox WHERE rowid>? AND acknowledged_at IS NULL ORDER BY rowid LIMIT ?", after, limit)
      .map((row) => ({ sequence: row.sequence, notice_id: row.notice_id, payload: JSON.parse(row.payload_json) }));
  }
  pageReviews(deliveryId, { after = 0, limit = 50 } = {}) {
    id(deliveryId); integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 reviews per page.");
    if (!this.#get("SELECT delivery_id FROM deliveries WHERE delivery_id=?", deliveryId)) fail("DELIVERY_MISSING", "Read reviews for a retained delivery only.");
    return this.#all("SELECT rowid AS sequence,review_id,action,note,created_at,expected_revision FROM reviews WHERE delivery_id=? AND rowid>? ORDER BY rowid LIMIT ?", deliveryId, after, limit).map((row) => ({ ...row }));
  }
  pageLegacyResults(watchId, { after = 0, limit = 50 } = {}) {
    id(watchId); integer(after); integer(limit, 1); if (limit > 100) fail("INVALID_INPUT", "Read at most 100 legacy results per page.");
    return this.#all("SELECT sequence,result_id,sha256,result_json FROM legacy_results WHERE watch_id=? AND sequence>? ORDER BY sequence LIMIT ?", watchId, after, limit)
      .map((row) => { const value = JSON.parse(row.result_json); return { sequence: row.sequence, result_id: row.result_id, sha256: row.sha256,
        theme_id: value.theme_id, symbols: value.symbols, created_at: value.created_at, summary: value.summary, result_state: value.result_state,
        provenance: { status: "unknown", run_id: null, method: null, source_refs: null } }; });
  }
  workspaceLegacyResult(resultId) {
    id(resultId);
    return this.#readView(() => {
      const row = this.#get("SELECT * FROM legacy_results WHERE result_id=?", resultId);
      if (!row) return null;
      return { sequence: row.sequence, result_id: row.result_id, sha256: row.sha256, result: JSON.parse(row.result_json),
        provenance: { status: "unknown", run_id: null, method: null, source_refs: null },
        archive_reference_count: this.#get("SELECT COUNT(*) AS total FROM legacy_archive_results WHERE result_id=?", resultId).total,
        archives: this.#all("SELECT a.archive_sha256,i.saved_at,i.accepted_result_id FROM legacy_archive_results a JOIN legacy_imports i ON i.archive_sha256=a.archive_sha256 AND i.watch_id=a.watch_id WHERE a.result_id=? ORDER BY a.rowid DESC LIMIT 10", resultId)
          .map((item) => ({ ...item, acceptance_status: "legacy-unclassified" })) };
    });
  }
  notices() {
    return this.#all("SELECT * FROM outbox WHERE acknowledged_at IS NULL ORDER BY rowid").map((row) => ({ notice_id: row.notice_id, payload: JSON.parse(row.payload_json) }));
  }
  acknowledgeNotice(noticeId) {
    return this.#transaction("acknowledge", () => {
      const value = this.#get("SELECT * FROM outbox WHERE notice_id=?", id(noticeId));
      if (!value) fail("NOTICE_MISSING", "Acknowledge a retained notice only.");
      this.#write("UPDATE outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE notice_id=?", this.#now(), noticeId);
    });
  }
  backup(name) {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.sqlite$/.test(name) || name === "research.sqlite") fail("UNSAFE_STORAGE_PATH", "Use a new bounded backup file name.");
    const destination = join(this.directory, name);
    this.verifyIntegrity();
    // An exclusive empty file protects the destination and sets its private mode before SQLite writes.
    const descriptor = openSync(destination, "wx", 0o600); closeSync(descriptor);
    this.#db.prepare("VACUUM INTO ?").run(destination);
    const saved = openSync(destination, "r");
    try { fsyncSync(saved); } finally { closeSync(saved); }
    privatePath(destination, false);
    const savedDatabase = new DatabaseSync(destination, { readOnly: true });
    try { verifyRetainedIntegrity(savedDatabase); } finally { savedDatabase.close(); }
    return destination;
  }
}

export function restoreResearchLedger(backupPath, newDirectory, options = {}) {
  if (!isAbsolute(backupPath) || !isAbsolute(newDirectory) || existsSync(newDirectory)) fail("UNSAFE_STORAGE_PATH", "Restore into a new absolute workspace directory only.");
  privatePath(backupPath, false);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, SCHEMA_VERSION].includes(backup.prepare("PRAGMA user_version").get().user_version) || backup.prepare("PRAGMA application_id").get().application_id !== APPLICATION_ID ||
        backup.prepare("PRAGMA quick_check").get().quick_check !== "ok" || backup.prepare("PRAGMA foreign_key_check").get()) {
      fail("STORAGE_CORRUPT", "Restore a supported verified workspace backup.");
    }
    verifyRetainedIntegrity(backup);
    if (options.allow_migration === false && backup.prepare("PRAGMA user_version").get().user_version !== SCHEMA_VERSION) {
      fail("SCHEMA_UPGRADE_REQUIRED", "Use an explicit upgrade from a private backup into a new workspace.");
    }
  } finally { backup.close(); }
  mkdirSync(newDirectory, { mode: 0o700 });
  copyFileSync(backupPath, join(newDirectory, "research.sqlite"), constants.COPYFILE_EXCL);
  return new ResearchLedger(newDirectory, options);
}
