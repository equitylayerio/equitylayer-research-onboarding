import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WorkspaceServiceError } from "./workspace-service.mjs";

const MAX_BODY = 3_000_000;
const MAX_RESPONSE = 3_000_000;
const READ_TIMEOUT_MS = 1000;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const HEADERS = { "Cache-Control": "no-store", "Content-Security-Policy": CSP,
  "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Connection": "close" };
const SENSITIVE = new Set(["host", "authorization", "origin", "content-type", "content-length", "transfer-encoding",
  "x-equitylayer-request", "sec-fetch-site"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DELIVERY_ID = /^el-delivery-[a-f0-9]{64}$/;
const EXTERNAL_ID = /^el-external-[a-f0-9]{64}$/;
const PROPOSAL_HASH = /^[a-f0-9]{64}$/;

export class WorkspaceServerError extends Error {
  constructor(code) { super(code); this.name = "WorkspaceServerError"; this.code = code; }
}
const fail = (code) => { throw new WorkspaceServerError(code); };
function send(response, status, value, type = "application/json; charset=utf-8") {
  if (response.destroyed || response.writableEnded) return;
  let body;
  try { body = type.startsWith("application/json") ? Buffer.from(JSON.stringify(value)) : Buffer.from(value); }
  catch { status = 500; body = Buffer.from('{"code":"RESPONSE_INVALID"}'); type = "application/json; charset=utf-8"; }
  if (body.length > MAX_RESPONSE) { status = 500; body = Buffer.from('{"code":"RESPONSE_LIMIT"}'); type = "application/json; charset=utf-8"; }
  response.writeHead(status, { ...HEADERS, "Content-Type": type, "Content-Length": body.length });
  response.end(body);
}
const deny = (response, code, status = 400) => send(response, status, { code });
function inspectHeaders(request, expectedHost, origin) {
  if (request.socket.remoteAddress !== "127.0.0.1") fail("LOOPBACK_REQUIRED");
  const counts = new Map();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const key = request.rawHeaders[index].toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (/^(?:forwarded$|x-forwarded-|x-real-ip$|via$|proxy-)/.test(key)) fail("PROXY_HEADERS_DENIED");
    if (SENSITIVE.has(key) && counts.get(key) > 1) fail("DUPLICATE_HEADERS_DENIED");
  }
  if (request.headers.host !== expectedHost) fail("HOST_DENIED");
  if (request.headers.origin !== undefined && request.headers.origin !== origin) fail("ORIGIN_DENIED");
  if (request.headers["sec-fetch-site"] !== undefined && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])) fail("FETCH_SITE_DENIED");
}
function target(request) {
  const raw = request.url;
  if (typeof raw !== "string" || raw.length > 8192 || !raw.startsWith("/") || raw.startsWith("//") ||
      /[\\#\u0000-\u0020\u007f]/u.test(raw)) fail("REQUEST_TARGET_INVALID");
  const path = raw.split("?", 1)[0];
  if (path.includes("%") || path.includes("//") || path.split("/").some((part) => part === "." || part === "..")) fail("REQUEST_TARGET_INVALID");
  return new URL(raw, "http://127.0.0.1");
}
function query(url, allowed) {
  const output = {};
  try { decodeURIComponent(url.search.slice(1)); } catch { fail("QUERY_INVALID"); }
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail("QUERY_INVALID");
    const value = url.searchParams.get(key);
    if (key === "watch_id") { if (!UUID.test(value)) fail("QUERY_INVALID"); output[key] = value; }
    else if (key === "order") { if (!["oldest", "newest"].includes(value)) fail("QUERY_INVALID"); output[key] = value; }
    else if (key === "delivery_id") { if (!DELIVERY_ID.test(value)) fail("QUERY_INVALID"); output[key] = value; }
    else if (key === "external_record_id") { if (!EXTERNAL_ID.test(value)) fail("QUERY_INVALID"); output[key] = value; }
    else if (key === "proposal_sha256") { if (!PROPOSAL_HASH.test(value)) fail("QUERY_INVALID"); output[key] = value; }
    else if (key === "method_sha256") { if (!PROPOSAL_HASH.test(value)) fail("QUERY_INVALID"); output[key] = value; }
    else if (key === "source_event_id") {
      if (!value || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) fail("QUERY_INVALID");
      output[key] = value;
    }
    else {
      if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail("QUERY_INVALID");
      const number = Number(value);
      if (!Number.isSafeInteger(number) || key === "limit" && (number < 1 || number > 100)) fail("QUERY_INVALID");
      output[key] = number;
    }
  }
  return output;
}
function readBody(request) {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY)) fail("BODY_LIMIT");
  return new Promise((resolve, reject) => {
    let length = 0, done = false; const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); chunks.length = 0;
      request.removeListener("data", data); request.removeListener("end", end); request.removeListener("error", aborted); request.removeListener("aborted", aborted);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new WorkspaceServerError("BODY_TIMEOUT")), READ_TIMEOUT_MS);
    const data = (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY) finish(new WorkspaceServerError("BODY_LIMIT")); else chunks.push(chunk);
    };
    const end = () => {
      let value;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { finish(new WorkspaceServerError("BODY_JSON_INVALID")); return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { finish(new WorkspaceServerError("BODY_JSON_INVALID")); return; }
      finish(null, value);
    };
    const aborted = () => finish(new WorkspaceServerError("BODY_ABORTED"));
    request.on("data", data); request.on("end", end); request.on("error", aborted); request.on("aborted", aborted);
  });
}
const SAFE_SERVICE_CODES = new Set(["INVALID_INPUT", "INPUT_SCHEMA_INVALID", "WATCH_INVALID", "WATCH_MISSING", "DELIVERY_MISSING",
  "RESULT_INVALID", "RESULT_SCOPE_CONFLICT", "REVIEW_CONFLICT", "ACCEPTANCE_GATED", "NOTICE_MISSING", "LEGACY_INVALID",
  "INVALID_LEGACY_WORKSPACE", "LEGACY_IMPORT_CONFLICT", "REVISION_CONFLICT", "STORAGE_BUSY", "STORAGE_CORRUPT",
  "UNSAFE_STORAGE_PATH", "STORAGE_WRITE_UNCERTAIN", "INVALID_RUN_CONTRACT", "LEGACY_WORKSPACE_INVALID",
  "THESIS_INPUT_INVALID", "THESIS_REFERENCE_MISSING", "THESIS_REVIEW_CONFLICT", "THESIS_ACCEPTANCE_GATED", "THESIS_STORAGE_CORRUPT",
  "THESIS_REVISION_CONFLICT", "THESIS_HUMAN_REVIEW_REQUIRED"]);
