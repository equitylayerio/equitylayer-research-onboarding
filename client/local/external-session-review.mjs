import { canonicalJson, contentHash } from "./run-contract.mjs";
import { ExternalSessionError } from "./external-session-contract.mjs";
import { researchSelection } from "./research-selection.mjs";

const fail = code => { throw new ExternalSessionError(code); };
const get = (db, sql, ...args) => db.prepare(sql).get(...args);
const all = (db, sql, ...args) => db.prepare(sql).all(...args);
const actions = ["received", "accept_evidence", "accept_interpretation", "revisit", "reject"];
export const EXTERNAL_REVIEW_SCHEMA = `
CREATE TABLE external_session_reviews(sequence INTEGER PRIMARY KEY AUTOINCREMENT,review_id TEXT NOT NULL UNIQUE,
 record_id TEXT NOT NULL REFERENCES external_session_records(record_id),action TEXT NOT NULL,note TEXT NOT NULL,
 expected_revision INTEGER NOT NULL,request_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,sha256 TEXT NOT NULL) STRICT;
CREATE TABLE external_review_manifest(singleton INTEGER PRIMARY KEY CHECK(singleton=1),sha256 TEXT NOT NULL) STRICT;
INSERT INTO external_review_manifest VALUES(1,'${contentHash([])}');
PRAGMA user_version=12;`;
export const externalReviewManifestHash = db => contentHash(all(db, "SELECT * FROM external_session_reviews ORDER BY sequence").map(row => ({ ...row })));
const fields = ["external_record_id", "action", "note", "review_id", "expected_revision"];
function requestValue(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== fields.length ||
      fields.some(key => !Object.hasOwn(value, key)) || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !Object.hasOwn(descriptor, "value")) ||
      !/^el-external-[a-f0-9]{64}$/.test(value.external_record_id ?? "") || !actions.includes(value.action) ||
      typeof value.note !== "string" || !value.note.trim() || value.note.length > 1200 || typeof value.review_id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,499}$/.test(value.review_id) || !Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0) fail("EXTERNAL_REVIEW_INPUT_INVALID");
  return JSON.parse(canonicalJson(value));
}
const recordBody = row => ({ review_id: row.review_id, external_record_id: row.record_id, action: row.action, note: row.note,
  expected_revision: row.expected_revision, request_sha256: row.request_sha256, created_at: row.created_at });

export function reviewExternalSession(db, input, now, consent, acceptanceCheck) {
  if (consent?.confirm_human_review !== true) fail("EXTERNAL_HUMAN_REVIEW_REQUIRED");
  const request = requestValue(input), requestHash = contentHash(request);
  if (get(db, "SELECT review_id FROM reviews WHERE review_id=?", request.review_id)) fail("REVIEW_CONFLICT");
  const prior = get(db, "SELECT * FROM external_session_reviews WHERE review_id=?", request.review_id);
  if (prior) {
    if (prior.request_sha256 !== requestHash) fail("REVIEW_CONFLICT");
    return { review_id: request.review_id, reused: true };
  }
  const record = get(db, "SELECT r.*,c.watch_id,c.revision FROM external_session_records r JOIN external_session_contexts c USING(context_id) WHERE record_id=?", request.external_record_id);
  if (!record) fail("EXTERNAL_RECORD_MISSING");
  if (!Number.isSafeInteger(now) || now < JSON.parse(record.payload_json).created_at) fail("EXTERNAL_REVIEW_TIME_INVALID");
  const watch = get(db, "SELECT * FROM watches WHERE watch_id=?", record.watch_id);
  if (watch.review_revision !== request.expected_revision) fail("REVIEW_CONFLICT");
  if (request.action.startsWith("accept_")) {
    acceptanceCheck(record.record_id);
    const field = request.action === "accept_evidence" ? "evidence_delivery_id" : "interpretation_delivery_id";
    db.prepare(`UPDATE watches SET ${field}=NULL WHERE watch_id=?`).run(record.watch_id);
  }
  const row = { review_id: request.review_id, record_id: record.record_id, action: request.action, note: request.note,
    expected_revision: request.expected_revision, request_sha256: requestHash, created_at: now };
  db.prepare("INSERT INTO external_session_reviews(review_id,record_id,action,note,expected_revision,request_sha256,created_at,sha256) VALUES(?,?,?,?,?,?,?,?)")
    .run(row.review_id, row.record_id, row.action, row.note, row.expected_revision, row.request_sha256, now, contentHash(recordBody(row)));
  db.prepare("UPDATE watches SET review_revision=review_revision+1 WHERE watch_id=?").run(record.watch_id);
  db.prepare("UPDATE outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE notice_id=?").run(now, `external:${record.record_id}`);
  db.prepare("UPDATE external_review_manifest SET sha256=? WHERE singleton=1").run(externalReviewManifestHash(db));
  return { review_id: request.review_id, reused: false };
}

