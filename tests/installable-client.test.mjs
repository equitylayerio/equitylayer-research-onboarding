import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { supportedNode, runEntry } from "../bin/equitylayer.mjs";
import { setup, policy, scope, result, estimate, methodBundle } from "./fixtures/local-research.mjs";
import { sourcePolicy, eventFixture, configureEventWatch } from "./fixtures/source-events.mjs";
import { secFeed, secAt, secResponse } from "./fixtures/sec-submissions.mjs";

const entryBytes = readFileSync(new URL('../bin/equitylayer.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic process exceeded the test deadline.')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t, source, { signalFailure = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'el-entry-stop-test-'));
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'client'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', name: 'synthetic-entry-test', version: '0.0.0' }));
  writeFileSync(join(root, 'bin/equitylayer.mjs'), entryBytes);
  writeFileSync(join(root, 'client/workspace-cli.mjs'), source);
  let executable = join(root, 'bin/equitylayer.mjs');
  if (signalFailure) {
    executable = join(root, 'driver.mjs');
    writeFileSync(executable, `import {runEntry} from './bin/equitylayer.mjs';
runEntry(['workspace'], {signalProcess(){const error=new Error('Synthetic refusal.');error.code='EPERM';throw error;}})
.then(result=>{process.exitCode=result.exitCode;});`);
  }
  const child = spawn(process.execPath, [executable, ...(signalFailure ? [] : ['workspace'])], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close'), exited = once(child, 'exit');
  let output = '', errorText = '', records = [], acceptReady;
  const ready = new Promise(resolve => { acceptReady = resolve; });
  child.stderr.on('data', bytes => { errorText += bytes; });
  child.stdout.on('data', bytes => {
    output += bytes;
    for (;;) {
      const end = output.indexOf('\n'); if (end < 0) break;
      const line = output.slice(0, end); output = output.slice(end + 1);
      const value = JSON.parse(line); records.push(value);
      if (value.ready) acceptReady(value);
    }
  });
  t.after(async () => {
    // These identifiers come only from this test's synthetic child processes.
    for (const record of records) for (const pid of [record.pid, record.descendant]) {
      if (Number.isSafeInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(closed, 3000);
    rmSync(root, { recursive: true, force: true });
  });
  return { child, closed, exited, ready, errors: () => errorText };
}

test('entry preserves a normal child exit code', { timeout: 6000 }, async t => {
  const f = await fixture(t, 'process.exitCode = 37;');
  assert.deepEqual(await bounded(f.closed, 3000), [37, null]);
});

test('entry reports SIGTERM cancellation even when the child exits zero', { timeout: 6000 }, async t => {
  const f = await fixture(t, `process.on('SIGTERM', () => process.exit(0));
console.log(JSON.stringify({ready:true,pid:process.pid})); setInterval(() => {}, 1000);`);
  const state = await bounded(f.ready, 3000);
  f.child.kill('SIGTERM');
  assert.deepEqual(await bounded(f.closed, 3000), [143, null]);
  assert.equal(alive(state.pid), false);
});

test('entry stops a child that ignores SIGTERM within a fixed bound', { timeout: 6000 }, async t => {
  const f = await fixture(t, `process.on('SIGTERM', () => {});
console.log(JSON.stringify({ready:true,pid:process.pid})); setInterval(() => {}, 1000);`);
  const state = await bounded(f.ready, 3000);
  f.child.kill('SIGTERM');
  assert.deepEqual(await bounded(f.closed, 3000), [143, null]);
  assert.equal(alive(state.pid), false);
});

test('entry stops an inherited descendant after its immediate child exits', { timeout: 6000, skip: process.platform === 'win32' }, async t => {
  const descendant = `process.on('SIGTERM',()=>{});process.send({ready:true});setInterval(()=>{},1000);`;
  const f = await fixture(t, `import {spawn} from 'node:child_process';
process.on('SIGTERM',()=>process.exit(0));
const descendant=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
descendant.on('message',()=>console.log(JSON.stringify({ready:true,pid:process.pid,descendant:descendant.pid})));
setInterval(()=>{},1000);`);
  const state = await bounded(f.ready, 3000);
  f.child.kill('SIGTERM');
  assert.deepEqual(await bounded(f.closed, 3000), [143, null]);
  assert.equal(alive(state.pid), false);
  assert.equal(alive(state.descendant), false);
});

test('entry reports SIGINT cancellation and preserves the first stop signal', { timeout: 6000 }, async t => {
  const f = await fixture(t, `process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});
console.log(JSON.stringify({ready:true,pid:process.pid}));setInterval(()=>{},1000);`);
  const state = await bounded(f.ready, 3000);
  f.child.kill('SIGINT');
  const repeated = setTimeout(() => f.child.kill('SIGTERM'), 200);
  t.after(() => clearTimeout(repeated));
  assert.deepEqual(await bounded(f.closed, 3000), [130, null]);
  assert.equal(alive(state.pid), false);
});

test('entry reports an unconfirmed stop without claiming child termination', { timeout: 6000 }, async t => {
  const f = await fixture(t, `process.on('SIGTERM',()=>{});
console.log(JSON.stringify({ready:true,pid:process.pid}));setInterval(()=>{},1000);`, { signalFailure:true });
  const state = await bounded(f.ready, 3000);
  f.child.kill('SIGTERM');
  // A live inherited child still owns the test pipes, so check the wrapper's exit.
  assert.deepEqual(await bounded(f.exited, 3000), [1, null]);
  assert.equal(f.errors(), 'CLIENT_STOP_UNCONFIRMED\n');
  assert.equal(alive(state.pid), true);
});

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "el-installable-client-"));
const prefix = join(root, "install with spaces"), cwd = join(root, "unrelated-directory");
const command = join(prefix, "node_modules", ".bin", "equitylayer");
const installed = join(prefix, "node_modules", "equitylayer-research-client");
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
let packed;
let retainInstallRoot = false;
const call = (...args) => spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 10000, maxBuffer: 1000000 });
before(() => {
  mkdirSync(cwd);
  const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", root, "--cache", join(root, "cache")],
    { cwd: repository, env, encoding: "utf8", timeout: 30000, maxBuffer: 1000000 });
  assert.equal(pack.status, 0, "The candidate package must build without registry access.");
  packed = JSON.parse(pack.stdout)[0];
  const install = spawnSync("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--package-lock=false",
    "--cache", join(root, "cache"), join(root, packed.filename)], { cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 1000000 });
  assert.equal(install.status, 0, "The reviewed tarball must install in an unrelated directory without registry access.");
});
after(() => { if (!retainInstallRoot) rmSync(root, { recursive: true, force: true }); });

test("runtime bounds reject unsupported or ambiguous versions", () => {
  for (const value of ["18.20.0", "22.12.9", "22.13", "22.13.0-next", "invalid"]) assert.equal(supportedNode(value), false);
  for (const value of ["22.13.0", "22.20.0", "24.19.0", "25.2.1"]) assert.equal(supportedNode(value), true);
});

test("unsupported Node returns fixed guidance without starting a child", async () => {
  let output = "";
  assert.deepEqual(await runEntry(["workspace", "--workspace", "/must-not-start"], { nodeVersion: "22.12.0", stderr: value => { output += value; } }), { exitCode: 1 });
  assert.match(output, /^NODE_VERSION_UNSUPPORTED:/); assert.doesNotMatch(output, /must-not-start/);
});

test("package includes all executable entrances, local assets, instructions, and licenses", () => {
  const files = new Set(packed.files.map(item => item.path));
  for (const path of ["bin/equitylayer.mjs", "client/cli.mjs", "client/local-cli.mjs", "client/workspace-cli.mjs", "client/local-service.mjs",
    "client/local/native-runtime.mjs", "client/local/execution-diagnostics.mjs", "client/local/ui/workspace.js", "client/local/ui/workspace-state.mjs",
    "client/local/ui/workspace.html", "client/local/ui/workspace.css", "client/local/assets/InterVariable.woff2", "client/local/assets/OFL-Inter.txt",
    "client/setup-cli.mjs", "client/source-setup-cli.mjs", "client/session-cli.mjs", "client/local/session-mcp.mjs", "client/local/session-connection.mjs",
    "client/local/ui/session-preparation.mjs", "prompts/model-portable-research.md", "prompts/local-session-research.md", "docs/first-use.md", "docs/installable-client.md", "LICENSE", "README.md", "package.json"]) assert.ok(files.has(path), `Missing package file: ${path}`);
});

