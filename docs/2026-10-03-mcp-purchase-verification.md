# Verified MCP purchase on Solana Devnet

On October 2, 2026 PT, one separately authorized purchase completed through MCP stdio.
The test used the public buyer and a private local seller. It did not call the buyer execution function directly.

## Result

- MCP sequence: initialize → list tools → call `request_taiwan_monthly_revenue_monitor_v1` → receive the research result.
- One purchase tool call. No automatic retry.
- Amount: 0.05 Devnet USDC, or 50000 atomic units.
- Buyer balance: 19.95 → 19.90 Devnet USDC.
- Seller balance: 20.05 → 20.10 Devnet USDC.
- Transaction finalized with no error at slot 506825300.
- The complete returned research payload matches the database record. Its independently recomputed SHA-256 matches the returned hash.

[View the transaction](https://explorer.solana.com/tx/5WD3cjtfw8Mzww7KPieqpaNT3TGmhmtAaKpGXQULmsrNParFavM4bzbJcyDzHYcHrcftFg9ciMRzEg2iwrMvTvGD?cluster=devnet)

| Field | Value |
|---|---|
| Task | `elr_662aeae2-20cd-4a9a-8c6a-aa888295edac` |
| Receipt | `7280e568-84e6-466c-9054-5e6e0bd71d98` |
| Output hash | `6c481e903a14d8b6f28eb757b7af7571c802873aaf38271e8c0b3db42127b9ab` |
| Paid scope | 2383.TW, 3037.TW, 8046.TW |
| Period / baseline | August 2026 / June 2026 |

## Approval and isolation

The user authorized one 0.05 Devnet USDC purchase in chat.
The operator checked the unchanged browser approval page and confirmed that authorized test.
The signing service allowed one signature. An exclusive attempt marker prevented the runner from repeating the attempt.
The bridge received a local signer reference, not the wallet key. The test did not use mainnet or trade securities.

The host was a Codex-orchestrated SDK MCP client. No native Claude or Codex connector installation is claimed.
The [sanitized proof](evidence/2026-10-03-mcp-devnet-payment-proof.json) includes a script-generated event transcript. It is not an independent wire capture.

## Independent checks

Two post-payment audits confirmed finalized settlement, correct balance changes, one new database record, and complete payload equality.
A separate QC agent independently verified the chain, receipt linkage, and full research hash.
It confirmed that the runner used `Client.callTool()` through `StdioClientTransport`, rather than importing `executeP1aRequest`.

The database briefly lost connectivity after delivery while local disk space was low.
After recovery, both read-only audits passed. No transaction was repeated.
The seller, signer, and test database were stopped after verification. Reopening a live purchase demo requires those local services.

Run the [wallet-free judge check](judge-check.md):

```sh
cd tools/x402-mcp-bridge
pnpm judge:check --mcp-proof --chain
```

This reads the existing transaction. It does not perform a new purchase.
Public metadata cannot independently prove the research contents, recompute the complete output hash, or establish source accuracy.
This attempt did not repeat delivery retrieval. The earlier [direct-execution test](2026-10-03-devnet-payment-verification.md) verified duplicate retrieval separately.

Production payment hosting, native-client installation, mainnet use, and securities execution remain outside this test.
Video recording and hackathon submission remain deferred.
