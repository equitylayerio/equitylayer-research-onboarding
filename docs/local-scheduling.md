# Local scheduling candidate

Internal candidate only. The public hackathon candidate does not contain this unfinished loop.
Use Node 22.13 or later on a supported POSIX system with a private SQLite workspace.
First complete [watch, method, policy, budget, and caller setup](local-execution.md).

The worker checks a bounded retained directory, the [fixed TWSE monthly API](local-twse-monthly-source.md), or a local SEC submissions index.
Use `equitylayer sources` and select `sec` for the optional filing-index detector. See [source setup](first-use.md#add-a-permitted-source).
The SEC index supplies no financial statement content. It does not approve company coverage or commercial data use.
When an eligible event creates a job, it can invoke your explicitly approved caller and save the result to the same [local Inbox](local-workspace.md).
It never accepts evidence or an investment interpretation. You review those separately.

## Configure

Save a private JSON file with the following fields. Paths, identifiers, hashes, and limits below are placeholders.
The file must have mode `0600`; directories must have mode `0700`. Use canonical absolute paths without links.

```json
{
  "schema_version": 1,
  "schedule_id": "my-ai-compute-watch",
  "revision": 1,
  "watch_id": "YOUR_RETAINED_WATCH_ID",
  "scope_revision": 1,
  "method_sha256": "YOUR_EXACT_RETAINED_METHOD_HASH",
  "source_id": "YOUR_CONFIGURED_SOURCE_ID",
  "budget_window": "YOUR_BUDGET_WINDOW_ID",
  "feed": { "kind": "retained_directory", "directory": "/absolute/private/feed" },
  "interval_ms": 86400000,
  "max_events": 20,
  "max_runs": 0,
  "tick_timeout_ms": 30000,
  "run_policy": { "max_attempts": 3, "max_wall_ms": 30000, "not_before": 0 },
  "runtime_sha256": null
}
```

`max_runs: 0` permits observation and intake only. It cannot invoke AI, even if a runtime exists.
When new eligible evidence creates a research job, the local workspace retains one **New evidence needs research** notice.
Open **Research with my AI** from that notice to select evidence in the existing Watch panel.
For a current watch revision, the panel selects that update's exact retained method and eligible source.
It also resolves references beyond the first options page without changing the normal pagination cursor.
Missing or blocked references remain explicit. No unrelated method or source replaces them automatically.
You can change the selection. Refresh preserves your changes and checks current source gates.
You can remove a previously selected source that becomes blocked. You cannot select that blocked source again.
The notice does not prepare a connection, share private context, or invoke a model.
Confirm the method, source selection, and private-context permissions before preparing the task.

Repeated observations do not repeat the notice, including after you acknowledge it or reopen the workspace.
HOLD, missing permission, and other source gates remain separate notices. They do not become research-ready alerts.
An old-revision notice cannot prepare research for a changed watch. Load an unloaded watch before using its preparation controls.
The comparison baseline remains the evidence you explicitly accepted, not the newest unreviewed result.

A returned external result resolves attention only for the same watch revision, method, and selected source events.
It creates the existing result-review notice. It does not complete a native background run, reconcile usage, release a budget, or accept research.
Results returned before observation do not create a redundant matching evidence reminder.
A completed native delivery also resolves its own pending evidence notice.
Other source events and methods retain their notices. Dismissal is acknowledgement only, not a research or investment decision.

For execution, select `max_runs` between 1 and 10 and obtain `runtime_sha256` with `schedule-runtime`.
That hash identifies the declared command configuration and execution settings, not the binary or its dependencies.
Budget, source rights, and private-input consent still apply.

```sh
npm run research:local -- schedule-runtime --workspace /absolute/private/workspace --runtime private-runtime.json
npm run research:local -- schedule-configure --workspace /absolute/private/workspace --input private-schedule.json
npm run research:local -- schedule-status --workspace /absolute/private/workspace --schedule-id my-ai-compute-watch
npm run research:local -- schedule-observe --workspace /absolute/private/workspace --schedule-id my-ai-compute-watch --ticks 2
npm run research:local -- schedule-run --workspace /absolute/private/workspace --schedule-id my-ai-compute-watch --ticks 2 --runtime private-runtime.json --allow-private-context --allow-candidate-method
npm run research:local -- schedule-stop --workspace /absolute/private/workspace --schedule-id my-ai-compute-watch
```

Each command worker processes at most 1–1000 ticks and remains attached to its process.
Ctrl+C or SIGTERM stops the process; restart it with the same schedule ID to continue checking due work.
`schedule-stop` disables the retained schedule. To enable it again, save the next immutable configuration revision.
For an unchanged stopped observation configuration, use the guarded [source-check resume command](#resume-stopped-source-checks) below.
The finite worker installs no operating-system service. A configured schedule without a running process does not monitor anything.
The [continuous worker and macOS service plan](local-background-worker.md) now supply opt-in continuous execution and crash recovery.

## Resume stopped source checks

Read `schedule-status` and retain its stopped revision and `config_sha256`.
Use the installed command below after reviewing the same source, watch, and method configuration.
Replace the placeholders with those exact status values.

```sh
equitylayer local schedule-resume-observe --workspace /absolute/private/workspace --schedule-id my-ai-compute-watch --revision STOPPED_REVISION --config-sha256 EXACT_STOPPED_HASH --confirm-resume
```

The command creates the next immutable revision with no other configuration change.
It requires a stopped observation-only schedule, the unchanged watch revision, and current permitted local source use.
It cannot resume a schedule that includes AI execution, change a feed or method, or restore revoked source permission.
It preserves source history, accepted evidence, judgment, research jobs, and budget reservations.
It starts no worker, source request, model, or operating-system service.

Use the returned revision and hash to obtain new **Set up source checks** instructions in Tracking.
Start that reviewed command separately. The old revision's worker command cannot run the new configuration.
Any installed OS service also needs a newly reviewed plan. The resume command does not replace its property list.
The source-setup snapshot remains the original setup record. `sources --resume-source` is setup recovery, not this ongoing operation.

An exact retry returns `reused: true` and the current schedule state.
It does not create another revision or undo a later stop of the returned revision.
If another configuration supersedes that revision, the old request fails with `SCHEDULE_CONFLICT`.
If the stopped setup or watch needs different inputs, review and save a new configuration instead.
These commands declare local-owner intent. They do not authenticate the owner or verify commercial rights.

## Caller feed contract

Your approved connector must supply JSON records with exactly `schema_version: 1`, `event`, `artifact`, `facts`, and `raw_base64`.
Use the existing source-event and artifact contracts. `raw_base64` contains the exact retained source bytes; the artifact hash must match those bytes.
Normalized facts must match their declared event and artifact. The filename is `contentHash(record) + ".json"` using the exported local contract helper.
Files must be private, owned, regular files without symbolic or hard links.

The active batch contains at most `max_events` files, with a maximum of 100 files, 4 MB per record, 2 MB decoded source bytes, and 16 MB total.
This directory is not a growing archive. Your connector must maintain the bounded active batch while the ledger retains its full source and research history.
The TWSE API feed has a separate permission check, parser, and fixed endpoint. Other live provider connectors remain unfinished.
Structural checks do not authenticate the source or grant commercial rights.

## Recovery and limits

Only one owner can hold a schedule lease. Another finite worker returns `busy` without dispatching a job.
Stop, configuration replacement, scope change, and lease expiry prevent an in-flight result from entering Inbox.
Unknown usage keeps its reservation until explicit accounting reconciliation; the worker does not substitute zero usage.
Late receipts can remain in history without becoming a delivery or accepted baseline.

An empty or invalid feed produces a named gate or failure, not a claim of no new evidence.
Unchanged HOLD observations retain their gate without repeating the same notice or invoking AI.
When you explicitly accept local evidence, the next scheduled event pins that exact evidence for comparison. Accepting an interpretation alone does not select the comparison baseline.

Schema 6 and 7 upgrades save private backups first. Schema 8 binds each scheduled research fence to its parent schedule and retains a matching checkpoint.
Integrity checks detect inconsistent records, not a hostile rewrite of all records and hashes.

Exit codes: `0` for completed observation or idle operation, `2` for gated, stopped, or busy work, and `1` for an operation error.
Schedule status excludes private feed paths and runtime credentials. Its `research_completion_verified: false` flag prevents a health check from claiming research-quality acceptance.
The local Inbox has a collapsible Tracking panel for schedule health and guarded stop.
It does not configure or enable schedules. A configured schedule does not prove that a worker runs.

See [the source-check verification boundary](local-verification-status.md#source-checks-and-workers) for the distinction between tested components and an accepted monitoring product.
Real caller research, other permitted live sources, user installation, research-quality evaluation, and release remain open.