SAFE_SERVICE_CODES.add("SCHEDULE_CONFLICT"); SAFE_SERVICE_CODES.add("SCHEDULE_MISSING");
for (const code of ["EXTERNAL_RECORD_MISSING", "EXTERNAL_HUMAN_REVIEW_REQUIRED", "EXTERNAL_REVIEW_INPUT_INVALID", "EXTERNAL_REVIEW_TIME_INVALID",
  "EXTERNAL_SESSION_STORAGE_INVALID", "EXTERNAL_SESSION_SCOPE_CHANGED", "SOURCE_RIGHTS_GATED", "SOURCE_POLICY_MISSING", "SOURCE_POLICY_CHANGED",
  "SOURCE_SCHEMA_CHANGED", "SOURCE_SCOPE_CONFLICT", "SOURCE_TIME_INVALID", "STALE_SOURCE", "METHOD_CURATION_REQUIRED", "CORRECTION_REVIEW_REQUIRED", "EXTERNAL_SESSION_AUTHORITY_CHANGED",
  "EVIDENCE_STATE_REVIEW_REQUIRED", "SOURCE_NEEDED"])
  SAFE_SERVICE_CODES.add(code);
for (const code of ["SESSION_CONNECTION_INVALID", "PRIVATE_CONTEXT_CONSENT_REQUIRED", "METHOD_CONSENT_REQUIRED", "EXTERNAL_SESSION_INPUT_INVALID",
  "EXTERNAL_SESSION_PREPARATION_INVALID", "EXTERNAL_SESSION_PREPARATION_CONFLICT", "EXTERNAL_SESSION_REFERENCE_MISSING", "EXTERNAL_SESSION_CONTEXT_INVALID",
  "EXTERNAL_SESSION_TIME_INVALID", "EXTERNAL_SESSION_INPUT_LIMIT"]) SAFE_SERVICE_CODES.add(code);

