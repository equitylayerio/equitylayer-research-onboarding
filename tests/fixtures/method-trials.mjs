import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchLedger } from "../../client/local/ledger.mjs";
import { contentHash } from "../../client/local/run-contract.mjs";
import { methodBundle, scope, limits, policy } from "./local-research.mjs";
import { configureEventWatch, intake, sourcePolicy } from "./source-events.mjs";

export function trialFixture({ fault = () => {}, allow = true } = {}) {
  let now = Date.parse("2026-10-12T00:00:00.000Z");
  const directory = mkdtempSync(join(tmpdir(), "el-method-trial-"));
  const ledger = new ResearchLedger(directory, { clock: () => now, fault });
  const method = configureEventWatch(ledger);
  ledger.configureSourcePolicy(scope().watch_id, { ...sourcePolicy(2), rights_status: "HOLD" });
  const decision = ledger.intakeSourceEvent(intake(method));
  const captured = ledger.captureMethodCase({ case_id: "synthetic-case", origin: { kind: "source_gate", id: `el-event-decision-${contentHash(decision.decision)}` },
    note: "Synthetic historical case. No real investment evidence.", author_id: "synthetic-owner" });
  const bundle = methodBundle(); bundle.version = "test-2"; bundle.content_sha256 = contentHash(Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== "content_sha256")));
  ledger.retainMethodCandidate({ candidate_id: "synthetic-candidate", bundle, parent_method_sha256: method.bundle_sha256,
    case_refs: [{ case_id: "synthetic-case", case_sha256: captured.sha256 }], reason: "Synthetic candidate version.", author_id: "synthetic-author" });
  const runtimePolicy = { schema_version: 1, runtime: { identity: "synthetic-paired-runtime", config_sha256: "a".repeat(64) },
    execution: { estimate: { tokens: 100, cost_microusd: 100, wall_ms: 500 }, timeout_ms: 100, lease_ms: 1000, heartbeat_ms: 20, retry_delay_ms: 0 } };
  ledger.freezeMethodPlan({ plan_id: "synthetic-plan", incumbent_method_sha256: method.bundle_sha256,
    case_refs: [{ case_id: "synthetic-case", case_sha256: captured.sha256, partition: "regression" }],
    rubric: { version: "synthetic-rubric", criteria: [{ id: "support", description: "Synthetic source support.", critical: true, weight: 1 }],
      minimum_score_bps: 9000, critical_regression_veto: true, comparison_rule: "paired_incumbent_no_regression" },
    evaluation_at: new Date(now).toISOString(), repetitions: 2, runtime_policy_sha256: contentHash(runtimePolicy), author_id: "synthetic-evaluator" });
  if (allow) ledger.configureSourcePolicy(scope().watch_id, sourcePolicy(3));
  ledger.configureBudget(scope().watch_id, "method-trial:test", limits());
  const request = { plan_id: "synthetic-plan", case_id: "synthetic-case", candidate_id: "synthetic-candidate", repetition: 1,
    runtime_policy: runtimePolicy, budget_window: "method-trial:test", run_policy: policy() };
  const pair = ledger.enqueueMethodTrialPair(request);
  return { ledger, directory, pair, request, runtimePolicy, clock: () => now, setNow: value => { now = value; } };
}
export const trialOptions = env => ({ allow_private_context: true, allow_candidate_method: true, allow_method_trial: true,
  runtime_policy: env.runtimePolicy, ...env.runtimePolicy.execution, clock: env.clock });
export function trialRuntime(env, execute) {
  return { ...env.runtimePolicy.runtime, execute: execute ?? (async () => ({ usage: { tokens: 10, cost_microusd: 20 },
    agent_fields: { result_state: "REVIEW_REQUIRED", summary: "Synthetic trial output. No investment finding.",
      sources: [{ url: "https://example.test/events", date: "2026-10-11", claim: "Synthetic retained fact.", kind: "reported_fact" }],
      drivers: [], falsifiers: [], unknowns: [], next_check_at: "2026-10-13T00:00:00.000Z" } })) };
}
