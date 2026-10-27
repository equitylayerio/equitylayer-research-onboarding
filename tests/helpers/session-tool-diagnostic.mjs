// Observe reports only. These labels do not prove the cause, billing, or permission to retry.
const TOOLS = new Set(["get_research_task", "get_submission_status", "submit_research"]);
const REJECTIONS = new Set([
  "AGENT_FIELDS_INVALID", "BASELINE_REQUIRED", "RESULT_DATE_INVALID", "RESULT_SOURCE_INVALID", "RESULT_INVALID",
  "RESEARCH_ADVICE_BLOCKED", "EXTERNAL_SESSION_SOURCE_DATE_INVALID", "EXTERNAL_SESSION_INPUT_INVALID",
  "EXTERNAL_SESSION_INPUT_LIMIT", "EXTERNAL_SESSION_SCOPE_CHANGED", "EXTERNAL_SESSION_AUTHORITY_CHANGED",
  "EXTERNAL_SESSION_SUBMISSION_CONFLICT", "EXTERNAL_SESSION_SUBMISSION_CONSENT_REQUIRED",
  "EXTERNAL_SESSION_CONTEXT_CONFLICT", "EXTERNAL_SESSION_STORAGE_INVALID", "EXTERNAL_SESSION_REFERENCE_MISSING",
  "EXTERNAL_SESSION_TIME_INVALID", "SOURCE_RIGHTS_GATED", "SOURCE_SCOPE_CONFLICT", "SOURCE_SCHEMA_CHANGED",
  "SOURCE_NEEDED", "STALE_SOURCE", "CORRECTION_REVIEW_REQUIRED", "SOURCE_TIME_INVALID", "SOURCE_POLICY_MISSING",
  "SESSION_OPERATION_FAILED", "SESSION_READ_REFERENCE_CHANGED", "SESSION_READ_REFERENCE_INVALID",
  "SESSION_READ_OFFSET_INVALID", "SESSION_READ_REPRESENTATION_CHANGED", "SESSION_READ_CONTENT_UNAVAILABLE",
  "SESSION_READ_PROJECTION_UNAVAILABLE", "SESSION_READ_RESPONSE_LIMIT"
]);
const PROTOCOL_CODES = new Set([-32700, -32600, -32601, -32602, -32603]);
const own = (object, key) => object !== null && typeof object === "object"
  ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
const textRules = ["TEXT_TYPE", "TEXT_LENGTH"];
function validationIssue(value) {
  const field = own(value, "field"), rule = own(value, "rule");
  if (typeof field !== "string" || field.length > 64 || typeof rule !== "string" || rule.length > 24) return "INVALID_ISSUE";
  let rules = {
    summary: textRules, result_state: ["RESULT_STATE"], next_check_at: ["UTC_TIMESTAMP", "CALENDAR_DATE", "CALENDAR_TIME"],
    sources: ["LIST_LENGTH", "SOURCES_REQUIRED"], drivers: ["LIST_LENGTH"], falsifiers: ["LIST_LENGTH"], unknowns: ["LIST_LENGTH"]
  }[field];
  const source = field.match(/^sources\[(?:[0-9]|[12][0-9])\](?:\.(url|date|claim|kind))?$/u);
  if (source) rules = source[1] === undefined ? ["FIELDS"] : {
    url: [...textRules, "HTTPS_URL"], date: ["CALENDAR_DATE"], claim: textRules, kind: ["EVIDENCE_KIND"]
  }[source[1]];
  if (/^(?:drivers\[[0-2]\]|falsifiers\[[0-4]\]|unknowns\[[0-9]\])$/u.test(field)) rules = textRules;
  return Array.isArray(rules) && rules.includes(rule) ? `${field}:${rule}` : "INVALID_ISSUE";
}

export function sessionToolDiagnostic(event) {
  const item = own(event, "item"), tool = own(item, "tool"), status = own(item, "status"), result = own(item, "result");
  if (own(event, "type") !== "item.completed" || own(item, "type") !== "mcp_tool_call" ||
      own(item, "server") !== "research" || !TOOLS.has(tool) || !["completed", "failed"].includes(status)) return null;
  const flags = [own(result, "isError"), own(result, "is_error")].filter(value => typeof value === "boolean");
  const flagConflict = new Set(flags).size > 1;
  const reported_tool_error = flagConflict || !flags.length ? null : flags[0];
  const codes = new Set(), issueReports = new Set();
  const candidate = value => {
    const code = own(value, "code");
    if (typeof code === "string") codes.add(REJECTIONS.has(code) ? code : "UNRECOGNIZED_CODE");
    const issue = code === "RESULT_INVALID" ? own(value, "issue") : undefined;
    if (issue !== undefined) issueReports.add(validationIssue(issue));
  };
  let protocol_error_code = null;
  if (!flagConflict && (status === "failed" || reported_tool_error === true)) {
    candidate(own(result, "structuredContent"));
    candidate(own(result, "structured_content"));
    const content = own(result, "content");
    if (Array.isArray(content) && content.length <= 8) for (let index = 0; index < content.length; index++) {
      const part = own(content, String(index)), text = own(part, "text");
      if (own(part, "type") !== "text" || typeof text !== "string" || Buffer.byteLength(text) > 16384) continue;
      try { candidate(JSON.parse(text)); } catch {}
    }
    const protocol = own(own(item, "error"), "code");
    if (PROTOCOL_CODES.has(protocol)) protocol_error_code = protocol;
  }
  const diagnostic_conflict = flagConflict || codes.size > 1 || issueReports.size > 1 || issueReports.has("INVALID_ISSUE");
  const onlyCode = codes.size === 1 ? [...codes][0] : null;
  const issue = !diagnostic_conflict && onlyCode === "RESULT_INVALID" && issueReports.size === 1 ? [...issueReports][0].split(":") : null;
  return { tool, status, reported_tool_error,
    reported_rejection_code: !diagnostic_conflict && REJECTIONS.has(onlyCode) ? onlyCode : null,
    protocol_error_code, diagnostic_conflict,
    ...(issue ? { reported_validation_issue: { field: issue[0], rule: issue[1] } } : {}) };
}
