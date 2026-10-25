import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { createRunEnvelope, contentHash, canonicalJson } from "../client/local/run-contract.mjs";
import { validateThesisProposal } from "../client/local/thesis-contract.mjs";
import { runLocal } from "../client/local-cli.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { startWorkspaceServer } from "../client/local/workspace-server.mjs";
import { loadWorkspaceAssets } from "../client/local/workspace-ui.mjs";
import { source, context, methodBundle, limits, policy, result } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";
import { thesisScope, proposal, thesisReview } from "./fixtures/thesis-proposal.mjs";

const human = { confirm_human_review: true };
function environment(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "el-thesis-test-")); let now = Date.parse("2026-10-12T00:00:00Z");
  let ledger = new ResearchLedger(root, { clock: () => now, ...options });
  ledger.saveRevision(thesisScope(), context());
  const fixture = source(), ref = ledger.retainSource(fixture.event, fixture.artifact, fixture.bytes);
  ledger.configureSourcePolicy(thesisScope().watch_id, sourcePolicy());
  t.after(() => { if (ledger) ledger.close(); });
  return { root, ref, fixture, get ledger() { return ledger; }, now: () => now,
    advance: ms => { now += ms; }, close() { ledger.close(); ledger = null; },
    reopen() { if (ledger) ledger.close(); ledger = new ResearchLedger(root, { clock: () => now }); } };
}
const next = (p, retained, patch = {}) => ({ ...p, revision: retained.revision + 1, parent_sha256: retained.sha256, ...patch });

test("workspace thesis views preserve unknowns, current gates, exact pins, and no execution", t => {
  const e = environment(t), a = e.ledger.proposeThesis(proposal(e.ref));
  const before = e.ledger.workspaceStatus().counts, service = new WorkspaceService(e.ledger);
  const view = service.thesisDetail(a.sha256);
  assert.equal(view.kind, "thesis"); assert.equal(view.verification, "structural_only");
  assert.equal(view.proposal.claims[0].status, "unknown"); assert.equal(view.acceptance_gates.accept_evidence, null);
  assert.equal(view.acceptance_gates.accept_interpretation.code, "THESIS_ACCEPTANCE_GATED");
  assert.equal(view.sources[0].artifact_sha256, e.ref.artifact_sha256);
  assert.equal(view.sources[0].local_rights_status, "ALLOWED"); assert.equal(Object.hasOwn(view.sources[0], "bytes"), false);
  assert.equal(view.author_authenticity, "not_verified"); assert.equal(view.source_authenticity, "not_verified");
  assert.deepEqual(e.ledger.workspaceStatus().counts, before); assert.equal(view.interpretation_sha256, null);
  assert.equal(service.theses({ watch_id: thesisScope().watch_id }).items[0].review_count, 0);
  assert.equal(service.theses({ watch_id: "11111111-1111-4111-8111-111111111111" }).items.length, 0);
  assert.throws(() => service.thesisDetail("not-a-hash"), { code: "WORKSPACE_INPUT_INVALID" });
});

