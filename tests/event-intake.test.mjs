import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ResearchLedger, restoreResearchLedger, LEDGER_SCHEMA_VERSION } from "../client/local/ledger.mjs";
import { contentHash } from "../client/local/run-contract.mjs";
import { scope, context, limits, result, estimate } from "./fixtures/local-research.mjs";
import { configureEventWatch, eventFixture, sourcePolicy, intake } from "./fixtures/source-events.mjs";

const root = () => mkdtempSync(join(tmpdir(), "equitylayer-event-intake-"));

test("an eligible event creates one durable job with pinned scope and relevant facts", () => {
  const directory = root(); const ledger = new ResearchLedger(directory, { clock: () => 1000 });
  const method = configureEventWatch(ledger); const input = intake(method, eventFixture(1, { issuers: ["LITE", "2345", "6701", "000660"] }));
  const queued = ledger.intakeSourceEvent(input);
  assert.equal(queued.decision.outcome, "queued"); assert.equal(queued.decision.relevant_fact_keys.length, 4);
  assert.equal(queued.run.status, "queued"); assert.deepEqual(queued.run.envelope.scope, scope());
  assert.equal(ledger.notices().length, 0); assert.equal(ledger.watch(scope().watch_id).evidence_delivery_id, null);
  assert.equal(ledger.cursors(scope().watch_id)[0].completed_event_id, null);
  const replay = ledger.intakeSourceEvent({ ...input, evaluation_at: "2026-10-12T01:00:00Z" });
  assert.equal(replay.run.run_id, queued.run.run_id); assert.equal(replay.reused, true);
  assert.equal(ledger.eventDecisions(scope().watch_id).length, 1); ledger.close();
  const reopened = new ResearchLedger(directory, { clock: () => 1000 });
  assert.equal(reopened.intakeSourceEvent(input).run.run_id, queued.run.run_id);
  const lease = reopened.claim("a"); reopened.finish(lease, result(lease.envelope));
  assert.equal(reopened.cursors(scope().watch_id)[0].completed_event_id, input.event.source_event_id);
  assert.equal(reopened.inbox().length, 1); assert.equal(reopened.notices().length, 1); reopened.verifyIntegrity(); reopened.close();
});

test("unknown source authority, schema drift, stale data, and missing context persist named gates", () => {
  for (const [change, code] of [
    [(ledger) => {}, "SOURCE_POLICY_MISSING"],
    [(ledger) => ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), rights_status: "HOLD" }), "SOURCE_RIGHTS_HOLD"],
    [(ledger) => ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), parser_version: "2" }), "SOURCE_SCHEMA_CHANGED"],
    [(ledger) => ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), max_source_age_ms: 1 }), "STALE_SOURCE"],
  ]) {
    const ledger = new ResearchLedger(root()); const method = configureEventWatch(ledger, { configurePolicy: false }); change(ledger);
    const input = intake(method); const held = ledger.intakeSourceEvent(input);
    assert.equal(held.run, null); assert.equal(held.decision.gate_code, code);
    assert.equal(ledger.intakeSourceEvent(input).reused, true); assert.equal(ledger.notices().length, 1);
    assert.equal(ledger.notices()[0].payload.gate_code, code); assert.equal(ledger.cursors(scope().watch_id)[0].queued_event_id, null);
    assert.equal(ledger.source(input.event.source_event_id).artifact.artifact_sha256, input.artifact.artifact_sha256);
    assert.equal(ledger.watch(scope().watch_id).interpretation_delivery_id, null); ledger.verifyIntegrity(); ledger.close();
  }
});

test("a held observation does not suppress the first allowed research after explicit local policy revision", () => {
  const ledger = new ResearchLedger(root()); const method = configureEventWatch(ledger, { configurePolicy: false });
  ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), rights_status: "HOLD" });
  const input = intake(method); assert.equal(ledger.intakeSourceEvent(input).decision.gate_code, "SOURCE_RIGHTS_HOLD");
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy(2));
  const ready = ledger.intakeSourceEvent(input); assert.equal(ready.decision.outcome, "queued");
  assert.equal(ledger.eventDecisions(scope().watch_id).length, 2); assert.equal(ledger.notices().length, 1);
  assert.equal(ledger.sourcePolicy(scope().watch_id, "synthetic-exchange").policy.revision, 2); ledger.verifyIntegrity(); ledger.close();
});

