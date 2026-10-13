# Public research setup verification and QC

Date: October 12, 2026. Scope: public client candidate, not the private backend or internal research loops.
This record describes pre-publication checks. Check GitHub main and CI for source publication.

## Product change

`setup` reads the hosted research plan and builds evidence requirements for each company.
It can match caller-declared local tool schemas and return a manual Codex or Claude Code configuration recipe.
AI Compute and PCB / CCL profiles use the same financial output contract. PCB / CCL is a local profile within an AI Compute watch, not a new server theme.
Tool inventory stays local. Its coverage is a caller declaration, not verified access or source rights.
The command does not install tools, run a model, finalize findings, accept a baseline, pay, sign, or order.

## Test counts

The client baseline was 39 tests after the deadline repair. Setup adds 23 tests, for 62 total.
The separate buyer suite remains 104 tests. Do not combine repeated runtime counts.

| Final local run | Passed | Failed | Cancelled | Skipped | Duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| Public client, Node 22.13.0 | 62 | 0 | 0 | 0 | 334.036792 ms |
| Public client, Node 24.19.0 | 62 | 0 | 0 | 0 | 258.79975 ms |
| Independent QC full client, Node 25.2.1 | 62 | 0 | 0 | 0 | 331.886417 ms |
| Independent probes plus repository setup tests, Node 25.2.1 | 42 | 0 | 0 | 0 | 309.100958 ms |
| Solana buyer, 10 test files | 104 | 0 | 0 | 0 | 1.82 s |

The focused 42-test run includes 19 independent probes and the 23 repository setup tests.
The buyer typecheck also passed. Its unit tests use synthetic signing and settlement responses.
The main-agent Node 22 and 24 command was `node --test --test-timeout=15000 tests/*.test.mjs`.
Independent QC ran `npm test`, which uses `node --test tests/*.test.mjs`.
Buyer commands were `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm test`, and `pnpm typecheck`.

## Manual hosted setup runs

Both runs used the public cross-market example and its retained October 1 scope.
They returned the hosted plan through the actual public client. No inventory, private notes, or provider credentials were sent.

```sh
node client/cli.mjs setup --input examples/ai-compute-scope.json --client codex --topic pcb_ccl --out codex-setup-reviewed-20261012.local.json
```

```json
{"saved":"codex-setup-reviewed-20261012.local.json","command":"setup","accepted_baseline":false}
```

```sh
node client/cli.mjs setup --input examples/ai-compute-scope.json --client claude-code --topic ai_compute --out claude-setup-reviewed-20261012.local.json
```

```json
{"saved":"claude-setup-reviewed-20261012.local.json","command":"setup","accepted_baseline":false}
```

Generated files were local, ignored, and mode 0600. No client configuration was applied.
Local `codex mcp add --help` and `claude mcp add --help` confirmed the command options only.
These runs do not establish a native AI connection, model research execution, or equivalent financial judgments across models.

## Fresh historical payment checks

Direct proof:

```sh
pnpm judge:check --chain
```

```text
Proof: Direct buyer execution
PASS: Historical proof metadata matches the retained transaction and delivery identifiers.
PASS: MCP initialization and tool discovery: request_taiwan_monthly_revenue_monitor_v1
PASS: Devnet transaction finalized. Buyer: -0.05 USDC. Seller: +0.05 USDC.
No purchase tool was called. No wallet was loaded. No transaction was submitted.
The public proof contains metadata only. This check cannot recompute the complete research output hash.
```

MCP proof:

```sh
pnpm judge:check --mcp-proof --chain
```

```text
Proof: MCP stdio purchase
PASS: Historical proof metadata matches the retained transaction and delivery identifiers.
PASS: MCP initialization and tool discovery: request_taiwan_monthly_revenue_monitor_v1
PASS: Devnet transaction finalized. Buyer: -0.05 USDC. Seller: +0.05 USDC.
No purchase tool was called. No wallet was loaded. No transaction was submitted.
The public proof contains metadata only. This check cannot recompute the complete research output hash.
```

These checks read existing Devnet transactions. They do not establish a new purchase or a public seller.
The buyer still requires the private, separately configured loopback seller for a fresh purchase.

## Independent checkpoint

Result: PASS for the bounded engineering scope. No checked blocker remains.
The reviewer checked private-field rejection, local-only inventory, pinned scope and Pack version, exact delivery metadata, malformed methods, result schema shape, missing tools, stale snapshots, session closure, and output overwrite protection.

Initial defects remain part of the record:

1. Extra credential and acceptance fields in delivery metadata were copied. The planner now rejects extras and supplies fixed local review instructions.
2. A non-object result contract was accepted. The planner now requires the exact public fields and their types.
3. A missing method and non-list checks were accepted. The planner now requires bounded method and check-list structures.

All three independent negative cases pass after repair.
Earlier positive-fixture failures omitted the required outer handle or complete delivery shape. They were fixture errors, not additional product defects.
The requested global checkpoint instruction file was unavailable. The configured independent QC role supplied this bounded review.
There was no browser, renderer, native client installation, actual model call, payment, order, or deployment acceptance.

## Founder gates

The [official event page](https://colosseum.com/worldsfair), checked October 12, lists October 12, 2026 as the submission date. Verify its exact cutoff in the signed-in portal.
The [official FAQ](https://colosseum.com/hackathon) asks for registration, team details, a repository link, a two-to-three-minute pitch, a demo of no more than three minutes, and go-to-market evidence.
Disclose prior development work. Report current user and revenue evidence without inventing traction.
No application was submitted by this checkpoint. Seller reviewer access and founder videos remain separate requirements.

- [ ] Confirm the submitted source version and reviewer access.
- [ ] Complete founder materials and submit before the portal cutoff.
- [ ] Run quality control checkpoint
