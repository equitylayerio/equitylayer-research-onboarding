import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { generatePaymentId } from "@x402/extensions/payment-identifier";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createApprovalRequest, type ApprovalRequest } from "./approval-server.js";
import { publishLocalDeliveryFromEnv } from "./delivery-inbox.js";
import { hasMatchingDeliveryIntegrity } from "./delivery-integrity.js";
import {
  assertAllowedPaymentRequired,
  bridgeConfigFromEnv,
  BridgePolicyError,
  P1A_AMOUNT_ATOMIC,
  P1A_ASSET,
  P1A_BASELINE_PERIOD,
  P1A_CAPABILITY_ID,
  P1A_CAPABILITY_VERSION,
  P1A_LOCAL_AUTH_HEADER,
  P1A_NETWORK,
  P1A_SOURCE_URL,
  P1A_SESSION_MAX_ATOMIC,
  P1A_SYMBOLS,
  redactedDiagnostic,
  TOOL_NAME,
  type BridgeConfig,
} from "./policy.js";
import { localSignerFromEnv, SignerUnavailableError, type LocalSigner } from "./signer.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ApprovalFactory = (details: Parameters<typeof createApprovalRequest>[0]) => Promise<ApprovalRequest>;

export class BridgeExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BridgeExecutionError";
  }
}

export class SpendSession {
  private payments = 0;
  private atomic = 0n;
  private pendingIdentifier: string | null = null;

  pendingPaymentIdentifier(): string | null { return this.pendingIdentifier; }
  markDeliveryPending(identifier: string): void {
    if (this.pendingIdentifier) throw new BridgeExecutionError("previous_payment_requires_review");
    this.pendingIdentifier = identifier;
  }
  clearPendingPayment(identifier: string): void {
    if (this.pendingIdentifier === identifier) this.pendingIdentifier = null;
  }

  summary(): { payments: number; atomic: string } {
    return { payments: this.payments, atomic: this.atomic.toString() };
  }

  recordOneApprovedPayment(): void {
    if (this.pendingIdentifier) throw new BridgeExecutionError("previous_payment_requires_review");
    const amount = BigInt(P1A_AMOUNT_ATOMIC);
    if (this.payments >= 3 || this.atomic + amount > BigInt(P1A_SESSION_MAX_ATOMIC)) {
      throw new BridgeExecutionError("session_spend_limit_reached");
    }
    this.payments += 1;
    this.atomic += amount;
  }
}

