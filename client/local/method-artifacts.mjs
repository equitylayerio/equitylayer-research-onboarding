import { canonicalJson, contentHash, publicScope, validateRunEnvelope } from "./run-contract.mjs";
import { verifyMethodBundle } from "./reference-bridge.mjs";

// The workflow is adopted. Each exact method and evaluation still needs human approval.
export const METHOD_RELEASE_GATE = "HUMAN_METHOD_APPROVAL_REQUIRED";

export class MethodArtifactError extends Error {
  constructor(code, message) { super(message); this.name = "MethodArtifactError"; this.code = code; }
}
export const methodFail = (code, message) => { throw new MethodArtifactError(code, message); };
export const methodExact = (value, fields) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || fields.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !fields.includes(key))) methodFail("METHOD_INPUT_INVALID", "Use the required method fields only.");
};
export const methodText = (value, maximum = 160) => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    methodFail("METHOD_INPUT_INVALID", "Use bounded printable method text.");
  }
  return value;
};
export const methodHash = value => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) methodFail("METHOD_INPUT_INVALID", "Use a lowercase SHA-256 hash.");
  return value;
};
export const methodList = (value, minimum = 1, maximum = 100) => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) methodFail("METHOD_INPUT_INVALID", "Use a bounded method list.");
  return value;
};
export const methodCaseRefs = value => {
  const ids = new Set();
  return methodList(value).map(ref => {
    methodExact(ref, ["case_id", "case_sha256"]); methodText(ref.case_id); methodHash(ref.case_sha256);
    if (ids.has(ref.case_id)) methodFail("METHOD_INPUT_INVALID", "Use each case once.");
    ids.add(ref.case_id); return ref;
  });
};
export function validateCaseRequest(input) {
  methodExact(input, ["case_id", "origin", "note", "author_id"]);
  methodText(input.case_id); methodText(input.note, 1200); methodText(input.author_id);
  methodExact(input.origin, ["kind", "id"]); methodText(input.origin.id, 500);
  if (!["run", "review", "source_gate"].includes(input.origin.kind)) methodFail("METHOD_INPUT_INVALID", "Use a retained run, review, or source gate.");
  return JSON.parse(canonicalJson(input));
}
export function validateCandidateRequest(input) {
  methodExact(input, ["candidate_id", "bundle", "parent_method_sha256", "case_refs", "reason", "author_id"]);
  methodText(input.candidate_id); methodText(input.reason, 1200); methodText(input.author_id);
  const reference = verifyMethodBundle(input.bundle); methodHash(input.parent_method_sha256); methodCaseRefs(input.case_refs);
  if (reference.bundle_sha256 === input.parent_method_sha256) methodFail("METHOD_PARENT_INVALID", "A candidate must differ from its parent.");
  return JSON.parse(canonicalJson(input));
}
export function validatePlanRequest(input) {
  methodExact(input, ["plan_id", "incumbent_method_sha256", "case_refs", "rubric", "evaluation_at", "repetitions", "runtime_policy_sha256", "author_id"]);
  methodText(input.plan_id); methodText(input.author_id); methodHash(input.incumbent_method_sha256); methodHash(input.runtime_policy_sha256);
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 10) methodFail("METHOD_INPUT_INVALID", "Use one to ten fixed repetitions.");
  if (typeof input.evaluation_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.evaluation_at) ||
      !Number.isFinite(Date.parse(input.evaluation_at)) || new Date(input.evaluation_at).toISOString() !== input.evaluation_at) {
    methodFail("METHOD_INPUT_INVALID", "Use a real UTC evaluation time with millisecond precision.");
  }
  const ids = new Set();
  methodList(input.case_refs).forEach(ref => {
    methodExact(ref, ["case_id", "case_sha256", "partition"]); methodText(ref.case_id); methodHash(ref.case_sha256);
    if (ids.has(ref.case_id) || !["regression", "holdout"].includes(ref.partition)) methodFail("METHOD_INPUT_INVALID", "Use distinct cases with explicit partitions.");
    ids.add(ref.case_id);
  });
  methodExact(input.rubric, ["version", "criteria", "minimum_score_bps", "critical_regression_veto", "comparison_rule"]);
  methodText(input.rubric.version);
  if (!Number.isSafeInteger(input.rubric.minimum_score_bps) || input.rubric.minimum_score_bps < 0 || input.rubric.minimum_score_bps > 10000 ||
      input.rubric.critical_regression_veto !== true || input.rubric.comparison_rule !== "paired_incumbent_no_regression") {
    methodFail("METHOD_INPUT_INVALID", "Keep the paired comparison and critical regression veto.");
  }
  const criteria = new Set();
  methodList(input.rubric.criteria, 1, 20).forEach(criterion => {
    methodExact(criterion, ["id", "description", "critical", "weight"]); methodText(criterion.id); methodText(criterion.description, 1200);
    if (criteria.has(criterion.id) || typeof criterion.critical !== "boolean" || !Number.isSafeInteger(criterion.weight) || criterion.weight < 1 || criterion.weight > 100) {
      methodFail("METHOD_INPUT_INVALID", "Use distinct criteria with explicit critical flags and bounded positive weights.");
    }
    criteria.add(criterion.id);
  });
  return JSON.parse(canonicalJson(input));
}

