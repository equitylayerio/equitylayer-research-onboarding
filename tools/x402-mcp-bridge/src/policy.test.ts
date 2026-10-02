import { describe, expect, it } from "vitest";
import type { PaymentRequired } from "@x402/core/types";

import {
  assertAllowedPaymentRequired,
  bridgeConfigFromEnv,
  BridgePolicyError,
  P1A_AMOUNT_ATOMIC,
  P1A_ASSET,
  P1A_CAPABILITY_ID,
  P1A_CAPABILITY_VERSION,
  P1A_NETWORK,
  P1A_SESSION_MAX_ATOMIC,
  P1A_OUTPUT_SCHEMA,
  redactedDiagnostic,
} from "./policy.js";

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

describe("P1a bridge policy", () => {
  it("allows exactly the fixed local Devnet challenge", () => {
    expect(assertAllowedPaymentRequired(challenge(), config)).toMatchObject({
      scheme: "exact",
      network: P1A_NETWORK,
      amount: P1A_AMOUNT_ATOMIC,
    });
  });

  it("rejects a changed advertised requirement before a signer is called", () => {
    const altered = challenge();
    altered.accepts[0].network = "eip155:8453";
    expect(() => assertAllowedPaymentRequired(altered, config)).toThrow(BridgePolicyError);
  });

  it("rejects a changed facilitator or a different loopback origin", () => {
    const changedFacilitator = challenge();
    (changedFacilitator.accepts[0].extra as Record<string, unknown>).facilitator = "https://example.invalid/facilitator";
    expect(() => assertAllowedPaymentRequired(changedFacilitator, config)).toThrow("facilitator_mismatch");

    const changedOrigin = challenge();
    changedOrigin.resource.url = "http://localhost:3101/api/x402/devnet/taiwan-monthly-revenue-monitor-v1";
    expect(() => assertAllowedPaymentRequired(changedOrigin, config)).toThrow("resource_url_not_allowlisted");

    const credentialedOrigin = challenge();
    credentialedOrigin.resource.url = "http://user:pass@127.0.0.1:3101/api/x402/devnet/taiwan-monthly-revenue-monitor-v1";
    expect(() => assertAllowedPaymentRequired(credentialedOrigin, config)).toThrow("resource_url_not_allowlisted");
  });

  it("rejects changed MIME type, timeout, or fixed symbol scope", () => {
    const changedMime = challenge();
    changedMime.resource.mimeType = "text/html";
    expect(() => assertAllowedPaymentRequired(changedMime, config)).toThrow("resource_metadata_mismatch");

    const changedTimeout = challenge();
    changedTimeout.accepts[0].maxTimeoutSeconds = 999_999;
    expect(() => assertAllowedPaymentRequired(changedTimeout, config)).toThrow("payment_requirement_mismatch");

    const changedSymbols = challenge();
    (changedSymbols.accepts[0].extra as Record<string, unknown>).symbols = ["2330.TW"];
    expect(() => assertAllowedPaymentRequired(changedSymbols, config)).toThrow("symbol_scope_mismatch");

    const changedFeePayer = challenge();
    (changedFeePayer.accepts[0].extra as Record<string, unknown>).feePayer = "not-a-public-key";
    expect(() => assertAllowedPaymentRequired(changedFeePayer, config)).toThrow("payment_extra_mismatch");

    const unexpectedExtra = challenge();
    (unexpectedExtra.accepts[0].extra as Record<string, unknown>).unapproved = true;
    expect(() => assertAllowedPaymentRequired(unexpectedExtra, config)).toThrow("payment_extra_mismatch");

    const unexpectedSpendKey = challenge();
    ((unexpectedSpendKey.accepts[0].extra as Record<string, unknown>).spend_limit as Record<string, unknown>).unapproved = true;
    expect(() => assertAllowedPaymentRequired(unexpectedSpendKey, config)).toThrow("spend_limit_mismatch");

    const extraResourceField = challenge();
    (extraResourceField.resource as unknown as Record<string, unknown>).serviceName = "unexpected";
    expect(() => assertAllowedPaymentRequired(extraResourceField, config)).toThrow("resource_metadata_mismatch");
  });

  it("rejects a public or credentialed resource origin", () => {
    expect(() => bridgeConfigFromEnv({
      X402_P1A_LOCAL_MODE: "true",
      X402_DEVNET_PAY_TO: config.payTo,
      X402_P1A_LOCAL_AUTH_TOKEN: config.localAuthToken,
      EQUITYLAYER_X402_LOCAL_ORIGIN: "https://equitylayer.io",
    })).toThrow("resource_origin_not_loopback_p1a");
    expect(() => bridgeConfigFromEnv({
      X402_P1A_LOCAL_MODE: "true",
      X402_DEVNET_PAY_TO: config.payTo,
      X402_P1A_LOCAL_AUTH_TOKEN: config.localAuthToken,
      EQUITYLAYER_X402_LOCAL_ORIGIN: "http://secret@127.0.0.1:3101",
    })).toThrow("resource_origin_not_loopback_p1a");
  });

  it("requires the exact local mode value", () => {
    expect(() => bridgeConfigFromEnv({
      X402_P1A_LOCAL_MODE: "1",
      X402_DEVNET_PAY_TO: config.payTo,
      X402_P1A_LOCAL_AUTH_TOKEN: config.localAuthToken,
    })).toThrow("local_mode_required");
  });

  it("requires a separate high-entropy local resource token", () => {
    expect(() => bridgeConfigFromEnv({
      X402_P1A_LOCAL_MODE: "true",
      X402_DEVNET_PAY_TO: config.payTo,
    })).toThrow("local_auth_token_missing");
  });

  it("redacts protocol payload labels in diagnostics", () => {
    expect(redactedDiagnostic("payment-signature=secret payment-required:other")).not.toContain("secret");
    expect(redactedDiagnostic("payment-signature=secret payment-required:other")).not.toContain("other");
  });
});