test("unrelated and byte-identical events make no additional job or notice", () => {
  const ledger = new ResearchLedger(root()); const method = configureEventWatch(ledger);
  const original = eventFixture(); const queued = ledger.intakeSourceEvent(intake(method, original));
  const identical = eventFixture(2);
  identical.bytes = original.bytes; identical.artifact.artifact_sha256 = original.artifact.artifact_sha256; identical.artifact.byte_length = original.bytes.length;
  identical.facts.forEach((fact) => { fact.source_artifact_sha256 = identical.artifact.artifact_sha256; fact.value = original.facts[0].value; });
  assert.equal(ledger.intakeSourceEvent(intake(method, identical)).decision.reason, "SOURCE_BYTES_UNCHANGED");
  const other = ledger.intakeSourceEvent(intake(method, eventFixture(3, { issuers: ["UNTRACKED"] })));
  assert.equal(other.decision.reason, "UNRELATED_EVENT"); assert.equal(ledger.notices().length, 0);
  assert.equal(ledger.claim("a").run_id, queued.run.run_id); assert.equal(ledger.claim("b"), null); ledger.close();
});

test("repeated unchanged observations cannot alternate into new research jobs", () => {
  const ledger = new ResearchLedger(root()); const method = configureEventWatch(ledger); const original = eventFixture();
  const first = ledger.intakeSourceEvent(intake(method, original));
  for (let number = 2; number <= 5; number++) {
    const same = eventFixture(number); same.bytes = original.bytes;
    same.artifact.artifact_sha256 = original.artifact.artifact_sha256; same.artifact.byte_length = original.bytes.length;
    same.facts[0].source_artifact_sha256 = original.artifact.artifact_sha256; same.facts[0].value = original.facts[0].value;
    const output = ledger.intakeSourceEvent(intake(method, same)); assert.equal(output.decision.reason, "SOURCE_BYTES_UNCHANGED"); assert.equal(output.run, null);
  }
  assert.equal(ledger.claim("a").run_id, first.run.run_id); assert.equal(ledger.claim("b"), null);
  assert.equal(ledger.notices().length, 0); ledger.verifyIntegrity(); ledger.close();
});

test("identical bytes with changed parsed values are a conflict, not a quiet observation", () => {
  const ledger = new ResearchLedger(root()); const method = configureEventWatch(ledger); const original = eventFixture();
  ledger.intakeSourceEvent(intake(method, original)); const changed = eventFixture(2); changed.bytes = original.bytes;
  changed.artifact.artifact_sha256 = original.artifact.artifact_sha256; changed.artifact.byte_length = original.bytes.length;
  changed.facts[0].source_artifact_sha256 = original.artifact.artifact_sha256;
  assert.equal(ledger.intakeSourceEvent(intake(method, changed)).decision.gate_code, "FACT_PARSE_CONFLICT"); ledger.close();
});

test("context-bound corrections retain raw history and gate conflicts without baseline replacement", () => {
  for (const violation of ["none", "missing_parent", "source", "period", "definition", "fork", "cycle"]) {
    const ledger = new ResearchLedger(root()); const method = configureEventWatch(ledger);
    const a = eventFixture(1, { issuers: ["LITE", "2345"] }); ledger.intakeSourceEvent(intake(method, a));
    const b = eventFixture(2, { kind: "CORRECTED_PERIOD", parent: a.event.source_event_id, issuers: ["LITE", "2345"] });
    if (violation === "missing_parent") b.event.supersedes_source_event_id = "missing";
    if (violation === "source") {
      b.artifact.source_id = "another-source"; ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), source_id: "another-source" });
    }
    if (violation === "period") b.artifact.source_period = "2026-08";
    if (violation === "definition") b.facts[0].definition_version = "different-definition";
    if (violation === "fork") {
      const sibling = eventFixture(3, { kind: "CORRECTED_PERIOD", parent: a.event.source_event_id, issuers: ["LITE", "2345"] });
      assert.equal(ledger.intakeSourceEvent(intake(method, sibling)).decision.outcome, "queued");
    }
    if (violation === "cycle") {
      const future = eventFixture(4, { kind: "CORRECTED_PERIOD", parent: b.event.source_event_id, issuers: ["LITE", "2345"] });
      ledger.retainSource(future.event, future.artifact, future.bytes); ledger.retainSourceFacts(future.event.source_event_id, future.facts);
      b.event.supersedes_source_event_id = future.event.source_event_id;
    }
    const decision = ledger.intakeSourceEvent(intake(method, b));
    assert.equal(decision.decision.outcome, violation === "none" ? "queued" : "gated");
    if (violation !== "none") assert.equal(decision.decision.gate_code, "CORRECTION_REVIEW_REQUIRED");
    assert.equal(ledger.source(a.event.source_event_id).artifact.artifact_sha256, a.artifact.artifact_sha256);
    assert.equal(ledger.source(b.event.source_event_id).artifact.artifact_sha256, b.artifact.artifact_sha256);
    assert.equal(ledger.watch(scope().watch_id).evidence_delivery_id, null); ledger.verifyIntegrity(); ledger.close();
  }
});

