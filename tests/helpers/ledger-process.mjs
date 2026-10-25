import { ResearchLedger } from "../../client/local/ledger.mjs";
import { setup, policy, result, estimate, scope } from "../fixtures/local-research.mjs";

const [directory, mode, faultPoint = ""] = process.argv.slice(2);
const ledger = new ResearchLedger(directory, { clock: () => 1000,
  fault: (point) => { if (point === faultPoint) process.kill(process.pid, "SIGKILL"); } });
if (mode === "worker") {
  process.send({ ready: true });
  process.on("message", (message) => {
    try {
      const output = message.command === "claim" ? ledger.claim(`worker-${process.pid}`, 1000)
        : ledger.reserveRequest(message.lease, "analysis", estimate());
      process.send({ output });
    } catch (error) { process.send({ error: error.code }); }
  });
  process.on("disconnect", () => { ledger.close(); });
} else {
  const envelope = setup(ledger);
  if (mode === "enqueue") ledger.enqueue(envelope, "test-window", policy());
  else if (mode === "review") ledger.review(envelope.delivery_id, "accept_evidence", "Explicit synthetic acceptance.", "child-review", 0);
  else if (mode === "acknowledge") ledger.acknowledgeNotice(envelope.delivery_id);
  else if (mode !== "schema") {
    const lease = ledger.claim("crash-worker", 1000);
    if (mode === "checkpoint") ledger.checkpoint(lease, "plan", { stage: "saved" });
    else if (mode === "finish") ledger.finish(lease, result(envelope));
    else {
      const request = ledger.reserveRequest(lease, "analysis", estimate());
      if (mode !== "reserve") ledger.markDispatched(lease, request.request_id);
      if (mode === "settle") ledger.settleRequest(lease, request.request_id, { tokens: 100, cost_microusd: 50 }, { response: "saved" });
    }
  }
  ledger.close();
}
