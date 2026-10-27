import test from "node:test";
import assert from "node:assert/strict";
import { sessionToolDiagnostic } from "./helpers/session-tool-diagnostic.mjs";

const event = (result, extra = {}) => ({ type: "item.completed", item: {
  type: "mcp_tool_call", server: "research", tool: "submit_research", status: "failed", result, ...extra } });

test("diagnostics retain a fixed rejection code and the CLI snake-case error flag", () => {
  const value = sessionToolDiagnostic(event({ is_error: true, content: [
    { type: "text", text: JSON.stringify({ code: "RESEARCH_ADVICE_BLOCKED" }) }] }));
  assert.equal(value.reported_tool_error, true);
  assert.equal(value.reported_rejection_code, "RESEARCH_ADVICE_BLOCKED");
});

test("the observed CLI shape can omit the error flag and retain the code in content", () => {
  const value = sessionToolDiagnostic(event({ structured_content: null, content: [
    { type: "text", text: '{"code":"EXTERNAL_SESSION_SOURCE_DATE_INVALID"}' }] }));
  assert.equal(value.reported_tool_error, null);
  assert.equal(value.reported_rejection_code, "EXTERNAL_SESSION_SOURCE_DATE_INVALID");
  assert.equal(value.status, "failed");
});

test("matching code copies do not create a conflict or retain other structured fields", () => {
  const value = sessionToolDiagnostic(event({ isError: true, structured_content: { code: "RESULT_INVALID", source: "PRIVATE" },
    content: [{ type: "text", text: '{"code":"RESULT_INVALID","detail":"PRIVATE"}' }] }));
  assert.equal(value.reported_rejection_code, "RESULT_INVALID");
  assert.equal(value.diagnostic_conflict, false);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
});

test("a protocol message without a structured numeric code remains unclassified", () => {
  const value = sessionToolDiagnostic(event(null, { error: { message: "PRIVATE message contains -32602 and RESULT_INVALID" } }));
  assert.equal(value.protocol_error_code, null);
  assert.equal(value.reported_rejection_code, null);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
});

test("diagnostics retain structured errors without private message or submission content", () => {
  const value = sessionToolDiagnostic(event({ isError: true,
    structuredContent: { code: "EXTERNAL_SESSION_SOURCE_DATE_INVALID", message: "PRIVATE SOURCE TEXT" },
    content: [{ type: "text", text: "PRIVATE RESEARCH BODY" }] }, { arguments: { summary: "PRIVATE SUBMISSION" } }));
  assert.equal(value.reported_rejection_code, "EXTERNAL_SESSION_SOURCE_DATE_INVALID");
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|message|arguments|content|summary/);
});

test("failed status without a retained code remains an unknown cause", () => {
  const value = sessionToolDiagnostic(event({ content: [{ type: "text", text: "PRIVATE ERROR TEXT" }] }));
  assert.equal(value.status, "failed");
  assert.equal(value.reported_rejection_code, null);
  assert.equal(value.reported_tool_error, null);
  assert.equal(value.diagnostic_conflict, false);
});

test("conflicting error flags or rejection codes cannot select a preferred explanation", () => {
  const flags = sessionToolDiagnostic(event({ isError: false, is_error: true,
    structuredContent: { code: "RESULT_INVALID" } }));
  assert.equal(flags.reported_tool_error, null);
  assert.equal(flags.reported_rejection_code, null);
  assert.equal(flags.diagnostic_conflict, true);
  const codes = sessionToolDiagnostic(event({ isError: true, structuredContent: { code: "RESULT_INVALID" },
    content: [{ type: "text", text: '{"code":"SOURCE_RIGHTS_GATED"}' }] }));
  assert.equal(codes.reported_rejection_code, null);
  assert.equal(codes.diagnostic_conflict, true);
});

test("only explicit protocol codes are retained and arbitrary uppercase values remain private", () => {
  const protocol = sessionToolDiagnostic(event(null, { error: { code: -32602, message: "PRIVATE PROTOCOL ERROR" } }));
  assert.equal(protocol.protocol_error_code, -32602);
  assert.doesNotMatch(JSON.stringify(protocol), /PRIVATE/);
  const unknown = sessionToolDiagnostic(event({ isError: true, structuredContent: { code: "PRIVATE_ACCOUNT_IDENTIFIER" } }));
  assert.equal(unknown.reported_rejection_code, null);
  assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE_ACCOUNT_IDENTIFIER/);
});

test("successful source text cannot inject a rejection code into diagnostics", () => {
  const value = sessionToolDiagnostic(event({ isError: false, structuredContent: { code: "SOURCE_RIGHTS_GATED" },
    content: [{ type: "text", text: '{"code":"RESEARCH_ADVICE_BLOCKED"}' }] }, { status: "completed" }));
  assert.equal(value.reported_tool_error, false);
  assert.equal(value.reported_rejection_code, null);
  assert.equal(value.protocol_error_code, null);
});

test("oversized and malformed text is not parsed or retained", () => {
  for (const text of ['{"code":', '"code":"RESULT_INVALID"', ' '.repeat(16385) + '{"code":"RESULT_INVALID"}']) {
    const value = sessionToolDiagnostic(event({ isError: true, content: [{ type: "text", text }] }));
    assert.equal(value.reported_rejection_code, null);
    assert.ok(JSON.stringify(value).length < 350);
  }
});

test("diagnostics exclude other servers, tools, event types, and invalid terminal states", () => {
  for (const extra of [{ server: "foreign" }, { tool: "exec_command" }, { type: "agent_message" }, { status: "in_progress" }])
    assert.equal(sessionToolDiagnostic(event({}, extra)), null);
  assert.equal(sessionToolDiagnostic({ ...event({}), type: "item.started" }), null);
  assert.equal(sessionToolDiagnostic(null), null);
});

test("structured snake-case content works without scanning nested source objects", () => {
  const fixed = sessionToolDiagnostic(event({ is_error: true, structured_content: { code: "BASELINE_REQUIRED" } }));
  assert.equal(fixed.reported_rejection_code, "BASELINE_REQUIRED");
  const nested = sessionToolDiagnostic(event({ isError: true, structuredContent: { source: { code: "RESULT_INVALID" } } }));
  assert.equal(nested.reported_rejection_code, null);
});

test("accessors cannot execute while the observer reads untrusted diagnostic fields", () => {
  let reads = 0;
  const value = event({});
  Object.defineProperty(value.item.result, "structuredContent", { get() { reads++; throw Error("PRIVATE GETTER"); } });
  Object.defineProperty(value.item.result, "isError", { get() { reads++; throw Error("PRIVATE GETTER"); } });
  const observed = sessionToolDiagnostic(value);
  assert.equal(reads, 0);
  assert.equal(observed.reported_rejection_code, null);
});
