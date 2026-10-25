import test from "node:test";
import assert from "node:assert/strict";
import { validateResearchResultFile, ResultFileError, resultValidationIssue, RESULT_UTC_TIMESTAMP_PATTERN } from "../client/local/result-file.mjs";
import { createRunEnvelope, contentHash } from "../client/local/run-contract.mjs";
import { scope, context, result } from "./fixtures/local-research.mjs";
import { sessionToolDiagnostic } from "./helpers/session-tool-diagnostic.mjs";

const envelope = () => createRunEnvelope({ scope: scope(), method: { bundle_version: "test", bundle_sha256: "a".repeat(64), profile_ids: ["test"] },
  source_refs: [], baselines: [], evaluation_at: "2026-10-11T00:00:00Z", local_context_sha256: contentHash(context()) });
const valid = () => result(envelope());
const rejects = (value) => assert.throws(() => validateResearchResultFile(value), { code: "RESULT_INVALID" });

test("complete version-one result files remain detached and compatible", () => {
  const input = valid(); const parsed = validateResearchResultFile(input);
  assert.deepEqual(parsed, input); assert.notEqual(parsed, input);
  parsed.sources[0].claim = "changed";
  assert.equal(input.sources[0].claim, "Synthetic claim.");
  assert.equal(validateResearchResultFile(result(envelope(), "SOURCE_NEEDED")).sources.length, 0);
});

test("every required field and unsupported field is checked before delivery", () => {
  for (const key of Object.keys(valid())) { const missing = valid(); delete missing[key]; rejects(missing); }
  rejects({ ...valid(), schema_version: 999 }); rejects({ ...valid(), extra: "unknown" });
  rejects({ ...valid(), result_id: "not-a-uuid" }); rejects({ ...valid(), result_state: "APPROVED" });
  rejects({ ...valid(), sources: [null] }); rejects({ ...valid(), sources: [] });
});

test("scope, timestamps, bounded text, and source records fail closed", () => {
  for (const patch of [
    { scope_revision: 0 }, { theme_id: "other" }, { symbols: ["LITE", "lite"] }, { stage_id: "other" },
    { summary: " " }, { summary: "a".repeat(3001) }, { created_at: "2026-02-30T00:00:00Z" },
    { next_check_at: "2026-10-11T24:00:00Z" }, { as_of_feed_day: "2026-02-30" },
    { drivers: ["1", "2", "3", "4"] }, { falsifiers: [1] }, { unknowns: "text" },
    { baseline: { pack_id: "pack" } }, { baseline: { pack_id: "pack", version: "v1", extra: true } },
  ]) rejects({ ...valid(), ...patch });
  for (const patch of [
    { url: "http://example.test/source" }, { url: "https://secret:password@example.test/source" },
    { date: "2026-02-30" }, { kind: "verified" }, { claim: " " }, { extra: true },
  ]) rejects({ ...valid(), sources: [{ ...valid().sources[0], ...patch }] });
});

test("optional Pack records retain declared agent-report status and cannot invent covered symbols", () => {
  const receipt = { capability_id: "taiwan-monthly-revenue-monitor", research_version: "test", covered_symbols: ["3037.TW"],
    receipt_reference: "agent-report-only", output_hash: "b".repeat(64), network: "eip155:5042002",
    transaction_reference: "synthetic-not-a-payment", settled_at: "2026-10-11T08:00:00+08:00", verification: "agent_reported" };
  const input = { ...valid(), symbols: [...valid().symbols, "3037.TW"].sort(), purchase_records: [receipt] };
  assert.deepEqual(validateResearchResultFile(input), input);
  for (const patch of [{ verification: "verified" }, { network: "solana-mainnet" }, { covered_symbols: ["NVDA"] },
    { covered_symbols: ["2383.TW"] }, { output_hash: "wrong" }, { extra: true }, { settled_at: "wrong" }]) {
    rejects({ ...input, purchase_records: [{ ...receipt, ...patch }] });
  }
});

for (const [patch, field, rule] of [
  [{ summary: { private_value: "secret" } }, "summary", "TEXT_TYPE"],
  [{ sources: Array(31).fill({}) }, "sources", "LIST_LENGTH"],
  [{ sources: [null] }, "sources[0]", "FIELDS"],
  [{ sources: [{ ...valid().sources[0], private_key: "secret" }] }, "sources[0]", "FIELDS"],
  [{ sources: [{ ...valid().sources[0], url: "private-invalid-url" }] }, "sources[0].url", "HTTPS_URL"],
  [{ sources: [{ ...valid().sources[0], url: "https://secret:password@example.test" }] }, "sources[0].url", "HTTPS_URL"],
  [{ sources: [{ ...valid().sources[0], url: 42 }] }, "sources[0].url", "TEXT_TYPE"],
  [{ sources: [{ ...valid().sources[0], date: "2026-02-30" }] }, "sources[0].date", "CALENDAR_DATE"],
  [{ sources: [{ ...valid().sources[0], kind: "private-kind" }] }, "sources[0].kind", "EVIDENCE_KIND"],
  [{ sources: [{ ...valid().sources[0], claim: " " }] }, "sources[0].claim", "TEXT_LENGTH"],
  [{ sources: [{ ...valid().sources[0], claim: 42 }] }, "sources[0].claim", "TEXT_TYPE"],
  [{ result_state: "private-state" }, "result_state", "RESULT_STATE"],
  [{ sources: [] }, "sources", "SOURCES_REQUIRED"],
  [{ drivers: [42] }, "drivers[0]", "TEXT_TYPE"],
  [{ falsifiers: [""] }, "falsifiers[0]", "TEXT_LENGTH"],
  [{ unknowns: ["a".repeat(601)] }, "unknowns[0]", "TEXT_LENGTH"],
]) test(`validator issue identifies ${field} and ${rule} without submitted content`, () => {
  let error;
  try { validateResearchResultFile({ ...valid(), ...patch }); } catch (value) { error = value; }
  assert.equal(error?.code, "RESULT_INVALID");
  assert.deepEqual(resultValidationIssue(error), { field, rule });
});

