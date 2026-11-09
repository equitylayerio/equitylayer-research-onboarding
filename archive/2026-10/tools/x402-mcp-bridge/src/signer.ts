import type { PaymentRequired } from "@x402/core/types";

export type LocalSignerRequest = {
  paymentRequired: PaymentRequired;
  paymentIdentifier: string;
};

/**
 * An external local signing provider implements this interface. The bridge does
 * not accept a private key, seed phrase, raw signature, or wallet material.
 */
export interface LocalSigner {
  signPayment(request: LocalSignerRequest): Promise<{ paymentSignature: string }>;
}

type SignerErrorCode =
  | "signer_unavailable"
  | "signer_origin_invalid"
  | "signer_token_invalid"
  | "signer_request_failed"
  | "signer_response_invalid";

export class SignerUnavailableError extends Error {
  constructor(readonly code: SignerErrorCode = "signer_unavailable") {
    super(code);
    this.name = "SignerUnavailableError";
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function parseSignerEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SignerUnavailableError("signer_origin_invalid");
  }
  if (
    url.protocol !== "http:"
    || !isLoopbackHost(url.hostname)
    || !url.port
    || url.username
    || url.password
    || url.pathname !== "/sign"
    || url.search
    || url.hash
  ) {
    throw new SignerUnavailableError("signer_origin_invalid");
  }
  return url.href;
}

function parseSignerToken(value: string | undefined): string {
  const token = value?.trim();
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new SignerUnavailableError("signer_token_invalid");
  }
  return token;
}

/**
 * A signer is optional and local. Set an exact loopback `/sign` endpoint only
 * when an approved Devnet wallet provider is already running on this machine.
 */
export function localSignerFromEnv(env: NodeJS.ProcessEnv = process.env): LocalSigner {
  const configured = env.EQUITYLAYER_X402_SIGNER_ORIGIN?.trim();
  if (!configured) return unavailableLocalSigner;
  const endpoint = parseSignerEndpoint(configured);
  const token = parseSignerToken(env.EQUITYLAYER_X402_SIGNER_TOKEN);

  return {
    async signPayment({ paymentRequired, paymentIdentifier }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ payment_required: paymentRequired, payment_identifier: paymentIdentifier }),
            signal: controller.signal,
          });
        } catch {
          throw new SignerUnavailableError("signer_request_failed");
        }
        if (!response.ok) throw new SignerUnavailableError("signer_request_failed");
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new SignerUnavailableError("signer_response_invalid");
        }
        const paymentSignature = typeof body === "object" && body !== null
          ? (body as Record<string, unknown>).payment_signature
          : undefined;
        if (typeof paymentSignature !== "string" || !paymentSignature) {
          throw new SignerUnavailableError("signer_response_invalid");
        }
        return { paymentSignature };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const unavailableLocalSigner: LocalSigner = {
  async signPayment() {
    throw new SignerUnavailableError();
  },
};
