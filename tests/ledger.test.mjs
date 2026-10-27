import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ResearchLedger, restoreResearchLedger } from "../client/local/ledger.mjs";
import { createRunEnvelope, contentHash } from "../client/local/run-contract.mjs";
import { setup, scope, context, policy, result, estimate, source, methodBundle, limits } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";

function environment(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "equitylayer-ledger-test-"));
  let now = 1000;
  const ledger = new ResearchLedger(directory, { clock: () => now, ...options });
  return { directory, ledger, setNow: (value) => { now = value; } };
}
const rejects = (action, code) => assert.throws(action, { code });
function queued(ledger, number = 1) {
  const envelope = setup(ledger, number);
  if (!ledger.sourcePolicy(scope().watch_id, "synthetic-exchange")) ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  ledger.enqueue(envelope, "test-window", policy());
  return envelope;
}

test("SQLite closes and reopens with immutable scope, method, sources, and checkpoints", () => {
  const { ledger, directory } = environment(); const envelope = queued(ledger);
  const lease = ledger.claim("worker-a"); ledger.checkpoint(lease, "plan", { pinned: true });
  ledger.close();
  const reopened = new ResearchLedger(directory, { clock: () => 1001 });
  assert.deepEqual(reopened.run(envelope.run_id).envelope, envelope);
  assert.equal(reopened.checkpoints(envelope.run_id)[0].payload.pinned, true);
  assert.equal(reopened.watch(scope().watch_id).revisions[0].local_context.question, context().question);
  assert.equal(lstatSync(join(directory, "research.sqlite")).mode & 0o777, 0o600);
  reopened.close();
});

test("observed and queued events do not advance completed evidence", () => {
  const { ledger } = environment(); const first = setup(ledger); const nextSource = source(2);
  ledger.retainSource(nextSource.event, nextSource.artifact, nextSource.bytes);
  ledger.observeSource(scope().watch_id, nextSource.artifact.source_id, nextSource.event.source_event_id);
  let cursor = ledger.cursors(scope().watch_id)[0];
  assert.equal(cursor.observed_event_id, "event-2"); assert.equal(cursor.queued_event_id, null); assert.equal(cursor.completed_event_id, null);
  ledger.enqueue(first, "test-window", policy());
  cursor = ledger.cursors(scope().watch_id)[0];
  assert.equal(cursor.observed_event_id, "event-2"); assert.equal(cursor.queued_event_id, "event-1"); assert.equal(cursor.completed_event_id, null);
  ledger.finish(ledger.claim("a"), result(first)); cursor = ledger.cursors(scope().watch_id)[0];
  assert.equal(cursor.completed_event_id, "event-1"); assert.equal(cursor.observed_event_id, "event-2");
  rejects(() => ledger.observeSource(scope().watch_id, "another-source", "event-2"), "REFERENCE_CONFLICT");
  ledger.close();
});

test("revision, reference, run policy, and checkpoint conflicts do not replace retained data", () => {
  const { ledger } = environment(); const envelope = queued(ledger);
  assert.equal(ledger.enqueue(envelope, "test-window", policy()).run_id, envelope.run_id);
  rejects(() => ledger.saveRevision(scope(), { private_question: "different" }), "REVISION_CONFLICT");
  rejects(() => ledger.saveRevision(scope(3), context()), "REVISION_CONFLICT");
  rejects(() => ledger.enqueue(envelope, "test-window", { ...policy(), max_attempts: 5 }), "RUN_IDENTITY_CONFLICT");
  const changed = source(); changed.event.parser_version = "2";
  rejects(() => ledger.retainSource(changed.event, changed.artifact, changed.bytes), "REFERENCE_CONFLICT");
  const lease = ledger.claim("worker-a"); ledger.checkpoint(lease, "plan", { value: 1 });
  rejects(() => ledger.checkpoint(lease, "plan", { value: 2 }), "CHECKPOINT_CONFLICT");
  assert.equal(ledger.checkpoints(envelope.run_id)[0].payload.value, 1);
  ledger.close();
});

