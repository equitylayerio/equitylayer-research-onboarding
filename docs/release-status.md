# Release preparation status

The public source release is published. Two separately authorized local Solana Devnet research purchases settled.
The first used the buyer execution code directly. The second used MCP stdio.
Neither result proves a completed hackathon submission or a mainnet payment.

## Product boundary

EquityLayer is a research harness for the AI the investor already uses.
The first theme is AI Compute across US, Taiwan, Japan, and Korea supply chains.
That theme scope does not imply verified data or purchasable updates for every company on the map.

The standard research client reads research plans and saves results for a user's local dashboard review.
The optional Solana buyer purchases one fixed monthly-revenue update, after separate human approval.
Research purchases and investment trades are different operations. Neither component places an investment trade.

The hosted application also provides indicative Jupiter quotes and a read-only NVDAx transaction checker.
It does not submit orders. See [trading production verification](2026-10-03-trading-production-verification.md).

## October 9 candidate verification

The Robinhood Chain candidate passed two live NVDA contract checks. It uses the same company research page and a separate read-only connection.
The candidate public client passed 25 tests. The Solana buyer passed 104 tests and type checking.
Both historical Devnet purchases remained finalized in fresh wallet-free checks. No new payment or transaction occurred.

The hosted MCP exposes the research tools, but it does not yet expose `get_instrument_evidence`.
The production evidence endpoint returned HTTP 404 on October 9. The Robinhood backend and client changes still require release.
Do not treat the candidate instructions as evidence of a deployed integration.

## Verified locally

| Component | Evidence |
|---|---|
| Research client | 22 automated tests. Two real calls each to begin and finalize against retained local MCP data. |
| Dashboard import | Desktop and mobile replay preserves explicit user review before baseline acceptance. |
| Solana buyer | 104 automated tests and typecheck, including the historical proof checker. The original 67-test export also passed a standalone frozen-lockfile installation outside the private app. |
| Seller compatibility | The private application's real seller SDK challenge passes the buyer policy, including header serialization. |

Local verification used Node.js 25.2.1 and pnpm 9.15.4.
The included CI workflow passed on Node.js 22 and 24, with pnpm 10 for the buyer.
See [the verified CI run](https://github.com/equitylayerio/equitylayer-research-onboarding/actions/runs/37010627506) for release source `9691953`.
The research replay draft was hand-authored to report missing evidence. Its result state was `SOURCE_NEEDED`.
The automated payment tests use synthetic signing and settlement responses.
A separate authorized test produced a finalized Devnet transaction and a matching durable delivery.
See [the payment verification and proof](2026-10-03-devnet-payment-verification.md).
See [the later MCP purchase verification](2026-10-03-mcp-purchase-verification.md) for the end-to-end protocol test.

The original buyer export matches EquityLayer application commit `ae2e160`. The public repository later added read-only judge verification commands.
The export contains only the buyer's source, tests, dependency lockfile, package configuration, and README.
It contains no seller database, wallet key, private research, or environment file.

An independent read-only QC checked the export, candidate files, CI commands, and release claims.
It found no blocker for a local release-candidate commit. It did not verify live settlement or authorize publication.
The pre-publication QC found a redirect defect in the duplicate-delivery test script. The fix rejects redirects and sets a deadline.
An independent test used two loopback servers and synthetic credentials. The redirect destination received no request. See [publication QC](2026-10-02-publication-qc.md).

## Remaining submission gates

1. Published: [public release PR](https://github.com/equitylayerio/equitylayer-research-onboarding/pull/1), merged into `main` on October 2, 2026.
2. Published: the compatible hosted research MCP and dashboard. A judge-accessible Solana seller remains pending.
3. Complete locally: the approved Devnet payee and durable seller storage.
4. Complete locally: one authorized 0.05 Devnet USDC purchase, with transaction, receipt, output hash, and duplicate-delivery evidence.
5. Record the final demo and check the organizer's current submission requirements and pre-existing-work rules.

The seller backend and full local dashboard are not included in this source candidate.
The research client can use the hosted MCP, but deployed versions can differ. Use a compatible local server if a tool is unavailable.
The October 2 production deployment resolved the earlier missing-tool failure. Two hosted begin/finalize checks and a retained filing outcome check passed. See [hosted verification](2026-10-02-hosted-verification.md).
Run `npm run research -- doctor` before the demo. A passing discovery check does not verify research execution or payment.
The Solana buyer only accepts the fixed loopback seller at port 3101. It is not a public multi-seller payment client.
The later test used a Codex-orchestrated SDK MCP stdio client. It did not test native Claude or Codex connector installation.
Buyer pending state is process-local. Do not restart the process to repeat a purchase with uncertain settlement.