test("workspace acceptance gates refresh source rights, freshness, and scope without writes", t => {
  const e = environment(t), a = e.ledger.proposeThesis(proposal(e.ref)), service = new WorkspaceService(e.ledger);
  e.ledger.configureSourcePolicy(thesisScope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
  assert.match(service.thesisDetail(a.sha256).acceptance_gates.accept_evidence.message, /rights/);
  e.ledger.configureSourcePolicy(thesisScope().watch_id, sourcePolicy(3)); e.advance(8 * 86400_000);
  assert.match(service.thesisDetail(a.sha256).acceptance_gates.accept_evidence.message, /stale/);
  e.ledger.saveRevision(thesisScope(2), context());
  assert.equal(service.thesisDetail(a.sha256).is_current_revision, false);
  assert.equal(service.theses().items[0].is_current_revision, false);
  assert.equal(e.ledger.thesis(a.thesis_id).evidence_revision, null);
});

test("workspace reviews reject authority fields and preserve accepted A when B is rejected", t => {
  const e = environment(t), p = proposal(e.ref), a = e.ledger.proposeThesis(p), service = new WorkspaceService(e.ledger);
  const request = (saved, action, revision) => ({ ...thesisReview(saved, action, revision), confirm_human_review: true });
  const first = request(a, "accept_evidence", 0);
  assert.throws(() => service.reviewThesis({ ...first, confirm_human_review: false }), { code: "WORKSPACE_INPUT_INVALID" });
  assert.throws(() => service.reviewThesis({ ...first, execute: true }), { code: "WORKSPACE_INPUT_INVALID" });
  assert.equal(service.reviewThesis(first).thesis.evidence_sha256, a.sha256);
  assert.equal(service.reviewThesis(first).reused, true);
  service.reviewThesis(request(a, "accept_interpretation", 1));
  const b = e.ledger.proposeThesis(next(p, a, { mechanism: "A different synthetic mechanism remains unproven." }));
  const rejected = service.reviewThesis(request(b, "reject", 2)).thesis;
  assert.equal(rejected.interpretation_sha256, a.sha256); assert.equal(rejected.accepted_interpretation, false);
  assert.equal(service.thesisDetail(a.sha256).accepted_interpretation, true);
  assert.equal(e.ledger.watch(thesisScope().watch_id).interpretation_delivery_id, null);
});

test("workspace source pages and complete thesis review journal retain bounded history", t => {
  const e = environment(t), p = proposal(e.ref), refs = [p.claims[0].evidence_refs[0]];
  for (let n = 2; n <= 23; n++) {
    const f = source(n), ref = e.ledger.retainSource(f.event, f.artifact, f.bytes);
    refs.push({ ...refs[0], document_id: `synthetic-document-${n}`, source_ref: ref });
  }
  p.claims[0].evidence_refs = refs;
  const a = e.ledger.proposeThesis(p), service = new WorkspaceService(e.ledger);
  const view = service.thesisDetail(a.sha256); assert.equal(view.sources.length, 20); assert.equal(view.source_count, 23);
  assert.equal(view.sources_has_more, true);
  const remaining = service.thesisSources({ proposal_sha256: a.sha256, after: view.sources_next_after, limit: 20 });
  assert.equal(remaining.items.length, 3); assert.equal(remaining.has_more, false);
  assert.equal(new Set([...view.sources, ...remaining.items].map(item => item.source_event_id)).size, 23);
  for (let n = 0; n < 34; n++) service.reviewThesis({ ...thesisReview(a, "received", n), confirm_human_review: true });
  assert.equal(service.thesisDetail(a.sha256).reviews.length, 10);
  const journal = service.thesisReviews({ proposal_sha256: a.sha256, limit: 20 });
  const more = service.thesisReviews({ proposal_sha256: a.sha256, after: journal.next_after, limit: 20 });
  assert.equal(journal.items.length + more.items.length, 34); assert.equal(more.has_more, false);
  assert.throws(() => service.thesisSources({ proposal_sha256: a.sha256, limit: 101 }), { code: "WORKSPACE_INPUT_INVALID" });
});

test("thesis HTTP routes require local authority and expose exact conflict recovery", async t => {
  const e = environment(t), a = e.ledger.proposeThesis(proposal(e.ref));
  const server = await startWorkspaceServer({ service: new WorkspaceService(e.ledger), assets: await loadWorkspaceAssets() });
  const auth = { Authorization: `Bearer ${server.token}` };
  const headers = { ...auth, Origin: server.origin, "Content-Type": "application/json", "X-EquityLayer-Request": "1" };
  const request = { ...thesisReview(a, "received"), confirm_human_review: true };
  try {
    for (const path of [`/api/theses/${a.sha256}`, `/api/thesis-sources?proposal_sha256=${a.sha256}`, `/api/thesis-reviews?proposal_sha256=${a.sha256}`]) {
      assert.equal((await fetch(server.origin + path)).status, 403);
      assert.equal((await fetch(server.origin + path, { headers: auth })).status, 200);
    }
    for (const key of ["Authorization", "Origin", "X-EquityLayer-Request"]) {
      const missing = { ...headers }; delete missing[key];
      assert.equal((await fetch(`${server.origin}/api/thesis-reviews`, { method: "POST", headers: missing, body: JSON.stringify(request) })).status, 403);
    }
    assert.equal(e.ledger.thesis(a.thesis_id).review_revision, 0);
    for (const badPath of ["/api/thesis-sources", "/api/thesis-reviews?proposal_sha256=bad", `/api/thesis-sources?proposal_sha256=${a.sha256}&limit=101`]) assert.equal((await fetch(server.origin + badPath, { headers: auth })).status, 400);
    assert.equal((await fetch(`${server.origin}/api/theses/${"0".repeat(64)}`, { headers: auth })).status, 404);
    const submit = body => fetch(`${server.origin}/api/thesis-reviews`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await submit({ ...request, trade: true })).status, 422);
    assert.equal((await submit(request)).status, 200);
    assert.equal((await submit(request)).status, 200);
    const conflict = await submit({ ...request, review_id: "synthetic-other", note: "Changed note." });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, "THESIS_REVIEW_CONFLICT");
    assert.equal(e.ledger.thesis(a.thesis_id).review_revision, 1);
    assert.equal(e.ledger.workspaceStatus().counts.requests, 0);
  } finally { await server.close(); }
});

