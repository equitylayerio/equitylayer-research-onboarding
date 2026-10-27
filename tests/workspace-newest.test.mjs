import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { startWorkspaceServer } from "../client/local/workspace-server.mjs";
import { setup, scope, context, policy, result } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";
import { proposal, thesisScope } from "./fixtures/thesis-proposal.mjs";

const consent = { allow_private_context: true, allow_candidate_method: true, allow_external_submission: true };
const uuid = n => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
function environment(t, kind) {
  const directory = mkdtempSync(join(tmpdir(), "el-newest-page-"));
  const clock = () => Date.parse("2026-10-12T00:00:00Z");
  let ledger = new ResearchLedger(directory, { clock });
  const envelope = kind === "externalResearch" ? setup(ledger) : null;
  if (envelope) ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  if (kind === "theses") ledger.saveRevision(thesisScope(), context());
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get ledger() { return ledger; }, get service() { return new WorkspaceService(ledger); },
    reopen() { ledger.close(); ledger = new ResearchLedger(directory, { clock, allow_creation: false, allow_migration: false }); },
    append(n) {
      if (kind === "inbox") {
        const run = setup(ledger, n); ledger.enqueue(run, "test-window", policy());
        ledger.finish(ledger.claim("synthetic-page-worker"), { ...result(run), result_id: uuid(n) });
      } else if (kind === "externalResearch") {
        const prepared = ledger.prepareExternalSession({ preparation_id: uuid(n), watch_id: scope().watch_id, revision: 1,
          method_sha256: envelope.method.bundle_sha256, source_event_ids: ["event-1"] }, consent);
        const agent_fields = Object.fromEntries(Object.entries({ ...result(envelope), next_check_at: "2026-10-13T00:00:00Z" })
          .filter(([key]) => ["result_state", "summary", "sources", "drivers", "falsifiers", "unknowns", "next_check_at"].includes(key)));
        ledger.submitExternalSession({ schema_version: 1, context_id: prepared.context.context_id, submission_id: uuid(n),
          session: { client: "Synthetic pagination", model: "No model invoked", session_reference: `page-${n}` }, agent_fields }, consent);
      } else ledger.proposeThesis(proposal(null, { thesis_id: `synthetic-page-${n}` }));
    } };
}

for (const kind of ["inbox", "externalResearch", "theses"]) {
  test(`${kind} newest pages expose late arrivals and retain complete stable older history`, t => {
    const f = environment(t, kind); for (let n = 1; n <= 53; n++) f.append(n);
    const before = f.ledger.workspaceStatus().counts;
    const original = f.service[kind]({ limit: 100 });
    const first = f.service[kind]({ order: "newest", limit: 20 });
    assert.deepEqual(first.items.map(item => item.sequence), Array.from({ length: 20 }, (_, i) => 53 - i));
    assert.equal(first.order, "newest"); assert.equal(first.next_after, 34); assert.equal(first.has_more, true);
    assert.deepEqual(f.ledger.workspaceStatus().counts, before);
    assert.deepEqual(f.service[kind]({ limit: 100 }), original);
    f.append(54);
    const second = f.service[kind]({ order: "newest", after: first.next_after, limit: 20 });
    const third = f.service[kind]({ order: "newest", after: second.next_after, limit: 20 });
    const all = [...first.items, ...second.items, ...third.items];
    assert.deepEqual(all.map(item => item.sequence), Array.from({ length: 53 }, (_, i) => 53 - i));
    assert.equal(third.has_more, false); assert.equal(new Set(all.map(item => item.sequence)).size, 53);
    assert.deepEqual(f.service[kind]({ order: "newest", after: 1, limit: 20 }),
      { items: [], next_after: 1, has_more: false, order: "newest" });
    assert.equal(f.service[kind]({ order: "newest", limit: 20 }).items[0].sequence, 54);
    const old = f.service[kind]({ limit: 20 });
    assert.equal(Object.hasOwn(old, "order"), false);
    assert.deepEqual(old.items.map(item => item.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(f.service[kind]({ after: 20, limit: 20 }).items[0].sequence, 21);
    assert.equal(f.service[kind]({ order: "oldest", limit: 20 }).items[0].sequence, 1);
    const absent = f.service[kind]({ order: "newest", watch_id: "99999999-1111-4111-8111-111111111111", limit: 20 });
    assert.deepEqual(absent, { items: [], next_after: 0, has_more: false, order: "newest" });
    f.reopen(); assert.equal(f.service[kind]({ order: "newest" }).items[0].sequence, 54);
    assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
  });
  for (const order of [null, undefined, "DESC", "newest;DROP", {}, []]) {
    test(`${kind} rejects explicit invalid page order ${JSON.stringify(order)}`, t => {
      const f = environment(t, kind);
      assert.throws(() => f.service[kind]({ order }), { code: "WORKSPACE_INPUT_INVALID" });
    });
  }
  test(`${kind} HTTP newest reads keep authentication and strict query checks`, async t => {
    const f = environment(t, kind); f.append(1); f.append(2);
    const server = await startWorkspaceServer({ service: f.service, assets: { html: "<main>Synthetic</main>", js: "", css: "" } });
    t.after(() => server.close());
    const route = kind === "externalResearch" ? "external-research" : kind;
    const read = (query, authorized = true) => fetch(`${server.origin}/api/${route}?${query}`, {
      headers: authorized ? { Authorization: `Bearer ${server.token}` } : {} });
    const response = await read("order=newest&limit=1"); assert.equal(response.status, 200);
    assert.equal((await response.json()).items[0].sequence, 2);
    assert.equal((await read("order=newest", false)).status, 403);
    for (const query of ["order=DESC", "order=newest&order=oldest", "order=", "order=newest&after=-1", "order=newest&limit=101"])
      assert.equal((await read(query)).status, 400);
    assert.equal((await fetch(`${server.origin}/api/watches?order=newest`, { headers: { Authorization: `Bearer ${server.token}` } })).status, 400);
    assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
  });
}