export function verifyExternalReviews(db) {
  const manifest = all(db, "SELECT * FROM external_review_manifest");
  if (manifest.length !== 1 || manifest[0].singleton !== 1 || manifest[0].sha256 !== externalReviewManifestHash(db)) fail("EXTERNAL_SESSION_STORAGE_INVALID");
  for (const row of all(db, "SELECT * FROM external_session_reviews")) {
    const request = requestValue({ external_record_id: row.record_id, action: row.action, note: row.note, review_id: row.review_id, expected_revision: row.expected_revision });
    const source = get(db, "SELECT r.payload_json,c.watch_id,c.revision FROM external_session_records r JOIN external_session_contexts c USING(context_id) WHERE record_id=?", row.record_id);
    if (!source || !Number.isSafeInteger(row.created_at) || row.created_at < JSON.parse(source.payload_json).created_at ||
        row.sha256 !== contentHash(recordBody(row)) || row.request_sha256 !== contentHash(request) ||
        get(db, "SELECT review_id FROM reviews WHERE review_id=?", row.review_id)) fail("EXTERNAL_SESSION_STORAGE_INVALID");
    if (row.action.startsWith("accept_") && JSON.parse(source.payload_json).record.result.result_state === "SOURCE_NEEDED") fail("EXTERNAL_SESSION_STORAGE_INVALID");
    const notice = get(db, "SELECT acknowledged_at FROM outbox WHERE notice_id=?", `external:${row.record_id}`);
    if (!notice || notice.acknowledged_at === null) fail("EXTERNAL_SESSION_STORAGE_INVALID");
  }
  const counters = new Map();
  for (const row of all(db, `SELECT watch_id,expected_revision FROM (
    SELECT r.watch_id,v.expected_revision FROM reviews v JOIN deliveries d USING(delivery_id) JOIN runs r USING(run_id)
    UNION ALL SELECT c.watch_id,v.expected_revision FROM external_session_reviews v JOIN external_session_records r USING(record_id) JOIN external_session_contexts c USING(context_id))
    ORDER BY watch_id,expected_revision`)) {
    const expected = counters.get(row.watch_id) ?? 0;
    if (row.expected_revision !== expected) fail("EXTERNAL_SESSION_STORAGE_INVALID");
    counters.set(row.watch_id, expected + 1);
  }
  for (const watch of all(db, "SELECT * FROM watches")) {
    if (watch.review_revision !== (counters.get(watch.watch_id) ?? 0)) fail("EXTERNAL_SESSION_STORAGE_INVALID");
    for (const [field, action] of [["evidence_delivery_id", "accept_evidence"], ["interpretation_delivery_id", "accept_interpretation"]]) {
      const selected = researchSelection(db, watch.watch_id, action);
      if (watch[field] !== (selected?.kind === "native" ? selected.id : null)) fail("EXTERNAL_SESSION_STORAGE_INVALID");
    }
  }
}
