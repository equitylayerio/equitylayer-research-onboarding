import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";

import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { appendPaymentIdentifierToExtensions, isValidPaymentId } from "@x402/extensions/payment-identifier";
import { ExactSvmScheme } from "@x402/svm/exact/client";

import { assertAllowedPaymentRequired, bridgeConfigFromEnv, type BridgeConfig } from "./policy.js";
import type { LocalSigner, LocalSignerRequest } from "./signer.js";

const EXPLICIT_SIGNER_MODE = "I_APPROVE_ISOLATED_DEVNET_SIGNER";
const DEFAULT_SIGNER_PORT = 9000;
const SIGNER_PATH = "/sign";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_KEYPAIR_FILE_BYTES = 4 * 1024;

type SignerErrorCode =
  | "devnet_signer_mode_required"
  | "devnet_signer_keypair_path_required"
  | "devnet_signer_keypair_path_invalid"
  | "devnet_signer_keypair_permissions_invalid"
  | "devnet_signer_keypair_invalid"
  | "devnet_signer_token_invalid"
  | "devnet_signer_port_invalid"
  | "devnet_signer_payment_identifier_invalid"
  | "devnet_signer_already_used";

export class DevnetSignerError extends Error {
  constructor(readonly code: SignerErrorCode) {
    super(code);
    this.name = "DevnetSignerError";
  }
}

export type IsolatedDevnetSignerConfig = {
  bridge: BridgeConfig;
  keypairPath: string;
  port: number;
  token: string;
};

type PaymentPayloadCreator = {
  createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload>;
};

export type LocalDevnetSignerServer = {
  close(): Promise<void>;
  url: string;
};

export type CreateSignerServerOptions = {
  config: IsolatedDevnetSignerConfig;
  signer: LocalSigner;
};

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_SIGNER_PORT;
  if (!/^\d+$/.test(value)) throw new DevnetSignerError("devnet_signer_port_invalid");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DevnetSignerError("devnet_signer_port_invalid");
  }
  return port;
}

function parseToken(value: string | undefined): string {
  const token = value?.trim();
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new DevnetSignerError("devnet_signer_token_invalid");
  }
  return token;
}

/**
 * The sidecar only runs after an explicit operator mode and can sign only the
 * exact loopback P1a challenge validated by the bridge policy.
 */
export function isolatedDevnetSignerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IsolatedDevnetSignerConfig {
  if (env.EQUITYLAYER_X402_DEVNET_SIGNER_MODE !== EXPLICIT_SIGNER_MODE) {
    throw new DevnetSignerError("devnet_signer_mode_required");
  }
  const keypairPath = env.EQUITYLAYER_X402_DEVNET_KEYPAIR_PATH?.trim();
  if (!keypairPath) throw new DevnetSignerError("devnet_signer_keypair_path_required");
  if (!isAbsolute(keypairPath)) throw new DevnetSignerError("devnet_signer_keypair_path_invalid");

  return {
    bridge: bridgeConfigFromEnv(env),
    keypairPath,
    port: parsePort(env.EQUITYLAYER_X402_SIGNER_PORT),
    token: parseToken(env.EQUITYLAYER_X402_SIGNER_TOKEN),
  };
}

/** Parse the 64-byte JSON keypair format written by an isolated Solana CLI wallet. */
export function parseIsolatedKeypairBytes(value: string): Uint8Array {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new DevnetSignerError("devnet_signer_keypair_invalid");
  }
  if (
    !Array.isArray(decoded)
    || decoded.length !== 64
    || decoded.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)
  ) {
    throw new DevnetSignerError("devnet_signer_keypair_invalid");
  }
  return Uint8Array.from(decoded);
}

/** Open the immutable descriptor without following links before checking metadata. */
export async function loadIsolatedKeypairBytes(keypairPath: string): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(keypairPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DevnetSignerError("devnet_signer_keypair_path_invalid");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_KEYPAIR_FILE_BYTES) {
      throw new DevnetSignerError("devnet_signer_keypair_path_invalid");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new DevnetSignerError("devnet_signer_keypair_permissions_invalid");
    }
    return parseIsolatedKeypairBytes(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof DevnetSignerError) throw error;
    throw new DevnetSignerError("devnet_signer_keypair_invalid");
  } finally {
    await handle.close();
  }
}