test("missing facts gate research until retained context arrives without replacing earlier decisions", () => {
  const ledger = new ResearchLedger(root()); const method = configureEventWatch(ledger); const input = intake(method);
  const held = ledger.intakeSourceEvent({ ...input, facts: [] }); assert.equal(held.decision.gate_code, "MISSING_FACT_CONTEXT");
  assert.equal(ledger.intakeSourceEvent(input).decision.outcome, "queued"); assert.equal(ledger.eventDecisions(scope().watch_id).length, 2);
  const changed = structuredClone(input.facts[0]); changed.value = 999;
  assert.throws(() => ledger.retainSourceFacts(input.event.source_event_id, [changed]), { code: "REFERENCE_CONFLICT" });
  assert.equal(ledger.sourceFacts(input.event.source_event_id)[0].value, input.facts[0].value);
  ledger.verifyIntegrity(); ledger.close();
});

test("budget missing is a persisted gate and configuring a budget allows the first job", () => {
  const ledger = new ResearchLedger(root()); const method = configureEventWatch(ledger, { configureBudget: false });
  const input = intake(method); assert.equal(ledger.intakeSourceEvent(input).decision.gate_code, "BUDGET_MISSING");
  ledger.configureBudget(scope().watch_id, "event-window", limits()); assert.equal(ledger.intakeSourceEvent(input).decision.outcome, "queued");
  assert.equal(ledger.eventDecisions(scope().watch_id).length, 2); ledger.close();
});

test("a source policy change stops pending and dispatched work without dropping unknown usage", () => {
  for (const dispatched of [false, true]) {
    const ledger = new ResearchLedger(root(), { clock: () => 1000 }); const method = configureEventWatch(ledger);
    const queued = ledger.intakeSourceEvent(intake(method)); const lease = ledger.claim("a"); const request = ledger.reserveRequest(lease, "analysis", estimate());
    if (dispatched) ledger.markDispatched(lease, request.request_id);
    ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
    assert.equal(ledger.run(queued.run.run_id).gate_code, "SOURCE_POLICY_CHANGED"); assert.equal(ledger.claim("b"), null);
    const budget = ledger.budget(scope().watch_id, "event-window");
    assert.equal(budget.reserved.tokens, dispatched ? estimate().tokens : 0);
    assert.equal(budget.gate_code, dispatched ? "USAGE_UNKNOWN" : null);
    assert.throws(() => ledger.finish(lease, result(lease.envelope)), { code: "LEASE_LOST" });
    assert.equal(ledger.watch(scope().watch_id).interpretation_delivery_id, null); ledger.verifyIntegrity(); ledger.close();
  }
});

test("policy revisions are immutable and never grant trading or public redistribution", () => {
  const ledger = new ResearchLedger(root()); configureEventWatch(ledger);
  assert.equal(ledger.configureSourcePolicy(scope().watch_id, sourcePolicy()).reused, true);
  assert.throws(() => ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), rights_status: "HOLD" }), { code: "SOURCE_POLICY_CONFLICT" });
  assert.throws(() => ledger.configureSourcePolicy(scope().watch_id, sourcePolicy(3)), { code: "SOURCE_POLICY_CONFLICT" });
  assert.throws(() => ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), allowed_purposes: ["trading"] }), { code: "INVALID_SOURCE_POLICY" });
  assert.equal(ledger.sourcePolicy(scope().watch_id, "synthetic-exchange").policy.revision, 1); ledger.close();
});

