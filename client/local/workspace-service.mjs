import { canonicalJson, publicScope } from "./run-contract.mjs";
import { sessionConnection } from "./session-connection.mjs";
import { fileURLToPath } from "node:url";

export class WorkspaceServiceError extends Error {
  constructor(code, message) { super(message); this.name = "WorkspaceServiceError"; this.code = code; }
}
const fail = (code, message) => { throw new WorkspaceServiceError(code, message); };
const exact = (value, required, optional = []) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) {
    fail("WORKSPACE_INPUT_INVALID", "Use the required workspace fields only.");
  }
};
const text = (value, maximum, allowEmpty = false) => {
  if (typeof value !== "string" || value.length > maximum || !allowEmpty && !value.trim()) fail("WORKSPACE_INPUT_INVALID", "Use bounded workspace text.");
  return value;
};
const identifier = (value) => text(value, 500);
const proposalHash = (value) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("WORKSPACE_INPUT_INVALID", "Use the exact proposal hash.");
  return value;
};
const detached = (value) => JSON.parse(canonicalJson(value));
function page(input, optional = []) {
  exact(input, [], ["after", "limit", ...optional]);
  const after = input.after ?? 0; const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("WORKSPACE_INPUT_INVALID", "Use a nonnegative cursor and a page size from 1 to 100.");
  return { after, limit };
}
const paged = (items, options) => ({ items, next_after: items.length ? items.at(-1).sequence : options.after,
  has_more: items.length === options.limit, ...(Object.hasOwn(options, "order") ? { order: options.order } : {}) });
function researchPage(input) {
  const options = page(input, ["watch_id", "order"]);
  if (input.watch_id !== undefined) options.watch_id = identifier(input.watch_id);
  if (Object.hasOwn(input, "order")) {
    if (input.order !== "oldest" && input.order !== "newest") fail("WORKSPACE_INPUT_INVALID", "Use oldest or newest for the page order.");
    options.order = input.order;
  }
  return options;
}

