import { WorkspaceRequestError, emptyPage, mergePage } from "./workspace-state.mjs";

export function makeSessionRequest(options, draft, uuid) {
  if (!options || !draft.method) throw new WorkspaceRequestError("Select a retained research method.");
  const sourceIds = [...draft.sourceIds].sort();
  if (sourceIds.length > 30 || new Set(sourceIds).size !== sourceIds.length) throw new WorkspaceRequestError("Select at most 30 different sources.");
  const prior = options.preparations.items.find(item => item.request.preparation_id === draft.preparationId && item.is_current_revision);
  const restored = prior && prior.request.method_sha256 === draft.method && JSON.stringify(prior.request.source_event_ids) === JSON.stringify(sourceIds);
  if (!options.methods.items.some(item => item.bundle_sha256 === draft.method) && !restored) throw new WorkspaceRequestError("Load the selected method before preparation.");
  for (const id of sourceIds) {
    const source = options.sources.items.find(item => item.source_event_id === id);
    if ((!source && !restored) || source?.gate_code) throw new WorkspaceRequestError("Resolve source permissions and current evidence gates before preparation.");
  }
  if (draft.privateAllowed !== true || draft.methodAllowed !== true) throw new WorkspaceRequestError("Confirm private task access and the selected candidate method.");
  if (!sourceIds.length && !draft.gapConfirmed) throw new WorkspaceRequestError("Confirm that this task has no retained evidence.");
  return Object.freeze({ preparation_id: draft.preparationId ?? uuid(), watch_id: options.watch_id, revision: options.revision,
    method_sha256: draft.method, source_event_ids: sourceIds, allow_private_context: true, allow_candidate_method: true,
    allow_external_submission: draft.returnAllowed === true, confirm_no_sources: sourceIds.length === 0 });
}