test("manual thesis intake retains US/Asia roles and unknown claims without execution or adoption", t => {
  const e = environment(t); const p = proposal(), saved = e.ledger.proposeThesis(p);
  assert.equal(saved.adopted, false); assert.equal(saved.reused, false);
  const detail = e.ledger.thesis(saved.thesis_id);
  assert.equal(detail.proposals[0].proposal.claims[0].status, "unknown"); assert.equal(detail.evidence_revision, null);
  assert.equal(detail.interpretation_revision, null); assert.equal(e.ledger.workspaceStatus().counts.requests, 0);
  assert.equal(e.ledger.workspaceStatus().counts.runs, 0); assert.equal(e.ledger.notices()[0].payload.kind, "thesis_candidate");
  assert.equal(e.ledger.proposeThesis(p).reused, true); assert.equal(e.ledger.notices().length, 1);
  e.reopen(); assert.equal(e.ledger.thesis(saved.thesis_id).current_revision, 1);
});

test("evidence and interpretation acceptance require separate exact human decisions", t => {
  const e = environment(t), saved = e.ledger.proposeThesis(proposal(e.ref));
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_evidence")), { code: "THESIS_HUMAN_REVIEW_REQUIRED" });
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_interpretation"), human), { code: "THESIS_ACCEPTANCE_GATED" });
  e.ledger.reviewThesis(thesisReview(saved, "accept_evidence"), human);
  assert.equal(e.ledger.thesis(saved.thesis_id).interpretation_revision, null);
  e.ledger.reviewThesis(thesisReview(saved, "accept_interpretation", 1), human);
  e.reopen(); const detail = e.ledger.thesis(saved.thesis_id);
  assert.equal(detail.evidence_revision, 1); assert.equal(detail.interpretation_revision, 1);
  assert.equal(e.ledger.watch(thesisScope().watch_id).interpretation_delivery_id, null);
});

test("new revision, receive, revisit, and reject preserve previously accepted thesis", t => {
  const e = environment(t), p = proposal(e.ref), a = e.ledger.proposeThesis(p);
  e.ledger.reviewThesis(thesisReview(a, "accept_evidence"), human);
  e.ledger.reviewThesis(thesisReview(a, "accept_interpretation", 1), human);
  const b = e.ledger.proposeThesis(next(p, a, { title: "Synthetic revised question" }));
  for (const [i, action] of ["received", "revisit", "reject"].entries()) e.ledger.reviewThesis(thesisReview(b, action, i + 2), human);
  e.reopen(); const state = e.ledger.thesis(a.thesis_id);
  assert.equal(state.current_revision, 2); assert.equal(state.evidence_revision, 1); assert.equal(state.interpretation_revision, 1);
  assert.equal(state.proposals.length, 2); assert.equal(state.reviews.length, 5);
  assert.equal(e.ledger.notices().length, 0);
});

test("stale review compare-and-swap and changed review IDs do not mutate adoption", t => {
  const e = environment(t), saved = e.ledger.proposeThesis(proposal(e.ref));
  e.ledger.reviewThesis(thesisReview(saved, "received"), human);
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_evidence", 0, { review_id: "another-tab" }), human), { code: "THESIS_REVIEW_CONFLICT" });
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "reject", 0), human), { code: "THESIS_REVIEW_CONFLICT" });
  assert.equal(e.ledger.thesis(saved.thesis_id).evidence_revision, null);
});

