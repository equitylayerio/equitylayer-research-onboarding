import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkspaceServer } from "../client/local/workspace-server.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { WorkspaceService } from "../client/local/workspace-service.mjs";
import { setup, scope, policy, result } from "./fixtures/local-research.mjs";

const assets = { html: '<!doctype html><html><head><link rel="stylesheet" href="/workspace.css"></head><body><main id="workspace"></main><script src="/workspace.js"></script></body></html>',
  js: 'document.querySelector("main").textContent = "Local workspace";', css: "body { color: black; }" };
const syntheticDelivery = `el-delivery-${"a".repeat(64)}`;
function stub() {
  const calls = []; const watches = [], reviews = [], acknowledgements = [], imports = [];
  const service = { calls, watchesSaved: watches, reviewsSaved: reviews, acknowledgements, imports,
    status: () => { calls.push("status"); return { status: "local", counts: { watches: watches.length } }; },
    watches: (params) => { calls.push(["watches", params]); return { items: watches }; },
    inbox: (params) => { calls.push(["inbox", params]); return { items: [] }; },
    sessionOptions: (params) => { calls.push(["sessionOptions", params]); return {}; },
    prepareSession: (params) => { calls.push(["prepareSession", params]); return {}; },
    externalResearch: (params) => { calls.push(["externalResearch", params]); return { items: [] }; },
    externalRecord: (id) => { calls.push(["externalRecord", id]); return { external_record_id: id }; },
    externalReviews: (params) => { calls.push(["externalReviews", params]); return { items: [] }; },
    reviewExternal: (value) => { calls.push(["reviewExternal", value]); return { saved: true }; },
    theses: (params) => { calls.push(["theses", params]); return { items: [] }; },
    thesisDetail: (id) => { calls.push(["thesisDetail", id]); return { sha256: id }; },
    thesisSources: (params) => { calls.push(["thesisSources", params]); return { items: [] }; },
    thesisReviews: (params) => { calls.push(["thesisReviews", params]); return { items: [] }; },
    reviewThesis: (value) => { calls.push(["reviewThesis", value]); return { saved: true }; },
    delivery: (id) => { calls.push(["delivery", id]); return { delivery_id: id, result: { summary: "SECRET_RETAINED_RESULT" } }; },
    notices: (params) => { calls.push(["notices", params]); return { items: [] }; },
    reviews: (params) => { calls.push(["reviews", params]); return { items: [] }; },
    legacy: (params) => { calls.push(["legacy", params]); return { items: [] }; },
    legacyResult: (id) => { calls.push(["legacyResult", id]); return { result_id: id }; },
    saveWatch: (value) => { calls.push("saveWatch"); watches.push(value); return { saved: true }; },
    review: (value) => { calls.push("review"); reviews.push(value); return { saved: true }; },
    acknowledge: (value) => { calls.push("acknowledge"); acknowledgements.push(value); return { acknowledged: true }; },
    importLegacy: (value) => { calls.push("importLegacy"); imports.push(value); return { imported: true }; },
    close: () => { service.closed = true; } };
  return service;
}
async function environment(t, service = stub()) {
  const server = await startWorkspaceServer({ service, assets }); t.after(async () => { await server.close(); });
  return { ...server, service };
}
function request(server, path = "/api/status", { method = "GET", headers = {}, body, authorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(server.origin);
    const req = httpRequest({ hostname: "127.0.0.1", port: endpoint.port, path, method,
      headers: { ...(authorized ? { Authorization: `Bearer ${server.token}` } : {}), ...headers } }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); if (body !== undefined) req.write(body); req.end();
  });
}
const writeHeaders = (server) => ({ Origin: server.origin, "Content-Type": "application/json", "X-EquityLayer-Request": "1" });
function raw(server, requestBytes) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(server.origin).port) });
    const chunks = []; socket.setTimeout(4000, () => { socket.destroy(); reject(new Error("Synthetic request deadline exceeded.")); });
    socket.on("connect", () => socket.write(requestBytes)); socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => { if (!chunks.length) reject(error); });
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
const rawHead = (server, extra = "", path = "/api/status", method = "GET") => `${method} ${path} HTTP/1.1\r\nHost: ${new URL(server.origin).host}\r\nAuthorization: Bearer ${server.token}\r\n${extra}`;