test("retained bytes and method references must exist before enqueue", () => {
  const { ledger } = environment(); const envelope = setup(ledger);
  const { run_id, delivery_id, contract_version, ...input } = envelope;
  const unretained = createRunEnvelope({ ...input, source_refs: [{ ...input.source_refs[0], source_event_id: "missing" }] });
  rejects(() => ledger.enqueue(unretained, "test-window", policy()), "REFERENCE_MISSING");
  const wrongMethod = createRunEnvelope({ ...input, method: { ...input.method, bundle_sha256: "f".repeat(64) } });
  rejects(() => ledger.enqueue(wrongMethod, "test-window", policy()), "REFERENCE_MISSING");
  const wrongHash = createRunEnvelope({ ...input, source_refs: [{ ...input.source_refs[0], artifact_sha256: "f".repeat(64) }] });
  rejects(() => ledger.enqueue(wrongHash, "test-window", policy()), "SOURCE_REFERENCE_CONFLICT");
  ledger.close();
});

test("two connections cannot claim one live run, and stale fencing tokens cannot write", () => {
  const { ledger, directory, setNow } = environment(); const envelope = queued(ledger);
  let otherNow = 1000; const other = new ResearchLedger(directory, { clock: () => otherNow });
  const a = ledger.claim("a", 100); assert.equal(other.claim("b", 100), null);
  ledger.checkpoint(a, "first", { value: 1 });
  setNow(1101); otherNow = 1101;
  const b = other.claim("b", 100); assert.equal(b.fence, a.fence + 1);
  rejects(() => ledger.checkpoint(a, "late", {}), "LEASE_LOST");
  rejects(() => ledger.finish(a, result(envelope)), "LEASE_LOST");
  assert.equal(other.checkpoints(envelope.run_id).length, 1);
  other.finish(b, result(envelope));
  other.close(); ledger.close();
});

test("heartbeat and retry caps preserve checkpoints without unbounded attempts", () => {
  const { ledger, setNow } = environment(); const envelope = setup(ledger);
  ledger.enqueue(envelope, "test-window", { ...policy(), max_attempts: 2 });
  const a = ledger.claim("a", 100); setNow(1050);
  assert.equal(ledger.heartbeat(a, 100).lease_until, 1150);
  assert.equal(ledger.heartbeat(a, 1).lease_until, 1150);
  setNow(1151); const b = ledger.claim("b", 100); assert.equal(b.fence, 2);
  setNow(1252); assert.equal(ledger.claim("c"), null);
  assert.equal(ledger.run(envelope.run_id).gate_code, "ATTEMPTS_EXCEEDED");
  ledger.close();
});

test("a pending reservation can recover, but a dispatched call with unknown usage gates the watch", () => {
  const { ledger, setNow } = environment(); const envelope = queued(ledger);
  const a = ledger.claim("a", 100); ledger.reserveRequest(a, "analysis", estimate());
  setNow(1101); const b = ledger.claim("b", 100);
  assert.equal(ledger.budget(scope().watch_id, "test-window").reserved.requests, 0);
  const request = ledger.reserveRequest(b, "analysis", estimate()); ledger.markDispatched(b, request.request_id);
  setNow(1202); assert.equal(ledger.claim("c"), null);
  assert.equal(ledger.run(envelope.run_id).gate_code, "USAGE_UNKNOWN");
  const budget = ledger.budget(scope().watch_id, "test-window");
  assert.equal(budget.spent.requests, 1); assert.equal(budget.reserved.tokens, 1000);
  assert.equal(budget.gate_code, "USAGE_UNKNOWN");
  assert.equal(ledger.notices().length, 1);
  const second = queued(ledger, 2); assert.equal(ledger.claim("d"), null);
  assert.equal(ledger.run(second.run_id).gate_code, "USAGE_UNKNOWN");
  ledger.close();
});

