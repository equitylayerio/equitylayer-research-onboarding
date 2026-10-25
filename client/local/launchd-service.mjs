import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { contentHash } from "./run-contract.mjs";
import { ScheduleError } from "./schedule-contract.mjs";

const fail = () => { throw new ScheduleError("SERVICE_PLAN_INVALID", "Use canonical owned paths and exact reviewed schedule pins."); };
const xml = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const path = (value, directory = false, privateFile = false) => {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4000 || /[\u0000-\u001f\u007f]/u.test(value) || realpathSync(value) !== value) fail();
  const info = lstatSync(value);
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) fail();
  if (info.isSymbolicLink() || (info.uid !== process.getuid() && (privateFile || info.uid !== 0)) || (info.mode & (privateFile ? 0o077 : 0o022))) fail();
  return value;
};
export function planLaunchAgent(input) {
  try {
    const required = ["workspace", "node", "schedule_id", "revision", "config_sha256"];
    if (!input || typeof input !== "object" || Array.isArray(input) || required.some(key => !Object.hasOwn(input, key)) ||
        Object.keys(input).some(key => ![...required, "runtime"].includes(key)) || process.platform !== "darwin" ||
        typeof input.schedule_id !== "string" || !input.schedule_id.trim() || input.schedule_id.startsWith("--") || input.schedule_id.length > 500 ||
        /[\u0000-\u001f\u007f]/u.test(input.schedule_id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !/^[a-f0-9]{64}$/.test(input.config_sha256)) fail();
    const workspace = path(input.workspace, true, true), node = path(input.node);
    if ((lstatSync(node).mode & 0o111) === 0 || !existsSync(join(workspace, "research.sqlite"))) fail();
    const probe = spawnSync(node, ["--version"], { env: {}, encoding: "utf8", timeout: 2000, maxBuffer: 4096 });
    const version = /^v(\d+)\.(\d+)\.(\d+)\s*$/.exec(probe.stdout ?? "");
    if (probe.error || probe.status !== 0 || !version || Number(version[1]) < 22 || Number(version[1]) === 22 && Number(version[2]) < 13) fail();
    const entry = path(fileURLToPath(new URL("../local-service.mjs", import.meta.url)));
    const workingDirectory = path(fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, ""), true);
    const args = [node, entry, input.runtime ? "schedule-daemon-run" : "schedule-daemon-observe", "--workspace", workspace,
      "--schedule-id", input.schedule_id, "--revision", String(input.revision), "--config-sha256", input.config_sha256, "--allow-continuous"];
    if (input.runtime) args.push("--runtime", path(input.runtime, false, true), "--allow-private-context", "--allow-candidate-method");
    const label = `io.equitylayer.research.${contentHash({ workspace, schedule_id: input.schedule_id }).slice(0, 32)}`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>ExitTimeOut</key><integer>30</integer>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
    return { label, plist, sha256: contentHash({ label, plist }), node_version: version[0].trim(), service_installed: false, research_completion_verified: false };
  } catch (error) { if (error instanceof ScheduleError) throw error; fail(); }
}
