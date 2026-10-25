import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync, symlinkSync, linkSync, lstatSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLocal } from "../client/local-cli.mjs";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { scope, context, methodBundle, limits, policy } from "./fixtures/local-research.mjs";
import { sourcePolicy, eventFixture } from "./fixtures/source-events.mjs";

const entry = fileURLToPath(new URL("../client/local-cli.mjs", import.meta.url));
const syntheticCode = `let text='';for await(const chunk of process.stdin)text+=chunk;const request=JSON.parse(text);const context=request.input.research_context;process.stdout.write(JSON.stringify({agent_fields:{result_state:'REVIEW_REQUIRED',summary:'SYNTHETIC_RESEARCH_SUMMARY_PRIVATE',sources:[{url:context.sources[0].artifact.canonical_url,date:'2026-10-11',kind:'reported_fact',claim:'Synthetic claim.'}],drivers:[],falsifiers:[],unknowns:[],next_check_at:'2026-10-13T00:00:00Z'},usage:{tokens:1,cost_microusd:1}}));`;
function environment() {
  const root = mkdtempSync(join(tmpdir(), "el-local-cli-test-")); const workspace = join(root, "workspace");
  const save = (name, value, mode = 0o600) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value), { mode }); return path; };
  const init = save("private-config.json", { scope: scope(), private_context: { ...context(), question: "SECRET_PRIVATE_QUESTION" },
    method_bundle: methodBundle(), budget: { window_id: "cli-window", limits: limits() }, source_policies: [sourcePolicy()] });
  const raw = join(root, "raw.json"); const fixture = eventFixture(); writeFileSync(raw, fixture.bytes, { mode: 0o644 });
  const { bytes, ...rest } = fixture;
  const event = save("event.json", { ...rest, raw_file: raw, watch_id: scope().watch_id, method_sha256: null,
    evaluation_at: "2026-10-12T00:00:00Z", budget_window: "cli-window", run_policy: policy() });
  const command = { allow_local_command: true, executable: process.execPath, args: ["--input-type=module", "-e", syntheticCode], identity: "synthetic-cli-v1", timeout_ms: 2000 };
  const execution = { timeout_ms: 1000, heartbeat_ms: 20, lease_ms: 1000, estimate: { tokens: 100, cost_microusd: 100, wall_ms: 2000 } };
  const runtime = save("private-runtime.json", { command, execution });
  let now = Date.parse("2026-10-12T00:00:01Z"); const outputs = [];
  const call = (args, overrides = {}) => runLocal(args, { stdout: (value) => outputs.push(value), clock: () => now, owner: "synthetic-cli", ...overrides });
  return { root, workspace, save, init, event, raw, runtime, command, execution, outputs, call, clock: () => now,
    advance: (ms) => { now += ms; } };
}
const args = (env, command, ...rest) => [command, "--workspace", env.workspace, ...rest];
const runArgs = (env) => args(env, "run", "--runtime", env.runtime, "--allow-private-context", "--allow-candidate-method");
async function prepare(env) {
  const configured = await env.call(args(env, "init", "--input", env.init)); assert.equal(configured.exitCode, 0);
  const fixture = eventFixture(); const { bytes, ...rest } = fixture;
  env.event = env.save("event.json", { ...rest, raw_file: env.raw, watch_id: scope().watch_id, method_sha256: configured.output.method_sha256,
    evaluation_at: "2026-10-12T00:00:00Z", budget_window: "cli-window", run_policy: policy() });
  const queued = await env.call(args(env, "intake", "--input", env.event)); assert.equal(queued.exitCode, 0); return queued.output;
}

test("local init, intake, synthetic child execution, and inbox complete without private stdout", async () => {
  const env = environment(); await prepare(env);
  const output = await env.call(runArgs(env)); assert.equal(output.exitCode, 0); assert.equal(output.output.status, "completed");
  const ledger = new ResearchLedger(env.workspace, { clock: env.clock });
  try { assert.equal(ledger.inbox().length, 1); assert.equal(ledger.inbox()[0].result.summary, "SYNTHETIC_RESEARCH_SUMMARY_PRIVATE"); }
  finally { ledger.close(); }
  assert.doesNotMatch(env.outputs.join(""), /SECRET_PRIVATE_QUESTION|SYNTHETIC_RESEARCH_SUMMARY_PRIVATE|Synthetic claim/);
});

test("status exposes summary IDs and counts without private text or envelopes", async () => {
  const env = environment(); await prepare(env); await env.call(runArgs(env));
  const status = await env.call(args(env, "status")); assert.equal(status.exitCode, 0); assert.equal(status.output.counts.deliveries, 1);
  assert.equal(status.output.runs[0].status, "completed");
  assert.doesNotMatch(JSON.stringify(status.output), /private_context|envelope|summary|SECRET_PRIVATE_QUESTION|SYNTHETIC_RESEARCH_SUMMARY_PRIVATE/);
});

