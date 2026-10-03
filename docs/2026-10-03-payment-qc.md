# Devnet payment QC

An independent reviewer checked the payment evidence and documentation without making another payment.
The reviewer made no file changes, signatures, transactions, or deployments.

## Passed

- The private and public proof files match exactly.
- The public Devnet RPC reports a finalized transfer with no transaction error.
- The buyer sent 50,000 atomic units to the approved seller.
- The buyer balance changed from 20 to 19.95 Devnet USDC.
- The seller balance changed from 20 to 20.05 Devnet USDC.
- The local database matches the amount, seller, transaction reference, and output hash.
- The earlier rejected attempt remains intact without a transaction reference or output hash.
- The duplicate request returns the same task ID, hash, receipt ID, and transaction reference.
- The settled route returns the stored result without another settlement call.
- Neither proof file contains keys, credentials, cookies, or a reusable payment-signature payload.
- The final documentation distinguishes local Devnet verification from hosted payment availability and mainnet readiness.

## Limits

The reviewer checked metadata and chain evidence. The reviewer did not independently recompute the complete database payload hash.
The operator separately recomputed that hash and confirmed the match.
The public proof omits the complete research payload. Its metadata does not independently reproduce the output hash.
The replay assertion covers the recorded fields, not byte-for-byte equality of the complete response.
The test directly called buyer execution code. It did not exercise purchase through an AI host's MCP session.

The operator reported 69 passing buyer tests and 16 passing seller tests in this run.
The independent reviewer did not repeat those tests.

## Publication decision

Result: pass for publishing the sanitized proof and updated documentation.
No additional payment is required for this checkpoint.

Target: documentation in the public onboarding repository, not a production application deployment.
Branch: `codex/hackathon-public-client`.
The public seller and full backend remain outside this source release.
