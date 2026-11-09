# Read-only judge check: QC record

Date: October 2, 2026 PT / October 3, 2026 UTC.
Target: public client repository, branch `codex/hackathon-public-client`.
This release does not deploy the production website or enable payments.

## Verification

- Research client: 22 tests passed before and after this change.
- Buyer package: 69 tests before this change, 93 tests after this change.
- TypeScript check passed.
- A separate QC agent repeated all 93 buyer tests, the type check, and the live read-only check.
- Invalid command arguments returned exit code 1.
- QC found an early stderr listener that could not attach before the child process started.
- The correction discards child stderr explicitly. No pipe can fill with unread diagnostics.

The implementation permits only MCP initialization and tool discovery in the judge check.
The optional chain check sends three read requests to the fixed Devnet RPC endpoint.
It does not request payment, load a wallet, call a signer, or submit a transaction.

## Manual run 1

Command: `pnpm judge:check --chain`
Exit code: 0.

```text
PASS: Historical proof metadata matches the retained transaction and delivery identifiers.
PASS: MCP initialization and tool discovery: request_taiwan_monthly_revenue_monitor_v1
PASS: Devnet transaction finalized. Buyer: -0.05 USDC. Seller: +0.05 USDC.
No purchase tool was called. No wallet was loaded. No transaction was submitted.
The public proof contains metadata only. This check cannot recompute the complete research output hash.
```

## Manual run 2

Command: `pnpm judge:check --chain`
Exit code: 0.

```text
PASS: Historical proof metadata matches the retained transaction and delivery identifiers.
PASS: MCP initialization and tool discovery: request_taiwan_monthly_revenue_monitor_v1
PASS: Devnet transaction finalized. Buyer: -0.05 USDC. Seller: +0.05 USDC.
No purchase tool was called. No wallet was loaded. No transaction was submitted.
The public proof contains metadata only. This check cannot recompute the complete research output hash.
```

## Remaining boundary

These checks do not establish a new purchase through Claude, Codex, or another AI host.
The retained payment used the buyer execution code directly. MCP discovery is a separate verification.
The public proof contains delivery metadata, not the complete paid result.
No customer demand, current research freshness, securities execution, or mainnet payment is established by these tests.
