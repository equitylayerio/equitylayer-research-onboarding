import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { openWorkspace } from "../client/workspace-cli.mjs";

const directory = () => mkdtempSync(join(tmpdir(), "equitylayer-workspace-cli-"));

test("help does not create a ledger or start a server", async () => {
  let output = "";
  assert.deepEqual(await openWorkspace(["--help"], { stdout: (text) => { output += text; } }), { help: true });
  assert.match(output, /Node 22\.13\+/);
  assert.match(output, /cannot invoke AI, pay, trade/);
});

test("invalid flags, ports, and relative paths fail before startup", async () => {
  for (const args of [["--workspace", "relative"], ["--host", "0.0.0.0"], ["--workspace", "/tmp/x", "--workspace", "/tmp/y"],
    ["--workspace", "/tmp/x", "--port", "65536"], ["--workspace", "/tmp/x", "--port", "01"],
    ["--workspace", "/tmp/x", "--port", "-1"], ["--workspace", "/tmp/x", "--show-link", "--show-link"],
    ["--workspace", "/tmp/x\n"], ["--workspace"], ["--help", "--show-link"]]) {
    await assert.rejects(openWorkspace(args), (error) => /^WORKSPACE_/.test(error.code));
  }
});

test("default startup serves real assets without printing the private token", async () => {
  let output = ""; const root = directory();
  const workspace = await openWorkspace(["--workspace", root], { stdout: (text) => { output += text; } });
  try {
    const started = JSON.parse(output);
    assert.equal(started.origin, workspace.server.origin);
    assert.equal(started.ai_execution_authorized, false);
    assert.equal(started.payment_authorized, false);
    assert.equal(started.trading_authorized, false);
    assert.equal(Object.hasOwn(started, "private_session_link"), false);
    assert.equal(output.includes(workspace.server.token), false);
    assert.equal(output.includes(root), false);
    const html = await fetch(workspace.server.origin);
    assert.equal(html.status, 200); assert.match(await html.text(), /Local workspace/);
    const font = await fetch(`${workspace.server.origin}/inter.woff2`);
    assert.equal(font.status, 200); assert.equal(font.headers.get("content-type"), "font/woff2");
    const locked = await fetch(`${workspace.server.origin}/api/status`);
    assert.equal(locked.status, 403);
    const response = await fetch(`${workspace.server.origin}/api/status`, { headers: { Authorization: `Bearer ${workspace.server.token}` } });
    assert.equal(response.status, 200); assert.equal((await response.json()).counts.watches, 0);
    assert.equal(statSync(root).mode & 0o777, 0o700);
  } finally { await workspace.close(); }
  await workspace.close();
  await assert.rejects(fetch(workspace.server.origin));
});

test("only explicit show-link prints the private fragment link", async () => {
  let output = "";
  const workspace = await openWorkspace(["--workspace", directory(), "--show-link"], { stdout: (text) => { output += text; } });
  try {
    const link = JSON.parse(output).private_session_link;
    assert.equal(link, workspace.server.bootstrap_url);
    assert.equal(new URL(link).search, "");
    assert.equal(new URL(link).hash, `#token=${workspace.server.token}`);
  } finally { await workspace.close(); }
});

test("restart retains SQLite records and creates a new session token", async () => {
  const root = directory(); const first = await openWorkspace(["--workspace", root], { stdout: () => {} });
  const initialToken = first.server.token;
  const { WorkspaceService } = await import("../client/local/workspace-service.mjs");
  new WorkspaceService(first.ledger).saveWatch({ scope: { watch_id: "11111111-1111-4111-8111-111111111111", revision: 1,
    theme_id: "ai_compute", symbols: ["NVDA", "3037.TW", "6758.T", "000660.KS"] },
    private_context: { question: "Synthetic private research question.", trigger: "Synthetic source event.", component: "CPO" } });
  await first.close();
  const second = await openWorkspace(["--workspace", root], { stdout: () => {} });
  try {
    assert.notEqual(second.server.token, initialToken);
    assert.equal(second.ledger.workspaceStatus().counts.watches, 1);
    const stale = await fetch(`${second.server.origin}/api/status`, { headers: { Authorization: `Bearer ${initialToken}` } });
    assert.equal(stale.status, 403);
  } finally { await second.close(); }
});

test("startup failures do not disclose arbitrary errors or file contents", async () => {
  const root = directory(); const file = join(root, "not-a-directory"); writeFileSync(file, "Synthetic secret.");
  await assert.rejects(openWorkspace(["--workspace", file], { stdout: () => {} }), (error) => {
    assert.equal(error.message.includes(file), false);
    assert.equal(error.message.includes("Synthetic secret"), false);
    return /^[A-Z][A-Z0-9_]+$/.test(error.code);
  });
});

test("the executable serves the workspace and closes on SIGTERM", async () => {
  const child = spawn(process.execPath, ["client/workspace-cli.mjs", "--workspace", directory()],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { errors += chunk; });
  const closed = once(child, "close");
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Synthetic startup timeout.")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("\n")) { clearTimeout(timer); resolve(output.split("\n")[0]); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); if (!output.includes("\n")) reject(Error("CLI stopped before startup.")); });
  }).catch((error) => { child.kill("SIGTERM"); throw error; });
  try {
    const started = JSON.parse(line);
    assert.equal(Object.hasOwn(started, "private_session_link"), false);
    assert.equal((await fetch(started.origin)).status, 200);
  } finally { child.kill("SIGTERM"); }
  const [code, signal] = await closed;
  assert.equal(code, 0, errors); assert.equal(signal, null);
});
