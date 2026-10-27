import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ResearchLedger, restoreResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { canonicalJson, contentHash } from "../client/local/run-contract.mjs";
import { externalSessionManifestHash } from "../client/local/external-session-store.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { setup, scope, policy, result, context, estimate } from "./fixtures/local-research.mjs";
import { sourcePolicy, eventFixture } from "./fixtures/source-events.mjs";

const consent = { allow_private_context: true, allow_candidate_method: true };
const submitConsent = { allow_external_submission: true };
function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-external-session-store-")));
  let now = Date.parse("2026-10-12T00:00:00Z"), ledger = new ResearchLedger(root, { clock: () => now, ...options });
  const envelope = setup(ledger); ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  const input = { preparation_id: "22222222-2222-4222-8222-222222222222", watch_id: scope().watch_id, revision: 1,
    method_sha256: envelope.method.bundle_sha256, source_event_ids: ["event-1"] };
  t.after(() => { try { ledger.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, envelope, input, get ledger() { return ledger; },
    prepare: (request = input) => ledger.prepareExternalSession(request, consent), advance: ms => { now += ms; },
    reopen() { ledger.close(); ledger = new ResearchLedger(root, { clock: () => now }); } };
}
const submission = prepared => ({ schema_version: 1, context_id: prepared.context.context_id,
  submission_id: "11111111-1111-4111-8111-111111111111",
  session: { client: "Synthetic test session", model: "caller-selected-test", session_reference: "synthetic-opaque-1" },
  agent_fields: Object.fromEntries(Object.entries({ ...result({ scope: scope() }), next_check_at: "2026-10-13T00:00:00Z" })
    .filter(([key]) => ["result_state", "summary", "sources", "drivers", "falsifiers", "unknowns", "next_check_at"].includes(key))) });

test("update focus resolves exact metadata outside normal pages without moving cursors or writing", t => {
  const f = fixture(t), raw = eventFixture(77);
  f.ledger.retainSource(raw.event, raw.artifact, raw.bytes); f.ledger.retainSourceFacts(raw.event.source_event_id, raw.facts);
  const before = protectedNative(f.root), service = new WorkspaceService(f.ledger);
  const plain = service.sessionOptions({ watch_id: scope().watch_id, limit: 1 });
  assert.equal(Object.hasOwn(plain, "focus"), false);
  const focused = service.sessionOptions({ watch_id: scope().watch_id, limit: 1,
    source_event_id: raw.event.source_event_id, method_sha256: f.envelope.method.bundle_sha256 });
  assert.deepEqual(focused.sources, plain.sources); assert.deepEqual(focused.methods, plain.methods);
  assert.equal(focused.focus.source.source_event_id, raw.event.source_event_id); assert.equal(focused.focus.source.gate_code, null);
  assert.equal(focused.focus.method.bundle_sha256, f.envelope.method.bundle_sha256);
  assert.equal(Object.hasOwn(focused.focus.source, "bytes"), false); assert.equal(Object.hasOwn(focused.focus.source, "facts"), false);
  assert.equal(f.ledger.workspaceStatus().counts.requests, 0); assert.equal(protectedNative(f.root), before);
});

for (const [change, code] of [
  [() => ({ rights_status: "HOLD" }), "SOURCE_RIGHTS_GATED"],
  [() => ({ parser_version: "changed" }), "SOURCE_SCHEMA_CHANGED"],
  [() => ({ issuer_map: { OTHER: "OTHER" } }), "SOURCE_SCOPE_CONFLICT"]
]) test(`update focus reports the current source gate ${code}`, t => {
  const f = fixture(t); f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), ...change() });
  const value = new WorkspaceService(f.ledger).sessionOptions({ watch_id: scope().watch_id,
    source_event_id: "event-1", method_sha256: f.envelope.method.bundle_sha256 });
  assert.equal(value.focus.source.gate_code, code); assert.equal(f.ledger.pageExternalSessionRecords().length, 0);
});

