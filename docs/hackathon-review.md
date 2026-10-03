# Hackathon review guide

EquityLayer supplies domain research methods to the AI an investor already uses.
The first theme is AI Compute across US, Taiwan, Japan, and Korea supply chains.
The map describes the research universe. It does not imply complete live data coverage.

## Review the research flow

1. Open [the AI Compute workspace](https://equitylayer.io/dashboard?view=explore).
2. Select a component and companies. Use the AI handoff to obtain a scoped research prompt.
3. Follow [the public client instructions](client.md). Run `doctor` before sending research.
4. Ask your AI to complete the returned research fields with public evidence.
5. Finalize the result. Import the saved file into the same browser workspace.
6. Review the evidence before accepting a baseline. Return later to compare the next result.

The dashboard stores the research review in that browser. This is not automatic background monitoring.
Missing sources produce a visible evidence gap, not an invented conclusion.
The [release status](release-status.md) identifies deployment limits and verified behavior.

## Review the Solana component

The [optional buyer](../tools/x402-mcp-bridge/README.md) lets an agent request one bounded research update through MCP and x402.
Its fixed contract uses Solana Devnet USDC. It requires separate human approval before signing.
The initial paid scope is 2383.TW, 3037.TW, and 8046.TW. It is narrower than the map.

Run its tests without a wallet:

```sh
cd tools/x402-mcp-bridge
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm typecheck
```

The seller backend is not in this public repository. The current buyer requires a configured loopback seller.
These automated tests use synthetic payment responses.
One separate local Devnet purchase settled on-chain. Read [the payment verification](2026-10-03-devnet-payment-verification.md) and its sanitized proof.
The verification script called the buyer execution code directly. An AI-host-driven purchase demo remains separate work.
Research purchases buy information. They do not buy securities.

## Source and provenance

- [Public release PR](https://github.com/equitylayerio/equitylayer-research-onboarding/pull/1)
- [CI verification](https://github.com/equitylayerio/equitylayer-research-onboarding/actions/runs/37010627506)
- [Independent publication QC](2026-10-02-publication-qc.md)
- [Hosted execution verification](2026-10-02-hosted-verification.md)
- [Devnet purchase verification](2026-10-03-devnet-payment-verification.md)

EquityLayer existed before this hackathon. Repository publication is not evidence that all work began during the event.
The submission must distinguish prior work from event-period changes. Organizer eligibility confirmation remains pending.