for (const operation of ["thesis_propose", "thesis_review"]) for (const phase of ["before_commit", "after_commit"]) {
  test(`${operation} ${phase} fault preserves retry identity and adoption`, t => {
    let enabled = false;
    const e = environment(t, { fault(point) { if (enabled && point === `${operation}:${phase}`) throw Error("Synthetic interrupted write."); } });
    const p = proposal(e.ref); const saved = operation === "thesis_review" ? e.ledger.proposeThesis(p) : null;
    const call = () => operation === "thesis_review" ? e.ledger.reviewThesis(thesisReview(saved, "accept_evidence"), human) : e.ledger.proposeThesis(p);
    enabled = true; assert.throws(call, { code: "STORAGE_WRITE_UNCERTAIN" }); e.reopen();
    const retry = call(); assert.equal(retry.reused, phase === "after_commit");
    const detail = e.ledger.thesis(p.thesis_id); assert.equal(detail.proposals.length, 1);
    assert.equal(detail.reviews.length, operation === "thesis_review" ? 1 : 0); e.ledger.verifyIntegrity();
  });
}

for (const [label, change] of [
  ["missing source", p => { p.claims[0].evidence_refs = []; }],
  ["counterevidence not checked", p => { p.counterevidence_search = "not_started"; }],
  ["source conflict", p => { p.claims[0].status = "conflict"; }],
]) test(`${label} gates acceptance without deleting the candidate`, t => {
  const e = environment(t), p = proposal(e.ref); change(p); const saved = e.ledger.proposeThesis(p);
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_evidence"), human), { code: "THESIS_ACCEPTANCE_GATED" });
  assert.equal(e.ledger.thesis(saved.thesis_id).proposals.length, 1);
});

for (const rights of ["HOLD", "UNKNOWN"]) test(`${rights} local source rights cannot become accepted thesis evidence`, t => {
  const e = environment(t), saved = e.ledger.proposeThesis(proposal(e.ref));
  e.ledger.configureSourcePolicy(thesisScope().watch_id, { ...sourcePolicy(2), rights_status: rights });
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_evidence"), human), { code: "THESIS_ACCEPTANCE_GATED" });
});

test("watch revision and source freshness gate acceptance but preserve historical proposals", t => {
  const e = environment(t), saved = e.ledger.proposeThesis(proposal(e.ref));
  e.advance(8 * 86400_000);
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_evidence"), human), { code: "THESIS_ACCEPTANCE_GATED" });
  e.ledger.saveRevision(thesisScope(2), context());
  assert.throws(() => e.ledger.proposeThesis(next(proposal(e.ref), saved)), { code: "THESIS_SCOPE_CHANGED" });
  assert.equal(e.ledger.thesis(saved.thesis_id).current_revision, 1);
});

test("retained source corrections block adoption of the superseded source", t => {
  const e = environment(t), saved = e.ledger.proposeThesis(proposal(e.ref)); const correction = source(2);
  correction.event.event_kind = "CORRECTED_PERIOD"; correction.event.supersedes_source_event_id = e.ref.source_event_id;
  e.ledger.retainSource(correction.event, correction.artifact, correction.bytes);
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_evidence"), human), { code: "THESIS_ACCEPTANCE_GATED" });
});

test("caller-agent proposal must match a completed non-trial run, its method, scope, and source set", t => {
  const e = environment(t); const method = e.ledger.retainMethod(methodBundle());
  const savedScope = e.ledger.saveRevision(thesisScope(), context()); e.ledger.configureBudget(thesisScope().watch_id, "thesis-test", limits());
  const envelope = createRunEnvelope({ scope: savedScope.scope, method, source_refs: [e.ref], baselines: [],
    evaluation_at: "2026-10-12T00:00:00Z", local_context_sha256: savedScope.local_context_sha256 });
  e.ledger.enqueue(envelope, "thesis-test", policy());
  const p = proposal(e.ref, { origin: { kind: "caller_agent", author_id: "synthetic-agent", run_id: envelope.run_id },
    method_sha256: method.bundle_sha256, novelty: { kind: "new_mechanism", reason: "Synthetic bounded discovery." } });
  assert.throws(() => e.ledger.proposeThesis(p), { code: "THESIS_ORIGIN_INVALID" });
  e.ledger.finish(e.ledger.claim("synthetic"), result(envelope));
  const saved = e.ledger.proposeThesis(p); assert.equal(saved.adopted, false);
  const other = source(2), otherRef = e.ledger.retainSource(other.event, other.artifact, other.bytes);
  const changed = next(p, saved); changed.claims[0].evidence_refs = [{ ...p.claims[0].evidence_refs[0], source_ref: otherRef }];
  assert.throws(() => e.ledger.proposeThesis(changed), { code: "THESIS_REFERENCE_MISSING" });
  e.reopen(); e.ledger.verifyIntegrity();
});

