# Connect caller-owned native research

Internal candidate on `codex/thesis-local-run`. This driver is not in the public release.
It connects a caller-selected Codex or Claude Code CLI to the existing local run and Inbox contracts.
The caller supplies an installed executable, exact CLI version, model, and approved authentication environment.
The driver does not install tools, log in, buy a model subscription, or change daily settings.

## Private configuration

Use the existing `execution` settings and estimates from [local execution](local-execution.md).
Replace `command` with `native`. Do not supply both fields.
Save the runtime file with mode `0600`.

```json
{
  "native": {
    "allow_native_research": true,
    "provider": "claude-code",
    "executable": "/absolute/path/to/claude",
    "model": "YOUR_SELECTED_MODEL",
    "cli_version": "YOUR_INSTALLED_VERSION",
    "env": { "HOME": "/absolute/caller/home", "PATH": "/approved/executable/search/path" },
    "timeout_ms": 120000
  },
  "execution": {
    "estimate": { "tokens": 10000, "cost_microusd": 100000, "wall_ms": 120000 },
    "timeout_ms": 120000,
    "lease_ms": 30000,
    "heartbeat_ms": 5000
  }
}
```

All values above are placeholders or example limits, not a tested login or price.
The model is mandatory. The harness does not choose a replacement or fallback.
For Codex, select `provider: "codex"` and its exact executable and version.
Keep the complete Codex version, including preview or build identifiers such as `0.162.0-alpha.17.2`.
Versions must remain bounded exact identifiers. Channel aliases such as `alpha` or `latest` are not accepted.
Inspection still compares the complete installed version and checks the required disabled features.
Accepting a version identifier does not certify model access, login validity, CLI compatibility, or research quality.
Review a changed CLI before updating its pin. Claude Code still uses its existing stable-version format.
An optional `CODEX_HOME` or `CLAUDE_CONFIG_DIR` selects caller-owned authentication storage.
HOME must identify an explicit absolute caller-approved authentication home.
Only approved environment entries enter the child process. No ambient key is inherited.
Native CLI authentication can use local storage or OS services. This driver does not certify their isolation.
Never put credentials in a public file, prompt, source artifact, or research result.

Use the existing commands:

```sh
npm run research:local -- run --workspace /absolute/private/workspace --runtime private-runtime.json --allow-private-context --allow-candidate-method
npm run research:local -- schedule-runtime --workspace /absolute/private/workspace --runtime private-runtime.json
```

The finite scheduler can use the returned runtime hash after an explicit schedule revision.
Selecting a runtime does not grant source rights, approve a method, or start a background service.

## Check setup before research

After reviewing your trusted executable and private runtime file, run:

```sh
npm run research:local -- runtime-check --runtime /absolute/private/runtime.json --allow-native-check
```

This command needs no workspace. It does not open SQLite, send a research prompt, or invoke a model.
It runs `--version` for both providers and `features list` for Codex.
The same version and feature checks run before research execution.
The executor now runs a bounded management check before it reserves a model request.
That check uses version, applicable feature, and requested cost-control checks only.
It does not send the research prompt or check authentication or model access.
It lasts at most five seconds and cannot exceed the remaining lease or execution time.
The executor deducts that elapsed time from its remaining dispatch deadline.
Source and method gates, input bounds, consent, and estimate validation still precede the check.
Generic command runtimes do not enter the native management check.
An already settled response can resume without a new management command.

A failed setup check retains a named failure with no model request or reservation.
This permits configuration repair without inventing an unknown model charge.
Execution still repeats the management checks after dispatch to detect runtime changes.
A later failure preserves the existing unknown-usage gate and full reservation.
This change does not reclassify or retry any older request.
The check uses only your declared environment, bounded output, cancellation, and a total deadline.
The executable remains caller-trusted. Its management commands are not an OS sandbox.