/**
 * This wrapper makes one payload only. It rejects every challenge except the
 * fixed local P1a capability before it calls the SVM scheme.
 */
export function createOneTimeP1aSigner(
  bridge: BridgeConfig,
  paymentPayloadCreator: PaymentPayloadCreator,
): LocalSigner {
  let signing = false;
  let used = false;

  return {
    async signPayment({ paymentRequired, paymentIdentifier }: LocalSignerRequest) {
      if (signing || used) throw new DevnetSignerError("devnet_signer_already_used");
      if (!isValidPaymentId(paymentIdentifier)) {
        throw new DevnetSignerError("devnet_signer_payment_identifier_invalid");
      }
      signing = true;
      try {
        const candidate = structuredClone(paymentRequired);
        assertAllowedPaymentRequired(candidate, bridge);
        if (!candidate.extensions) throw new DevnetSignerError("devnet_signer_payment_identifier_invalid");
        appendPaymentIdentifierToExtensions(candidate.extensions, paymentIdentifier);
        const paymentPayload = await paymentPayloadCreator.createPaymentPayload(candidate);
        used = true;
        return { paymentSignature: encodePaymentSignatureHeader(paymentPayload) };
      } finally {
        signing = false;
      }
    },
  };
}

export async function createOneTimeP1aSignerFromKeypair(
  bridge: BridgeConfig,
  keypairBytes: Uint8Array,
): Promise<LocalSigner> {
  const signer = await createKeyPairSignerFromBytes(keypairBytes);
  const client = new x402Client();
  client.register("solana:*", new ExactSvmScheme(signer));
  return createOneTimeP1aSigner(bridge, client);
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function hasAuthorization(request: IncomingMessage, expectedToken: string): boolean {
  const supplied = request.headers.authorization;
  if (!supplied?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(supplied.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) return null;
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Start a token-bound, one-time local signer. It never exposes key material. */
export async function createLocalDevnetSignerServer(
  options: CreateSignerServerOptions,
): Promise<LocalDevnetSignerServer> {
  const { config, signer } = options;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (!isLoopbackRequest(request) || request.url !== SIGNER_PATH || request.method !== "POST") {
      response.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }
    if (!hasAuthorization(request, config.token)) {
      response.writeHead(401, { "cache-control": "no-store" }).end();
      return;
    }
    const body = await requestJson(request);
    const paymentRequired = body?.payment_required;
    const paymentIdentifier = body?.payment_identifier;
    if (!paymentRequired || typeof paymentRequired !== "object" || typeof paymentIdentifier !== "string") {
      json(response, 400, { error: "signing_request_invalid" });
      return;
    }
    try {
      const signed = await signer.signPayment({
        paymentRequired: paymentRequired as PaymentRequired,
        paymentIdentifier,
      });
      json(response, 200, { payment_signature: signed.paymentSignature });
    } catch (error) {
      const status = error instanceof DevnetSignerError && error.code === "devnet_signer_already_used" ? 409 : 400;
      json(response, status, { error: "signing_request_rejected" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: config.port }, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new DevnetSignerError("devnet_signer_port_invalid");
  }
  return {
    url: `http://127.0.0.1:${address.port}${SIGNER_PATH}`,
    close: () => closeServer(server),
  };
}

export async function runIsolatedDevnetSigner(): Promise<void> {
  const config = isolatedDevnetSignerConfigFromEnv();
  const keypairBytes = await loadIsolatedKeypairBytes(config.keypairPath);
  const signer = await createOneTimeP1aSignerFromKeypair(config.bridge, keypairBytes);
  const server = await createLocalDevnetSignerServer({ config, signer });
  process.stderr.write(`Isolated Devnet signer is listening at ${server.url}. It can sign one approved P1a request.\n`);

  await new Promise<void>((resolve) => {
    const stop = () => void server.close().finally(resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  void runIsolatedDevnetSigner().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "devnet_signer_start_failed"}\n`);
    process.exitCode = 1;
  });
}