test("budget reservation is atomic across runs and settled operations reuse their saved response", () => {
  const { ledger, setNow } = environment();
  const first = setup(ledger); const second = setup(ledger, 2);
  ledger.configureBudget(scope().watch_id, "tight", { requests: 1, tokens: 1000, cost_microusd: 1000, wall_ms: 1000 });
  ledger.enqueue(first, "tight", policy()); ledger.enqueue(second, "tight", policy());
  const a = ledger.claim("a"); const b = ledger.claim("b");
  const request = ledger.reserveRequest(a, "analysis", estimate());
  assert.equal(ledger.reserveRequest(a, "analysis", estimate()).reused, true);
  rejects(() => ledger.reserveRequest(b, "analysis", estimate()), "BUDGET_EXHAUSTED");
  ledger.markDispatched(a, request.request_id); setNow(1100);
  ledger.settleRequest(a, request.request_id, { tokens: 500, cost_microusd: 200 }, { response: "saved" });
  const reused = ledger.reserveRequest(a, "analysis", estimate()); assert.equal(reused.reused, true);
  assert.equal(reused.response.response, "saved");
  const budget = ledger.budget(scope().watch_id, "tight");
  assert.equal(budget.spent.requests, 1); assert.equal(budget.spent.tokens, 500); assert.equal(budget.spent.wall_ms, 100);
  assert.equal(budget.reserved.tokens, 0);
  ledger.finish(a, result(first)); ledger.close();
});

test("unknown and exceeded usage never look like a completed no-change result", () => {
  for (const usage of [null, { tokens: 2000, cost_microusd: 2000 }]) {
    const { ledger } = environment(); const envelope = queued(ledger);
    const lease = ledger.claim("a"); const request = ledger.reserveRequest(lease, "analysis", estimate());
    ledger.markDispatched(lease, request.request_id); ledger.settleRequest(lease, request.request_id, usage, { response: "not accepted" });
    assert.equal(ledger.run(envelope.run_id).status, "gated");
    assert.equal(ledger.inbox().length, 0);
    rejects(() => ledger.finish(lease, result(envelope, "NO_NEW_EVIDENCE")), "LEASE_LOST");
    assert.equal(ledger.notices().length, 1); ledger.close();
  }
});

test("a scope change cancels the old run without releasing uncertain dispatched usage", () => {
  const { ledger } = environment(); const envelope = queued(ledger);
  const lease = ledger.claim("a"); const request = ledger.reserveRequest(lease, "analysis", estimate());
  ledger.markDispatched(lease, request.request_id); ledger.saveRevision(scope(2), context());
  assert.equal(ledger.run(envelope.run_id).status, "cancelled");
  assert.equal(ledger.budget(scope().watch_id, "test-window").gate_code, "USAGE_UNKNOWN");
  rejects(() => ledger.finish(lease, result(envelope)), "LEASE_LOST");
  assert.equal(ledger.watch(scope().watch_id).revisions.length, 2); ledger.close();
});

test("delivery and its outbox message are idempotent and cannot accept a baseline automatically", () => {
  const { ledger } = environment(); const envelope = queued(ledger); const lease = ledger.claim("a");
  const first = ledger.finish(lease, result(envelope)); assert.equal(first.reused, false);
  assert.equal(ledger.finish(lease, result(envelope)).reused, true);
  rejects(() => ledger.finish(lease, { ...result(envelope), summary: "changed" }), "DELIVERY_CONFLICT");
  assert.equal(ledger.inbox().length, 1); assert.equal(ledger.notices().length, 1);
  assert.equal(ledger.watch(scope().watch_id).evidence_delivery_id, null);
  ledger.acknowledgeNotice(first.delivery_id); ledger.acknowledgeNotice(first.delivery_id);
  assert.equal(ledger.notices().length, 0); ledger.close();
});

