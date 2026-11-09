import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";

import {
  createLocalDevnetSignerServer,
  createOneTimeP1aSigner,
  DevnetSignerError,
  isolatedDevnetSignerConfigFromEnv,
  loadIsolatedKeypairBytes,
  parseIsolatedKeypairBytes,
} from "./devnet-signer.js";
import {
  P1A_AMOUNT_ATOMIC,
  P1A_ASSET,
  P1A_CAPABILITY_ID,
  P1A_CAPABILITY_VERSION,
  P1A_NETWORK,
  P1A_OUTPUT_SCHEMA,
  P1A_SESSION_MAX_ATOMIC,
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

const validId = "elr_0123456789abcdef0123456789abcdef";
const token = "t".repeat(32);
let closeServer: (() => Promise<void>) | undefined;
let temporaryDirectory: string | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("isolated Devnet signer", () => {
  it("requires explicit mode, an absolute key path, and a local token", () => {
    expect(() => isolatedDevnetSignerConfigFromEnv({
      X402_P1A_LOCAL_MODE: "true",
      X402_DEVNET_PAY_TO: config.payTo,
      X402_P1A_LOCAL_AUTH_TOKEN: config.localAuthToken,
    })).toThrow("devnet_signer_mode_required");

    expect(() => isolatedDevnetSignerConfigFromEnv({
      X402_P1A_LOCAL_MODE: "true",
      X402_DEVNET_PAY_TO: config.payTo,
      X402_P1A_LOCAL_AUTH_TOKEN: config.localAuthToken,
      EQUITYLAYER_X402_DEVNET_SIGNER_MODE: "I_APPROVE_ISOLATED_DEVNET_SIGNER",
      EQUITYLAYER_X402_DEVNET_KEYPAIR_PATH: "relative.json",
      EQUITYLAYER_X402_SIGNER_TOKEN: token,
    })).toThrow("devnet_signer_keypair_path_invalid");

    expect(isolatedDevnetSignerConfigFromEnv({
      X402_P1A_LOCAL_MODE: "true",
      X402_DEVNET_PAY_TO: config.payTo,
      X402_P1A_LOCAL_AUTH_TOKEN: config.localAuthToken,
      EQUITYLAYER_X402_DEVNET_SIGNER_MODE: "I_APPROVE_ISOLATED_DEVNET_SIGNER",
      EQUITYLAYER_X402_DEVNET_KEYPAIR_PATH: "/tmp/isolated-devnet.json",
      EQUITYLAYER_X402_SIGNER_TOKEN: token,
    })).toMatchObject({ port: 9000, bridge: config });
  });

  it("accepts only a 64-byte local keypair file shape", () => {
    expect(parseIsolatedKeypairBytes(JSON.stringify(Array.from({ length: 64 }, (_, index) => index)))).toHaveLength(64);
    expect(() => parseIsolatedKeypairBytes("[1,2,3]")).toThrow("devnet_signer_keypair_invalid");
    expect(() => parseIsolatedKeypairBytes(JSON.stringify(Array(64).fill(256)))).toThrow("devnet_signer_keypair_invalid");
  });

  it("opens only a non-symlink, owner-only keypair descriptor", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "equitylayer-devnet-signer-"));
    const realPath = join(temporaryDirectory, "keypair.json");
    const linkPath = join(temporaryDirectory, "keypair-link.json");
    const encoded = JSON.stringify(Array.from({ length: 64 }, (_, index) => index));
    await writeFile(realPath, encoded, { mode: 0o600 });
    await chmod(realPath, 0o600);

    await expect(loadIsolatedKeypairBytes(realPath)).resolves.toHaveLength(64);

    await symlink(realPath, linkPath);
    await expect(loadIsolatedKeypairBytes(linkPath)).rejects.toMatchObject({ code: "devnet_signer_keypair_path_invalid" });

    await chmod(realPath, 0o644);
    await expect(loadIsolatedKeypairBytes(realPath)).rejects.toMatchObject({ code: "devnet_signer_keypair_permissions_invalid" });

    await chmod(realPath, 0o600);
    await writeFile(realPath, "x".repeat(4_097), { mode: 0o600 });
    await expect(loadIsolatedKeypairBytes(realPath)).rejects.toMatchObject({ code: "devnet_signer_keypair_path_invalid" });
  });

  it("adds the payment identifier only after the fixed challenge passes and signs once", async () => {
    const createPaymentPayload = vi.fn(async (request: PaymentRequired) => {
      expect(request.extensions?.["payment-identifier"]).toMatchObject({ info: { id: validId } });
      return {
        x402Version: 2,
        accepted: request.accepts[0],
        payload: { signature: "test" },
        extensions: request.extensions,
      } as PaymentPayload;
    });
    const signer = createOneTimeP1aSigner(config, { createPaymentPayload });

    await expect(signer.signPayment({ paymentRequired: challenge(), paymentIdentifier: validId })).resolves.toMatchObject({ paymentSignature: expect.any(String) });
    await expect(signer.signPayment({ paymentRequired: challenge(), paymentIdentifier: validId })).rejects.toMatchObject({ code: "devnet_signer_already_used" });
    expect(createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it("rejects a modified challenge before constructing a payment payload", async () => {
    const createPaymentPayload = vi.fn();
    const signer = createOneTimeP1aSigner(config, { createPaymentPayload });
    const altered = challenge();
    altered.accepts[0].amount = "999999";

    await expect(signer.signPayment({ paymentRequired: altered, paymentIdentifier: validId })).rejects.toThrow("payment_requirement_mismatch");
    expect(createPaymentPayload).not.toHaveBeenCalled();
  });

  it("serves only an authenticated loopback signing request", async () => {
    const signer = { signPayment: vi.fn(async () => ({ paymentSignature: "signed" })) };
    const server = await createLocalDevnetSignerServer({
      config: {
        bridge: config,
        keypairPath: "/tmp/unused.json",
        port: 0,
        token,
      },
      signer,
    });
    closeServer = server.close;

    const denied = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment_required: challenge(), payment_identifier: validId }),
    });
    expect(denied.status).toBe(401);

    const allowed = await fetch(server.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ payment_required: challenge(), payment_identifier: validId }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ payment_signature: "signed" });
    expect(signer.signPayment).toHaveBeenCalledTimes(1);
  });

  it("maps one-time signing refusal to conflict without returning details", async () => {
    const signer = {
      signPayment: vi.fn(async () => {
        throw new DevnetSignerError("devnet_signer_already_used");
      }),
    };
    const server = await createLocalDevnetSignerServer({
      config: { bridge: config, keypairPath: "/tmp/unused.json", port: 0, token },
      signer,
    });
    closeServer = server.close;

    const response = await fetch(server.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ payment_required: challenge(), payment_identifier: validId }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "signing_request_rejected" });
  });
});
