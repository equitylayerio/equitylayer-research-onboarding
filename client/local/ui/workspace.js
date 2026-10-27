(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const button = (text, handler, className) => {
    const node = element("button", text, className); node.type = "button";
    node.addEventListener("click", handler); return node;
  };
  const human = (value) => String(value ?? "Unknown").replace(/_/g, " ");
  const date = (value) => typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : value ?? "Not recorded";
  const trackingDate = value => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const timestamp = (value) => typeof value === "number" ? value : Date.parse(value) || 0;
  // Use the verified local receipt, not task preparation, for Inbox arrival.
  const receiptTime = (item) => Number.isSafeInteger(item?.received_at) && item.received_at >= 0 && item.received_at <= 8_640_000_000_000_000 ? item.received_at : null;
  const uuid = () => crypto.randomUUID();
  let tokenStorage;
  try { tokenStorage = sessionStorage; } catch { tokenStorage = { getItem: () => null, setItem() {}, removeItem() {} }; }
  let token = readToken(location, history, tokenStorage);
  let selected = null;
  let detail = null;
  let sessionUI = null;
  let researchNotice = null;
  let editing = null;
  let editorOpen = false;
  let refreshBusy = false;
  let pollCount = 0;
  let generation = 0;
  let detailGeneration = 0;
  let pageEpoch = 0;
  let pollScheduled = false;
  let status = null;
  let tracking = emptyPage(), trackingError = null;
  const trackingPlans = new Map();
  let watches = emptyPage(), inbox = emptyPage(), external = emptyPage(), theses = emptyPage(), sources = emptyPage(), notices = emptyPage(), legacy = emptyPage(), journal = emptyPage();
  let historyComplete = false;
  let inboxKind = "all";
  const filters = { theme: "", company: "", watch: "" };
  function message(text = "", isError = false) {
    $("status-message").textContent = text; $("status-message").dataset.error = String(isError);
  }
  function locked() {
    token = null; clearToken(tokenStorage); selected = detail = editing = status = null;
    editorOpen = false; api.lock(); writes.clear();
    sessionUI?.clear(); researchNotice = null;
    watches = inbox = external = theses = sources = notices = legacy = journal = emptyPage(); generation++; detailGeneration++;
    tracking = emptyPage(); trackingError = null; trackingPlans.clear();
    $("workspace").hidden = true; $("locked").hidden = false; $("connection").textContent = "Locked";
    $("refresh").disabled = true; $("lock").disabled = true;
    for (const id of ["detail-summary", "detail", "inbox", "watches", "notices", "gates", "tracking", "legacy-results", "history-items", "pending-request"]) $(id).replaceChildren();
    for (const id of ["question-input", "trigger-input", "component-input", "symbols-input", "review-note"]) $(id).value = "";
    message("The access token is missing or expired. Open a new workspace link from the local command.", true);
  }
  const api = createWorkspaceAPI({ fetchImpl: (...args) => fetch(...args), token, onLocked: locked });
  const writes = createWriteCoordinator(api, async () => { await refresh({ announce: false }); });
  sessionUI = createSessionPreparation({ document, api, writes, uuid, onError: error => showError(error),
    onChange: () => renderPending(), onSaved: async () => { await refresh({ announce: false }); message("Task prepared. Connect it in your AI client. No AI request started."); },
    onOpenResult: id => openExternal(id) });
  function showError(error) { message(error instanceof WorkspaceRequestError ? (error.code.includes(" ") ? error.code : errorMessage(error)) : "The operation failed. Refresh the workspace before you retry.", true); }
  function loading(container) {
    container.replaceChildren(); container.setAttribute("aria-busy", "true");
    for (let i = 0; i < 3; i++) { const node = element("div", "", "loading"); node.setAttribute("aria-hidden", "true"); container.append(node); }
    container.append(element("p", "Loading local records…", "sr-only"));
  }
  function empty(container, heading, text) { const section = element("div", undefined, "empty"); section.append(element("h2", heading), element("p", text)); container.replaceChildren(section); }
  function pageURL(route, page, parameters = {}) {
    const query = new URLSearchParams({ after: String(page.next_after), limit: "50",
      ...(["inbox", "external-research", "theses"].includes(route) ? { order: "newest" } : {}), ...parameters });
    return `/api/${route}?${query}`;
  }
  function renderThemes() {
    const container = $("themes"); container.replaceChildren();
    for (const [id, label] of [["", "All themes"], ...Object.entries(THEMES)]) {
      const node = button(label, () => { filters.theme = id; renderThemes(); renderInbox(); });
      node.setAttribute("aria-pressed", String(filters.theme === id)); container.append(node);
    }
  }
  function renderWatches() {
    const container = $("watches"); container.replaceChildren();
    const all = button("All watches", () => selectWatch(null)); all.setAttribute("aria-pressed", String(!filters.watch)); container.append(all);
    for (const watch of watches.items) {
      const node = button(`${watch.scope.symbols.join(" · ")} · r${watch.current_revision}`, () => selectWatch(watch));
      node.setAttribute("aria-pressed", String(filters.watch === watch.watch_id)); container.append(node);
    }
    if (!watches.items.length) container.append(element("p", "Save your first watch to define a thesis question.", "field-help"));
    $("more-watches").hidden = !watches.has_more;
    if (filters.watch && !watches.items.some((watch) => watch.watch_id === filters.watch)) container.append(element("p", "The selected watch is outside this refreshed page. Load more watches to read its current scope.", "field-help"));
    const company = $("company-filter"); company.replaceChildren(element("option", "All companies")); company.firstChild.value = "";
    const symbols = [...new Set([...watches.items.flatMap((watch) => watch.scope.symbols), ...inbox.items.flatMap((item) => item.result.symbols), ...external.items.flatMap((item) => item.result.symbols), ...theses.items.flatMap((item) => item.scope.symbols)])].sort();
    for (const symbol of symbols) { const option = element("option", symbol); option.value = symbol; company.append(option); }
    company.value = filters.company;
  }
  function renderGates() {
    const container = $("gates"); container.replaceChildren();
    for (const gate of status?.gates ?? []) {
      const row = element("div", undefined, "gate-row"), display = executionGateDisplay(gate);
      if (display) {
        row.append(element("strong", display.title), element("p", display.detail), element("p", display.accounting), element("p", display.next));
        const technical = element("details"); technical.append(element("summary", "Technical details"), element("p", gate.gate_code));
        if (display.failure_code) technical.append(element("p", display.failure_code));
        if (display.request_id) technical.append(element("p", display.request_id));
        const reference = gate.source_event_id ?? gate.run_id ?? gate.notice_id;
        if (reference) technical.append(element("p", reference));
        row.append(technical);
      } else row.append(element("strong", gate.gate_code), element("span", gate.source_event_id ?? gate.run_id ?? gate.notice_id));
      container.append(row);
    }
    if (!status?.gates?.length) container.append(element("p", "No current gates are recorded.", "field-help"));
    if (status?.view_truncated) container.append(element("p", `This status view is bounded. ${status.gate_count} gates and ${status.run_count} runs remain in the local record.`, "field-help"));
  }
  function renderNotices() {
    const needsResearch = notices.items.filter(notice => notice.payload?.kind === "research_needed" &&
      watches.items.some(watch => watch.watch_id === notice.payload.watch_id && watch.current_revision === notice.payload.scope_revision)).length;
    $("notice-count").textContent = `(${notices.items.length}${notices.has_more ? "+" : ""}${needsResearch ? ` · ${needsResearch} need research` : ""})`;
    const container = $("notices"); container.replaceChildren();
    for (const notice of notices.items) {
      const row = element("div", undefined, "notice-row");
      if (notice.payload?.kind === "research_needed") {
        const watch = watches.items.find(item => item.watch_id === notice.payload.watch_id);
        const current = watch && watch.current_revision === notice.payload.scope_revision;
        row.append(element("strong", current ? "New evidence needs research" : "Evidence update"),
          element("p", `${watch ? watch.scope.symbols.join(" · ") : "Watch not loaded"} · ${notice.payload.source_period ?? "Period not specified"}`, "detail-meta"),
          element("p", "Choose evidence and connect your AI. This notice does not start research.", "field-help"));
        if (current) row.append(button("Research with my AI", async () => {
          if (writes.busy || writes.pending) { message("Resolve the pending operation before opening this update.", true); return; }
          await selectWatch(watch, notice.payload);
          const heading = $("detail").querySelector("h1");
          if (filters.watch === watch.watch_id && !selected && !editorOpen && heading) {
            $("workspace").dataset.detail = "true"; heading.tabIndex = -1; heading.focus();
          }
        }));
        else row.append(element("p", watch ? "This update belongs to an earlier watch revision." : "Load this watch from Themes and companies to inspect the update.", "field-help"));
        const pins = element("details"); pins.append(element("summary", "Evidence references"), element("pre", JSON.stringify(notice.payload, null, 2))); row.append(pins);
      } else row.append(element("strong", notice.payload?.gate_code ?? "Local notice"), element("pre", JSON.stringify(notice.payload, null, 2)));
      const acknowledge = button("Acknowledge notice", () => mutate("/api/notices/acknowledge", { notice_id: notice.notice_id }, "Notice acknowledged. Evidence and interpretation did not change."));
      acknowledge.dataset.write = "true"; row.append(acknowledge); container.append(row);
    }
    if (!notices.items.length) container.append(element("p", "No unacknowledged notices are loaded.", "field-help"));
    $("more-notices").hidden = !notices.has_more;
  }
  function renderTracking() {
    const container = $("tracking"); container.replaceChildren(); container.setAttribute("aria-busy", "false");
    $("more-tracking").hidden = !tracking.has_more || !!trackingError;
    if (trackingError) {
      $("tracking-count").textContent = "· status unavailable";
      container.append(element("p", "Tracking status is unavailable. Existing records remain unchanged.", "field-help"),
        button("Retry tracking status", () => refresh({ announce: false })));
      return;
    }
    const items = tracking.items.filter(item => (!filters.watch || item.watch_id === filters.watch) &&
      (!filters.theme || item.theme_id === filters.theme) && (!filters.company || item.symbols.includes(filters.company)));
    const attention = items.filter(item => trackingDisplay(item).tone === "warning").length;
    $("tracking-count").textContent = `· ${items.length}${tracking.has_more ? "+" : ""}${attention ? ` · ${attention} need attention` : ""}`;
    for (const item of items) {
      const state = trackingDisplay(item), row = element("article", undefined, "tracking-row");
      row.append(element("h3", item.symbols.join(" · ")));
      const label = element("p", state.label, "tracking-state"); label.dataset.tone = state.tone; row.append(label);
      row.append(element("p", state.detail, "field-help"));
      row.append(element("p", `${item.source_id === "twse_listed_monthly_revenue_v1" ? "TWSE monthly revenue" : human(item.source_id)} · ${item.mode === "observation_only" ? "Source checks only" : "Research configured"}`, "muted"));
      row.append(element("p", `Last check: ${item.last_finished_at === null ? "Not checked" : trackingDate(item.last_finished_at)} · Next due: ${item.enabled ? trackingDate(item.next_due) : "Stopped"}`, "muted"));
      if (item.last_worker_seen_at != null) row.append(element("p", `Worker seen: ${trackingDate(item.last_worker_seen_at)}`, "muted"));
      if (item.worker_code) row.append(element("p", human(item.worker_code), "field-help"));
      if (item.last_tick?.codes?.length) {
        const issues = element("details"); issues.append(element("summary", "Last check issues"));
        const list = element("ul"); for (const code of item.last_tick.codes) list.append(element("li", human(code))); issues.append(list); row.append(issues);
      }
      const planKey = JSON.stringify([item.schedule_id, item.revision, item.config_sha256]);
      const canPlan = item.enabled && item.is_current_scope && item.mode === "observation_only" && item.source_rights_status === "ALLOWED" &&
        !["checking", "monitoring"].includes(item.worker_state);
      if (canPlan) {
        const saved = trackingPlans.get(planKey);
        const guide = button(saved ? "Hide start instructions" : "Set up source checks", async () => {
          if (trackingPlans.has(planKey)) { trackingPlans.delete(planKey); renderTracking(); return; }
          if (trackingPlans.size >= 100) trackingPlans.delete(trackingPlans.keys().next().value);
          const attempt = { loading: true };
          trackingPlans.set(planKey, attempt); renderTracking();
          const stillCurrent = () => token && trackingPlans.get(planKey) === attempt && tracking.items.some(current =>
            current.schedule_id === item.schedule_id && current.revision === item.revision && current.config_sha256 === item.config_sha256);
          try {
            // This authenticated POST returns instructions only. It cannot start a worker.
            const value = await api.write("/api/schedules/observation-plan", {
              schedule_id: item.schedule_id, revision: item.revision, config_sha256: item.config_sha256
            });
            if (!stillCurrent()) return;
            if (!value || typeof value.available !== "boolean" || typeof value.message !== "string" ||
                value.available && (typeof value.shell_command !== "string" || value.shell_command.length > 20000))
              throw new WorkspaceRequestError("Start instructions are invalid. Refresh tracking before you retry.");
            trackingPlans.set(planKey, { value });
          } catch (error) {
            if (!stillCurrent()) return;
            trackingPlans.set(planKey, { error: error.status === 409 ? "Tracking changed. Refresh before requesting new instructions."
              : "Start instructions are unavailable. Refresh tracking and try again." });
          }
          renderTracking();
        });
        guide.disabled = Boolean(saved?.loading); row.append(guide);
        if (saved) {
          const instructions = element("div", undefined, "tracking-instructions"); instructions.setAttribute("aria-live", "polite");
          if (saved.loading) instructions.append(element("p", "Loading start instructions…", "field-help"));
          else if (saved.error) instructions.append(element("p", saved.error, "field-help"));
          else {
            instructions.append(element("p", saved.value.message, "field-help"));
            if (saved.value.available) {
              const label = element("label", "Command for your terminal"); label.htmlFor = `source-check-command-${item.sequence}`;
              const command = element("textarea", undefined, "observation-command"); command.id = label.htmlFor;
              command.readOnly = true; command.rows = 5; command.value = saved.value.shell_command;
              const feedback = element("p", "Keep the terminal open. Ctrl-C stops checks. New evidence appears here for research with your AI.", "field-help");
              const copy = button("Copy start command", async () => {
                try {
                  if (!globalThis.navigator?.clipboard?.writeText) throw new Error("Clipboard unavailable.");
                  await navigator.clipboard.writeText(command.value); feedback.textContent = "Command copied. Run it in a separate terminal. No worker started here.";
                } catch { command.focus(); command.select?.(); feedback.textContent = "Select and copy the command. Run it in a separate terminal."; }
              });
              instructions.append(label, command, copy, feedback);
            }
          }
          row.append(instructions);
        }
      } else trackingPlans.delete(planKey);
      if (item.enabled) {
        const stop = button("Stop tracking", () => mutate("/api/schedules/stop", makeStopTrackingRequest(item), "Tracking stopped. Your research and accepted judgment remain unchanged."));
        stop.dataset.write = "true"; stop.setAttribute("aria-label", `Stop tracking ${item.symbols.join(", ")}`); row.append(stop);
      }
      container.append(row);
    }
    if (!items.length) container.append(element("p", tracking.items.length ? "No matching loaded tracking. Change filters or load more." : "Tracking is not configured. Connect a source and worker for this watch.", "field-help"));
    renderPending();
  }
  async function moreTracking() {
    if (!token || !tracking.has_more || pagesBusy.has("tracking")) return;
    const current = generation, epoch = pageEpoch, prior = tracking;
    pagesBusy.add("tracking"); $("more-tracking").disabled = true;
    try {
      const next = await api.read(pageURL("schedules", prior, filters.watch ? { watch_id: filters.watch } : {}));
      if (!token || current !== generation || epoch !== pageEpoch) return;
      tracking = mergeTrackingPage(prior, next); renderTracking();
    } catch (error) { if (token && current === generation && epoch === pageEpoch) { trackingError = error; renderTracking(); } }
    finally { pagesBusy.delete("tracking"); $("more-tracking").disabled = false; }
  }
  function renderInbox() {
    const container = $("inbox"); container.setAttribute("aria-busy", "false"); container.replaceChildren();
    const results = inboxKind === "thesis" ? [] : filterInbox(inbox.items, filters);
    const externalResults = inboxKind === "thesis" ? [] : filterInbox(external.items, filters);
    const candidates = inboxKind === "delivery" ? [] : filterTheses(theses.items, filters);
    const items = [...results.map(item => ({ kind: "delivery", item, date: item.result.created_at })),
      ...externalResults.map(item => ({ kind: "external", item, date: receiptTime(item) })),
      ...candidates.map(item => ({ kind: "thesis", item, date: item.created_at }))]
      .sort((a, b) => timestamp(b.date) - timestamp(a.date) || b.item.sequence - a.item.sequence || a.kind.localeCompare(b.kind));
    const moreAvailable = inboxKind !== "thesis" && (inbox.has_more || external.has_more) || inboxKind !== "delivery" && theses.has_more;
    $("inbox-count").textContent = `${items.length} loaded${moreAvailable ? " · more available" : ""}`;
    $("filter-description").textContent = [THEMES[filters.theme], filters.company, filters.watch ? "Selected watch" : ""].filter(Boolean).join(" · ") || "All research";
    $("view-watch").hidden = !filters.watch;
    $("view-watch").disabled = !watches.items.some((watch) => watch.watch_id === filters.watch);
    for (const entry of items) {
      const { item } = entry;
      if (entry.kind === "thesis") {
        const node = button("", () => openThesis(item.sha256), "result-row");
        node.setAttribute("aria-pressed", String(selected?.kind === "thesis" && selected.id === item.sha256));
        node.append(element("span", `Thesis · ${item.research_topic === "pcb_ccl" ? "PCB / CCL" : "AI Compute"} · r${item.revision}`, "result-meta"), element("strong", item.title));
        node.append(element("span", item.scope.symbols.join(" · "), "result-meta"));
        node.append(element("span", [item.accepted_interpretation ? "Adopted thesis" : "Candidate", item.accepted_evidence ? "Evidence accepted" : "", !item.is_current_revision ? "Older revision" : ""].filter(Boolean).join(" · "), "result-state"));
        node.append(element("span", `${date(item.created_at)} · ${item.review_count} reviews`, "result-meta")); container.append(node); continue;
      }
      const isExternal = entry.kind === "external", id = isExternal ? item.external_record_id : item.delivery_id;
      const node = button("", () => isExternal ? openExternal(id) : openDelivery(id), "result-row"); node.setAttribute("aria-pressed", String(selected?.kind === entry.kind && selected.id === id));
      if (isExternal) node.append(element("span", `External AI · ${item.session.client} · usage unverified`, "result-meta"));
      node.append(element("span", `${item.result.symbols.join(" · ")} · ${THEMES[item.result.theme_id] ?? human(item.result.theme_id)}`, "result-meta"), element("strong", item.result.summary));
      const state = [human(item.result.result_state), !item.is_current_revision ? "Old scope" : "", item.accepted_evidence ? "Evidence accepted" : "", item.accepted_interpretation ? "Interpretation accepted" : ""].filter(Boolean).join(" · ");
      node.append(element("span", state, `result-state${item.result.result_state === "SOURCE_NEEDED" || !item.is_current_revision ? " warning" : ""}`));
      node.append(element("span", `${isExternal ? `Received: ${date(receiptTime(item))}` : date(item.result.created_at)} · ${item.source_count} sources · ${item.review_count} reviews`, "result-meta"));
      if (item.latest_review) node.append(element("span", `Latest: ${ACTIONS[item.latest_review.action] ?? human(item.latest_review.action)}`, "result-meta"));
      container.append(node);
    }
    if (!items.length) {
      if (inbox.items.length || external.items.length || theses.items.length) empty(container, "No matching loaded results", "Change the filters or load more records to inspect the complete history.");
      else if (status?.gates?.some(gate => executionGateDisplay(gate))) empty(container, "Research needs attention", "No research result is loaded. Review the issue above before another attempt.");
      else empty(container, "No results yet", watches.items.length || status?.counts?.watches > 0
        ? "Your watch is saved. Check tracking and source permissions before you authorize research."
        : "Save a watch to define your question. Research execution requires separate authorization.");
    }
    $("more-inbox").hidden = !inbox.has_more || inboxKind === "thesis";
    $("more-external").hidden = !external.has_more || inboxKind === "thesis";
    $("more-theses").hidden = !theses.has_more || inboxKind === "delivery";
    renderTracking();
  }
  function renderLegacy() {
    $("legacy-section").hidden = !filters.watch;
    const container = $("legacy-results"); container.replaceChildren();
    for (const record of legacy.items.toReversed()) {
      const node = button("", () => openLegacy(record.result_id), "result-row"); node.setAttribute("aria-pressed", String(selected?.id === record.result_id));
      node.append(element("strong", record.summary), element("span", `${date(record.created_at)} · Unknown provenance`, "result-meta")); container.append(node);
    }
    if (!legacy.items.length) container.append(element("p", "No legacy records are loaded for this watch.", "field-help"));
    $("more-legacy").hidden = !legacy.has_more;
  }
  function sectionList(container, heading, values, emptyText) {
    container.append(element("h2", heading));
    if (!values?.length) { container.append(element("p", emptyText, "muted")); return; }
    const list = element("ul"); for (const value of values) list.append(element("li", value)); container.append(list);
  }
  function reference(label, id) {
    const section = element("div"); section.append(element("h3", label));
    if (id) section.append(button([detail?.delivery_id, detail?.external_record_id].includes(id) ? "This result" : "Open accepted result", () => id.startsWith("el-external-") ? openExternal(id) : openDelivery(id)));
    else section.append(element("p", "None recorded", "muted"));
    if (id) section.append(element("p", id, "field-help"));
    return section;
  }
  function thesisReference(label, hash, revision) {
    const section = element("div"); section.append(element("h3", label));
    if (hash) section.append(button(hash === detail.sha256 ? `This revision · r${revision}` : `Open accepted revision · r${revision}`, () => openThesis(hash)));
    else section.append(element("p", "None recorded", "muted"));
    return section;
  }
  function renderThesisReview() {
    $("review-panel").hidden = false; $("thesis-review-help").hidden = false;
    const action = $("review-action"), previous = action.value;
    action.replaceChildren();
    for (const [id, label] of Object.entries(THESIS_ACTIONS)) {
      const option = element("option", label); option.value = id;
      option.disabled = !!thesisAcceptanceGate(detail, id, !sources.has_more); action.append(option);
    }
    action.value = Object.hasOwn(THESIS_ACTIONS, previous) ? previous : "received";
    const gates = [...new Set(["accept_evidence", "accept_interpretation"].map(id => thesisAcceptanceGate(detail, id, !sources.has_more)).filter(Boolean))];
    $("review-gate").hidden = !gates.length; $("review-gate").textContent = gates.join(" ");
  }
  function renderThesisDetail(summary, container) {
    const p = detail.proposal;
    summary.append(element("h1", p.title), element("p", `${p.research_topic === "pcb_ccl" ? "PCB / CCL" : "AI Compute"} · thesis r${p.revision} · ${p.scope.symbols.join(" · ")}`, "detail-meta"));
    summary.append(element("p", detail.accepted_interpretation ? "Adopted thesis" : "Candidate · not adopted", "result-state"), element("p", p.mechanism));
    summary.append(element("p", `Next check: ${p.next_check}`), element("p", `Origin: ${p.origin.kind === "caller_agent" ? "Your AI (declared)" : "Human (declared)"} · ${date(detail.created_at)}`, "detail-meta"));
    if (!detail.is_current_revision) summary.append(element("p", "Older revision. Acceptance requires the current thesis and watch scope.", "gate-note"));
    const baselines = element("div", undefined, "baseline-grid");
    baselines.append(thesisReference("Accepted evidence", detail.evidence_sha256, detail.evidence_revision), thesisReference("Adopted thesis", detail.interpretation_sha256, detail.interpretation_revision)); summary.append(baselines);
    container.append(element("h2", "What changed"), element("p", "Structural differences only. Review their investment significance.", "field-help"));
    const changes = element("details"); changes.append(element("summary", p.revision === 1 ? "Initial claims" : "Claim changes"), element("pre", JSON.stringify(detail.delta, null, 2))); container.append(changes);
    container.append(element("h2", "Company roles"));
    const roles = element("ul"); for (const role of p.market_roles) roles.append(element("li", `${role.symbol} · ${role.market} · ${human(role.role)}`)); container.append(roles);
    container.append(element("h2", "Claims"));
    for (const claim of p.claims) {
      const row = element("section", undefined, "claim-row");
      row.append(element("h3", claim.statement), element("p", `${human(claim.status)} · ${human(claim.kind)} · ${human(claim.economic_stage)} · ${claim.symbols.join(" · ")}`, "detail-meta"));
      row.append(element("p", `Period: ${claim.period === null ? "Unknown" : JSON.stringify(claim.period)} · Unit: ${claim.unit ?? "Unknown"} · Denominator: ${claim.denominator ?? "Unknown"}`, "field-help"));
      for (const [label, values] of [["Required evidence", claim.required_evidence], ["Falsifiers", claim.falsifiers], ["Cannot infer", claim.inference_limits]]) {
        row.append(element("h4", label)); const list = element("ul"); for (const value of values) list.append(element("li", value)); row.append(list);
      }
      row.append(element("h4", "Evidence"));
      if (!claim.evidence_refs.length) row.append(element("p", "No evidence references. This claim remains a research gap.", "muted"));
      for (const evidence of claim.evidence_refs) {
        const source = sources.items.find(item => item.source_event_id === evidence.source_ref.source_event_id);
        const item = element("div", undefined, "source-row"); item.append(element("p", `${human(evidence.relation)} · ${evidence.document_id} · ${evidence.locator}`));
        const url = safeSourceURL(source?.url);
        if (url) { const link = element("a", "Open source"); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; item.append(link); }
        row.append(item);
      }
      container.append(row);
    }
    container.append(element("h2", "Alternative explanation"), element("p", p.alternative_explanation), element("p", `Counterevidence search: ${human(p.counterevidence_search)}`, "detail-meta"));
    container.append(element("h2", "Sources"), element("p", `${sources.items.length} of ${detail.source_count} sources loaded. Local rights are separate from commercial rights.`, "field-help"));
    for (const source of sources.items) {
      const row = element("div", undefined, "source-row");
      row.append(element("p", `${date(source.published_at)} · local rights: ${source.local_rights_status}`));
      const url = safeSourceURL(source.url);
      if (url) { const link = element("a", source.url); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link); }
      else row.append(element("p", "Source link unavailable.", "field-help"));
      container.append(row);
    }
    if (sources.has_more) { const moreButton = button("Load remaining sources", moreThesisSources); moreButton.disabled = pagesBusy.has("sources"); container.append(moreButton); }
    const pins = element("details", undefined, "pins"); pins.append(element("summary", "Proposal, method, and source pins"), element("pre", JSON.stringify({ proposal_sha256: detail.sha256, method_sha256: p.method_sha256, origin: p.origin, scope: p.scope, sources: p.claims.map(claim => ({ claim_id: claim.claim_id, refs: claim.evidence_refs })), verification: detail.verification, source_authenticity: detail.source_authenticity, author_authenticity: detail.author_authenticity }, null, 2))); container.append(pins);
    renderThesisReview(); $("review-history").hidden = false; renderHistory(); renderPending();
  }
  async function moreThesisSources() {
    if (!token || selected?.kind !== "thesis" || !detail || !sources.has_more || pagesBusy.has("sources")) return;
    const id = selected.id, current = detailGeneration, epoch = pageEpoch;
    const prior = sources; pagesBusy.add("sources"); renderDetail();
    try {
      const next = await api.read(pageURL("thesis-sources", prior, { proposal_sha256: id }));
      if (!token || selected?.kind !== "thesis" || selected.id !== id || current !== detailGeneration || epoch !== pageEpoch) return;
      sources = mergePage(prior, next);
    } catch (error) { if (token && current === detailGeneration) showError(error); }
    finally { pagesBusy.delete("sources"); if (token && !editorOpen && selected?.kind === "thesis" && detail?.kind === "thesis") renderDetail(); }
  }
  function renderDetail() {
    const container = $("detail"); container.replaceChildren();
    const summary = $("detail-summary"); summary.replaceChildren();
    $("watch-editor").hidden = true; editorOpen = false; $("detail").hidden = false; summary.hidden = false;
    $("thesis-review-help").hidden = true;
    if (!detail) { empty(summary, "Select a result", "Read the evidence, then choose a review action. Opening a result does not accept it."); $("review-panel").hidden = true; $("review-history").hidden = true; return; }
    if (detail.kind === "thesis") { renderThesisDetail(summary, container); return; }
    const result = detail.result;
    summary.append(element("h1", result.symbols.join(" · ")), element("p", `${THEMES[result.theme_id] ?? human(result.theme_id)}${result.stage_id ? ` · ${human(result.stage_id)}` : ""} · scope r${result.scope_revision}`, "detail-meta"));
    summary.append(element("p", human(result.result_state), "result-state"), element("h2", "Summary"), element("p", result.summary));
    if (detail.kind === "external") {
      summary.append(element("p", `Received: ${date(receiptTime(detail))}`, "detail-meta"),
        element("p", `Task prepared: ${date(result.created_at)} · Proposed next check: ${date(result.next_check_at)}`, "detail-meta"));
      summary.append(element("p", `External AI · ${detail.session.client} · ${detail.session.model} (declared)`, "detail-meta"),
        element("p", "Usage unverified. This is not a completed background run. Review the evidence before acceptance.", "field-help"));
    } else summary.append(element("p", `Created: ${date(result.created_at)} · Next check: ${date(result.next_check_at)}`, "detail-meta"));
    if (result.as_of_feed_day) summary.append(element("p", `Feed date: ${result.as_of_feed_day}`, "detail-meta"));
    if (detail.private_context) {
      container.append(element("h2", "Thesis question"), element("p", detail.private_context.question), element("h3", "Trigger"), element("p", detail.private_context.trigger));
      if (detail.private_context.component) container.append(element("p", `Component: ${detail.private_context.component}`, "muted"));
      const watch = watches.items.find((entry) => entry.watch_id === result.watch_id);
      if (watch) container.append(button("Edit watch · next revision", () => openEditor(watch)));
      const baselines = element("div", undefined, "baseline-grid"); baselines.append(reference("Accepted evidence", detail.evidence_reference?.id ?? detail.evidence_delivery_id), reference("Accepted interpretation", detail.interpretation_reference?.id ?? detail.interpretation_delivery_id)); container.append(baselines);
      container.append(element("p", `Current watch scope: r${detail.current_revision} · Review revision: ${detail.review_revision}`, "detail-meta"));
    } else {
      container.append(element("p", "Unknown provenance · legacy-unclassified original acceptance. This record does not create new accepted evidence.", "gate-note"));
      container.append(element("h2", "Original archive references"));
      for (const archive of detail.archives ?? []) container.append(element("p", `Saved: ${date(archive.saved_at)} · Original accepted result: ${archive.accepted_result_id ?? "None"} · ${archive.acceptance_status}`, "detail-meta"));
      if (detail.archive_reference_count > detail.archives?.length) container.append(element("p", `${detail.archive_reference_count} archive references remain in SQLite. This view shows the latest ${detail.archives.length}.`, "field-help"));
    }
    sectionList(container, "Drivers", result.drivers, "No drivers are recorded.");
    sectionList(container, "Falsifiers", result.falsifiers, "No falsifiers are recorded.");
    sectionList(container, "Unknowns", result.unknowns, "No unknowns are recorded.");
    container.append(element("h2", "Sources"));
    if (!result.sources.length) container.append(element("p", "No sources are recorded. Acceptance is disabled when sources are required.", "muted"));
    for (const [index, source] of result.sources.entries()) {
      let dateLabel = "";
      if (detail.kind === "external") {
        const audit = detail.provenance?.source_dates?.find(entry => entry.citation_index === index);
        const bases = new Set(audit?.matches?.map(match => match.basis) ?? []);
        dateLabel = bases.size > 1 ? "Date basis varies by source version" : bases.has("declared_publication")
          ? "Published (reported)" : bases.has("retained_retrieval") ? "Retrieved · publication date unknown" : "Date basis not recorded";
      }
      const row = element("div", undefined, "source-row"); row.append(element("p", source.claim), element("span", `${date(source.date)}${dateLabel ? ` · ${dateLabel}` : ""} · ${human(source.kind)}`));
      const url = safeSourceURL(source.url);
      if (url) { const link = element("a", source.url); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(element("br"), link); }
      else row.append(element("p", `Link unavailable: ${String(source.url ?? "No URL")}`, "field-help"));
      container.append(row);
    }
    const pins = element("details", undefined, "pins"); pins.append(element("summary", "Method, source pins, and comparison baselines")); pins.append(element("pre", JSON.stringify(detail.provenance, null, 2))); container.append(pins);
    $("review-panel").hidden = !detail.delivery_id && !detail.external_record_id;
    if (detail.delivery_id || detail.external_record_id) {
      const gate = acceptanceGate(detail); $("review-gate").hidden = !gate; $("review-gate").textContent = gate ?? "";
      const action = $("review-action"); const value = action.value; action.replaceChildren();
      for (const [id, label] of Object.entries(ACTIONS)) { const option = element("option", label); option.value = id; option.disabled = !!gate && id.startsWith("accept_"); action.append(option); }
      if (Object.hasOwn(ACTIONS, value) && (!gate || !value.startsWith("accept_"))) action.value = value;
      $("review-history").hidden = false;
      renderHistory();
    } else $("review-history").hidden = true;
    renderPending();
  }
  function renderHistory() {
    const items = historyComplete ? journal.items : detail?.reviews ?? [];
    $("history-count").textContent = `${detail.review_count} reviews retained · ${items.length} loaded${historyComplete ? " from complete journal" : " in recent view"}`;
    const container = $("history-items"); container.replaceChildren();
    for (const review of items) { const row = element("div", undefined, "history-row"); row.append(element("strong", (detail.kind === "thesis" ? THESIS_ACTIONS : ACTIONS)[review.action] ?? human(review.action)), element("p", review.note), element("span", `${date(review.created_at)} · ${detail.kind === "thesis" ? `thesis r${review.revision} · review r${review.expected_review_revision}` : `revision ${review.expected_revision}`} · ${review.review_id}`)); container.append(row); }
    if (!items.length) container.append(element("p", "No reviews are recorded.", "muted"));
    $("load-history").hidden = historyComplete && !journal.has_more;
    $("load-history").textContent = historyComplete ? "Load more reviews" : "Read complete journal";
  }
  function renderPending() {
    const pending = writes.pending;
    $("pending-panel").hidden = !pending;
    const disabled = writes.busy || !!pending;
    for (const node of document.querySelectorAll('[data-write="true"], #watch-form button[type="submit"], #submit-review, #import-legacy')) node.disabled = disabled;
    if (detail?.kind === "thesis" && thesisAcceptanceGate(detail, $("review-action").value, !sources.has_more)) $("submit-review").disabled = true;
    if (detail?.kind !== "thesis" && $("review-action").value.startsWith("accept_") && acceptanceGate(detail)) $("submit-review").disabled = true;
    sessionUI?.sync();
    $("review-action").disabled = disabled; $("review-note").disabled = disabled;
    if (!pending) { $("pending-request").textContent = ""; return; }
    const conflict = pending.outcome === "conflict";
    $("pending-message").textContent = conflict ? "The local record changed. Read the refreshed record. Submit a new action only after you check it." : "The reply is uncertain. The exact request remains in memory. Check the current record before you retry.";
    $("pending-request").textContent = JSON.stringify(pending.body, null, 2);
    $("retry-exact").hidden = conflict; $("retry-exact").disabled = writes.busy;
    $("resolve-conflict").hidden = !conflict; $("resolve-conflict").disabled = writes.busy;
  }
  async function mutate(path, body, success) {
    if (!token || writes.busy || writes.pending) return;
    try {
      const promise = writes.submit(path, body); renderPending();
      await promise;
      await refresh({ announce: false });
      if (token) message(success);
    } catch (error) { showError(error); if (token && writes.pending) $("pending-heading").focus(); }
    finally { renderPending(); }
  }
  async function refresh({ announce = true, first = false } = {}) {
    if (!token || refreshBusy) return;
    refreshBusy = true; $("refresh").disabled = true;
    const current = generation;
    if (first) loading($("inbox"));
    try {
      const values = await Promise.all([api.read("/api/status"), api.read("/api/watches?limit=50"),
        api.read(`/api/inbox?limit=50&order=newest${filters.watch ? `&watch_id=${filters.watch}` : ""}`), api.read("/api/notices?limit=50"),
        api.read(`/api/theses?limit=50&order=newest${filters.watch ? `&watch_id=${filters.watch}` : ""}`),
        api.read(`/api/schedules?limit=50${filters.watch ? `&watch_id=${filters.watch}` : ""}`).then(page => ({ page }), error => ({ error })),
        api.read(`/api/external-research?limit=50&order=newest${filters.watch ? `&watch_id=${filters.watch}` : ""}`)]);
      if (!token || current !== generation) return;
      pageEpoch++;
      // A refresh starts at the first page. Do not retain stale review or scope snapshots.
      status = values[0]; watches = mergePage(emptyPage(), values[1]); inbox = mergePage(emptyPage(), values[2]); notices = values[3]; theses = mergePage(emptyPage(), values[4]);
      external = mergePage(emptyPage(), values[6]);
      trackingError = values[5].error ?? null;
      try { tracking = trackingError ? emptyPage() : mergeTrackingPage(emptyPage(), values[5].page); }
      catch (error) { trackingError = error; tracking = emptyPage(); }
      renderWatches(); renderInbox(); renderGates(); renderNotices(); renderLegacy();
      if (selected?.kind === "delivery" && !editorOpen) await openDelivery(selected.id, false);
      else if (selected?.kind === "external" && !editorOpen) await openExternal(selected.id, false);
      else if (selected?.kind === "thesis" && !editorOpen) await openThesis(selected.id, false);
      else if (filters.watch && !selected && !editorOpen) {
        const watch = watches.items.find((entry) => entry.watch_id === filters.watch);
        if (watch) renderWatchDetail(watch);
        else empty($("detail"), "Load the current watch", "The selected watch is outside this refreshed page. Load more watches to read its current scope.");
      }
      $("connection").textContent = "Local record connected";
      if (announce) message("Local records refreshed. Viewing did not change acceptance.");
    } catch (error) {
      if (current !== generation) return;
      showError(error);
      if (first && token) { empty($("inbox"), "Records could not load", "Select Refresh to try again."); $("inbox").setAttribute("aria-busy", "false"); }
    } finally { refreshBusy = false; $("refresh").disabled = !token; }
  }
  async function openDelivery(id, focus = true) { await openResult("delivery", id, `/api/deliveries/${id}`, focus); }
  async function openExternal(id, focus = true) { await openResult("external", id, `/api/external-research/${id}`, focus); }
  async function openLegacy(id) { await openResult("legacy", id, `/api/legacy/results/${id}`, true); }
  async function openThesis(id, focus = true) { await openResult("thesis", id, `/api/theses/${id}`, focus); }
  async function openResult(kind, id, path, focus) {
    sessionUI.clear();
    const changed = selected?.id !== id || selected?.kind !== kind;
    const priorReviewCount = detail?.review_count;
    selected = { kind, id }; editing = null; editorOpen = false; $("workspace").dataset.detail = "true";
    $("watch-editor").hidden = true; $("detail").hidden = false; $("detail-summary").hidden = false;
    const current = ++detailGeneration;
    if (changed) { detail = null; sources = emptyPage(); historyComplete = false; journal = emptyPage(); $("review-action").value = "received"; $("review-note").value = ""; $("detail-summary").replaceChildren(); loading($("detail")); $("review-panel").hidden = true; $("review-history").hidden = true; }
    renderInbox(); renderLegacy();
    try {
      const value = await api.read(path);
      if (!token || current !== detailGeneration) return;
      if (value.review_count !== priorReviewCount) { historyComplete = false; journal = emptyPage(); }
      detail = value;
      if (kind === "thesis") sources = { items: value.sources, next_after: value.sources_next_after, has_more: value.sources_has_more };
      $("detail").setAttribute("aria-busy", "false"); renderDetail();
      if (focus) { const heading = $("detail-summary").querySelector("h1"); heading.tabIndex = -1; heading.focus(); }
    } catch (error) {
      if (!token || current !== detailGeneration) return;
      detail = null; $("review-panel").hidden = true; $("review-history").hidden = true; empty($("detail"), "Result could not load", "Refresh the workspace or select the result again."); $("detail").setAttribute("aria-busy", "false"); showError(error);
    }
  }
  async function selectWatch(watch, notice = null) {
    sessionUI.clear();
    researchNotice = notice;
    filters.watch = watch?.watch_id ?? ""; generation++; detailGeneration++; selected = detail = editing = null; editorOpen = false;
    inbox = external = theses = sources = legacy = journal = tracking = emptyPage(); historyComplete = false; trackingError = null; pageEpoch++;
    $("workspace").dataset.detail = "false"; renderWatches(); renderDetail();
    loading($("inbox")); renderTracking(); loading($("tracking")); const current = generation;
    try {
      const [inboxPage, legacyPage, thesisPage, trackingPage, externalPage] = await Promise.all([api.read(pageURL("inbox", emptyPage(), filters.watch ? { watch_id: filters.watch } : {})),
        watch ? api.read(pageURL("legacy", emptyPage(), { watch_id: watch.watch_id })) : Promise.resolve(emptyPage()),
        api.read(pageURL("theses", emptyPage(), filters.watch ? { watch_id: filters.watch } : {})),
        api.read(pageURL("schedules", emptyPage(), filters.watch ? { watch_id: filters.watch } : {})).then(page => ({ page }), error => ({ error })),
        api.read(pageURL("external-research", emptyPage(), filters.watch ? { watch_id: filters.watch } : {}))]);
      if (!token || current !== generation) return;
      trackingError = trackingPage.error ?? null;
      try { tracking = trackingError ? emptyPage() : mergeTrackingPage(emptyPage(), trackingPage.page); }
      catch (error) { trackingError = error; tracking = emptyPage(); }
      inbox = mergePage(emptyPage(), inboxPage); external = mergePage(emptyPage(), externalPage); theses = mergePage(emptyPage(), thesisPage); legacy = mergePage(emptyPage(), legacyPage); renderInbox(); renderLegacy(); renderWatches();
      if (watch) renderWatchDetail(watch);
    } catch (error) { if (token && current === generation) { showError(error); empty($("inbox"), "Records could not load", "Select Refresh to try again."); } }
  }
  function renderWatchDetail(watch) {
    $("detail-summary").replaceChildren();
    const container = $("detail"); container.replaceChildren(element("h1", watch.scope.symbols.join(" · ")), element("p", `${THEMES[watch.scope.theme_id]} · r${watch.current_revision}`, "detail-meta"),
      element("h2", "Thesis question"), element("p", watch.private_context.question), element("h3", "Trigger"), element("p", watch.private_context.trigger),
      element("p", `${watch.result_count} results · ${watch.legacy_result_count} legacy records`, "muted"), button("Edit watch · next revision", () => openEditor(watch)));
    const baselines = element("div", undefined, "baseline-grid"); baselines.append(reference("Accepted evidence", watch.evidence_reference?.id ?? watch.evidence_delivery_id), reference("Accepted interpretation", watch.interpretation_reference?.id ?? watch.interpretation_delivery_id)); container.append(baselines);
    if (watch.latest_delivery_id) container.append(button("Open latest result", () => openDelivery(watch.latest_delivery_id)));
    container.append(sessionUI.mount(watch, researchNotice));
    container.append(element("p", "Saving a scope or private question does not authorize AI execution.", "field-help"));
  }
  function openEditor(watch = null) {
    sessionUI.clear();
    editing = watch; editorOpen = true; detailGeneration++; $("workspace").dataset.detail = "true";
    $("watch-editor").hidden = false; $("detail").hidden = true; $("detail-summary").hidden = true; $("review-panel").hidden = true; $("review-history").hidden = true;
    $("editor-heading").textContent = watch ? "Edit watch" : "New watch";
    $("theme-input").value = watch?.scope.theme_id ?? "ai_compute";
    $("stage-input").value = watch?.scope.stage_id ?? "";
    $("symbols-input").value = watch?.scope.symbols.join(", ") ?? "";
    $("question-input").value = watch?.private_context.question ?? "";
    $("trigger-input").value = watch?.private_context.trigger ?? "";
    $("component-input").value = watch?.private_context.component ?? "";
    $("editor-revision").textContent = watch ? `The watch ID remains ${watch.watch_id}. Save revision ${watch.current_revision + 1}.` : "The new watch starts at revision 1.";
    updateStage(); renderPending(); $("theme-input").focus();
  }
  function updateStage() { const allowed = $("theme-input").value === "ai_compute"; $("stage-input").disabled = !allowed; if (!allowed) $("stage-input").value = ""; }
  const pagesBusy = new Set();
  async function more(kind) {
    if (!token || pagesBusy.has(kind)) return;
    pagesBusy.add(kind);
    const controls = { watches: "more-watches", inbox: "more-inbox", external: "more-external", theses: "more-theses", notices: "more-notices", legacy: "more-legacy", reviews: "load-history" };
    const control = $(controls[kind]); control.disabled = true;
    const current = generation, currentPageEpoch = pageEpoch, selectedId = selected?.id, selectedKind = selected?.kind, currentDetail = detailGeneration;
    try {
      const pages = { watches, inbox, external, theses, notices, legacy, reviews: historyComplete ? journal : emptyPage() };
      const parameters = ["inbox", "external", "theses"].includes(kind) && filters.watch || kind === "legacy" ? { watch_id: filters.watch } : kind === "reviews" ? selectedKind === "thesis" ? { proposal_sha256: selectedId } : selectedKind === "external" ? { external_record_id: selectedId } : { delivery_id: selectedId } : {};
      const route = kind === "external" ? "external-research" : kind === "reviews" && selectedKind === "external" ? "external-reviews" : kind === "reviews" && selectedKind === "thesis" ? "thesis-reviews" : kind;
      const next = await api.read(pageURL(route, pages[kind], parameters));
      if (!token || current !== generation || currentPageEpoch !== pageEpoch || kind === "reviews" && (selected?.id !== selectedId || selected?.kind !== selectedKind || currentDetail !== detailGeneration)) return;
      const merged = mergePage(pages[kind], next);
      if (kind === "watches") {
        watches = merged; renderWatches(); renderInbox(); renderNotices();
        const watch = watches.items.find((entry) => entry.watch_id === filters.watch);
        if (watch && !selected && !editorOpen) renderWatchDetail(watch);
      }
      if (kind === "inbox") { inbox = merged; renderInbox(); renderWatches(); }
      if (kind === "external") { external = merged; renderInbox(); renderWatches(); }
      if (kind === "theses") { theses = merged; renderInbox(); renderWatches(); }
      if (kind === "notices") { notices = merged; renderNotices(); }
      if (kind === "legacy") { legacy = merged; renderLegacy(); }
      if (kind === "reviews") { journal = merged; historyComplete = true; renderHistory(); }
      renderPending();
    } catch (error) { if (token && current === generation) showError(error); }
    finally { pagesBusy.delete(kind); control.disabled = false; }
  }
  for (const [id, label] of Object.entries(THEMES)) { const option = element("option", label); option.value = id; $("theme-input").append(option); }
  for (const stage of STAGES) { const option = element("option", human(stage)); option.value = stage; $("stage-input").append(option); }
  $("new-watch").addEventListener("click", () => openEditor());
  $("view-watch").addEventListener("click", () => {
    const watch = watches.items.find((entry) => entry.watch_id === filters.watch);
    if (!watch) return;
    detailGeneration++; selected = detail = editing = null; editorOpen = false; renderDetail(); renderWatchDetail(watch);
    $("workspace").dataset.detail = "true";
    const heading = $("detail").querySelector("h1"); heading.tabIndex = -1; heading.focus();
  });
  $("cancel-edit").addEventListener("click", () => { editing = null; renderDetail(); if (!detail) $("workspace").dataset.detail = "false"; });
  $("theme-input").addEventListener("change", updateStage);
  $("company-filter").addEventListener("change", () => { filters.company = $("company-filter").value; renderInbox(); });
  $("review-action").addEventListener("change", renderPending);
  $("inbox-kind").addEventListener("change", () => { inboxKind = $("inbox-kind").value; renderInbox(); });
  $("refresh").addEventListener("click", () => { pollCount = 0; refresh(); if (token && !pollScheduled) schedulePoll(); });
  $("more-tracking").addEventListener("click", moreTracking);
  $("lock").addEventListener("click", locked);
  $("back-inbox").addEventListener("click", () => { $("workspace").dataset.detail = "false"; $("inbox-heading").focus(); });
  for (const [id, kind] of [["more-watches", "watches"], ["more-inbox", "inbox"], ["more-external", "external"], ["more-theses", "theses"], ["more-notices", "notices"], ["more-legacy", "legacy"], ["load-history", "reviews"]]) $(id).addEventListener("click", () => more(kind));
  $("watch-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (writes.busy || writes.pending) return;
    try {
      const request = makeWatchRequest({ theme_id: $("theme-input").value, stage_id: $("stage-input").value, symbols: $("symbols-input").value,
        question: $("question-input").value, trigger: $("trigger-input").value, component: $("component-input").value }, editing, uuid);
      const promise = writes.submit("/api/watches", request); renderPending();
      await promise; editing = null; editorOpen = false; $("watch-editor").hidden = true; $("detail").hidden = false;
      await refresh({ announce: false });
      if (token) { const saved = watches.items.find((watch) => watch.watch_id === request.scope.watch_id); if (saved) await selectWatch(saved); message(`Watch revision ${request.scope.revision} saved. AI execution remains unauthorized.`); }
    } catch (error) { showError(error); }
    finally { renderPending(); }
  });
  $("review-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (writes.busy || writes.pending) return;
    try {
      const isThesis = detail?.kind === "thesis";
      const request = isThesis ? makeThesisReviewRequest(detail, $("review-action").value, $("review-note").value, uuid, !sources.has_more) : makeReviewRequest(detail, $("review-action").value, $("review-note").value, uuid);
      await mutate(isThesis ? "/api/thesis-reviews" : detail?.kind === "external" ? "/api/external-reviews" : "/api/reviews", request, "Review saved. Accepted evidence and interpretation are shown separately.");
    }
    catch (error) { showError(error); }
  });
  $("retry-exact").addEventListener("click", async () => {
    if (writes.busy || writes.pending?.outcome !== "uncertain") return;
    try { const pending = writes.pending; const promise = writes.retry(); renderPending(); const value = await promise;
      if (token && pending.path === "/api/session-prepare") sessionUI.receive(value, pending.body);
      await refresh({ announce: false }); if (token) message("The exact request is confirmed. Check the refreshed record."); }
    catch (error) { showError(error); }
    finally { renderPending(); }
  });
  $("resolve-conflict").addEventListener("click", () => {
    writes.discardConflict(); renderPending();
    if (editing) { const current = watches.items.find((watch) => watch.watch_id === editing.watch_id); if (current) openEditor(current); }
    message("The refreshed record is available. Check it before you submit a new request.");
  });
  $("import-legacy").addEventListener("click", async () => {
    if (writes.busy || writes.pending) return;
    const file = $("legacy-file").files?.[0];
    if (!file || file.size > MAX_ARCHIVE_BYTES) { message("Select a JSON archive with at most 2 MB.", true); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > MAX_ARCHIVE_BYTES) throw new WorkspaceRequestError("Select a JSON archive with at most 2 MB.");
      let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      await mutate("/api/legacy/import", { archive_base64: btoa(binary) }, "Legacy archive imported. Provenance remains unknown. Original acceptance remains legacy-unclassified.");
      $("legacy-file").value = "";
    } catch (error) { showError(error); }
  });
  function schedulePoll() {
    pollScheduled = true;
    setTimeout(async () => {
      pollScheduled = false;
      if (token && !document.hidden && pollCount < 120 && !writes.busy && !writes.pending && !editorOpen) { pollCount++; await refresh({ announce: false }); }
      if (token && pollCount < 120) schedulePoll();
      else if (token) $("connection").textContent = "Automatic refresh paused · select Refresh";
    }, 30_000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && token && pollCount < 120 && !writes.busy && !writes.pending && !editorOpen) refresh({ announce: false }); });
  renderThemes();
  if (token) {
    $("locked").hidden = true; $("workspace").hidden = false; $("lock").disabled = false;
    $("connection").textContent = "Connecting to local record";
    refresh({ first: true }); schedulePoll();
  } else locked();
})();