// These artifacts retain local evidence. They do not authenticate authors or approve methods.
export function validateMethodArtifact(kind, record) {
  methodExact(record, ["schema_version", "request", "request_sha256", "captured_at", "payload"]);
  if (record.schema_version !== 1 || !Number.isSafeInteger(record.captured_at) || record.captured_at < 0 || contentHash(record.request) !== record.request_sha256) {
    methodFail("METHOD_ARTIFACT_INVALID", "The method artifact does not match its request.");
  }
  if (kind === "case") {
    validateCaseRequest(record.request);
    methodExact(record.payload, ["classification", "curation_status", "family_sha256", "scope", "private_context", "envelope", "method_sha256", "source_refs", "origin_record", "checkpoints", "requests", "delivery", "retention_limits"]);
    if (record.payload.classification !== "regression" || record.payload.curation_status !== "founder_review_required") methodFail("METHOD_ARTIFACT_INVALID", "Captured historical cases remain regression material awaiting review.");
    publicScope(record.payload.scope); methodHash(record.payload.family_sha256); methodHash(record.payload.method_sha256);
    if (record.payload.envelope !== null) validateRunEnvelope(record.payload.envelope);
    methodList(record.payload.source_refs, 0, 1000); methodList(record.payload.checkpoints, 0, 1000); methodList(record.payload.requests, 0, 1000);
    methodText(record.payload.retention_limits, 1200);
  } else if (kind === "candidate") {
    validateCandidateRequest(record.request);
    methodExact(record.payload, ["method_sha256", "serialized_sha256", "curation_status", "release_status"]);
    if (record.payload.method_sha256 !== verifyMethodBundle(record.request.bundle).bundle_sha256 || record.payload.serialized_sha256 !== contentHash(record.request.bundle) ||
        record.payload.curation_status !== "founder_review_required" || record.payload.release_status !== "candidate") methodFail("METHOD_ARTIFACT_INVALID", "The retained candidate does not match its method bytes.");
  } else if (kind === "plan") {
    validatePlanRequest(record.request);
    methodExact(record.payload, ["corpus_sha256", "rubric_sha256", "release_gate", "evaluation_status"]);
    if (record.payload.corpus_sha256 !== contentHash(record.request.case_refs) || record.payload.rubric_sha256 !== contentHash(record.request.rubric) ||
        !["D12_UNANSWERED", METHOD_RELEASE_GATE].includes(record.payload.release_gate) || record.payload.evaluation_status !== "not_executed") methodFail("METHOD_ARTIFACT_INVALID", "A frozen plan does not prove an evaluation or method approval.");
  } else methodFail("METHOD_ARTIFACT_INVALID", "Use a supported method artifact kind.");
  return JSON.parse(canonicalJson(record));
}

export const METHOD_ARTIFACT_SCHEMA = `
CREATE TABLE method_artifacts(sequence INTEGER PRIMARY KEY AUTOINCREMENT,artifact_id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('case','candidate','plan')),sha256 TEXT NOT NULL,record_json TEXT NOT NULL) STRICT;
CREATE TABLE method_artifact_manifest(singleton INTEGER PRIMARY KEY CHECK(singleton=1),sha256 TEXT NOT NULL) STRICT;
INSERT INTO method_artifact_manifest VALUES(1,'${contentHash([])}');
PRAGMA user_version=5;`;

