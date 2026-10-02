import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";

import { createApprovalRequest, type ApprovalRequest } from "./approval-server.js";
import {
  BridgeExecutionError,
  executeP1aRequest,
  SpendSession,
  type BridgeExecutionDependencies,
} from "./index.js";
import {
  bridgeConfigFromEnv,
  BridgePolicyError,
  P1A_CAPABILITY_ID,
  P1A_CAPABILITY_VERSION,
  P1A_LOCAL_AUTH_HEADER,
  P1A_NETWORK,
  P1A_SOURCE_URL,
  P1A_SYMBOLS,
} from "./policy.js";
import { localSignerFromEnv, SignerUnavailableError, type LocalSigner } from "./signer.js";

const EXPLICIT_PAYMENT_APPROVAL = "I_APPROVE_ONE_DEVNET_P1A_PAYMENT";
const APPROVAL_TIMEOUT_MS = 60_000;

export type PaymentResponseEvidence = {
  success: true;
  transaction_reference: string;
  network: string;
};

export type DeliveryEvidence = {
  task_id: string;
  capability_id: typeof P1A_CAPABILITY_ID;
  capability_version: typeof P1A_CAPABILITY_VERSION;
  input_scope: {
    symbols: readonly (typeof P1A_SYMBOLS)[number][];
    baseline_period: string;
    source_url: typeof P1A_SOURCE_URL;
  };
  research_pack: {
    schema_version: string;
    pack_version: string;
    as_of: string;
    as_of_date: string;
    report_period: string;
    prior_as_of: string;
    prior_as_of_date: string;
    source: {
      api_url: typeof P1A_SOURCE_URL;
      snapshot_hash: string;
      evidence_state: "official_source";
    };
  };
  output_hash: string;
  receipt: {
    receipt_id: string;
    status: "settled";
    transaction_reference: string;
    settled_at: string;
  };
};

export type DuplicateDeliveryEvidence = {
  status: 200;
  matched_original: true;
  payment_response: PaymentResponseEvidence;
  task_id: string;
  output_hash: string;
  receipt_id: string;
  transaction_reference: string;
};

type PaymentProofEvidence = {
  schema_version: "1.0";
  kind: "equitylayer_x402_devnet_payment_proof";
  executed_at: string;
  environment: "solana_devnet_local_only";
  approval: { required: true; approved_at: string };
  payment_challenge: Record<string, unknown> | null;
  payment_response: PaymentResponseEvidence;
  delivery: DeliveryEvidence;
  duplicate_delivery: DuplicateDeliveryEvidence;
};

export class DevnetPaymentSmokeError extends Error {
  constructor(readonly code:
    | "devnet_payment_approval_required"
    | "payment_challenge_capture_failed"
    | "payment_response_capture_failed"
    | "payment_response_delivery_mismatch"
    | "delivery_record_invalid"
    | "duplicate_delivery_check_failed") {
    super(code);
    this.name = "DevnetPaymentSmokeError";
  }
}

/** Do not make a payment unless the operator provides this exact approval value. */
export function requireExplicitDevnetPaymentApproval(env: NodeJS.ProcessEnv = process.env): void {
  if (env.X402_DEVNET_SMOKE_APPROVED !== EXPLICIT_PAYMENT_APPROVAL) {
    throw new DevnetPaymentSmokeError("devnet_payment_approval_required");
  }
}