test("installed user guides resolve relative links without private verification records", () => {
  const files = new Set(packed.files.map(item => item.path));
  assert.ok(files.has("docs/local-verification-status.md")); assert.ok(files.has("docs/local-method-artifacts.md"));
  for (const file of packed.files.filter(item => item.path.startsWith("docs/") && item.path.endsWith(".md"))) {
    const text = readFileSync(join(installed, file.path), "utf8");
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu)) {
      const target = match[1]; if (/^(?:[a-z]+:|#|\/)/iu.test(target)) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(file.path), target.split("#", 1)[0]));
      assert.ok(files.has(resolved), `${file.path} must resolve ${resolved} within the installed package.`);
    }
    assert.doesNotMatch(text, /\/Users\/andrea\.unicorn\//u);
  }
  assert.equal(packed.files.some(item => /^docs\/20\d{2}-/u.test(item.path)), false);
});

test("package excludes private records, tests, audit artifacts, backend, and payment tools", () => {
  for (const file of packed.files) {
    assert.doesNotMatch(file.path, /(?:^|\/)(?:\.qc|\.git|\.env[^/]*|tests|tools|data|content|node_modules)(?:\/|$)|\.sqlite(?:-|$)|\.local\.json$/);
    assert.ok(file.path === "README.md" || file.path === "LICENSE" || file.path === "package.json" || file.path === "bin/equitylayer.mjs" ||
      /^client\/(?:[^/]+\.mjs|local\/[^/]+\.mjs|local\/ui\/[^/]+\.(?:mjs|js|css|html)|local\/assets\/(?:InterVariable\.woff2|OFL-Inter\.txt|README\.md))$/.test(file.path) ||
      /^prompts\/(?:model-portable-research|local-session-research)\.md$/.test(file.path) || /^docs\/(?:first-use|installable-client|client|local-execution|local-method-artifacts|local-verification-status|native-research-runtime|local-workspace|local-scheduling|local-background-worker|local-twse-monthly-source|local-thesis-tracking)\.md$/.test(file.path), `Unexpected package file: ${file.path}`);
  }
  const metadata = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(metadata.private, true); assert.equal(metadata.dependencies, undefined);
  assert.equal(Object.keys(metadata.scripts).some(name => /^(?:preinstall|install|postinstall|prepare)$/.test(name)), false);
});

test("installed first-use instructions reach the bounded local session prompt without missing local links", () => {
  for (const file of ["docs/first-use.md", "docs/local-workspace.md", "prompts/local-session-research.md", "prompts/model-portable-research.md"]) {
    const path = join(installed, file), text = readFileSync(path, "utf8");
    for (const [, link] of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^https?:\/\//.test(link)) continue;
      const target = join(dirname(path), link);
      assert.ok(target.startsWith(installed + "/")); assert.ok(statSync(target).isFile(), `Missing installed instruction link: ${link}`);
    }
  }
  const prompt = readFileSync(join(installed, "prompts/local-session-research.md"), "utf8");
  assert.match(prompt, /Call get_research_task without arguments for the manifest/);
  assert.match(prompt, /Continue with next_offset/); assert.match(prompt, /Only the human can choose/);
  assert.match(prompt, /No model run verified these new instructions/);
  assert.match(prompt, /Research-time limits belong to your AI client, not to this local MCP server/);
  assert.match(prompt, /reserve time to write the result and check its submission status/);
  assert.match(prompt, /Never invent claims to produce a valid return/);
  const workspaceGuide = readFileSync(join(installed, "docs/local-workspace.md"), "utf8");
  assert.match(workspaceGuide, /There is no automatic 120-second research limit for this connection/);
  assert.match(workspaceGuide, /An external return does not settle or authorize a retry of an old runner request/);
});

test("installed executable resolves its own package and works outside the checkout", () => {
  assert.equal(realpathSync(command), realpathSync(join(installed, "bin", "equitylayer.mjs")));
  assert.ok(statSync(realpathSync(command)).mode & 0o111);
  const metadata = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  assert.equal(call("--version").stdout, `${metadata.name} ${metadata.version}\n`);
  assert.equal(call("--version").status, 0);
});

test("installed Tracking instructions use the installed entry without starting work", async () => {
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const { WorkspaceService } = await import(pathToFileURL(join(installed, "client/local/workspace-service.mjs")));
  const ledger = new ResearchLedger(join(root, "installed source instructions"));
  try {
    const method = configureEventWatch(ledger);
    ledger.configureSchedule({ schema_version: 1, schedule_id: "installed-observation", revision: 1,
      watch_id: scope().watch_id, scope_revision: 1, method_sha256: method.bundle_sha256,
      source_id: "synthetic-exchange", budget_window: "event-window", feed: { kind: "retained_directory", directory: join(root, "unused feed") },
      interval_ms: 1000, max_events: 10, max_runs: 0, tick_timeout_ms: 2000, run_policy: policy(), runtime_sha256: null });
    const service = new WorkspaceService(ledger), item = service.schedules().items[0], before = ledger.workspaceStatus();
    const input = { schedule_id: item.schedule_id, revision: item.revision, config_sha256: item.config_sha256 };
    const plan = service.observationPlan(input);
    assert.equal(plan.available, true); assert.equal(plan.command.command, process.execPath);
    assert.equal(plan.command.args[0], realpathSync(join(installed, "bin/equitylayer.mjs")));
    assert.ok(plan.command.args.includes("schedule-daemon-observe"));
    assert.equal(plan.worker_started, false); assert.equal(plan.ai_execution_authorized, false);
    assert.deepEqual(ledger.workspaceStatus(), before);
    service.stopSchedule({ ...input, confirm_stop: true });
    assert.equal(service.observationPlan(input).shell_command, null);
    assert.equal(ledger.workspaceStatus().counts.requests, 0); ledger.verifyIntegrity();
  } finally { ledger.close(); }
});

test("installed observation resume preserves a later stop and returns new pinned start instructions", async () => {
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const { WorkspaceService } = await import(pathToFileURL(join(installed, "client/local/workspace-service.mjs")));
  const workspace = join(root, "installed resume with spaces"), ledger = new ResearchLedger(workspace);
  try {
    const method = configureEventWatch(ledger);
    ledger.configureSchedule({ schema_version: 1, schedule_id: "installed-resume", revision: 1, watch_id: scope().watch_id,
      scope_revision: 1, method_sha256: method.bundle_sha256, source_id: "synthetic-exchange", budget_window: "event-window",
      feed: { kind: "retained_directory", directory: join(root, "unused resume feed") }, interval_ms: 1000,
      max_events: 10, max_runs: 0, tick_timeout_ms: 2000, run_policy: policy(), runtime_sha256: null });
    const original = ledger.scheduleStatus("installed-resume"), service = new WorkspaceService(ledger);
    ledger.stopSchedule(original.schedule_id, original);
    const args = ["local", "schedule-resume-observe", "--workspace", workspace, "--schedule-id", original.schedule_id,
      "--revision", String(original.revision), "--config-sha256", original.config_sha256, "--confirm-resume"];
    const before = ledger.workspaceStatus().counts, budget = ledger.budget(scope().watch_id, "event-window");
    const denied = call(...args.slice(0, -1)); assert.equal(denied.status, 1); assert.equal(ledger.scheduleStatus(original.schedule_id).enabled, false);
    const resumed = call(...args); assert.equal(resumed.status, 0); const value = JSON.parse(resumed.stdout);
    assert.equal(value.schedule.revision, 2); assert.equal(value.reused, false); assert.equal(value.worker_started, false);
    assert.equal(value.ai_execution_authorized, false); assert.equal(value.research_completion_verified, false);
    const pins = item => ({ schedule_id: item.schedule_id, revision: item.revision, config_sha256: item.config_sha256 });
    const plan = service.observationPlan(pins(value.schedule)); assert.equal(plan.available, true);
    assert.equal(plan.command.args[0], realpathSync(join(installed, "bin/equitylayer.mjs")));
    assert.equal(plan.command.args[plan.command.args.indexOf("--revision") + 1], "2");
    assert.throws(() => service.observationPlan(pins(original)), { code: "SCHEDULE_CONFLICT" });
    ledger.stopSchedule(original.schedule_id, value.schedule);
    const replay = call(...args); assert.equal(replay.status, 0); assert.equal(JSON.parse(replay.stdout).reused, true);
    assert.equal(JSON.parse(replay.stdout).schedule.enabled, false);
    assert.deepEqual(ledger.workspaceStatus().counts, before); assert.deepEqual(ledger.budget(scope().watch_id, "event-window"), budget);
    assert.equal(ledger.workspaceStatus().counts.requests, 0); ledger.verifyIntegrity();
  } finally { ledger.close(); }
});

test("two installed resume processes serialize one saved observation revision", async () => {
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const workspace = join(root, "installed simultaneous resume"), ledger = new ResearchLedger(workspace);
  try {
    const method = configureEventWatch(ledger);
    ledger.configureSchedule({ schema_version: 1, schedule_id: "installed-concurrent-resume", revision: 1,
      watch_id: scope().watch_id, scope_revision: 1, method_sha256: method.bundle_sha256, source_id: "synthetic-exchange",
      budget_window: "event-window", feed: { kind: "retained_directory", directory: join(root, "unused concurrent feed") },
      interval_ms: 1000, max_events: 10, max_runs: 0, tick_timeout_ms: 2000, run_policy: policy(), runtime_sha256: null });
    const original = ledger.scheduleStatus("installed-concurrent-resume"); ledger.stopSchedule(original.schedule_id);
    const args = ["local", "schedule-resume-observe", "--workspace", workspace, "--schedule-id", original.schedule_id,
      "--revision", "1", "--config-sha256", original.config_sha256, "--confirm-resume"];
    const invoke = async () => {
      const child = spawn(process.execPath, [realpathSync(command), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "", closeConfirmed = false;
      const closed = once(child, "close").then(value => { closeConfirmed = true; return value; });
      child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { errors += bytes; });
      try {
        const [code, signal] = await bounded(closed, 6000);
        assert.equal(code, 0, errors); assert.equal(signal, null); return JSON.parse(output);
      } finally {
        if (!closeConfirmed) {
          // The wrapper owns its detached CLI group. Let it stop that group and confirm closure.
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          try { await bounded(closed, 3500); }
          catch { retainInstallRoot = true; throw Error("Synthetic installed process termination is unconfirmed. Preserve its fixture."); }
        }
        if (errors.includes("CLIENT_STOP_UNCONFIRMED")) {
          retainInstallRoot = true; throw Error("Synthetic CLI group termination is unconfirmed. Preserve its fixture.");
        }
      }
    };
    const outcomes = await Promise.allSettled([invoke(), invoke()]);
    const replies = outcomes.map(outcome => { if (outcome.status === "rejected") throw outcome.reason; return outcome.value; });
    assert.deepEqual(replies.map(reply => reply.reused).sort(), [false, true]);
    for (const reply of replies) { assert.equal(reply.schedule.revision, 2); assert.equal(reply.worker_started, false); }
    assert.equal(ledger.scheduleStatus(original.schedule_id).revision, 2);
    assert.equal(ledger.workspaceStatus().counts.requests, 0); ledger.verifyIntegrity();
  } finally { ledger.close(); }
});

test("installed source setup and scheduler share the fixed SEC detector without native configuration", async () => {
  const workspace = join(root, "installed SEC workspace"), answers = join(root, "sec-setup-answers.json"), method = join(root, "sec-method.json");
  const source = join(root, "sec-source-answers.json");
  writeFileSync(answers, JSON.stringify({ focus: "ai_compute", symbols: ["LITE", "2345.TW"],
    question: "Synthetic private thesis", trigger: "Synthetic filing evidence" }), { mode: 0o600 });
  writeFileSync(method, JSON.stringify(methodBundle()), { mode: 0o600 });
  const setup = call("setup", "--session", "--workspace", workspace, "--answers", answers, "--method-bundle", method);
  assert.equal(setup.status, 0); const watch = JSON.parse(setup.stdout);
  const { kind, cik, symbol, user_agent } = secFeed();
  writeFileSync(source, JSON.stringify({ kind, cik, symbol, user_agent, rights_status: "ALLOWED",
    rights_reference: "Synthetic fixture permission only.", allow_candidate_trials: true }), { mode: 0o600 });
  const configured = call("sources", "--workspace", workspace, "--answers", source, "--confirm-local-source-use");
  assert.equal(configured.status, 0); const output = JSON.parse(configured.stdout);
  assert.equal(output.network_called, false); assert.equal(output.model_called, false); assert.equal(output.evidence_scope, "filing_index_metadata_only");
  assert.equal(existsSync(join(workspace, "runtime.local.json")), false); assert.doesNotMatch(configured.stdout, /tests@example/);
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const { processScheduleTick } = await import(pathToFileURL(join(installed, "client/local/scheduler.mjs")));
  const ledger = new ResearchLedger(workspace); let calls = 0;
  try {
    // This request callback returns synthetic bytes. It never contacts SEC.
    const tick = await processScheduleTick(ledger, output.schedule_id, { clock: () => Math.max(Date.now(), Date.parse(secAt)),
      source_fetch_impl: async () => { calls++; return secResponse(); } });
    assert.equal(tick.status, "completed"); assert.equal(calls, 1); assert.equal(ledger.workspaceStatus().counts.runs, 1);
    assert.equal(ledger.workspaceStatus().counts.requests, 0); assert.equal(ledger.workspaceStatus().counts.deliveries, 0);
    assert.ok(ledger.watch(watch.watch_id)); ledger.verifyIntegrity();
  } finally { ledger.close(); }
});

for (const version of [10, 11]) test(`installed status refuses schema ${version} twice without a migration`, async () => {
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const workspace = join(root, `installed-old-schema-${version}`), path = join(workspace, "research.sqlite");
  const ledger = new ResearchLedger(workspace); setup(ledger); ledger.close();
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;");
  if (version === 10) db.exec("DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;");
  db.exec(`PRAGMA user_version=${version}; PRAGMA wal_checkpoint(TRUNCATE);`); db.close();
  const before = readFileSync(path), files = readdirSync(workspace).sort();
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = call("local", "status", "--workspace", workspace);
    assert.equal(output.status, 1); assert.deepEqual(JSON.parse(output.stdout), { status: "error", code: "SCHEMA_UPGRADE_REQUIRED" });
    assert.deepEqual(readFileSync(path), before); assert.deepEqual(readdirSync(workspace).sort(), files);
  }
});

test("installed native adapter preserves the fixed parser-report category without raw stderr", async () => {
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const { createNativeResearchRuntime } = await import(pathToFileURL(join(installed, "client/local/native-runtime.mjs")));
  const workspace = join(root, "installed diagnostic fixture"), ledger = new ResearchLedger(workspace, { clock: () => Date.parse("2026-10-11T00:00:02Z") });
  let input;
  try {
    const envelope = setup(ledger); ledger.configureSourcePolicy(scope().watch_id, sourcePolicy()); ledger.enqueue(envelope, "test-window", policy());
    const context = ledger.executionContext(ledger.claim("synthetic-installed-launch", 10000));
    input = { schema_version: 1, context_sha256: context.sha256, research_context: context.payload, agent_fields_contract: { response: "Seven fields." } };
  } finally { ledger.close(); }
  const executable = join(root, "synthetic-installed-codex.mjs");
  const features = ["shell_tool", "unified_exec", "hooks", "plugins", "apps", "browser_use", "browser_use_external",
    "browser_use_full_cdp_access", "computer_use", "in_app_browser", "image_generation", "multi_agent", "code_mode_host"];
  writeFileSync(executable, `#!${process.execPath}\nimport process from 'node:process';
const args=process.argv.slice(2);
if(args.includes('--version')) console.log('codex-cli 0.144.5');
else if(args[0]==='features') for(const name of ${JSON.stringify(features)}) console.log(name+' stable true');
else {for await(const chunk of process.stdin){} process.stderr.write("error: unexpected argument '--synthetic-private-flag' found\\nUsage: codex exec [OPTIONS] [PROMPT] [COMMAND]\\n");process.exitCode=2;}
`, { mode: 0o700 });
  const runtime = createNativeResearchRuntime({ allow_native_research: true, provider: "codex", executable,
    model: "synthetic-no-model", cli_version: "0.144.5", env: { HOME: root }, timeout_ms: 5000 });
  await assert.rejects(runtime.execute(input), error => {
    assert.equal(error.code, "NATIVE_ARGUMENT_ERROR_REPORTED"); assert.doesNotMatch(error.message, /synthetic-private-flag|Usage:/); return true;
  });
});

test("default help does not create a workspace, connect, or authorize execution", () => {
  const before = readdirSync(cwd);
  for (const args of [[], ["--help"]]) {
    const result = call(...args); assert.equal(result.status, 0);
    assert.match(result.stdout, /equitylayer research --help/); assert.match(result.stdout, /explicit AI execution consent/);
  }
  assert.deepEqual(readdirSync(cwd), before);
});

for (const route of ["research", "local", "workspace", "setup", "sources", "session", "documents"]) test(`installed ${route} help loads its complete module graph`, () => {
  const result = call(route, "--help"); assert.equal(result.status, 0);
  assert.ok(result.stdout.length > 100); assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|ENOENT/);
});

