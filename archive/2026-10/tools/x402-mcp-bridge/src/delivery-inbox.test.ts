import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { publishLocalDelivery, publishLocalDeliveryFromEnv } from "./delivery-inbox.js";
import {
  P1A_BASELINE_PERIOD,
  P1A_CAPABILITY_ID,
  P1A_CAPABILITY_VERSION,
  P1A_SOURCE_URL,
  P1A_SYMBOLS,
} from "./policy.js";

function result(taskId = "task_1", outputHash = "a".repeat(64)) {
  return {
    task_id: taskId,
    capability_id: P1A_CAPABILITY_ID,
    capability_version: P1A_CAPABILITY_VERSION,
    input_scope: {
      symbols: P1A_SYMBOLS,
      baseline_period: P1A_BASELINE_PERIOD,
      source_url: P1A_SOURCE_URL,
    },
    research_pack: {
      report_period: "2026-07",
      as_of_date: "2026-08-13",
      research_readthrough: {
        summary: "A deterministic monthly-revenue read-through.",
        impact_path: "Official source to deterministic diff.",
        what_it_supports: ["Issuer operating momentum."],
        what_it_does_not_prove: ["HBM availability."],
        next_trigger: "The next official monthly release.",
      },
    },
    output_hash: outputHash,
    receipt: {
      receipt_id: `receipt_${taskId}`,
      status: "settled",
      transaction_reference: `devnet_${taskId}`,
      settled_at: "2026-08-25T11:59:00.000Z",
    },
  };
}

describe("local delivery publisher", () => {
  it("writes a private caller-owned inbox and deduplicates deliveries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "equitylayer-delivery-inbox-"));
    const inboxPath = join(directory, "inbox.json");
    await publishLocalDelivery(inboxPath, result(), "2026-08-25T12:00:00.000Z");
    await publishLocalDelivery(inboxPath, result(), "2026-08-25T12:01:00.000Z");
    await publishLocalDelivery(inboxPath, result("task_2", "b".repeat(64)), "2026-08-25T12:02:00.000Z");

    const inbox = JSON.parse(await readFile(inboxPath, "utf8"));
    expect(inbox).toMatchObject({ owner: "caller", persistence: "local_only" });
    expect(inbox.deliveries.map((item: { task_id: string }) => item.task_id)).toEqual(["task_2", "task_1"]);
    expect(inbox.deliveries[0]).not.toHaveProperty("payment_signature");
    expect((await lstat(inboxPath)).mode & 0o777).toBe(0o600);
  });

  it("does nothing when the optional path is not configured", async () => {
    await expect(publishLocalDeliveryFromEnv(result(), {})).resolves.toBe(false);
  });

  it("rejects relative inbox paths", async () => {
    await expect(publishLocalDelivery("relative/inbox.json", result())).rejects.toThrow("local_delivery_inbox_path_invalid");
  });
});
