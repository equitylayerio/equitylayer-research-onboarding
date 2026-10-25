import { canonicalJson, contentHash, publicScope } from "./run-contract.mjs";
import { verifyMethodBundle, verifySourceReference } from "./reference-bridge.mjs";

export class ThesisError extends Error {
  constructor(code, message) { super(message); this.name = "ThesisError"; this.code = code; }
}
export const thesisFail = (code, message) => { throw new ThesisError(code, message); };
const invalid = (message) => thesisFail("THESIS_INPUT_INVALID", message);
export const thesisExact = (value, fields) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || fields.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !fields.includes(key))) invalid("Use the required thesis fields only.");
};
export const thesisText = (value, maximum = 160) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) invalid("Use bounded printable thesis text.");
  return value;
};
const hash = value => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid("Use a lowercase SHA-256 hash.");
  return value;
};
const list = (value, min, max) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid("Use a bounded thesis list.");
  return value;
};
const strings = value => list(value, 1, 20).map(item => thesisText(item, 1200));
const positive = value => {
  if (!Number.isSafeInteger(value) || value < 1) invalid("Use a positive revision.");
};
const unique = values => { if (new Set(values).size !== values.length) invalid("Remove duplicate thesis identifiers."); };
const nullableHash = value => value === null ? null : hash(value);

// Evidence labels are caller assertions. Schema checks cannot verify an economic claim.
export function validateThesisProposal(input) {
  canonicalJson(input);
  thesisExact(input, ["schema_version", "thesis_id", "revision", "parent_sha256", "scope", "research_topic", "origin", "method_sha256",
    "title", "mechanism", "novelty", "market_roles", "claims", "alternative_explanation", "counterevidence_search", "next_check"]);
  if (input.schema_version !== 1) invalid("Use thesis schema version one.");
  thesisText(input.thesis_id); positive(input.revision); nullableHash(input.parent_sha256);
  if ((input.revision === 1) !== (input.parent_sha256 === null)) invalid("Pin the parent hash for every later thesis revision.");
  const scope = publicScope(input.scope);
  if (scope.theme_id !== "ai_compute" || !["ai_compute", "pcb_ccl"].includes(input.research_topic)) invalid("Use an AI Compute watch and a supported research topic.");
  thesisExact(input.origin, ["kind", "author_id", "run_id"]); thesisText(input.origin.author_id);
  if (!["human", "caller_agent"].includes(input.origin.kind)) invalid("Use a human or caller-agent proposal origin.");
  if (input.origin.kind === "human" ? input.origin.run_id !== null : typeof input.origin.run_id !== "string") invalid("Bind caller-agent proposals to a retained research run.");
  if (input.origin.run_id !== null) thesisText(input.origin.run_id, 500);
  nullableHash(input.method_sha256);
  if (input.origin.kind === "caller_agent" && input.method_sha256 === null) invalid("Pin the caller-agent method hash.");
  thesisText(input.title, 240); thesisText(input.mechanism, 2400); thesisText(input.alternative_explanation, 2400); thesisText(input.next_check, 1200);
  thesisExact(input.novelty, ["kind", "reason"]);
  if (!["manual_intuition", "new_mechanism", "new_role", "material_counterevidence"].includes(input.novelty.kind)) invalid("Declare the candidate difference.");
  if (input.origin.kind === "caller_agent" && input.novelty.kind === "manual_intuition") invalid("A caller-agent proposal must declare its research difference.");
  thesisText(input.novelty.reason, 1200);
  const markets = list(input.market_roles, 2, 20);
  for (const role of markets) {
    thesisExact(role, ["symbol", "market", "role"]);
    if (!scope.symbols.includes(role.symbol) || !["US", "TW", "JP", "KR"].includes(role.market) ||
        !["demand", "architecture", "manufacturing", "materials", "competition"].includes(role.role)) invalid("Use scoped company roles and explicit markets.");
  }
  unique(markets.map(role => role.symbol));
  if (markets.length !== scope.symbols.length || !markets.some(role => role.market === "US") || !markets.some(role => role.market !== "US")) invalid("Retain US and Asian roles for every scoped company.");
  const claims = list(input.claims, 1, 30);
  for (const claim of claims) {
    thesisExact(claim, ["claim_id", "statement", "kind", "status", "economic_stage", "symbols", "period", "unit", "denominator",
      "evidence_refs", "required_evidence", "falsifiers", "inference_limits"]);
    thesisText(claim.claim_id); thesisText(claim.statement, 2400);
    if (!["fact", "company_statement", "inference", "hypothesis"].includes(claim.kind) ||
        !["unknown", "supportive", "challenged", "mixed", "conflict", "retired"].includes(claim.status) ||
        !["demand", "technical", "qualification", "shipment", "mix", "price", "profit", "cash"].includes(claim.economic_stage)) invalid("Use explicit claim types, states, and economic stages.");
    list(claim.symbols, 1, 20).forEach(symbol => { if (!scope.symbols.includes(symbol)) invalid("Keep each claim within the watch scope."); });
    unique(claim.symbols);
    for (const key of ["period", "unit", "denominator"]) if (claim[key] !== null) thesisText(claim[key], 500);
    strings(claim.required_evidence); strings(claim.falsifiers); strings(claim.inference_limits);
    const refs = list(claim.evidence_refs, 0, 30);
    for (const ref of refs) {
      thesisExact(ref, ["document_id", "local_source_id", "source_ref", "locator", "relation"]);
      thesisText(ref.document_id); thesisText(ref.local_source_id); thesisText(ref.locator, 1000);
      if (!["support", "counter", "context"].includes(ref.relation)) invalid("Declare each evidence relation.");
      thesisExact(ref.source_ref, ["source_event_id", "source_event_sha256", "source_artifact_id", "artifact_sha256"]);
      thesisText(ref.source_ref.source_event_id, 500); thesisText(ref.source_ref.source_artifact_id, 500);
      hash(ref.source_ref.source_event_sha256); hash(ref.source_ref.artifact_sha256);
    }
    unique(refs.map(ref => canonicalJson([ref.document_id, ref.local_source_id, ref.source_ref, ref.locator, ref.relation])));
    const supports = refs.some(ref => ref.relation === "support"), counters = refs.some(ref => ref.relation === "counter");
    if (claim.status === "supportive" && !supports || claim.status === "challenged" && !counters ||
        claim.status === "mixed" && (!supports || !counters) || claim.status === "conflict" && !refs.length) invalid("Retain the evidence required by the claim state.");
  }
  unique(claims.map(claim => claim.claim_id));
  if (!["not_started", "searched_none_found", "found"].includes(input.counterevidence_search) ||
      (input.counterevidence_search === "found") !== claims.some(claim => claim.evidence_refs.some(ref => ref.relation === "counter"))) invalid("Declare the counterevidence search outcome without inventing evidence.");
  return JSON.parse(canonicalJson({ ...input, scope }));
}