`configuration_checked` means that the declared CLI version and applicable feature checks passed.
It does not prove authentication, selected-model access, source rights, financial correctness, or Inbox delivery.
`authentication` and `model_access` remain `not_checked`. `execution_authorized` remains false.
The `native.allow_native_research` setting selects the opt-in driver. This setup check does not grant execution consent.
Codex reports `accounting: cost_unavailable`. Claude reports `accounting: provider_report_unverified` until a real result reports usage.
Neither report replaces the existing usage gate or estimates a missing charge.
The output omits credentials and local configuration paths. Keep configuration hashes private when sharing diagnostics.
Generic command runtimes cannot use this check to execute their own arguments.

The returned `runtime_sha256` includes execution settings and can identify a reviewed schedule runtime.
Editing this adapter changes its runtime hash. Review a new exact runtime and schedule revision before execution.

## Research behavior

The driver reads the common instructions from `prompts/model-portable-research.md`.
Its configuration hash includes those instructions, the result schema, adapter source, retained-content renderer, provider, model, CLI version, environment, and bounds.
Changing these pins requires explicit runtime review. Existing generic command configurations remain compatible.
The executable and dependencies are caller-trusted. The configuration hash does not authenticate their binaries.

New execution snapshots include pinned facts, source metadata, methods, private context, and supported retained source text.
The text preserves every UTF-8 byte of the retained artifact. No HTML rendering or link retrieval occurs.
Supported media include JSON, plain text, CSV, HTML, and XML. PDFs, other binary data, and unsupported encodings remain explicit coverage gaps.
Complete retained text does not establish that the artifact contains the publisher's complete document or sufficient research evidence.
An unavailable record still requires valid source metadata and exact source references.
Older snapshots remain unchanged. A legacy snapshot without source text cannot claim direct document review.
Method trials preserve the captured snapshot's original coverage. They do not acquire later source content.
The combined context must fit the ledger's 2,000,000-byte limit. The default native prompt limit is 600,000 bytes.
An explicit native configuration can raise its prompt limit to 2,000,000 bytes. These limits do not establish model context capacity.
Oversized input gates before request reservation. The driver does not silently truncate evidence or retry a size failure.
This first driver is retained-evidence-only. It does not discover sources or use other finance plugins.
Missing capabilities and evidence must remain explicit in the research output.
Completing the live-source and native-tool workflow remains separate work.

Codex receives a structured output schema, read-only mode, and disabled execution, browser, plugin, hook, and agent features.
The installed CLI must report the named feature controls before dispatch.
Claude receives an empty tool and MCP catalog, disabled hooks and skills, and a six-turn bound.
Both run in a new private temporary directory. Private prompts travel through stdin, not command arguments.
The driver does not use a permission-bypass flag. These controls do not certify the provider or form an OS sandbox.

The same existing validator checks result fields, dates, retained source URLs, missing baselines, and research-advice limits.
No new advice regex or alternative financial validator was added.
Structured output does not establish factual correctness or claim support.
Results enter the existing Inbox only after the ledger's source, usage, budget, and delivery gates pass.
No import or result receipt adopts an investment thesis.

## Usage and failures

### Optional Claude invocation controls

The internal candidate accepts this optional `native.claude_limits` object:

```json
{
  "max_budget_microusd": 150000,
  "max_output_tokens": 1000,
  "max_turns": 2
}
```

These are example controls, not a model price or an approved budget.
Supply all fields together. The turn bound is one to six, and the output bound is one to 32,000 tokens.
The budget bound is one to 100,000,000 microusd. One million microusd equals one USD.
Codex configurations cannot use Claude-specific controls.

The configuration is detached before validation and includes the controls in its immutable hash.
Shared setup and execution checks require the exact advertised `--max-budget-usd` flag.
Claude help can omit the documented `--max-turns` flag. Its absence alone does not reject the installed CLI.
The driver still supplies the explicit turn argument. An unsupported invocation fails rather than removing a requested bound.
The driver applies the output-token variable and disables CLI API and structured-output retries for that process only.
The caller environment and daily settings do not change.