// This panel prepares a connection. It cannot start a model or change source rights.
export function createSessionPreparation({ document, api, writes, uuid, onError, onChange, onSaved, onOpenResult }) {
  const node = (tag, text, className) => {
    const value = document.createElement(tag); if (text !== undefined) value.textContent = String(text);
    if (className) value.className = className; return value;
  };
  const root = node("section", undefined, "session-preparation"); root.id = "session-preparation";
  const draftValue = () => ({ method: "", sourceIds: new Set(), privateAllowed: false, methodAllowed: false, returnAllowed: false, gapConfirmed: false, preparationId: null });
  let options = null, watch = null, draft = draftValue(), connection = null, epoch = 0, busy = false, loadError = null, update = null, seedPending = false;
  const controls = [];
  const button = (text, action, changesDraft = false) => {
    const value = node("button", text); value.type = "button";
    value.addEventListener("click", () => { if (changesDraft && (busy || writes.busy || writes.pending)) return; return action(); });
    if (changesDraft) controls.push({ input: value, disabled: false }); return value;
  };
  function checkbox(id, text, checked, change, disabled = false) {
    const label = node("label", undefined, "session-choice"), input = node("input"); input.type = "checkbox"; input.id = id;
    input.checked = checked; input.disabled = disabled; input.addEventListener("change", () => { change(input.checked); sync(); });
    label.append(input, node("span", text)); controls.push({ input, disabled }); return label;
  }
  function invalidate() { draft.privateAllowed = false; draft.methodAllowed = false; draft.preparationId = null; connection = null; }
  function sync() {
    const locked = busy || writes.busy || !!writes.pending;
    for (const control of controls) control.input.disabled = locked || control.disabled;
    const submit = root.querySelector("#prepare-session");
    if (submit) {
      let invalid = false; try { makeSessionRequest(options, draft, uuid); } catch { invalid = true; }
      submit.disabled = locked || invalid; submit.textContent = writes.busy ? "Preparing task…" : "Prepare connection";
    }
  }
  function render() {
    const focused = document.activeElement?.id;
    const otherSourcesOpen = root.querySelector("#session-other-sources")?.open === true;
    root.replaceChildren(); controls.length = 0; root.append(node("h2", "Research with my AI"));
    root.append(node("p", "Select retained evidence for this question. Your AI client controls its model, login, and charges.", "field-help"));
    const reload = button("Refresh task options", () => load()); reload.disabled = busy || writes.busy || !!writes.pending; root.append(reload);
    if (busy && !options) { root.append(node("p", "Loading retained methods and sources…", "field-help")); return; }
    if (loadError) root.append(node("p", "Task options could not load. Retry before you prepare research.", "gate-note"), button("Retry task options", () => load()));
    if (!options) return;
    if (options.revision !== watch.current_revision) { root.append(node("p", "The watch changed. Refresh before you prepare research.", "gate-note")); return; }
    if (update) {
      const available = options.focus?.method && options.focus?.source && !options.focus.source.gate_code;
      const selected = draft.method === update.method_sha256 && draft.sourceIds.has(update.source_event_id);
      const note = node("p", !available
        ? "This update's method or source is unavailable or blocked. Refresh options or inspect the evidence references."
        : selected ? "This update's method and source are selected. Review them and confirm access before preparation. No AI started."
          : "Review the update references and your current selection. Confirm access before preparation. No AI started.", "field-help");
      note.id = "session-update-context"; note.setAttribute("role", "status"); root.append(note);
    }
    const form = node("form"); form.id = "session-form";
    const methodLabel = node("label", "Research method"); methodLabel.htmlFor = "session-method";
    const method = node("select"); method.id = "session-method";
    const placeholder = node("option", "Select a method"); placeholder.value = ""; method.append(placeholder);
    for (const item of options.methods.items) {
      const label = `${item.version} · ${item.profiles.map(p => p.title).join(" / ")} · ${item.release_status}`;
      const option = node("option", label); option.value = item.bundle_sha256; method.append(option);
    }
    if (draft.method && !options.methods.items.some(item => item.bundle_sha256 === draft.method)) {
      const option = node("option", "Saved task method · load method details before a new task"); option.value = draft.method; method.append(option);
    }
    method.value = draft.method; method.addEventListener("change", () => { invalidate(); draft.method = method.value; render(); });
    controls.push({ input: method, disabled: false }); form.append(methodLabel, method);
    if (!options.methods.items.length) form.append(node("p", "No method is retained. Complete local setup before preparing research.", "gate-note"));
    if (options.methods.has_more) form.append(button("Load more methods", () => load("methods")));
    const sourceSet = node("fieldset"); sourceSet.append(node("legend", "Retained sources"));
    const otherSources = update ? node("details") : null;
    if (otherSources) {
      otherSources.id = "session-other-sources"; otherSources.open = otherSourcesOpen;
      otherSources.append(node("summary", "Other retained sources"));
    }
    for (const item of options.sources.items) {
      const label = `${item.source_id} · ${item.period ?? "Period unknown"} · ${item.event_kind.replaceAll("_", " ")}`;
      const row = node("div", undefined, "session-source");
      row.append(checkbox(`session-source-${item.sequence}`, label, draft.sourceIds.has(item.source_event_id), checked => {
        invalidate(); if (checked) draft.sourceIds.add(item.source_event_id); else draft.sourceIds.delete(item.source_event_id); render();
      }, !!item.gate_code && !draft.sourceIds.has(item.source_event_id)));
      row.append(node("p", item.gate_code ? `Blocked: ${item.gate_code}` : `Retrieved: ${item.retrieved_at}`, "field-help"));
      const pins = node("details"); pins.append(node("summary", "Source details"), node("p", item.url, "field-help"), node("p", item.source_event_id, "field-help")); row.append(pins);
      (otherSources && item.source_event_id !== update.source_event_id ? otherSources : sourceSet).append(row);
    }
    if (otherSources && options.sources.items.some(item => item.source_event_id !== update.source_event_id)) sourceSet.append(otherSources);
    const notLoaded = [...draft.sourceIds].filter(id => !options.sources.items.some(item => item.source_event_id === id));
    for (const id of notLoaded) sourceSet.append(node("p", `Saved source: ${id}. Current permission is checked during preparation.`, "field-help"));
    if (!options.sources.items.length) sourceSet.append(node("p", "No source is retained. A task without evidence can report gaps, not establish an investment conclusion.", "field-help"));
    form.append(sourceSet);
    if (options.sources.has_more) form.append(button("Load more sources", () => load("sources")));
    form.append(node("p", `${draft.sourceIds.size} sources selected · maximum 30. Source text is data, not instructions.`, "field-help"));
    form.append(checkbox("session-private", "Allow my configured AI to read this private question and the selected retained evidence.", draft.privateAllowed, value => { draft.privateAllowed = value; }));
    form.append(checkbox("session-method-consent", "Use this candidate method for this question. This does not approve a method release or research conclusion.", draft.methodAllowed, value => { draft.methodAllowed = value; }));
    form.append(checkbox("session-return", "Let my AI return a result to this Inbox for my review.", draft.returnAllowed, value => { draft.returnAllowed = value; connection = null; render(); }));
    if (!draft.sourceIds.size) form.append(checkbox("session-gap", "I understand this task has no retained evidence. It must report the evidence gap.", draft.gapConfirmed, value => { draft.gapConfirmed = value; }));
    const submit = node("button", "Prepare connection", "primary"); submit.id = "prepare-session"; submit.type = "submit"; submit.dataset.write = "true"; form.append(submit);
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (writes.busy || writes.pending || busy) return;
      const current = epoch;
      try {
        const body = makeSessionRequest(options, draft, uuid); draft.preparationId = body.preparation_id;
        const promise = writes.submit("/api/session-prepare", body); onChange(); sync();
        const value = await promise;
        if (current !== epoch) return;
        receive(value, body); await load(); await onSaved();
      } catch (error) { if (current === epoch) onError(error); }
      finally { if (current === epoch) { sync(); onChange(); } }
    });
    root.append(form);
    if (connection) {
      const section = node("section"); section.append(node("h3", "Connect your AI"), node("p", "Add this local stdio MCP connection in your AI client. Read get_research_task before returning research.", "field-help"));
      section.append(node("p", "Preparation did not start AI or verify model usage. This is not a remote ChatGPT website connector.", "field-help"));
      const label = node("label", "MCP connection JSON"); label.htmlFor = "session-connection";
      const config = node("textarea"); config.id = "session-connection"; config.readOnly = true; config.rows = 8;
      config.value = JSON.stringify(connection.mcp_command, null, 2);
      section.append(label, config, button("Select connection JSON", () => { config.focus(); config.select(); }));
      section.append(node("p", "Copy the selected text. Keep the connection private. Your AI client may incur charges when you run it.", "field-help"));
      section.append(button("Prepare a new task", () => { draft.preparationId = null; connection = null; draft.privateAllowed = false; draft.methodAllowed = false; render(); }, true));
      root.append(section);
    }
    const history = node("details"); history.append(node("summary", "Prepared tasks"));
    for (const item of options.preparations.items) {
      const row = node("div", undefined, "session-source"); row.append(node("p", `${new Date(item.created_at).toISOString()} · scope r${item.request.revision} · ${item.result_id ? "Result returned" : "Awaiting result"}`, "field-help"));
      if (item.result_id) row.append(button("Open returned result", () => onOpenResult(item.result_id)));
      else if (item.is_current_revision) row.append(button("Restore task selection", () => {
        draft = { ...draftValue(), method: item.request.method_sha256, sourceIds: new Set(item.request.source_event_ids), preparationId: item.request.preparation_id };
        connection = null; render();
      }, true));
      else row.append(node("p", "Older scope. Prepare a task for the current watch.", "field-help"));
      history.append(row);
    }
    if (!options.preparations.items.length) history.append(node("p", "No task is prepared for this watch.", "field-help"));
    if (options.preparations.has_more) history.append(button("Load more prepared tasks", () => load("preparations")));
    root.append(history); sync();
    if (/^(?:session-[a-z0-9-]+|prepare-session)$/.test(focused ?? "")) root.querySelector(`#${focused}`)?.focus();
  }
  async function load(page) {
    if (!watch || busy) return;
    const current = epoch; busy = true; loadError = null; render();
    try {
      const query = new URLSearchParams({ watch_id: watch.watch_id, limit: "20" });
      if (update) { query.set("source_event_id", update.source_event_id); query.set("method_sha256", update.method_sha256); }
      if (page) for (const kind of ["methods", "sources", "preparations"]) query.set(`${kind}_after`, String(kind === page ? options[kind].next_after : 0));
      const next = await api.read(`/api/session-options?${query}`);
      if (current !== epoch) return;
      if (!next || next.watch_id !== watch.watch_id || next.revision !== watch.current_revision) throw new WorkspaceRequestError("The watch changed. Refresh before preparation.");
      for (const kind of ["methods", "sources", "preparations"]) next[kind] = mergePage(page && kind === page ? options[kind] : emptyPage(), next[kind]);
      // Keep already loaded option pages until the panel closes. Revalidate at preparation.
      if (options && page) for (const kind of ["methods", "sources", "preparations"]) if (kind !== page) next[kind] = options[kind];
      // Include the exact update references without moving the normal pagination cursor.
      for (const [kind, item] of [["methods", next.focus?.method], ["sources", next.focus?.source]]) {
        if (item) next[kind].items = [...next[kind].items.filter(value => value.sequence !== item.sequence), item].sort((a, b) => a.sequence - b.sequence);
      }
      options = next;
      if (seedPending) {
        draft.method = options.focus?.method?.bundle_sha256 === update.method_sha256 ? update.method_sha256 : "";
        const source = options.focus?.source;
        draft.sourceIds = new Set(source?.source_event_id === update.source_event_id && !source.gate_code ? [source.source_event_id] : []);
        seedPending = false;
      }
    } catch (error) { if (current === epoch) { loadError = error; onError(error); } }
    finally { if (current === epoch) { busy = false; render(); } }
  }
  function receive(value, body) {
    if (watch?.watch_id !== body?.watch_id || watch.current_revision !== body.revision) return;
    draft = { method: body.method_sha256, sourceIds: new Set(body.source_event_ids), preparationId: body.preparation_id,
      privateAllowed: body.allow_private_context === true, methodAllowed: body.allow_candidate_method === true,
      returnAllowed: body.allow_external_submission === true, gapConfirmed: body.confirm_no_sources === true };
    connection = value; render();
  }
  function clear() { epoch++; watch = options = connection = loadError = update = null; seedPending = false; draft = draftValue(); busy = false; controls.length = 0; root.replaceChildren(); }
  return { mount(value, notice = null) {
    const selectedUpdate = notice?.kind === "research_needed" && notice.watch_id === value.watch_id && notice.scope_revision === value.current_revision &&
      /^[a-f0-9]{64}$/.test(notice.method_sha256 ?? "") && typeof notice.source_event_id === "string" && notice.source_event_id.length > 0 &&
      notice.source_event_id.length <= 500 ? { method_sha256: notice.method_sha256, source_event_id: notice.source_event_id } : null;
    if (watch?.watch_id !== value.watch_id || watch.current_revision !== value.current_revision || JSON.stringify(update) !== JSON.stringify(selectedUpdate)) {
      clear(); watch = value; update = selectedUpdate; seedPending = !!update; load();
    }
    return root;
  }, clear, sync, receive };
}
