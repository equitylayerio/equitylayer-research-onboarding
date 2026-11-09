# Public source QC — October 2, 2026

Scope: the research client and optional Solana Devnet buyer. This report does not establish a live payment or completed submission.

## Results

- Research client: 22 tests passed.
- Solana buyer: 69 tests passed. Type checking passed.
- The tracked-file and history scan found no obvious credentials, private keys, environment files, or private seller backend.
- Installation does not start payment. CI installs the buyer with lifecycle scripts disabled.
- The client checks available tools before it sends a research draft.
- The buyer requires a fixed Devnet contract and separate human approval.

## Defect and regression check

QC found that the duplicate-delivery test request could forward sensitive headers through a redirect.
The fixed helper rejects redirects and applies a ten-second deadline. It does not sign or retry.
The independent reviewer called the actual helper against two temporary loopback servers with synthetic credentials.
The original server received one request. The redirect destination received zero requests and zero headers.
The request failed with `unexpected redirect`.

## Release boundary

- Public repository: `equitylayerio/equitylayer-research-onboarding`.
- Public source branch: `codex/hackathon-public-client`.
- Hosted research endpoint: `https://equitylayer.io/mcp`.
- Local research endpoint used in prior verification: `http://127.0.0.1:3100/mcp`.
- Optional buyer seller: loopback port 3101, Solana Devnet only.

Hosted tool deployment, CI results, and live settlement require separate verification.
No transaction, payment, or wallet signature occurred during this QC.

## Subsequent verification

Public CI passed on Node 22 and 24. The production research service was then deployed and checked independently of this publication QC.
See [hosted verification](2026-10-02-hosted-verification.md). Live Solana settlement remains unverified.
