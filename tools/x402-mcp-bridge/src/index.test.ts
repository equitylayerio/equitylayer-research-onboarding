import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import { executeP1aRequest, publishOptionalLocalDelivery, SpendSession } from "./index.js";
import {
  P1A_AMOUNT_ATOMIC,
  P1A_ASSET,
  P1A_BASELINE_PERIOD,
  P1A_CAPABILITY_ID,
  P1A_CAPABILITY_VERSION,
  P1A_NETWORK,
  P1A_SESSION_MAX_ATOMIC,
  P1A_SOURCE_URL,
  P1A_OUTPUT_SCHEMA,
  P1A_SYMBOLS,
} from "./policy.js";
import { unavailableLocalSigner } from "./signer.js";
import { deliveryOutputHash } from "./delivery-integrity.js";

const config = {
  origin: "http://127.0.0.1:3101",
  endpoint: "http://127.0.0.1:3101/api/x402/devnet/taiwan-monthly-revenue-monitor-v1",
  payTo: "11111111111111111111111111111111",
  localAuthToken: "l".repeat(32),
};

function challenge(): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: config.endpoint,
      mimeType: "application/json",
      description: "P1a local-only source-linked Taiwan monthly-revenue monitor refresh.",
    },
    accepts: [{
      scheme: "exact",
      network: P1A_NETWORK,
      asset: P1A_ASSET,
      amount: P1A_AMOUNT_ATOMIC,
      payTo: config.payTo,
      maxTimeoutSeconds: 300,
      extra: {
        capability_id: P1A_CAPABILITY_ID,
        capability_version: P1A_CAPABILITY_VERSION,
        facilitator: "https://x402.org/facilitator",
        feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5",
        symbols: ["2383.TW", "3037.TW", "8046.TW"],
        output_schema: P1A_OUTPUT_SCHEMA,
        spend_limit: {
          per_payment_atomic: P1A_AMOUNT_ATOMIC,
          session_max_atomic: P1A_SESSION_MAX_ATOMIC,
          session_max_payments: 3,
        },
      },
    }],
    extensions: {
      "payment-identifier": {
        info: { required: true },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            required: { type: "boolean" },
            id: {
              type: "string",
              minLength: 16,
              maxLength: 128,
              pattern: "^[a-zA-Z0-9_-]+$",
            },
          },
          required: ["required"],
        },
      },
    },
  };
}

function approvedRequest() {
  return {
    url: "http://127.0.0.1:49152/approval/token",
    waitForDecision: async () => true,
    close: async () => undefined,
  };
}