export type BridgeExecutionDependencies = {
  config: BridgeConfig;
  signer: LocalSigner;
  fetchImpl: FetchLike;
  approvalFactory: ApprovalFactory;
  session: SpendSession;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

function toolError(error: unknown): BridgeExecutionError {
  if (error instanceof BridgeExecutionError) return error;
  if (error instanceof BridgePolicyError) return new BridgeExecutionError(error.code);
  if (error instanceof SignerUnavailableError) return new BridgeExecutionError(error.code);
  return new BridgeExecutionError("payment_request_failed");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStrictArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function isFixedInputScope(value: unknown): boolean {
  const scope = recordValue(value);
  return Boolean(
    scope
    && isStrictArray(scope.symbols, P1A_SYMBOLS)
    && scope.baseline_period === P1A_BASELINE_PERIOD
    && scope.source_url === P1A_SOURCE_URL,
  );
}

function hasCompleteEvidenceLayers(value: unknown): boolean {
  const layers = recordValue(value);
  if (!layers) return false;

  const reportedFacts = recordValue(layers.reported_facts);
  const managementClaims = recordValue(layers.management_claims);
  const inferences = recordValue(layers.inferences);
  const unknowns = recordValue(layers.unknowns);

  return Boolean(
    reportedFacts
    && isStrictArray(reportedFacts.fields, ["monthly_revenue", "changes"])
    && reportedFacts.source === P1A_SOURCE_URL
    && nonEmptyString(reportedFacts.scope_note)
    && managementClaims
    && isStrictArray(managementClaims.fields, ["issuer_note"])
    && Array.isArray(managementClaims.items)
    && nonEmptyString(managementClaims.scope_note)
    && inferences
    && Array.isArray(inferences.items)
    && inferences.items.length > 0
    && nonEmptyString(inferences.scope_note)
    && unknowns
    && isStrictArray(unknowns.fields, ["unknowns"])
    && nonEmptyString(unknowns.scope_note),
  );
}

function hasFixedCompanyRows(value: unknown, fields: readonly string[], isChange = false): boolean {
  if (!Array.isArray(value) || value.length !== P1A_SYMBOLS.length) return false;
  const symbols = value.map(row => recordValue(row)?.symbol);
  if (!P1A_SYMBOLS.every(symbol => symbols.filter(value => value === symbol).length === 1)) return false;
  return value.every(value => {
    const row = recordValue(value)!;
    if (!nonEmptyString(row.company_name)) return false;
    if (!fields.every(field => typeof row[field] === "number" && Number.isFinite(row[field]))) return false;
    return isChange
      ? row.revenue_delta_pct === null || (typeof row.revenue_delta_pct === "number" && Number.isFinite(row.revenue_delta_pct))
      : row.company_code === String(row.symbol).split(".")[0];
  });
}

function isCompleteResearchPack(value: unknown): boolean {
  const pack = recordValue(value);
  if (!pack) return false;

  const requiredStrings = [
    "schema_version",
    "pack_version",
    "as_of",
    "as_of_date",
    "report_period",
    "prior_as_of",
    "prior_as_of_date",
    "falsifier",
    "next_trigger",
  ];
  if (!requiredStrings.every((field) => nonEmptyString(pack[field]))) return false;
  if (!hasFixedCompanyRows(pack.records, ["revenue_thousand_twd", "previous_month_revenue_thousand_twd",
    "previous_year_revenue_thousand_twd", "mom_pct", "yoy_pct", "ytd_revenue_thousand_twd",
    "previous_ytd_revenue_thousand_twd", "ytd_yoy_pct"])) return false;
  if (!hasFixedCompanyRows(pack.changes, ["revenue_delta_thousand_twd", "current_mom_pct", "current_yoy_pct"], true)) return false;
  if (!Array.isArray(pack.unknowns)) return false;
  const source = recordValue(pack.source);
  const readthrough = recordValue(pack.research_readthrough);
  if (!source || source.api_url !== P1A_SOURCE_URL || source.evidence_state !== "official_source") return false;
  if (!hasCompleteEvidenceLayers(pack.evidence_layers) || !Array.isArray(pack.public_claims)) return false;
  if (
    !readthrough
    || readthrough.generation !== "deterministic"
    || readthrough.review_status !== "not_human_reviewed"
    || !nonEmptyString(readthrough.summary)
    || !nonEmptyString(readthrough.impact_path)
    || !Array.isArray(readthrough.what_it_supports)
    || !Array.isArray(readthrough.what_it_does_not_prove)
    || !nonEmptyString(readthrough.falsifier)
    || !nonEmptyString(readthrough.next_trigger)
  ) return false;
  return true;
}

function hasSettledReceipt(value: unknown): boolean {
  const receipt = recordValue(value);
  return Boolean(
    receipt
    && receipt.status === "settled"
    && nonEmptyString(receipt.receipt_id)
    && nonEmptyString(receipt.transaction_reference)
    && nonEmptyString(receipt.settled_at),
  );
}

function validateDelivery(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new BridgeExecutionError("delivery_body_invalid");
  const result = value as Record<string, unknown>;
  if (
    !nonEmptyString(result.task_id)
    || !/^[a-f0-9]{64}$/.test(String(result.output_hash))
    || result.capability_id !== P1A_CAPABILITY_ID
    || result.capability_version !== P1A_CAPABILITY_VERSION
    || !isFixedInputScope(result.input_scope)
    || !isCompleteResearchPack(result.research_pack)
    || !hasSettledReceipt(result.receipt)
  ) {
    throw new BridgeExecutionError("delivery_result_invalid");
  }
  return result;
}

/**
 * Execute exactly one fixed P1a request. There is no arbitrary endpoint, price,
 * ticker, or payment choice exposed to the MCP host or its model.
 */
export async function executeP1aRequest(dependencies: BridgeExecutionDependencies): Promise<Record<string, unknown>> {
  if (dependencies.session.pendingPaymentIdentifier()) throw new BridgeExecutionError("previous_payment_requires_review");
  const initial = await dependencies.fetchImpl(dependencies.config.endpoint, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: "application/json",
      [P1A_LOCAL_AUTH_HEADER]: dependencies.config.localAuthToken,
    },
  });
  if (initial.status !== 402) throw new BridgeExecutionError("payment_challenge_missing");
  const paymentRequiredHeader = initial.headers.get("payment-required");
  if (!paymentRequiredHeader) throw new BridgeExecutionError("payment_required_header_missing");

  let paymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
  } catch {
    throw new BridgeExecutionError("payment_required_header_invalid");
  }
  assertAllowedPaymentRequired(paymentRequired, dependencies.config);

  const session = dependencies.session.summary();
  const approval = await dependencies.approvalFactory({
    toolName: TOOL_NAME,
    endpoint: dependencies.config.endpoint,
    priceAtomic: P1A_AMOUNT_ATOMIC,
    asset: P1A_ASSET,
    network: P1A_NETWORK,
    payTo: dependencies.config.payTo,
    capabilityVersion: P1A_CAPABILITY_VERSION,
    sessionSpendAtomic: session.atomic,
  });
  dependencies.stderr.write(`Open the local approval page: ${approval.url}\n`);
  let approved: boolean;
  try {
    approved = await approval.waitForDecision();
  } finally {
    await approval.close();
  }
  if (!approved) throw new BridgeExecutionError("payment_not_approved");

  // Count an approved signing attempt before asking a signer. This is conservative
  // and prevents concurrent tool calls from exceeding the local session limit.
  dependencies.session.recordOneApprovedPayment();
  const paymentIdentifier = generatePaymentId("elr_");
  dependencies.session.markDeliveryPending(paymentIdentifier);
  let signed: { paymentSignature: string };
  try {
    signed = await dependencies.signer.signPayment({ paymentRequired, paymentIdentifier });
  } catch (error) {
    dependencies.session.clearPendingPayment(paymentIdentifier);
    if (error instanceof SignerUnavailableError) throw new BridgeExecutionError("signer_unavailable");
    throw new BridgeExecutionError("signer_failed");
  }
  if (!signed.paymentSignature || typeof signed.paymentSignature !== "string") {
    dependencies.session.clearPendingPayment(paymentIdentifier);
    throw new BridgeExecutionError("signer_response_invalid");
  }

  // Verification, source refresh, and settlement each have a separate server deadline.
  // Retain the public identifier if delivery is uncertain. Do not authorize another payment in this session.
  const retry = await dependencies.fetchImpl(dependencies.config.endpoint, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: {
      accept: "application/json",
      [P1A_LOCAL_AUTH_HEADER]: dependencies.config.localAuthToken,
      "payment-signature": signed.paymentSignature,
    },
  });
  if (!retry.ok) throw new BridgeExecutionError(`payment_retry_failed_${retry.status}`);
  const responseHeader = retry.headers.get("payment-response");
  if (!responseHeader) throw new BridgeExecutionError("payment_response_missing");
  let transaction: string;
  try {
    const settlement = decodePaymentResponseHeader(responseHeader);
    if (!settlement.success) throw new BridgeExecutionError("payment_settlement_failed");
    if (settlement.network !== P1A_NETWORK || !settlement.transaction) {
      throw new BridgeExecutionError("payment_response_mismatch");
    }
    transaction = settlement.transaction;
  } catch (error) {
    if (error instanceof BridgeExecutionError) throw error;
    throw new BridgeExecutionError("payment_response_invalid");
  }
  const result = validateDelivery(await retry.json());
  if (!hasMatchingDeliveryIntegrity(result, transaction)) throw new BridgeExecutionError("delivery_integrity_mismatch");
  dependencies.session.clearPendingPayment(paymentIdentifier);
  return result;
}

