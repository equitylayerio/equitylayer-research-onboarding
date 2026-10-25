import { canonicalJson, contentHash } from "./run-contract.mjs";
import { methodExact, methodHash, methodText, MethodArtifactError } from "./method-artifacts.mjs";

const fail = message => { throw new MethodArtifactError("TRIAL_POLICY_INVALID", message); };
const integer = (value, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("Use bounded integer trial limits.");
  return value;
};

// Pin declared caller settings. This does not authenticate a runtime or provider bill.
export function validateTrialRuntimePolicy(value) {
  methodExact(value, ["schema_version", "runtime", "execution"]);
  if (value.schema_version !== 1) fail("Use runtime policy schema version one.");
  methodExact(value.runtime, ["identity", "config_sha256"]); methodText(value.runtime.identity, 160); methodHash(value.runtime.config_sha256);
  methodExact(value.execution, ["estimate", "timeout_ms", "lease_ms", "heartbeat_ms", "retry_delay_ms"]);
  const execution = value.execution;
  methodExact(execution.estimate, ["tokens", "cost_microusd", "wall_ms"]);
  Object.values(execution.estimate).forEach(number => integer(number, 0, Number.MAX_SAFE_INTEGER));
  integer(execution.timeout_ms, 1, 3_600_000); integer(execution.lease_ms, 1, 3_600_000);
  integer(execution.heartbeat_ms, 1, 60_000); integer(execution.retry_delay_ms, 0, 60_000);
  if (execution.estimate.wall_ms < execution.timeout_ms || execution.heartbeat_ms * 3 > execution.lease_ms) fail("Reserve enough wall time and renew the lease within one third of its duration.");
  const policy = JSON.parse(canonicalJson(value));
  return { policy, sha256: contentHash(policy) };
}

export function requireTrialRuntimePolicy(expectedSha, policyValue, runtime, options) {
  methodHash(expectedSha);
  const retained = validateTrialRuntimePolicy(policyValue);
  if (retained.sha256 !== expectedSha || runtime?.identity !== retained.policy.runtime.identity || runtime?.config_sha256 !== retained.policy.runtime.config_sha256 ||
      typeof runtime.execute !== "function") fail("The trial runtime does not match its frozen policy.");
  const fields = ["estimate", "timeout_ms", "lease_ms", "heartbeat_ms", "retry_delay_ms"];
  const actual = Object.fromEntries(fields.map(field => [field, options?.[field]]));
  if (fields.some(field => actual[field] === undefined) || canonicalJson(actual) !== canonicalJson(retained.policy.execution)) fail("Use the exact execution limits retained in the frozen policy.");
  return retained;
}
