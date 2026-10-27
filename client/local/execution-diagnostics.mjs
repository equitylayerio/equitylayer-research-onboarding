// These messages describe observations, not model access or billing outcomes.
const MESSAGES = Object.freeze({
  NATIVE_VERSION_CHANGED: "The installed CLI version differs from the configured version.",
  NATIVE_CAPABILITY_UNVERIFIED: "The CLI did not confirm the required disabled features.",
  NATIVE_COST_CONTROL_UNVERIFIED: "The CLI did not advertise the requested cost control.",
  NATIVE_TIMEOUT: "The native command exceeded its time limit.",
  NATIVE_ABORTED: "The native command stopped after an abort signal.",
  NATIVE_START_FAILED: "The native command did not start successfully.",
  NATIVE_EXECUTABLE_MISSING: "The operating system could not find the CLI or its interpreter.",
  NATIVE_EXECUTABLE_DENIED: "The operating system refused to execute the CLI.",
  NATIVE_ARGUMENT_ERROR_REPORTED: "The CLI reported an unsupported argument. Check the pinned caller configuration. Actual usage remains unverified.",
  NATIVE_INPUT_FAILED: "The native command could not receive the input.",
  NATIVE_OUTPUT_LIMIT: "The native command exceeded the output limit.",
  NATIVE_STDERR_LIMIT: "The native command exceeded the error output limit.",
  NATIVE_COMMAND_FAILED: "The native command did not exit successfully.",
  NATIVE_TURN_FAILED_REPORTED: "The native caller reported a failed turn. The cause and usage remain unverified.",
  NATIVE_CALLER_ERROR_REPORTED: "The native caller emitted an error event. The cause and usage remain unverified.",
  NATIVE_TURN_LIMIT_REPORTED: "The native caller reported its turn limit. Research did not complete.",
  NATIVE_BUDGET_LIMIT_REPORTED: "The native caller reported its estimated budget limit. Actual usage remains unverified.",
  NATIVE_EXECUTION_ERROR_REPORTED: "The native caller reported an execution error. The underlying cause remains unverified.",
  NATIVE_STRUCTURE_LIMIT_REPORTED: "The native caller reported its structured-output retry limit. No valid result was retained.",
  NATIVE_AUTH_ERROR_REPORTED: "The native caller reported an authentication error. Check the caller login separately.",
  NATIVE_PERMISSION_ERROR_REPORTED: "The native caller reported a permission error. Account access remains unverified.",
  NATIVE_RESOURCE_ERROR_REPORTED: "The native caller reported an unavailable resource. Check the selected model and account access separately.",
  NATIVE_RATE_LIMIT_REPORTED: "The native caller reported a rate limit. Do not retry unknown usage automatically.",
  NATIVE_OVERLOAD_REPORTED: "The native caller reported overload. Do not retry unknown usage automatically.",
  NATIVE_REQUEST_ERROR_REPORTED: "The native caller reported an invalid request. Check the runtime configuration separately.",
  NATIVE_API_ERROR_REPORTED: "The native caller reported an API error. The underlying cause remains unverified.",
  NATIVE_OUTPUT_INVALID: "The native command did not return a valid successful result.",
  EXECUTION_TIMEOUT: "The executor exceeded its time limit.",
  EXECUTION_STOPPED: "The executor received a stop request.",
  DISPATCH_UNCERTAIN: "The executor cannot confirm the request outcome.",
  PREDISPATCH_FAILED: "The executor failed before it confirmed dispatch."
});

export const isExecutionFailureCode = code => typeof code === "string" && Object.hasOwn(MESSAGES, code);

export function executionFailureSummary(value) {
  if (!value || Object.keys(value).sort().join() !== "dispatch_state,failure_code,request_id,schema_version" ||
      value.schema_version !== 1 || !isExecutionFailureCode(value.failure_code) ||
      !["none", "reserved", "dispatched", "settled", "unknown"].includes(value.dispatch_state) ||
      (value.request_id === null ? value.dispatch_state !== "none" :
        typeof value.request_id !== "string" || !/^el-request-[a-f0-9]{64}$/.test(value.request_id) || value.dispatch_state === "none")) return null;
  return { ...value, message: MESSAGES[value.failure_code],
    accounting_instruction: "Keep the accounting gate. Do not retry a request with unknown usage." };
}
