import { scope } from "./local-research.mjs";

export const thesisScope = (revision = 1) => ({ ...scope(revision), theme_id: "ai_compute", symbols: ["NVDA", "2383.TW"] });
export function proposal(ref = null, patch = {}) {
  return { schema_version: 1, thesis_id: "synthetic-ccl", revision: 1, parent_sha256: null, scope: thesisScope(), research_topic: "pcb_ccl",
    origin: { kind: "human", author_id: "synthetic-owner", run_id: null }, method_sha256: null,
    title: "Synthetic material-upgrade question", mechanism: "Synthetic requirements may change the material mix. This is not company evidence.",
    novelty: { kind: "manual_intuition", reason: "Synthetic thesis intake." },
    market_roles: [{ symbol: "NVDA", market: "US", role: "demand" }, { symbol: "2383.TW", market: "TW", role: "materials" }],
    claims: [{ claim_id: "synthetic-upgrade", statement: "Synthetic material adoption remains unknown.", kind: "hypothesis", status: "unknown",
      economic_stage: "qualification", symbols: ["2383.TW"], period: null, unit: null, denominator: null,
      evidence_refs: ref ? [{ document_id: "synthetic-document", local_source_id: "S01", source_ref: ref, locator: "Synthetic row.", relation: "context" }] : [],
      required_evidence: ["A dated qualification statement."], falsifiers: ["A lower-cost material passes the same requirements."],
      inference_limits: ["A datasheet does not prove shipments or margins."] }],
    alternative_explanation: "The existing material may meet the requirement.", counterevidence_search: "searched_none_found",
    next_check: "Check the next dated source event.", ...patch };
}
export const thesisReview = (retained, action, expected = 0, patch = {}) => ({ review_id: `synthetic-review-${expected}`, thesis_id: retained.thesis_id,
  revision: retained.revision, proposal_sha256: retained.sha256, expected_review_revision: expected, action,
  note: "Synthetic owner review, not an investment conclusion.", actor: { kind: "human", actor_id: "synthetic-owner" }, ...patch });