test("update focus keeps missing method and source references explicit without a fallback", t => {
  const f = fixture(t), value = new WorkspaceService(f.ledger).sessionOptions({ watch_id: scope().watch_id,
    source_event_id: "missing-event", method_sha256: "f".repeat(64) });
  assert.deepEqual(value.focus, { method: null, source: null });
  assert.equal(value.methods.items.length, 1); assert.equal(value.sources.items.length, 1);
});

for (const extra of [{ source_event_id: "event-1" }, { method_sha256: "f".repeat(64) },
  { source_event_id: "", method_sha256: "f".repeat(64) }, { source_event_id: "event-1", method_sha256: "wrong" }]) {
  test(`update focus rejects incomplete or invalid references ${JSON.stringify(extra)}`, t => {
    const f = fixture(t);
    assert.throws(() => new WorkspaceService(f.ledger).sessionOptions({ watch_id: scope().watch_id, ...extra }), { code: "INVALID_INPUT" });
  });
}

test("external Inbox exposes immutable local receipt time separately from the result timestamp", t => {
  const f = fixture(t), prepared = f.prepare(), input = submission(prepared);
  const originalTime = prepared.context.evaluation_at, receivedAt = Date.parse(originalTime) + 90_000;
  f.advance(90_000);
  const saved = f.ledger.submitExternalSession(input, submitConsent);
  const before = f.ledger.externalSessionRecord(saved.record_id);
  let service = new WorkspaceService(f.ledger);
  assert.equal(service.externalRecord(saved.record_id).received_at, receivedAt);
  assert.equal(service.externalRecord(saved.record_id).result.created_at, originalTime);
  assert.equal(service.externalResearch().items[0].received_at, receivedAt);
  f.advance(60_000);
  assert.equal(f.ledger.submitExternalSession(input, submitConsent).reused, true);
  assert.deepEqual(f.ledger.externalSessionRecord(saved.record_id), before);
  f.reopen(); service = new WorkspaceService(f.ledger);
  assert.equal(service.externalRecord(saved.record_id).received_at, receivedAt);
  assert.equal(service.externalResearch().items[0].received_at, receivedAt);
  assert.equal(service.externalRecord(saved.record_id).review_count, 0);
  assert.equal(service.externalRecord(saved.record_id).accepted_evidence, false);
  assert.equal(service.externalRecord(saved.record_id).accepted_interpretation, false);
});
function protectedNative(root) {
  const db = new DatabaseSync(join(root, "research.sqlite"), { readOnly: true });
  try {
    return contentHash(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'external_session_%' AND name!='outbox' ORDER BY name").all()
      .map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { bytes_base64: Buffer.from(value).toString("base64") } : value]))) })));
  } finally { db.close(); }
}