function deliveredResult() {
  const result = {
    task_id: "task_1",
    capability_id: P1A_CAPABILITY_ID,
    capability_version: P1A_CAPABILITY_VERSION,
    input_scope: {
      symbols: P1A_SYMBOLS,
      baseline_period: P1A_BASELINE_PERIOD,
      source_url: P1A_SOURCE_URL,
    },
    research_pack: {
      schema_version: "1.0",
      pack_version: "taiwan-monthly-revenue-monitor:v1:2026-07",
      as_of: "2026-07",
      as_of_date: "2026-08-13",
      report_period: "2026-07",
      prior_as_of: "2026-06",
      prior_as_of_date: "2026-07-17",
      source: { api_url: P1A_SOURCE_URL, evidence_state: "official_source" },
      evidence_layers: {
        reported_facts: {
          fields: ["monthly_revenue", "changes"],
          source: P1A_SOURCE_URL,
          scope_note: "Issuer-reported monthly revenue and deterministic changes.",
        },
        management_claims: {
          fields: ["issuer_note"],
          items: [],
          scope_note: "Issuer notes are company statements.",
        },
        inferences: {
          items: [{
            id: "2383-tw-revenue-readthrough",
            symbol: "2383.TW",
            company_name: "Company 2383",
            statement: "Narrow operating read-through.",
            confidence: "low",
            based_on: ["official source"],
            limitation: "No causal or valuation inference.",
          }],
          scope_note: "Deterministic evidence-bounded operating read-through.",
        },
        unknowns: {
          fields: ["unknowns"],
          scope_note: "Top-level unknowns state the limits.",
        },
      },
      research_readthrough: {
        generation: "deterministic",
        review_status: "not_human_reviewed",
        summary: "Fixed-source operating read-through.",
        impact_path: "official source to deterministic diff",
        what_it_supports: ["reported direction"],
        what_it_does_not_prove: ["demand or valuation"],
        confidence: "low",
        unknowns: ["shipment mix"],
        falsifier: "later official source",
        next_trigger: "next official release",
      },
      public_claims: [],
      records: P1A_SYMBOLS.map(symbol => ({ symbol, company_code: symbol.split(".")[0], company_name: String(symbol),
        revenue_thousand_twd: 100, previous_month_revenue_thousand_twd: 100, previous_year_revenue_thousand_twd: 100,
        mom_pct: 0, yoy_pct: 0, ytd_revenue_thousand_twd: 100, previous_ytd_revenue_thousand_twd: 100, ytd_yoy_pct: 0 })),
      changes: P1A_SYMBOLS.map((symbol, index) => ({ symbol, company_name: symbol,
        revenue_delta_thousand_twd: 0, revenue_delta_pct: index === 0 ? null : 0, current_mom_pct: 0, current_yoy_pct: 0 })),
      unknowns: [],
      falsifier: "official source changes",
      next_trigger: "next official release",
    },
    output_hash: "a".repeat(64),
    receipt: {
      receipt_id: "receipt_1",
      status: "settled",
      transaction_reference: "devnet_tx",
      settled_at: "2026-08-14T00:00:00.000Z",
    },
  };
  result.output_hash = deliveryOutputHash(result);
  return result;
}

