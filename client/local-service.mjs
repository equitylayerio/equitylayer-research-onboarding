#!/usr/bin/env node
import { runLocal } from "./local-cli.mjs";

// Handled gates stop the service. Only an abnormal process exit requests OS restart.
const args = process.argv.slice(2), controller = new AbortController();
const stop = () => controller.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
if (!["schedule-daemon-observe", "schedule-daemon-run"].includes(args[0])) {
  process.stdout.write('{"status":"failed","code":"SERVICE_COMMAND_DENIED"}\n'); process.exitCode = 0;
} else {
  runLocal(args, { signal: controller.signal }).then(() => { process.exitCode = 0; }).catch(() => {
    process.stdout.write('{"status":"failed","code":"SERVICE_OPERATION_FAILED"}\n'); process.exitCode = 0;
  }).finally(() => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); });
}
