# EquityLayer Research Onboarding

Build a better investment decision system with your AI.

This repository gives you a public, tool-neutral starting point for the EquityLayer workflow:

1. **Discover** the research question that can change your view.
2. **Build** a source map, company roles, and decision-relevant metrics.
3. **Verify** each update against dated evidence, limits, and falsifiers.

It does not bundle live market data, private research packs, or the private product backend. It does not execute investment trades.

## Start in 10 minutes

For an executable MCP workflow, use the [research client](docs/client.md). It reads the existing harness and saves a result for local review.
The client has no payment or trading permissions. The complete hackathon release is still in preparation.
Run `npm run research -- doctor` first. The hosted service may lack required research tools.
Give your AI the [MCP onboarding prompt](prompts/mcp-onboarding.md) for this workflow.

An optional [Solana research buyer](tools/x402-mcp-bridge/README.md) exposes one fixed Devnet research-purchase tool through MCP.
It requires a separately configured local seller, signer, and explicit human approval. Installing it does not enable payment.
See the [release status](docs/release-status.md) for verified behavior and remaining gates.
For a short product walkthrough, use the [hackathon review guide](docs/hackathon-review.md).
Use the [wallet-free judge check](docs/judge-check.md) to verify MCP discovery and the existing Devnet payment.

1. Open [the onboarding prompt](prompts/onboarding.md).
2. Copy it into the AI tool that you already use.
3. Answer its questions. Start with one theme and one decision.
4. Save the output in [the research brief template](templates/research-brief.md).
5. Use [the review prompt](prompts/review-update.md) when new evidence arrives.

Do not paste passwords, API keys, private account data, or material non-public information into a model.

## What good output looks like

A useful research workspace has:

- one decision question, not a broad sector summary;
- explicit company roles in the value chain;
- primary sources for material claims;
- a small set of metrics with units and dates;
- unknowns and counterevidence;
- a condition that would change the view;
- a dated comparison baseline for the next review.

See the [illustrative AI compute example](examples/ai-compute.md). It shows structure only. It is not current research and does not recommend a security.

## Repository map

- `client/`: executable MCP client with no package dependencies.
- `docs/client.md`: connection, research, and local result instructions.
- `examples/ai-compute-scope.json`: a fixed cross-market scope, not a current research report.
- `tools/x402-mcp-bridge/`: optional Solana Devnet research buyer, tests, and fixed purchase policy.
- `docs/release-status.md`: verification evidence and submission boundaries.

- `prompts/onboarding.md`: create the first research workspace.
- `prompts/review-update.md`: compare new evidence with the saved baseline.
- `templates/research-brief.md`: record the decision question and evidence boundary.
- `templates/source-map.md`: define approved sources and escalation rules.
- `templates/tracking-dashboard.md`: track only decision-relevant metrics.
- `examples/ai-compute.md`: a synthetic example of the format.

## Relationship to EquityLayer

This is the public onboarding layer. The private EquityLayer product adds durable workspaces, curated research packs, source-linked updates, change detection, and agent interfaces.

The prompts are model-independent. Better models can improve synthesis and tool use, but the human remains responsible for the research question, source approval, materiality, and final judgment.

## License and risk

The repository is available under the MIT License. Market and company information can become stale. Verify important claims against current primary sources before making a decision.
