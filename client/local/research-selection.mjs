import { canonicalJson } from "./run-contract.mjs";
import { ExternalSessionError } from "./external-session-contract.mjs";

const get = (db, sql, ...args) => db.prepare(sql).get(...args);
const fail = () => { throw new ExternalSessionError("EXTERNAL_SESSION_STORAGE_INVALID"); };
export function researchTarget(db, kind, id) {
  if (!["native", "external"].includes(kind)) fail();
  if (kind === "native") {
    const row = get(db, "SELECT d.*,r.watch_id,r.revision,r.envelope_json FROM deliveries d JOIN runs r USING(run_id) WHERE delivery_id=?", id);
    return row ? { kind, id, watch_id: row.watch_id, revision: row.revision, sha256: row.sha256, created_at: row.created_at,
      result: JSON.parse(row.result_json), source_records: JSON.parse(row.envelope_json).source_refs.map(ref => {
        const source = get(db, "SELECT a.metadata_json FROM source_events e JOIN artifacts a USING(artifact_id) WHERE e.event_id=?", ref.source_event_id);
        if (!source) fail();
        return { artifact: JSON.parse(source.metadata_json) };
      }) } : null;
  }
  const row = get(db, "SELECT r.payload_json,c.watch_id,c.revision,c.payload_json AS context_json FROM external_session_records r JOIN external_session_contexts c USING(context_id) WHERE record_id=?", id);
  if (!row) return null;
  const payload = JSON.parse(row.payload_json), context = JSON.parse(row.context_json).context;
  return { kind: "external", id, watch_id: row.watch_id, revision: row.revision, sha256: payload.record.content_sha256,
    created_at: payload.created_at, result: payload.record.result, source_records: context.source_records,
    ...(payload.record.schema_version === 2 ? { source_dates: payload.record.source_dates } : {}) };
}

export function researchSelection(db, watchId, action) {
  const schema = get(db, "PRAGMA user_version").user_version;
  const native = "SELECT v.delivery_id AS id,'native' AS kind,v.expected_revision FROM reviews v JOIN deliveries d USING(delivery_id) JOIN runs r USING(run_id) WHERE r.watch_id=? AND v.action=?";
  const row = schema >= 12 ? get(db, `SELECT * FROM (${native} UNION ALL SELECT v.record_id AS id,'external' AS kind,v.expected_revision
    FROM external_session_reviews v JOIN external_session_records e USING(record_id) JOIN external_session_contexts c USING(context_id)
    WHERE c.watch_id=? AND v.action=?) ORDER BY expected_revision DESC LIMIT 1`, watchId, action, watchId, action) :
    get(db, `${native} ORDER BY v.expected_revision DESC LIMIT 1`, watchId, action);
  if (!row) return null;
  const target = researchTarget(db, row.kind, row.id);
  if (!target || target.watch_id !== watchId) fail();
  return { kind: target.kind, id: target.id, scope_revision: target.revision, output_sha256: target.sha256,
    recorded_at: new Date(target.created_at).toISOString() };
}

export function selectedResearchBaseline(db, watchId, revision) {
  const selected = researchSelection(db, watchId, "accept_evidence");
  if (!selected || selected.scope_revision !== revision) return [];
  return [{ owner: "caller_local", pack_id: `local-evidence:${watchId}`, pack_version: selected.id,
    output_sha256: selected.output_sha256, recorded_at: selected.recorded_at }];
}

export function resolveResearchBaseline(db, watchId, revision, reference) {
  const kind = reference.pack_version.startsWith("el-external-") ? "external" : "native";
  const target = researchTarget(db, kind, reference.pack_version);
  if (!target || reference.owner !== "caller_local" || reference.pack_id !== `local-evidence:${watchId}` || target.watch_id !== watchId ||
      target.revision !== revision || target.sha256 !== reference.output_sha256 || new Date(target.created_at).toISOString() !== reference.recorded_at) fail();
  if (kind === "external" && !get(db, "SELECT review_id FROM external_session_reviews WHERE record_id=? AND action='accept_evidence' LIMIT 1", target.id)) fail();
  return target;
}

export function checkResearchRights(db, target) {
  for (const source of target.source_records) {
    const row = get(db, "SELECT policy_json FROM source_policies WHERE watch_id=? AND source_id=? ORDER BY revision DESC LIMIT 1", target.watch_id, source.artifact.source_id);
    const policy = row ? JSON.parse(row.policy_json) : null;
    if (!policy || policy.rights_status !== "ALLOWED" || !policy.allowed_purposes.includes("local_research")) throw new ExternalSessionError("SOURCE_RIGHTS_GATED");
  }
}
export function researchBaselineContext(db, watchId, revision, reference) {
  const target = resolveResearchBaseline(db, watchId, revision, reference);
  checkResearchRights(db, target);
  return { reference, status: "available", purpose: "comparison_evidence_only", origin: target.kind,
    usage: target.kind === "external" ? "unverified" : "not_asserted", result: JSON.parse(canonicalJson(target.result)),
    ...(Object.hasOwn(target, "source_dates") ? { source_dates: JSON.parse(canonicalJson(target.source_dates)) } : {}) };
}
