# Research client compatibility checkpoint

Date: October 2, 2026. Target: local release candidate.
Branch: `codex/hackathon-public-client`.

## Changes

- Add `doctor` to check required research tools before a demo.
- Check tools before `begin`, `finalize`, and `instrument` send input.
- Read all discovery pages, with a 20-page limit and cursor checks.
- Stop on invalid or incomplete discovery. Do not report a partial list as complete.

## Automated checks

The previous client suite contained 17 tests. The current suite contains 22 tests, all passing on Node.js 25.2.1.
An independent QC reviewer ran the same suite: 22 passed, zero failed.
The reviewer found no blocker for a local commit. `git diff --check` passed.

The new tests cover missing tools, blocked draft transmission, exit codes, session cleanup, pagination, and malformed discovery.
The existing tests continue to cover transport limits, result files, and prohibited payment or execution tools.

## Real endpoint checks

Each check ran twice. No payment, signature, order, or baseline acceptance occurred.

| Endpoint | Run 1 | Run 2 |
|---|---|---|
| `https://equitylayer.io/mcp` | Exit 2. Missing `begin_research` and `finalize_research`. No instrument mapping tool. | Same result. |
| `http://127.0.0.1:3100/mcp` | Exit 0. Required research tools and instrument mapping tool present. | Same result. |

Both outputs identify the check as `tool_discovery_only`.
Both retain `research_execution_verified: false` and `payment_verified: false`.
A passing check confirms tool names, not schemas, source coverage, result quality, or payment.

## Retained-data replay

The updated CLI ran `begin` twice against the compatible local server with `examples/ai-compute-scope.json`.
Both plans had SHA-256 `5048155610fdba292c8507f8ccf632982e4e82ae9a8e9a53ac73459124c83918`.
The retained day was October 1, 2026.

The updated CLI ran `finalize` twice with the previously reviewed public source-gap draft.
Both runs saved a `SOURCE_NEEDED` result for local import and explicit user review.
Both returned `accepted_baseline: false`.
Both warned that no supplied source matched a registered official host.
The draft was hand-authored. This replay does not measure model research quality or complete cross-market coverage.

## Release decision

The local client change passes QC. The hosted research workflow remains blocked on a compatible deployment.
Do not present this report as proof of public release, successful payment, or a completed hackathon submission.
The source candidate still requires a judge-accessible dashboard and seller, payment evidence, and the final submission materials.
