import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { canonicalJson, contentHash } from "./run-contract.mjs";

export class CommandRuntimeError extends Error {
  constructor(code, message) { super(message); this.name = "CommandRuntimeError"; this.code = code; }
}
const fail = (code, message) => { throw new CommandRuntimeError(code, message); };
const bound = (value, fallback, maximum) => {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) fail("COMMAND_CONFIG_INVALID", "Use a positive bounded command limit.");
  return number;
};
const printable = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const measured = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === "cost_microusd,tokens" &&
  [value.tokens, value.cost_microusd].every((number) => Number.isSafeInteger(number) && number >= 0);

// The caller controls authorization, usage measurement, and executable trust.
// This adapter does not provide an operating-system sandbox.
export function createLocalCommandRuntime(config) {
  if (!config || config.allow_local_command !== true) fail("COMMAND_CONSENT_REQUIRED", "Authorize the local command explicitly.");
  if (!printable(config.executable, 4000) || !isAbsolute(config.executable) || !Array.isArray(config.args) ||
      config.args.length > 100 || config.args.some((arg) => typeof arg !== "string" || arg.length > 16000 || arg.includes("\0")) ||
      !printable(config.identity, 200)) fail("COMMAND_CONFIG_INVALID", "Supply an absolute executable, bounded arguments, and a runtime identity.");
  const timeout = bound(config.timeout_ms, 30_000, 3_600_000);
  const inputLimit = bound(config.max_input_bytes, 2_000_000, 2_000_000);
  const outputLimit = bound(config.max_output_bytes, 1_000_000, 2_000_000);
  const stderrLimit = bound(config.max_stderr_bytes, 16_384, 1_000_000);
  const environment = config.env ?? {};
  if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.keys(environment).length > 100 ||
      Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length > 16000 || value.includes("\0"))) {
    fail("COMMAND_CONFIG_INVALID", "Supply bounded environment strings only.");
  }
  const pinned = JSON.parse(canonicalJson({ executable: config.executable, args: config.args, identity: config.identity,
    env: environment, timeout_ms: timeout, max_input_bytes: inputLimit, max_output_bytes: outputLimit, max_stderr_bytes: stderrLimit }));
  return Object.freeze({ identity: pinned.identity, config_sha256: contentHash(pinned),
    execute(input, { signal, request_id } = {}) {
      const serialized = canonicalJson({ input, request_id });
      if (Buffer.byteLength(serialized) > inputLimit) fail("COMMAND_INPUT_LIMIT", "The command input exceeds the byte limit.");
      return new Promise((resolve, reject) => {
        let child, timer, killTimer, done = false, outputBytes = 0, stderrBytes = 0;
        const chunks = [];
        const kill = () => {
          try { child?.kill("SIGTERM"); } catch { /* Termination is best effort. */ }
          killTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* Termination is best effort. */ } }, 100);
          killTimer.unref();
        };
        const finish = (error, value) => {
          if (done) return;
          done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
          if (error) { chunks.length = 0; kill(); reject(error); } else { clearTimeout(killTimer); resolve(value); }
        };
        const error = (code, message) => finish(new CommandRuntimeError(code, message));
        const abort = () => error("COMMAND_ABORTED", "The caller stopped the command.");
        if (signal?.aborted) { abort(); return; }
        try { child = spawn(pinned.executable, pinned.args, { shell: false, env: pinned.env, stdio: ["pipe", "pipe", "pipe"] }); }
        catch { error("COMMAND_START_FAILED", "The command did not start."); return; }
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => error("COMMAND_TIMEOUT", "The command exceeded its time limit."), timeout);
        child.on("error", () => error("COMMAND_START_FAILED", "The command did not start."));
        child.stdin.on("error", () => error("COMMAND_INPUT_FAILED", "The command did not receive its input."));
        child.stdout.on("data", (chunk) => {
          if (done) return;
          outputBytes += chunk.length;
          if (outputBytes > outputLimit) error("COMMAND_OUTPUT_LIMIT", "The command output exceeds the byte limit.");
          else chunks.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderrBytes += chunk.length;
          if (!done && stderrBytes > stderrLimit) error("COMMAND_STDERR_LIMIT", "The command error output exceeds the byte limit.");
        });
        child.on("close", (code, terminationSignal) => {
          clearTimeout(killTimer);
          if (done) return;
          if (code !== 0 || terminationSignal) { error("COMMAND_FAILED", "The command did not complete successfully."); return; }
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { error("COMMAND_OUTPUT_INVALID", "The command must return one JSON object."); return; }
          chunks.length = 0;
          if (!value || typeof value !== "object" || Array.isArray(value) ||
              !Object.hasOwn(value, "agent_fields") || Object.keys(value).some((key) => !["agent_fields", "usage"].includes(key))) {
            error("COMMAND_OUTPUT_INVALID", "The command must return agent fields and optional usage."); return;
          }
          finish(null, { agent_fields: value.agent_fields, usage: measured(value.usage) ? value.usage : null });
        });
        child.stdin.end(serialized);
      });
    } });
}
