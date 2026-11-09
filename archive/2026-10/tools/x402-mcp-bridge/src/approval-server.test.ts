import { describe, expect, it } from "vitest";

import { createApprovalRequest } from "./approval-server.js";

const details = {
  toolName: "request_taiwan_monthly_revenue_monitor_v1",
  endpoint: "http://127.0.0.1:3101/api/x402/devnet/taiwan-monthly-revenue-monitor-v1",
  priceAtomic: "50000",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  payTo: "11111111111111111111111111111111",
  capabilityVersion: "v1",
  sessionSpendAtomic: "0",
};

describe("loopback approval server", () => {
  it("requires an explicit local approval action", async () => {
    const request = await createApprovalRequest(details, { timeoutMs: 1_000 });
    const page = await fetch(request.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Approve one payment");

    const approved = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approve",
    });
    expect(approved.status).toBe(200);
    await expect(request.waitForDecision()).resolves.toBe(true);
  });

  it("expires without signing approval", async () => {
    const request = await createApprovalRequest(details, { timeoutMs: 20 });
    await expect(request.waitForDecision()).resolves.toBe(false);
  });

  it("treats an explicit reject as a rejected approval", async () => {
    const request = await createApprovalRequest(details, { timeoutMs: 1_000 });
    await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=reject",
    });
    await expect(request.waitForDecision()).resolves.toBe(false);
  });
});
