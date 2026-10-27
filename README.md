# EquityLayer Research Onboarding

Build a better investment decision system with your AI.

This repository gives you a public, tool-neutral starting point for the EquityLayer workflow:

1. **Discover** the research question that can change your view.
2. **Build** a source map, company roles, and decision-relevant metrics.
3. **Verify** each update against dated evidence, limits, and falsifiers.

It does not bundle live market data, private research packs, or the private product backend. It does not execute investment trades.

## Choose a starting point

For the unpublished installable candidate, see [tarball installation and upgrade](docs/installable-client.md).
Its `equitylayer` command works outside the source checkout. This does not establish complete first-use or real-caller acceptance.
The tarball contains selected user guides only. Repository examples, hackathon evidence, and optional payment tools below are not bundled.

For an executable MCP workflow, use the [research client](docs/client.md). It reads the existing harness and saves a result for local review.
The client has no payment or trading permissions. The optional hackathon buyer is a separate component.
Run `npm run research -- doctor` first. The hosted service may lack required research tools.
Give your AI the [MCP onboarding prompt](prompts/mcp-onboarding.md) for this workflow.

The local candidate now includes a [caller-owned execution CLI](docs/local-execution.md).
It stores research jobs in private SQLite and requires explicit command and private-input approval before AI execution.
An opt-in [local workspace](docs/local-workspace.md) now reads the same SQLite record and provides an Inbox with separate review actions.
To connect your existing local stdio AI client, start with `equitylayer setup --session --workspace /absolute/private/new-workspace`.
This route needs no native model configuration or inference budget. Prepare its private MCP connection from Watch detail.
Controlled Inbox and Tracking browser checks use synthetic data. Complete caller-to-review and second-update acceptance remains open.
See [the portable verification boundary](docs/local-verification-status.md) before treating a passing check as product acceptance.
Use the [native setup check](docs/native-research-runtime.md#check-setup-before-research) to check declared Codex or Claude Code versions before creating a workspace.
It does not invoke a model or verify authentication, model access, billing, or Inbox delivery.
The [retained-source boundary](docs/local-verification-status.md#research-and-readable-sources) covers supported UTF-8 artifact text and explicit gaps for unsupported content.
Legacy snapshots and method replays keep their original coverage. Text readability does not grant source rights or establish research quality.
The local development candidate adds [finite scheduling](docs/local-scheduling.md), a gated [TWSE monthly source adapter](docs/local-twse-monthly-source.md), and a [continuous worker](docs/local-background-worker.md).
Real native research, a second real update, other permitted sources, and external-user installation remain open.
The separate public hackathon candidate excludes these unfinished local loop modules.
Local [method artifacts](docs/local-method-artifacts.md) retain failure cases, candidate metadata, and frozen regression plans.
These records do not establish evaluation success or an active method release.

An optional [Solana research buyer](tools/x402-mcp-bridge/README.md) exposes one fixed Devnet research-purchase tool through MCP.
It requires a separately configured local seller, signer, and explicit human approval. Installing it does not enable payment.
See the [release status](docs/release-status.md) for verified behavior and remaining gates.
For a short product walkthrough, use the [hackathon review guide](docs/hackathon-review.md).
Use the [wallet-free judge check](docs/judge-check.md) to verify MCP discovery and the existing Devnet payment.
See [trading connections](docs/trading-connections.md) for the Jupiter handoff, Robinhood Chain evidence, and the separate broker MCP plan. Research payments do not authorize investment trades.
Use [the multi-chain judge check](docs/chain-review.md) to read canonical Robinhood Chain contract evidence without a wallet.

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
- `client/local/`: candidate run contracts, SQLite ledger, and bounded execution. See [the local library boundaries](docs/local-ledger.md).
- `client/local-cli.mjs`: opt-in local operations. See [configuration and recovery](docs/local-execution.md) and [finite scheduling](docs/local-scheduling.md). It installs no background service.
- `client/workspace-cli.mjs`: local-only Inbox and review interface. See [startup and review](docs/local-workspace.md).
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

The public onboarding prompts and API/MCP entrance supply research methods for the AI you already use.
The unpublished local client candidate stores private questions, research, and separate human review decisions on your machine.
It does not bundle the private hosted backend, source datasets, or curated commercial Research Packs.
The published default branch can lag a development candidate. Verify the exact source or supplied archive before installation.

The prompts are model-independent. Better models can improve synthesis and tool use, but the human remains responsible for the research question, source approval, materiality, and final judgment.

## License and risk

The repository is available under the MIT License. The bundled Inter font uses the SIL Open Font License. See [font attribution](client/local/assets/README.md).
Market and company information can become stale. Verify important claims against current primary sources before making a decision.
