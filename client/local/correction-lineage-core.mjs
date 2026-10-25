// Generated from the shared correction core. Do not edit this copy.
// Source SHA-256: 6ba5f9763f9433797aaf53a0b8b15a95c944e7be6294c8d3d0b492aa59f2e6aa
/** Check the correction graph after the caller validates all record schemas. */
export function validateCorrectionLineageCore(event, retainedEvents, context, { canonicalJson, gate }) {
    if (event.event_kind !== "CORRECTED_PERIOD")
        return event;
    if (!context)
        gate("The correction requires retained artifacts and facts.");
    const lineageContext = context;
    // Exact replays are valid. Conflicting records with the same ID require review.
    const insert = (map, key, value) => {
        const existing = map.get(key);
        if (existing && canonicalJson(existing) !== canonicalJson(value)) {
            gate("The correction context contains conflicting records with the same ID.");
        }
        map.set(key, value);
    };
    const events = new Map();
    for (const value of retainedEvents) {
        insert(events, value.source_event_id, value);
    }
    insert(events, event.source_event_id, event);
    const artifacts = new Map();
    for (const value of lineageContext.artifacts) {
        insert(artifacts, value.source_artifact_id, value);
    }
    const facts = new Map();
    for (const value of lineageContext.facts) {
        insert(facts, `${value.source_event_id}:${value.fact_key}`, value);
    }
    // Include ancestors and sibling branches in the graph check.
    const related = new Set([event.source_event_id]);
    let expanded = true;
    while (expanded) {
        expanded = false;
        for (const value of events.values()) {
            const parent = value.supersedes_source_event_id;
            if (!parent || (!related.has(value.source_event_id) && !related.has(parent)))
                continue;
            if (!events.has(parent))
                gate("The correction chain references a missing source event.");
            for (const id of [parent, value.source_event_id]) {
                if (!related.has(id)) {
                    related.add(id);
                    expanded = true;
                }
            }
        }
    }
    const visited = new Set();
    for (const id of related) {
        const path = new Set();
        let cursor = id;
        while (cursor && !visited.has(cursor)) {
            if (path.has(cursor))
                gate("The correction chain contains a cycle.");
            path.add(cursor);
            cursor = events.get(cursor).supersedes_source_event_id;
        }
        for (const ancestor of path)
            visited.add(ancestor);
    }
    const children = new Map();
    for (const id of related) {
        const value = events.get(id);
        const keys = new Set(value.affected_fact_keys);
        if (keys.size === 0 || keys.size !== value.affected_fact_keys.length) {
            gate("The correction chain requires a nonempty set of unique fact keys.");
        }
        const artifact = artifacts.get(value.source_artifact_id);
        if (!artifact)
            gate("The correction chain references a missing source artifact.");
        for (const key of keys) {
            const fact = facts.get(`${id}:${key}`);
            if (!fact)
                gate("The correction chain references a missing affected fact.");
            if (fact.source_artifact_sha256 !== artifact.artifact_sha256 ||
                fact.source_url !== artifact.canonical_url || fact.parser_version !== value.parser_version) {
                gate("An affected fact does not match its source artifact or parser.");
            }
        }
        const parentId = value.supersedes_source_event_id;
        if (!parentId)
            continue;
        if (value.event_kind !== "CORRECTED_PERIOD")
            gate("Only a correction can supersede a source event.");
        const parent = events.get(parentId);
        const parentArtifact = artifacts.get(parent.source_artifact_id);
        if (!parentArtifact)
            gate("The correction chain references a missing prior artifact.");
        if (artifact.source_id !== parentArtifact.source_id || artifact.source_class !== parentArtifact.source_class ||
            artifact.source_period === null || artifact.source_period !== parentArtifact.source_period) {
            gate("The correction does not match the prior source and reporting period.");
        }
        if ([...keys].some((key) => !parent.affected_fact_keys.includes(key))) {
            gate("The correction changes a fact outside the prior fact lineage.");
        }
        for (const key of keys) {
            const currentFact = facts.get(`${id}:${key}`);
            const priorFact = facts.get(`${parentId}:${key}`);
            if (!priorFact || currentFact.definition_version !== priorFact.definition_version) {
                gate("The correction requires the same retained fact definition.");
            }
        }
        const siblings = children.get(parentId) ?? [];
        if (siblings.some((sibling) => sibling.affected_fact_keys.some((key) => keys.has(key)))) {
            gate("The correction chain contains competing corrections for the same fact.");
        }
        children.set(parentId, [...siblings, value]);
    }
    return event;
}