test("installed document command retains an allowed body for session selection and exact replay", async t => {
  const workspace = join(root, "document workspace"), answers = join(root, "document session.json"), method = join(root, "document method.json");
  writeFileSync(answers, JSON.stringify({ focus: "pcb_ccl", symbols: ["TTMI", "2383.TW"], question: "Synthetic question.", trigger: "Synthetic release." }), { mode: 0o600 });
  writeFileSync(method, JSON.stringify(methodBundle()), { mode: 0o600 });
  const setupCall = call("setup", "--session", "--workspace", workspace, "--answers", answers, "--method-bundle", method);
  assert.equal(setupCall.status, 0); const setupValue = JSON.parse(setupCall.stdout);
  const file = join(root, "retained document.html"), metadataFile = join(root, "document metadata.json");
  writeFileSync(file, "<h1>Synthetic retained statement</h1><p>Not investment evidence.</p>", { mode: 0o600 });
  writeFileSync(metadataFile, JSON.stringify({ canonical_url: "https://example.test/installed-document", source_class: "issuer_release", symbols: ["TTMI"],
    retrieved_at: new Date(Date.now() - 1000).toISOString(), published_at: null, source_period: null, content_type: "text/html",
    http_status: 200, rights_status: "ALLOWED", rights_reference: "Synthetic local use only.", allow_candidate_trials: true, max_source_age_days: 30 }), { mode: 0o600 });
  const args = ["documents", "--workspace", workspace, "--file", file, "--answers", metadataFile, "--confirm-local-source-use"];
  const first = call(...args); assert.equal(first.status, 0); const initial = JSON.parse(first.stdout);
  const second = call(...args); assert.equal(second.status, 0); assert.equal(JSON.parse(second.stdout).reused, true);
  assert.deepEqual(JSON.parse(second.stdout).reference, initial.reference);
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const ledger = new ResearchLedger(workspace); try {
    const choices = ledger.workspaceSessionOptions(setupValue.watch_id);
    assert.equal(choices.sources.items.length, 1); assert.equal(choices.sources.items[0].gate_code, null);
    assert.deepEqual(ledger.source(initial.reference.source_event_id).bytes, readFileSync(file));
    assert.equal(ledger.workspaceStatus().counts.requests, 0); ledger.verifyIntegrity();
  } finally { ledger.close(); }
  const preparation = call("session", "prepare", "--workspace", workspace, "--watch", setupValue.watch_id, "--revision", "1",
    "--method", methodBundle().content_sha256, "--source-event", initial.reference.source_event_id,
    "--allow-private-context", "--allow-candidate-method");
  assert.equal(preparation.status, 0);
  const client = await installedTaskClient(t, JSON.parse(preparation.stdout));
  const manifest = (await client.tool("get_research_task")).result.structuredContent;
  assert.equal(manifest.sources.length, 1); const pin = manifest.sources[0];
  assert.equal(pin.sha256, initial.reference.artifact_sha256);
  const body = await client.tool("get_research_task", { view: "read", source_event_id: pin.source_event_id, sha256: pin.sha256,
    representation: "readable", representation_sha256: pin.readable.representation_sha256, offset: 0 });
  assert.equal(body.result.isError, false); assert.match(body.result.structuredContent.text, /Synthetic retained statement/);
  assert.equal(body.result.structuredContent.evidence_verified, false);
  await client.close();
});

