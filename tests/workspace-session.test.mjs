import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { startWorkspaceServer } from "../client/local/workspace-server.mjs";
import { sessionConnection } from "../client/local/session-connection.mjs";
import { createSessionMcp } from "../client/local/session-mcp.mjs";
import { setup, scope, methodBundle } from "./fixtures/local-research.mjs";
import { sourcePolicy, eventFixture } from "./fixtures/source-events.mjs";
import { contentHash } from "../client/local/run-contract.mjs";

const consent = { allow_private_context: true, allow_candidate_method: true, allow_external_submission: true };
const uuid = n => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-workspace-session-"))), now = Date.parse("2026-10-12T00:00:00Z");
  const ledger = new ResearchLedger(root, { clock: () => now }), envelope = setup(ledger); ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, ledger, envelope, service: new WorkspaceService(ledger), request: (n = 1) => ({ preparation_id: uuid(n), watch_id: scope().watch_id,
    revision: 1, method_sha256: envelope.method.bundle_sha256, source_event_ids: ["event-1"], ...consent, confirm_no_sources: false }) };
}
test("guided options expose bounded metadata, not private questions or source bodies", t => {
  const f = fixture(t), before = f.ledger.workspaceStatus();
  const view = f.service.sessionOptions({ watch_id: scope().watch_id });
  assert.equal(view.revision, 1); assert.equal(view.methods.items[0].bundle_sha256, f.envelope.method.bundle_sha256);
  assert.equal(view.sources.items[0].source_event_id, "event-1"); assert.equal(view.sources.items[0].gate_code, null);
  assert.deepEqual(view.preparations.items, []); assert.doesNotMatch(JSON.stringify(view), /Synthetic local research question|synthetic_value|local_context_sha256/);
  assert.deepEqual(f.ledger.workspaceStatus(), before);
});
for (const key of ["methods_after", "sources_after", "preparations_after", "limit"]) {
  test(`guided options reject explicit null ${key}`, t => {
    const f = fixture(t);
    assert.throws(() => f.service.sessionOptions({ watch_id: scope().watch_id, [key]: null }), { code: "INVALID_INPUT" });
  });
}
test("method, source, and preparation pages have separate stable cursors", t => {
  const f = fixture(t);
  for (let n = 2; n <= 4; n++) {
    const bundle = methodBundle(); bundle.version = `test-${n}`; delete bundle.content_sha256; bundle.content_sha256 = contentHash(bundle);
    f.ledger.retainMethod(bundle); const raw = eventFixture(n); f.ledger.retainSource(raw.event, raw.artifact, raw.bytes);
  }
  for (let n = 1; n <= 3; n++) f.service.prepareSession(f.request(n));
  const first = f.service.sessionOptions({ watch_id: scope().watch_id, limit: 2 });
  assert.equal(first.methods.has_more, true); assert.equal(first.sources.has_more, true); assert.equal(first.preparations.has_more, true);
  const next = f.service.sessionOptions({ watch_id: scope().watch_id, limit: 2, methods_after: first.methods.next_after,
    sources_after: first.sources.next_after, preparations_after: first.preparations.next_after });
  assert.equal(next.methods.items.length, 2); assert.equal(next.sources.items.length, 2); assert.equal(next.preparations.items.length, 1);
  assert.equal(new Set([...first.preparations.items, ...next.preparations.items].map(v => v.request.preparation_id)).size, 3);
  assert.deepEqual(first.preparations.items[0].request.source_event_ids, ["event-1"]);
});
for (const [patch, code] of [[{ rights_status: "HOLD" }, "SOURCE_RIGHTS_GATED"], [{ parser_version: "changed" }, "SOURCE_SCHEMA_CHANGED"],
  [{ allow_candidate_trials: false }, "METHOD_CURATION_REQUIRED"], [{ issuer_map: { OTHER: "OTHER" } }, "SOURCE_SCOPE_CONFLICT"]]) {
  test(`guided source catalog and preparation share the ${code} gate`, t => {
    const f = fixture(t); f.ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), ...patch });
    assert.equal(f.service.sessionOptions({ watch_id: scope().watch_id }).sources.items[0].gate_code, code);
    assert.throws(() => f.service.prepareSession(f.request()), { code });
    assert.equal(f.service.sessionOptions({ watch_id: scope().watch_id }).preparations.items.length, 0);
  });
}
test("preparation pins its scope and can recover an exact committed reply", t => {
  const f = fixture(t), input = f.request(), one = f.service.prepareSession(input), two = f.service.prepareSession(input);
  assert.equal(one.context_id, two.context_id); assert.equal(two.reused, true); assert.equal(one.native_execution, false);
  assert.equal(one.mcp_command.command, process.execPath); assert.match(one.mcp_command.args[0], /client\/session-cli\.mjs$/);
  assert.ok(one.mcp_command.args.includes(f.root)); assert.ok(one.mcp_command.args.includes("--allow-external-submission"));
  assert.doesNotMatch(JSON.stringify(one), /Synthetic local research question|synthetic_value/);
  assert.throws(() => f.service.prepareSession({ ...input, source_event_ids: [], confirm_no_sources: true }), { code: "EXTERNAL_SESSION_PREPARATION_CONFLICT" });
  f.ledger.saveRevision(scope(2), { question: "Changed question.", trigger: "Changed trigger." });
  assert.throws(() => f.service.prepareSession(f.request(2)), { code: "EXTERNAL_SESSION_SCOPE_CHANGED" });
  assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
});
for (const change of [{ allow_private_context: false }, { allow_candidate_method: false }, { allow_external_submission: "yes" },
  { confirm_no_sources: true }, { source_event_ids: [], confirm_no_sources: false }, { command: "untrusted" }]) {
  test(`guided preparation rejects unsupported permission or authority ${Object.keys(change).join(",")}`, t => {
    const f = fixture(t); assert.throws(() => f.service.prepareSession({ ...f.request(), ...change }), { code: "WORKSPACE_INPUT_INVALID" });
    assert.equal(f.service.sessionOptions({ watch_id: scope().watch_id }).preparations.items.length, 0);
  });
}
test("an explicitly confirmed evidence gap prepares a read-only task without inventing sources", t => {
  const f = fixture(t), saved = f.service.prepareSession({ ...f.request(), source_event_ids: [], confirm_no_sources: true, allow_external_submission: false });
  assert.equal(saved.mcp_command.args.includes("--allow-external-submission"), false);
  assert.deepEqual(f.ledger.externalSessionTask(saved.context_id, consent).sources, []);
  assert.equal(f.ledger.pageExternalResearch().length, 0);
});
test("a prepared UI connection accepts a structured return into the existing Inbox", t => {
  const f = fixture(t), saved = f.service.prepareSession(f.request()), mcp = createSessionMcp({ ledger: f.ledger, context_id: saved.context_id, consent });
  mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Synthetic UI test", version: "1" } } });
  mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  const returned = mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_research", arguments: { submission_id: uuid(8),
    session: { client: "Synthetic client", model: "Declared test model", session_reference: "opaque" }, agent_fields: { result_state: "SOURCE_NEEDED",
      summary: "Synthetic task requires actual evidence.", sources: [], drivers: [], falsifiers: [], unknowns: ["Synthetic data only."], next_check_at: "2026-10-13T00:00:00Z" } } } });
  const id = returned.result.structuredContent.record_id;
  assert.equal(f.service.externalResearch().items[0].external_record_id, id); assert.equal(f.service.externalRecord(id).accepted_evidence, false);
  assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
});
test("connection construction accepts argument data, not injected executable authority", t => {
  const f = fixture(t), prepared = f.ledger.prepareExternalSession(Object.fromEntries(Object.entries(f.request()).filter(([key]) =>
    ["preparation_id", "watch_id", "revision", "method_sha256", "source_event_ids"].includes(key))), consent);
  const path = "/private/fixture with spaces;echo BAD";
  assert.ok(sessionConnection(path, prepared, consent).mcp_command.args.includes(path));
  for (const path of ["relative", "/private/bad\npath"]) assert.throws(() => sessionConnection(path, prepared, consent), { code: "SESSION_CONNECTION_INVALID" });
});
test("HTTP guided setup keeps the bearer, origin, write marker, and bounded query boundary", async t => {
  const f = fixture(t), server = await startWorkspaceServer({ service: f.service, assets: { html: "<main>Test</main>", js: "", css: "" } });
  t.after(() => server.close());
  const call = (path, body, headers = {}) => fetch(server.origin + path, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${server.token}`, ...(body ? { Origin: server.origin, "Content-Type": "application/json", "X-EquityLayer-Request": "1" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call(`/api/session-options?watch_id=${scope().watch_id}`)).status, 200);
  assert.equal((await call(`/api/session-options?watch_id=${scope().watch_id}`, null, { Authorization: "" })).status, 403);
  assert.equal((await call(`/api/session-options?watch_id=${scope().watch_id}&limit=51`)).status, 422);
  for (const headers of [{ Origin: "https://example.test" }, { "X-EquityLayer-Request": "" }, { Authorization: "" }]) {
    assert.equal((await call("/api/session-prepare", f.request(), headers)).status, 403);
  }
  assert.equal((await call("/api/session-prepare", f.request())).status, 200);
  assert.equal(f.ledger.workspaceStatus().counts.requests, 0);
});