export async function publishOptionalLocalDelivery(
  result: Record<string, unknown>,
  publish: (delivery: Record<string, unknown>) => Promise<boolean> = publishLocalDeliveryFromEnv,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): Promise<Record<string, unknown>> {
  try {
    await publish(result);
  } catch {
    // The payment has settled. Do not hide the validated result when the
    // optional local Dashboard inbox is unavailable.
    stderr.write("local_delivery_inbox_write_failed\n");
  }
  return result;
}

export async function runBridge(): Promise<void> {
  const config = bridgeConfigFromEnv();
  const dependencies: BridgeExecutionDependencies = {
    config,
    signer: localSignerFromEnv(),
    fetchImpl: fetch,
    approvalFactory: (details) => createApprovalRequest(details),
    session: new SpendSession(),
    stderr: process.stderr,
  };
  const server = new McpServer({ name: "equitylayer-x402-p1a-bridge", version: "0.1.0" });
  server.tool(
    TOOL_NAME,
    "Request the fixed local EquityLayer P1a Taiwan monthly-revenue monitor. A human must approve every Devnet payment.",
    async () => {
      try {
        const result = await executeP1aRequest(dependencies);
        const delivered = await publishOptionalLocalDelivery(result);
        return { content: [{ type: "text", text: JSON.stringify(delivered) }] };
      } catch (error) {
        const normalized = toolError(error);
        process.stderr.write(`${redactedDiagnostic(normalized.code)}\n`);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: normalized.code,
            ...(dependencies.session.pendingPaymentIdentifier() ? {
              payment_identifier: dependencies.session.pendingPaymentIdentifier(),
              delivery_status: "unconfirmed",
              next_action: "Check the seller receipt before you authorize another payment. Do not restart to repeat the purchase.",
            } : {}),
          }) }],
        };
      }
    },
  );
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  void runBridge().catch((error) => {
    process.stderr.write(`${redactedDiagnostic(error instanceof Error ? error.message : "bridge_start_failed")}\n`);
    process.exitCode = 1;
  });
}