test("installed session prepares and returns research through its own absolute stdio entry", async t => {
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const workspace = join(root, "installed-session-workspace"), now = Date.now(), ledger = new ResearchLedger(workspace), envelope = setup(ledger), raw = eventFixture(35);
  raw.artifact.retrieved_at = new Date(now - 1000).toISOString(); raw.event.observed_at = raw.artifact.retrieved_at;
  ledger.retainSource(raw.event, raw.artifact, raw.bytes); ledger.retainSourceFacts(raw.event.source_event_id, raw.facts);
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy()); ledger.close();
  const preparation = call("session", "prepare", "--workspace", workspace, "--watch", scope().watch_id, "--revision", "1",
    "--method", envelope.method.bundle_sha256, "--source-event", raw.event.source_event_id,
    "--allow-private-context", "--allow-candidate-method", "--allow-external-submission");
  assert.equal(preparation.status, 0);
  const prepared = JSON.parse(preparation.stdout), config = prepared.mcp_command;
  assert.equal(config.command, process.execPath); assert.equal(realpathSync(config.args[0]), realpathSync(join(installed, "client/session-cli.mjs")));
  const child = spawn(config.command, config.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] }), closed = once(child, "close");
  let output = "", errors = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", text => { output += text; }); child.stderr.on("data", text => { errors += text; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000); t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const input = { submission_id: "11111111-1111-4111-8111-111111111111", session: { client: "Installed synthetic client", model: "declared", session_reference: "opaque-installed-reference" },
    agent_fields: { result_state: "SOURCE_NEEDED", summary: "Synthetic source is not investment evidence.", sources: [], drivers: [], falsifiers: [], unknowns: ["Real evidence required."],
      next_check_at: new Date(now + 86400000).toISOString() } };
  const messages = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "installed-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_research_task" } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "submit_research", arguments: input } }];
  child.stdin.end(messages.map(value => JSON.stringify(value) + "\n").join(""));
  assert.deepEqual(await closed, [0, null]); clearTimeout(timer);
  const responses = output.trim().split("\n").map(line => JSON.parse(line)); assert.equal(responses.length, 3);
  assert.equal(responses[0].result.serverInfo.version, JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version);
  assert.equal(responses[1].result.structuredContent.context.context_id, prepared.context_id); assert.equal(responses[2].result.structuredContent.reused, false);
  assert.doesNotMatch(errors, /Synthetic private|SESSION_OPERATION_FAILED|ERR_MODULE_NOT_FOUND/);
  const reopened = new ResearchLedger(workspace);
  try { assert.equal(reopened.externalSessionStatus(prepared.context_id).usage, "unverified"); assert.equal(reopened.pageExternalSessionRecords().length, 1);
    assert.equal(reopened.workspaceStatus().counts.requests, 0); reopened.verifyIntegrity(); } finally { reopened.close(); }
});

