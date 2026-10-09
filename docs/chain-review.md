# One research workflow, different chain connections

EquityLayer helps your existing AI perform structured investment research.
The research question, sources, result, and local review stay the same when the execution connection changes.

| Connection | Verified scope | Not included |
| --- | --- | --- |
| Solana Devnet | Two retained USDC research-purchase tests | Tokenized-equity purchase; public self-service seller |
| Solana mainnet / Jupiter | NVDAx mapping, indicative quote, external handoff, bounded receipt check | Automatic order, wallet custody, referral attribution |
| Robinhood Chain mainnet | Live canonical contract, decimals, UI multiplier, oracle pause flag at one pinned block | Price, liquidity, eligibility, legal rights, broker access, order |

## Read-only judge check

Use Node.js 22 or later. No wallet, API key, or payment is needed.
On October 9, the candidate passed two direct NVDA checks and two public-client MCP checks against real chain data.
The hosted MCP did not yet expose this tool.
Publication and deployment remain pending. The default command below stops if the hosted service lacks the tool.
Use the local command to review the candidate before deployment.
See [the retained October 9 reads](evidence/2026-10-09-robinhood-read-checks.json).
Those outputs are expired historical evidence. They are not a current quote or a production deployment check.

```bash
npm run research -- evidence --input examples/robinhood-evidence.json
```

For a locally running candidate backend:

```bash
npm run research -- evidence --input examples/robinhood-evidence.json --endpoint http://127.0.0.1:3110/mcp
```

The client first discovers `get_instrument_evidence`. It stops if the server lacks the tool.
It then reads NVIDIA's canonical Robinhood Chain deployment and contract state.
Supported initial symbols: NVDA, AAPL, MSFT, TSLA, CRWD. The research map does not imply token support for every company.

Expected success: `status: checked`, `chain_id: 4663`, contract address, block hash, decimals, multiplier, and source links.
The public RPC supplies **latest, not finalized** evidence. All contract reads use the same block number, and the block hash is checked again.
The server rejects stale blocks, ambiguous mappings, wrong networks, and registry/contract mismatches.
`oracle_paused: false` does not establish a fresh or usable price. No price is read by this tool.
Evidence expires after at most 30 seconds. Read it again when needed; do not treat retained output as current.
This demo uses Robinhood's rate-limited public RPC, which its documentation does not recommend for production. It has no production availability guarantee.
HTTP and MCP share a per-server-instance limit of 15 checks per minute. It is not a per-user allowance or a distributed rate limit.
An unavailable read returns exit code 2. This can reflect rate limits, provider failure, or unsupported coverage. Do not retry a trade.

## Dashboard

Workspace → a company → Trade options → Connection.
Choose Solana / Jupiter or Robinhood Chain read-only. The research stays on the same page.
For Robinhood Chain, choose **Check chain evidence**. There is no buy button or wallet request.
This is not Robinhood's broker Trading MCP. Broker authentication and orders remain separate.

## Submission boundary

This public repository contains the onboarding prompts, executable research client, and optional Solana buyer.
It does not contain the private backend. Review the hosted demo and retained evidence as separate artifacts.
The chain check is a real read-only integration, not a simulated trade. It does not guarantee qualification for a hackathon track.
Submit one product, and confirm track selection with the organizer. Do not claim a Robinhood token purchase or a Solana tokenized-equity purchase from the Devnet research-payment records.

## Sources checked October 4, 2026

- [Robinhood public Stock Token API](https://docs.robinhood.com/chain/stock-token-apis/)
- [Robinhood Chain connection settings](https://docs.robinhood.com/chain/connecting/)
- [Stock Token contracts and multipliers](https://docs.robinhood.com/chain/building-with-stock-tokens/)
- [Oracle restrictions](https://docs.robinhood.com/chain/oracles-and-price-feeds/)
- [Crypto World's Fair](https://colosseum.com/worldsfair)
- [Hackathon rules](https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf)