test("only validator-created issues are readable and returned copies cannot mutate their identity", () => {
  let error; try { validateResearchResultFile({ ...valid(), summary: 42 }); } catch (value) { error = value; }
  const issue = resultValidationIssue(error); issue.field = "PRIVATE"; issue.rule = "PRIVATE";
  assert.deepEqual(resultValidationIssue(error), { field: "summary", rule: "TEXT_TYPE" });
  error.message = "PRIVATE"; error.issue = { field: "PRIVATE", rule: "PRIVATE" };
  assert.deepEqual(resultValidationIssue(error), { field: "summary", rule: "TEXT_TYPE" });
  let reads = 0;
  const forged = new ResultFileError("PRIVATE");
  Object.defineProperty(forged, "issue", { get() { reads++; throw new Error("PRIVATE"); } });
  for (const value of [forged, { code: "RESULT_INVALID", issue: "PRIVATE" }, null, undefined, 42]) assert.equal(resultValidationIssue(value), null);
  assert.equal(reads, 0);
  let internal; try { validateResearchResultFile({ ...valid(), watch_id: "invalid" }); } catch (value) { internal = value; }
  assert.equal(resultValidationIssue(internal), null);
});

test("the shared timestamp pattern preserves valid UTC forms and never accepts an offset", () => {
  const pattern = new RegExp(RESULT_UTC_TIMESTAMP_PATTERN);
  for (const value of ["2026-10-12T00:00Z", "2026-10-12T00:00:00Z", "2026-10-12T00:00:00.123Z"]) {
    assert.equal(pattern.test(value), true); assert.equal(validateResearchResultFile({ ...valid(), next_check_at: value }).next_check_at, value);
  }
  for (const value of ["2026-10-12T00:00:00+00:00", "2026-10-12", "2026-10-12T00:00:00z", "tomorrow"]) {
    assert.equal(pattern.test(value), false); rejects({ ...valid(), next_check_at: value });
  }
});

const diagnosticEvent = result => ({ type: "item.completed", item: {
  type: "mcp_tool_call", server: "research", tool: "submit_research", status: "failed", result } });
test("the acceptance observer retains only fixed validation fields and rules from duplicate CLI copies", () => {
  const issue = { field: "sources[29].claim", rule: "TEXT_LENGTH", private_value: "PRIVATE" };
  const value = { code: "RESULT_INVALID", issue, private_source: "PRIVATE" };
  const observed = sessionToolDiagnostic(diagnosticEvent({ structured_content: value,
    content: [{ type: "text", text: JSON.stringify(value) }] }));
  assert.deepEqual(observed.reported_validation_issue, { field: "sources[29].claim", rule: "TEXT_LENGTH" });
  assert.equal(observed.diagnostic_conflict, false);
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE|private_value|private_source/);
});

test("the acceptance observer suppresses conflicting, malformed, and unknown validation issues", () => {
  const known = { code: "RESULT_INVALID", issue: { field: "summary", rule: "TEXT_LENGTH" } };
  for (const issue of [{ field: "next_check_at", rule: "UTC_TIMESTAMP" }, { field: "PRIVATE", rule: "TEXT_LENGTH" },
    { field: "summary", rule: "PRIVATE" }, { field: "sources[30].claim", rule: "TEXT_LENGTH" },
    { field: "drivers[3]", rule: "TEXT_LENGTH" }, { field: "summary", rule: "HTTPS_URL" }, null]) {
    const observed = sessionToolDiagnostic(diagnosticEvent({ structured_content: known,
      content: [{ type: "text", text: JSON.stringify({ code: "RESULT_INVALID", issue }) }] }));
    assert.equal(observed.reported_validation_issue, undefined);
    assert.equal(observed.diagnostic_conflict, true);
    assert.equal(observed.reported_rejection_code, null);
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE/);
  }
});

test("a validation issue cannot enter the observer through success, another code, inheritance, or getters", () => {
  const issue = { field: "summary", rule: "TEXT_LENGTH" }, value = { code: "RESULT_INVALID", issue };
  const success = diagnosticEvent({ isError: false, structured_content: value }); success.item.status = "completed";
  assert.equal(sessionToolDiagnostic(success).reported_validation_issue, undefined);
  assert.equal(sessionToolDiagnostic(diagnosticEvent({ structured_content: { ...value, code: "SOURCE_RIGHTS_GATED" } })).reported_validation_issue, undefined);
  let reads = 0; const getter = {};
  Object.defineProperty(getter, "field", { get() { reads++; throw Error("PRIVATE"); } });
  for (const invalid of [Object.create(issue), getter]) {
    const observed = sessionToolDiagnostic(diagnosticEvent({ structured_content: { code: "RESULT_INVALID", issue: invalid } }));
    assert.equal(observed.reported_validation_issue, undefined);
  }
  assert.equal(reads, 0);
});
