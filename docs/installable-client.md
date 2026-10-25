# Install the local client candidate

This package is an unpublished candidate. A tarball install does not establish product acceptance or grant source rights.
A bounded checkout-based Codex session returned financial research from retained TTM and EMC disclosures. The result survived reopen.
Human review, a second real update, installed native-caller acceptance, and external-user pilots remain incomplete.
The public hackathon repository does not yet contain these local loop modules.

## Requirements

Use Node 22.13 or later and npm on macOS or Linux.
Local installation checks cover macOS on Node 22.13.0, 24.19.0, and 25.2.1.
Windows and fresh Linux installation still require separate acceptance. Node 22 SQLite support is experimental.
Bring your own AI client and account. Private session mode needs a client that can launch local stdio MCP.
Native runner mode separately needs an installed supported Codex or Claude Code. Installation does not authenticate either caller.
The package contains no source dataset, private research, account credential, wallet, seller, or payment bridge.
It has no runtime package dependencies and no install lifecycle scripts.

## Install a reviewed artifact

Obtain a reviewed candidate tarball from its maintainer. Check its supplied SHA-256 with your local hashing tool before installation.
There is no published npm-registry release or automatic updater in this candidate.
Use a new installation directory. Keep private workspaces outside that directory.

```sh
npm install --prefix /absolute/path/to/equitylayer-install --ignore-scripts --offline --no-audit --no-fund /absolute/path/to/reviewed-client.tgz
/absolute/path/to/equitylayer-install/node_modules/.bin/equitylayer --help
/absolute/path/to/equitylayer-install/node_modules/.bin/equitylayer --version
```

The commands above install a supplied artifact, not an arbitrary download or a package selected by name.
The installed documentation is in `node_modules/equitylayer-research-client/docs/` under your installation directory.
The font and its license are included in the package. No build step is required.

## Use the entrances

For your existing AI session, use [first-use setup](first-use.md): `equitylayer setup --session --workspace /absolute/private/new-workspace`.
This route creates no model configuration or inference reservation. The user's AI client controls its charges.
For a separate native runner, omit `--session` and supply its configuration and budget.
It collects configuration interactively and retrieves candidate methods only after public-scope consent. It does not start research.

Use the installed `equitylayer` command in place of the source-checkout commands:

| Existing command | Installed command |
| --- | --- |
| `npm run research -- …` | `equitylayer research …` |
| `npm run research:local -- …` | `equitylayer local …` |
| `npm run research:workspace -- …` | `equitylayer workspace …` |