test("external research persists separately, reopens, and retains an unverified session declaration", t => {
  const f = fixture(t), before = protectedNative(f.root), prepared = f.prepare();
  const task = f.ledger.externalSessionTask(prepared.context.context_id, consent);
  assert.deepEqual(task.private_context, context()); assert.equal(task.sources[0].source_content.status, "included");
  const stored = f.ledger.submitExternalSession(submission(prepared), submitConsent);
  assert.equal(stored.accepted_evidence, false); assert.equal(stored.accepted_interpretation, false);
  assert.equal(protectedNative(f.root), before); assert.equal(f.ledger.inbox().length, 0);
  assert.equal(f.ledger.workspaceStatus().counts.requests, 0); assert.equal(f.ledger.notices()[0].payload.kind, "external_research_review");
  f.reopen(); const read = f.ledger.externalSessionRecord(stored.record_id);
  assert.equal(read.record.verification.usage, "unverified"); assert.equal(read.record.verification.session_identity, "caller_declared");
  assert.equal(f.ledger.pageExternalSessionRecords()[0].record.record_id, stored.record_id);
  assert.equal(f.ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
});

test("date policy reaches the AI task and survives return, reopen, and exact replay", t => {
  const f = fixture(t), before = protectedNative(f.root), prepared = f.prepare();
  const task = f.ledger.externalSessionTask(prepared.context.context_id, consent);
  assert.equal(task.context.schema_version, 2); assert.equal(task.citation_date_policy.enforced, true);
  assert.equal(task.citation_date_policy.timezone, "UTC");
  assert.deepEqual(task.citation_date_policy.dates.map(item => ({ date: item.date, basis: item.basis })), [{ date: "2026-10-11", basis: "retained_retrieval" }]);
  const input = submission(prepared), wrong = JSON.parse(JSON.stringify(input)); wrong.agent_fields.sources[0].date = "2026-10-10";
  assert.throws(() => f.ledger.submitExternalSession(wrong, submitConsent), { code: "EXTERNAL_SESSION_SOURCE_DATE_INVALID" });
  assert.equal(f.ledger.pageExternalSessionRecords().length, 0); assert.equal(f.ledger.notices().length, 0);
  const receipt = f.ledger.submitExternalSession(input, submitConsent);
  assert.equal(protectedNative(f.root), before); f.reopen();
  const retained = f.ledger.externalSessionRecord(receipt.record_id);
  assert.equal(retained.record.schema_version, 2); assert.equal(retained.record.source_dates[0].matches[0].basis, "retained_retrieval");
  assert.deepEqual(f.ledger.workspaceExternalSessionRecord(receipt.record_id).provenance.source_dates, retained.record.source_dates);
  assert.equal(Object.hasOwn(f.ledger.pageExternalResearch()[0], "provenance"), false);
  assert.equal(Object.hasOwn(f.ledger.pageExternalResearch()[0], "source_dates"), false);
  assert.equal(f.ledger.submitExternalSession(input, submitConsent).reused, true); f.ledger.verifyIntegrity();
  assert.equal(f.ledger.notices().length, 1);
});

test("rehashed citation metadata cannot replace the retained date basis", t => {
  const f = fixture(t), prepared = f.prepare(), receipt = f.ledger.submitExternalSession(submission(prepared), submitConsent);
  const db = new DatabaseSync(join(f.root, "research.sqlite"));
  try {
    const row = db.prepare("SELECT payload_json FROM external_session_records WHERE record_id=?").get(receipt.record_id);
    const payload = JSON.parse(row.payload_json); payload.record.source_dates[0].matches[0].basis = "declared_publication";
    const { content_sha256, record_id, ...body } = payload.record; payload.record.content_sha256 = contentHash(body);
    db.prepare("UPDATE external_session_records SET payload_json=?,sha256=? WHERE record_id=?").run(canonicalJson(payload), contentHash(payload), receipt.record_id);
    db.prepare("UPDATE external_session_manifest SET sha256=? WHERE singleton=1").run(externalSessionManifestHash(db));
  } finally { db.close(); }
  assert.throws(() => f.ledger.verifyIntegrity(), error => {
    assert.equal(error.code, "STORAGE_CORRUPT"); assert.equal(error.cause?.code, "EXTERNAL_SESSION_STORAGE_INVALID"); return true;
  });
});

test("accepted evidence retains date bases for the next research comparison", t => {
  const f = fixture(t), prepared = f.prepare(), receipt = f.ledger.submitExternalSession(submission(prepared), submitConsent);
  f.ledger.reviewExternalSession({ external_record_id: receipt.record_id, action: "accept_evidence", note: "Synthetic date-basis comparison.",
    review_id: "date-basis-review", expected_revision: 0 }, { confirm_human_review: true });
  const next = f.prepare({ ...f.input, preparation_id: "33333333-3333-4333-8333-333333333333" });
  const task = f.ledger.externalSessionTask(next.context.context_id, consent);
  assert.equal(task.baseline_context.length, 1); assert.equal(task.baseline_context[0].usage, "unverified");
  assert.equal(task.baseline_context[0].source_dates[0].matches[0].basis, "retained_retrieval");
  assert.equal(f.ledger.watch(scope().watch_id).interpretation_delivery_id, null);
});

test("preparation retries retain the original time and reject changed inputs for the same identity", t => {
  const f = fixture(t), first = f.prepare(); f.advance(1000);
  assert.deepEqual(f.prepare(), { ...first, reused: true });
  assert.throws(() => f.prepare({ ...f.input, source_event_ids: [] }), { code: "EXTERNAL_SESSION_PREPARATION_CONFLICT" });
  const second = f.prepare({ ...f.input, preparation_id: "33333333-3333-4333-8333-333333333333" });
  assert.notEqual(second.context.context_id, first.context.context_id);
});

test("explicit private-input, candidate-method, and external-submission consents remain separate", t => {
  const f = fixture(t);
  assert.throws(() => f.ledger.prepareExternalSession(f.input), { code: "PRIVATE_CONTEXT_CONSENT_REQUIRED" });
  assert.throws(() => f.ledger.prepareExternalSession(f.input, { allow_private_context: true }), { code: "METHOD_CONSENT_REQUIRED" });
  const prepared = f.prepare();
  assert.throws(() => f.ledger.externalSessionTask(prepared.context.context_id), { code: "PRIVATE_CONTEXT_CONSENT_REQUIRED" });
  assert.throws(() => f.ledger.submitExternalSession(submission(prepared)), { code: "EXTERNAL_SESSION_SUBMISSION_CONSENT_REQUIRED" });
  assert.equal(f.ledger.pageExternalSessionRecords().length, 0);
});

test("one context retains one immutable output, with exact replay but no replacement", t => {
  const f = fixture(t), prepared = f.prepare(), input = submission(prepared), first = f.ledger.submitExternalSession(input, submitConsent);
  const replay = f.ledger.submitExternalSession(input, submitConsent); assert.equal(replay.reused, true); assert.equal(replay.record_id, first.record_id);
  for (const changed of [{ ...input, submission_id: "33333333-3333-4333-8333-333333333333" },
    { ...input, agent_fields: { ...input.agent_fields, summary: "Different synthetic output." } }]) {
    assert.throws(() => f.ledger.submitExternalSession(changed, submitConsent), { code: "EXTERNAL_SESSION_SUBMISSION_CONFLICT" });
  }
  assert.equal(f.ledger.pageExternalSessionRecords().length, 1); assert.equal(f.ledger.notices().length, 1);
});

for (const point of ["before_commit", "after_commit"]) test(`external submit recovers an exact request after ${point}`, t => {
  let fault = false;
  const f = fixture(t, { fault: key => { if (fault && key === `external_submit:${point}`) { fault = false; throw Error("Synthetic lost reply."); } } });
  const prepared = f.prepare(), input = submission(prepared); fault = true;
  assert.throws(() => f.ledger.submitExternalSession(input, submitConsent), { code: "STORAGE_WRITE_UNCERTAIN" });
  f.reopen(); assert.equal(f.ledger.pageExternalSessionRecords().length, point === "after_commit" ? 1 : 0);
  assert.equal(f.ledger.submitExternalSession(input, submitConsent).reused, point === "after_commit");
  assert.equal(f.ledger.pageExternalSessionRecords().length, 1); assert.equal(f.ledger.notices().length, 1);
});

for (const point of ["before_commit", "after_commit"]) test(`external preparation recovers after ${point}`, t => {
  let fault = true;
  const f = fixture(t, { fault: key => { if (fault && key === `external_prepare:${point}`) { fault = false; throw Error("Synthetic lost preparation reply."); } } });
  assert.throws(() => f.prepare(), { code: "STORAGE_WRITE_UNCERTAIN" });
  f.reopen(); assert.equal(f.prepare().reused, point === "after_commit"); f.ledger.verifyIntegrity();
});

for (const [change, code] of [
  [f => f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" }), "SOURCE_RIGHTS_GATED"],
  [f => f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), allowed_purposes: [] }), "SOURCE_RIGHTS_GATED"],
  [f => f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), allow_candidate_trials: false }), "METHOD_CURATION_REQUIRED"],
  [f => f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), parser_version: "different" }), "SOURCE_SCHEMA_CHANGED"],
  [f => f.ledger.configureSourcePolicy(scope().watch_id, sourcePolicy(2)), "EXTERNAL_SESSION_AUTHORITY_CHANGED"],
  [f => f.ledger.saveRevision(scope(2), context()), "EXTERNAL_SESSION_SCOPE_CHANGED"],
  [f => f.advance(8 * 86400000), "STALE_SOURCE"],
]) test(`current authority blocks task access and new submission with ${code}`, t => {
  const f = fixture(t), prepared = f.prepare(); change(f);
  assert.throws(() => f.ledger.externalSessionTask(prepared.context.context_id, consent), { code });
  assert.throws(() => f.ledger.submitExternalSession(submission(prepared), submitConsent), { code });
  assert.equal(f.ledger.pageExternalSessionRecords().length, 0); f.reopen(); f.ledger.verifyIntegrity();
});