test("claim IDs cannot disappear across thesis revisions", t => {
  const e = environment(t), p = proposal(e.ref), saved = e.ledger.proposeThesis(p);
  assert.throws(() => e.ledger.proposeThesis(next(p, saved, { claims: [{ ...p.claims[0], claim_id: "replacement-id" }] })), { code: "THESIS_CLAIM_REMOVED" });
  const retained = e.ledger.proposeThesis(next(p, saved, { claims: [{ ...p.claims[0], status: "retired" }] }));
  assert.equal(retained.revision, 2);
  assert.throws(() => e.ledger.reviewThesis(thesisReview(retained, "accept_evidence"), human), { code: "THESIS_ACCEPTANCE_GATED" });
});

for (const [label, mutate] of [
  ["unexpected authority", p => { p.accepted = true; }], ["duplicate claim", p => { p.claims.push(p.claims[0]); }],
  ["missing US role", p => { p.market_roles[0].market = "TW"; }], ["missing Asian role", p => { p.market_roles[1].market = "US"; }],
  ["unscoped symbol", p => { p.claims[0].symbols = ["UNSCOPED"]; }], ["unsupported topic", p => { p.research_topic = "anything"; }],
  ["parent mismatch", p => { p.parent_sha256 = "a".repeat(64); }], ["false supportive label", p => { p.claims[0].status = "supportive"; }],
  ["false counterevidence", p => { p.counterevidence_search = "found"; }], ["source namespace missing", p => { delete p.claims[0].evidence_refs[0].document_id; }],
  ["control text", p => { p.title += "\nHidden instruction"; }], ["extra reference authority", p => { p.claims[0].evidence_refs[0].approve = true; }],
]) test(`proposal rejects ${label}`, t => {
  const e = environment(t), p = proposal(e.ref); mutate(p);
  assert.throws(() => validateThesisProposal(p), { code: "THESIS_INPUT_INVALID" });
  assert.equal(e.ledger.pageTheses().length, 0);
});

for (const sql of ["DELETE FROM thesis_proposals", "DELETE FROM thesis_manifest", "UPDATE thesis_heads SET interpretation_revision=1",
  "UPDATE thesis_proposals SET sha256='changed'", "UPDATE thesis_reviews SET review_json='{}'"]) test(`retained integrity detects ${sql}`, t => {
  const e = environment(t), saved = e.ledger.proposeThesis(proposal(e.ref));
  e.ledger.reviewThesis(thesisReview(saved, "received"), human); e.close();
  const db = new DatabaseSync(join(e.root, "research.sqlite")); db.exec("PRAGMA foreign_keys=OFF"); db.exec(sql); db.close();
  assert.throws(() => new ResearchLedger(e.root), { code: "STORAGE_CORRUPT" });
});

