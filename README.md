# EquityLayer research onboarding

**Fundamental research layer for AI agents.**

EquityLayer gives the AI you already use one MCP connection for investment research. Your agent can track the variables behind your own thesis, or follow a Research Pack we publish, and tell you when something moved. You keep the judgment. EquityLayer never says what to buy, sell, size or time.

This repository is the public starting point: how to connect, a prompt to paste into your AI, and templates for your own research notes.

## Connect

Add one MCP server to your AI client. No account is needed to read public research.

```text
https://equitylayer.io/mcp      (Streamable HTTP)
```

- **Claude Code:** `claude mcp add --transport http equitylayer https://equitylayer.io/mcp`
- **Codex, Cursor, Claude Desktop and others:** add a remote HTTP MCP server with the URL above.
- **Agents without MCP:** read [`https://equitylayer.io/llms.txt`](https://equitylayer.io/llms.txt).

`https://equitylayer.io/mcp/full` lists every tool on the same server. It is not a second connection.

## Two ways to use it

### 1. Bring your own thesis

You state a thesis in your own words. Your agent maps it to the variables EquityLayer tracks, you agree what each one should show, and your agent checks them on a schedule.

1. `plan_thesis_tracking`: give it your thesis, and the companies or terms you mean. It returns candidate variables with what each can't show, plus gaps where nothing in the catalog measures your point.
2. Write the four parts with your agent: **hypothesis**, **why**, **tracking** (each link, its variables and what a reading means) and **wrong_if** (what would make you admit it's wrong). The thresholds are your judgment.
3. `check_thesis_harness`: returns each link's status (`not_due`, `seen`, `against`, `late`, `no_data`), which `wrong_if` conditions fired, and what needs a person. Save the `next_baseline` it returns and pass it back next time to see only what changed.

You keep the harness and the baseline. EquityLayer stores neither. The full loop is in the skill at [`https://equitylayer.io/skills/thesis-harness.md`](https://equitylayer.io/skills/thesis-harness.md).

### 2. Follow a Research Pack

A Research Pack is a curated thesis with the variables it tracks, the evidence, and what would prove it wrong.

1. `list_registry`: find current Packs. An empty list means no Pack is published yet; your agent should say so, not substitute something else.
2. `get_research_pack`: read the thesis, evidence, tracked variables and next check.
3. `create_research_follow`, then `check_research_follow` with the saved Follow Card whenever you want an update.

The current research themes are **CPO, Physical AI and space infrastructure**. Their first Packs are in review and not published yet.

## Paste this into your AI

Start with [`prompts/mcp-onboarding.md`](prompts/mcp-onboarding.md). It sets the boundaries above and walks your agent through either path.

## What's here

- `prompts/mcp-onboarding.md`: the prompt to paste into your AI.
- `prompts/onboarding.md`: set up your first research workspace without any tools.
- `prompts/review-update.md`: compare new evidence with a saved baseline.
- `templates/`: a research brief, a source map and a tracking dashboard for your own notes.
- `archive/2026-10/`: the October 2026 workflow (research client, Devnet payment demo, trading connections). It no longer matches the service and is kept for the record only.

## Boundaries

- Research, not advice. No trade instructions, target prices, position sizes or timing.
- A person decides. Tool results that need judgment say so.
- Data comes from official sources with dates. Readings from some company decks are withheld until their rights are reviewed; the tools say when.
- No wallet, broker or payment permission is needed or requested.

## License and risk

MIT License. Market and company information can become stale. Verify important claims against current primary sources before you rely on them.