test("installed workspace prepares a guided task and runs its packaged stdio connection", async t => {
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const { WorkspaceService } = await import(pathToFileURL(join(installed, "client/local/workspace-service.mjs")));
  const { startWorkspaceServer } = await import(pathToFileURL(join(installed, "client/local/workspace-server.mjs")));
  const { loadWorkspaceAssets } = await import(pathToFileURL(join(installed, "client/local/workspace-ui.mjs")));
  const workspace = join(root, "installed guided workspace"), ledger = new ResearchLedger(workspace), now = Date.now();
  t.after(() => ledger.close());
  const envelope = setup(ledger), raw = eventFixture(37);
  raw.artifact.retrieved_at = new Date(now - 1000).toISOString(); raw.event.observed_at = raw.artifact.retrieved_at;
  ledger.retainSource(raw.event, raw.artifact, raw.bytes); ledger.retainSourceFacts(raw.event.source_event_id, raw.facts);
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  const server = await startWorkspaceServer({ service: new WorkspaceService(ledger), assets: await loadWorkspaceAssets() });
  t.after(() => server.close());
  const link = new URL(server.bootstrap_url), token = new URLSearchParams(link.hash.slice(1)).get("token");
  const headers = { authorization: `Bearer ${token}` };
  const options = await fetch(`${link.origin}/api/session-options?watch_id=${scope().watch_id}`, { headers });
  assert.equal(options.status, 200); const catalog = await options.json();
  assert.ok(catalog.methods.items.some(item => item.bundle_sha256 === envelope.method.bundle_sha256));
  const focusResponse = await fetch(`${link.origin}/api/session-options?watch_id=${scope().watch_id}&source_event_id=${raw.event.source_event_id}&method_sha256=${envelope.method.bundle_sha256}&limit=1`, { headers });
  assert.equal(focusResponse.status, 200); const focused = await focusResponse.json();
  assert.equal(focused.focus.source.source_event_id, raw.event.source_event_id); assert.equal(focused.focus.source.gate_code, null);
  assert.equal(focused.focus.method.bundle_sha256, envelope.method.bundle_sha256);
  assert.ok(focused.focus.source.sequence > focused.sources.next_after);
  const response = await fetch(`${link.origin}/api/session-prepare`, { method: "POST",
    headers: { ...headers, origin: link.origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-equitylayer-request": "1" },
    body: JSON.stringify({ preparation_id: "11111111-2222-4222-8222-111111111111", watch_id: scope().watch_id, revision: 1,
      method_sha256: envelope.method.bundle_sha256, source_event_ids: [raw.event.source_event_id],
      allow_private_context: true, allow_candidate_method: true, allow_external_submission: true, confirm_no_sources: false }) });
  assert.equal(response.status, 200); const prepared = await response.json(), config = prepared.mcp_command;
  assert.equal(realpathSync(config.args[0]), realpathSync(join(installed, "client/session-cli.mjs")));
  const child = spawn(config.command, config.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] }), closed = once(child, "close");
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const messages = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "installed-guided-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_research_task" } }];
  child.stdin.end(messages.map(value => JSON.stringify(value) + "\n").join(""));
  assert.deepEqual(await closed, [0, null]); clearTimeout(timer);
  const replies = output.trim().split("\n").map(JSON.parse);
  assert.equal(replies[1].result.structuredContent.context.context_id, prepared.context_id);
  assert.equal(ledger.workspaceStatus().counts.requests, 0);
  assert.equal(ledger.workspaceSessionOptions(scope().watch_id).preparations.items.length, 1);
});

test("installed session-first setup reaches a retained external Inbox result without native configuration", async t => {
  const workspace = join(root, "installed session-first workspace"), answers = join(root, "session-answers.json"), method = join(root, "session-method.json");
  writeFileSync(answers, JSON.stringify({ focus: "pcb_ccl", symbols: ["NVDA", "2383.TW", "6752.T", "000150.KS"],
    question: "Synthetic private thesis", trigger: "Synthetic next evidence" }), { mode: 0o600 });
  writeFileSync(method, JSON.stringify(methodBundle()), { mode: 0o600 });
  const configured = call("setup", "--session", "--workspace", workspace, "--answers", answers, "--method-bundle", method);
  assert.equal(configured.status, 0); const config = JSON.parse(configured.stdout);
  assert.equal(config.research_mode, "external_session"); assert.equal(config.runtime_file, null);
  assert.equal(existsSync(join(workspace, "runtime.local.json")), false);
  assert.equal(call("setup", "--workspace", workspace, "--resume").status, 0);
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const { WorkspaceService } = await import(pathToFileURL(join(installed, "client/local/workspace-service.mjs")));
  const ledger = new ResearchLedger(workspace), service = new WorkspaceService(ledger);
  const prepared = service.prepareSession({ preparation_id: "11111111-2222-4222-8222-333333333333", watch_id: config.watch_id,
    revision: 1, method_sha256: methodBundle().content_sha256, source_event_ids: [], confirm_no_sources: true,
    allow_private_context: true, allow_candidate_method: true, allow_external_submission: true });
  ledger.close();
  const child = spawn(prepared.mcp_command.command, prepared.mcp_command.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] }), closed = once(child, "close");
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const messages = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "session-first-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_research", arguments: {
      submission_id: "11111111-2222-4222-8222-444444444444", session: { client: "Synthetic installed session", model: "No model invoked", session_reference: "synthetic" },
      agent_fields: { result_state: "SOURCE_NEEDED", summary: "Synthetic task has no retained evidence.", sources: [], drivers: [], falsifiers: [],
        unknowns: ["Real evidence and research remain unverified."], next_check_at: new Date(Date.now() + 86400000).toISOString() } } } }];
  child.stdin.end(messages.map(value => JSON.stringify(value) + "\n").join(""));
  assert.deepEqual(await closed, [0, null]); clearTimeout(timer);
  const replies = output.trim().split("\n").map(JSON.parse); assert.equal(replies[1].result.structuredContent.reused, false);
  const reopened = new ResearchLedger(workspace); t.after(() => reopened.close());
  assert.equal(reopened.workspaceStatus().counts.requests, 0); assert.equal(reopened.pageExternalSessionRecords().length, 1);
  assert.equal(reopened.externalSessionStatus(prepared.context_id).usage, "unverified");
  assert.deepEqual(reopened.budget(config.watch_id, "initial").limits, { requests: 0, tokens: 0, cost_microusd: 0, wall_ms: 0 });
});