test("a sourced state with no source records cannot enter the inbox or acceptance state", () => {
  const { ledger } = environment(); const envelope = queued(ledger); const lease = ledger.claim("a");
  rejects(() => ledger.finish(lease, { ...result(envelope), sources: [] }), "RESULT_INVALID");
  assert.equal(ledger.inbox().length, 0); ledger.close();
});

test("malformed result files cannot complete evidence cursors or become accepted evidence", () => {
  const { ledger } = environment(); const envelope = queued(ledger); const lease = ledger.claim("a");
  const malformed = { ...result(envelope), schema_version: 999, sources: [null] }; delete malformed.summary;
  rejects(() => ledger.finish(lease, malformed), "RESULT_INVALID");
  assert.equal(ledger.inbox().length, 0); assert.equal(ledger.notices().length, 0);
  assert.equal(ledger.cursors(scope().watch_id)[0].completed_event_id, null);
  rejects(() => ledger.review(envelope.delivery_id, "accept_evidence", "Invalid data.", "malformed", 0), "DELIVERY_MISSING");
  assert.equal(ledger.watch(scope().watch_id).evidence_delivery_id, null);
  ledger.close();
});

test("receiving, evidence acceptance, interpretation acceptance, revisit, and reject remain distinct", () => {
  const { ledger } = environment(); const a = queued(ledger); const aId = ledger.finish(ledger.claim("a"), result(a)).delivery_id;
  ledger.review(aId, "received", "Read result A.", "received-a", 0);
  assert.equal(ledger.watch(scope().watch_id).evidence_delivery_id, null);
  ledger.review(aId, "accept_evidence", "Accept evidence A.", "evidence-a", 1);
  assert.equal(ledger.watch(scope().watch_id).interpretation_delivery_id, null);
  ledger.review(aId, "accept_interpretation", "Accept interpretation A.", "view-a", 2);
  const b = queued(ledger, 2); const bId = ledger.finish(ledger.claim("b"), result(b)).delivery_id;
  ledger.review(bId, "revisit", "Recheck B.", "revisit-b", 3);
  ledger.review(bId, "reject", "Reject B.", "reject-b", 4);
  const watch = ledger.watch(scope().watch_id);
  assert.equal(watch.evidence_delivery_id, aId); assert.equal(watch.interpretation_delivery_id, aId);
  assert.equal(ledger.reviews(scope().watch_id).length, 5);
  assert.equal(ledger.review(bId, "reject", "Reject B.", "reject-b", 4).reused, true);
  rejects(() => ledger.review(bId, "accept_interpretation", "Accept B.", "reject-b", 4), "REVIEW_CONFLICT");
  rejects(() => ledger.review(bId, "accept_interpretation", "Accept B.", "new-b", 0), "REVIEW_CONFLICT");
  ledger.close();
});

test("missing-source and old-revision deliveries cannot replace accepted evidence or interpretation", () => {
  const { ledger } = environment(); const a = queued(ledger); const aId = ledger.finish(ledger.claim("a"), result(a)).delivery_id;
  ledger.review(aId, "accept_evidence", "Accept A.", "accept-a", 0);
  const b = queued(ledger, 2); const bId = ledger.finish(ledger.claim("b"), result(b, "SOURCE_NEEDED")).delivery_id;
  rejects(() => ledger.review(bId, "accept_evidence", "Missing data.", "missing-b", 1), "ACCEPTANCE_GATED");
  ledger.saveRevision(scope(2), context());
  rejects(() => ledger.review(aId, "accept_interpretation", "Old scope.", "old-a", 1), "ACCEPTANCE_GATED");
  assert.equal(ledger.watch(scope().watch_id).evidence_delivery_id, aId); ledger.close();
});

test("history continues past 31 updates and inbox pages do not delete earlier results", () => {
  const { ledger } = environment();
  for (let number = 1; number <= 35; number++) {
    const envelope = queued(ledger, number); ledger.finish(ledger.claim(`worker-${number}`), result(envelope));
  }
  const page = ledger.inbox({ limit: 20 }); const next = ledger.inbox({ after: page.at(-1).sequence, limit: 20 });
  assert.equal(page.length, 20); assert.equal(next.length, 15); assert.equal(ledger.inbox({ limit: 100 }).length, 35);
  ledger.close();
});

