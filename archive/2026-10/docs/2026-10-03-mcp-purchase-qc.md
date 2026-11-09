# MCP purchase QC

Target: local seller and signer → Solana Devnet. Public evidence target: `equitylayerio/equitylayer-research-onboarding`.
No production website deployment or mainnet payment occurred.

## Independent review

A separate QC agent read the one-attempt runner, saved MCP response, and event transcript.
It did not read wallet keys or runtime credentials. It did not execute a purchase.

Passed checks:

- The runner used the SDK client over stdio and made one `tools/call`.
- The runner did not import or call `executeP1aRequest` directly.
- The transaction finalized on Devnet with `meta.err = null`.
- The seller received exactly 50000 atoms of the fixed Devnet USDC mint.
- The buyer lost the same amount.
- The complete research output hash recomputed to `6c481e903a14d8b6f28eb757b7af7571c802873aaf38271e8c0b3db42127b9ab`.
- Before the new proof-check cases: 93 buyer tests, 22 research-client tests, and typecheck passed.
- After the new proof-check cases: 104 buyer tests and typecheck passed. The research-client suite is unchanged.

The lead also ran two read-only database audits after a temporary Docker interruption.
Both confirmed complete output equality with the MCP response and exactly one new purchase record.
No purchase was repeated during recovery. The test services were stopped afterward.

The follow-up QC passed all 104 buyer tests, 22 client tests, typecheck, and the live read-only MCP proof check.
It confirmed correct transaction selection and found no secrets or private research in the publication files.
It identified ambiguous duplicate-retrieval wording in the shared judge guide. The correction limits that claim to the earlier direct-execution proof.

## Public verification, manual run 1

Command: `pnpm judge:check --mcp-proof --chain`. Exit code: 0.

```text
Proof: MCP stdio purchase
PASS: Historical proof metadata matches the retained transaction and delivery identifiers.
PASS: MCP initialization and tool discovery: request_taiwan_monthly_revenue_monitor_v1
PASS: Devnet transaction finalized. Buyer: -0.05 USDC. Seller: +0.05 USDC.
No purchase tool was called. No wallet was loaded. No transaction was submitted.
The public proof contains metadata only. This check cannot recompute the complete research output hash.
```

## Public verification, manual run 2

Command: `pnpm judge:check --mcp-proof --chain`. Exit code: 0.

```text
Proof: MCP stdio purchase
PASS: Historical proof metadata matches the retained transaction and delivery identifiers.
PASS: MCP initialization and tool discovery: request_taiwan_monthly_revenue_monitor_v1
PASS: Devnet transaction finalized. Buyer: -0.05 USDC. Seller: +0.05 USDC.
No purchase tool was called. No wallet was loaded. No transaction was submitted.
The public proof contains metadata only. This check cannot recompute the complete research output hash.
```

## Limits preserved

The host was an SDK MCP client orchestrated by Codex, not a native Claude or Codex connector installation.
The event transcript was produced by the runner. It was not independently captured from the wire.
The public proof excludes the complete research payload, credentials, signing material, and approval URL.
Hash equality establishes delivery consistency, not source accuracy or investment value.
This run does not establish production payment hosting or automatic future research monitoring.