test("installed candidate retains receipt times and newest external pages across reopen", async t => {
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const { WorkspaceService } = await import(pathToFileURL(join(installed, "client/local/workspace-service.mjs")));
  const { loadWorkspaceAssets } = await import(pathToFileURL(join(installed, "client/local/workspace-ui.mjs")));
  const workspace = join(root, "installed newest workspace"), start = Date.parse("2026-10-12T00:00:00Z");
  let now = start, ledger = new ResearchLedger(workspace, { clock: () => now });
  t.after(() => ledger.close());
  const envelope = setup(ledger); ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  const consent = { allow_private_context: true, allow_candidate_method: true, allow_external_submission: true };
  const prepare = n => ledger.prepareExternalSession({ preparation_id: `${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`,
    watch_id: scope().watch_id, revision: 1, method_sha256: envelope.method.bundle_sha256, source_event_ids: ["event-1"] }, consent);
  const pending = prepare(54);
  const submit = (prepared, n) => ledger.submitExternalSession({ schema_version: 1, context_id: prepared.context.context_id,
    submission_id: `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`,
    session: { client: "Synthetic installed pagination", model: "No model invoked", session_reference: `synthetic-${n}` },
    agent_fields: { result_state: "INITIAL_RESEARCH", summary: `Synthetic installed arrival ${n}.`, sources: result(envelope).sources,
      drivers: [], falsifiers: [], unknowns: ["Synthetic data is not investment evidence."], next_check_at: "2026-10-13T00:00:00Z" } }, consent);
  for (let n = 1; n <= 53; n++) { now = start + n * 1000; submit(prepare(n), n); }
  let service = new WorkspaceService(ledger);
  const first = service.externalResearch({ order: "newest" });
  assert.deepEqual(first.items.map(item => item.sequence), Array.from({ length: 50 }, (_, i) => 53 - i));
  now = start + 54_000; const newest = submit(pending, 54);
  const older = service.externalResearch({ order: "newest", after: first.next_after });
  assert.deepEqual(older.items.map(item => item.sequence), [3, 2, 1]);
  assert.equal(service.externalResearch().items[0].sequence, 1);
  const detail = service.externalRecord(newest.record_id);
  assert.equal(detail.received_at, now); assert.equal(detail.result.created_at, new Date(start).toISOString());
  assert.equal(detail.review_count, 0); assert.equal(detail.accepted_evidence, false); assert.equal(detail.accepted_interpretation, false);
  ledger.close(); ledger = new ResearchLedger(workspace, { clock: () => now, allow_creation: false, allow_migration: false });
  service = new WorkspaceService(ledger);
  assert.deepEqual(service.externalRecord(newest.record_id), detail);
  assert.equal(service.externalResearch({ order: "newest" }).items[0].sequence, 54);
  for (const kind of ["inbox", "theses"]) assert.deepEqual(service[kind]({ order: "newest" }), { items: [], next_after: 0, has_more: false, order: "newest" });
  assert.equal(ledger.workspaceStatus().counts.requests, 0); ledger.verifyIntegrity();
  const assets = await loadWorkspaceAssets();
  assert.match(assets.js, /order=newest/); assert.match(assets.html, /Load older external results/);
  assert.match(assets.js, /Task prepared:/);
});

async function installedFinancialFixture(label) {
  const workspace = join(root, label), answers = join(root, `${label}-answers.json`), method = join(root, `${label}-method.json`);
  writeFileSync(answers, JSON.stringify({ focus: "ai_compute", symbols: ["LITE", "2345.TW"],
    question: "Compare synthetic cash and profit across periods. Keep issuer boundaries separate.",
    trigger: "Review a new synthetic financial period." }), { mode: 0o600 });
  writeFileSync(method, JSON.stringify(methodBundle()), { mode: 0o600 });
  const configured = call("setup", "--session", "--workspace", workspace, "--answers", answers, "--method-bundle", method);
  assert.equal(configured.status, 0);
  const setupValue = JSON.parse(configured.stdout);
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")));
  const ledger = new ResearchLedger(workspace), sources = [];
  try {
    ledger.configureSourcePolicy(setupValue.watch_id, sourcePolicy());
    for (const [index, period, sales, cash, capex] of [[71, "2026-06", 100, 30, -15], [72, "2026-09", 120, 25, -5]]) {
      const raw = eventFixture(index, { period, issuers: ["LITE"] });
      // These are invented financial bytes. They do not represent an issuer or an approved financial parser.
      raw.bytes = Buffer.from(`<html><body><h1>Synthetic LITE ${period}</h1><p>Quarterly actuals. USD thousands. Unaudited, preliminary.</p>
<table><tr><th>Metric</th><th>${period}</th></tr><tr><td>Sales</td><td>${sales}</td></tr>
<tr><td>Operating cash</td><td>${cash}</td></tr><tr><td>Signed net capex</td><td>${capex}</td></tr>
<tr><td>Issuer-defined FCF</td><td>${cash + capex}</td></tr></table>
<p>FCF equals operating cash plus signed net capex. No Asia issuer financials or supplier link is supplied.</p></body></html>`);
      raw.artifact.content_type = "text/html";
      raw.artifact.canonical_url = `https://example.test/synthetic-financial/${period}`;
      raw.artifact.byte_length = raw.bytes.length;
      raw.artifact.artifact_sha256 = createHash("sha256").update(raw.bytes).digest("hex");
      raw.artifact.retrieved_at = new Date(Date.now() - 1000).toISOString();
      raw.event.observed_at = raw.artifact.retrieved_at;
      ledger.retainSource(raw.event, raw.artifact, raw.bytes);
      sources.push(raw);
    }
    assert.equal(existsSync(join(workspace, "runtime.local.json")), false);
    assert.deepEqual(ledger.budget(setupValue.watch_id, "initial").limits, { requests: 0, tokens: 0, cost_microusd: 0, wall_ms: 0 });
  } finally { ledger.close(); }
  const prepare = (number, selected) => {
    const output = call("session", "prepare", "--workspace", workspace, "--watch", setupValue.watch_id, "--revision", "1",
      "--method", methodBundle().content_sha256, "--preparation-id", `${String(number).padStart(8, "0")}-2222-4222-8222-111111111111`,
      ...selected.flatMap(raw => ["--source-event", raw.event.source_event_id]),
      "--allow-private-context", "--allow-candidate-method", "--allow-external-submission");
    assert.equal(output.status, 0); return JSON.parse(output.stdout);
  };
  return { workspace, watch_id: setupValue.watch_id, sources, prepare, ResearchLedger };
}

async function installedTaskClient(t, prepared) {
  const config = prepared.mcp_command;
  assert.equal(realpathSync(config.args[0]), realpathSync(join(installed, "client/session-cli.mjs")));
  const child = spawn(config.command, config.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] }), closed = once(child, "close");
  let buffer = "", errors = "", id = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", text => { errors += text; });
  child.stdout.on("data", text => {
    buffer += text;
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const request = pending.get(value.id);
      if (request) { clearTimeout(request.timer); pending.delete(value.id); request.resolve(value); }
    }
  });
  child.on("close", () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Synthetic installed MCP stopped.")); }
    pending.clear();
  });
  child.stdin.on("error", () => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await bounded(closed, 3000);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(Error("Synthetic installed MCP timed out.")); }, 4000);
    pending.set(key, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-financial-test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { tool: (name, args = {}) => request("tools/call", { name, arguments: args }),
    async close() { child.stdin.end(); assert.deepEqual(await bounded(closed, 4000), [0, null]); assert.doesNotMatch(errors, /SESSION_OPERATION_FAILED/); } };
}

async function installedSection(client, manifest, section) {
  const pin = manifest.sections.find(item => item.section === section), chunks = [];
  let offset = 0;
  do {
    const reply = await client.tool("get_research_task", { view: "read", section, sha256: pin.sha256, offset });
    assert.equal(reply.result.isError, false);
    const part = reply.result.structuredContent;
    assert.equal(part.offset, offset); chunks.push(part.text); offset = part.next_offset;
  } while (offset !== null);
  const text = chunks.join("");
  assert.equal(Buffer.byteLength(text), pin.byte_length);
  assert.equal(createHash("sha256").update(text).digest("hex"), pin.sha256);
  return JSON.parse(text);
}