Running `equitylayer` without arguments shows help only. It does not connect, create a workspace, or invoke a model.
The `research` entrance uses the public API/MCP. Send public research only. Run `research doctor` to check hosted tool availability.
The `local` entrance operates private SQLite jobs. Follow [local execution](local-execution.md) to configure the watch, method, budget, and approved source policies.
Its `run` command still requires a private runtime and both execution consent flags.
Use [native setup](native-research-runtime.md) to check the caller configuration without a model request.
The `workspace` entrance provides private review on `127.0.0.1`. It does not invoke AI or accept an investment thesis automatically.
The draft `session` entrance connects an existing AI client through private stdio MCP.
It exposes one prepared task only. See [the session boundary and remaining limits](local-workspace.md#connect-your-existing-ai-session).

```sh
equitylayer local --help
equitylayer local runtime-check --runtime /absolute/private/runtime.json --allow-native-check
equitylayer workspace --workspace /absolute/private/workspace --show-link
```

Use the explicit private session link only on your own machine. Do not share it.
Stop the foreground workspace with Ctrl-C. Installation does not start a background worker or an OS service.
Research methods and source approvals are separate from installing code. Missing or held evidence remains a named gate.
Setup generates the private JSON inputs for you. `equitylayer sources --workspace /absolute/private/workspace` adds a permitted source configuration.
It supports the fixed TWSE API or an existing private connector feed. It does not grant verified rights or start tracking.
Follow [first-use source setup](first-use.md#add-a-permitted-source) before observation. Other live connectors and the complete real caller flow remain incomplete.

## Backup before an upgrade

Stop any worker that uses the workspace. Create a new backup with the already-installed version that owns that workspace:

```sh
equitylayer local backup --workspace /absolute/private/workspace --name before-upgrade.sqlite
```

Keep that backup private. Install the reviewed new artifact into a different installation directory.
Normal commands refuse an older schema with `SCHEMA_UPGRADE_REQUIRED`. They do not authorize a schema upgrade.
This includes setup resume, source setup, session preparation, session serving, workspace startup, and local commands.
The empty workspace entrance can still create a new current-schema database. That is not an old-schema upgrade.
Preserve the original workspace and its backup. Use the new client's explicit upgrade command only for a new copy.
Do not replace your current installation before checking the new version, help, and package identity.
For a backup already in the new client's schema, restore into a new workspace:

```sh
equitylayer local restore --backup /absolute/private/workspace/before-upgrade.sqlite --workspace /absolute/private/new-workspace
equitylayer local status --workspace /absolute/private/new-workspace
equitylayer workspace --workspace /absolute/private/new-workspace --show-link
```

Use the new installation's command for these checks. Keep the old installation and original workspace until acceptance is complete.
Restore preserves unknown usage and source gates. It does not approve research, clear accounting, or restart tracking.
For an older supported backup, use this command instead of `restore`:

```sh
equitylayer local upgrade --backup /absolute/private/workspace/before-upgrade.sqlite --workspace /absolute/private/upgraded-copy --allow-schema-upgrade
equitylayer local status --workspace /absolute/private/upgraded-copy
equitylayer workspace --workspace /absolute/private/upgraded-copy --show-link
```

The destination must not exist. The command copies the backup and migrates the copy through the existing migration transaction.
It retains a separate pre-migration snapshot inside the new directory. It does not change the supplied backup or original workspace.
The command does not start workers, invoke AI, release reserved budgets, or accept research.
Verify your watch, retained history, review decisions, source gates, and accounting before using the new copy.
If an upgrade fails, preserve its partial destination and diagnostic code. Use a different new destination for another attempt.
Do not remove the original workspace or the compatible backup. Do not operate both copies as simultaneous tracking workspaces.
Do not open a newer database with an older client.
For rollback, use the old installation with its original workspace or a compatible pre-upgrade backup restored into a new directory.
This release does not claim reverse migrations or automatic downgrade support.

The `0.1.0-local.4` candidate includes the workspace failure explanations and checks before native request reservation.
It also prevents another controller from changing an active request through a duplicate execution attempt.
These changes do not establish successful native research or release unknown usage reservations.
Use a new installation prefix for this candidate. Preserve the earlier package and original workspace.

The `0.1.0-local.6` candidate adds session-first setup without a native runtime or inference budget.
The unpublished `0.1.0-local.7` candidate adds `session check` and a generated `check_command`.
This checks the installed local MCP connection without reading the private task or invoking AI.
It does not prove a working AI-to-Inbox research path. No public release is authorized by these checks.
Its setup snapshot schema 2 is separate from the SQLite schema. Older setup commands cannot read this new snapshot.
Existing native schema 1 snapshots remain unchanged and can resume with the new client.
Use a new installation prefix and preserve old workspaces. Do not treat a session workspace as a configured background AI runner.

The unpublished `0.1.0-local.8` candidate includes exact Codex preview pins and bounded native launch diagnostic categories.
Its `local status` command refuses an older database schema instead of upgrading it.
This is not a filesystem read-only sandbox. SQLite can still touch shared-memory or journal metadata.
Other commands in local.8 retained their previous migration behavior. That historical candidate added no explicit upgrade command.
Its earlier real desktop attempt returned no research result. A later separately authorized checkout attempt returned SOURCE_NEEDED.
That later result does not establish complete research or success through an installed archive.

The unpublished `0.1.0-local.9` candidate separates fresh creation from migration and adds the explicit copy-upgrade command above.
All normal installed entrances refuse old schemas, even when a caller supplies migration-enabled dependency options.
The underlying ledger SDK retains its compatible constructor defaults. Direct SDK callers must select their own explicit creation and migration policy.
This release adds no in-place upgrade, reverse migration, automatic update, or production deployment.

The unpublished `0.1.0-local.11` candidate adds bounded cancellation to the installed command launcher.
On macOS and Linux, each command starts in its own process group. SIGINT or SIGTERM targets that invocation's inherited group.
The launcher allows one second for shutdown, then sends SIGKILL and allows one further second to confirm termination.
Cancelled commands return 130 for SIGINT or 143 for SIGTERM, even when their immediate child exits zero.
The first signal handled by the launcher determines that cancellation status.
If termination remains unconfirmed, the launcher reports `CLIENT_STOP_UNCONFIRMED` and returns 1. It does not claim the child stopped.
Keep the workspace. Check the invocation's processes before another attempt. Do not retry an unknown-usage model request.
Cancellation does not accept research, release budgets, grant source rights, or restart tracking.
This is process cleanup, not a security sandbox. It cannot guarantee cleanup after SIGKILL, power loss, or arbitrary detached descendants.
Native callers retain their separate cancellation and usage rules. This launcher does not verify provider-side request cancellation.
The earlier local.10 archive remains unchanged. Install local.11 in a new prefix and keep the old installation for rollback.

The unpublished `0.1.0-local.12` candidate fixes cancellation in interactive setup.
Ctrl-C, end of input, or an explicit process cancellation stops the active prompt with `SETUP_CANCELLED`.
The setup operation returns 1. A launcher that handles a process signal still returns its separate 130 or 143 status.
Cancellation before setup confirmation or public-scope consent creates no workspace and starts no method connection.
The command removes its prompt and cancellation listeners before it returns.
An unrelated operation failure remains an error. It is not relabeled as user cancellation.
Completed setup still requires explicit save and separate public-scope consent, or a supplied offline method.
If cancellation occurs after a frozen setup snapshot exists, preserve the directory and use the documented resume procedure.
This change does not authorize AI execution, source access, budget release, payment, or trading.
The earlier local.11 archive remains unchanged. Install local.12 in a new prefix.

The unpublished `0.1.0-local.13` candidate adds **Set up source checks** inside Tracking.
It displays an exact installed-client command for an eligible observation schedule. It does not execute that command.
Copy it to a separate local terminal. The command checks the saved revision and configuration hash again before it starts.
Use Ctrl-C to stop the process. **Stop tracking** disables the saved schedule and preserves research history.
The guide adds no AI authorization, source-rights approval, login persistence, payment, or trading.
It does not provide a complete monitoring service. See [background worker setup and limits](local-background-worker.md).
Install local.13 into a new prefix. Preserve the earlier local.12 archive and installation.

The unpublished `0.1.0-local.14` candidate adds optional local SEC submissions detection through `equitylayer sources`.
Select `sec`, then supply one selected listed symbol, its ten-digit CIK, your contact header, and your local-use declaration.
The default is HOLD. Configuration performs no network request or model call.
An allowed observation checks one fixed issuer endpoint daily and creates the existing research-needed notice for relevant changes.
It does not fetch filing bodies, calculate financials, grant commercial rights, install a service, or accept research.
This local source does not extend the shared service's approved registry or its financial coverage.
Install local.14 into a new prefix. Preserve the earlier local.13 archive and installation.

The unpublished `0.1.0-local.15` candidate fixes terminal cancellation in source setup.
Ctrl-C, EOF, and an external cancellation return `SOURCE_SETUP_CANCELLED` before configuration writes.
Cancellation during the questions preserves the existing workspace bytes and grants no source permission.
Successful setup still requires separate local-use and save confirmations. It does not start observation or AI.
Install local.15 into a new prefix. Preserve the earlier local.14 archive and installation.

The unpublished `0.1.0-local.16` candidate changes local MCP task delivery to bounded reads.
The same three tool names and permission flags remain. The hosted API/MCP does not change.
`get_research_task` without arguments now returns a manifest, not inline original source bodies.
Clients must read the listed task sections and relevant source ranges before making claims.
This replaces the oversized local task response. It does not certify the exact cause of the earlier model visibility failure.

### Read a local research task

1. Call `get_research_task` without arguments. Keep its context ID and exact section/source hashes.
2. Read `private_context`, `method`, `baselines`, and `citation_dates` with `view: "read"` and the listed section hash.
3. Read `source_metadata` and `facts` when needed. A section's format is canonical JSON.
4. For source text, use `source_event_id` instead of `section`. Copy the listed artifact hash into `sha256`.
5. Use `view: "find"` with a literal `query` to locate relevant text. Then read the required ranges and nearby headers/footnotes.
6. Continue a read with `next_offset`. Concatenate bytes before parsing JSON sections. Stop only when the required coverage is sufficient.

Example arguments for a section read:

```json
{"view":"read","section":"method","sha256":"COPY_THE_EXACT_MANIFEST_HASH","offset":0,"limit":2048}
```

Example arguments for a source search:

```json
{"view":"find","source_event_id":"COPY_THE_SELECTED_EVENT_ID","sha256":"COPY_THE_EXACT_SOURCE_HASH","query":"Operating cash flow","offset":0}
```

Replace the example placeholders with manifest values. They are not valid hashes or event selections.
Each read returns at most 2048 content bytes, the whole-document hash, a range hash, and exact byte offsets.
Offsets are UTF-8 bytes, not character positions. Do not split a multibyte character. Use returned continuation offsets.
Manifest source pages contain at most five entries. Continue with `cursor: next_source_cursor` until it is null.
Search accepts at most 120 UTF-8 query bytes and returns at most three non-overlapping literal matches per page.
It is case-sensitive and is not a regular expression.
Source text remains the original retained UTF-8, including HTML where applicable. It is not executed or rendered.
A search miss can result from case, tags, or entities. It does not prove the issuer omitted information.

Task-read results count both MCP copies against a 15000-byte limit, with additional room for the protocol envelope.
Oversized metadata produces `SESSION_READ_RESPONSE_LIMIT`, not a silently truncated success.
Unavailable content remains explicit. A returned range or search result never verifies research quality or complete source review.
Every read rechecks current watch scope and source rights. A stale hash, HOLD, or changed authority stops access.
No view accepts another context, arbitrary file path, or URL. No view fetches a source, invokes AI, changes a budget, or accepts research.
Submission and status behavior remain unchanged. A real financial comparison still needs separate verification and human review.
Install local.16 into a new prefix. Preserve the earlier local.15 archive and installation.

The frozen `0.1.0-local.17` candidate includes [local session instructions](../prompts/local-session-research.md).
The first-use and workspace guides now describe the bounded local.16 task contract.
The workspace guide includes argument examples that run against a synthetic MCP task in the offline tests.
Those tests do not verify model compliance or financial reasoning. Review permissions and charges in your own AI client before use.
No new runtime behavior, source access, or acceptance authority is added. The server reports the local.17 package version.
Install local.17 into a new prefix. Preserve the frozen local.16 archive and installation.

The unpublished `0.1.0-local.18` candidate adds optional readable HTML source delivery and client-owned timing guidance.
Raw UTF-8 remains the default and the source of record. No source bytes change.
The manifest supplies a readable representation hash when that view is available.
Use `representation: "readable"` and the matching `representation_sha256` with read or find requests.
Keep the original `source_event_id` and `sha256` from the same manifest entry.
Offsets and range hashes apply to the selected representation. Each readable range also identifies an enclosing original byte range.
Readable text does not prove quote equivalence, table alignment, CSS visibility, or financial meaning. Check the original when these affect a claim.
An unavailable readable view does not remove access to permitted original bytes.
The same scope, rights, lineage, and human-review gates still apply.

The local MCP does not invoke or stop the user's model. Any research deadline belongs to the AI client.
The packaged prompt asks the client to reserve time for its result and submission-status check.
These instructions do not enforce a deadline, guarantee a return, or settle an old runner request.
Offline source and installation checks do not establish a successful live financial comparison.
The frozen local.18 server reports that version. Preserve its archive and installation.

The unpublished `0.1.0-local.19` candidate includes the fixed validation diagnostics from the reviewed source change.
Its local MCP reports local.19. Install this candidate into a new prefix, without replacing an older installation.
The timestamp schema declares the validator's existing UTC `Z` syntax. Calendar and chronology checks remain separate.
On a supported validation failure, the server returns a fixed field and rule without private values:

```json
{"code":"RESULT_INVALID","issue":{"field":"next_check_at","rule":"UTC_TIMESTAMP"}}
```

This example is synthetic. It does not identify the invalid field in an earlier real research attempt.
Check `get_submission_status` before deciding whether a correction is appropriate.
Do not change research facts, citations, or result state merely to pass validation.
Do not retry without remaining authority in your AI client. A one-attempt limit still requires a stop.
After an uncertain reply, preserve the submission ID and exact content. Check status before an explicitly permitted replay.
Offline installation and synthetic-return checks do not establish a successful real financial comparison or verified model usage.
This candidate grants no commercial source rights, automatic acceptance, payment, order, or release authority.

The unpublished `0.1.0-local.20` candidate adds receipt-time labels and newest-first Inbox pagination.
Its local MCP reports local.20. Use a new installation prefix and preserve the frozen local.19 archive.
The Inbox loads the latest 50 entries from each research collection. Select **Load older** to read earlier entries.
Refresh reads the current first pages and removes earlier loaded snapshots from the view, not from retained history.
Collection retrieval uses append sequence. The mixed list sorts loaded entries by their displayed times.
Watch filtering occurs before pagination. Theme and company filters apply only to loaded entries.
External details distinguish **Received**, **Task prepared**, and **Proposed next check**.
These changes neither accept research nor start a model, source check, payment, or order.
Offline package checks do not prove unaided customer use or a second real financial update.

## Maintainer packaging

The unpublished `0.1.0-local.23` candidate adds portable verification guidance and repairs links that depended on private audit records.
It also bundles the method-artifact guide required by the execution guide. The local MCP reports local.23, with unchanged tool behavior.
Preserve the fixed local.20, local.21, and local.22 archives. This documentation candidate does not authorize publication or a new model call.

The unpublished `0.1.0-local.22` development candidate adds `local schedule-resume-observe` for an exact stopped observation configuration.
It saves the next immutable revision without starting work or changing source permission. Its local MCP reports local.22.
Keep the reviewed local.20 and local.21 archives unchanged. Install a new candidate into a separate prefix.
See [source-check recovery](local-scheduling.md#resume-stopped-source-checks). Real AI and unaided-user acceptance remain separate gates.

The unpublished `0.1.0-local.21` development candidate adds exact update references to local task preparation.
Its local MCP reports local.21. Preserve the frozen local.20 archive and install any new candidate in a separate prefix.
Opening a current evidence notice selects its available method and source, including references beyond the first options page.
Current source gates still apply. Missing references do not cause automatic substitution.
The user must confirm private access, candidate-method use, and optional result return before preparation.
This change does not start AI, source checks, payments, or trades.
It does not establish a successful real default-entry research trial or an unassisted customer installation.

Build the candidate from the reviewed checkout:

```sh
npm pack --ignore-scripts --offline --pack-destination /absolute/private/artifacts
```

The manifest includes executable modules, UI assets, shared instructions, selected user guides, and licenses.
It excludes tests, `.qc`, raw research, SQLite files, private configuration, payment tools, and the backend.
The package remains `private:true` to prevent accidental registry publication. Local tarball installation remains available.
Review the exact tarball contents and hash before distribution. Packaging does not authorize a push, deployment, or publication.

- [ ] Complete guided setup, supported-platform installation, and external-user pilots.
- [ ] Run quality control checkpoint
