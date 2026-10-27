import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync, chmodSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runDocuments, collectDocumentAnswers } from "../client/documents-cli.mjs";
import { setupWorkspace } from "../client/setup-cli.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { methodBundle } from "./fixtures/local-research.mjs";
const clock = () => Date.parse("2026-10-26T20:00:00Z");
const metadata = () => ({ canonical_url: "https://example.test/retained-release", source_class: "issuer_release", symbols: ["TTMI"],
  retrieved_at: "2026-10-25T10:00:00Z", published_at: null, source_period: "2026-Q3", content_type: "text/html; charset=utf-8",
  http_status: 200, rights_status: "HOLD", rights_reference: null, allow_candidate_trials: false, max_source_age_days: 30 });
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-documents-test-"))), workspace = join(root, "workspace"), file = join(root, "source.html"), answers = join(root, "answers.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const setup = await setupWorkspace({ workspace, session: true, method_bundle: methodBundle(),
    answers: { focus: "pcb_ccl", symbols: ["TTMI", "2383.TW"], question: "PRIVATE_QUESTION", trigger: "PRIVATE_TRIGGER" } }, { clock });
  writeFileSync(file, "<h1>Synthetic release</h1><p>Not investment evidence.</p>", { mode: 0o600 });
  const run = async (value = metadata(), flags = [], deps = {}) => {
    writeFileSync(answers, JSON.stringify(value), { mode: 0o600 });
    return runDocuments(["--workspace", workspace, "--file", file, "--answers", answers, ...flags], { clock, stdout() {}, ...deps });
  };
  const open = options => new ResearchLedger(workspace, { clock, ...options });
  return { root, workspace, file, answers, run, setup, open };
}
const allowed = () => ({ ...metadata(), rights_status: "ALLOWED", rights_reference: "Synthetic permission for local research only.", allow_candidate_trials: true });

