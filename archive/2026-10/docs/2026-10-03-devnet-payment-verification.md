# Solana Devnet purchase verification

One authorized research purchase settled on October 3, 2026 UTC (October 2 in Los Angeles).
This is a local Devnet integration test. It is not a mainnet launch or a hackathon submission.

## Result

| Check | Observed result |
|---|---|
| Price | 0.05 Devnet USDC, or 50,000 atomic units |
| On-chain status | Finalized, with no transaction error |
| Buyer balance | 20 → 19.95 Devnet USDC |
| Seller balance | 20 → 20.05 Devnet USDC |
| Delivery | Persisted as `settled` in the local PostgreSQL database |
| Receipt | Same transaction reference as the chain and `payment-response` header |
| Duplicate request | HTTP 200, with the same task, receipt, transaction, and output hash |

[View the Devnet transaction](https://explorer.solana.com/tx/XUZFjtxNd8Zyxcs3f5nx3TZ6yncVQXHma1qAvJsDPKw7dTPRnbuW2nBSPJzNX3Gzuv3JnAeVfSScJPDabemgj67?cluster=devnet).
The transaction used slot `506815848`. Its network fee was 10,001 Devnet lamports.

Output hash: `804c1ac2c528d63da6757f04034397858c907991c3c3cc368aa27ca57313af76`.
Receipt: `8388ae53-7a19-41ed-a571-dd928a7ff74a`.

The [sanitized proof](evidence/2026-10-03-x402-devnet-payment-proof.json) contains the challenge, receipt, and duplicate-delivery result.
It excludes keys, authentication tokens, payment-signature headers, and the full research payload.
The operator recomputed the output hash from the complete retained database payload. It matched the database and delivery hashes.
The public proof contains selected research metadata, so it does not independently reproduce that full-payload hash calculation.

## Research scope

The purchase refreshed the fixed Taiwan monthly-revenue monitor for `2383.TW`, `3037.TW`, and `8046.TW`.
It compared the June 2026 baseline with August 2026 TWSE data published on September 17.
The capability did not purchase complete coverage of the AI Compute map.
It did not buy securities or execute an investment decision.

## Execution boundary

- The seller ran on `127.0.0.1:3101`, with a local PostgreSQL database.
- The isolated signer ran on loopback and permitted one approved signature.
- The test used the public x402 facilitator and Solana Devnet.
- The smoke test called the buyer execution code directly. It did not test a Claude or Codex MCP session making this purchase.
- An earlier signed attempt failed verification before settlement. Its record remains intact. The user authorized this second attempt separately.
- Circle faucet funding initialized the seller token account before the successful attempt. Faucet funding is not purchase evidence.
- The duplicate request reused the original payment payload. It did not request a second signature.

The public buyer still requires a configured local seller. The seller backend is not included in this repository.
This proof does not make the hosted website a public Solana checkout.
No mainnet funds or investment trades were used.

## Checks in this run

- Buyer tests: 69 passed across 9 files.
- Seller contract and route tests: 16 passed across 2 files.
- Public export checks: 22 research-client tests, 69 buyer tests, and buyer typecheck passed.
- No production code changed in this run.

An [independent QC checkpoint](2026-10-03-payment-qc.md) passed for publication of this evidence and documentation.

The remaining submission work includes a recorded demo, an explicit judge-reproduction plan, and organizer eligibility and submission checks.