export function validateThesisReview(input) {
  canonicalJson(input);
  thesisExact(input, ["review_id", "thesis_id", "revision", "proposal_sha256", "expected_review_revision", "action", "note", "actor"]);
  thesisText(input.review_id); thesisText(input.thesis_id); positive(input.revision); hash(input.proposal_sha256);
  if (!Number.isSafeInteger(input.expected_review_revision) || input.expected_review_revision < 0) invalid("Use a nonnegative review revision.");
  if (!["received", "accept_evidence", "accept_interpretation", "revisit", "reject"].includes(input.action)) invalid("Use an explicit thesis review action.");
  thesisText(input.note, 1200); thesisExact(input.actor, ["kind", "actor_id"]); thesisText(input.actor.actor_id);
  if (input.actor.kind !== "human") invalid("A thesis review requires the local owner's declared human decision.");
  return JSON.parse(canonicalJson(input));
}

// These differences compare retained structure. They do not grade investment significance.
export function thesisDelta(previous, current) {
  const next = validateThesisProposal(current), prior = previous === null ? null : validateThesisProposal(previous);
  if (prior && (prior.thesis_id !== next.thesis_id || next.revision !== prior.revision + 1 ||
      next.parent_sha256 !== contentHash(prior))) thesisFail("THESIS_REVISION_CONFLICT", "Compare adjacent revisions of the same thesis.");
  const fields = ["scope", "mechanism", "market_roles", "alternative_explanation", "counterevidence_search", "method_sha256"];
  const changed_fields = fields.filter(field => !prior || canonicalJson(prior[field]) !== canonicalJson(next[field]));
  const claims = next.claims.flatMap(claim => {
    const old = prior?.claims.find(item => item.claim_id === claim.claim_id);
    const keys = Object.keys(claim).filter(key => !old || canonicalJson(old[key]) !== canonicalJson(claim[key])).sort();
    return keys.length ? [{ claim_id: claim.claim_id, change: !old ? "added" : claim.status === "retired" && old.status !== "retired" ? "retired" : "modified",
      changed_fields: keys, previous_status: old?.status ?? null, proposed_status: claim.status }] : [];
  });
  return { changed_fields, claims, has_research_change: changed_fields.length > 0 || claims.length > 0, significance_verified: false };
}

