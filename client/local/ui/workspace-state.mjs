import { executionFailureSummary } from "../execution-diagnostics.mjs";

export const THEMES = Object.freeze({ ai_compute: "AI Compute", optical_cpo: "Optical / CPO", ai_power_thermal: "AI Power & Thermal", physical_ai: "Physical AI", space_infrastructure: "Space Infrastructure" });
export const STAGES = Object.freeze(["chip", "memory", "rack", "network", "facility", "cooling", "power", "grid"]);
export const ACTIONS = Object.freeze({ received: "Received", accept_evidence: "Accept evidence", accept_interpretation: "Accept interpretation", revisit: "Revisit", reject: "Reject" });
export const THESIS_ACTIONS = Object.freeze({ ...ACTIONS, accept_interpretation: "Adopt thesis" });
export const TOKEN_KEY = "equitylayer.workspace.token";
export const MAX_ARCHIVE_BYTES = 2_000_000;

export function executionGateDisplay(gate) {
  const value = gate?.execution_failure;
  // Rebuild from the shared fixed-code contract. Never display provider text as recovery instructions.
  const failure = value && executionFailureSummary({ schema_version: value.schema_version, failure_code: value.failure_code,
    request_id: value.request_id, dispatch_state: value.dispatch_state });
  const unknown = gate?.gate_code === "USAGE_UNKNOWN";
  if (!failure && !unknown) return null;
  return {
    title: failure ? "Research did not complete" : "Usage needs review",
    detail: failure?.message ?? "No verified usage receipt is available.",
    accounting: unknown ? "Usage is unconfirmed. The budget reservation remains held." : "This workspace does not start an automatic retry.",
    next: unknown ? "Check your AI command and account separately. Do not retry this request until usage is resolved."
      : "Review this failure before another attempt. Your accepted research remains unchanged.",
    failure_code: failure?.failure_code ?? null, request_id: failure?.request_id ?? null,
  };
}

export function trackingDisplay(item) {
  if (!item.enabled) return { label: "Stopped", tone: "muted", detail: "No new checks will start." };
  if (!item.is_current_scope) return { label: "Scope changed", tone: "warning", detail: "Update tracking for the current watch revision." };
  if (item.source_rights_status !== "ALLOWED") return { label: "Source permission needed", tone: "warning", detail: "Tracking cannot use this source until its local permission is resolved." };
  if (item.worker_state === "checking") return { label: "Checking now", tone: "active", detail: "A worker holds the current check." };
  if (item.worker_state === "interrupted") return { label: "Interrupted", tone: "warning", detail: "Restart the worker to recover this check." };
  if (item.worker_state === "offline") return { label: "Worker offline", tone: "warning", detail: "No current worker heartbeat is recorded. Restart tracking after checking the issue." };
  if (item.last_tick?.status === "failed") return { label: "Last check failed", tone: "warning", detail: "Read the issue below. Restart the worker after resolving it." };
  if (item.last_tick?.status === "gated") return { label: "Last check blocked", tone: "warning", detail: "Read the issue below before the next check." };
  if (item.worker_state === "monitoring") return { label: "Monitoring", tone: "active", detail: "A current worker heartbeat is recorded. Checks follow the configured interval." };
  return { label: item.state === "due" ? "Check due" : item.state === "configured" ? "Not checked yet" : "Next check pending",
    tone: "muted", detail: "A configured schedule does not prove that a background worker is running." };
}
export function makeStopTrackingRequest(item) {
  if (!item?.enabled || typeof item.schedule_id !== "string" || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(item.config_sha256 ?? "")) throw new WorkspaceRequestError("Refresh tracking before you stop it.");
  return Object.freeze({ schedule_id: item.schedule_id, revision: item.revision, config_sha256: item.config_sha256, confirm_stop: true });
}