test("transaction failure and a lost post-commit reply retain atomic recovery semantics", () => {
  for (const point of ["enqueue:before_commit", "enqueue:after_commit"]) {
    let enabled = false;
    const { directory, ledger } = environment({ fault: (current) => { if (enabled && current === point) { const error = new Error("Synthetic disk or lost-reply fault."); error.code = "ENOSPC"; throw error; } } });
    const envelope = setup(ledger); enabled = true;
    rejects(() => ledger.enqueue(envelope, "test-window", policy()), "STORAGE_WRITE_UNCERTAIN");
    ledger.close();
    const reopened = new ResearchLedger(directory, { clock: () => 1000 });
    assert.equal(Boolean(reopened.run(envelope.run_id)), point.endsWith("after_commit"));
    reopened.enqueue(envelope, "test-window", policy()); assert.equal(reopened.claim("a").run_id, envelope.run_id);
    assert.equal(reopened.claim("b"), null); reopened.close();
  }
});

test("unsafe paths, unsupported schema, and corrupt database data fail without replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "equitylayer-unsafe-test-"));
  chmodSync(directory, 0o755); rejects(() => new ResearchLedger(directory), "UNSAFE_STORAGE_PATH"); chmodSync(directory, 0o700);
  const target = join(directory, "target"); writeFileSync(target, "unchanged", { mode: 0o600 });
  symlinkSync(target, join(directory, "research.sqlite")); rejects(() => new ResearchLedger(directory), "UNSAFE_STORAGE_PATH");
  assert.equal(readFileSync(target, "utf8"), "unchanged");
  const corrupt = mkdtempSync(join(tmpdir(), "equitylayer-corrupt-test-"));
  writeFileSync(join(corrupt, "research.sqlite"), "not sqlite", { mode: 0o600 });
  assert.throws(() => new ResearchLedger(corrupt)); assert.equal(readFileSync(join(corrupt, "research.sqlite"), "utf8"), "not sqlite");
  const newer = mkdtempSync(join(tmpdir(), "equitylayer-newer-test-"));
  writeFileSync(join(newer, "research.sqlite"), "", { mode: 0o600 });
  const db = new DatabaseSync(join(newer, "research.sqlite")); db.exec("PRAGMA user_version=99"); db.close();
  rejects(() => new ResearchLedger(newer), "SCHEMA_UNSUPPORTED");
  for (const version of [0, 1]) {
    const unrelated = mkdtempSync(join(tmpdir(), "equitylayer-unrelated-test-"));
    writeFileSync(join(unrelated, "research.sqlite"), "", { mode: 0o600 });
    const other = new DatabaseSync(join(unrelated, "research.sqlite"));
    other.exec(`CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('retain'); PRAGMA user_version=${version};`); other.close();
    rejects(() => new ResearchLedger(unrelated), "SCHEMA_UNSUPPORTED");
    const verify = new DatabaseSync(join(unrelated, "research.sqlite"), { readOnly: true });
    assert.equal(verify.prepare("SELECT value FROM unrelated").get().value, "retain"); verify.close();
  }
  const foreign = mkdtempSync(join(tmpdir(), "equitylayer-foreign-empty-test-"));
  writeFileSync(join(foreign, "research.sqlite"), "", { mode: 0o600 });
  const tagged = new DatabaseSync(join(foreign, "research.sqlite")); tagged.exec("PRAGMA application_id=12345"); tagged.close();
  rejects(() => new ResearchLedger(foreign), "SCHEMA_UNSUPPORTED");
  const verifyTag = new DatabaseSync(join(foreign, "research.sqlite"), { readOnly: true });
  assert.equal(verifyTag.prepare("PRAGMA application_id").get().application_id, 12345);
  assert.equal(verifyTag.prepare("PRAGMA user_version").get().user_version, 0); verifyTag.close();
});

