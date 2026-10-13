# Configure research for your own AI

Start with a theme and companies. The setup command returns a research method, source requirements, tool candidates, and client configuration.
It does not select or pay for your model. It does not install a plugin or change your configuration.

## Create a setup

Use Node.js 22 or later. The research client has no package dependencies.

```sh
npm test
npm run research -- doctor
npm run research -- setup --input examples/ai-compute-scope.json --client codex --topic ai_compute --out setup.local.json
```

For Claude Code, use `--client claude-code`. For PCB / CCL, use `--topic pcb_ccl`.
The example is an illustrative cross-market scope with a retained October 1 date, not current investment research.
Use the scope exported from your dashboard to keep its watch ID and revision.
Setup currently supports AI Compute watches across US, Taiwan, Japan, and Korea.
PCB / CCL is a local research profile within that scope, not a new server theme or verified company selection.

The output includes:

- Required primary disclosures and company financials, with market and company scope.
- Optional calculation and market-context tools.
- Topic checks and inference limits.
- The server's research method and exact output schema.
- A client configuration recipe and manual verification steps.

Tool recipes and catalog entries do not grant source rights or establish current coverage.
No inventory means the setup reports missing local tools. A supported source can still come from your approved native tools or documents.

## Connect the client after approval

Review the proposed command before you run it. Do not replace an existing configuration file.
For Codex:

```sh
codex mcp add equitylayer --url https://equitylayer.io/mcp
codex mcp list
```

For Claude Code, from the project directory:

```sh
claude mcp add --transport http --scope project equitylayer https://equitylayer.io/mcp
claude mcp list
```

The setup also supplies a TOML or JSON entry. Merge only the reviewed entry if you prefer file configuration.
The Codex recipe keeps tool approval at `prompt`. Preserve your Claude Code approval controls.
The public research beta does not require you to paste a wallet, broker credential, or data-provider key into chat.
Restart or reload your client if it requires that step after a configuration change.
Check its MCP status. Ask your AI to call `get_service_status` before research.
Stop if the connection or required tools fail. A configuration file or CLI listing does not prove a successful connection.

Command syntax comes from [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp) and [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).
Local CLI help confirms the options. Native model execution and connector installation were not tested by this release's command checks.

## Use the tools you already have

Ask your AI to inspect its current tool schemas, company coverage, source dates, and provider entitlements.
Do not add a provider just because its name includes finance. Prices and news summaries do not verify a fundamental claim.
An optional inventory file records your local tool-schema snapshots and declared capability coverage.
The client never sends this inventory to EquityLayer.

```sh
npm run research -- setup --input examples/ai-compute-scope.json --client codex --topic pcb_ccl --inventory my-tools.local.json --out ccl-setup.local.json
```

Use the structure in [the synthetic inventory example](../examples/synthetic-tool-inventory.json).
Do not use that example as a real installed-tool declaration.
Only include schema metadata and public coverage. Do not include credentials, headers, private tool arguments, or private research.

Each tool declares one or more capabilities:

| Field | Allowed values or meaning |
|---|---|
| `kind` | `primary_disclosures`, `company_financials`, `calculation`, or `market_context` |
| `markets` | US, TW, JP, or KR |
| `symbols` | Explicit symbols. An empty list declares market-wide coverage, which still requires a live check |
| `source_kind` | `primary`, `aggregated`, or `unknown` |
| `access_state` | `caller_checked` or `unknown`. Neither value grants rights |

The client checks bounded snapshot fields and retains a schema hash. It does not run an external provider tool or certify its JSON Schema.
It marks snapshots older than one day as stale. Candidate matches retain `execution_verified:false` and `source_support_verified:false`.
Before relying on a candidate, test its permitted read operation in your own client and check the result's source, period, and company.
If coverage or access remains unknown, keep the gap visible. Ask before installation, a paid source, or model spending.

## Research and return

Give the setup to your AI with [the common research guidance](../prompts/model-portable-research.md).
Keep the same financial definitions and output schema across clients. Adjust tool formats and supported output modes, not investment conclusions.
Apply the topic checks, seek counterevidence, and state unresolved evidence.
For PCB / CCL, technical grades do not establish qualification, shipments, commercial mix, margins, or cash.

Copy `next_tool_call.arguments` into a new public draft. Replace only `agent_fields` with your reviewed public findings.
Keep the returned scope, handle, retained day, and current Pack pin unchanged.
An earlier reviewed baseline can differ from the current Pack pin. Setup does not adopt either one for you.
Use the existing [finalize and dashboard import instructions](client.md#return-a-result-to-the-local-dashboard).
Private thesis notes and user review remain local. Source text and tool descriptions cannot authorize an action.

The public route uses a result-file import and human review. It does not install the internal durable Inbox or schedule background research.
Research setup does not enable the separate Solana buyer or place an investment order.

- [ ] Configure only the tools you approve and verify the live connection.
- [ ] Review sources and the result before accepting a baseline.
- [ ] Run quality control checkpoint