export function verifyMethodArtifacts(db) {
  const rows = db.prepare("SELECT * FROM method_artifacts ORDER BY sequence").all();
  const lookup = new Map(rows.map(row => [row.artifact_id, row]));
  const fail = () => methodFail("METHOD_ARTIFACT_INVALID", "Retained method content or references changed.");
  const method = sha => db.prepare("SELECT bundle_json FROM methods WHERE bundle_sha256=?").get(sha);
  for (const row of rows) {
    const record = validateMethodArtifact(row.kind, JSON.parse(row.record_json));
    const request = record.request;
    if (canonicalJson(record) !== row.record_json || contentHash(record) !== row.sha256 || row.artifact_id !== `${row.kind}:${request[`${row.kind}_id`]}`) fail();
    if (row.kind === "case") {
      if (!method(record.payload.method_sha256)) fail();
      const scope = record.payload.scope;
      const revision = db.prepare("SELECT scope_json,context_json FROM revisions WHERE watch_id=? AND revision=?").get(scope.watch_id, scope.revision);
      if (!revision || canonicalJson(scope) !== revision.scope_json || canonicalJson(record.payload.private_context) !== revision.context_json) fail();
      for (const ref of record.payload.source_refs) {
        const source = db.prepare("SELECT e.sha256,e.artifact_id,a.sha256 AS artifact_sha FROM source_events e JOIN artifacts a ON a.artifact_id=e.artifact_id WHERE e.event_id=?").get(ref.source_event_id);
        if (!source || source.sha256 !== ref.source_event_sha256 || source.artifact_id !== ref.source_artifact_id || source.artifact_sha !== ref.artifact_sha256) fail();
      }
      if (request.origin.kind === "review") {
        const review = db.prepare("SELECT * FROM reviews WHERE review_id=?").get(request.origin.id);
        if (!review || canonicalJson({ ...review }) !== canonicalJson(record.payload.origin_record)) fail();
      } else if (request.origin.kind === "source_gate") {
        const gate = db.prepare("SELECT decision_json FROM event_decisions WHERE decision_id=?").get(request.origin.id);
        if (!gate || gate.decision_json !== canonicalJson(record.payload.origin_record)) fail();
      } else if (!db.prepare("SELECT run_id FROM runs WHERE run_id=?").get(request.origin.id)) fail();
      if (record.payload.envelope) {
        const run = db.prepare("SELECT envelope_json FROM runs WHERE run_id=?").get(record.payload.envelope.run_id);
        if (!run || run.envelope_json !== canonicalJson(record.payload.envelope)) fail();
        if (canonicalJson(record.payload.envelope.scope) !== canonicalJson(scope) ||
            record.payload.envelope.method.bundle_sha256 !== record.payload.method_sha256 ||
            canonicalJson(record.payload.envelope.source_refs) !== canonicalJson(record.payload.source_refs) ||
            record.payload.envelope.local_context_sha256 !== contentHash(record.payload.private_context)) fail();
        for (const cp of record.payload.checkpoints) {
          const retained = db.prepare("SELECT sha256,payload_json FROM checkpoints WHERE run_id=? AND checkpoint_key=?").get(record.payload.envelope.run_id, cp.key);
          if (!retained || retained.sha256 !== cp.sha256 || retained.payload_json !== canonicalJson(cp.payload)) fail();
        }
        for (const snapshot of record.payload.requests) {
          const retained = db.prepare("SELECT * FROM requests WHERE request_id=? AND run_id=?").get(snapshot.request_id, record.payload.envelope.run_id);
          if (!retained || retained.operation_id !== snapshot.operation_id || retained.owner !== snapshot.owner || retained.fence !== snapshot.fence ||
              retained.estimate_json !== canonicalJson(snapshot.estimate) || retained.dispatched_at !== snapshot.dispatched_at) fail();
          for (const receipt of snapshot.receipts) {
            const retainedReceipt = db.prepare("SELECT receipt_json FROM request_receipts WHERE receipt_sha256=? AND request_id=?").get(receipt.receipt_sha256, snapshot.request_id);
            if (!retainedReceipt || retainedReceipt.receipt_json !== canonicalJson(receipt.record)) fail();
          }
        }
        if (record.payload.delivery) {
          const delivery = db.prepare("SELECT sha256,result_json FROM deliveries WHERE delivery_id=? AND run_id=?").get(record.payload.delivery.delivery_id, record.payload.envelope.run_id);
          if (!delivery || delivery.sha256 !== record.payload.delivery.sha256 || delivery.result_json !== canonicalJson(record.payload.delivery.result)) fail();
        }
      }
      if (record.payload.family_sha256 !== contentHash({ scope, sources: record.payload.source_refs.map(ref => ref.artifact_sha256), private_context: record.payload.private_context })) fail();
    } else {
      if (!method(request[row.kind === "candidate" ? "parent_method_sha256" : "incumbent_method_sha256"])) fail();
      for (const ref of request.case_refs) {
        const retained = lookup.get(`case:${ref.case_id}`);
        if (!retained || retained.sha256 !== ref.case_sha256) fail();
        if (row.kind === "plan" && ref.partition !== "regression") fail();
      }
      if (row.kind === "candidate") {
        const retained = method(record.payload.method_sha256);
        if (!retained || retained.bundle_json !== canonicalJson(request.bundle)) fail();
      }
    }
  }
  const parents = new Map(rows.filter(row => row.kind === "candidate").map(row => {
    const record = JSON.parse(row.record_json); return [record.payload.method_sha256, record.request.parent_method_sha256];
  }));
  if (parents.size !== rows.filter(row => row.kind === "candidate").length) fail();
  for (const child of parents.keys()) {
    let ancestor = child; const seen = new Set();
    while (ancestor) { if (seen.has(ancestor)) fail(); seen.add(ancestor); ancestor = parents.get(ancestor); }
  }
  const manifest = db.prepare("SELECT sha256 FROM method_artifact_manifest WHERE singleton=1").get();
  if (!manifest || manifest.sha256 !== contentHash(rows.map(row => ({ artifact_id: row.artifact_id, kind: row.kind, sha256: row.sha256 })))) fail();
}