Inspection reports `cost_control: client_estimate_only` and `billing_ceiling_verified: false`.
Advertised flags and synthetic process tests do not prove provider enforcement.
The [official CLI reference](https://code.claude.com/docs/en/cli-reference) states that spend can pass the estimated threshold.
The documented newer-version behavior for stopping subagents does not justify a blanket upgrade requirement for this tool-disabled invocation.
Use headroom and review your account's billing controls. This driver does not guarantee an invoice ceiling.
The existing request budget and unknown-usage gates remain independent of these CLI controls.

Claude usage comes from CLI `modelUsage` counters and `total_cost_usd`, not generated research text.
The cost is the CLI's reported amount. It is not a verified invoice or guaranteed billing ceiling.
Missing counters or cost remain unknown. They do not become zero or the configured estimate.
Codex's checked event format reports tokens but no measured dollar amount. Its response therefore retains unknown usage.
Under the current ledger contract, that creates `USAGE_UNKNOWN` and prevents Inbox delivery.
The Codex accounting integration is still incomplete. Do not advertise it as a completed automatic return route.

Authentication errors, version changes, permission denials, failed turns, malformed JSON, and unsupported capabilities fail closed.
One total deadline includes version and capability checks before the model command.
Output limits, cancellation, and POSIX process-group termination bound the invocation, with a 100 ms forced-kill grace.
An invalid research result retains reported usage before the existing validator blocks delivery.
Raw stdout and stderr do not enter error messages or stored research fields.
The adapter does not retry a model call. Existing uncertain-request and receipt reconciliation rules still apply.

For new failures, `research:local status` includes `execution_failure` on the affected gate.
It contains a fixed failure code, request ID, observed dispatch state, and fixed explanatory text.
The ledger stores this observation and the gate in one transaction. A failure cannot commit only one of them.

Codex now preserves two fixed event observations instead of reducing both to an invalid-output error:

- `NATIVE_TURN_FAILED_REPORTED`: the bounded JSONL stream ends with one valid `turn.failed` event and no completed turn.
- `NATIVE_CALLER_ERROR_REPORTED`: the stream ends with one valid `error` event, without a failed or completed turn.

These labels report event structure only. They do not establish authentication, model availability, MCP startup failure, or provider billing.
The classifier does not read message wording for a cause. Source text inside an agent message cannot supply a diagnostic label.
Malformed or contradictory events retain the generic failure. Raw messages remain excluded from errors and stored records.
The [official non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode) documents the JSONL event types.
This adapter does not assume that Codex error messages contain stable reason codes.

The 2026-10-21 authorized native MCP attempt remains failed, with zero external results and unverified usage.
Its discarded raw error cannot be reconstructed or retrospectively classified by this change.
No additional real model call was made to test these diagnostics. Synthetic processes verify the labels and unchanged accounting gates.
This change does not complete real AI research return, a second source update, or product acceptance.
The accounting gate remains separate. A native command failure does not establish authentication failure, model inference, or a charge.
An unknown request keeps its reservation and cannot retry automatically.
Older attempts without this diagnostic remain unknown. The harness does not reconstruct a cause from missing output.
This status field is available through the local CLI and workspace status API.
The local workspace displays the fixed failure explanation and accounting state before technical identifiers.
The [portable verification boundary](local-verification-status.md#what-the-checks-establish) describes the isolated desktop and mobile checks.

## Verification scope

The process tests use a synthetic native CLI. They verify flags, parsing, cancellation, and the actual local CLI-to-Inbox route.
They do not prove native model authentication, source support, or equivalent outputs across models.
Actual installed management help was checked for Codex 0.144.5 and Claude Code 2.1.150.
The [retained-source boundary](local-verification-status.md#research-and-readable-sources) separates readable delivery from research acceptance.
No native research call, payment, signature, order, push, or deployment occurred in the retained-content implementation stage.
An earlier read-only login-status check reported an authenticated Claude account. It did not verify a model request or resolve the earlier OAuth failure.

References: [OpenAI CLI reference](https://learn.chatgpt.com/docs/cli/reference) and [Claude CLI reference](https://code.claude.com/docs/en/cli-reference).
Current vendor documentation can differ from the installed version. Local help and explicit version checks remain necessary.

## 2026-10-21 pre-dispatch verification

Symptom: a version, capability, or requested-control mismatch created an unknown-usage request before any inference command could run.
Root cause: the executor marked dispatch before the native driver's management checks.
Fix: run a bounded native preflight before reservation. Repeat checks after dispatch to detect runtime drift.
The first three repository regressions failed before the fix. Each returned USAGE_UNKNOWN instead of its setup failure code.
After repair, all three retain zero requests, zero reservations, and a durable named failure with dispatch state none.

Independent QC found a second-controller race in the first implementation.
Another connection could run preflight and gate a currently dispatched regular run.
The early owner/fence guard now protects regular runs and method trials.
The permanent concurrency regression failed before this guard repair and passed afterward.

Final complete suite, Node25.2.1,42 test files:

```text
tests 900
pass 900
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 56730.487458
```

The previous complete result was894/894 from the workspace failure repair.
An intermediate899/899 result preceded the concurrency repair and is not the final verification.
The final independent synthetic probes passed10/10 twice.
They checked lease/deadline expiry, cancellation, HOLD races, elapsed-time accounting, settled reuse, generic runtimes, drift, and cleanup.
QC report: `.qc/2026-10-21-native-predispatch-qc.md`.
The complete logs remain under `.qc/2026-10-21-native-predispatch-full-final.log`.

Two management-only runs used the installed Claude Code2.1.150 and the retained public detector input.
Both returned the same result:

```json
{"status":"management_preflight_passed","provider":"claude-code","cli_version":"2.1.150","authentication":"not_checked","model_access":"not_checked","model_called":false,"research_prompt_sent":false,"workspace_read_only":true,"protected_files_unchanged":3,"unknown_requests_preserved":1,"inbox_delivery_verified":false,"billing_invoice_verified":false}
```

The old trial's independent read-only probes also passed8/8 twice.
The management script was run twice. It cannot dispatch research.

### Separate newly authorized diagnostic trial

The user then approved one new independent Claude diagnostic attempt.
The attempt used a private diagnostic proxy around the same installed CLI and model.
The proxy passed the same model arguments and prompt through. It did not act as a mock model.
It retained only fixed failure categories, byte counts, exit status, and booleans on failure.
Raw error output was not saved. The proxy is not part of the installable client.

Bounds: four turns,120 seconds,USD1 local reservation,USD0.25 CLI estimate threshold, and no automatic retry.
The estimate threshold is not a verified invoice ceiling.
Only the existing159620-byte public SEC filing-discovery detector was used.
No new source was retrieved. Detector metadata is not current financial research.

The attempt ended after5903ms with one unknown request and no receipt, Inbox delivery, review, or acceptance.
The full USD1 reservation remains held. Numeric spent-zero fields do not prove zero actual usage.
The process returned JSON and exit code1. No fixed error category matched.
The provider cause remains unverified. The preflight fix is not described as a fix for this trial.
The single-use guard and marker prevent another inference attempt from this script.
All three previous trial database digests match the new manifest.
The new workspace reopens with its accounting gate intact.

Retained result: `.qc/claude-diagnostic-2026-10-21/result.json`.
Independent record QC passed8/8 twice. Four database digests and12 protected file hashes remained unchanged during each read-only probe.
Report: `.qc/2026-10-21-native-diagnostic-record-qc.md`.
The private proxy does not itself type-check num_turns in a reduced failure envelope. Parent parsing remains fail-closed.
This instrumentation limit does not establish a provider cause or affect an approved public release.
This authorization is consumed. Do not retry this request or another unknown request.
The real research-to-Inbox acceptance remains incomplete.

The investigate workflow required a reproduced defect before implementation.
STE-flavored guidance kept this report separate from unproven provider-cause claims.

- [ ] Verify caller authentication and one explicitly authorized native research run.
- [ ] Complete Codex accounting, approved live sources, and native tool capability support.
- [ ] Run quality control checkpoint
