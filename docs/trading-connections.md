# Research and trading connections

EquityLayer supplies research methods, source rules, and reviewed research records. Your trading provider supplies execution.
Buying a Research Pack does not authorize an investment trade.

## Solana: Jupiter first

The current application has one checked mapping: NVDA to NVDAx on Solana mainnet.
NVDAx is a tokenized product, not an NVIDIA share. Check issuer and venue eligibility before use.
The wider research map does not imply trading support for every company.

The local implementation adds this sequence:

1. Select reviewed research in the company page's Trade options.
2. Select a side and amount. Read an indicative quote.
3. Continue to Jupiter. Review and confirm the final order there.
4. Return to EquityLayer. Enter the public wallet address and transaction signature.
5. Check the transaction. Save the chain evidence beside the original research handoff.

EquityLayer does not hold wallet keys or submit the trade.
The receipt checker reads finalized mainnet data. It currently supports direct Jupiter V6 exchanges between USDC and NVDAx.
Unsupported routes return an unverified result. Do not repeat a trade because a check fails.
The local record does not prove wallet ownership or referral attribution. It does not update your holdings automatically.

The new receipt checker is a local implementation candidate, not a verified production release.
Check tool discovery before use. Its MCP tool is `check_trading_receipt`.
It accepts `instrument_id`, `wallet`, `signature`, and `handoff_at`. It cannot place an order.

## Robinhood: separate broker connection

Robinhood publishes an official trading MCP endpoint:

```text
https://agent.robinhood.com/mcp/trading
```

Connect it through your AI client's connector settings. Authenticate directly with Robinhood.
Read Robinhood's access disclosures first. The connection can expose accounts, positions, balances, and order history to your AI.
Do not send broker credentials or complete account records to EquityLayer.

**Turn on Trade approvals in Robinhood before a trading workflow.**
Robinhood states that external MCP accounts have this control off by default.
A prompt is not a substitute for the provider's approval control.

The proposed workflow uses official tools in this order:

1. Read `get_trade_approval_setting`. Stop if manual approval is off or cannot be checked.
2. Read `get_equity_tradability` and `get_equity_quotes` for the user's selected symbol.
3. Ask the user for the side, amount, and order type. Do not infer them from research.
4. Use `review_equity_order` for the proposed order. Present warnings to the user.
5. Stop for separate approval before any order submission.
6. Read `get_equity_orders` after an approved submission. Distinguish open, partially filled, filled, canceled, and rejected orders.

Discover each tool's current schema from the official server. This repository does not supply a Robinhood order adapter.
Account authentication, order submission, and receipt import are not verified in this release.

## Hackathon scope

Crypto World's Fair is multi-chain. Section 14 of its rules lists Solana, Tempo, Hyperliquid, Zcash, Ethereum L1, Base, Arbitrum, and Robinhood Chain.
The rules require integration with the relevant chain for its track.
Robinhood's broker MCP is not Robinhood Chain. Adding the broker connector alone does not establish eligibility for that chain's track.

Use Solana for the current entry. Keep other execution connections separate from the research product.
The verified Devnet USDC purchase bought research. It did not buy tokenized equity.
No referral fee or commission is enabled by this guide.

## Official references

Checked on October 3, 2026:

- [Jupiter order and execute](https://developers.jup.ag/docs/swap/order-and-execute)
- [Jupiter API access and keyless limits](https://github.com/jup-ag/docs/blob/main/llms.txt)
- [NVDAx issuer page](https://assets.backed.fi/products/nvidia-xstock)
- [Robinhood external-agent onboarding](https://robinhood.com/us/en/support/articles/agentic-trading-overview/)
- [Robinhood approvals and trading tools](https://robinhood.com/us/en/support/articles/trading-with-your-agent/)
- [Crypto World's Fair rules, section 14](https://colosseum.com/legal/Crypto%20World's%20Fair%20Hackathon%20Rules.pdf)
