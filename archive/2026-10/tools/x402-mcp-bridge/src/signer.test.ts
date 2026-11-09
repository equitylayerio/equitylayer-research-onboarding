import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentRequired } from "@x402/core/types";

import { localSignerFromEnv, SignerUnavailableError } from "./signer.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local signer boundary", () => {
  it("fails closed when no local signer endpoint is configured", async () => {
    await expect(localSignerFromEnv({}).signPayment({
      paymentRequired: {} as PaymentRequired,
      paymentIdentifier: "payment_1",
    })).rejects.toMatchObject({ code: "signer_unavailable" });
  });

  it("rejects a non-loopback or non-sign endpoint before it can be called", () => {
    expect(() => localSignerFromEnv({ EQUITYLAYER_X402_SIGNER_ORIGIN: "https://wallet.example/sign" }))
      .toThrow(new SignerUnavailableError("signer_origin_invalid"));
    expect(() => localSignerFromEnv({ EQUITYLAYER_X402_SIGNER_ORIGIN: "http://127.0.0.1:9000/other" }))
      .toThrow(new SignerUnavailableError("signer_origin_invalid"));
  });

  it("fails closed if an endpoint is configured without an exact local signer token", () => {
    expect(() => localSignerFromEnv({ EQUITYLAYER_X402_SIGNER_ORIGIN: "http://127.0.0.1:9000/sign" }))
      .toThrow(new SignerUnavailableError("signer_token_invalid"));
    expect(() => localSignerFromEnv({
      EQUITYLAYER_X402_SIGNER_ORIGIN: "http://127.0.0.1:9000/sign",
      EQUITYLAYER_X402_SIGNER_TOKEN: "too-short",
    })).toThrow(new SignerUnavailableError("signer_token_invalid"));
  });

  it("sends only the payment challenge and local payment identifier to an approved signer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ payment_signature: "signed-payload" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const token = "t".repeat(32);
    const signer = localSignerFromEnv({
      EQUITYLAYER_X402_SIGNER_ORIGIN: "http://127.0.0.1:9000/sign",
      EQUITYLAYER_X402_SIGNER_TOKEN: token,
    });
    await expect(signer.signPayment({
      paymentRequired: { x402Version: 2 } as PaymentRequired,
      paymentIdentifier: "payment_1",
    })).resolves.toEqual({ paymentSignature: "signed-payload" });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9000/sign", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
      body: JSON.stringify({ payment_required: { x402Version: 2 }, payment_identifier: "payment_1" }),
    }));
  });

  it("does not retry a rejected signer redirect", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("redirect rejected"));
    vi.stubGlobal("fetch", fetchMock);
    const signer = localSignerFromEnv({
      EQUITYLAYER_X402_SIGNER_ORIGIN: "http://127.0.0.1:9000/sign",
      EQUITYLAYER_X402_SIGNER_TOKEN: "t".repeat(32),
    });
    await expect(signer.signPayment({ paymentRequired: {} as PaymentRequired, paymentIdentifier: "test" }))
      .rejects.toMatchObject({ code: "signer_request_failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });
});