// This service reads and reviews local records. It cannot invoke AI, purchase, or trade.
export class WorkspaceService {
  constructor(ledger) { this.ledger = ledger; }
  status() {
    const status = this.ledger.workspaceStatus();
    return detached({ schema_version: 1, counts: status.counts, runs: status.runs.slice(-100), gates: status.gates.slice(0, 100),
      run_count: status.runs.length, gate_count: status.gates.length,
      view_truncated: status.runs.length > 100 || status.gates.length > 100 });
  }
  watches(input = {}) { const options = page(input); return detached(paged(this.ledger.pageWatches(options), options)); }
  sessionOptions(input) {
    exact(input, ["watch_id"], ["methods_after", "sources_after", "preparations_after", "limit", "source_event_id", "method_sha256"]);
    const { watch_id, ...options } = input;
    return detached(this.ledger.workspaceSessionOptions(identifier(watch_id), options));
  }
  prepareSession(input) {
    exact(input, ["preparation_id", "watch_id", "revision", "method_sha256", "source_event_ids",
      "allow_private_context", "allow_candidate_method", "allow_external_submission", "confirm_no_sources"]);
    if (input.allow_private_context !== true || input.allow_candidate_method !== true || typeof input.allow_external_submission !== "boolean" ||
        !Array.isArray(input.source_event_ids) || typeof input.confirm_no_sources !== "boolean" ||
        input.confirm_no_sources !== (input.source_event_ids.length === 0)) fail("WORKSPACE_INPUT_INVALID", "Confirm private task access, the candidate method, and any missing evidence.");
    const { allow_private_context, allow_candidate_method, allow_external_submission, confirm_no_sources, ...request } = input;
    const consent = { allow_private_context, allow_candidate_method, allow_external_submission };
    const prepared = this.ledger.prepareExternalSession(request, consent);
    return detached(sessionConnection(this.ledger.directory, prepared, consent));
  }
  schedules(input = {}) {
    const options = page(input, ["watch_id"]);
    if (input.watch_id !== undefined) options.watch_id = identifier(input.watch_id);
    return detached(paged(this.ledger.pageSchedules(options), options));
  }
  observationPlan(input) {
    exact(input, ["schedule_id", "revision", "config_sha256"]);
    const plan = this.ledger.scheduleObservationPlan(identifier(input.schedule_id), input);
    const messages = {
      SCHEDULE_STOPPED: "Tracking is stopped. Review a new configuration before restarting.",
      SCHEDULE_SCOPE_CHANGED: "The watch changed. Update tracking for its current revision.",
      OBSERVATION_SCHEDULE_REQUIRED: "This schedule includes AI research. Use its separately approved runner setup.",
      SOURCE_RIGHTS_GATED: "Document permitted local source use before starting checks.",
      WORKER_ALREADY_RUNNING: "A worker is already monitoring this schedule.",
      SOURCE_CHECK_RUNNING: "A source check is running. Wait for its result before starting another worker."
    };
    // Paths come from this installed process, never from browser-supplied commands.
    const args = [fileURLToPath(new URL("../../bin/equitylayer.mjs", import.meta.url)), "local", "schedule-daemon-observe",
      "--workspace", this.ledger.directory, "--schedule-id", plan.schedule_id, "--revision", String(plan.revision),
      "--config-sha256", plan.config_sha256, "--allow-continuous"];
    const values = [process.execPath, ...args];
    if (values.some(value => /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)))
      fail("WORKSPACE_INPUT_INVALID", "Use printable paths and tracking identifiers for terminal instructions.");
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    return detached({ ...plan, message: plan.code ? messages[plan.code] : "Run source checks in a separate terminal. No AI starts.",
      command: plan.available ? { command: process.execPath, args } : null,
      shell_command: plan.available ? values.map(quote).join(" ") : null,
      worker_started: false, ai_execution_authorized: false, service_installation_performed: false,
      source_rights_verified: false, commercial_reuse_authorized: false, payment_authorized: false, trading_authorized: false });
  }
  stopSchedule(input) {
    exact(input, ["schedule_id", "revision", "config_sha256", "confirm_stop"]);
    if (input.confirm_stop !== true) fail("WORKSPACE_INPUT_INVALID", "Confirm that tracking must stop.");
    this.ledger.stopSchedule(identifier(input.schedule_id), { revision: input.revision, config_sha256: input.config_sha256 });
    return detached({ stopped: true, schedule: this.ledger.scheduleStatus(input.schedule_id), accepted_evidence: false, accepted_interpretation: false });
  }
  theses(input = {}) {
    const options = researchPage(input);
    return detached(paged(this.ledger.pageTheses(options), options));
  }
  thesisDetail(hash) { return detached(this.ledger.workspaceThesis(proposalHash(hash))); }
  thesisSources(input) {
    exact(input, ["proposal_sha256"], ["after", "limit"]);
    const { proposal_sha256, ...rest } = input; const options = page(rest);
    return detached(paged(this.ledger.pageThesisSources(proposalHash(proposal_sha256), options), options));
  }
  thesisReviews(input) {
    exact(input, ["proposal_sha256"], ["after", "limit"]);
    const { proposal_sha256, ...rest } = input; const options = page(rest);
    return detached(paged(this.ledger.pageThesisReviews(proposalHash(proposal_sha256), options), options));
  }
  reviewThesis(input) {
    exact(input, ["review_id", "thesis_id", "revision", "proposal_sha256", "expected_review_revision", "action", "note", "actor", "confirm_human_review"]);
    if (input.confirm_human_review !== true) fail("WORKSPACE_INPUT_INVALID", "Confirm the local human review.");
    const { confirm_human_review, ...review } = input;
    const result = this.ledger.reviewThesis(review, { confirm_human_review });
    return detached({ ...result, thesis: this.thesisDetail(input.proposal_sha256) });
  }
  inbox(input = {}) {
    const options = researchPage(input);
    return detached(paged(this.ledger.pageInbox(options), options));
  }
  delivery(id) {
    const result = this.ledger.workspaceDelivery(identifier(id));
    if (!result) fail("WORKSPACE_NOT_FOUND", "The local delivery does not exist.");
    return detached(result);
  }
  externalResearch(input = {}) {
    const options = researchPage(input);
    return detached(paged(this.ledger.pageExternalResearch(options), options));
  }
  externalRecord(id) {
    const value = this.ledger.workspaceExternalSessionRecord(identifier(id));
    if (!value) fail("WORKSPACE_NOT_FOUND", "The external research record does not exist.");
    return detached(value);
  }
  externalReviews(input) {
    exact(input, ["external_record_id"], ["after", "limit"]);
    const { external_record_id, ...rest } = input; const options = page(rest);
    return detached(paged(this.ledger.pageExternalReviews(identifier(external_record_id), options), options));
  }
  reviewExternal(input) {
    exact(input, ["external_record_id", "action", "note", "review_id", "expected_revision", "confirm_human_review"]);
    const { confirm_human_review, ...request } = input;
    const value = this.ledger.reviewExternalSession(request, { confirm_human_review });
    return detached({ ...value, external_record: this.externalRecord(input.external_record_id) });
  }
  notices(input = {}) { const options = page(input); return detached(paged(this.ledger.pageNotices(options), options)); }
  reviews(input) {
    exact(input, ["delivery_id"], ["after", "limit"]); const { delivery_id, ...rest } = input; const options = page(rest);
    return detached(paged(this.ledger.pageReviews(identifier(delivery_id), options), options));
  }
  legacy(input) {
    exact(input, ["watch_id"], ["after", "limit"]); const { watch_id, ...rest } = input; const options = page(rest);
    return detached(paged(this.ledger.pageLegacyResults(identifier(watch_id), options), options));
  }
  legacyResult(id) {
    const result = this.ledger.workspaceLegacyResult(identifier(id));
    if (!result) fail("WORKSPACE_NOT_FOUND", "The local legacy result does not exist.");
    return detached(result);
  }
  saveWatch(input) {
    exact(input, ["scope", "private_context"]);
    const scope = publicScope(input.scope);
    exact(input.private_context, ["question", "trigger"], ["component"]);
    const context = { question: text(input.private_context.question, 600), trigger: text(input.private_context.trigger, 600),
      component: text(input.private_context.component ?? "", 100, true) };
    const saved = this.ledger.saveRevision(scope, context);
    return detached({ watch_id: saved.scope.watch_id, revision: saved.scope.revision, local_context_sha256: saved.local_context_sha256,
      execution_authorized: false });
  }
  review(input) {
    exact(input, ["delivery_id", "action", "note", "review_id", "expected_revision"]);
    const result = this.ledger.review(identifier(input.delivery_id), text(input.action, 32), text(input.note, 1200),
      identifier(input.review_id), input.expected_revision, { acknowledge_notice: true });
    return detached({ ...result, delivery: this.delivery(input.delivery_id) });
  }
  acknowledge(input) {
    exact(input, ["notice_id"]); this.ledger.acknowledgeNotice(identifier(input.notice_id));
    return { acknowledged: true, notice_id: input.notice_id, accepted_evidence: false, accepted_interpretation: false };
  }
  importLegacy(input) {
    exact(input, ["archive_base64"]);
    if (typeof input.archive_base64 !== "string" || input.archive_base64.length > 2_666_668 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.archive_base64)) fail("WORKSPACE_INPUT_INVALID", "Use a bounded base64 workspace archive.");
    const bytes = Buffer.from(input.archive_base64, "base64");
    if (bytes.toString("base64") !== input.archive_base64) fail("WORKSPACE_INPUT_INVALID", "Use canonical base64 archive bytes.");
    return detached({ ...this.ledger.importLegacyWorkspace(bytes), provenance_status: "unknown", acceptance_status: "legacy-unclassified" });
  }
}
