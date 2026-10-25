import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { planLaunchAgent } from "../client/local/launchd-service.mjs";

test("service entry denies non-worker commands without execution or restart", () => {
  const child = spawnSync(process.execPath, ["client/local-service.mjs", "run"], { encoding: "utf8" });
  assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).code, "SERVICE_COMMAND_DENIED");
});
test("service entry treats handled setup failures as terminal rather than restart loops", () => {
  const child = spawnSync(process.execPath, ["client/local-service.mjs", "schedule-daemon-run"], { encoding: "utf8" });
  assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).status, "error");
  assert.equal(JSON.parse(child.stdout).code, "CLI_FLAGS_INVALID");
});
test("launchd plan escapes arguments, pins configuration and performs no installation", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-launchd-plan-test-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "research.sqlite"), "synthetic-not-opened", { mode: 0o600 });
  const input = { workspace: root, node: realpathSync(process.execPath), schedule_id: "synthetic&<watch>", revision: 2, config_sha256: "e".repeat(64) };
  if (process.platform !== "darwin") { assert.throws(() => planLaunchAgent(input), { code: "SERVICE_PLAN_INVALID" }); return; }
  const first = planLaunchAgent(input), second = planLaunchAgent(input);
  assert.equal(first.sha256, second.sha256); assert.equal(first.service_installed, false);
  assert.equal(first.node_version, process.version);
  assert.match(first.plist, /synthetic&amp;&lt;watch&gt;/); assert.match(first.plist, /SuccessfulExit<\/key><false/);
  assert.match(first.plist, /--allow-continuous/); assert.doesNotMatch(first.plist, /--allow-private-context|EnvironmentVariables|StandardOutPath/);
  assert.match(first.label, /^io\.equitylayer\.research\.[a-f0-9]{32}$/);
  for (const patch of [{ revision: 0 }, { config_sha256: "changed" }, { node: "relative" }, { command: "trade" }, { schedule_id: "--run" }]) {
    assert.throws(() => planLaunchAgent({ ...input, ...patch }), { code: "SERVICE_PLAN_INVALID" });
  }
  chmodSync(root, 0o755); assert.throws(() => planLaunchAgent(input), { code: "SERVICE_PLAN_INVALID" });
});
test("service plan rejects an unsupported runtime before generating a restartable service", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "el-launchd-version-test-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "research.sqlite"), "synthetic-not-opened", { mode: 0o600 });
  const node = join(root, "synthetic-node"); writeFileSync(node, '#!/bin/sh\nprintf "v20.0.0\\n"\n', { mode: 0o700 });
  assert.throws(() => planLaunchAgent({ workspace: root, node, schedule_id: "synthetic", revision: 1, config_sha256: "a".repeat(64) }), { code: "SERVICE_PLAN_INVALID" });
});