test("an exact committed replay after a HOLD reads only the retained receipt", t => {
  const f = fixture(t), prepared = f.prepare(), input = submission(prepared), first = f.ledger.submitExternalSession(input, submitConsent);
  f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
  const before = protectedNative(f.root);
  assert.equal(f.ledger.submitExternalSession(input, submitConsent).reused, true);
  assert.equal(f.ledger.externalSessionRecord(first.record_id).record.verification.usage, "unverified");
  assert.equal(protectedNative(f.root), before); assert.equal(f.ledger.notices().length, 1);
});

test("native accepted A, revisited B, unknown usage, receipts, and reservations remain unchanged", t => {
  const f = fixture(t);
  for (const number of [1, 2]) {
    const envelope = setup(f.ledger, number); f.ledger.enqueue(envelope, "test-window", policy());
    const delivered = f.ledger.finish(f.ledger.claim("synthetic-native-owner"), { ...result(envelope),
      result_id: `${number.toString().padStart(8, "0")}-1111-4111-8111-111111111111` });
    if (number === 1) {
      f.ledger.review(delivered.delivery_id, "accept_evidence", "Synthetic A.", "native-evidence", 0);
      f.ledger.review(delivered.delivery_id, "accept_interpretation", "Synthetic A.", "native-interpretation", 1);
    } else f.ledger.review(delivered.delivery_id, "revisit", "Synthetic B.", "native-revisit", 2);
  }
  const pending = setup(f.ledger, 3); f.ledger.enqueue(pending, "test-window", policy());
  const lease = f.ledger.claim("synthetic-native-owner"), request = f.ledger.reserveRequest(lease, "synthetic-unknown", estimate());
  f.ledger.markDispatched(lease, request.request_id); f.ledger.gateRun(lease, "DISPATCH_UNCERTAIN");
  const before = protectedNative(f.root), prepared = f.prepare();
  f.ledger.submitExternalSession(submission(prepared), submitConsent);
  assert.equal(protectedNative(f.root), before); assert.equal(f.ledger.requests(pending.run_id)[0].status, "unknown");
  assert.equal(f.ledger.budget(scope().watch_id, "test-window").gate_code, "USAGE_UNKNOWN");
  f.reopen(); assert.equal(protectedNative(f.root), before);
});