function recordedChallenge(paymentRequired: PaymentRequired): Record<string, unknown> {
  const requirement = paymentRequired.accepts[0];
  const extra = requirement?.extra as Record<string, unknown> | undefined;
  const spendLimit = extra?.spend_limit as Record<string, unknown> | undefined;
  const identifier = paymentRequired.extensions?.["payment-identifier"] as {
    info?: { required?: unknown };
  } | undefined;

  return {
    x402_version: paymentRequired.x402Version,
    resource: {
      url: paymentRequired.resource.url,
      mime_type: paymentRequired.resource.mimeType,
      description: paymentRequired.resource.description,
    },
    requirement: {
      scheme: requirement?.scheme,
      network: requirement?.network,
      asset: requirement?.asset,
      amount_atomic: requirement?.amount,
      pay_to: requirement?.payTo,
      max_timeout_seconds: requirement?.maxTimeoutSeconds,
      capability_id: extra?.capability_id,
      capability_version: extra?.capability_version,
      output_schema: extra?.output_schema,
      spend_limit: spendLimit,
      symbols: extra?.symbols,
    },
    payment_identifier_required: identifier?.info?.required === true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requiredString(value: unknown): string {
  if (!nonEmptyString(value)) throw new DevnetPaymentSmokeError("delivery_record_invalid");
  return value;
}

function hasFixedSymbols(value: unknown): value is readonly (typeof P1A_SYMBOLS)[number][] {
  return Array.isArray(value)
    && value.length === P1A_SYMBOLS.length
    && value.every((symbol, index) => symbol === P1A_SYMBOLS[index]);
}

/** Keep only the proof fields that the published P1a contract permits. */
export function recordedDelivery(value: unknown): DeliveryEvidence {
  const result = asRecord(value);
  const inputScope = asRecord(result?.input_scope);
  const pack = asRecord(result?.research_pack);
  const source = asRecord(pack?.source);
  const receipt = asRecord(result?.receipt);
  if (
    !result
    || result.capability_id !== P1A_CAPABILITY_ID
    || result.capability_version !== P1A_CAPABILITY_VERSION
    || !inputScope
    || !hasFixedSymbols(inputScope.symbols)
    || inputScope.source_url !== P1A_SOURCE_URL
    || !nonEmptyString(inputScope.baseline_period)
    || !pack
    || !source
    || source.api_url !== P1A_SOURCE_URL
    || source.evidence_state !== "official_source"
    || !receipt
    || receipt.status !== "settled"
  ) {
    throw new DevnetPaymentSmokeError("delivery_record_invalid");
  }

  return {
    task_id: requiredString(result.task_id),
    capability_id: P1A_CAPABILITY_ID,
    capability_version: P1A_CAPABILITY_VERSION,
    input_scope: {
      symbols: [...P1A_SYMBOLS],
      baseline_period: requiredString(inputScope.baseline_period),
      source_url: P1A_SOURCE_URL,
    },
    research_pack: {
      schema_version: requiredString(pack.schema_version),
      pack_version: requiredString(pack.pack_version),
      as_of: requiredString(pack.as_of),
      as_of_date: requiredString(pack.as_of_date),
      report_period: requiredString(pack.report_period),
      prior_as_of: requiredString(pack.prior_as_of),
      prior_as_of_date: requiredString(pack.prior_as_of_date),
      source: {
        api_url: P1A_SOURCE_URL,
        snapshot_hash: requiredString(source.snapshot_hash),
        evidence_state: "official_source",
      },
    },
    output_hash: requiredString(result.output_hash),
    receipt: {
      receipt_id: requiredString(receipt.receipt_id),
      status: "settled",
      transaction_reference: requiredString(receipt.transaction_reference),
      settled_at: requiredString(receipt.settled_at),
    },
  };
}

export function recordedPaymentResponse(header: string | null): PaymentResponseEvidence {
  if (!header) throw new DevnetPaymentSmokeError("payment_response_capture_failed");
  try {
    const response = decodePaymentResponseHeader(header);
    if (!response.success || response.network !== P1A_NETWORK || !nonEmptyString(response.transaction)) {
      throw new DevnetPaymentSmokeError("payment_response_capture_failed");
    }
    return {
      success: true,
      transaction_reference: response.transaction,
      network: response.network,
    };
  } catch (error) {
    if (error instanceof DevnetPaymentSmokeError) throw error;
    throw new DevnetPaymentSmokeError("payment_response_capture_failed");
  }
}

export function requireMatchedPaymentResponse(
  delivery: DeliveryEvidence,
  paymentResponse: PaymentResponseEvidence,
): void {
  if (paymentResponse.transaction_reference !== delivery.receipt.transaction_reference) {
    throw new DevnetPaymentSmokeError("payment_response_delivery_mismatch");
  }
}

export async function recordedDuplicateDelivery(
  original: DeliveryEvidence,
  response: Response,
): Promise<DuplicateDeliveryEvidence> {
  if (response.status !== 200) throw new DevnetPaymentSmokeError("duplicate_delivery_check_failed");
  const paymentResponse = recordedPaymentResponse(response.headers.get("payment-response"));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DevnetPaymentSmokeError("duplicate_delivery_check_failed");
  }
  const duplicate = recordedDelivery(body);
  if (
    duplicate.task_id !== original.task_id
    || duplicate.output_hash !== original.output_hash
    || duplicate.receipt.receipt_id !== original.receipt.receipt_id
    || duplicate.receipt.transaction_reference !== original.receipt.transaction_reference
    || paymentResponse.transaction_reference !== original.receipt.transaction_reference
  ) {
    throw new DevnetPaymentSmokeError("duplicate_delivery_check_failed");
  }
  return {
    status: 200,
    matched_original: true,
    payment_response: paymentResponse,
    task_id: duplicate.task_id,
    output_hash: duplicate.output_hash,
    receipt_id: duplicate.receipt.receipt_id,
    transaction_reference: duplicate.receipt.transaction_reference,
  };
}

function evidencePath(executedAt: Date): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(sourceDirectory, "../../..");
  const stamp = executedAt.toISOString().replace(/[:.]/g, "-");
  return resolve(repositoryRoot, "content", "launch", "evidence", `${stamp}-x402-devnet-payment-proof.json`);
}