test("installed default session reads synthetic financial evidence and retains a second update without changing human selections", { timeout: 30000 }, async t => {
  const f = await installedFinancialFixture("installed financial cycle");
  const { WorkspaceService } = await import(pathToFileURL(join(installed, "client/local/workspace-service.mjs")));
  const first = f.prepare(71, [f.sources[0]]), client = await installedTaskClient(t, first);
  const manifest = (await client.tool("get_research_task")).result.structuredContent;
  for (const section of ["private_context", "method", "baselines", "instructions", "citation_dates"]) await installedSection(client, manifest, section);
  const readFinancialSource = async (connection, pin, raw) => {
    assert.equal(pin.sha256, raw.artifact.artifact_sha256); assert.equal(pin.readable.status, "available_not_read");
    const selector = { source_event_id: pin.source_event_id, sha256: pin.sha256,
      representation: "readable", representation_sha256: pin.readable.representation_sha256 };
    const found = await connection.tool("get_research_task", { ...selector, view: "find", query: "Operating cash" });
    assert.equal(found.result.isError, false); assert.equal(found.result.structuredContent.matches.length, 1);
    const reply = await connection.tool("get_research_task", { ...selector, view: "read", offset: 0 });
    assert.equal(reply.result.isError, false); const text = reply.result.structuredContent;
    assert.equal(text.next_offset, null); assert.equal(text.evidence_verified, false);
    assert.match(text.text, /USD thousands/); assert.match(text.text, /Unaudited, preliminary/);
    assert.match(text.text, /Signed net capex/); assert.match(text.text, /No Asia issuer financials/);
    assert.ok(text.original_range); return text.text;
  };
  assert.match(await readFinancialSource(client, manifest.sources[0], f.sources[0]), /30/);
  const fields = (state, selected, summary) => ({ result_state: state, summary, sources: selected.map(raw => ({
    url: raw.artifact.canonical_url, date: raw.artifact.retrieved_at.slice(0, 10), kind: "reported_fact",
    claim: `Synthetic ${raw.artifact.source_period} quarterly actuals. USD thousands, unaudited and preliminary. Not real investment evidence.` })),
    drivers: [], falsifiers: [], unknowns: ["No Asian issuer financials, grade economics, or supplier relationship is established."],
    next_check_at: new Date(Date.now() + 86400000).toISOString() });
  const input = (number, agent_fields) => ({ submission_id: `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`,
    session: { client: "Synthetic installed financial cycle", model: "No model invoked", session_reference: `synthetic-${number}` }, agent_fields });
  const initialInput = input(71, fields("INITIAL_RESEARCH", [f.sources[0]], "Synthetic first quarter: operating cash 30 plus signed net capex -15 equals issuer-defined FCF 15. USD thousands."));
  const a = await client.tool("submit_research", initialInput); assert.equal(a.result.isError, false);
  const aId = a.result.structuredContent.record_id;
  assert.equal((await client.tool("get_submission_status")).result.structuredContent.record_id, aId);
  await client.close();
  let ledger = new f.ResearchLedger(f.workspace), service = new WorkspaceService(ledger);
  try {
    assert.equal(service.externalRecord(aId).review_count, 0);
    // Only this synthetic service client simulates a human. The MCP connection has no review tool.
    for (const [expected_revision, action] of ["received", "accept_evidence", "accept_interpretation"].entries()) {
      service.reviewExternal({ external_record_id: aId, action, expected_revision,
        review_id: `synthetic-financial-a-${action}`, note: "Synthetic review only, not approval of real research.", confirm_human_review: true });
    }
    ledger.verifyIntegrity();
  } finally { ledger.close(); }
  const second = f.prepare(72, f.sources), updated = await installedTaskClient(t, second);
  assert.notEqual(second.context_id, first.context_id);
  const nextManifest = (await updated.tool("get_research_task")).result.structuredContent;
  const baseline = await installedSection(updated, nextManifest, "baselines");
  assert.equal(baseline.content.length, 1); assert.equal(baseline.content[0].result.summary, initialInput.agent_fields.summary);
  assert.equal(baseline.content[0].usage, "unverified"); assert.equal(baseline.content[0].purpose, "comparison_evidence_only");
  const currentPin = nextManifest.sources.find(pin => pin.source_event_id === f.sources[1].event.source_event_id);
  assert.match(await readFinancialSource(updated, currentPin, f.sources[1]), /25/);
  const secondInput = input(72, fields("REVIEW_REQUIRED", f.sources,
    "Synthetic update: sales 120-100=20. Operating cash 25-30=-5, but issuer-defined FCF rises from 30+(-15)=15 to 25+(-5)=20. USD thousands. No Asia-side conclusion follows."));
  const b = await updated.tool("submit_research", secondInput); assert.equal(b.result.isError, false);
  const bId = b.result.structuredContent.record_id; await updated.close();
  const reconnected = await installedTaskClient(t, second);
  assert.equal((await reconnected.tool("get_submission_status")).result.structuredContent.record_id, bId);
  assert.equal((await reconnected.tool("submit_research", secondInput)).result.structuredContent.reused, true);
  await reconnected.close();
  ledger = new f.ResearchLedger(f.workspace); service = new WorkspaceService(ledger);
  let expected;
  try {
    const detail = service.externalRecord(bId);
    assert.equal(detail.accepted_evidence, false); assert.equal(detail.accepted_interpretation, false);
    assert.equal(detail.evidence_reference.id, aId); assert.equal(detail.interpretation_reference.id, aId);
    for (const [index, action] of ["received", "revisit", "reject"].entries()) {
      service.reviewExternal({ external_record_id: bId, action, expected_revision: index + 3,
        review_id: `synthetic-financial-b-${action}`, note: "Synthetic recheck must preserve A.", confirm_human_review: true });
      assert.equal(service.externalRecord(bId).evidence_reference.id, aId);
      assert.equal(service.externalRecord(bId).interpretation_reference.id, aId);
    }
    assert.deepEqual(service.externalResearch({ order: "newest" }).items.map(item => item.external_record_id), [bId, aId]);
    assert.equal(ledger.pageExternalSessionRecords().length, 2); assert.equal(ledger.workspaceStatus().counts.requests, 0);
    assert.deepEqual(ledger.budget(f.watch_id, "initial").limits, { requests: 0, tokens: 0, cost_microusd: 0, wall_ms: 0 });
    expected = service.externalRecord(bId); ledger.verifyIntegrity();
  } finally { ledger.close(); }
  ledger = new f.ResearchLedger(f.workspace);
  try { assert.deepEqual(new WorkspaceService(ledger).externalRecord(bId), expected); ledger.verifyIntegrity(); }
  finally { ledger.close(); }
});

test("installed default session rechecks revoked source rights before reads and submission", { timeout: 15000 }, async t => {
  const f = await installedFinancialFixture("installed revoked financial source"), prepared = f.prepare(73, f.sources);
  const client = await installedTaskClient(t, prepared), manifest = (await client.tool("get_research_task")).result.structuredContent;
  const ledger = new f.ResearchLedger(f.workspace);
  try { ledger.configureSourcePolicy(f.watch_id, { ...sourcePolicy(2), rights_status: "HOLD" }); } finally { ledger.close(); }
  const pin = manifest.sources[0];
  const read = await client.tool("get_research_task", { view: "read", source_event_id: pin.source_event_id, sha256: pin.sha256 });
  assert.equal(read.result.isError, true); assert.deepEqual(read.result.structuredContent, { code: "SOURCE_RIGHTS_GATED" });
  const denied = await client.tool("submit_research", { submission_id: "00000073-1111-4111-8111-111111111111",
    session: { client: "Synthetic revoked source", model: "No model invoked", session_reference: "synthetic-revoked" },
    agent_fields: { result_state: "SOURCE_NEEDED", summary: "Source access stopped. No conclusion follows.", sources: [], drivers: [],
      falsifiers: [], unknowns: ["Source rights are on hold."], next_check_at: new Date(Date.now() + 86400000).toISOString() } });
  assert.equal(denied.result.isError, true); assert.deepEqual(denied.result.structuredContent, { code: "SOURCE_RIGHTS_GATED" });
  assert.equal((await client.tool("get_submission_status")).result.structuredContent.state, "awaiting_submission"); await client.close();
  const reopened = new f.ResearchLedger(f.workspace);
  try { assert.equal(reopened.pageExternalSessionRecords().length, 0); assert.equal(reopened.workspaceStatus().counts.requests, 0); reopened.verifyIntegrity(); }
  finally { reopened.close(); }
});

test("invalid commands and forwarded flags retain nonzero status without a shell", () => {
  const unknown = call("research; touch SECRET_MARKER");
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /CLIENT_COMMAND_INVALID/); assert.doesNotMatch(unknown.stderr, /SECRET_MARKER/);
  const invalid = call("local", "status", "--workspace", "relative;touch SECRET_MARKER");
  assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).code, "WORKSPACE_PATH_INVALID");
  assert.deepEqual(readdirSync(cwd), []);
});

