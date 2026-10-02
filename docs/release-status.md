# Release preparation status

This repository is a public-source candidate. It is not evidence of a completed hackathon submission or a live payment.

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
| Research client | 17 automated tests. Two real calls each to begin and finalize against retained local MCP data. |
| Dashboard import | Desktop and mobile replay preserves explicit user review before baseline acceptance. |
| Solana buyer | 67 automated tests, typecheck, and standalone frozen-lockfile installation outside the private app. |
| Seller compatibility | The private application's real seller SDK challenge passes the buyer policy, including header serialization. |

Local verification used Node.js 25.2.1 and pnpm 9.15.4.
The included CI workflow specifies Node.js 22 and 24, with pnpm 10 for the buyer. Those CI jobs have not run yet.
The research replay draft was hand-authored to report missing evidence. Its result state was `SOURCE_NEEDED`.
The payment tests use synthetic signing and settlement responses. They do not prove an on-chain payment.

The buyer source comes from EquityLayer application commit `3c6cc24` without changes.
The export contains only the buyer's source, tests, dependency lockfile, package configuration, and README.
It contains no seller database, wallet key, private research, or environment file.

An independent read-only QC checked the export, candidate files, CI commands, and release claims.
It found no blocker for a local release-candidate commit. It did not verify live settlement or authorize publication.

## Remaining submission gates

1. Confirm the repository destination and publish the reviewed source. A local commit is not a public timestamp.
2. Provide access to a compatible seller and a judge-accessible dashboard build.
3. Configure an approved Devnet payee and durable seller storage.
4. Obtain explicit authorization for a bounded Devnet payment test. Preserve its actual transaction and matching delivery hash.
5. Record the final demo and check the organizer's current submission requirements and pre-existing-work rules.

The seller backend and full local dashboard are not included in this source candidate.
The research client can use the hosted MCP, but deployed versions can differ. Use a compatible local server if a tool is unavailable.
The Solana buyer only accepts the fixed loopback seller at port 3101. It is not a public multi-seller payment client.
Buyer pending state is process-local. Do not restart the process to repeat a purchase with uncertain settlement.
