import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { declarePaymentIdentifierExtension, PAYMENT_IDENTIFIER } from "@x402/extensions/payment-identifier";
import { z } from "zod";

export const TOOL_NAME = "request_taiwan_monthly_revenue_monitor_v1";
export const P1A_ROUTE_PATH = "/api/x402/devnet/taiwan-monthly-revenue-monitor-v1";
export const P1A_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const P1A_ASSET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const P1A_AMOUNT_ATOMIC = "50000";
export const P1A_SESSION_MAX_ATOMIC = "150000";
export const P1A_FACILITATOR = "https://x402.org/facilitator";
export const P1A_CAPABILITY_ID = "taiwan-monthly-revenue-monitor";
export const P1A_CAPABILITY_VERSION = "v1";
export const P1A_BASELINE_PERIOD = "2026-06";
export const P1A_SOURCE_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L";
export const P1A_RESOURCE_DESCRIPTION = "P1a local-only source-linked Taiwan monthly-revenue monitor refresh.";
export const P1A_LOCAL_AUTH_HEADER = "x-equitylayer-p1a-local-token";
export const P1A_OUTPUT_SCHEMA = [
  "task_id",
  "capability_id",
  "capability_version",
  "input_scope",
  "research_pack",
  "output_hash",
  "receipt",
] as const;
export const P1A_SYMBOLS = ["2383.TW", "3037.TW", "8046.TW"] as const;

export type BridgeConfig = {
  origin: string;
  endpoint: string;
  payTo: string;
  localAuthToken: string;
};

export class BridgePolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BridgePolicyError";
  }
}

const trueLiteral = z.literal("true");
const localAuthTokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const paymentIdentifierDeclaration = declarePaymentIdentifierExtension(true);

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

export function parseLocalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BridgePolicyError("resource_origin_invalid");
  }
  if (
    url.protocol !== "http:"
    || url.username
    || url.password
    || !isLoopbackHost(url.hostname)
    || url.port !== "3101"
    || (url.pathname !== "" && url.pathname !== "/")
    || url.search
    || url.hash
  ) {
    throw new BridgePolicyError("resource_origin_not_loopback_p1a");
  }
  return url.origin;
}

export function bridgeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  if (!trueLiteral.safeParse(env.X402_P1A_LOCAL_MODE).success) {
    throw new BridgePolicyError("local_mode_required");
  }
  const payTo = env.X402_DEVNET_PAY_TO?.trim();
  if (!payTo) throw new BridgePolicyError("pay_to_missing");
  const localAuthToken = env.X402_P1A_LOCAL_AUTH_TOKEN?.trim();
  if (!localAuthToken || !localAuthTokenPattern.test(localAuthToken)) {
    throw new BridgePolicyError("local_auth_token_missing");
  }
  const origin = parseLocalOrigin(env.EQUITYLAYER_X402_LOCAL_ORIGIN ?? "http://127.0.0.1:3101");
  return { origin, endpoint: `${origin}${P1A_ROUTE_PATH}`, payTo, localAuthToken };
}

function isStrictArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function isSolanaPublicKey(value: unknown): value is string {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return isStrictArray(Object.keys(value).sort(), [...expected].sort());
}

function isExactData(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(value)
      && value.length === expected.length
      && value.every((entry, index) => isExactData(entry, expected[index]));
  }
  const expectedRecord = asRecord(expected);
  if (expectedRecord) {
    const valueRecord = asRecord(value);
    return Boolean(
      valueRecord
      && hasExactKeys(valueRecord, Object.keys(expectedRecord))
      && Object.keys(expectedRecord).every((key) => isExactData(valueRecord[key], expectedRecord[key])),
    );
  }
  return Object.is(value, expected);
}

function hasExactExtraKeys(extra: Record<string, unknown>): boolean {
  const expected = [
    "capability_id",
    "capability_version",
    "facilitator",
    "feePayer",
    "output_schema",
    "spend_limit",
    "symbols",
  ];
  return isStrictArray(Object.keys(extra).sort(), expected);
}