test("installed workspace serves packaged assets, stops, reopens, and restores without AI", async t => {
  const workspace = join(root, "private-workspace");
  async function open() {
    const child = spawn(command, ["workspace", "--workspace", workspace], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close"); let text = "";
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
    child.stderr.resume();
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Installed workspace startup exceeded the test limit.")), 10000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => { text += chunk; if (text.includes("\n")) { clearTimeout(timer); resolve(text.split("\n")[0]); } });
      child.once("error", () => { clearTimeout(timer); reject(Error("Installed workspace did not start.")); });
      child.once("close", () => { clearTimeout(timer); if (!text.includes("\n")) reject(Error("Installed workspace stopped before startup.")); });
    }).catch(error => { child.kill("SIGTERM"); throw error; });
    return { child, closed, started: JSON.parse(line) };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const { child, closed, started } = await open();
    try {
      assert.equal(new URL(started.origin).hostname, "127.0.0.1");
      assert.equal(Object.hasOwn(started, "private_session_link"), false);
      assert.equal(started.ai_execution_authorized, false); assert.equal(started.payment_authorized, false); assert.equal(started.trading_authorized, false);
      const html = await fetch(started.origin); assert.equal(html.status, 200); assert.match(await html.text(), /Local workspace/);
      const font = await fetch(`${started.origin}/inter.woff2`); assert.equal(font.status, 200); assert.ok((await font.arrayBuffer()).byteLength > 1000);
      const locked = await fetch(`${started.origin}/api/status`); assert.equal(locked.status, 403); await locked.text();
    } finally { child.kill("SIGTERM"); }
    assert.deepEqual(await closed, [143, null]);
    await assert.rejects(fetch(started.origin));
  }
  const status = call("local", "status", "--workspace", workspace);
  assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).counts.requests, 0);
  assert.equal(call("local", "backup", "--workspace", workspace, "--name", "before-upgrade.sqlite").status, 0);
  const restored = join(root, "restored-workspace");
  const restore = call("local", "restore", "--backup", join(workspace, "before-upgrade.sqlite"), "--workspace", restored);
  assert.equal(restore.status, 0); assert.equal(JSON.parse(restore.stdout).execution_authorized, false);
  const recovered = call("local", "status", "--workspace", restored);
  assert.equal(recovered.status, 0); assert.equal(JSON.parse(recovered.stdout).counts.requests, 0);
  assert.equal(call("local", "restore", "--backup", join(workspace, "before-upgrade.sqlite"), "--workspace", restored).status, 1);
});

for (const schemaVersion of [12, 10, 11]) test(`installed restore or explicit upgrade from schema ${schemaVersion} preserves unknown usage, source HOLD, and review decisions`, async () => {
  const { ResearchLedger } = await import(pathToFileURL(join(installed, "client/local/ledger.mjs")).href);
  const workspace = join(root, `synthetic upgrade origin ${schemaVersion}`), restored = join(root, `synthetic upgrade copy ${schemaVersion}`);
  const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  const snapshot = ledger => ({ status: ledger.workspaceStatus(), watch: ledger.watch(scope().watch_id),
    inbox: ledger.inbox(), reviews: ledger.reviews(scope().watch_id), budget: ledger.budget(scope().watch_id, "test-window"),
    held_source: ledger.sourcePolicy(scope().watch_id, "held-upgrade-source") });
  const ledger = new ResearchLedger(workspace);
  let expected, requestId;
  try {
    for (const number of [1, 2]) {
      const envelope = setup(ledger, number); ledger.enqueue(envelope, "test-window", policy());
      const delivery = ledger.finish(ledger.claim("synthetic-install-owner"), { ...result(envelope),
        result_id: `${number.toString().padStart(8, "0")}-1111-4111-8111-111111111111` });
      if (number === 1) {
        ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
        ledger.review(delivery.delivery_id, "accept_evidence", "Synthetic evidence only.", "install-evidence", 0);
        ledger.review(delivery.delivery_id, "accept_interpretation", "Synthetic interpretation only.", "install-interpretation", 1);
      } else ledger.review(delivery.delivery_id, "revisit", "Synthetic recheck only.", "install-revisit", 2);
    }
    const pending = setup(ledger, 3); ledger.enqueue(pending, "test-window", policy());
    const lease = ledger.claim("synthetic-install-owner");
    const request = ledger.reserveRequest(lease, "synthetic-upgrade-unknown", estimate()); requestId = request.request_id;
    ledger.markDispatched(lease, requestId); ledger.gateRun(lease, "DISPATCH_UNCERTAIN");
    ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(), source_id: "held-upgrade-source", rights_status: "HOLD" });
    expected = { ...snapshot(ledger), requests: ledger.requests(pending.run_id) };
    assert.equal(expected.requests[0].status, "unknown");
    assert.equal(expected.budget.gate_code, "USAGE_UNKNOWN");
    assert.equal(expected.watch.evidence_delivery_id, expected.inbox[0].delivery_id);
    assert.equal(expected.watch.interpretation_delivery_id, expected.inbox[0].delivery_id);
    assert.notEqual(expected.watch.interpretation_delivery_id, expected.inbox[1].delivery_id);
    ledger.verifyIntegrity();
  } finally { ledger.close(); }
  assert.equal(call("local", "backup", "--workspace", workspace, "--name", "upgrade.sqlite").status, 0);
  if (schemaVersion !== 12) {
    const db = new DatabaseSync(join(workspace, 'upgrade.sqlite'));
    db.exec('DROP TABLE external_session_reviews; DROP TABLE external_review_manifest;');
    if (schemaVersion === 10) db.exec('DROP TABLE external_session_records; DROP TABLE external_session_contexts; DROP TABLE external_session_manifest;');
    db.exec(`PRAGMA user_version=${schemaVersion}; PRAGMA wal_checkpoint(TRUNCATE);`); db.close();
    const refused = call('local', 'restore', '--backup', join(workspace, 'upgrade.sqlite'), '--workspace', restored);
    assert.equal(refused.status, 1); assert.equal(JSON.parse(refused.stdout).code, 'SCHEMA_UPGRADE_REQUIRED');
    assert.equal(existsSync(restored), false);
    const consent = call('local', 'upgrade', '--backup', join(workspace, 'upgrade.sqlite'), '--workspace', restored);
    assert.equal(consent.status, 1); assert.equal(JSON.parse(consent.stdout).code, 'SCHEMA_UPGRADE_CONSENT_REQUIRED');
    assert.equal(existsSync(restored), false);
  }
  const originalHash = hash(join(workspace, "research.sqlite")), backupHash = hash(join(workspace, "upgrade.sqlite"));
  const restoredOutput = call("local", schemaVersion === 12 ? "restore" : "upgrade", "--backup", join(workspace, "upgrade.sqlite"), "--workspace", restored,
    ...(schemaVersion === 12 ? [] : ['--allow-schema-upgrade']));
  assert.equal(restoredOutput.status, 0); assert.equal(JSON.parse(restoredOutput.stdout).execution_authorized, false);
  assert.equal(JSON.parse(restoredOutput.stdout).status, schemaVersion === 12 ? 'restored' : 'upgraded_copy');
  const reopened = new ResearchLedger(restored);
  try {
    assert.deepEqual({ ...snapshot(reopened), requests: reopened.requests(expected.requests[0].run_id) }, expected);
    assert.equal(reopened.requests(expected.requests[0].run_id)[0].request_id, requestId);
    reopened.verifyIntegrity();
  } finally { reopened.close(); }
  assert.equal(hash(join(workspace, "research.sqlite")), originalHash);
  assert.equal(hash(join(workspace, "upgrade.sqlite")), backupHash);
  assert.equal(call("local", "restore", "--backup", join(workspace, "upgrade.sqlite"), "--workspace", restored).status, 1);
});
