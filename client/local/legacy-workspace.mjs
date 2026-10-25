import { createHash } from "node:crypto";
import { publicScope } from "./run-contract.mjs";
import { validateResearchResultFile } from "./result-file.mjs";

export const LEGACY_WORKSPACE_MAX_BYTES = 2_000_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class LegacyWorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = "LegacyWorkspaceError";
    this.code = "LEGACY_WORKSPACE_INVALID";
  }
}
const fail = (message) => { throw new LegacyWorkspaceError(message); };
const record = (value, required, optional = []) => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => ![...required, ...optional].includes(key))) {
    fail("The legacy record has missing or unsupported fields.");
  }
};
const text = (value, max, { trim = false, empty = false } = {}) => {
  if (typeof value !== "string") fail("Use bounded legacy text.");
  const parsed = trim ? value.trim() : value;
  if (parsed.length > max || !empty && !parsed.length) fail("Use bounded legacy text.");
  return parsed;
};
const list = (value, max = Infinity) => {
  if (!Array.isArray(value) || value.length > max) fail("The legacy list has an invalid length.");
  return value;
};
const uuid = (value) => {
  if (typeof value !== "string" || !UUID.test(value)) fail("Use a valid legacy UUID.");
  return value.toLowerCase();
};
const timestamp = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) fail("Use a valid UTC legacy timestamp.");
  const instant = new Date(value).toISOString();
  if (instant.slice(0, 16) !== value.slice(0, 16) || value[16] === ":" && instant.slice(17, 19) !== value.slice(17, 19)) {
    fail("Use a real legacy calendar time.");
  }
  return value;
};
const baseline = (value) => {
  record(value, ["pack_id", "version"]);
  return { pack_id: text(value.pack_id, 120), version: text(value.version, 160) };
};
const companies = (value) => list(value, 20).map((item) => text(item, 30, { empty: true }));

function parseThemeWatch(value) {
  record(value, ["schema_version", "theme_id", "question", "trigger", "component", "companies", "baseline", "saved_at", "history"]);
  if (value.schema_version !== 1 || value.theme_id !== "ai_compute") fail("Use theme watch schema version one for AI Compute.");
  return {
    schema_version: 1, theme_id: value.theme_id,
    question: text(value.question, 600, { trim: true }), trigger: text(value.trigger, 600, { trim: true }),
    component: text(value.component, 100, { empty: true }), companies: companies(value.companies),
    baseline: baseline(value.baseline), saved_at: timestamp(value.saved_at),
    history: list(value.history).map((entry) => {
      record(entry, ["reason", "decision", "from_version", "to_version", "reviewed_at"],
        ["kind", "question", "trigger", "component", "companies"]);
      if (!["keep", "revisit"].includes(entry.decision)) fail("Use a supported legacy review decision.");
      if (entry.kind !== undefined && !["evidence_review", "note", "view_edit"].includes(entry.kind)) {
        fail("Use a supported legacy history kind.");
      }
      const parsed = { ...entry, reason: text(entry.reason, 1200, { trim: true }),
        from_version: text(entry.from_version, 160, { empty: true }), to_version: text(entry.to_version, 160, { empty: true }),
        reviewed_at: timestamp(entry.reviewed_at) };
      for (const [key, max] of [["question", 600], ["trigger", 600], ["component", 100]]) {
        if (entry[key] !== undefined) parsed[key] = text(entry[key], max, { empty: true });
      }
      if (entry.companies !== undefined) parsed.companies = companies(entry.companies);
      return parsed;
    }),
  };
}

// The raw archive is the authority for legacy bytes. Typed records do not add provenance.
export function parseLegacyWorkspace(rawBytes) {
  if (!(rawBytes instanceof Uint8Array)) fail("Use legacy JSON bytes.");
  if (rawBytes.byteLength > LEGACY_WORKSPACE_MAX_BYTES) fail("The legacy archive exceeds 2000000 bytes.");
  const raw_bytes = Buffer.from(rawBytes);
  let workspace;
  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(raw_bytes);
    workspace = JSON.parse(rawText);
  } catch {
    fail("Use valid UTF-8 JSON for the legacy archive.");
  }
  record(workspace, ["schema_version", "watches"]);
  if (workspace.schema_version !== 1) fail("Use legacy workspace schema version one.");
  const watchIds = new Set();
  const resultIds = new Set();
  const watches = list(workspace.watches, 30).map((watch) => {
    record(watch, ["scope", "saved_at", "results", "reviews"], ["accepted_result_id", "legacy_watch"]);
    record(watch.scope, ["watch_id", "revision", "theme_id", "symbols", "question", "trigger"], ["component", "stage_id"]);
    const { component = "", question, trigger, ...scopeValue } = watch.scope;
    let scope;
    try { scope = publicScope(scopeValue); } catch { fail("Use a valid legacy watch scope."); }
    if (watchIds.has(scope.watch_id)) fail("Remove duplicate legacy watch IDs.");
    watchIds.add(scope.watch_id);
    const private_context = { component: text(component, 100, { trim: true, empty: true }),
      question: text(question, 600, { trim: true }), trigger: text(trigger, 600, { trim: true }) };
    const saved_at = timestamp(watch.saved_at);
    const watchResultIds = new Set();
    // Raw byte limits bound complete histories. Do not apply the old UI limit of 30 results.
    const results = list(watch.results).map((input) => {
      let result;
      try { result = validateResearchResultFile(input); } catch { fail("Use a valid legacy research result."); }
      result.result_id = uuid(result.result_id);
      if (resultIds.has(result.result_id)) fail("Remove duplicate legacy result IDs.");
      resultIds.add(result.result_id);
      watchResultIds.add(result.result_id);
      if (result.watch_id !== scope.watch_id || result.scope_revision > scope.revision) {
        fail("The legacy result does not belong to this watch revision.");
      }
      if (result.scope_revision === scope.revision && (result.theme_id !== scope.theme_id ||
          result.stage_id !== scope.stage_id || JSON.stringify(result.symbols) !== JSON.stringify(scope.symbols))) {
        fail("The current legacy result must match the watch scope.");
      }
      return result;
    });
    const reviewIds = new Set();
    const reviews = list(watch.reviews).map((review) => {
      record(review, ["result_id", "decision", "reviewed_at", "reason"]);
      const result_id = uuid(review.result_id);
      if (reviewIds.has(result_id)) fail("Remove duplicate legacy reviews.");
      if (!watchResultIds.has(result_id)) fail("Each legacy review must refer to a result in its watch.");
      if (!["keep", "revisit"].includes(review.decision)) fail("Use a supported legacy review decision.");
      reviewIds.add(result_id);
      return { result_id, decision: review.decision, reviewed_at: timestamp(review.reviewed_at),
        reason: text(review.reason, 1200, { trim: true }) };
    });
    if (watch.accepted_result_id !== undefined && !reviewIds.has(uuid(watch.accepted_result_id))) {
      fail("The accepted legacy result must have a review in its watch.");
    }
    const accepted_result_id = watch.accepted_result_id ?? null;
    return { scope, private_context, saved_at, results, reviews, accepted_result_id,
      accepted_result: { status: "legacy-unclassified", result_id: accepted_result_id },
      ...(watch.legacy_watch !== undefined ? { legacy_watch: parseThemeWatch(watch.legacy_watch) } : {}) };
  });
  return { schema_version: 1, raw_bytes, raw_sha256: createHash("sha256").update(raw_bytes).digest("hex"), workspace, watches };
}
