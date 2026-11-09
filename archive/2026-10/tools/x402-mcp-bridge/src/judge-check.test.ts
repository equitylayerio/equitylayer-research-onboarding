import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { checkChainTransaction, checkHistoricalChain, checkHistoricalProof, checkMcpDiscovery, checkMcpProof, HISTORICAL_TRANSACTION, MCP_TRANSACTION } from "./judge-check.js";
import { P1A_ASSET, TOOL_NAME } from "./policy.js";

const proof = JSON.parse(await readFile(new URL("../../../docs/evidence/2026-10-03-x402-devnet-payment-proof.json", import.meta.url), "utf8"));
const mcpProof = JSON.parse(await readFile(new URL("../../../docs/evidence/2026-10-03-mcp-devnet-payment-proof.json", import.meta.url), "utf8"));
const owners = ["63SLWtHaXHFK4yFN85x6Y5MsD4VDoFMZ98Sk4yFF7JP1", "269BifgYuikBEby13nG7CB3sfCEUjLwyxpuY3PmLXw6P"];
function transaction() {
  const balances = (amounts: string[]) => owners.map((owner, accountIndex) => ({ owner, accountIndex, mint: P1A_ASSET, uiTokenAmount: { amount: amounts[accountIndex], decimals: 6 } }));
  return { slot: 506815848, transaction: { signatures: [HISTORICAL_TRANSACTION] }, meta: {
    err: null as unknown, preTokenBalances: balances(["20000000", "20000000"]), postTokenBalances: balances(["19950000", "20050000"]),
  } };
}

describe("historical proof", () => {
  it("accepts the retained proof", () => expect(() => checkHistoricalProof(proof)).not.toThrow());
  it.each(["amount", "seller", "transaction", "scope", "hash", "duplicate", "missing"]) ("rejects a %s mismatch", (field) => {
    const changed = structuredClone(proof);
    if (field === "amount") changed.payment_challenge.requirement.amount_atomic = "50001";
    if (field === "seller") changed.payment_challenge.requirement.pay_to = owners[0];
    if (field === "transaction") changed.payment_response.transaction_reference = "wrong";
    if (field === "scope") changed.delivery.input_scope.symbols.pop();
    if (field === "hash") changed.delivery.output_hash = "0".repeat(64);
    if (field === "duplicate") changed.duplicate_delivery.receipt_id = "different";
    if (field === "missing") delete changed.delivery;
    expect(() => checkHistoricalProof(changed)).toThrow();
  });
});

describe("MCP purchase proof", () => {
  it("accepts the retained MCP metadata", () => expect(() => checkMcpProof(mcpProof)).not.toThrow());
  it.each(["count", "tool", "transport", "receipt", "hash", "signature", "seller", "scope", "extra_call"])("rejects a %s mismatch", field => {
    const changed = structuredClone(mcpProof);
    if (field === "count") changed.protocol.calls = 2;
    if (field === "tool") changed.protocol.events[2].name = "wrong";
    if (field === "transport") changed.protocol.transport = "direct";
    if (field === "receipt") changed.delivery.receipt.receipt_id = "wrong";
    if (field === "hash") changed.protocol.events[4].output_hash = "0".repeat(64);
    if (field === "signature") changed.payment.transaction_reference = HISTORICAL_TRANSACTION;
    if (field === "seller") changed.payment.seller = "wrong";
    if (field === "scope") changed.delivery.input_scope.symbols.pop();
    if (field === "extra_call") changed.protocol.events.push(changed.protocol.events[2]);
    expect(() => checkMcpProof(changed)).toThrow();
  });
  it("verifies the selected MCP transaction instead of the older transaction", async () => {
    const tx = transaction();
    tx.transaction.signatures[0] = MCP_TRANSACTION;
    const results = ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", { value: [{ err: null, confirmationStatus: "finalized" }] }, tx];
    const request = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: results.shift() }));
    await checkHistoricalChain(request as typeof fetch, MCP_TRANSACTION);
    const calls = request.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[2][1].body)).params[0]).toBe(MCP_TRANSACTION);
    expect(() => checkChainTransaction(transaction(), MCP_TRANSACTION)).toThrow();
  });
});

describe("read-only chain verification", () => {
  it("accepts the expected balance changes", () => expect(() => checkChainTransaction(transaction())).not.toThrow());
  it.each(["signature", "error", "mint", "owner", "amount", "decimals", "account", "missing"]) ("rejects a %s mismatch", (field) => {
    const tx = transaction();
    if (field === "signature") tx.transaction.signatures[0] = "wrong";
    if (field === "error") tx.meta.err = { InstructionError: [0, "failed"] };
    if (field === "mint") tx.meta.postTokenBalances[1].mint = "wrong";
    if (field === "owner") tx.meta.postTokenBalances[1].owner = "wrong";
    if (field === "amount") tx.meta.postTokenBalances[1].uiTokenAmount.amount = "20000000";
    if (field === "decimals") tx.meta.postTokenBalances[1].uiTokenAmount.decimals = 9;
    if (field === "account") tx.meta.postTokenBalances[1].accountIndex = 42;
    if (field === "missing") tx.meta.preTokenBalances = [];
    expect(() => checkChainTransaction(tx)).toThrow();
  });
  it("sends only the three fixed read requests", async () => {
    const results = ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", { value: [{ err: null, confirmationStatus: "finalized" }] }, transaction()];
    const request = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: results.shift() }));
    await checkHistoricalChain(request as typeof fetch);
    const calls = request.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual(Array(3).fill("https://api.devnet.solana.com"));
    expect(calls.map(([, init]) => JSON.parse(String(init.body)).method)).toEqual(["getGenesisHash", "getSignatureStatuses", "getTransaction"]);
    expect(calls.every(([, init]) => init.redirect === "error" && init.signal)).toBe(true);
  });
  it.each(["rpc_error", "wrong_network", "missing", "http", "unfinalized"])("fails closed for %s", async (kind) => {
    let call = 0;
    const request = vi.fn(async () => {
      call++;
      if (kind === "http") return new Response("unavailable", { status: 503 });
      if (kind === "rpc_error") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -1 } });
      if (kind === "missing") return Response.json({ jsonrpc: "2.0", id: 1, result: null });
      const result = kind === "wrong_network" ? "mainnet" : call === 1 ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" : { value: [{ err: null, confirmationStatus: "confirmed" }] };
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    });
    await expect(checkHistoricalChain(request as typeof fetch)).rejects.toThrow();
    expect(request.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

it("initializes the real MCP server without calling the purchase tool", async () => {
  expect(await checkMcpDiscovery()).toEqual([TOOL_NAME]);
}, 20_000);