// The caller owns the service and ledger. Closing the server does not close either object.
export async function startWorkspaceServer(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some((key) => !["service", "port", "assets", "token"].includes(key))) fail("SERVER_CONFIG_INVALID");
  const { service, port = 0, assets, token = randomBytes(32).toString("hex") } = config;
  const required = ["status", "watches", "inbox", "delivery", "notices", "reviews", "legacy", "legacyResult", "saveWatch", "review", "acknowledge", "importLegacy",
    "theses", "thesisDetail", "thesisSources", "thesisReviews", "reviewThesis", "externalResearch", "externalRecord", "externalReviews", "reviewExternal", "sessionOptions", "prepareSession"];
  if (!service || required.some((name) => typeof service[name] !== "function") || !Number.isInteger(port) || port < 0 || port > 65535 ||
      typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !assets ||
      ["html", "js", "css"].some((key) => typeof assets[key] !== "string" && !Buffer.isBuffer(assets[key])) ||
      assets.font !== undefined && !Buffer.isBuffer(assets.font)) fail("SERVER_CONFIG_INVALID");
  const staticAssets = new Map([["/", [Buffer.from(assets.html), "text/html; charset=utf-8"]],
    ["/workspace.js", [Buffer.from(assets.js), "text/javascript; charset=utf-8"]], ["/workspace.css", [Buffer.from(assets.css), "text/css; charset=utf-8"]]]);
  if (assets.font) staticAssets.set("/inter.woff2", [Buffer.from(assets.font), "font/woff2"]);
  if ([...staticAssets.values()].some(([bytes]) => bytes.length > MAX_RESPONSE)) fail("SERVER_CONFIG_INVALID");
  const expectedToken = Buffer.from(token); let origin, expectedHost;
  const server = createServer({ maxHeaderSize: 16_384, headersTimeout: 1000, requestTimeout: 2000, connectionsCheckingInterval: 250 }, async (request, response) => {
    request.on("error", () => {});
    try {
      inspectHeaders(request, expectedHost, origin);
      const url = target(request); const path = url.pathname;
      if (request.method === "GET" && staticAssets.has(path)) {
        query(url, []);
        if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) fail("BODY_DENIED");
        const [bytes, type] = staticAssets.get(path); send(response, 200, bytes, type); return;
      }
      if (!path.startsWith("/api/")) { deny(response, "ROUTE_NOT_FOUND", 404); return; }
      const authorization = request.headers.authorization;
      const supplied = typeof authorization === "string" && /^Bearer [a-f0-9]{64}$/.test(authorization) ? Buffer.from(authorization.slice(7)) : Buffer.alloc(64);
      if (!timingSafeEqual(supplied, expectedToken)) { deny(response, "AUTH_REQUIRED", 403); return; }
      let output;
      if (request.method === "GET") {
        if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) fail("BODY_DENIED");
        if (path === "/api/status") { query(url, []); output = await service.status(); }
        else if (path === "/api/watches") output = await service.watches(query(url, ["after", "limit"]));
        else if (path === "/api/session-options") {
          const params = query(url, ["watch_id", "methods_after", "sources_after", "preparations_after", "limit", "source_event_id", "method_sha256"]);
          if (!params.watch_id) fail("QUERY_INVALID");
          output = await service.sessionOptions(params);
        }
        else if (path === "/api/schedules") output = await service.schedules(query(url, ["after", "limit", "watch_id"]));
        else if (path === "/api/theses") output = await service.theses(query(url, ["after", "limit", "watch_id", "order"]));
        else if (path.startsWith("/api/theses/") && PROPOSAL_HASH.test(path.slice("/api/theses/".length))) { query(url, []); output = await service.thesisDetail(path.slice("/api/theses/".length)); }
        else if (["/api/thesis-sources", "/api/thesis-reviews"].includes(path)) {
          const params = query(url, ["after", "limit", "proposal_sha256"]);
          if (!params.proposal_sha256) fail("QUERY_INVALID");
          output = await service[path === "/api/thesis-sources" ? "thesisSources" : "thesisReviews"](params);
        }
        else if (path === "/api/inbox") output = await service.inbox(query(url, ["after", "limit", "watch_id", "order"]));
        else if (path === "/api/external-research") output = await service.externalResearch(query(url, ["after", "limit", "watch_id", "order"]));
        else if (path.startsWith("/api/external-research/") && EXTERNAL_ID.test(path.slice("/api/external-research/".length))) {
          query(url, []); output = await service.externalRecord(path.slice("/api/external-research/".length));
        }
        else if (path === "/api/external-reviews") {
          const params = query(url, ["after", "limit", "external_record_id"]);
          if (!params.external_record_id) fail("QUERY_INVALID");
          output = await service.externalReviews(params);
        }
        else if (path === "/api/notices") output = await service.notices(query(url, ["after", "limit"]));
        else if (path === "/api/reviews") {
          const params = query(url, ["after", "limit", "delivery_id"]);
          if (!params.delivery_id) fail("QUERY_INVALID");
          output = await service.reviews(params);
        }
        else if (path === "/api/legacy") {
          const params = query(url, ["after", "limit", "watch_id"]);
          if (!params.watch_id) fail("QUERY_INVALID");
          output = await service.legacy(params);
        }
        else if (path.startsWith("/api/deliveries/") && DELIVERY_ID.test(path.slice("/api/deliveries/".length))) { query(url, []); output = await service.delivery(path.slice("/api/deliveries/".length)); }
        else if (path.startsWith("/api/legacy/results/") && UUID.test(path.slice("/api/legacy/results/".length))) { query(url, []); output = await service.legacyResult(path.slice("/api/legacy/results/".length)); }
        else { deny(response, "ROUTE_NOT_FOUND", 404); return; }
      } else if (request.method === "POST") {
        query(url, []);
        const writes = { "/api/watches": "saveWatch", "/api/session-prepare": "prepareSession", "/api/reviews": "review", "/api/external-reviews": "reviewExternal", "/api/thesis-reviews": "reviewThesis", "/api/notices/acknowledge": "acknowledge", "/api/legacy/import": "importLegacy", "/api/schedules/stop": "stopSchedule",
          "/api/schedules/observation-plan": "observationPlan" };
        if (!Object.hasOwn(writes, path)) { deny(response, "ROUTE_NOT_FOUND", 404); return; }
        if (request.headers.origin !== origin) fail("WRITE_ORIGIN_REQUIRED");
        if (request.headers["content-type"] !== "application/json") fail("JSON_CONTENT_TYPE_REQUIRED");
        if (request.headers["x-equitylayer-request"] !== "1") fail("WRITE_HEADER_REQUIRED");
        output = await service[writes[path]](await readBody(request));
      } else { deny(response, "METHOD_DENIED", 405); return; }
      send(response, 200, output);
    } catch (error) {
      const code = error instanceof WorkspaceServerError || error instanceof WorkspaceServiceError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code : SAFE_SERVICE_CODES.has(error?.code) ? error.code : "WORKSPACE_OPERATION_FAILED";
      const securityCode = ["LOOPBACK_REQUIRED", "PROXY_HEADERS_DENIED", "DUPLICATE_HEADERS_DENIED", "HOST_DENIED", "ORIGIN_DENIED", "FETCH_SITE_DENIED", "WRITE_ORIGIN_REQUIRED", "WRITE_HEADER_REQUIRED"].includes(code);
      deny(response, code, ["WORKSPACE_NOT_FOUND", "DELIVERY_MISSING", "NOTICE_MISSING", "THESIS_REFERENCE_MISSING", "SCHEDULE_MISSING"].includes(code) ? 404 : ["REVIEW_CONFLICT", "THESIS_REVIEW_CONFLICT", "SCHEDULE_CONFLICT", "EXTERNAL_SESSION_PREPARATION_CONFLICT"].includes(code) ? 409 : error instanceof WorkspaceServerError
        ? code === "BODY_TIMEOUT" ? 408 : code === "BODY_LIMIT" ? 413 : securityCode ? 403 : 400 : code === "WORKSPACE_OPERATION_FAILED" ? 500 : 422);
    }
  });
  server.maxConnections = 32;
  server.on("clientError", (_error, socket) => {
    if (!socket.writable || socket.destroyed) return;
    const body = '{"code":"HTTP_REQUEST_INVALID"}';
    socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: ${CSP}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  await new Promise((resolve, reject) => {
    const failed = () => reject(new WorkspaceServerError("SERVER_START_FAILED"));
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", failed); resolve(); });
  });
  expectedHost = `127.0.0.1:${server.address().port}`; origin = `http://${expectedHost}`;
  let closing;
  return Object.freeze({ origin, url: `${origin}/`, bootstrap_url: `${origin}/#token=${token}`, token,
    close: () => {
      if (!closing) closing = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(new WorkspaceServerError("SERVER_CLOSE_FAILED")) : resolve());
        server.closeAllConnections();
      });
      return closing;
    } });
}