async function writeEvidence(evidence: PaymentProofEvidence, executedAt: Date): Promise<string> {
  const path = evidencePath(executedAt);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof DevnetPaymentSmokeError
    || error instanceof BridgeExecutionError
    || error instanceof BridgePolicyError
    || error instanceof SignerUnavailableError
  ) {
    return error.code;
  }
  return "devnet_payment_smoke_failed";
}

/**
 * Run one approved P1a payment through the same bridge code that an MCP host
 * uses. The resource server and isolated signer must already run on loopback.
 * This function does not create or fund a wallet.
 */
export async function runApprovedDevnetPaymentSmoke(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ evidencePath: string; delivery: DeliveryEvidence }> {
  requireExplicitDevnetPaymentApproval(env);

  const config = bridgeConfigFromEnv(env);
  const externalSigner = localSignerFromEnv(env);
  let paymentSignature: string | null = null;
  const signer: LocalSigner = {
    async signPayment(request) {
      const signed = await externalSigner.signPayment(request);
      paymentSignature = signed.paymentSignature;
      return signed;
    },
  };
  let observedChallenge: Record<string, unknown> | null = null;
  let paymentResponseHeader: string | null = null;
  let approvalAt: string | null = null;
  const fetchImpl: BridgeExecutionDependencies["fetchImpl"] = async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 402) {
      const header = response.headers.get("payment-required");
      if (!header) throw new DevnetPaymentSmokeError("payment_challenge_capture_failed");
      try {
        observedChallenge = recordedChallenge(decodePaymentRequiredHeader(header));
      } catch {
        throw new DevnetPaymentSmokeError("payment_challenge_capture_failed");
      }
    }
    if (response.ok) {
      paymentResponseHeader = response.headers.get("payment-response");
    }
    return response;
  };
  const approvalFactory: BridgeExecutionDependencies["approvalFactory"] = async (details): Promise<ApprovalRequest> => {
    const approval = await createApprovalRequest(details, { timeoutMs: APPROVAL_TIMEOUT_MS });
    return {
      ...approval,
      async waitForDecision() {
        const approved = await approval.waitForDecision();
        if (approved) approvalAt = new Date().toISOString();
        return approved;
      },
    };
  };

  const result = await executeP1aRequest({
    config,
    signer,
    fetchImpl,
    approvalFactory,
    session: new SpendSession(),
    stderr: process.stderr,
  });
  if (!observedChallenge || !approvalAt) {
    throw new DevnetPaymentSmokeError("payment_challenge_capture_failed");
  }
  if (!paymentSignature) {
    throw new DevnetPaymentSmokeError("payment_response_capture_failed");
  }

  const delivery = recordedDelivery(result);
  const paymentResponse = recordedPaymentResponse(paymentResponseHeader);
  requireMatchedPaymentResponse(delivery, paymentResponse);
  const duplicateResponse = await fetch(config.endpoint, {
    method: "GET",
    headers: {
      accept: "application/json",
      [P1A_LOCAL_AUTH_HEADER]: config.localAuthToken,
      "payment-signature": paymentSignature,
    },
  });
  const duplicateDelivery = await recordedDuplicateDelivery(delivery, duplicateResponse);

  const executedAt = new Date();
  const evidence: PaymentProofEvidence = {
    schema_version: "1.0",
    kind: "equitylayer_x402_devnet_payment_proof",
    executed_at: executedAt.toISOString(),
    environment: "solana_devnet_local_only",
    approval: { required: true, approved_at: approvalAt },
    payment_challenge: observedChallenge,
    payment_response: paymentResponse,
    delivery,
    duplicate_delivery: duplicateDelivery,
  };
  const savedEvidencePath = await writeEvidence(evidence, executedAt);
  return { evidencePath: savedEvidencePath, delivery };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  void runApprovedDevnetPaymentSmoke().then(({ evidencePath, delivery }) => {
    process.stdout.write(`${JSON.stringify({
      status: "settled",
      task_id: delivery.task_id,
      output_hash: delivery.output_hash,
      transaction_reference: delivery.receipt.transaction_reference,
      evidence_path: evidencePath,
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${safeErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
