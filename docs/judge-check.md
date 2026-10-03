# Check the demo without a wallet

This check reads one retained payment proof and starts the real buyer MCP server.
It initializes MCP and lists the purchase tool. It does not call that tool.

Use Node.js 22 or later and pnpm. From the repository root, run:

```sh
cd tools/x402-mcp-bridge
pnpm install --frozen-lockfile --ignore-scripts
pnpm judge:check
pnpm judge:check --chain
```

The first command checks retained metadata and MCP discovery without network requests.
The `--chain` option also reads the existing transaction from the fixed Solana Devnet RPC endpoint.
It checks the network, finalized status, transaction signature, USDC mint, and both balance changes.
No wallet, seller backend, signer, API key, or test tokens are required.
Exit code 1 means verification failed or the RPC result is unavailable. It does not mean a new payment failed.

Expected live output:

```text
PASS: Historical proof metadata matches the retained transaction and delivery identifiers.
PASS: MCP initialization and tool discovery: request_taiwan_monthly_revenue_monitor_v1
PASS: Devnet transaction finalized. Buyer: -0.05 USDC. Seller: +0.05 USDC.
No purchase tool was called. No wallet was loaded. No transaction was submitted.
The public proof contains metadata only. This check cannot recompute the complete research output hash.
```

## Evidence limits

- The live check verifies an existing transaction. It does not reproduce a new purchase.
- Discovery through MCP and payment through the buyer execution code were tested separately.
- The proof metadata reports a delivery and duplicate retrieval. The blockchain does not verify the research content or its quality.
- The public proof omits the full research payload. The private verification record describes the independent hash recomputation.
- The seller requires a private local backend. The public repository alone cannot serve a new paid research request.
- The historical pack covers August 2026 against a June baseline. It is not a claim of current research.

See [the payment record](2026-10-03-devnet-payment-verification.md) and [the research walkthrough](hackathon-review.md).