test("a private SQLite snapshot restores into a new workspace with both accepted references and complete history", () => {
  const { ledger, directory } = environment(); const envelope = queued(ledger);
  const deliveryId = ledger.finish(ledger.claim("a"), result(envelope)).delivery_id;
  ledger.review(deliveryId, "accept_evidence", "Accept the synthetic evidence for this test.", "evidence", 0);
  ledger.review(deliveryId, "accept_interpretation", "Accept the synthetic view for this test.", "view", 1);
  const snapshot = ledger.backup("test-backup.sqlite");
  assert.equal(lstatSync(snapshot).mode & 0o777, 0o600);
  assert.throws(() => ledger.backup("test-backup.sqlite"), { code: "EEXIST" });
  rejects(() => ledger.backup("../outside.sqlite"), "UNSAFE_STORAGE_PATH");
  const restored = restoreResearchLedger(snapshot, join(directory, "restored"));
  assert.equal(restored.watch(scope().watch_id).evidence_delivery_id, deliveryId);
  assert.equal(restored.watch(scope().watch_id).interpretation_delivery_id, deliveryId);
  assert.equal(restored.inbox().length, 1); assert.equal(restored.reviews(scope().watch_id).length, 2);
  rejects(() => restoreResearchLedger(snapshot, directory), "UNSAFE_STORAGE_PATH");
  restored.close(); ledger.close();
});

const childScript = fileURLToPath(new URL("./helpers/ledger-process.mjs", import.meta.url));
async function worker(directory, registry) {
  const child = fork(childScript, [directory, "worker"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  registry.add(child);
  let diagnostics = ""; child.stderr.on("data", (value) => { diagnostics += value; });
  await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", () => reject(new Error(`The synthetic worker exited before readiness. ${diagnostics}`)));
    child.once("message", resolve);
  });
  return child;
}
function request(child, message) {
  return new Promise((resolve, reject) => {
    child.once("message", resolve); child.once("error", reject); child.send(message);
  });
}

test("partial startup failure closes the already-ready owned IPC worker", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "equitylayer-cleanup-test-"));
  const unsafe = mkdtempSync(join(tmpdir(), "equitylayer-cleanup-unsafe-test-")); chmodSync(unsafe, 0o755);
  const registry = new Set(); let ready;
  try {
    ready = await worker(directory, registry);
    await assert.rejects(worker(unsafe, registry), /private owned path/);
  } finally {
    registry.forEach((child) => { if (child.connected) child.disconnect(); });
    await Promise.all([...registry].map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }));
  }
  assert.equal(ready.connected, false); assert.equal(ready.exitCode, 0);
});

test("twenty process pairs initialize private workspaces without replacing their schemas", { timeout: 30_000 }, async () => {
  for (let pair = 0; pair < 20; pair++) {
    const directory = mkdtempSync(join(tmpdir(), "equitylayer-initialization-test-"));
    const registry = new Set();
    try {
      const children = await Promise.all([worker(directory, registry), worker(directory, registry)]);
      const messages = await Promise.all(children.map((child) => request(child, { command: "claim" })));
      assert.equal(messages.every((value) => value.output === null), true);
    } finally { registry.forEach((child) => { if (child.connected) child.disconnect(); }); }
  }
});