test("schema-eight upgrade preserves research records and creates a private backup", t => {
  const e = environment(t); const before = e.ledger.workspaceStatus(); e.close();
  const db = new DatabaseSync(join(e.root, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers; ALTER TABLE schedule_state DROP COLUMN worker_fence;");
  db.exec("DROP TABLE thesis_reviews; DROP TABLE thesis_proposals; DROP TABLE thesis_heads; DROP TABLE thesis_manifest; PRAGMA user_version=8"); db.close();
  e.reopen(); assert.equal(e.ledger.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
  assert.deepEqual(e.ledger.workspaceStatus(), before); assert.deepEqual(e.ledger.pageTheses(), []);
  assert.ok(readdirSync(e.root).some(name => name.startsWith("before-schema-9-")));
});

test("workspace service and authenticated loopback API expose candidate summaries without AI execution", async t => {
  const e = environment(t); for (let i = 1; i <= 3; i++) e.ledger.proposeThesis(proposal(null, { thesis_id: `candidate-${i}` }));
  const service = new WorkspaceService(e.ledger), page = service.theses({ limit: 2 });
  assert.equal(page.items.length, 2); assert.equal(page.items[0].proposal, undefined);
  assert.equal(service.theses({ after: page.next_after, limit: 2 }).items.length, 1);
  const server = await startWorkspaceServer({ service, assets: await loadWorkspaceAssets() });
  try {
    assert.equal((await fetch(`${server.origin}/api/theses`)).status, 403);
    const response = await fetch(`${server.origin}/api/theses?limit=2`, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200); assert.equal((await response.json()).items.length, 2);
    assert.equal(e.ledger.workspaceStatus().counts.requests, 0);
  } finally { await server.close(); }
});

test("CLI proposal, explicit review, listing, and reopen complete without model execution", async t => {
  const e = environment(t), p = proposal(e.ref); const path = join(e.root, "proposal.json"); writeFileSync(path, JSON.stringify(p), { mode: 0o600 });
  e.close();
  const call = (...args) => runLocal(args, { stdout() {}, clock: e.now });
  const saved = await call("thesis-propose", "--workspace", e.root, "--input", path);
  assert.equal(saved.exitCode, 0); assert.equal(saved.output.status, "candidate");
  const reviewPath = join(e.root, "review.json"); writeFileSync(reviewPath, JSON.stringify(thesisReview(saved.output, "accept_evidence")), { mode: 0o600 });
  const denied = await call("thesis-review", "--workspace", e.root, "--input", reviewPath);
  assert.equal(denied.output.code, "THESIS_HUMAN_REVIEW_REQUIRED");
  assert.equal((await call("thesis-review", "--workspace", e.root, "--input", reviewPath, "--confirm-human-review")).exitCode, 0);
  assert.equal((await call("thesis-list", "--workspace", e.root)).output.items.length, 1);
  assert.equal((await call("thesis-status", "--workspace", e.root, "--thesis-id", p.thesis_id)).output.evidence_revision, 1);
  e.reopen(); assert.equal(e.ledger.workspaceStatus().counts.requests, 0);
});

test("claim delta retains the prior unknown state and names changed evidence fields", t => {
  const e = environment(t), p = proposal(e.ref), a = e.ledger.proposeThesis(p);
  const b = structuredClone(next(p, a)); b.claims[0].status = "supportive"; b.claims[0].evidence_refs[0].relation = "support";
  const saved = e.ledger.proposeThesis(b);
  assert.equal(saved.delta.claims[0].previous_status, "unknown"); assert.equal(saved.delta.claims[0].proposed_status, "supportive");
  assert.deepEqual(saved.delta.claims[0].changed_fields, ["evidence_refs", "status"]);
  assert.equal(saved.delta.significance_verified, false); assert.equal(e.ledger.thesis(p.thesis_id).evidence_revision, null);
  assert.equal(e.ledger.thesis(p.thesis_id, { after: 1 }).proposals[0].delta.claims[0].previous_status, "unknown");
});

test("title-only revisions remain in history without generating a research-change notice", t => {
  const e = environment(t), p = proposal(), a = e.ledger.proposeThesis(p);
  const b = e.ledger.proposeThesis(next(p, a, { title: "Synthetic shorter title" }));
  assert.equal(b.delta.has_research_change, false); assert.equal(e.ledger.notices().length, 1);
  assert.equal(e.ledger.thesis(p.thesis_id).proposals.length, 2);
});

test("complete proposal and review history remains available through bounded pages", t => {
  const e = environment(t); let p = proposal(), saved;
  for (let i = 0; i < 25; i++) {
    if (saved) p = next(p, saved); saved = e.ledger.proposeThesis(p);
    e.ledger.reviewThesis(thesisReview(saved, "received", i), human);
  }
  const first = e.ledger.thesis(p.thesis_id), rest = e.ledger.thesis(p.thesis_id, { after: first.next_revision, review_after: first.next_review_after });
  assert.equal(first.proposals.length, 20); assert.equal(rest.proposals.length, 5);
  assert.equal(first.reviews.length, 20); assert.equal(rest.reviews.length, 5);
  assert.equal(e.ledger.thesis(p.thesis_id).interpretation_revision, null);
  assert.throws(() => e.ledger.thesis(p.thesis_id, { limit: 101 }), { code: "INVALID_INPUT" });
});

test("CLI candidate pages accept strict numeric cursors and reject ambiguous limits", async t => {
  const e = environment(t); for (let i = 1; i <= 3; i++) e.ledger.proposeThesis(proposal(null, { thesis_id: `cli-candidate-${i}` })); e.close();
  const call = (...args) => runLocal(args, { stdout() {}, clock: e.now });
  const first = await call("thesis-list", "--workspace", e.root, "--limit", "2");
  const second = await call("thesis-list", "--workspace", e.root, "--limit", "2", "--after", `${first.output.next_after}`);
  assert.equal(first.output.items.length, 2); assert.equal(second.output.items.length, 1);
  for (const invalid of ["0", "101", "2x", "01"]) assert.equal((await call("thesis-list", "--workspace", e.root, "--limit", invalid)).output.code, "CLI_FLAGS_INVALID");
});

test("counterevidence search cannot say none found while retaining counterevidence", t => {
  const e = environment(t), p = proposal(e.ref); p.claims[0].evidence_refs[0].relation = "counter";
  assert.throws(() => validateThesisProposal(p), { code: "THESIS_INPUT_INVALID" });
});

for (const sql of ["UPDATE thesis_proposals SET created_at=created_at+1", "UPDATE thesis_proposals SET sequence=-1"]) {
  test(`an open connection detects proposal metadata corruption: ${sql}`, t => {
    const e = environment(t), saved = e.ledger.proposeThesis(proposal(e.ref));
    const db = new DatabaseSync(join(e.root, "research.sqlite")); db.exec(sql); db.close();
    assert.throws(() => e.ledger.thesis(saved.thesis_id), { code: "STORAGE_CORRUPT" });
    assert.throws(() => e.ledger.proposeThesis(proposal(e.ref, { thesis_id: "another" })), { code: "STORAGE_CORRUPT" });
  });
}

test("changed retained source bytes cannot become accepted evidence on an open connection", t => {
  const e = environment(t), saved = e.ledger.proposeThesis(proposal(e.ref));
  const db = new DatabaseSync(join(e.root, "research.sqlite"));
  db.prepare("UPDATE artifacts SET bytes=? WHERE artifact_id=?").run(Buffer.from("Changed synthetic bytes."), e.ref.source_artifact_id); db.close();
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_evidence"), human), { code: "STORAGE_CORRUPT" });
});

test("changed method bytes cannot authorize a new thesis on an open connection", t => {
  const e = environment(t), bundle = methodBundle(), method = e.ledger.retainMethod(bundle);
  const db = new DatabaseSync(join(e.root, "research.sqlite"));
  db.prepare("UPDATE methods SET bundle_json=? WHERE bundle_sha256=?").run(canonicalJson({ ...bundle, execution_policy: "Changed synthetic policy." }), method.bundle_sha256); db.close();
  assert.throws(() => e.ledger.proposeThesis(proposal(e.ref, { method_sha256: method.bundle_sha256 })), { code: "STORAGE_CORRUPT" });
});

test("source schema changes gate acceptance under the current local policy", t => {
  const e = environment(t), saved = e.ledger.proposeThesis(proposal(e.ref));
  e.ledger.configureSourcePolicy(thesisScope().watch_id, { ...sourcePolicy(2), parser_version: "changed" });
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_evidence"), human), { code: "THESIS_ACCEPTANCE_GATED" });
});

test("a raw correction cannot bypass the full source-intake lineage gate", t => {
  const e = environment(t), correction = source(2);
  correction.event.event_kind = "CORRECTED_PERIOD"; correction.event.supersedes_source_event_id = e.ref.source_event_id;
  const ref = e.ledger.retainSource(correction.event, correction.artifact, correction.bytes), saved = e.ledger.proposeThesis(proposal(ref));
  assert.throws(() => e.ledger.reviewThesis(thesisReview(saved, "accept_evidence"), human), { code: "THESIS_ACCEPTANCE_GATED" });
});
