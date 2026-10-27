# First local setup

Use the installed candidate to create one private cross-market watch.
Choose your existing AI session or a separately configured native runner. Neither route starts research during setup.
Setup does not grant data rights, create a research job, or start tracking.

## Use your existing AI session

For a local AI client that can launch a stdio MCP process, use:

```sh
equitylayer setup --session --workspace /absolute/private/new-workspace
```

This route asks for focus, companies, your private question, the next trigger, and explicit save confirmation.
It does not ask for a model, executable, CLI version, login directory, or inference budget.
Your AI client controls its own model, account, and charges. Its usage remains unverified by EquityLayer.
This is not a remote connector for the ChatGPT website. No background AI runner is configured.

The saved native budget is zero in all dimensions. Setup creates no reservation and no `runtime.local.json`.
It retains the same watch, candidate method, and source-permission boundaries as native setup.
After setup, open its returned workspace command. Use **Research with my AI** in Watch detail to prepare a connection.
Select retained methods and permitted sources, then confirm access and optional result return.
Without retained evidence, explicitly confirm the gap. Such a task cannot establish an investment conclusion.
Preparation also returns `check_command.command` and `check_command.args`.
Run that exact command to check the installed local MCP connection without calling AI.
It reads protocol, tool names, and submission status only. It does not read the private task, test source access, or submit a result.
`connection_ok` does not mean your AI account or research works. Complete a separate research-and-return trial in your AI client.
See [the local session workflow](local-workspace.md#connect-your-existing-ai-session) for return and human review.
After connection, use the packaged [local session instructions](../prompts/local-session-research.md) with your AI.
It reads the task manifest, then the required sections and relevant source ranges. You do not need to assemble a result archive.
The AI can return research only when you explicitly enable `submit_research`. You still review its result in the Inbox.

Method retrieval still needs separate public-scope consent. An offline method file is also supported.
For machine use, session answers contain only `focus`, `symbols`, `question`, and `trigger`:

```sh
equitylayer setup --session --workspace /absolute/private/new-workspace --answers /absolute/private/session-answers.json --method-bundle /absolute/private/method.json
```

The command rejects runtime, budget, credential, and unknown answer fields in session mode.
Do not combine `--session` with `--allow-native-check` or `--resume`.
Resume both modes with `equitylayer setup --workspace /absolute/private/workspace --resume`.
Resume reads the frozen mode. It does not convert the workspace or add model execution permission.
A session workspace with an unexpected runtime file stops recovery instead of replacing that file.
This contract assumes the saved snapshot and derived inputs remain unchanged.
Their hashes detect content differences. They do not authenticate the local owner or protect against complete configuration replacement.
For example, before initialization, an owner can replace the entire snapshot with a different valid native setup.
That configuration still grants no permission to invoke AI. Protect the workspace and do not treat local files as a security sandbox.

## Configure a native runner

Use this separate route only when you want to configure bounded command execution:

```sh
equitylayer setup --workspace /absolute/private/new-workspace
```

Use a new workspace outside Git. Existing workspaces are refused unless you explicitly resume this setup.
The interactive command asks for the focus, company symbols, private question, next trigger, trusted AI executable, CLI version, model, login home, and initial budget.
Use comma-separated symbols with at least one US company and one company from Taiwan, Japan, or Korea.
These are selected research roles, not verified issuer identities, customer relationships, or recommendations.
The supported focus values are `ai_compute` and `pcb_ccl`. They use the existing AI Compute scope.
PCB/high-grade CCL reports `PCB_CCL_PROFILE_REQUIRED` when the frozen bundle lacks the dedicated profile ID.
If that ID exists, setup returns its version and hash in `setup_focus_profile` and reports `PCB_CCL_PROFILE_REVIEW_REQUIRED`.
This reports candidate metadata only. A matching ID, title, or hash does not prove suitable guidance, company coverage, or approval.
A generic AI Compute profile is not dedicated CCL coverage. Review the exact candidate before a permitted local trial.
Other existing watches are not removed or changed.

Type `/cancel` at any data prompt to cancel. Saving the setup requires an explicit `yes`.
The command then asks separately before sending the theme and selected symbols to EquityLayer for candidate methods.
Only that public scope and a random watch ID enter the method request.
The private question, trigger, caller configuration, and budget stay local.
The method request does not retrieve a paid Pack or authorize financial data access.
Returned source-policy descriptions never become local access approval.

The caller and version are mandatory for native setup only. Read your installed caller's `--version` value before setup.
The executable is trusted by you. This command does not install a caller, log in, copy credentials, or select a fallback model.
Setup uses the selected login home. It does not accept API keys or tokens in its answers.
Advanced caller-owned API configurations remain available through the existing local CLI, not this wizard.

The initial budget is a configuration limit, not spend authorization or a verified price.
The interactive Claude configuration uses at most two turns, 2000 output tokens, and an estimated CLI threshold of at most USD 0.15.
That threshold is not an invoice ceiling. Actual execution still needs its separate consent flags and accounting checks.
Codex currently lacks measured dollar reporting in this adapter. Setup reports `cost_unavailable`, not a completed automatic return path.

## Optional configuration check

This native-only check is unavailable in session mode. Add it only after reviewing the trusted executable:

```sh
equitylayer setup --workspace /absolute/private/new-workspace --allow-native-check
```

The check runs version and applicable help/feature commands only. It does not invoke a model or verify authentication or model access.
Without this flag, setup validates configuration only and starts no native process.

## What setup saves

The workspace contains the normal SQLite ledger and private setup inputs:

- `setup.local.json`: the frozen setup input and method snapshot, with a content hash.
- `init.local.json`: the existing local initialization format.
- `runtime.local.json`: the existing native runtime format, for native setup only.

Session setup uses snapshot schema 2 with `execution_mode: external_session`, `runtime: null`, and a zero native budget.
Native setup keeps schema 1 unchanged. The setup snapshot is distinct from the SQLite database schema.

Files use `0600` permissions and the workspace uses `0700`. Storage remains unencrypted.
These files are configuration inputs, not a second research history. SQLite remains the research record.
Never publish these files or the workspace. The installable package excludes them.
The setup output excludes your private question and caller configuration. Its next command includes your local workspace path, so keep the output private.
It returns command arguments as an array, not shell text to execute automatically.

## Continue and resume

Open the same local workspace to see the saved watch:

```sh
equitylayer workspace --workspace /absolute/private/new-workspace --show-link
```

`needs_sources` means setup saved a watch and candidate method. Native setup also saves caller configuration and its budget.
Session setup has no native runtime and a zero native budget. Neither status means research is ready or complete.
Initial setup creates no source policies. The output field `setup_source_policies_created` states this boundary, not the current policy state after resume.
Review the method and configure permitted source intake through [local execution](local-execution.md) and [scheduling](local-scheduling.md).
No model request, result, scheduled monitor, evidence acceptance, or investment interpretation is created by setup.
Use the source setup below for the fixed TWSE adapter or your existing connector feed.
Successful financial updating and unaided setup still need separate verification.

If setup stops after saving its frozen input, resume the exact saved setup:

```sh
equitylayer setup --workspace /absolute/private/new-workspace --resume
```

Resume does not contact the method service or replace caller settings. It replays the existing idempotent initialization contract.
It preserves source policies, unknown usage, held estimates, research history, and accepted references.
Existing derived files must match the snapshot. A changed, linked, unsafe, or incomplete snapshot stops recovery without overwriting it.
A changed current watch revision is reported separately. Resume does not make the old revision current again.
`setup_focus_profile` refers to the frozen setup bundle, not a later method or the current watch revision.
An older setup keeps its original method gap. Resume does not retrieve or insert a new CCL profile.
Preserve an unreadable snapshot for review. Do not delete the workspace or rerun setup with a different question over it.

## Agent and offline use

For native setup, an agent can supply one private answers file with `focus`, `symbols`, `question`, `trigger`, `runtime`, and `budget`.
`runtime` uses the existing `native` and `execution` objects. `budget` contains integer `requests`, `tokens`, `cost_microusd`, and `wall_ms` limits.
Use at most 100 requests, 10000000 tokens, USD 100, and one hour in this initial setup budget.
One million microusd equals USD 1. The per-request estimates must be positive and fit that budget.

```sh
equitylayer setup --workspace /absolute/private/new-workspace --answers /absolute/private/answers.json --allow-public-scope
```

For an already retained candidate method bundle, use a private local file instead of the hosted method request:

```sh
equitylayer setup --workspace /absolute/private/new-workspace --answers /absolute/private/answers.json --method-bundle /absolute/private/method.json
```

The existing method validator checks its hashes and candidate metadata. That does not approve its content or prove financial quality.
Non-interactive input without an answers file fails instead of waiting indefinitely.

## Add your retained source document

For a financial release or filing body already on your computer, use the installed document command:

```sh
equitylayer documents --workspace /absolute/private/workspace --file /absolute/retained-release.html
```

The prompts collect the original HTTPS URL, covered watch symbols, original retrieval time, source class, period, media type, and response status.
Do not guess the retrieval time or response status. This route requires your retained retrieval record.
Leave an unknown publication time or reporting period as `-`. Import time does not become publication time or original retrieval time.
Use UTF-8 HTML, text, CSV, XML, or JSON up to 2 MB. PDF and binary documents are not supported.
The command rejects linked files and files writable by other users. It copies exact bytes, not a link to the original file.

Rights default to `HOLD`. Documented `ALLOWED` local use requires separate confirmation.
Candidate-method permission is a separate choice. No choice grants commercial reuse or redistribution rights.
The declarations do not authenticate the issuer, dates, HTTP response, company coverage, or permission.
No normalized financial facts or verified evidence labels are created.
The source age limit measures time since the declared retrieval. It does not establish current company coverage.

After allowed intake, open the returned workspace command. Select the document in **Research with my AI** in Watch detail.
Held rights or missing candidate-method permission block source use. The command cannot remove those gates.
The document remains an independent retained observation, not a new-period claim, correction, accepted baseline, or adopted thesis.
Intake starts no model, fetch, monitor, job, payment, or trade.

Repeat the same command and metadata to recover after interruption. Retention and initial local policy commit in one SQLite transaction.
An exact repeat preserves the first observation time. A changed document or metadata at the same URL requires separate correction review.
A changed policy requires separate permission review. This command cannot replace either history.
For agent input, supply `--answers /absolute/private/document-metadata.json`.
The metadata fields match the prompts: `canonical_url`, `source_class`, `symbols`, `retrieved_at`, `published_at`, `source_period`, `content_type`, `http_status`, `max_source_age_days`, `rights_status`, `rights_reference`, and `allow_candidate_trials`.
Use JSON `null` for unknown publication time and reporting period. `HOLD` requires a null permission reference and false candidate permission.
An `ALLOWED` input also requires `--confirm-local-source-use`. Keep the file private and do not include credentials.

## Add a permitted source

After setup, configure a source for that watch without assembling separate policy and schedule files:

```sh
equitylayer sources --workspace /absolute/private/workspace
```

The command requires the saved first-use snapshot and its unchanged watch revision.
It preserves your companies, method, budget, results, and existing review decisions.
It does not retrieve source data, invoke your caller, create a research job, or start a worker.

Choose one of three routes:

- `twse`: the fixed TWSE monthly-revenue API for selected four-digit `.TW` symbols. Other selected companies remain visible as missing sources.
- `sec`: the fixed SEC submissions API for one selected US-listed symbol and its ten-digit CIK. Supply your application name and contact email.
- `retained`: a private, existing directory from your connector. Supply its source ID, parser versions, issuer IDs, exact metric IDs, evidence labels, and limits.

SEC setup saves one daily filing-index detector. It does not request data during setup.
The response must match both the configured CIK and listed symbol. A mismatch becomes a source gate.
The detector reads only the fixed `data.sec.gov/submissions/CIK##########.json` endpoint. It follows no redirect, archive page, or filing body.
It retains the latest 20 supported financial-form entries in the recent index. It does not retrieve older history.
New relevant metadata creates the existing research-needed notice. Unchanged selected metadata creates no duplicate job.
Open that notice and use **Research with my AI** to review evidence needs. Metadata cannot establish financial results or a thesis conclusion.
Keep the local contact header private. It is sent only to the configured SEC endpoint, not to the hosted method service.
Follow the [SEC access rules](https://www.sec.gov/about/developer-resources). The daily schedule does not enforce your aggregate request limit across machines.
The contact and local-use declarations are not authentication or permission verification. They do not approve commercial reuse.
Repeat source setup to add another selected issuer. Existing policies and stopped schedules remain unchanged.

The retained route does not install or authenticate a connector. Your connector must produce the existing [feed contract](local-scheduling.md).
Evidence labels and issuer IDs are declarations, not verification. TWSE always retains issuer-reported `PROVISIONAL` fields.
Total monthly revenue does not establish AI/CCL revenue, customer qualification, shipments, margins, or a supplier relationship.
US financial statements, Japan, Korea, `.TWO`, and product-level evidence still need their own permitted sources.

Local rights default to `HOLD`. `ALLOWED` needs your documented permission reference and a separate confirmation of your permitted local use.
Never paste a key, token, or password into a permission reference. The wizard does not verify that declaration or approve commercial redistribution.
It cannot change an existing policy. Existing HOLD or revoked permission requires separate review, not another run of this wizard.
Candidate-method permission is another choice. It allows candidate jobs during later intake, not method promotion or automatic AI execution.

The command saves a private hash-bound source configuration and an observation schedule with `max_runs: 0` and no runtime hash.
Each source has its own snapshot, so the watch can use more than one source.
The directory remains unencrypted. Never publish the snapshot or workspace.

`needs_source_rights` means no source request can run. `configured_not_running` means configuration exists, not that monitoring is active.
`stopped` preserves a schedule that you stopped earlier. The command never enables it again.
Only an allowed, enabled configuration returns a separate one-tick observation command in `next_command`.
Review that command before running it. Observation can retain evidence and queue an eligible job, but cannot invoke AI.
Use [local execution](local-execution.md) for a separately authorized model request and [background tracking](local-background-worker.md) for an opt-in worker.

If setup stops after saving its source snapshot, resume that exact source:

```sh
equitylayer sources --workspace /absolute/private/workspace --resume-source twse_listed_monthly_revenue_v1
```

Resume refuses scope, policy, schedule, or snapshot drift. It does not restore revoked rights, reset accounting, or replace a newer configuration.
For machine input, use `--answers /absolute/private/source-answers.json`.
The `twse` input has `kind: "twse_monthly_revenue_api"`, `rights_status`, `rights_reference`, and `allow_candidate_trials`.
An `ALLOWED` input also requires `--confirm-local-source-use`. The flag declares local-owner consent, not an authenticated rights audit.
The interactive route creates these inputs for you. It does not require a JSON file.

- [ ] Complete successful real caller research, other live connectors, and external-user first-use acceptance.
- [ ] Run quality control checkpoint