test("a changed accepted baseline requires a new external context", t => {
  const f = fixture(t), prepared = f.prepare();
  f.ledger.enqueue(f.envelope, "test-window", policy()); const delivered = f.ledger.finish(f.ledger.claim("synthetic-native-owner"), result(f.envelope));
  f.ledger.review(delivered.delivery_id, "accept_evidence", "Synthetic baseline changed.", "baseline-review", 0);
  assert.throws(() => f.ledger.submitExternalSession(submission(prepared), submitConsent), { code: "EXTERNAL_SESSION_AUTHORITY_CHANGED" });
});

for (const [variant, code] of [["provisional", "EVIDENCE_STATE_REVIEW_REQUIRED"], ["metric", "SOURCE_SCOPE_CONFLICT"]]) {
  test(`external preparation respects the configured ${variant} fact policy`, t => {
    const f = fixture(t), raw = eventFixture();
    if (variant === "provisional") raw.facts[0].evidence_state = "PROVISIONAL";
    else f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), metric_definition_ids: ["another_permitted_metric"] });
    f.ledger.retainSource(raw.event, raw.artifact, raw.bytes); f.ledger.retainSourceFacts(raw.event.source_event_id, raw.facts);
    assert.throws(() => f.prepare({ ...f.input, source_event_ids: [raw.event.source_event_id] }), { code });
    assert.equal(f.ledger.pageExternalSessionRecords().length, 0);
  });
}

