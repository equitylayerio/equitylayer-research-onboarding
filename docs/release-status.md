# Release preparation status

The public source release is published. One local Solana Devnet research purchase also settled.
Neither result proves a completed hackathon submission or a mainnet payment.

## Product boundary

EquityLayer is a research harness for the AI the investor already uses.
The first theme is AI Compute across US, Taiwan, Japan, and Korea supply chains.
That theme scope does not imply verified data or purchasable updates for every company on the map.

The standard research client reads research plans and saves results for a user's local dashboard review.
The optional Solana buyer purchases one fixed monthly-revenue update, after separate human approval.
Research purchases and investment trades are different operations. Neither component places an investment trade.

## Verified locally

| Component | Evidence |
|---|---|
| Research client | 22 automated tests. Two real calls each to begin and finalize against retained local MCP data. |
| Dashboard import | Desktop and mobile replay preserves explicit user review before baseline acceptance. |
| Solana buyer | 69 automated tests and typecheck. The original 67-test export also passed a standalone frozen-lockfile installation outside the private app. |
| Seller compatibility | The private application's real seller SDK challenge passes the buyer policy, including header serialization. |

Local verification used Node.js 25.2.1 and pnpm 9.15.4.
The included CI workflow passed on Node.js 22 and 24, with pnpm 10 for the buyer.
See [the verified CI run](https://github.com/equitylayerio/equitylayer-research-onboarding/actions/runs/37010627506) for release source `9691953`.
The research replay draft was hand-authored to report missing evidence. Its result state was `SOURCE_NEEDED`.
The automated payment tests use synthetic signing and settlement responses.
A separate authorized test produced a finalized Devnet transaction and a matching durable delivery.
See [the payment verification and proof](2026-10-03-devnet-payment-verification.md).

The buyer source matches EquityLayer application commit `ae2e160`.
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
The successful test called the buyer execution code directly, not through an AI host's MCP session.
Buyer pending state is process-local. Do not restart the process to repeat a purchase with uncertain settlement.