export const THESIS_SCHEMA = `
CREATE TABLE thesis_heads(thesis_id TEXT PRIMARY KEY,watch_id TEXT NOT NULL REFERENCES watches(watch_id),
 current_revision INTEGER NOT NULL,review_revision INTEGER NOT NULL,evidence_revision INTEGER,interpretation_revision INTEGER) STRICT;
CREATE TABLE thesis_proposals(sequence INTEGER PRIMARY KEY AUTOINCREMENT,thesis_id TEXT NOT NULL REFERENCES thesis_heads(thesis_id),
 revision INTEGER NOT NULL,sha256 TEXT NOT NULL,proposal_json TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(thesis_id,revision)) STRICT;
CREATE TABLE thesis_reviews(sequence INTEGER PRIMARY KEY AUTOINCREMENT,review_id TEXT NOT NULL UNIQUE,
 thesis_id TEXT NOT NULL REFERENCES thesis_heads(thesis_id),revision INTEGER NOT NULL,sha256 TEXT NOT NULL,review_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,FOREIGN KEY(thesis_id,revision) REFERENCES thesis_proposals(thesis_id,revision)) STRICT;
CREATE TABLE thesis_manifest(singleton INTEGER PRIMARY KEY CHECK(singleton=1),sha256 TEXT NOT NULL) STRICT;
INSERT INTO thesis_manifest VALUES(1,'${contentHash({ heads: [], proposals: [], reviews: [] })}');
PRAGMA user_version=9;`;

export function thesisManifestHash(db) {
  return contentHash({ heads: db.prepare("SELECT * FROM thesis_heads ORDER BY thesis_id").all().map(row => ({ ...row })),
    proposals: db.prepare("SELECT sequence,thesis_id,revision,sha256,created_at FROM thesis_proposals ORDER BY sequence").all().map(row => ({ ...row })),
    reviews: db.prepare("SELECT sequence,review_id,sha256,created_at FROM thesis_reviews ORDER BY sequence").all().map(row => ({ ...row })) });
}

export function checkThesisReferences(db, proposal) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const revision = get("SELECT scope_json FROM revisions WHERE watch_id=? AND revision=?", proposal.scope.watch_id, proposal.scope.revision);
  if (!revision || canonicalJson(proposal.scope) !== revision.scope_json) thesisFail("THESIS_REFERENCE_MISSING", "Retain the exact watch scope first.");
  if (proposal.method_sha256 !== null) {
    const row = get("SELECT bundle_json FROM methods WHERE bundle_sha256=?", proposal.method_sha256);
    if (!row || verifyMethodBundle(JSON.parse(row.bundle_json)).bundle_sha256 !== proposal.method_sha256) thesisFail("THESIS_REFERENCE_MISSING", "Retain the exact method first.");
  }
  let run;
  if (proposal.origin.kind === "caller_agent") {
    const row = get("SELECT envelope_json,status FROM runs WHERE run_id=?", proposal.origin.run_id);
    run = row && JSON.parse(row.envelope_json);
    if (!run || row.status !== "completed" || run.trial || canonicalJson(run.scope) !== canonicalJson(proposal.scope) ||
        run.method.bundle_sha256 !== proposal.method_sha256 || !get("SELECT delivery_id FROM deliveries WHERE run_id=?", proposal.origin.run_id)) thesisFail("THESIS_ORIGIN_INVALID", "Bind the proposal to a completed scoped research delivery.");
  }
  for (const claim of proposal.claims) for (const evidence of claim.evidence_refs) {
    const ref = evidence.source_ref;
    const row = get("SELECT e.sha256,e.artifact_id,e.event_json,a.sha256 AS artifact_sha,a.metadata_json,a.bytes FROM source_events e JOIN artifacts a ON a.artifact_id=e.artifact_id WHERE e.event_id=?", ref.source_event_id);
    if (!row || row.sha256 !== ref.source_event_sha256 || row.artifact_id !== ref.source_artifact_id || row.artifact_sha !== ref.artifact_sha256 ||
        run && !run.source_refs.some(item => canonicalJson(item) === canonicalJson(ref))) thesisFail("THESIS_REFERENCE_MISSING", "Use retained source pins within the research run.");
    verifySourceReference(JSON.parse(row.event_json), JSON.parse(row.metadata_json), row.bytes, ref);
  }
}