export class WorkspaceRequestError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export function readToken(location, history, storage) {
  const fragment = location.hash ?? "";
  const hasTokenFragment = Boolean(fragment) && fragment !== "#inbox-heading";
  const token = /^#token=([a-f0-9]{64})$/.exec(fragment)?.[1];
  if (fragment) history.replaceState(null, "", `${location.pathname}${location.search}`);
  try {
    if (hasTokenFragment) {
      storage.removeItem(TOKEN_KEY);
      if (token) storage.setItem(TOKEN_KEY, token);
    }
    const saved = storage.getItem(TOKEN_KEY);
    return token ?? (!hasTokenFragment && /^[a-f0-9]{64}$/.test(saved ?? "") ? saved : null);
  } catch { return token ?? null; }
}
export function clearToken(storage) { try { storage.removeItem(TOKEN_KEY); } catch {} }
export function safeSourceURL(value) {
  try {
    if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function acceptanceGate(detail) {
  if (!detail?.delivery_id && !detail?.external_record_id) return "Legacy provenance is unknown. This record cannot become new accepted evidence.";
  if (!detail.is_current_revision) return "The watch scope changed. Acceptance is disabled for this revision.";
  if (detail.result?.result_state === "SOURCE_NEEDED") return "Sources are required. Acceptance is disabled for this result.";
  if (detail.kind === "external" && !Object.hasOwn(detail, "acceptance_gate")) return "Acceptance checks did not load. Refresh the result.";
  if (detail.acceptance_gate) return `Acceptance is blocked: ${detail.acceptance_gate}. Check the source permissions and current research scope.`;
  return null;
}
export function makeWatchRequest(values, existing, uuid) {
  const symbols = values.symbols.split(/[\s,]+/).filter(Boolean).map((symbol) => symbol.toUpperCase());
  if (symbols.length < 1 || symbols.length > 20 || new Set(symbols).size !== symbols.length ||
      symbols.some((symbol) => !/^[A-Z0-9][A-Z0-9.^-]{0,29}$/.test(symbol))) {
    throw new WorkspaceRequestError("Use 1 to 20 unique company symbols. Use letters, numbers, periods, carets, or hyphens.");
  }
  if (!Object.hasOwn(THEMES, values.theme_id) || values.stage_id &&
      (values.theme_id !== "ai_compute" || !STAGES.includes(values.stage_id))) throw new WorkspaceRequestError("Select a supported theme and stage.");
  for (const [field, maximum] of [["question", 600], ["trigger", 600]]) {
    if (typeof values[field] !== "string" || !values[field].trim() || values[field].length > maximum) {
      throw new WorkspaceRequestError(`Enter ${field} text from 1 to ${maximum} characters.`);
    }
  }
  if ((values.component ?? "").length > 100) throw new WorkspaceRequestError("Use at most 100 characters for the component.");
  return { scope: { watch_id: existing?.watch_id ?? uuid(), revision: existing ? existing.current_revision + 1 : 1,
    theme_id: values.theme_id, ...(values.stage_id ? { stage_id: values.stage_id } : {}), symbols: symbols.sort() },
    private_context: { question: values.question, trigger: values.trigger, component: values.component ?? "" } };
}
export function makeReviewRequest(detail, action, note, uuid) {
  if (!Object.hasOwn(ACTIONS, action)) throw new WorkspaceRequestError("Select a review action.");
  if (typeof note !== "string" || !note.trim() || note.length > 1200) throw new WorkspaceRequestError("Enter a review reason from 1 to 1200 characters.");
  if (!detail?.delivery_id && !detail?.external_record_id) throw new WorkspaceRequestError("Select a research result before you submit a review.");
  if (action.startsWith("accept_") && acceptanceGate(detail)) throw new WorkspaceRequestError(acceptanceGate(detail));
  return Object.freeze({ ...(detail.external_record_id ? { external_record_id: detail.external_record_id, confirm_human_review: true } : { delivery_id: detail.delivery_id }),
    action, note, review_id: uuid(), expected_revision: detail.review_revision });
}
export function thesisAcceptanceGate(detail, action, sourcesComplete = true) {
  if (!detail || detail.kind !== "thesis") return "Select a thesis revision before review.";
  if (!action.startsWith("accept_")) return null;
  if (!detail.is_current_revision) return "Acceptance requires the current thesis and watch scope.";
  if (!sourcesComplete) return "Load the remaining sources before acceptance.";
  if (!detail.acceptance_gates || !Object.hasOwn(detail.acceptance_gates, action)) return "Acceptance gates did not load. Refresh the thesis.";
  return detail.acceptance_gates[action]?.message ?? null;
}
export function makeThesisReviewRequest(detail, action, note, uuid, sourcesComplete = true) {
  if (!Object.hasOwn(THESIS_ACTIONS, action)) throw new WorkspaceRequestError("Select a review action.");
  if (typeof note === "string") note = note.trim();
  if (typeof note !== "string" || !note.trim() || note.length > 1200) throw new WorkspaceRequestError("Enter a review reason from 1 to 1200 characters.");
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(note)) throw new WorkspaceRequestError("Use one line of printable text for the thesis review reason. Remove control characters.");
  const gate = thesisAcceptanceGate(detail, action, sourcesComplete);
  if (gate) throw new WorkspaceRequestError(gate);
  return Object.freeze({ review_id: uuid(), thesis_id: detail.thesis_id, revision: detail.revision,
    proposal_sha256: detail.sha256, expected_review_revision: detail.review_revision, action, note,
    actor: { kind: "human", actor_id: "local-workspace-owner" }, confirm_human_review: true });
}
export function emptyPage() { return { items: [], next_after: 0, has_more: false }; }
export function mergeTrackingPage(previous, next) {
  const text = value => typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value);
  const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
  const valid = item => item && Number.isSafeInteger(item.sequence) && item.sequence > 0 &&
    text(item.schedule_id) && text(item.watch_id) && text(item.theme_id) && text(item.source_id) &&
    Number.isSafeInteger(item.revision) && item.revision > 0 && /^[a-f0-9]{64}$/.test(item.config_sha256 ?? "") &&
    Array.isArray(item.symbols) && item.symbols.length > 0 && item.symbols.length <= 100 && item.symbols.every(text) &&
    typeof item.enabled === "boolean" && typeof item.is_current_scope === "boolean" &&
    ["stopped", "running", "interrupted", "due", "waiting", "configured"].includes(item.state) &&
    ["ALLOWED", "HOLD", "UNKNOWN", "MISSING"].includes(item.source_rights_status) &&
    ["checking", "interrupted", "not_verified", "monitoring", "offline"].includes(item.worker_state) &&
    (item.last_worker_seen_at === undefined || item.last_worker_seen_at === null || time(item.last_worker_seen_at)) &&
    (item.worker_code === undefined || item.worker_code === null || text(item.worker_code)) &&
    ["observation_only", "research_configured"].includes(item.mode) && time(item.next_due) &&
    (item.last_finished_at === null || time(item.last_finished_at)) &&
    (item.last_tick === null || item.last_tick &&
      ["completed", "failed", "gated", "interrupted"].includes(item.last_tick.status) &&
      Array.isArray(item.last_tick.codes) && item.last_tick.codes.length <= 100 && item.last_tick.codes.every(text));
  if (!Array.isArray(next?.items) || !next.items.every(valid)) {
    throw new WorkspaceRequestError("The server returned invalid tracking records. Refresh tracking status.");
  }
  return mergePage(previous, next);
}
export function mergePage(previous, next) {
  if (!next || !Array.isArray(next.items) || !Number.isSafeInteger(next.next_after) || next.next_after < 0 || typeof next.has_more !== "boolean" ||
      Object.hasOwn(next, "order") && !["oldest", "newest"].includes(next.order) ||
      previous.items.length && previous.order !== next.order && (previous.order === "newest" || next.order === "newest")) {
    throw new WorkspaceRequestError("The server returned an invalid page. Refresh the workspace.");
  }
  if (next.order === "newest") {
    const boundary = previous.next_after;
    if (next.items.length > 100 || next.items.some((item, index) => !Number.isSafeInteger(item?.sequence) || item.sequence < 1 ||
        index > 0 && item.sequence >= next.items[index - 1].sequence || boundary > 0 && item.sequence >= boundary) ||
        (next.items.length ? next.next_after !== next.items.at(-1).sequence : next.has_more || next.next_after !== boundary)) {
      throw new WorkspaceRequestError("The server returned an invalid page. Refresh the workspace.");
    }
    return { items: [...previous.items, ...next.items].sort((a, b) => b.sequence - a.sequence),
      next_after: next.next_after, has_more: next.has_more, order: "newest" };
  }
  if (next.has_more && next.next_after <= previous.next_after) throw new WorkspaceRequestError("The page cursor did not advance. Refresh the workspace.");
  const bySequence = new Map(previous.items.map((item) => [item.sequence, item]));
  next.items.forEach((item) => bySequence.set(item.sequence, item));
  return { items: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence), next_after: next.next_after, has_more: next.has_more,
    ...(Object.hasOwn(next, "order") ? { order: next.order } : {}) };
}
export function filterInbox(items, { theme = "", company = "", watch = "" }) {
  return items.filter((item) => (!theme || item.result.theme_id === theme) &&
    (!company || item.result.symbols.includes(company)) && (!watch || item.result.watch_id === watch));
}
export function filterTheses(items, { theme = "", company = "", watch = "" }) {
  return items.filter((item) => (!theme || item.scope.theme_id === theme) &&
    (!company || item.scope.symbols.includes(company)) && (!watch || item.watch_id === watch));
}
export function errorMessage(error) {
  if (error.code === "SCHEDULE_CONFLICT") return "Tracking changed. Refresh its status before stopping it.";
  if (error.status === 403) return "The access token is missing or expired. Open a new workspace link from the local command.";
  if (error.status === 409 || ["REVIEW_CONFLICT", "REVISION_CONFLICT"].includes(error.code)) return "The local record changed. Refresh the record. Check your reason before you retry.";
  if (error.status >= 500 || !error.status || error.code === "STORAGE_WRITE_UNCERTAIN") return "The reply is uncertain. Check the current record before you retry the exact request.";
  return `The server rejected the request (${error.code || "REQUEST_FAILED"}). Check the record before you retry.`;
}
export function createWorkspaceAPI({ fetchImpl, token, onLocked = () => {} }) {
  let locked = !token;
  async function request(path, body) {
    if (locked) throw new WorkspaceRequestError("AUTH_REQUIRED", 403);
    if (!/^\/api\/[a-z0-9/?=&._-]+$/i.test(path) || path.includes("//")) throw new WorkspaceRequestError("REQUEST_PATH_INVALID", 400);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      if (body !== undefined) { headers["Content-Type"] = "application/json"; headers["X-EquityLayer-Request"] = "1"; }
      let response;
      try { response = await fetchImpl(path, { method: body === undefined ? "GET" : "POST", headers,
        credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
      catch { throw new WorkspaceRequestError("REPLY_UNCERTAIN"); }
      if (response.status === 403) { locked = true; token = null; onLocked(); }
      let value;
      try { value = await response.json(); } catch { throw new WorkspaceRequestError("REPLY_INVALID"); }
      if (!response.ok) {
        throw new WorkspaceRequestError(value?.code ?? "REQUEST_FAILED", response.status);
      }
      return value;
    } finally { clearTimeout(timer); }
  }
  return { read: (path) => request(path), write: (path, body) => request(path, body), lock() { locked = true; token = null; } };
}
// Keep requests in memory. An uncertain review must retain its exact ID and revision.
export function createWriteCoordinator(api, onConflict = async () => {}) {
  let pending = null;
  let busy = false;
  let epoch = 0;
  async function submit(path, body, retry = false) {
    if (busy) throw new WorkspaceRequestError("A request is in progress. Wait for its reply.", 400);
    if (pending && !retry) throw new WorkspaceRequestError("Resolve the pending request before you submit another request.", 400);
    if (retry && !pending) throw new WorkspaceRequestError("There is no pending request to retry.", 400);
    pending = pending ?? { path, body: JSON.parse(JSON.stringify(body)), outcome: "pending" };
    const attempt = pending;
    const current = epoch;
    busy = true;
    try {
      const value = await api.write(attempt.path, attempt.body);
      pending = null;
      return value;
    } catch (error) {
      if (current !== epoch) throw error;
      if (error.status === 409 || ["REVIEW_CONFLICT", "REVISION_CONFLICT"].includes(error.code)) {
        pending.outcome = "conflict";
        await onConflict();
      } else if (!error.status || error.status >= 500 || error.code === "STORAGE_WRITE_UNCERTAIN") {
        pending.outcome = "uncertain";
      } else pending = null;
      throw error;
    } finally { busy = false; }
  }
  return { submit, retry: () => submit(null, null, true), get pending() { return pending; }, get busy() { return busy; },
    discardConflict() { if (!busy && pending?.outcome === "conflict") pending = null; },
    clear() { epoch++; pending = null; } };
}
