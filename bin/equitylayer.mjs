#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { constants } from "node:os";

const HELP = `EquityLayer research client
  equitylayer research --help
  equitylayer local --help
  equitylayer workspace --help
  equitylayer session --help
  equitylayer setup --session --workspace ABSOLUTE_NEW_PRIVATE_DIRECTORY
  equitylayer setup --workspace ABSOLUTE_NEW_PRIVATE_DIRECTORY
  equitylayer sources --workspace ABSOLUTE_PRIVATE_DIRECTORY
  equitylayer documents --workspace ABSOLUTE_PRIVATE_DIRECTORY --file ABSOLUTE_RETAINED_FILE
  equitylayer --version

Research connects to the public API/MCP. Send public research only.
Local stores private jobs and requires explicit AI execution consent.
Workspace serves a local review interface. It cannot invoke AI, pay, or trade.
This candidate does not install models or a background service.
Read docs/installable-client.md in the installed package before setup.
`;
const ROUTES = Object.freeze({ research: "../client/cli.mjs", local: "../client/local-cli.mjs", workspace: "../client/workspace-cli.mjs", session: "../client/session-cli.mjs", setup: "../client/setup-cli.mjs", sources: "../client/source-setup-cli.mjs", documents: "../client/documents-cli.mjs" });

export function supportedNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return Boolean(match && (Number(match[1]) > 22 || Number(match[1]) === 22 && Number(match[2]) >= 13));
}

export async function runEntry(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value),
  nodeVersion = process.versions.node, signalProcess = process.kill } = {}) {
  if (!supportedNode(nodeVersion)) { stderr("NODE_VERSION_UNSUPPORTED: Use Node 22.13 or later.\n"); return { exitCode: 1 }; }
  if (!args.length || args.length === 1 && args[0] === "--help") { stdout(HELP); return { exitCode: 0 }; }
  if (args.length === 1 && args[0] === "--version") {
    const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    stdout(`${metadata.name} ${metadata.version}\n`); return { exitCode: 0 };
  }
  if (!Object.hasOwn(ROUTES, args[0])) { stderr("CLIENT_COMMAND_INVALID: Read equitylayer --help.\n"); return { exitCode: 1 }; }
  const entry = fileURLToPath(new URL(ROUTES[args[0]], import.meta.url));
  // Preserve the existing entry's validation, permissions, and output handling.
  return new Promise(resolve => {
    let child, finished = false, childClosed = false, stopSignal = null, stopTimer = null, forceSent = false, stopDeadline = 0;
    const ownedGroup = process.platform !== "win32";
    const finish = exitCode => {
      if (finished) return;
      finished = true;
      clearTimeout(stopTimer);
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
      resolve({ exitCode });
    };
    const signalOwned = signal => {
      if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) return;
      try { signalProcess(ownedGroup ? -child.pid : child.pid, signal); }
      catch (error) {
        // The process group can be absent before the child completes its spawn.
        if (error.code === "ESRCH" && !childClosed) { try { child.kill(signal); } catch { /* Confirm termination separately. */ } }
      }
    };
    const ownedAlive = () => {
      if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) return false;
      try { signalProcess(ownedGroup ? -child.pid : child.pid, 0); return true; }
      catch (error) { return error.code !== "ESRCH"; }
    };
    const checkStop = () => {
      clearTimeout(stopTimer);
      if (finished || !stopSignal) return;
      if (childClosed && !ownedAlive()) { finish(128 + constants.signals[stopSignal]); return; }
      if (performance.now() >= stopDeadline) {
        if (forceSent) {
          stderr("CLIENT_STOP_UNCONFIRMED\n");
          // Report uncertainty without waiting forever for a child we cannot stop.
          child?.unref();
          finish(1);
          return;
        }
        forceSent = true;
        signalOwned("SIGKILL");
        stopDeadline = performance.now() + 1000;
      }
      stopTimer = setTimeout(checkStop, 25);
    };
    const stop = signal => {
      if (finished || stopSignal) return;
      stopSignal = signal;
      stopDeadline = performance.now() + 1000;
      signalOwned(signal);
      checkStop();
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    // A new POSIX group limits cancellation to this invocation and its inherited children.
    try { child = spawn(process.execPath, [entry, ...args.slice(1)], { shell: false, stdio: "inherit", detached: ownedGroup }); }
    catch { stderr("CLIENT_START_FAILED\n"); finish(1); return; }
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    child.once("error", () => { stderr("CLIENT_START_FAILED\n"); finish(1); });
    child.once("close", (code, signal) => {
      childClosed = true;
      if (stopSignal) checkStop();
      else finish(Number.isInteger(code) ? code : 128 + (constants.signals[signal] ?? 1));
    });
  });
}

let main = false;
try { main = Boolean(process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)); } catch { /* An import need not have a file entry. */ }
if (main) runEntry(process.argv.slice(2)).then(result => { process.exitCode = result.exitCode; }).catch(() => {
  process.stderr.write("CLIENT_COMMAND_FAILED\n"); process.exitCode = 1;
});