test("replay reports the current HOLD policy and can resume an undispatched job after explicit authority restoration", () => {
  const ledger = new ResearchLedger(root(), { clock: () => 1000 }); const method = configureEventWatch(ledger); const input = intake(method);
  const first = ledger.intakeSourceEvent(input);
  ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
  const held = ledger.intakeSourceEvent(input); assert.equal(held.decision.outcome, "gated"); assert.equal(held.decision.gate_code, "SOURCE_RIGHTS_HOLD");
  assert.equal(held.decision.policy_sha256, ledger.sourcePolicy(scope().watch_id, "synthetic-exchange").sha256);
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy(3)); const resumed = ledger.intakeSourceEvent(input);
  assert.equal(resumed.decision.outcome, "queued"); assert.equal(resumed.run.run_id, first.run.run_id);
  assert.equal(resumed.decision.policy_sha256, contentHash(sourcePolicy(3)));
  assert.equal(ledger.claim("a").run_id, first.run.run_id); assert.equal(ledger.claim("b"), null); ledger.verifyIntegrity(); ledger.close();
});

for (const point of ["before_commit", "after_commit"]) test(`event intake recovers an atomic ${point} storage failure`, () => {
  const directory = root(); let fail = true; const ledger = new ResearchLedger(directory, { fault: (event) => {
    if (fail && event === `event_intake:${point}`) { fail = false; throw new Error("Synthetic write failure."); }
  } });
  const method = configureEventWatch(ledger); const input = intake(method);
  assert.throws(() => ledger.intakeSourceEvent(input), { code: "STORAGE_WRITE_UNCERTAIN" }); ledger.close();
  const reopened = new ResearchLedger(directory); const ready = reopened.intakeSourceEvent(input);
  assert.equal(ready.reused, point === "after_commit"); assert.equal(reopened.eventDecisions(scope().watch_id).length, 1);
  assert.equal(reopened.claim("a").run_id, ready.run.run_id); assert.equal(reopened.claim("b"), null); reopened.close();
});

test("backup and restore verify facts, source policies, decisions, and the unique job reference", () => {
  const directory = root(); const ledger = new ResearchLedger(directory); const method = configureEventWatch(ledger);
  const queued = ledger.intakeSourceEvent(intake(method)); const snapshot = ledger.backup("events.sqlite"); ledger.close();
  const restored = restoreResearchLedger(snapshot, join(directory, "restored"));
  assert.equal(restored.eventDecisions(scope().watch_id)[0].run_id, queued.run.run_id);
  assert.equal(restored.intakeSourceEvent(intake(method)).reused, true); restored.close();
  for (const [index, change] of ["UPDATE normalized_facts SET fact_json='{}'", "UPDATE source_policies SET policy_json='{}'", "UPDATE event_decisions SET decision_json='{}'"].entries()) {
    const path = join(directory, `changed-${index}.sqlite`); copyFileSync(snapshot, path);
    const changed = new DatabaseSync(path); changed.exec(change); changed.close();
    assert.throws(() => restoreResearchLedger(path, join(directory, `rejected-${index}`)), { code: "STORAGE_CORRUPT" });
  }
});

test("deleted event jobs and facts fail integrity verification before replay can duplicate research", () => {
  for (const change of ["DELETE FROM event_jobs", "DELETE FROM normalized_facts", "DELETE FROM source_fact_sets"]) {
    const directory = root(); const ledger = new ResearchLedger(directory); const method = configureEventWatch(ledger);
    ledger.intakeSourceEvent(intake(method)); const backup = ledger.backup("complete.sqlite"); ledger.close();
    const modified = new DatabaseSync(backup); modified.exec(change); modified.close();
    assert.throws(() => restoreResearchLedger(backup, join(directory, "rejected")), { code: "STORAGE_CORRUPT" });
    const altered = new DatabaseSync(join(directory, "research.sqlite")); altered.exec(change); altered.close();
    assert.throws(() => new ResearchLedger(directory), { code: "STORAGE_CORRUPT" });
  }
});