for (const version of [10, 11]) for (const override of [false, true]) test(`status refuses schema ${version} without migration; injected override=${override}`, async () => {
  const env = environment(); await prepare(env);
  const path = join(env.workspace, "research.sqlite"), db = new DatabaseSync(path);
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  if (version === 10) db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec(`PRAGMA user_version=${version}; PRAGMA wal_checkpoint(TRUNCATE);`); db.close();
  const before = readFileSync(path), files = readdirSync(env.workspace).sort();
  for (let call = 0; call < 2; call++) {
    const result = await env.call(args(env, "status"), { ledgerOptions: { allow_migration: override } });
    assert.deepEqual(result, { exitCode: 1, output: { status: "error", code: "SCHEMA_UPGRADE_REQUIRED" } });
    assert.deepEqual(readFileSync(path), before); assert.deepEqual(readdirSync(env.workspace).sort(), files);
  }
});

test("status does not initialize a missing workspace", async () => {
  const env = environment();
  const result = await env.call(args(env, "status"));
  assert.deepEqual(result, { exitCode: 1, output: { status: "error", code: "WORKSPACE_MISSING" } });
  assert.equal(existsSync(env.workspace), false);
});

test("status preserves current retained records across two checks", async () => {
  const env = environment(); await prepare(env); await env.call(runArgs(env));
  const snapshot = () => {
    const db = new DatabaseSync(join(env.workspace, "research.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        .map(({ name }) => { assert.match(name, /^[a-z_]+$/); return { name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() }; });
    } finally { db.close(); }
  };
  const before = snapshot();
  for (let call = 0; call < 2; call++) {
    const result = await env.call(args(env, "status")); assert.equal(result.exitCode, 0);
    assert.equal(result.output.counts.deliveries, 1); assert.deepEqual(snapshot(), before);
  }
});

test("run does not dispatch without both explicit consent flags", async () => {
  const env = environment(); await prepare(env);
  for (const rest of [[], ["--allow-private-context"], ["--allow-candidate-method"]]) {
    assert.equal((await env.call(args(env, "run", "--runtime", env.runtime, ...rest))).output.code, "RUN_CONSENT_REQUIRED");
  }
  const status = await env.call(args(env, "status")); assert.equal(status.output.counts.requests, 0); assert.equal(status.output.runs[0].status, "queued");
});

test("cached settled output survives a CLI fault and a process reopen", async () => {
  const env = environment(); await prepare(env); let settlementFault = true;
  const fault = (point) => {
    if (point === "settle:after_commit" && settlementFault) { settlementFault = false; throw new Error("SECRET_SETTLEMENT_FAILURE"); }
    if (point === "gate_run:before_commit") throw new Error("SECRET_GATE_FAILURE");
  };
  assert.equal((await env.call(runArgs(env), { ledgerOptions: { fault } })).output.code, "STORAGE_WRITE_UNCERTAIN");
  env.advance(1001); const recovered = await env.call(runArgs(env)); assert.equal(recovered.output.status, "completed");
  const status = await env.call(args(env, "status")); assert.equal(status.output.counts.requests, 1); assert.equal(status.output.counts.deliveries, 1);
  assert.doesNotMatch(env.outputs.join(""), /SECRET_SETTLEMENT_FAILURE|SECRET_GATE_FAILURE/);
});

test("private configuration permissions reject group and world access", async () => {
  const env = environment(); chmodSync(env.init, 0o644);
  assert.equal((await env.call(args(env, "init", "--input", env.init))).output.code, "INPUT_FILE_UNSAFE");
});
test("private runtime permissions reject shared access before any claim", async () => {
  const env = environment(); await prepare(env); chmodSync(env.runtime, 0o640);
  assert.equal((await env.call(runArgs(env))).output.code, "INPUT_FILE_UNSAFE");
  assert.equal((await env.call(args(env, "status"))).output.counts.requests, 0);
});
for (const kind of ["symlink", "hardlink"]) test(`${kind} private input is rejected`, async () => {
  const env = environment(); const path = join(env.root, `${kind}.json`);
  if (kind === "symlink") symlinkSync(env.init, path); else linkSync(env.init, path);
  assert.equal((await env.call(args(env, "init", "--input", path))).output.code, "INPUT_FILE_UNSAFE");
});

test("share-readable source bytes are accepted but writable shared bytes are rejected", async () => {
  const env = environment(); await prepare(env); chmodSync(env.raw, 0o666);
  assert.equal((await env.call(args(env, "intake", "--input", env.event))).output.code, "INPUT_FILE_UNSAFE");
});
test("source byte symlinks cannot enter intake", async () => {
  const env = environment(); const configured = await env.call(args(env, "init", "--input", env.init));
  const raw = join(env.root, "raw-link.json"); symlinkSync(env.raw, raw); const fixture = eventFixture(); const { bytes, ...rest } = fixture;
  const event = env.save("linked-event.json", { ...rest, raw_file: raw, watch_id: scope().watch_id, method_sha256: configured.output.method_sha256,
    evaluation_at: "2026-10-12T00:00:00Z", budget_window: "cli-window", run_policy: policy() });
  assert.equal((await env.call(args(env, "intake", "--input", event))).output.code, "INPUT_FILE_UNSAFE");
});
test("private JSON and source bytes have bounded sizes", async () => {
  const env = environment(); writeFileSync(env.init, " ".repeat(1_000_001));
  assert.equal((await env.call(args(env, "init", "--input", env.init))).output.code, "INPUT_FILE_UNSAFE");
  const rawEnv = environment(); await prepare(rawEnv); writeFileSync(rawEnv.raw, Buffer.alloc(2_000_001));
  assert.equal((await rawEnv.call(args(rawEnv, "intake", "--input", rawEnv.event))).output.code, "INPUT_FILE_UNSAFE");
});
test("malformed JSON errors contain no paths or source text", async () => {
  const env = environment(); writeFileSync(env.init, "SECRET_INVALID_JSON{");
  const output = await env.call(args(env, "init", "--input", env.init)); assert.equal(output.output.code, "INPUT_JSON_INVALID");
  assert.doesNotMatch(env.outputs.join(""), /SECRET_INVALID_JSON|el-local-cli-test/);
});
for (const bad of [
  ["status", "--workspace", "/synthetic", "--workspace", "/synthetic"],
  ["status", "--workspace", "/synthetic", "--endpoint", "https://example.test"],
  ["status", "--workspace"], ["status", "--workspace", "relative"], ["pay", "--workspace", "/synthetic"],
  ["run", "--workspace", "/synthetic", "--runtime", "file", "--allow-private-context", "true", "--allow-candidate-method"]
]) test(`malformed flags fail safely: ${bad[0]} ${bad.length}`, async () => {
  const env = environment(); const output = await env.call(bad); assert.equal(output.exitCode, 1);
  assert.match(output.output.code, /^[A-Z_]+$/); assert.doesNotMatch(JSON.stringify(output.output), /synthetic|example.test/);
});

test("exact runtime schema rejects hidden consent or ambient connector options", async () => {
  const env = environment(); await prepare(env);
  env.runtime = env.save("bad-runtime.json", { command: env.command, execution: { ...env.execution, allow_private_context: true } });
  assert.equal((await env.call(runArgs(env))).output.code, "INPUT_SCHEMA_INVALID");
  env.runtime = env.save("bad-runtime-2.json", { command: { ...env.command, endpoint: "https://example.test" }, execution: env.execution });
  assert.equal((await env.call(runArgs(env))).output.code, "INPUT_SCHEMA_INVALID");
});
test("exact init and intake schemas reject unsupported fields", async () => {
  const env = environment(); const initial = { scope: scope(), private_context: context(), method_bundle: methodBundle(),
    budget: { window_id: "cli-window", limits: limits() }, source_policies: [sourcePolicy()], api_key: "SECRET_UNSUPPORTED" };
  assert.equal((await env.call(args(env, "init", "--input", env.save("bad-init.json", initial)))).output.code, "INPUT_SCHEMA_INVALID");
  await prepare(env); const fixture = eventFixture();
  assert.equal((await env.call(args(env, "intake", "--input", env.save("bad-event.json", { ...fixture, raw_file: env.raw })))).output.code, "INPUT_SCHEMA_INVALID");
});

test("backup uses a bounded new private filename", async () => {
  const env = environment(); await prepare(env);
  assert.equal((await env.call(args(env, "backup", "--name", "retained.sqlite"))).output.status, "backed_up");
  assert.equal(lstatSync(join(env.workspace, "retained.sqlite")).mode & 0o777, 0o600);
  assert.equal((await env.call(args(env, "backup", "--name", "../escape.sqlite"))).output.code, "BACKUP_NAME_INVALID");
});

test("actual executable CLI entry returns safe status without model dispatch", () => {
  const child = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8", timeout: 2000 });
  assert.equal(child.status, 0); assert.match(child.stdout, /does not verify a model connection/);
});

test("reconciliation requires a private exact operator decision", async () => {
  const env = environment(); await prepare(env);
  const path = env.save("bad-decision.json", { request_id: "synthetic", receipt_sha256: "a".repeat(64), reason: "Synthetic reason.", reconciliation_id: "synthetic", resume: false, tokens: 0 });
  assert.equal((await env.call(args(env, "reconcile", "--input", path))).output.code, "INPUT_SCHEMA_INVALID");
  const privatePath = env.save("shared-decision.json", { request_id: "synthetic", receipt_sha256: "a".repeat(64), reason: "Synthetic reason.", reconciliation_id: "synthetic", resume: false }, 0o644);
  assert.equal((await env.call(args(env, "reconcile", "--input", privatePath))).output.code, "INPUT_FILE_UNSAFE");
});

test("CLI command arguments preserve shell expressions as literal data", async () => {
  const env = environment(); await prepare(env);
  const sentinel = join(env.root, "must-not-exist"); const literal = `$(touch ${sentinel})`;
  const source = `if(process.argv[1]!==${JSON.stringify(literal)})throw new Error('Literal argument changed.');${syntheticCode}`;
  env.runtime = env.save("literal-runtime.json", { command: { ...env.command, args: ["--input-type=module", "-e", source, literal] }, execution: env.execution });
  assert.equal((await env.call(runArgs(env))).output.status, "completed"); assert.equal(existsSync(sentinel), false);
});

test("an explicit operator decision reconciles retained measured usage and resumes cached output", async () => {
  const env = environment(); await prepare(env);
  env.runtime = env.save("unknown-runtime.json", { command: { ...env.command,
    args: ["--input-type=module", "-e", syntheticCode.replace("usage:{tokens:1,cost_microusd:1}", "usage:null")] }, execution: env.execution });
  assert.equal((await env.call(runArgs(env))).output.code, "USAGE_UNKNOWN");
  const status = await env.call(args(env, "status")); const requestId = status.output.requests[0].request_id;
  const ledger = new ResearchLedger(env.workspace, { clock: env.clock }); let receipt;
  try {
    const retained = ledger.requestReceipts(requestId)[0].record.response;
    receipt = ledger.recordRequestReceipt(requestId, { tokens: 1, cost_microusd: 1 }, retained);
  } finally { ledger.close(); }
  const input = env.save("private-decision.json", { request_id: requestId, receipt_sha256: receipt.receipt_sha256,
    reason: "Synthetic operator checked the retained usage evidence.", reconciliation_id: "synthetic-reconciliation", resume: true });
  const decision = await env.call(args(env, "reconcile", "--input", input)); assert.equal(decision.output.status, "queued");
  assert.equal((await env.call(runArgs(env))).output.status, "completed");
  const final = await env.call(args(env, "status")); assert.equal(final.output.counts.requests, 1); assert.equal(final.output.counts.deliveries, 1);
  assert.doesNotMatch(env.outputs.join(""), /Synthetic operator checked|SECRET_PRIVATE_QUESTION|SYNTHETIC_RESEARCH_SUMMARY_PRIVATE/);
});

test("source gates remain visible after reopen when no run can be claimed", async () => {
  const env = environment();
  env.init = env.save("hold-config.json", { scope: scope(), private_context: { question: "SECRET_HELD_QUESTION" }, method_bundle: methodBundle(),
    budget: { window_id: "cli-window", limits: limits() }, source_policies: [{ ...sourcePolicy(), rights_status: "HOLD" }] });
  const initialized = await env.call(args(env, "init", "--input", env.init)); assert.equal(initialized.exitCode, 0);
  const fixture = eventFixture(); const { bytes, ...rest } = fixture;
  env.event = env.save("held-event.json", { ...rest, raw_file: env.raw, watch_id: scope().watch_id, method_sha256: initialized.output.method_sha256,
    evaluation_at: "2026-10-12T00:00:00Z", budget_window: "cli-window", run_policy: policy() });
  const intake = await env.call(args(env, "intake", "--input", env.event)); assert.equal(intake.output.gate_code, "SOURCE_RIGHTS_HOLD");
  assert.match(intake.output.decision_id, /^el-event-decision-[a-f0-9]{64}$/);
  for (let index = 0; index < 2; index++) {
    const status = await env.call(args(env, "status")); assert.equal(status.output.gates[0].gate_code, "SOURCE_RIGHTS_HOLD");
    const run = await env.call(runArgs(env)); assert.equal(run.exitCode, 2); assert.equal(run.output.status, "gated");
    assert.deepEqual(run.output.gates, ["SOURCE_RIGHTS_HOLD"]); assert.equal(status.output.counts.requests, 0);
  }
  assert.doesNotMatch(env.outputs.join(""), /SECRET_HELD_QUESTION/);
});