function requireCapabilityExtra(extra: Record<string, unknown> | undefined): void {
  if (!extra || extra.capability_id !== P1A_CAPABILITY_ID || extra.capability_version !== P1A_CAPABILITY_VERSION) {
    throw new BridgePolicyError("capability_mismatch");
  }
  if (!hasExactExtraKeys(extra) || !isSolanaPublicKey(extra.feePayer)) {
    throw new BridgePolicyError("payment_extra_mismatch");
  }
  if (!isStrictArray(extra.output_schema, P1A_OUTPUT_SCHEMA)) {
    throw new BridgePolicyError("output_schema_mismatch");
  }
  if (extra.facilitator !== P1A_FACILITATOR) {
    throw new BridgePolicyError("facilitator_mismatch");
  }
  if (!isStrictArray(extra.symbols, P1A_SYMBOLS)) {
    throw new BridgePolicyError("symbol_scope_mismatch");
  }
  const spend = asRecord(extra.spend_limit);
  if (
    !spend
    || !hasExactKeys(spend, ["per_payment_atomic", "session_max_atomic", "session_max_payments"])
    || spend.per_payment_atomic !== P1A_AMOUNT_ATOMIC
    || spend.session_max_atomic !== P1A_SESSION_MAX_ATOMIC
    || spend.session_max_payments !== 3
  ) {
    throw new BridgePolicyError("spend_limit_mismatch");
  }
}

function requireFixedPaymentIdentifierExtension(extensions: Record<string, unknown> | undefined): void {
  if (!extensions || !hasExactKeys(extensions, [PAYMENT_IDENTIFIER])) {
    throw new BridgePolicyError("payment_extension_mismatch");
  }
  if (!isExactData(extensions[PAYMENT_IDENTIFIER], paymentIdentifierDeclaration)) {
    throw new BridgePolicyError("payment_identifier_required");
  }
}

function requireLoopbackResource(value: string, config: BridgeConfig): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BridgePolicyError("resource_url_invalid");
  }
  if (
    url.protocol !== "http:"
    || !isLoopbackHost(url.hostname)
    || url.username
    || url.password
    || url.href !== config.endpoint
  ) {
    throw new BridgePolicyError("resource_url_not_allowlisted");
  }
}

/** Reject the entire challenge unless every advertised option is the one P1a option. */
export function assertAllowedPaymentRequired(
  paymentRequired: PaymentRequired,
  config: BridgeConfig,
): PaymentRequirements {
  if (paymentRequired.x402Version !== 2) throw new BridgePolicyError("x402_version_mismatch");
  const resource = asRecord(paymentRequired.resource);
  if (!resource || !hasExactKeys(resource, ["url", "mimeType", "description"])) {
    throw new BridgePolicyError("resource_metadata_mismatch");
  }
  requireLoopbackResource(paymentRequired.resource.url, config);
  if (
    paymentRequired.resource.mimeType !== "application/json"
    || paymentRequired.resource.description !== P1A_RESOURCE_DESCRIPTION
  ) {
    throw new BridgePolicyError("resource_metadata_mismatch");
  }
  if (paymentRequired.accepts.length !== 1) throw new BridgePolicyError("payment_option_count_mismatch");

  const requirement = paymentRequired.accepts[0];
  if (!hasExactKeys(requirement as unknown as Record<string, unknown>, [
    "scheme",
    "network",
    "asset",
    "amount",
    "payTo",
    "maxTimeoutSeconds",
    "extra",
  ])) {
    throw new BridgePolicyError("payment_requirement_mismatch");
  }
  if (
    requirement.scheme !== "exact"
    || requirement.network !== P1A_NETWORK
    || requirement.asset !== P1A_ASSET
    || requirement.amount !== P1A_AMOUNT_ATOMIC
    || requirement.payTo !== config.payTo
    || requirement.maxTimeoutSeconds !== 300
  ) {
    throw new BridgePolicyError("payment_requirement_mismatch");
  }
  requireCapabilityExtra(requirement.extra);
  requireFixedPaymentIdentifierExtension(paymentRequired.extensions);
  return requirement;
}

export function redactedDiagnostic(value: unknown): string {
  const text = String(value);
  return text
    .replace(/payment-signature\s*[:=]\s*[^\s,]+/gi, "payment-signature=[redacted]")
    .replace(/payment-required\s*[:=]\s*[^\s,]+/gi, "payment-required=[redacted]");
}
