import { encodePaymentResponseHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";

import {
  DevnetPaymentSmokeError,
  recordedDelivery,
  recordedDuplicateDelivery,
  recordedPaymentResponse,
  requireMatchedPaymentResponse,
  requireExplicitDevnetPaymentApproval,
} from "./devnet-payment-smoke.js";
import {
  P1A_BASELINE_PERIOD,
  P1A_CAPABILITY_ID,
  P1A_CAPABILITY_VERSION,
  P1A_NETWORK,
  P1A_SOURCE_URL,
  P1A_SYMBOLS,
} from "./policy.js";

function deliveryResult(extra: Record<string, unknown> = {}) {
  return {
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
      source: {
        api_url: P1A_SOURCE_URL,
        snapshot_hash: "a".repeat(64),
        evidence_state: "official_source",
      },
      private_key: "must-not-persist",
    },
    output_hash: "b".repeat(64),
    receipt: {
      receipt_id: "receipt_1",
      status: "settled",
      transaction_reference: "devnet_tx",
      settled_at: "2026-08-15T00:00:00.000Z",
      payment_signature: "must-not-persist",
    },
    payment_signature: "must-not-persist",
    local_token: "must-not-persist",
    ...extra,
  };
}

function settlementHeader(transaction = "devnet_tx"): string {
  return encodePaymentResponseHeader({
    success: true,
    transaction,
    network: P1A_NETWORK,
  });
}

describe("approved Devnet payment smoke gate", () => {
  it("does not permit a payment without the exact founder approval value", () => {
    expect(() => requireExplicitDevnetPaymentApproval({})).toThrow(
      new DevnetPaymentSmokeError("devnet_payment_approval_required"),
    );
    expect(() => requireExplicitDevnetPaymentApproval({ X402_DEVNET_SMOKE_APPROVED: "true" })).toThrow(
      new DevnetPaymentSmokeError("devnet_payment_approval_required"),
    );
  });

  it("accepts only the exact founder approval value", () => {
    expect(() => requireExplicitDevnetPaymentApproval({
      X402_DEVNET_SMOKE_APPROVED: "I_APPROVE_ONE_DEVNET_P1A_PAYMENT",
    })).not.toThrow();
  });
});

describe("approved Devnet payment proof evidence", () => {
  it("records only the allowlisted delivery summary", () => {
    const evidence = recordedDelivery(deliveryResult());

    expect(evidence).toMatchObject({
      task_id: "task_1",
      capability_id: P1A_CAPABILITY_ID,
      capability_version: P1A_CAPABILITY_VERSION,
      receipt: { transaction_reference: "devnet_tx", status: "settled" },
    });
    expect(JSON.stringify(evidence)).not.toContain("must-not-persist");
    expect(evidence).not.toHaveProperty("payment_signature");
    expect(evidence.research_pack).not.toHaveProperty("private_key");
  });

  it("rejects a delivery that does not satisfy the fixed P1a scope", () => {
    expect(() => recordedDelivery(deliveryResult({
      input_scope: { symbols: ["2383.TW"], baseline_period: P1A_BASELINE_PERIOD, source_url: P1A_SOURCE_URL },
    }))).toThrow(new DevnetPaymentSmokeError("delivery_record_invalid"));
  });

  it("records a valid PAYMENT-RESPONSE summary without persisting its header", () => {
    const evidence = recordedPaymentResponse(settlementHeader());

    expect(evidence).toEqual({
      success: true,
      transaction_reference: "devnet_tx",
      network: P1A_NETWORK,
    });
  });

  it("rejects a missing or mismatched PAYMENT-RESPONSE", () => {
    expect(() => recordedPaymentResponse(null)).toThrow(
      new DevnetPaymentSmokeError("payment_response_capture_failed"),
    );
    expect(() => recordedPaymentResponse(encodePaymentResponseHeader({
      success: true,
      transaction: "devnet_tx",
      network: "eip155:8453" as typeof P1A_NETWORK,
    }))).toThrow(new DevnetPaymentSmokeError("payment_response_capture_failed"));
  });

  it("requires the initial PAYMENT-RESPONSE transaction to match the receipt", () => {
    const delivery = recordedDelivery(deliveryResult());

    expect(() => requireMatchedPaymentResponse(delivery, {
      success: true,
      transaction_reference: "different_devnet_tx",
      network: P1A_NETWORK,
    })).toThrow(new DevnetPaymentSmokeError("payment_response_delivery_mismatch"));
  });

  it("requires a same-signature retry to return the stored original delivery", async () => {
    const original = recordedDelivery(deliveryResult());
    const response = new Response(JSON.stringify(deliveryResult()), {
      status: 200,
      headers: { "payment-response": settlementHeader() },
    });

    await expect(recordedDuplicateDelivery(original, response)).resolves.toEqual({
      status: 200,
      matched_original: true,
      payment_response: {
        success: true,
        transaction_reference: "devnet_tx",
        network: P1A_NETWORK,
      },
      task_id: "task_1",
      output_hash: "b".repeat(64),
      receipt_id: "receipt_1",
      transaction_reference: "devnet_tx",
    });
  });

  it("rejects a duplicate retry that returns a different delivery", async () => {
    const original = recordedDelivery(deliveryResult());
    const response = new Response(JSON.stringify(deliveryResult({ output_hash: "c".repeat(64) })), {
      status: 200,
      headers: { "payment-response": settlementHeader() },
    });

    await expect(recordedDuplicateDelivery(original, response)).rejects.toMatchObject({
      code: "duplicate_delivery_check_failed",
    });
  });
});