// Replay checks preserve decisions and detect changed or deleted records. They do not authenticate a human or source.
export function verifyTheses(db) {
  const corrupt = () => thesisFail("THESIS_STORAGE_CORRUPT", "Retained thesis content or decisions changed. Preserve the workspace before recovery.");
  const heads = db.prepare("SELECT * FROM thesis_heads").all();
  const states = new Map();
  for (const row of db.prepare("SELECT * FROM thesis_proposals ORDER BY sequence").all()) {
    const p = validateThesisProposal(JSON.parse(row.proposal_json));
    if (canonicalJson(p) !== row.proposal_json || contentHash(p) !== row.sha256 || row.thesis_id !== p.thesis_id || row.revision !== p.revision ||
        !Number.isSafeInteger(row.created_at) || row.created_at < 0 || !Number.isSafeInteger(row.sequence) || row.sequence < 1) corrupt();
    checkThesisReferences(db, p);
    const prior = states.get(p.thesis_id);
    if (prior ? p.revision !== prior.current_revision + 1 || p.parent_sha256 !== prior.sha256 || prior.watch_id !== p.scope.watch_id ||
        prior.topic !== p.research_topic || prior.claim_ids.some(id => !p.claims.some(claim => claim.claim_id === id)) : p.revision !== 1) corrupt();
    states.set(p.thesis_id, { watch_id: p.scope.watch_id, current_revision: p.revision, review_revision: 0, evidence_revision: null,
      interpretation_revision: null, sha256: row.sha256, topic: p.research_topic, claim_ids: p.claims.map(claim => claim.claim_id) });
  }
  for (const row of db.prepare("SELECT * FROM thesis_reviews ORDER BY sequence").all()) {
    const r = validateThesisReview(JSON.parse(row.review_json)), state = states.get(r.thesis_id);
    const p = db.prepare("SELECT sha256,sequence,proposal_json FROM thesis_proposals WHERE thesis_id=? AND revision=?").get(r.thesis_id, r.revision);
    if (!state || !p || row.review_id !== r.review_id || row.thesis_id !== r.thesis_id || row.revision !== r.revision ||
        row.sha256 !== contentHash({ review: r, created_at: row.created_at }) || canonicalJson(r) !== row.review_json ||
        r.proposal_sha256 !== p.sha256 || r.expected_review_revision !== state.review_revision || !Number.isSafeInteger(row.created_at) || row.created_at < 0 ||
        !Number.isSafeInteger(row.sequence) || row.sequence < 1) corrupt();
    if (r.action === "accept_evidence") state.evidence_revision = r.revision;
    if (r.action === "accept_interpretation") {
      if (state.evidence_revision !== r.revision) corrupt();
      state.interpretation_revision = r.revision;
    }
    state.review_revision++;
  }
  if (states.size !== heads.length) corrupt();
  for (const head of heads) {
    const state = states.get(head.thesis_id);
    if (!state || ["watch_id", "current_revision", "review_revision", "evidence_revision", "interpretation_revision"].some(key => head[key] !== state[key])) corrupt();
  }
  const manifest = db.prepare("SELECT sha256 FROM thesis_manifest WHERE singleton=1").get();
  if (!manifest || manifest.sha256 !== thesisManifestHash(db)) corrupt();
}
