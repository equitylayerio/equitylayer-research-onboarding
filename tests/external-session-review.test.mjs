import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { setup, scope, context, result, policy, estimate } from "./fixtures/local-research.mjs";
import { sourcePolicy, eventFixture } from "./fixtures/source-events.mjs";
import { createRunEnvelope, canonicalJson } from "../client/local/run-contract.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { startWorkspaceServer } from "../client/local/workspace-server.mjs";

const consent = { allow_private_context: true, allow_candidate_method: true, allow_external_submission: true };
const human = { confirm_human_review: true };
function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-external-review-"))), now = Date.parse("2026-10-12T00:00:00Z");
  let ledger = new ResearchLedger(root, { clock: () => now, ...options }); const envelope = setup(ledger);
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  t.after(() => { try { ledger.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, envelope, get ledger() { return ledger; }, reopen() { ledger.close(); ledger = new ResearchLedger(root, { clock: () => now }); },
    external(number = 1, state = "INITIAL_RESEARCH") {
      const prepared = ledger.prepareExternalSession({ preparation_id: `${number.toString().padStart(8, "0")}-2222-4222-8222-222222222222`,
        watch_id: scope().watch_id, revision: 1, method_sha256: envelope.method.bundle_sha256, source_event_ids: ["event-1"] }, consent);
      const fields = Object.fromEntries(Object.entries({ ...result({ scope: scope() }), result_state: state, summary: `Synthetic external ${number}.`,
        sources: state === "SOURCE_NEEDED" ? [] : result({ scope: scope() }).sources, next_check_at: "2026-10-13T00:00:00Z" })
        .filter(([key]) => ["result_state", "summary", "sources", "drivers", "falsifiers", "unknowns", "next_check_at"].includes(key)));
      const receipt = ledger.submitExternalSession({ schema_version: 1, context_id: prepared.context.context_id,
        submission_id: `${number.toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
        session: { client: "Synthetic caller", model: "Declared test model", session_reference: `opaque-${number}` }, agent_fields: fields }, consent);
      return { ...receipt, context: prepared.context };
    } };
}
const request = (record, action, revision, id = `${action}:${revision}`) => ({ external_record_id: record.record_id, action,
  note: "Synthetic human review.", review_id: id, expected_revision: revision });
function native(f, number = 1) {
  const envelope = setup(f.ledger, number); f.ledger.enqueue(envelope, "test-window", policy());
  return f.ledger.finish(f.ledger.claim("synthetic-review-owner"), { ...result(envelope),
    result_id: `${number.toString().padStart(8, "0")}-3333-4333-8333-333333333333` });
}

test("accepted external evidence reaches a native execution snapshot and cached reads recheck rights", t => {
  const f = fixture(t), b = f.external();
  f.ledger.reviewExternalSession(request(b, "accept_evidence", 0), human);
  const raw = eventFixture(2, { sourceId: "synthetic-execution-source" });
  const reference = f.ledger.retainSource(raw.event, raw.artifact, raw.bytes);
  f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), source_id: raw.artifact.source_id });
  const next = f.external(2), envelope = createRunEnvelope({ scope: f.envelope.scope, method: f.envelope.method,
    source_refs: [reference], baselines: next.context.baselines, evaluation_at: next.context.evaluation_at,
    local_context_sha256: f.envelope.local_context_sha256 });
  f.ledger.enqueue(envelope, "test-window", policy()); const lease = f.ledger.claim("synthetic-baseline-reader");
  const first = f.ledger.executionContext(lease);
  assert.equal(first.payload.baseline_context[0].result.summary, "Synthetic external 1.");
  assert.equal(first.payload.baseline_context[0].usage, "unverified");
  assert.equal(first.payload.baseline_context[0].purpose, "comparison_evidence_only");
  assert.deepEqual(f.ledger.executionContext(lease), first);
  f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
  assert.throws(() => f.ledger.executionContext(lease), { code: "SOURCE_RIGHTS_GATED" });
  assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
});

test("native acceptance rejects held permissions without hiding historical results", t => {
  const f = fixture(t), a = native(f);
  f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
  assert.equal(f.ledger.workspaceDelivery(a.delivery_id).acceptance_gate, "SOURCE_RIGHTS_GATED");
  assert.throws(() => f.ledger.review(a.delivery_id, "accept_evidence", "Synthetic reason.", "held-native", 0), { code: "SOURCE_RIGHTS_GATED" });
  f.ledger.review(a.delivery_id, "revisit", "Synthetic historical review.", "revisit-native", 0);
  assert.equal(f.ledger.workspaceDelivery(a.delivery_id).review_count, 1);
});

test("native acceptance requires an explicit permitted source policy", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-external-review-"))), ledger = new ResearchLedger(root);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const a = native({ ledger });
  assert.throws(() => ledger.review(a.delivery_id, "accept_evidence", "Synthetic reason.", "no-policy", 0), { code: "SOURCE_RIGHTS_GATED" });
  assert.equal(ledger.workspaceDelivery(a.delivery_id).review_count, 0);
});

test("a review cannot precede its result and a failed clock check writes nothing", t => {
  let clock = Date.parse("2026-10-12T00:00:00Z");
  const f = fixture(t, { clock: () => clock }), b = f.external(); clock--;
  assert.throws(() => f.ledger.reviewExternalSession(request(b, "received", 0), human), { code: "EXTERNAL_REVIEW_TIME_INVALID" });
  assert.equal(f.ledger.pageExternalReviews(b.record_id).length, 0);
  assert.equal(f.ledger.pageWatches()[0].review_revision, 0);
});

test("runner context cannot expose an unhashed external baseline change", t => {
  const f = fixture(t), b = f.external(); f.ledger.reviewExternalSession(request(b, "accept_evidence", 0), human);
  const next = f.external(2), envelope = createRunEnvelope({ scope: f.envelope.scope, method: f.envelope.method,
    source_refs: f.envelope.source_refs, baselines: next.context.baselines, evaluation_at: next.context.evaluation_at,
    local_context_sha256: f.envelope.local_context_sha256 });
  f.ledger.enqueue(envelope, "test-window", policy()); const lease = f.ledger.claim("synthetic-integrity-reader");
  const db = new DatabaseSync(join(f.root, "research.sqlite"));
  try {
    const saved = JSON.parse(db.prepare("SELECT payload_json FROM external_session_records WHERE record_id=?").get(b.record_id).payload_json);
    saved.record.result.summary = "Unhashed synthetic change.";
    db.prepare("UPDATE external_session_records SET payload_json=? WHERE record_id=?").run(canonicalJson(saved), b.record_id);
  } finally { db.close(); }
  assert.throws(() => f.ledger.executionContext(lease), { code: "STORAGE_CORRUPT" });
});

test("authenticated HTTP external review preserves selections, consent, replay, journal and reopen", async t => {
  const f = fixture(t), a = native(f);
  f.ledger.review(a.delivery_id, "accept_evidence", "Synthetic A.", "http-a-evidence", 0);
  f.ledger.review(a.delivery_id, "accept_interpretation", "Synthetic A.", "http-a-interpretation", 1);
  const b = f.external(), server = await startWorkspaceServer({ service: new WorkspaceService(f.ledger),
    assets: { html: "<main>Test workspace</main>", js: "", css: "" } });
  t.after(() => server.close());
  const call = async (path, body, extra = {}) => {
    const response = await fetch(`${server.origin}/api/${path}`, { method: body ? "POST" : "GET", headers: {
      Authorization: `Bearer ${server.token}`, ...(body ? { Origin: server.origin, "Content-Type": "application/json", "X-EquityLayer-Request": "1" } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const list = await call("external-research?limit=1"); assert.equal(list.status, 200);
  assert.equal(list.value.items[0].external_record_id, b.record_id); assert.equal(list.value.items[0].private_context, undefined);
  assert.equal((await call("external-research", null, { Authorization: "" })).status, 403);
  assert.equal((await call("external-reviews", { ...request(b, "received", 2), ...human }, { Origin: "https://example.test" })).status, 403);
  assert.equal((await call("external-reviews", request(b, "received", 2))).value.code, "WORKSPACE_INPUT_INVALID");
  for (const [index, action] of ["received", "revisit", "reject", "accept_evidence", "accept_interpretation"].entries()) {
    const body = { ...request(b, action, index + 2), ...human }, saved = await call("external-reviews", body);
    assert.equal(saved.status, 200); assert.equal(saved.value.reused, false);
    assert.equal(saved.value.external_record.evidence_reference.id, index < 3 ? a.delivery_id : b.record_id);
    assert.equal(saved.value.external_record.interpretation_reference.id, index < 4 ? a.delivery_id : b.record_id);
    assert.equal((await call("external-reviews", body)).value.reused, true);
  }
  assert.equal((await call("external-reviews", { ...request(b, "received", 0, "stale-tab"), ...human })).status, 409);
  assert.equal((await call(`external-reviews?external_record_id=${b.record_id}&limit=2`)).value.items.length, 2);
  assert.equal((await call(`external-research/${b.record_id}`)).value.review_count, 5);
  assert.equal((await call("external-reviews?external_record_id=invalid")).status, 400);
  await server.close(); f.reopen();
  const reopened = new WorkspaceService(f.ledger).externalRecord(b.record_id);
  assert.equal(reopened.accepted_evidence, true); assert.equal(reopened.accepted_interpretation, true);
  assert.equal(reopened.verification.usage, "unverified"); assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
});

test("human review unifies native and external selection without conflating evidence and interpretation", t => {
  const f = fixture(t), a = native(f);
  f.ledger.review(a.delivery_id, "accept_evidence", "Synthetic A.", "native-a-evidence", 0);
  f.ledger.review(a.delivery_id, "accept_interpretation", "Synthetic A.", "native-a-interpretation", 1);
  const b = f.external();
  for (const [index, action] of ["received", "revisit", "reject"].entries()) {
    f.ledger.reviewExternalSession(request(b, action, index + 2), human);
    const detail = f.ledger.workspaceExternalSessionRecord(b.record_id);
    assert.equal(detail.evidence_reference.id, a.delivery_id); assert.equal(detail.interpretation_reference.id, a.delivery_id);
    assert.equal(detail.accepted_evidence, false); assert.equal(detail.accepted_interpretation, false);
  }
  f.ledger.reviewExternalSession(request(b, "accept_evidence", 5), human);
  let detail = f.ledger.workspaceExternalSessionRecord(b.record_id);
  assert.equal(detail.evidence_reference.id, b.record_id); assert.equal(detail.interpretation_reference.id, a.delivery_id);
  assert.equal(f.ledger.watch(scope().watch_id).evidence_delivery_id, null);
  f.ledger.reviewExternalSession(request(b, "accept_interpretation", 6), human);
  assert.equal(f.ledger.externalSessionStatus(b.context.context_id).accepted_interpretation, true);
  const c = f.external(2), task = f.ledger.externalSessionTask(c.context.context_id, consent);
  assert.equal(task.context.baselines[0].pack_version, b.record_id); assert.equal(task.baseline_context[0].result.summary, "Synthetic external 1.");
  assert.equal(task.baseline_context[0].usage, "unverified"); assert.equal(task.baseline_context[0].purpose, "comparison_evidence_only");
  const d = native(f, 2); f.ledger.review(d.delivery_id, "accept_evidence", "Synthetic native D.", "native-d", 7);
  detail = f.ledger.workspaceExternalSessionRecord(b.record_id);
  assert.equal(detail.evidence_reference.id, d.delivery_id); assert.equal(detail.interpretation_reference.id, b.record_id);
  f.reopen(); assert.equal(f.ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
  assert.equal(f.ledger.pageExternalReviews(b.record_id).length, 5); assert.equal(f.ledger.inbox().length, 2);
});

test("external reviews preserve an unknown native request and its held reservation", t => {
  const f = fixture(t), b = f.external(); f.ledger.enqueue(f.envelope, "test-window", policy());
  const lease = f.ledger.claim("synthetic-unknown-owner"), pending = f.ledger.reserveRequest(lease, "unknown-before-review", estimate());
  f.ledger.markDispatched(lease, pending.request_id); f.ledger.gateRun(lease, "DISPATCH_UNCERTAIN");
  const before = f.ledger.budget(scope().watch_id, "test-window"), requests = f.ledger.requests(f.envelope.run_id);
  f.ledger.reviewExternalSession(request(b, "accept_evidence", 0), human);
  assert.deepEqual(f.ledger.budget(scope().watch_id, "test-window"), before); assert.deepEqual(f.ledger.requests(f.envelope.run_id), requests);
  assert.equal(f.ledger.inbox().length, 0); f.reopen(); f.ledger.verifyIntegrity();
});

test("submission and opening a record do not acknowledge or accept it", t => {
  const f = fixture(t), b = f.external();
  const detail = f.ledger.workspaceExternalSessionRecord(b.record_id);
  assert.equal(detail.accepted_evidence, false); assert.equal(detail.accepted_interpretation, false); assert.equal(detail.review_count, 0);
  assert.equal(f.ledger.notices().length, 1); assert.equal(f.ledger.pageExternalResearch()[0].external_record_id, b.record_id);
  f.ledger.reviewExternalSession(request(b, "received", 0), human); assert.equal(f.ledger.notices().length, 0);
});

test("review requires an explicit human channel and rejects stale or conflicting requests", t => {
  const f = fixture(t), b = f.external(), first = request(b, "received", 0);
  assert.throws(() => f.ledger.reviewExternalSession(first), { code: "EXTERNAL_HUMAN_REVIEW_REQUIRED" });
  assert.equal(f.ledger.reviewExternalSession(first, human).reused, false);
  assert.equal(f.ledger.reviewExternalSession(first, human).reused, true);
  assert.throws(() => f.ledger.reviewExternalSession({ ...first, note: "Changed." }, human), { code: "REVIEW_CONFLICT" });
  assert.throws(() => f.ledger.reviewExternalSession(request(b, "reject", 0), human), { code: "REVIEW_CONFLICT" });
  assert.equal(f.ledger.workspaceExternalSessionRecord(b.record_id).review_count, 1);
});

for (const action of ["accept_evidence", "accept_interpretation"]) test(`${action} rejects missing evidence`, t => {
  const f = fixture(t), b = f.external(1, "SOURCE_NEEDED");
  assert.equal(f.ledger.workspaceExternalSessionRecord(b.record_id).acceptance_gate, "ACCEPTANCE_GATED");
  assert.throws(() => f.ledger.reviewExternalSession(request(b, action, 0), human), { code: "ACCEPTANCE_GATED" });
  f.ledger.reviewExternalSession(request(b, "revisit", 0), human); f.reopen();
});

for (const [change, code] of [[f => f.ledger.saveRevision(scope(2), context()), "EXTERNAL_SESSION_SCOPE_CHANGED"],
  [f => f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" }), "SOURCE_RIGHTS_GATED"],
  [f => f.ledger.configureSourcePolicy(scope().watch_id, sourcePolicy(2)), "EXTERNAL_SESSION_AUTHORITY_CHANGED"]]) {
  test(`current acceptance gate ${code} preserves historical review access`, t => {
    const f = fixture(t), b = f.external(); change(f);
    assert.equal(f.ledger.workspaceExternalSessionRecord(b.record_id).acceptance_gate, code);
    assert.throws(() => f.ledger.reviewExternalSession(request(b, "accept_evidence", 0), human), { code });
    f.ledger.reviewExternalSession(request(b, "reject", 0), human); f.reopen(); f.ledger.verifyIntegrity();
  });
}

test("native and external review IDs cannot refer to different journal entries", t => {
  const f = fixture(t), a = native(f), b = f.external();
  f.ledger.review(a.delivery_id, "received", "Synthetic native.", "shared-id", 0);
  assert.throws(() => f.ledger.reviewExternalSession(request(b, "received", 1, "shared-id"), human), { code: "REVIEW_CONFLICT" });
  f.ledger.reviewExternalSession(request(b, "received", 1, "external-id"), human);
  assert.throws(() => f.ledger.review(a.delivery_id, "received", "Synthetic native.", "external-id", 2), { code: "REVIEW_CONFLICT" });
});

for (const point of ["before_commit", "after_commit"]) test(`external review recovers after ${point}`, t => {
  let fault = false;
  const f = fixture(t, { fault: key => { if (fault && key === `external_review:${point}`) { fault = false; throw Error("Synthetic lost review reply."); } } });
  const b = f.external(), input = request(b, "accept_evidence", 0); fault = true;
  assert.throws(() => f.ledger.reviewExternalSession(input, human), { code: "STORAGE_WRITE_UNCERTAIN" });
  f.reopen(); assert.equal(f.ledger.reviewExternalSession(input, human).reused, point === "after_commit");
  assert.equal(f.ledger.workspaceExternalSessionRecord(b.record_id).review_count, 1); assert.equal(f.ledger.notices().length, 0);
});

test("schema eleven migration backs up retained native and external research", t => {
  const f = fixture(t), a = native(f); f.ledger.review(a.delivery_id, "accept_evidence", "Synthetic A.", "old-native-review", 0);
  const b = f.external(); f.ledger.close(); const db = new DatabaseSync(join(f.root, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest; PRAGMA user_version=11"); db.close();
  const upgraded = new ResearchLedger(f.root);
  try { assert.equal(upgraded.verifyIntegrity().schema_version, 12); assert.equal(upgraded.workspaceExternalSessionRecord(b.record_id).evidence_reference.id, a.delivery_id); }
  finally { upgraded.close(); }
  const backups = readdirSync(f.root).filter(name => name.startsWith("before-schema-12-")); assert.equal(backups.length, 1);
  const old = new DatabaseSync(join(f.root, backups[0]), { readOnly: true });
  try { assert.equal(old.prepare("PRAGMA user_version").get().user_version, 11); } finally { old.close(); }
});

test("external history is paginated, retains recent detail, and keeps stable review identities", t => {
  const f = fixture(t), b = f.external();
  for (let index = 0; index < 35; index++) f.ledger.reviewExternalSession(request(b, "received", index), human);
  assert.equal(f.ledger.workspaceExternalSessionRecord(b.record_id).reviews.length, 10);
  const first = f.ledger.pageExternalReviews(b.record_id, { limit: 20 }), second = f.ledger.pageExternalReviews(b.record_id, { after: first.at(-1).sequence, limit: 20 });
  assert.equal(first.length, 20); assert.equal(second.length, 15); assert.equal(new Set([...first, ...second].map(item => item.review_id)).size, 35);
  f.reopen(); assert.equal(f.ledger.workspaceExternalSessionRecord(b.record_id).review_count, 35);
});

for (const sql of ["DELETE FROM external_session_reviews", "DELETE FROM external_review_manifest", "UPDATE external_session_reviews SET note='changed'",
  "UPDATE watches SET review_revision=0", "UPDATE watches SET evidence_delivery_id='fake-native'"]) test(`review corruption fails reopen: ${sql}`, t => {
  const f = fixture(t), b = f.external(); f.ledger.reviewExternalSession(request(b, "accept_evidence", 0), human); f.ledger.close();
  const db = new DatabaseSync(join(f.root, "research.sqlite")); db.exec(sql); db.close();
  assert.throws(() => new ResearchLedger(f.root), { code: "STORAGE_CORRUPT" });
});
