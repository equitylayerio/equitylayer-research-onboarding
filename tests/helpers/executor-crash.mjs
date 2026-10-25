import { ResearchLedger } from "../../client/local/ledger.mjs";
import { executeClaimedRun } from "../../client/local/executor.mjs";
import { result } from "../fixtures/local-research.mjs";

const [directory, time, invalid] = process.argv.slice(2);
const now = Number(time);
const ledger = new ResearchLedger(directory, { clock: () => now, fault: (point) => {
  if (point === "settle:after_commit") process.exit(23);
} });
const lease = ledger.claim("synthetic-crash-worker", 1000);
const data = result(lease.envelope);
const agentFields = Object.fromEntries(["result_state", "summary", "sources", "drivers", "falsifiers", "unknowns", "next_check_at"].map((key) => [key, data[key]]));
if (invalid === "invalid") agentFields.result_id = "agent-must-not-set-id";
await executeClaimedRun(ledger, lease, { identity: "synthetic-runtime-v1", config_sha256: "a".repeat(64),
  execute: async () => ({ agent_fields: agentFields, usage: { tokens: 1, cost_microusd: 1 } }) },
{ allow_private_context: true, allow_candidate_method: true, clock: () => now, timeout_ms: 200, heartbeat_ms: 20,
  lease_ms: 1000, estimate: { tokens: 100, cost_microusd: 100, wall_ms: 500 } });
ledger.close();