test("server binds loopback and supplies a per-start token only to its caller", async (t) => {
  const one = await environment(t), two = await environment(t);
  assert.match(one.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/); assert.match(one.token, /^[a-f0-9]{64}$/);
  assert.notEqual(one.token, two.token); assert.equal(one.url, `${one.origin}/`);
  assert.equal(one.bootstrap_url, `${one.origin}/#token=${one.token}`); assert.equal(new URL(one.bootstrap_url).search, "");
  await assert.rejects(startWorkspaceServer({ service: stub(), assets, host: "0.0.0.0" }), { code: "SERVER_CONFIG_INVALID" });
});
test("the fixed self-hosted font route accepts only trusted font bytes and never exposes private data", async (t) => {
  const server = await startWorkspaceServer({ service: stub(), assets: { ...assets, font: Buffer.from("wOF2SyntheticFont") } });
  t.after(() => server.close());
  const response = await request(server, "/inter.woff2", { authorized: false });
  assert.equal(response.status, 200); assert.equal(response.headers["content-type"], "font/woff2");
  assert.equal(response.text, "wOF2SyntheticFont"); assert.match(response.headers["content-security-policy"], /font-src 'self'/);
  assert.equal(response.text.includes(server.token), false); assert.equal(response.headers["access-control-allow-origin"], undefined);
  await assert.rejects(startWorkspaceServer({ service: stub(), assets: { ...assets, font: "/private/font-path" } }), { code: "SERVER_CONFIG_INVALID" });
  assert.equal((await request(server, "/fonts/other.woff2")).status, 404);
});
test("static assets contain no injected private data, token, cookies, or private cache validators", async (t) => {
  const server = await environment(t);
  for (const path of ["/", "/workspace.js", "/workspace.css"]) {
    const response = await request(server, path, { authorized: false }); assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers.etag, undefined); assert.equal(response.headers["set-cookie"], undefined);
    assert.doesNotMatch(response.text + JSON.stringify(response.headers), new RegExp(`${server.token}|SECRET_RETAINED_RESULT`));
    assert.match(response.headers["content-security-policy"], /default-src 'none'/);
    assert.doesNotMatch(response.headers["content-security-policy"], /unsafe-inline|https:|data:/);
  }
  assert.equal(server.service.calls.length, 0);
});
for (const authorization of [undefined, "Bearer invalid", `bearer ${"a".repeat(64)}`, `Bearer ${"a".repeat(64)} `, `Basic ${"a".repeat(64)}`]) {
  test("API reads require the exact bearer header", async (t) => {
    const server = await environment(t); const headers = authorization === undefined ? {} : { Authorization: authorization };
    const response = await request(server, "/api/status", { authorized: false, headers });
    assert.equal(response.status, 403); assert.equal(JSON.parse(response.text).code, "AUTH_REQUIRED"); assert.equal(server.service.calls.length, 0);
  });
}
test("authorized reads route strict pagination and delivery IDs", async (t) => {
  const server = await environment(t); assert.equal((await request(server)).status, 200);
  assert.equal((await request(server, "/api/watches?after=2&limit=3")).status, 200);
  const watch = "8713bba6-e91e-4c1a-b756-2b18d2b7c775";
  assert.equal((await request(server, `/api/inbox?watch_id=${watch}&after=1&limit=2`)).status, 200);
  assert.equal((await request(server, "/api/notices?limit=5")).status, 200);
  const delivery = await request(server, `/api/deliveries/${syntheticDelivery}`); assert.equal(delivery.status, 200);
  assert.deepEqual(server.service.calls[1], ["watches", { after: 2, limit: 3 }]);
  assert.deepEqual(server.service.calls[2], ["inbox", { watch_id: watch, after: 1, limit: 2 }]);
  assert.equal((await request(server, `/api/reviews?delivery_id=${syntheticDelivery}&after=1&limit=3`)).status, 200);
  assert.equal((await request(server, `/api/legacy?watch_id=${watch}&limit=2`)).status, 200);
  assert.equal((await request(server, `/api/legacy/results/${watch}`)).status, 200);
});
for (const headers of [{ Host: "localhost:1234" }, { Host: "evil.example" }, { Origin: "https://evil.example" },
  { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { "X-Forwarded-For": "127.0.0.1" }, { Forwarded: "host=127.0.0.1" }]) {
  test("foreign hosts, origins, fetch sites, and proxy headers are denied", async (t) => {
    const server = await environment(t); const response = await request(server, "/api/status", { headers });
    assert.equal(response.status, 403); assert.equal(server.service.calls.length, 0);
  });
}
for (const header of ["Host", "Authorization", "Origin", "Content-Type", "X-EquityLayer-Request", "Sec-Fetch-Site"]) {
  test(`duplicate sensitive ${header} raw headers are denied`, async (t) => {
    const server = await environment(t); const values = { Host: new URL(server.origin).host, Authorization: `Bearer ${server.token}`,
      Origin: server.origin, "Content-Type": "application/json", "X-EquityLayer-Request": "1", "Sec-Fetch-Site": "same-origin" };
    const duplicate = `${header}: ${values[header]}\r\n${header}: ${values[header]}\r\n`;
    const response = await raw(server, rawHead(server, duplicate) + "\r\n");
    assert.match(response, /HTTP\/1\.1 (?:400|403)/); assert.match(response, /DUPLICATE_HEADERS_DENIED|HTTP_REQUEST_INVALID/);
    assert.equal(server.service.calls.length, 0); assert.doesNotMatch(response, new RegExp(server.token));
  });
}
for (const path of ["http://evil.example/api/status", "/api/../status", "/api/%2e%2e/status", "/api/deliveries/a%2Fb", "/api\\status",
  "/api/status?token=SECRET_TOKEN", "/api/status?path=/secret", "/api/watches?limit=101", "/api/watches?limit=1&limit=2",
  "/api/watches?after=-1", "/api/watches?after=9007199254740992", "/api/inbox?watch_id=arbitrary", "/api/notices?limit=01"]) {
  test("query and path injection is denied", async (t) => {
    const server = await environment(t); const response = await request(server, path);
    assert.equal(response.status, 400); assert.equal(server.service.calls.length, 0); assert.doesNotMatch(response.text, /SECRET_TOKEN|secret|evil.example/);
  });
}
test("unknown routes and unsupported methods expose no tool or filesystem access", async (t) => {
  const server = await environment(t);
  for (const path of ["/api/execute", "/api/pay", "/api/trade", "/api/source-policy", "/api/files", "/missing"]) assert.equal((await request(server, path)).status, 404);
  assert.equal((await request(server, "/api/status", { method: "DELETE" })).status, 405); assert.equal(server.service.calls.length, 0);
});
test("authenticated session options carry exact update references without a write", async t => {
  const server = await environment(t), watch = "8713bba6-e91e-4c1a-b756-2b18d2b7c775", method = "f".repeat(64);
  const path = `/api/session-options?watch_id=${watch}&source_event_id=event-77&method_sha256=${method}&limit=1`;
  assert.equal((await request(server, path, { authorized: false })).status, 403); assert.equal(server.service.calls.length, 0);
  assert.equal((await request(server, path)).status, 200);
  assert.deepEqual(server.service.calls, [["sessionOptions", { watch_id: watch, source_event_id: "event-77", method_sha256: method, limit: 1 }]]);
  assert.equal(server.service.watchesSaved.length, 0); assert.equal(server.service.reviewsSaved.length, 0);
  assert.equal((await request(server, path + "&source_event_id=other")).status, 400);
  assert.equal(server.service.calls.length, 1);
});
test("update-reference queries decode a bounded printable source ID without changing path validation", async t => {
  const server = await environment(t), watch = "8713bba6-e91e-4c1a-b756-2b18d2b7c775", method = "f".repeat(64);
  const id = "來源:77 / ? & + % literal", query = new URLSearchParams({ watch_id: watch, source_event_id: id, method_sha256: method });
  assert.equal((await request(server, `/api/session-options?${query}`)).status, 200);
  assert.equal(server.service.calls[0][1].source_event_id, id);
  assert.equal((await request(server, `/api/%73ession-options?${query}`)).status, 400);
  assert.equal(server.service.calls.length, 1);
});
for (const source of ["%ZZ", "%E0%A4", "%0A", "%00", "", "x".repeat(501)]) {
  test(`update-reference queries reject malformed or unbounded values ${source.slice(0, 12)}`, async t => {
    const server = await environment(t), path = `/api/session-options?watch_id=8713bba6-e91e-4c1a-b756-2b18d2b7c775&source_event_id=${source}&method_sha256=${"f".repeat(64)}`;
    assert.equal((await request(server, path)).status, 400); assert.equal(server.service.calls.length, 0);
  });
}
for (const omitted of ["Origin", "Content-Type", "X-EquityLayer-Request"]) test(`writes require ${omitted}`, async (t) => {
  const server = await environment(t); const headers = writeHeaders(server); delete headers[omitted];
  const response = await request(server, "/api/watches", { method: "POST", headers, body: "{}" });
  assert.notEqual(response.status, 200); assert.equal(server.service.calls.length, 0);
});
test("form content types cannot write", async (t) => {
  const server = await environment(t);
  for (const type of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data"]) {
    assert.equal((await request(server, "/api/watches", { method: "POST", headers: { ...writeHeaders(server), "Content-Type": type }, body: "{}" })).status, 400);
  }
  assert.equal(server.service.calls.length, 0);
});
test("authorized writes retain watch, review, acknowledgement, and import input", async (t) => {
  const server = await environment(t);
  const cases = [["/api/watches", { scope: { watch_id: "synthetic" }, private_context: { question: "SECRET_PRIVATE_QUESTION" } }, "watchesSaved"],
    ["/api/reviews", { delivery_id: "synthetic", action: "received", note: "Synthetic note.", review_id: "review", expected_revision: 0 }, "reviewsSaved"],
    ["/api/notices/acknowledge", { notice_id: "synthetic-notice" }, "acknowledgements"], ["/api/legacy/import", { archive_base64: "e30=" }, "imports"]];
  for (const [path, input, field] of cases) {
    const response = await request(server, path, { method: "POST", headers: writeHeaders(server), body: JSON.stringify(input) });
    assert.equal(response.status, 200); assert.deepEqual(server.service[field][0], input);
    assert.doesNotMatch(response.text + JSON.stringify(response.headers), /SECRET_PRIVATE_QUESTION/);
  }
  const response = await request(server, "/api/watches"); assert.match(response.text, /SECRET_PRIVATE_QUESTION/);
});
test("body limits stop declared and chunked flooding without service writes", async (t) => {
  const server = await environment(t);
  const write = `Origin: ${server.origin}\r\nContent-Type: application/json\r\nX-EquityLayer-Request: 1\r\n`;
  const declared = await raw(server, rawHead(server, write + "Content-Length: 3000001\r\n", "/api/watches", "POST") + "\r\n");
  assert.match(declared, /413/); assert.match(declared, /BODY_LIMIT/);
  const bytes = "x".repeat(3_000_001);
  const chunked = await raw(server, rawHead(server, write + "Transfer-Encoding: chunked\r\n", "/api/watches", "POST") + `\r\n${bytes.length.toString(16)}\r\n${bytes}\r\n0\r\n\r\n`);
  assert.match(chunked, /413/); assert.match(chunked, /BODY_LIMIT/); assert.equal(server.service.calls.length, 0);
});
test("a total body deadline stops incomplete requests", async (t) => {
  const server = await environment(t);
  const write = `Origin: ${server.origin}\r\nContent-Type: application/json\r\nX-EquityLayer-Request: 1\r\nContent-Length: 100\r\n`;
  const response = await raw(server, rawHead(server, write, "/api/watches", "POST") + "\r\n{");
  assert.match(response, /408/); assert.match(response, /BODY_TIMEOUT/); assert.equal(server.service.calls.length, 0);
});
for (const body of ["not JSON SECRET_BODY", "[]", "null", "42"]) test("invalid bodies return code-only errors", async (t) => {
  const server = await environment(t); const response = await request(server, "/api/watches", { method: "POST", headers: writeHeaders(server), body });
  assert.equal(response.status, 400); assert.equal(response.text, '{"code":"BODY_JSON_INVALID"}'); assert.doesNotMatch(response.text, /SECRET_BODY/);
});
test("service exceptions and response bounds do not expose arbitrary secrets", async (t) => {
  const service = stub(); service.status = () => { throw new Error("SECRET_STACK_PATH /private/path"); };
  const server = await environment(t, service); const error = await request(server);
  assert.equal(error.text, '{"code":"WORKSPACE_OPERATION_FAILED"}'); assert.doesNotMatch(JSON.stringify(error.headers), /SECRET_STACK_PATH/);
  service.status = () => ({ secret: "SECRET_RESPONSE".repeat(300_000) });
  assert.equal((await request(server)).text, '{"code":"RESPONSE_LIMIT"}');
  service.review = () => { throw Object.assign(new Error("SECRET_NOTE"), { code: "REVIEW_CONFLICT" }); };
  assert.equal((await request(server, "/api/reviews", { method: "POST", headers: writeHeaders(server), body: "{}" })).status, 409);
});
test("closing the HTTP server leaves caller-owned service state available", async (t) => {
  const server = await environment(t); await server.close(); await server.close(); assert.equal(server.service.closed, undefined);
  assert.deepEqual(server.service.status(), { status: "local", counts: { watches: 0 } });
});

test("authorized SQLite watch and review changes persist after HTTP and ledger reopen", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "el-workspace-server-test-"));
  const clock = () => Date.parse("2026-10-12T00:00:00Z");
  const ledger = new ResearchLedger(directory, { clock });
  const envelope = setup(ledger); ledger.enqueue(envelope, "test-window", policy());
  const delivered = ledger.finish(ledger.claim("synthetic-http-fixture"), result(envelope));
  const server = await environment(t, new WorkspaceService(ledger));
  const inbox = await request(server, "/api/inbox?limit=2");
  assert.equal(JSON.parse(inbox.text).items[0].delivery_id, delivered.delivery_id);
  const review = { delivery_id: delivered.delivery_id, action: "received", note: "Synthetic review note.", review_id: "synthetic-http-review", expected_revision: 0 };
  const reviewed = await request(server, "/api/reviews", { method: "POST", headers: writeHeaders(server), body: JSON.stringify(review) });
  assert.equal(reviewed.status, 200); assert.equal(JSON.parse(reviewed.text).delivery.review_revision, 1);
  assert.equal(JSON.parse((await request(server, "/api/notices")).text).items.length, 0);
  const ack = await request(server, "/api/notices/acknowledge", { method: "POST", headers: writeHeaders(server), body: JSON.stringify({ notice_id: delivered.delivery_id }) });
  assert.equal(ack.status, 200); assert.equal(JSON.parse(ack.text).accepted_evidence, false);
  const save = { scope: scope(2), private_context: { question: "SECRET_NEW_LOCAL_QUESTION", trigger: "Synthetic local change." } };
  const saved = await request(server, "/api/watches", { method: "POST", headers: writeHeaders(server), body: JSON.stringify(save) });
  assert.equal(saved.status, 200); assert.equal(JSON.parse(saved.text).execution_authorized, false);
  const stale = await request(server, "/api/reviews", { method: "POST", headers: writeHeaders(server),
    body: JSON.stringify({ ...review, action: "accept_evidence", review_id: "synthetic-stale-http-review", expected_revision: 1 }) });
  assert.equal(stale.status, 422); assert.equal(JSON.parse(stale.text).code, "ACCEPTANCE_GATED");
  const conflict = await request(server, "/api/reviews", { method: "POST", headers: writeHeaders(server),
    body: JSON.stringify({ ...review, review_id: "synthetic-conflicting-review", expected_revision: 0 }) });
  assert.equal(conflict.status, 409); assert.equal(JSON.parse(conflict.text).code, "REVIEW_CONFLICT");
  await server.close(); assert.equal(ledger.watch(scope().watch_id).current_revision, 2); ledger.close();
  const reopened = new ResearchLedger(directory, { clock });
  const second = await environment(t, new WorkspaceService(reopened));
  t.after(async () => { await second.close(); reopened.close(); });
  const watches = JSON.parse((await request(second, "/api/watches")).text).items;
  assert.equal(watches[0].private_context.question, "SECRET_NEW_LOCAL_QUESTION"); assert.equal(watches[0].review_revision, 1);
  const delivery = JSON.parse((await request(second, `/api/deliveries/${delivered.delivery_id}`)).text);
  assert.equal(delivery.is_current_revision, false); assert.equal(delivery.reviews[0].review_id, "synthetic-http-review");
  assert.equal(delivery.accepted_evidence, false); assert.equal(delivery.accepted_interpretation, false);
  assert.equal((await request(second, "/api/deliveries/missing")).status, 404);
  const invalid = await request(second, "/api/watches", { method: "POST", headers: writeHeaders(second), body: JSON.stringify({ arbitrary_tool: "SECRET_BAD_INPUT" }) });
  assert.equal(invalid.status, 422); assert.equal(invalid.text, '{"code":"WORKSPACE_INPUT_INVALID"}');
  const reviewPage = JSON.parse((await request(second, `/api/reviews?delivery_id=${delivered.delivery_id}&limit=10`)).text);
  assert.equal(reviewPage.items[0].review_id, "synthetic-http-review");
  const legacyScope = { ...scope(), watch_id: "77777777-7777-4777-8777-777777777777" };
  const legacyResult = { ...result({ scope: legacyScope }), result_id: "22222222-2222-4222-8222-222222222222" };
  const archive = { schema_version: 1, watches: [{ scope: { ...legacyScope, question: "LEGACY_PRIVATE_QUESTION", trigger: "Synthetic import." },
    saved_at: "2026-10-11T00:00:00Z", results: [legacyResult], reviews: [] }] };
  const imported = await request(second, "/api/legacy/import", { method: "POST", headers: writeHeaders(second),
    body: JSON.stringify({ archive_base64: Buffer.from(JSON.stringify(archive)).toString("base64") }) });
  assert.equal(imported.status, 200);
  const legacy = JSON.parse((await request(second, `/api/legacy?watch_id=${legacyScope.watch_id}&limit=10`)).text);
  assert.equal(legacy.items[0].result_id, legacyResult.result_id);
  const legacyDetail = JSON.parse((await request(second, `/api/legacy/results/${legacyResult.result_id}`)).text);
  assert.equal(legacyDetail.result.result_id, legacyResult.result_id);
  for (const path of ["/api/watches", "/api/inbox", "/api/notices", `/api/deliveries/${delivered.delivery_id}`,
    `/api/reviews?delivery_id=${delivered.delivery_id}`, `/api/legacy?watch_id=${legacyScope.watch_id}`, `/api/legacy/results/${legacyResult.result_id}`]) {
    const unauthorized = await request(second, path, { authorized: false }); assert.equal(unauthorized.status, 403);
    assert.doesNotMatch(unauthorized.text + JSON.stringify(unauthorized.headers), /SECRET_NEW_LOCAL_QUESTION|LEGACY_PRIVATE_QUESTION|Synthetic review note/);
  }
});

for (const path of ["/api/reviews", "/api/reviews?delivery_id=arbitrary", `/api/reviews?delivery_id=${syntheticDelivery}&delivery_id=${syntheticDelivery}`,
  "/api/legacy", "/api/legacy?watch_id=arbitrary", "/api/reviews?watch_id=77777777-7777-4777-8777-777777777777"]) {
  test("review and legacy queries require their exact resource IDs", async (t) => {
    const server = await environment(t); assert.equal((await request(server, path)).status, 400); assert.equal(server.service.calls.length, 0);
  });
}
