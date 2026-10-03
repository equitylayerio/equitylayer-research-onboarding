import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { P1A_AMOUNT_ATOMIC, P1A_ASSET, P1A_NETWORK, P1A_SYMBOLS, TOOL_NAME } from "./policy.js";

export const HISTORICAL_TRANSACTION = "XUZFjtxNd8Zyxcs3f5nx3TZ6yncVQXHma1qAvJsDPKw7dTPRnbuW2nBSPJzNX3Gzuv3JnAeVfSScJPDabemgj67";
const SELLER = "269BifgYuikBEby13nG7CB3sfCEUjLwyxpuY3PmLXw6P";
const BUYER = "63SLWtHaXHFK4yFN85x6Y5MsD4VDoFMZ98Sk4yFF7JP1";
const HASH = "804c1ac2c528d63da6757f04034397858c907991c3c3cc368aa27ca57313af76";
const TASK = "elr_0254ff72-de64-495b-a279-deee4af088e5";
const RECEIPT = "8388ae53-7a19-41ed-a571-dd928a7ff74a";
const settlement = z.object({ success: z.literal(true), transaction_reference: z.literal(HISTORICAL_TRANSACTION), network: z.literal(P1A_NETWORK) });
const proofSchema = z.object({
  schema_version: z.literal("1.0"),
  kind: z.literal("equitylayer_x402_devnet_payment_proof"),
  environment: z.literal("solana_devnet_local_only"),
  approval: z.object({ required: z.literal(true), approved_at: z.string().datetime() }),
  payment_challenge: z.object({
    x402_version: z.literal(2),
    requirement: z.object({ network: z.literal(P1A_NETWORK), asset: z.literal(P1A_ASSET), amount_atomic: z.literal(P1A_AMOUNT_ATOMIC), pay_to: z.literal(SELLER) }),
  }),
  payment_response: settlement,
  delivery: z.object({
    task_id: z.literal(TASK),
    input_scope: z.object({ symbols: z.array(z.string()) }),
    research_pack: z.object({ report_period: z.literal("2026-08"), prior_as_of: z.literal("2026-06") }),
    output_hash: z.literal(HASH),
    receipt: z.object({ receipt_id: z.literal(RECEIPT), status: z.literal("settled"), transaction_reference: z.literal(HISTORICAL_TRANSACTION) }),
  }),
  duplicate_delivery: z.object({ status: z.literal(200), matched_original: z.literal(true), payment_response: settlement,
    task_id: z.literal(TASK), output_hash: z.literal(HASH), receipt_id: z.literal(RECEIPT), transaction_reference: z.literal(HISTORICAL_TRANSACTION) }),
});

export function checkHistoricalProof(value: unknown): void {
  const proof = proofSchema.parse(value);
  assert.deepEqual(proof.delivery.input_scope.symbols, [...P1A_SYMBOLS], "The historical scope does not match.");
}

const tokenBalance = z.object({ accountIndex: z.number().int().nonnegative(), owner: z.string(), mint: z.string(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/), decimals: z.number().int() }) });
const chainTransaction = z.object({
  slot: z.number().int().positive(),
  transaction: z.object({ signatures: z.array(z.string()) }),
  meta: z.object({ err: z.null(), preTokenBalances: z.array(tokenBalance), postTokenBalances: z.array(tokenBalance) }),
});

export function checkChainTransaction(value: unknown): void {
  const tx = chainTransaction.parse(value);
  assert.equal(tx.transaction.signatures[0], HISTORICAL_TRANSACTION, "The transaction does not match.");
  for (const [owner, expected] of [[BUYER, -50000n], [SELLER, 50000n]] as const) {
    const before = tx.meta.preTokenBalances.filter((b) => b.owner === owner && b.mint === P1A_ASSET);
    const after = tx.meta.postTokenBalances.filter((b) => b.owner === owner && b.mint === P1A_ASSET);
    assert.equal(before.length, 1, "The historical source balance is missing or ambiguous.");
    assert.equal(after.length, 1, "The historical destination balance is missing or ambiguous.");
    assert.equal(before[0].accountIndex, after[0].accountIndex, "The token account does not match.");
    assert.equal(before[0].uiTokenAmount.decimals, 6, "The token decimals do not match.");
    assert.equal(after[0].uiTokenAmount.decimals, 6, "The token decimals do not match.");
    assert.equal(BigInt(after[0].uiTokenAmount.amount) - BigInt(before[0].uiTokenAmount.amount), expected, "The token balance change does not match.");
  }
}

// This function permits only read requests to the fixed Devnet RPC endpoint.
export async function checkHistoricalChain(fetchImpl: typeof fetch = fetch): Promise<void> {
  async function rpc(method: string, params: unknown[]) {
    const response = await fetchImpl("https://api.devnet.solana.com", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert(response.ok, "The Devnet RPC request failed. No payment was made.");
    const body = z.object({ jsonrpc: z.literal("2.0"), id: z.literal(1), result: z.unknown(), error: z.unknown().optional() }).parse(await response.json());
    assert(!body.error && body.result !== undefined && body.result !== null, "The Devnet RPC result is unavailable. No payment was made.");
    return body.result;
  }
  assert.equal(await rpc("getGenesisHash", []), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "The RPC network is not Devnet.");
  const status = z.object({ value: z.tuple([z.object({ err: z.null(), confirmationStatus: z.literal("finalized") })]) });
  status.parse(await rpc("getSignatureStatuses", [[HISTORICAL_TRANSACTION], { searchTransactionHistory: true }]));
  checkChainTransaction(await rpc("getTransaction", [HISTORICAL_TRANSACTION, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]));
}

export async function checkMcpDiscovery(): Promise<string[]> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("index.ts", import.meta.url))],
    cwd: root,
    env: { X402_P1A_LOCAL_MODE: "true", X402_DEVNET_PAY_TO: SELLER, X402_P1A_LOCAL_AUTH_TOKEN: "judge_read_only_placeholder_not_a_secret" },
    stderr: "ignore",
  });
  const client = new Client({ name: "equitylayer-read-only-judge", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const result = await client.listTools(undefined, { timeout: 10_000 });
    const names = result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [TOOL_NAME], "The MCP tool list does not match.");
    return names;
  } finally {
    await client.close();
    await transport.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === "--chain"), "Use no argument, or use --chain.");
  const proof = JSON.parse(await readFile(new URL("../../../docs/evidence/2026-10-03-x402-devnet-payment-proof.json", import.meta.url), "utf8"));
  checkHistoricalProof(proof);
  console.log("PASS: Historical proof metadata matches the retained transaction and delivery identifiers.");
  console.log(`PASS: MCP initialization and tool discovery: ${(await checkMcpDiscovery()).join(", ")}`);
  if (args.includes("--chain")) {
    await checkHistoricalChain();
    console.log("PASS: Devnet transaction finalized. Buyer: -0.05 USDC. Seller: +0.05 USDC.");
  } else {
    console.log("SKIP: Live Devnet verification. Use --chain to read the existing transaction.");
  }
  console.log("No purchase tool was called. No wallet was loaded. No transaction was submitted.");
  console.log("The public proof contains metadata only. This check cannot recompute the complete research output hash.");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch(() => {
    console.error("FAIL: The judge check did not pass. Check the proof, MCP dependencies, and Devnet RPC availability. No payment was made.");
    process.exitCode = 1;
  });
}