test("normalized facts cannot change behind a prepared external context", t => {
  const f = fixture(t), raw = eventFixture(); f.ledger.retainSource(raw.event, raw.artifact, raw.bytes);
  const prepared = f.prepare({ ...f.input, source_event_ids: [raw.event.source_event_id] });
  assert.deepEqual(f.ledger.externalSessionTask(prepared.context.context_id, consent).sources[0].facts, []);
  f.ledger.retainSourceFacts(raw.event.source_event_id, raw.facts);
  assert.throws(() => f.ledger.externalSessionTask(prepared.context.context_id, consent), { code: "EXTERNAL_SESSION_AUTHORITY_CHANGED" });
});

test("mixed-source rows expose only eligible normalized facts", t => {
  const f = fixture(t), raw = eventFixture(5, { issuers: ["LITE", "UNRELATED"] });
  raw.facts[1].evidence_state = "PROVISIONAL";
  f.ledger.retainSource(raw.event, raw.artifact, raw.bytes); f.ledger.retainSourceFacts(raw.event.source_event_id, raw.facts);
  const prepared = f.prepare({ ...f.input, source_event_ids: [raw.event.source_event_id] });
  const task = f.ledger.externalSessionTask(prepared.context.context_id, consent);
  assert.deepEqual(task.sources[0].facts, [raw.facts[0]]);
  f.reopen(); f.ledger.verifyIntegrity();
});

for (const [field, value, code] of [["summary", "Buy this stock.", "RESEARCH_ADVICE_BLOCKED"],
  ["sources", [{ url: "https://unretained.test/source", date: "2026-10-11", claim: "Synthetic claim.", kind: "reported_fact" }], "RESULT_SOURCE_INVALID"]]) {
  test(`invalid external output reports ${code}, not uncertain storage`, t => {
    const f = fixture(t), prepared = f.prepare(), input = submission(prepared);
    input.agent_fields[field] = value;
    assert.throws(() => f.ledger.submitExternalSession(input, submitConsent), { code });
    assert.equal(f.ledger.pageExternalSessionRecords().length, 0); assert.equal(f.ledger.notices().length, 0);
  });
}

test("a rehashed context cannot claim a historically incompatible parser policy", t => {
  const f = fixture(t); f.prepare();
  f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), parser_version: "incompatible-parser" }); f.ledger.close();
  const db = new DatabaseSync(join(f.root, "research.sqlite"));
  const row = db.prepare("SELECT payload_json FROM external_session_contexts").get(), payload = JSON.parse(row.payload_json);
  const policyRow = db.prepare("SELECT sha256 FROM source_policies WHERE revision=2").get();
  payload.authority.policies[0] = { source_id: "synthetic-exchange", revision: 2, sha256: policyRow.sha256 };
  db.prepare("UPDATE external_session_contexts SET payload_json=?,sha256=?").run(canonicalJson(payload), contentHash(payload));
  db.prepare("UPDATE external_session_manifest SET sha256=?").run(externalSessionManifestHash(db)); db.close();
  assert.throws(() => new ResearchLedger(f.root), { code: "STORAGE_CORRUPT" });
});

test("a later retained correction cannot silently replace pinned source data", t => {
  const f = fixture(t), prepared = f.prepare(), previous = f.ledger.source("event-1");
  f.ledger.retainSource({ ...previous.event, source_event_id: "new-correction", event_kind: "CORRECTED_PERIOD", supersedes_source_event_id: "event-1" }, previous.artifact, previous.bytes);
  assert.throws(() => f.ledger.submitExternalSession(submission(prepared), submitConsent), { code: "CORRECTION_REVIEW_REQUIRED" });
  assert.equal(f.ledger.pageExternalSessionRecords().length, 0);
});

