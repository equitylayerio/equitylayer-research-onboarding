# Hosted research verification — October 2, 2026

The research service is live at `https://equitylayer.io/mcp`.
The [dashboard](https://equitylayer.io/dashboard?view=explore) is available for browser-local review.
This report does not establish live Solana settlement or a completed hackathon submission.

## Discovery and execution

The public client's `doctor` command found all required research tools and the instrument-mapping tool.
The service reported harness version `1.1.0`.
Two independent begin/finalize sequences used the retained October 1 scope in `examples/ai-compute-scope.json`.
The draft contained public, hand-authored evidence-gap fields. It was not an AI research-quality benchmark.

| Check | Result ID | Result |
|---|---|---|
| First finalize | `5cd7c20a-c2e8-4db7-84e3-2a06311779ee` | `SOURCE_NEEDED`; zero sources; baseline not accepted |
| Second finalize | `8306c6eb-7933-4577-9bba-a60bae7891aa` | `SOURCE_NEEDED`; zero sources; baseline not accepted |

Both begin calls returned the same deterministic research handle:
`cc9deaf8cbb98ff2af54d80911c709ff1d3c8d6effe3826ccbb5790ba2615cf2`.
Coverage was available for `3711.TW`, not for every company in the cross-market scope.
The company tracker returned 16 retained filings for `3711.TW` through October 1.

## Retained outcome and isolation

The public watchlist digest for `3711.TW` on September 24 returned two filings with `status: measured` and `excess_1d: 1.1458008658008658` percentage points.
This confirms that the production Git deployment includes the retained price inputs. It does not establish causality or predictive performance.

The hosted local-delivery route and the Solana Devnet seller route both returned HTTP 404, as required by their local-only boundaries.
No wallet signature, payment, or investment trade occurred.

## Limits

- The Solana buyer still requires a configured local seller and explicit approval.
- A real Devnet transaction, matching delivery hash, and judge-accessible payment demonstration remain pending.
- Browser-local review is not background monitoring. Public result validation does not establish source accuracy.
- The private seller backend and full dashboard are not included in this public source repository.
