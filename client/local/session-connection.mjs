import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalSessionError } from "./external-session-contract.mjs";

// Derive executable paths from this installed module, not from browser input.
export function sessionConnection(directory, prepared, consent) {
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(directory) ||
      !/^el-session-context-[a-f0-9]{64}$/.test(prepared?.context?.context_id ?? "") ||
      consent?.allow_private_context !== true || consent?.allow_candidate_method !== true || typeof consent.allow_external_submission !== "boolean") {
    throw new ExternalSessionError("SESSION_CONNECTION_INVALID");
  }
  const args = [fileURLToPath(new URL("../session-cli.mjs", import.meta.url)), "serve", "--workspace", directory,
      "--context", prepared.context.context_id, "--allow-private-context", "--allow-candidate-method",
      ...(consent.allow_external_submission ? ["--allow-external-submission"] : [])];
  const checkArgs = [...args]; checkArgs[1] = "check";
  return { context_id: prepared.context.context_id, preparation_id: prepared.context.preparation_id, reused: prepared.reused,
    mcp_command: { command: process.execPath, args }, check_command: { command: process.execPath, args: checkArgs },
    native_execution: false, usage: "unverified", accepted_evidence: false, accepted_interpretation: false };
}