test("backup and restore preserve external history and private storage modes", t => {
  const f = fixture(t), prepared = f.prepare(), stored = f.ledger.submitExternalSession(submission(prepared), submitConsent);
  const backup = f.ledger.backup("external-backup.sqlite"), before = readFileSync(backup);
  const restored = restoreResearchLedger(backup, join(f.root, "restored"));
  try { assert.deepEqual(restored.externalSessionRecord(stored.record_id), f.ledger.externalSessionRecord(stored.record_id)); restored.verifyIntegrity(); }
  finally { restored.close(); }
  assert.deepEqual(readFileSync(backup), before);
});

test("schema-ten migration creates a private backup and keeps native history", t => {
  const f = fixture(t), before = protectedNative(f.root); f.ledger.close();
  const db = new DatabaseSync(join(f.root, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest; PRAGMA user_version=10;"); db.close();
  const upgraded = new ResearchLedger(f.root);
  try { assert.equal(upgraded.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION); assert.equal(protectedNative(f.root), before); }
  finally { upgraded.close(); }
  const backups = readdirSync(f.root).filter(name => name.startsWith("before-schema-11-")); assert.equal(backups.length, 1);
  const snapshot = new DatabaseSync(join(f.root, backups[0]), { readOnly: true });
  try { assert.equal(snapshot.prepare("PRAGMA user_version").get().user_version, 10); } finally { snapshot.close(); }
});

for (const sql of ["DELETE FROM external_session_records", "DELETE FROM external_session_contexts", "DELETE FROM external_session_manifest",
  "UPDATE external_session_contexts SET request_sha256='changed'", "UPDATE external_session_records SET payload_json='{}'",
  "DELETE FROM outbox WHERE json_extract(payload_json,'$.kind')='external_research_review'"]) {
  test(`corrupt external history fails reopen: ${sql}`, t => {
    const f = fixture(t), prepared = f.prepare(); f.ledger.submitExternalSession(submission(prepared), submitConsent); f.ledger.close();
    const db = new DatabaseSync(join(f.root, "research.sqlite")); db.exec("PRAGMA foreign_keys=OFF"); db.exec(sql); db.close();
    assert.throws(() => new ResearchLedger(f.root), { code: "STORAGE_CORRUPT" });
  });
}

test("rehashing a record cannot add runner or acceptance authority", t => {
  const f = fixture(t), prepared = f.prepare(); f.ledger.submitExternalSession(submission(prepared), submitConsent); f.ledger.close();
  const db = new DatabaseSync(join(f.root, "research.sqlite"));
  const row = db.prepare("SELECT * FROM external_session_records").get(), payload = JSON.parse(row.payload_json);
  payload.record.accepted_evidence = true;
  db.prepare("UPDATE external_session_records SET payload_json=?,sha256=?").run(JSON.stringify(payload), contentHash(payload));
  db.prepare("UPDATE external_session_manifest SET sha256=?").run(externalSessionManifestHash(db)); db.close();
  assert.throws(() => new ResearchLedger(f.root), { code: "STORAGE_CORRUPT" });
});

test("two actual processes cannot duplicate an external record or its notice", async t => {
  const f = fixture(t), prepared = f.prepare(), input = JSON.stringify(submission(prepared));
  const module = fileURLToPath(new URL("../client/local/ledger.mjs", import.meta.url));
  const code = `import {ResearchLedger} from ${JSON.stringify(module)};const db=new ResearchLedger(process.argv[1],{clock:()=>Date.parse('2026-10-12T00:00:00Z')});try{process.stdout.write(JSON.stringify(db.submitExternalSession(JSON.parse(process.argv[2]),{allow_external_submission:true})));}finally{db.close();}`;
  const worker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.root, input], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.resume();
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("Synthetic writer exceeded its deadline.")); }, 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", status => { clearTimeout(timer); status === 0 ? resolve(JSON.parse(output)) : reject(Error("Synthetic writer failed.")); });
  });
  const outputs = await Promise.all([worker(), worker()]);
  assert.deepEqual(outputs.map(value => value.reused).sort(), [false, true]);
  assert.equal(f.ledger.pageExternalSessionRecords().length, 1); assert.equal(f.ledger.notices().length, 1); f.ledger.verifyIntegrity();
});
