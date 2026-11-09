# EquityLayer Solana research buyer

This MCP bridge requests one fixed Taiwan monthly-revenue update through Solana Devnet x402.
It does not buy securities or execute trades. The broader research theme is AI Compute.

## Test the package

Use Node.js 22 or later and pnpm 10. Local verification used Node.js 25.2.1.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm typecheck
```

These tests use synthetic payment fixtures. They do not send a blockchain transaction.
The package declares its own dependencies. It does not need the parent application's dependencies.

## Purchase contract

- Tool: `request_taiwan_monthly_revenue_monitor_v1`.
- Resource: `http://127.0.0.1:3101/api/x402/devnet/taiwan-monthly-revenue-monitor-v1`.
- Scope: 2383.TW, 3037.TW, and 8046.TW.
- Baseline: June 2026. A comparison against this baseline is not necessarily a monthly change.
- Price: 0.05 Devnet USDC per request, at most three signing attempts and 0.15 Devnet USDC per process session.
- A local approval page requires human approval before each signature.
- The bridge checks the challenge, delivered company scope, output hash, and settlement reference.

This is the local-only v1 contract. It does not claim paid coverage across the full US, Taiwan, Japan, and Korea map.
The seller backend is separate. Copying this package does not create a working seller or a funded wallet.

## Runtime prerequisites

An operator must configure a compatible seller with durable storage before running a payment test.
The seller and bridge must use the same approved public payee and local authentication token.

The bridge requires `X402_P1A_LOCAL_MODE=true`, `X402_DEVNET_PAY_TO`, and `X402_P1A_LOCAL_AUTH_TOKEN`.
It accepts an optional `EQUITYLAYER_X402_LOCAL_ORIGIN`, restricted to loopback port 3101.
Use `pnpm start` as the MCP stdio command after configuration.

Signing is disabled unless an approved local signer is configured through `EQUITYLAYER_X402_SIGNER_ORIGIN` and `EQUITYLAYER_X402_SIGNER_TOKEN`.
The origin must identify a loopback `/sign` endpoint. The bridge does not accept private keys through MCP arguments.
The included isolated Devnet signer and payment smoke script have separate explicit approval gates. Do not start them as an installation step.

## Delivery and uncertain payments

The paid response has a 60-second deadline to allow the seller's sequential verification, source refresh, and settlement steps.
A timeout does not prove that settlement failed. The bridge returns a public payment identifier when delivery remains unconfirmed.
It blocks another payment in the same session until the current delivery is verified.
Check the seller's durable record before authorizing another payment. Do not restart the bridge to repeat an uncertain purchase.
The buyer's pending identifier is process-local. Durable buyer recovery is not implemented.

Set `EQUITYLAYER_LOCAL_DELIVERY_INBOX_PATH` to an absolute local path to save a verified delivery summary for the dashboard.
If that optional write fails, the MCP result still returns the verified delivery. No baseline is accepted automatically.

## Release boundary

Automated tests do not establish a live payment proof. Before claiming a completed purchase, retain a real authorized Devnet transaction and matching delivery.
Do not publish wallet files, local tokens, environment files, or private research with this package.