test("separate OS processes serialize one claim and a shared budget reservation", { timeout: 15_000 }, async () => {
  const { ledger, directory } = environment(); const first = setup(ledger); const second = setup(ledger, 2);
  ledger.configureBudget(scope().watch_id, "race", { requests: 1, tokens: 1000, cost_microusd: 1000, wall_ms: 1000 });
  ledger.enqueue(first, "race", policy());
  const registry = new Set();
  try {
    const [a, b] = await Promise.all([worker(directory, registry), worker(directory, registry)]);
    const firstClaims = await Promise.all([request(a, { command: "claim" }), request(b, { command: "claim" })]);
    assert.equal(firstClaims.filter((value) => value.output !== null).length, 1);
    ledger.enqueue(second, "race", policy());
    const winner = firstClaims[0].output ? a : b; const loser = winner === a ? b : a;
    const winnerLease = firstClaims.find((value) => value.output !== null).output;
    const loserLease = (await request(loser, { command: "claim" })).output;
    const reservations = await Promise.all([request(winner, { command: "reserve", lease: winnerLease }), request(loser, { command: "reserve", lease: loserLease })]);
    assert.equal(reservations.filter((value) => value.error === "BUDGET_EXHAUSTED").length, 1);
    assert.equal(ledger.budget(scope().watch_id, "race").reserved.requests, 1);
  } finally { registry.forEach((child) => { if (child.connected) child.disconnect(); }); ledger.close(); }
});

for (const mode of ["schema", "enqueue", "checkpoint", "reserve", "dispatch", "settle", "finish", "review", "acknowledge"]) {
  for (const boundary of ["before_commit", "after_commit"]) {
    test(`SIGKILL at ${mode}:${boundary} preserves atomic state and recovery`, { timeout: 10_000 }, async () => {
      const directory = mkdtempSync(join(tmpdir(), "equitylayer-crash-test-"));
      let envelope;
      if (mode !== "schema") {
        const initial = new ResearchLedger(directory, { clock: () => 1000 }); envelope = setup(initial);
        if (mode === "review") initial.configureSourcePolicy(scope().watch_id, sourcePolicy());
        if (mode !== "enqueue") initial.enqueue(envelope, "test-window", policy());
        if (["review", "acknowledge"].includes(mode)) initial.finish(initial.claim("initial"), result(envelope));
        initial.close();
      }
      const child = spawn(process.execPath, [childScript, directory, mode, `${mode}:${boundary}`], { stdio: ["ignore", "ignore", "pipe"] });
      let diagnostics = ""; child.stderr.on("data", (value) => { diagnostics += value; });
      const closed = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
      assert.equal(closed.signal, "SIGKILL", diagnostics);
      const reopened = new ResearchLedger(directory, { clock: () => 2001 });
      if (mode === "schema") { assert.equal(reopened.watch(scope().watch_id), null); reopened.close(); return; }
      const after = boundary === "after_commit";
      if (mode === "enqueue") assert.equal(Boolean(reopened.run(envelope.run_id)), after);
      if (mode === "checkpoint") assert.equal(reopened.checkpoints(envelope.run_id).length, after ? 1 : 0);
      if (mode === "reserve") assert.equal(reopened.budget(scope().watch_id, "test-window").reserved.requests, after ? 1 : 0);
      if (mode === "dispatch") assert.equal(reopened.budget(scope().watch_id, "test-window").spent.requests, after ? 1 : 0);
      if (mode === "settle") assert.equal(reopened.budget(scope().watch_id, "test-window").spent.tokens, after ? 100 : 0);
      if (mode === "finish") { assert.equal(reopened.inbox().length, after ? 1 : 0); assert.equal(reopened.notices().length, after ? 1 : 0); }
      if (mode === "review") assert.equal(reopened.watch(scope().watch_id).evidence_delivery_id, after ? envelope.delivery_id : null);
      if (mode === "acknowledge") assert.equal(reopened.notices().length, after ? 0 : 1);
      if (["checkpoint", "reserve"].includes(mode)) {
        assert.equal(reopened.claim("recovery").run_id, envelope.run_id);
        assert.equal(reopened.budget(scope().watch_id, "test-window").reserved.requests, 0);
      }
      if (mode === "dispatch" && after || mode === "settle" && !after) {
        assert.equal(reopened.claim("recovery"), null);
        assert.equal(reopened.run(envelope.run_id).gate_code, "USAGE_UNKNOWN");
      }
      reopened.close();
    });
  }
}