test("schema-two workspaces upgrade with a private backup before adding event tables", () => {
  const directory = root(); const ledger = new ResearchLedger(directory); ledger.saveRevision(scope(), context()); ledger.close();
  const db = new DatabaseSync(join(directory, "research.sqlite"));
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec("DROP TABLE schedule_worker_ticks; DROP TABLE schedule_workers;");
  db.exec("DROP TABLE thesis_reviews; DROP TABLE thesis_proposals; DROP TABLE thesis_heads; DROP TABLE thesis_manifest;");
  db.exec("DROP TABLE schedule_run_leases; DROP TABLE schedule_ticks; DROP TABLE schedule_state; DROP TABLE schedule_configs;");
  db.exec("DROP TABLE method_trial_outputs; DROP TABLE method_trial_manifest; DROP TABLE method_trial_pairs; DROP TABLE method_artifact_manifest; DROP TABLE method_artifacts;");
  db.exec("DROP TABLE usage_reconciliations; DROP TABLE request_receipts; ALTER TABLE requests DROP COLUMN accounting_version; ALTER TABLE requests DROP COLUMN receipt_set_sha256; ALTER TABLE requests DROP COLUMN selected_receipt_sha256; ALTER TABLE requests DROP COLUMN reconciliation_sha256; DROP TABLE event_jobs; DROP TABLE event_decisions; DROP TABLE source_policies; DROP TABLE source_fact_sets; DROP TABLE normalized_facts; PRAGMA user_version=2;"); db.close();
  const upgraded = new ResearchLedger(directory); assert.equal(upgraded.verifyIntegrity().schema_version, LEDGER_SCHEMA_VERSION);
  assert.ok(readdirSync(directory).some((name) => name.startsWith("before-schema-3-"))); upgraded.close();
});

const childScript = `import { ResearchLedger } from ${JSON.stringify(new URL("../client/local/ledger.mjs", import.meta.url).href)};
  import { intake, eventFixture } from ${JSON.stringify(new URL("./fixtures/source-events.mjs", import.meta.url).href)};
  const ledger = new ResearchLedger(process.argv[1], { fault: point => { if (point === process.argv[3]) process.kill(process.pid,'SIGKILL'); } });
  const output = ledger.intakeSourceEvent(intake({bundle_sha256:process.argv[2]},eventFixture()));
  console.log(JSON.stringify({reused:output.reused,run_id:output.run?.run_id})); ledger.close();`;
function runChild(directory, method, fault = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript, directory, method.bundle_sha256, fault], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

test("six OS processes retain one event decision and research job", { timeout: 20_000 }, async () => {
  const directory = root(); const ledger = new ResearchLedger(directory); const method = configureEventWatch(ledger); ledger.close();
  const outputs = await Promise.all(Array.from({ length: 6 }, () => runChild(directory, method)));
  outputs.forEach((output) => assert.equal(output.code, 0, output.stderr));
  const records = outputs.map((output) => JSON.parse(output.stdout));
  assert.equal(records.filter((output) => !output.reused).length, 1); assert.equal(new Set(records.map((output) => output.run_id)).size, 1);
  const reopened = new ResearchLedger(directory); assert.equal(reopened.eventDecisions(scope().watch_id).length, 1);
  assert.equal(reopened.notices().length, 0); assert.equal(reopened.claim("a").run_id, records[0].run_id);
  assert.equal(reopened.claim("b"), null); reopened.close();
});

for (const boundary of ["before_commit", "after_commit"]) test(`SIGKILL at event_intake:${boundary} preserves source-to-job recovery`, { timeout: 15_000 }, async () => {
  const directory = root(); const ledger = new ResearchLedger(directory); const method = configureEventWatch(ledger); ledger.close();
  const exit = await runChild(directory, method, `event_intake:${boundary}`); assert.equal(exit.signal, "SIGKILL", exit.stderr);
  const reopened = new ResearchLedger(directory); const output = reopened.intakeSourceEvent(intake(method));
  assert.equal(output.reused, boundary === "after_commit"); assert.equal(reopened.eventDecisions(scope().watch_id).length, 1);
  assert.equal(reopened.sourceFacts(eventFixture().event.source_event_id).length, 1); reopened.verifyIntegrity(); reopened.close();
});
