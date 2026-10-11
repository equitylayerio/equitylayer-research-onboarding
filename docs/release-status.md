# Release preparation status

The public source release is published. Two separately authorized local Solana Devnet research purchases settled.
The first used the buyer execution code directly. The second used MCP stdio.
Neither result proves a completed hackathon submission or a mainnet payment.

## October 11 repair candidate

This section records the checks before candidate publication. It does not report the current GitHub or production state.
Check the default branch and its latest CI for source publication. Check the hosted deployment separately.

The client candidate adds safe validation paths and retained Pack version discovery. Its first repair passed 28 tests.
The next local repair supports the SDK's flattened field errors. Both text formats require a known tool name.
The full client suite now passes 30 tests. An independent reviewer repeated all 30 tests and checked the parser boundary.
Two calls with an invalid stage returned only `stage_id`, without the raw error values or an automatic retry.
The onboarding instructions now preserve the returned Pack version through finalize and require review before baseline acceptance.
Missing current evidence keeps the previous baseline. A retained-version comparison does not check new official releases.

These changes were on the candidate branch during these checks. These checks do not establish a new backend deployment.
Hosted tool discovery passed on October 11, and two read-only version queries returned August 2026.
Those reads do not verify the unpublished backend repairs, native AI connectors, research quality, payment, or a completed submission.

Two local agents also tested six synthetic research cases each. The first run exposed a date-scope error and two invalid fixture stages.
The method now separates the retained filing day from a research cutoff that the user explicitly supplies.
Both non-blind replays received all six methods. An independent reviewer scored their answers at 60/60, with no hard failure.
The first valid-method trials scored 38/40. The replay is not a new blind trial, a cross-model comparison, or proof of investment quality.

The public client completed two HTTP research runs against the local production build with real retained July and August data.
Each run returned `SOURCE_NEEDED` and `WAIT_FOR_SOURCE`. Each run kept the caller's reviewed July baseline.
Finalize returned the checked August version and rejected `NO_NEW_EVIDENCE` for the stale Pack.
The caller must still review the result locally. These calls did not test browser storage or native AI connectors.
The public buyer passed 104 tests and type checking. No new payment or investment order occurred.

## Product boundary

EquityLayer is a research harness for the AI the investor already uses.
The first theme is AI Compute across US, Taiwan, Japan, and Korea supply chains.
That theme scope does not imply verified data or purchasable updates for every company on the map.

The standard research client reads research plans and saves results for a user's local dashboard review.
The optional Solana buyer purchases one fixed monthly-revenue update, after separate human approval.
Research purchases and investment trades are different operations. Neither component places an investment trade.

The hosted application also provides indicative Jupiter quotes and a read-only NVDAx transaction checker.
It does not submit orders. See [trading production verification](2026-10-03-trading-production-verification.md).

## October 9 production verification

The backend and public-client release are published. [Public PR 9](https://github.com/equitylayerio/equitylayer-research-onboarding/pull/9) merged into `main`.
The hosted HTTP endpoint returned `checked` for NVDA at block `84501766`; the public client completed a hosted MCP read at block `84501815`.
An independent MCP read also returned `checked` at block `84502545`.
Hosted desktop and mobile checks passed, including evidence expiry, explicit retry, and switching back to Solana. No order, wallet signature, or payment occurred.
These observations are historical. Run a new read when you need current evidence; it expires after at most 30 seconds.

## Earlier October 9 candidate verification

The Robinhood Chain candidate passed two live NVDA contract checks. It uses the same company research page and a separate read-only connection.
The candidate public client passed 25 tests. The Solana buyer passed 104 tests and type checking.
Both historical Devnet purchases remained finalized in fresh wallet-free checks. No new payment or transaction occurred.

Before the deployment, hosted MCP did not expose `get_instrument_evidence`, and the evidence endpoint returned HTTP 404. Those earlier results are superseded by the production checks above.

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
