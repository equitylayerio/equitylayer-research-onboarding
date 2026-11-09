# Trading production verification

Checked on October 3, 2026. All checks were read-only. No wallet was connected, no payment was made, and no transaction was signed or submitted.

## Release

- Application merge: `0ff525220bec525640e951fcb5a32a487789e9d2`, [PR #3](https://github.com/equitylayerio/equitylayer/pull/3).
- Railway production deployment: `b139c239-d677-4a8d-8fbd-af9ca094f5bc`. The Details page showed Active and Deployment successful for that merge on `master`.
- Public guide merge: `643048b368404ecec1390fb96f65b2b9188e1a17`, [PR #7](https://github.com/equitylayerio/equitylayer-research-onboarding/pull/7).

## Checks

1. Production `POST /api/trading/receipt` returned HTTP 200 and `Cache-Control: no-store`. Empty input returned `unverified`.
2. Production MCP initialization and `tools/list` returned 29 tools. `check_trading_receipt`, `get_trading_quote`, and `resolve_trading_instrument` carried read-only annotations.
3. `resolve_trading_instrument` returned the checked NVDA to NVDAx mapping. The receipt tool rejected an extra `submit` argument.
4. Production HTTP returned an indicative 1 USDC buy quote for NVDAx. `execution_supported` was `false`. Quotes expire; this result is not a current price or execution promise.
   The production company page also displayed a quote. The eligibility checkbox stayed unchecked and the Jupiter continuation button stayed disabled.
5. A public third-party historical transaction returned `matched`, side `sell`, with USDC atomic amount `530053478` and NVDAx atomic amount `225645002` (8 decimals). The check used a test handoff time. `ownership_verified` and `attribution_verified` were both `false`.

Historical sample: [Solana Explorer](https://explorer.solana.com/tx/5EW5NVRbZaFeby7LeyFT19Lu4HGHt5CdUTCgZ3bWJGPNjRBTQTNtaAVG9bxh1ic88B9rbKCiT1EVkejdCwv18i5d).

An independent QC repeated production tool discovery, the empty-input check, and the historical receipt check. It found no production endpoint blocker.

## Limits

This verifies deployed read-only capabilities, not an EquityLayer user's completed investment trade or referral revenue.
The transaction checker supports direct Jupiter V6 exchanges between USDC and NVDAx. Other routes can remain unverified.
The Devnet research purchase proof is separate. The hosted Solana research seller remains unavailable; the public buyer uses the compatible local seller.
Robinhood authentication and order execution remain unverified and are not included in this release.