describe("P1a bridge execution", () => {
  it("does not replace or clear another pending payment", () => {
    const session = new SpendSession();
    session.markDeliveryPending("first");
    expect(() => session.markDeliveryPending("second")).toThrow("previous_payment_requires_review");
    session.clearPendingPayment("second");
    expect(session.pendingPaymentIdentifier()).toBe("first");
    session.clearPendingPayment("first");
    expect(session.pendingPaymentIdentifier()).toBeNull();
  });
  it("reserves the session before awaiting a signer during concurrent calls", async () => {
    let completeSignature!: (value: { paymentSignature: string }) => void;
    const signer = { signPayment: vi.fn(() => new Promise<{ paymentSignature: string }>(resolve => { completeSignature = resolve; })) };
    const fetchImpl = vi.fn(async (_input, init) => init.headers["payment-signature"]
      ? Response.json(deliveredResult(), { headers: { "payment-response": encodePaymentResponseHeader({
        success: true, transaction: "devnet_tx", network: P1A_NETWORK,
      }) } })
      : new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(challenge()) } }));
    const session = new SpendSession();
    const deps = { config, signer, fetchImpl, session, approvalFactory: async () => approvedRequest(), stderr: { write: () => true } };
    const first = executeP1aRequest(deps);
    const second = expect(executeP1aRequest(deps)).rejects.toMatchObject({ code: "previous_payment_requires_review" });
    await vi.waitFor(() => expect(signer.signPayment).toHaveBeenCalledTimes(1));
    await second;
    const pending = session.pendingPaymentIdentifier();
    expect(pending).toMatch(/^elr_/);
    completeSignature({ paymentSignature: "signed" });
    await expect(first).resolves.toMatchObject({ task_id: "task_1" });
    expect(session.pendingPaymentIdentifier()).toBeNull();
    expect(session.summary().payments).toBe(1);
    expect(signer.signPayment).toHaveBeenCalledTimes(1);
  });
  it.each(["empty", "missing", "duplicate", "numeric", "code", "name", "change", "change-percent"])("rejects incomplete issuer evidence: %s", async kind => {
    const delivery = deliveredResult();
    if (kind === "empty") delivery.research_pack.records = [];
    if (kind === "missing") delivery.research_pack.records.pop();
    if (kind === "duplicate") delivery.research_pack.records[1] = delivery.research_pack.records[0];
    if (kind === "numeric") delivery.research_pack.records[0].revenue_thousand_twd = NaN;
    if (kind === "code") delivery.research_pack.records[0].company_code = "9999";
    if (kind === "name") delivery.research_pack.records[0].company_name = "";
    if (kind === "change") delivery.research_pack.changes = [];
    // JSON transport converts non-finite values to null. Rehash to test schema, not integrity rejection.
    const body = JSON.parse(JSON.stringify(delivery));
    if (kind === "change-percent") body.research_pack.changes[0].revenue_delta_pct = "invalid";
    body.output_hash = deliveryOutputHash(body);
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 402,
      headers: { "payment-required": encodePaymentRequiredHeader(challenge()) } }))
      .mockResolvedValueOnce(Response.json(body, { headers: {
        "payment-response": encodePaymentResponseHeader({ success: true, transaction: "devnet_tx", network: P1A_NETWORK }),
      } }));
    await expect(executeP1aRequest({ config, fetchImpl, signer: { signPayment: async () => ({ paymentSignature: "signed" }) },
      session: new SpendSession(), approvalFactory: async () => approvedRequest(), stderr: { write: () => true },
    })).rejects.toMatchObject({ code: "delivery_result_invalid" });
  });
  it("allows a paid response after ten seconds without another signature", async () => {
    // Replace only the clock source. Advance the timer without a real payment or an eleven-second wait.
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 402,
        headers: { "payment-required": encodePaymentRequiredHeader(challenge()) } }))
        .mockImplementationOnce((_input, init) => new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
          setTimeout(() => resolve(Response.json(deliveredResult(), { headers: {
            "payment-response": encodePaymentResponseHeader({ success: true, transaction: "devnet_tx", network: P1A_NETWORK }),
          } })), 11_000);
        }));
      const signer = { signPayment: vi.fn().mockResolvedValue({ paymentSignature: "signed" }) };
      const session = new SpendSession();
      const result = executeP1aRequest({ config, signer, fetchImpl, approvalFactory: async () => approvedRequest(), session,
        stderr: { write: () => true } });
      const assertion = expect(result).resolves.toMatchObject({ task_id: "task_1" });
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
      expect(timeout.mock.calls.map(call => call[0])).toEqual([10_000, 60_000]);
      expect(signer.signPayment).toHaveBeenCalledTimes(1);
      expect(session.pendingPaymentIdentifier()).toBeNull();
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retains an uncertain payment identifier and prevents a new payment in the session", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 402,
      headers: { "payment-required": encodePaymentRequiredHeader(challenge()) } }))
      .mockRejectedValueOnce(new Error("connection lost after transmission"));
    const signer = { signPayment: vi.fn().mockResolvedValue({ paymentSignature: "signed" }) };
    const session = new SpendSession();
    const deps = { config, fetchImpl, signer, session, approvalFactory: async () => approvedRequest(), stderr: { write: () => true } };
    await expect(executeP1aRequest(deps)).rejects.toThrow("connection lost");
    expect(session.pendingPaymentIdentifier()).toMatch(/^elr_/);
    await expect(executeP1aRequest(deps)).rejects.toMatchObject({ code: "previous_payment_requires_review" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signer.signPayment).toHaveBeenCalledTimes(1);
  });

  it.each(["content", "receipt", "date", "hash"])("rejects a delivery with an invalid %s", async (field) => {
    const delivery = deliveredResult();
    if (field === "content") delivery.research_pack.research_readthrough.summary = "Changed after hashing";
    if (field === "receipt") delivery.receipt.transaction_reference = "different_transaction";
    if (field === "date") delivery.receipt.settled_at = "invalid-date";
    if (field === "hash") delivery.output_hash = "0".repeat(64);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 402,
        headers: { "payment-required": encodePaymentRequiredHeader(challenge()) } }))
      .mockResolvedValueOnce(Response.json(delivery, { headers: {
        "payment-response": encodePaymentResponseHeader({ success: true, transaction: "devnet_tx", network: P1A_NETWORK }),
      } }));
    const signer = { signPayment: vi.fn().mockResolvedValue({ paymentSignature: "signed" }) };
    await expect(executeP1aRequest({ config, signer, fetchImpl, approvalFactory: async () => approvedRequest(),
      session: new SpendSession(), stderr: { write: () => true },
    })).rejects.toMatchObject({ code: "delivery_integrity_mismatch" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signer.signPayment).toHaveBeenCalledTimes(1);
  });

  it("returns the settled result when the optional local inbox write fails", async () => {
    const result = deliveredResult();
    const publish = vi.fn().mockRejectedValue(new Error("disk unavailable"));
    const stderr = { write: vi.fn(() => true) };

    await expect(publishOptionalLocalDelivery(result, publish, stderr)).resolves.toBe(result);
    expect(publish).toHaveBeenCalledWith(result);
    expect(stderr.write).toHaveBeenCalledWith("local_delivery_inbox_write_failed\n");
  });

  it("signs once only after approval and retries the same fixed endpoint once", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 402,
        headers: { "payment-required": encodePaymentRequiredHeader(challenge()) },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(deliveredResult()), {
        status: 200,
        headers: {
          "payment-response": encodePaymentResponseHeader({
            success: true,
            transaction: "devnet_tx",
            network: P1A_NETWORK,
          }),
        },
      }));
    const signer = { signPayment: vi.fn().mockResolvedValue({ paymentSignature: "signed" }) };
    const stderr = { write: vi.fn(() => true) };

    const result = await executeP1aRequest({
      config,
      signer,
      fetchImpl,
      approvalFactory: async () => approvedRequest(),
      session: new SpendSession(),
      stderr,
    });

    expect(result.task_id).toBe("task_1");
    expect(signer.signPayment).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(config.endpoint);
    expect(fetchImpl.mock.calls[0][1].headers["x-equitylayer-p1a-local-token"]).toBe(config.localAuthToken);
    expect(fetchImpl.mock.calls[1][1].headers["x-equitylayer-p1a-local-token"]).toBe(config.localAuthToken);
    expect(fetchImpl.mock.calls[1][1].headers["payment-signature"]).toBe("signed");
    expect(fetchImpl.mock.calls.every(call => call[1].redirect === "error" && call[1].signal instanceof AbortSignal)).toBe(true);
  });

  it("does not retry when no external signer is available", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), {
      status: 402,
      headers: { "payment-required": encodePaymentRequiredHeader(challenge()) },
    }));

    await expect(executeP1aRequest({
      config,
      signer: unavailableLocalSigner,
      fetchImpl,
      approvalFactory: async () => approvedRequest(),
      session: new SpendSession(),
      stderr: { write: () => true },
    })).rejects.toMatchObject({ code: "signer_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not sign when approval is rejected", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), {
      status: 402,
      headers: { "payment-required": encodePaymentRequiredHeader(challenge()) },
    }));
    const signer = { signPayment: vi.fn() };

    await expect(executeP1aRequest({
      config,
      signer,
      fetchImpl,
      approvalFactory: async () => ({ ...approvedRequest(), waitForDecision: async () => false }),
      session: new SpendSession(),
      stderr: { write: () => true },
    })).rejects.toMatchObject({ code: "payment_not_approved" });
    expect(signer.signPayment).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a settlement response for a different network", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 402,
        headers: { "payment-required": encodePaymentRequiredHeader(challenge()) },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(deliveredResult()), {
        status: 200,
        headers: {
          "payment-response": encodePaymentResponseHeader({
            success: true,
            transaction: "devnet_tx",
            network: "eip155:8453" as typeof P1A_NETWORK,
          }),
        },
      }));
    const signer = { signPayment: vi.fn().mockResolvedValue({ paymentSignature: "signed" }) };

    await expect(executeP1aRequest({
      config,
      signer,
      fetchImpl,
      approvalFactory: async () => approvedRequest(),
      session: new SpendSession(),
      stderr: { write: () => true },
    })).rejects.toMatchObject({ code: "payment_response_mismatch" });
  });

  it("rejects a settled response that lacks the promised Research Pack or receipt", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 402,
        headers: { "payment-required": encodePaymentRequiredHeader(challenge()) },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: "task_1",
        capability_id: P1A_CAPABILITY_ID,
        capability_version: P1A_CAPABILITY_VERSION,
        output_hash: "a".repeat(64),
      }), {
        status: 200,
        headers: {
          "payment-response": encodePaymentResponseHeader({
            success: true,
            transaction: "devnet_tx",
            network: P1A_NETWORK,
          }),
        },
      }));
    const signer = { signPayment: vi.fn().mockResolvedValue({ paymentSignature: "signed" }) };

    await expect(executeP1aRequest({
      config,
      signer,
      fetchImpl,
      approvalFactory: async () => approvedRequest(),
      session: new SpendSession(),
      stderr: { write: () => true },
    })).rejects.toMatchObject({ code: "delivery_result_invalid" });
  });

  it("rejects a settled response with a stale capability version", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 402,
        headers: { "payment-required": encodePaymentRequiredHeader(challenge()) },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...deliveredResult(),
        capability_version: "v0",
      }), {
        status: 200,
        headers: {
          "payment-response": encodePaymentResponseHeader({
            success: true,
            transaction: "devnet_tx",
            network: P1A_NETWORK,
          }),
        },
      }));
    const signer = { signPayment: vi.fn().mockResolvedValue({ paymentSignature: "signed" }) };

    await expect(executeP1aRequest({
      config,
      signer,
      fetchImpl,
      approvalFactory: async () => approvedRequest(),
      session: new SpendSession(),
      stderr: { write: () => true },
    })).rejects.toMatchObject({ code: "delivery_result_invalid" });
  });

  it("rejects a settled response with a scope that differs from the paid operation", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 402,
        headers: { "payment-required": encodePaymentRequiredHeader(challenge()) },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...deliveredResult(),
        input_scope: {
          symbols: ["2383.TW", "3037.TW", "9999.TW"],
          baseline_period: P1A_BASELINE_PERIOD,
          source_url: P1A_SOURCE_URL,
        },
      }), {
        status: 200,
        headers: {
          "payment-response": encodePaymentResponseHeader({
            success: true,
            transaction: "devnet_tx",
            network: P1A_NETWORK,
          }),
        },
      }));
    const signer = { signPayment: vi.fn().mockResolvedValue({ paymentSignature: "signed" }) };

    await expect(executeP1aRequest({
      config,
      signer,
      fetchImpl,
      approvalFactory: async () => approvedRequest(),
      session: new SpendSession(),
      stderr: { write: () => true },
    })).rejects.toMatchObject({ code: "delivery_result_invalid" });
  });

  it("rejects a settled response that omits one required evidence layer", async () => {
    const delivery = deliveredResult();
    const { unknowns: _unknowns, ...incompleteLayers } = delivery.research_pack.evidence_layers;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 402,
        headers: { "payment-required": encodePaymentRequiredHeader(challenge()) },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...delivery,
        research_pack: {
          ...delivery.research_pack,
          evidence_layers: incompleteLayers,
        },
      }), {
        status: 200,
        headers: {
          "payment-response": encodePaymentResponseHeader({
            success: true,
            transaction: "devnet_tx",
            network: P1A_NETWORK,
          }),
        },
      }));
    const signer = { signPayment: vi.fn().mockResolvedValue({ paymentSignature: "signed" }) };

    await expect(executeP1aRequest({
      config,
      signer,
      fetchImpl,
      approvalFactory: async () => approvedRequest(),
      session: new SpendSession(),
      stderr: { write: () => true },
    })).rejects.toMatchObject({ code: "delivery_result_invalid" });
  });
});