test("document intake retains exact bytes with HOLD, no work or acceptance, and stable replay after reopening", async t => {
  const f = await fixture(t), first = await f.run(); assert.equal(first.exitCode, 0); assert.equal(first.output.status, "retained_rights_held");
  assert.equal(first.output.published_at_known, false); assert.equal(first.output.reused, false);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|Synthetic release|rights_reference/);
  const ledger = f.open();
  try {
    const saved = ledger.source(first.output.reference.source_event_id);
    assert.deepEqual(saved.bytes, readFileSync(f.file)); assert.equal(saved.artifact.published_at, null);
    assert.equal(saved.artifact.retrieved_at, metadata().retrieved_at); assert.equal(saved.event.observed_at, new Date(clock()).toISOString());
    assert.equal(saved.event.event_kind, "LATE_SOURCE_ARRIVED"); assert.equal(saved.event.supersedes_source_event_id, null);
    assert.equal(ledger.sourceFacts(saved.event.source_event_id).length, 0);
    const choices = ledger.workspaceSessionOptions(f.setup.watch_id);
    assert.equal(choices.sources.items.length, 1); assert.notEqual(choices.sources.items[0].gate_code, null);
    assert.deepEqual(ledger.workspaceStatus().counts, { watches: 1, runs: 0, deliveries: 0, requests: 0, receipts: 0, notices: 0 });
    assert.equal(ledger.pageSchedules().length, 0); ledger.verifyIntegrity();
  } finally { ledger.close(); }
  const second = await f.run(metadata(), [], { clock: () => clock() + 10000 });
  assert.equal(second.exitCode, 0); assert.equal(second.output.reused, true); assert.deepEqual(first.output.reference, second.output.reference);
});
test("allowed local use needs explicit consent and source selection still grants no research adoption", async t => {
  const f = await fixture(t);
  assert.equal((await f.run(allowed())).output.code, "DOCUMENT_LOCAL_USE_CONFIRMATION_REQUIRED");
  const saved = await f.run(allowed(), ["--confirm-local-source-use"]);
  assert.equal(saved.output.status, "retained_for_session_selection");
  for (const key of ["commercial_reuse_authorized", "research_accepted", "model_called", "network_called", "tracking_started", "payment_authorized", "trading_authorized"]) assert.equal(saved.output[key], false);
  const ledger = f.open(); try {
    const choices = ledger.workspaceSessionOptions(f.setup.watch_id);
    assert.equal(choices.sources.items[0].gate_code, null);
    assert.equal(ledger.sourcePolicy(f.setup.watch_id, saved.output.source_id).policy.allowed_purposes[0], "local_research"); ledger.verifyIntegrity();
  } finally { ledger.close(); }
});
test("same-URL content changes and rights changes cannot overwrite a retained document or HOLD", async t => {
  const f = await fixture(t), first = await f.run();
  assert.equal((await f.run(allowed(), ["--confirm-local-source-use"])).output.code, "DOCUMENT_POLICY_REVIEW_REQUIRED");
  writeFileSync(f.file, "<p>Changed document.</p>");
  assert.equal((await f.run()).output.code, "DOCUMENT_VERSION_REVIEW_REQUIRED");
  const ledger = f.open(); try {
    assert.match(ledger.source(first.output.reference.source_event_id).bytes.toString(), /Synthetic release/);
    assert.equal(ledger.sourcePolicy(f.setup.watch_id, first.output.source_id).policy.rights_status, "HOLD"); ledger.verifyIntegrity();
  } finally { ledger.close(); }
});
for (const stage of ["before_commit", "after_commit"]) test(`document ${stage} fault preserves atomic recovery without duplicate history`, async t => {
  const f = await fixture(t), failed = await f.run(metadata(), [], { fault: point => { if (point === `document_intake:${stage}`) throw Error("Synthetic crash."); } });
  assert.equal(failed.exitCode, 1);
  const recovered = await f.run(); assert.equal(recovered.exitCode, 0); assert.equal(recovered.output.reused, stage === "after_commit");
  const ledger = f.open(); try { assert.equal(ledger.workspaceSessionOptions(f.setup.watch_id).sources.items.length, 1); ledger.verifyIntegrity(); } finally { ledger.close(); }
});
for (const [label, change] of Object.entries({ company: { symbols: ["NVDA"] }, duplicate: { symbols: ["TTMI", "TTMI"] },
  unknown: { secret: "DO_NOT_PRINT" }, future: { retrieved_at: "2026-11-01T00:00:00Z" },
  publication: { published_at: "2026-10-26T00:00:00Z" }, date: { retrieved_at: "2026-02-30T00:00:00Z" },
  status: { http_status: 404 }, media: { content_type: "application/pdf" }, credential: { canonical_url: "https://secret@example.test/file" },
  age: { max_source_age_days: 0 }, permission: { allow_candidate_trials: true } })) test(`invalid document ${label} creates no source or policy`, async t => {
  const f = await fixture(t), value = await f.run({ ...metadata(), ...change });
  assert.equal(value.exitCode, 1); assert.doesNotMatch(JSON.stringify(value), /DO_NOT_PRINT|secret@example/);
  const ledger = f.open(); try { assert.equal(ledger.workspaceSessionOptions(f.setup.watch_id).sources.items.length, 0); ledger.verifyIntegrity(); } finally { ledger.close(); }
});
for (const kind of ["symlink", "hardlink", "writable", "binary", "oversize"]) test(`unsafe document ${kind} is refused`, async t => {
  const f = await fixture(t);
  if (kind === "symlink") { const copy = join(f.root, "copy.html"); writeFileSync(copy, "safe"); rmSync(f.file); symlinkSync(copy, f.file); }
  if (kind === "hardlink") linkSync(f.file, join(f.root, "linked.html"));
  if (kind === "writable") chmodSync(f.file, 0o666);
  if (kind === "binary") writeFileSync(f.file, Buffer.from([0xff, 0, 3]));
  if (kind === "oversize") writeFileSync(f.file, Buffer.alloc(2_000_001, 32));
  assert.equal((await f.run()).exitCode, 1);
});
test("document prompt keeps unknown dates and held rights without technical source schemas", async t => {
  const replies = [metadata().canonical_url, "", "TTMI", metadata().retrieved_at, "", "", "", "200", "", "", "yes"];
  const answer = await collectDocumentAnswers(async () => replies.shift(), { symbols: ["TTMI", "2383.TW"] });
  assert.equal(answer.metadata.rights_status, "HOLD"); assert.equal(answer.metadata.published_at, null);
  assert.equal(answer.metadata.allow_candidate_trials, false); assert.equal(answer.confirm_local_use, false);
  const f = await fixture(t); assert.equal((await f.run(answer.metadata)).exitCode, 0);
});
test("document cancellation, EOF, non-terminal input, and invalid flags stop before retention", async t => {
  const f = await fixture(t), input = new PassThrough(), promptOutput = new PassThrough();
  const base = ["--workspace", f.workspace, "--file", f.file];
  assert.equal((await runDocuments(base, { input, promptOutput, stdout() {} })).output.code, "DOCUMENT_INTERACTIVE_REQUIRED");
  assert.equal((await runDocuments([...base, "--unknown"], { stdout() {} })).output.code, "DOCUMENT_FLAGS_INVALID");
  assert.equal((await runDocuments(base, { stdout() {}, ask: async () => "/cancel" })).output.code, "DOCUMENT_CANCELLED");
  input.isTTY = true; promptOutput.isTTY = true; let displayed = "";
  promptOutput.on("data", bytes => { displayed += bytes; if (displayed.includes("Original HTTPS source URL")) queueMicrotask(() => input.end()); });
  assert.equal((await runDocuments(base, { input, promptOutput, stdout() {} })).output.code, "DOCUMENT_CANCELLED");
  input.destroy(); promptOutput.destroy();
  const ledger = f.open(); try { assert.equal(ledger.workspaceSessionOptions(f.setup.watch_id).sources.items.length, 0); } finally { ledger.close(); }
});
