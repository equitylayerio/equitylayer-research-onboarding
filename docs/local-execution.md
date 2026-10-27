# Caller-owned local execution candidate

Use Node 22.13 or later on a supported POSIX system. SQLite remains experimental in Node 22.
The current candidate has macOS checks on Node 24. Fresh Linux and minimum-version installation still need verification.
It uses the existing API/MCP contract without sending private research to the shared service.
No hosted model account, default model credentials, signer, or trading command comes with this entry.

## Before execution

Configure a trusted research command that accepts one JSON document on stdin and returns one JSON document on stdout.
Use the opt-in [native research driver](native-research-runtime.md) for an installed caller-selected Codex or Claude Code CLI.
The generic command adapter does not supply a model connection. You must configure that connection in your caller environment.
The command can access the operating system. Do not treat this adapter as a sandbox or permission enforcement for an untrusted executable.
The adapter starts no shell and inherits no environment credentials. Supply only the environment values your approved command needs.
Do not publish private configuration, SQLite files, source material, or model outputs in Git.

The command receives the pinned private context, candidate methods, normalized facts, and source metadata.
Explicit private-input consent authorizes that configured command to receive this context. Check its provider and data policy first.
Source text remains data. It cannot authorize payments, investment orders, source access, or new credentials.
This guide does not establish a successful real caller research run.

## Local commands

All workspace paths must be absolute. Configuration and decision files must be owned regular private files without links.
Keep their permissions at `0600`. Keep the workspace directory at `0700`.
Retained public source files may be share-readable, but must not be links or group/world writable.

```sh
npm run research:local -- init --workspace /absolute/private/workspace --input private-config.json
npm run research:local -- intake --workspace /absolute/private/workspace --input source-event.json
npm run research:local -- status --workspace /absolute/private/workspace
npm run research:local -- run --workspace /absolute/private/workspace --runtime private-runtime.json --allow-private-context --allow-candidate-method
npm run research:local -- reconcile --workspace /absolute/private/workspace --input private-decision.json
npm run research:local -- backup --workspace /absolute/private/workspace --name review-backup.sqlite
npm run research:local -- restore --backup /absolute/private/workspace/review-backup.sqlite --workspace /absolute/private/restored-workspace
```

`init` needs exactly `scope`, `private_context`, `method_bundle`, `budget`, and `source_policies`.
The budget contains `window_id` and `limits` for requests, tokens, cost_microusd, and wall_ms.
Source policies use the existing local policy contract. Unknown rights, HOLD, denied purpose, or unapproved candidates stay gated.
An init failure can retain completed local setup steps. Read status and replay the exact configuration before changing it.

`intake` needs `watch_id`, `event`, `artifact`, `raw_file`, `facts`, `method_sha256`, `evaluation_at`, `budget_window`, and `run_policy`.
`raw_file` is the absolute path to the retained bytes. The CLI checks their size and the declared source hash.
The run policy contains `max_attempts`, `max_wall_ms`, and `not_before` in milliseconds.
Event intake supplies the existing source policy and lineage checks. It does not grant rights or establish financial truth.

`status` returns identifiers, current gates, and counts. It excludes private questions, reasoning, result text, and runtime credentials.
It does not initialize or upgrade storage. An older schema returns `SCHEMA_UPGRADE_REQUIRED` without a migration backup or schema change.
Do not use another normal command to bypass this refusal. Create a backup with the old compatible client before upgrading.
Use the explicit copy-upgrade command below. The new client's `backup` command also refuses older storage.
This guard is not a filesystem read-only sandbox: opening SQLite storage, including an old workspace with an active WAL, can touch shared-memory or journal metadata.
All normal installed entrances refuse old schemas. Only new setup or an empty workspace can create a fresh current-schema database.
Counts include retained history. The status view has no pagination yet.
`run` performs at most one claimed job. It does not install a background scheduler.
Exit codes: `0` for command success or idle, `2` for a research gate, and `1` for a local operation error.
An idle status does not mean research completed. Active source gates remain visible even when no job exists.

## Backup and restore

`backup` creates a new private SQLite snapshot inside the workspace. It refuses an existing backup file.
`restore` validates a current-schema snapshot and requires a new absolute destination directory. It never overwrites an existing workspace.
The restored workspace preserves source gates, unknown usage, research history, review history, and existing accepted references.
Restoration does not approve new evidence, grant source rights, reconcile missing usage, or invoke AI.
The command prints counts and status, not private research text or credentials.
The directory uses `0700` permissions. Database files use `0600` permissions and remain unencrypted.
Keep backup files private and outside Git. Do not restore from an untrusted file.

Stop the original worker before selecting a restored workspace for continued tracking.
Restoration does not stop another process, install an OS service, or start the copied tracking configurations.
Read the restored status and review its exact runtime, source policy, and budget before restarting tracking.
Open the restored dashboard with `research:workspace -- --workspace /absolute/private/restored-workspace --show-link`.
For a supported older backup, use an explicit upgrade into a new directory:

```sh
npm run research:local -- upgrade --backup /absolute/private/workspace/before-upgrade.sqlite --workspace /absolute/private/upgraded-copy --allow-schema-upgrade
```

The original backup and original workspace remain unchanged. The new copy retains a separate pre-migration snapshot.
The migration transaction changes only that copy. Upgrade does not start workers, accept research, or release accounting reservations.
Ordinary restore rejects an older schema before creating its destination. Invalid backups also fail before destination creation.
If migration fails, preserve the partial destination and error code. Use a different new directory for another attempt.
Keep the old installation and original workspace for rollback. No reverse migration or automatic downgrade is available.
See [installation and upgrade](installable-client.md) for the installed-command procedure.

## Runtime configuration

The private runtime file contains exactly `command` and `execution`.
The following paths and identity are placeholders, not an installed model connection:

```json
{
  "command": {
    "allow_local_command": true,
    "executable": "/absolute/path/to/your-approved-research-command",
    "args": [],
    "identity": "caller-research-command-version-1"
  },
  "execution": {
    "estimate": { "tokens": 10000, "cost_microusd": 100000, "wall_ms": 30000 },
    "timeout_ms": 30000,
    "heartbeat_ms": 5000,
    "lease_ms": 30000
  }
}
```

These example estimates are not prices or usage measurements. Set them from your approved runtime and remaining budget.
Optional command fields: `env`, `timeout_ms`, `max_input_bytes`, `max_output_bytes`, and `max_stderr_bytes`.
Optional execution fields: `timeout_ms`, `heartbeat_ms`, `lease_ms`, and `retry_delay_ms`.
Do not place consent flags or an arbitrary clock in the runtime file.
The configuration hash fixes declared command settings, not the executable's binary or all of its dependencies.
Change the declared identity/configuration when the runtime changes. A pinned run refuses a different configuration.

The command output has exactly `agent_fields` and `usage`.
Agent fields are `result_state`, `summary`, `sources`, `drivers`, `falsifiers`, `unknowns`, and `next_check_at`.
The input contract supplies field bounds, supported states, and source/date rules.
The agent cannot provide result identity, scope, creation time, baseline selection, or purchase receipts.

Usage must contain measured nonnegative integer `tokens` and `cost_microusd`, or `null` for unknown usage.
One million cost_microusd equals one USD. The caller must verify its usage and pricing basis.
The adapter does not authenticate a provider invoice. Never replace missing usage with zero or an estimate.
Elapsed wall usage measures dispatch to retained receipt, not provider billing time.
Known usage beyond the reservation gates the budget rather than hiding the excess.

## Recovery and curation

Each job fixes watch revision, method, source references, comparison references, and private context.
The first execution snapshot and runtime configuration survive restart. A settled output can finish without another AI request.
Heartbeat, fencing, request reservations, and immutable result delivery prevent a stale worker from accepting new state.
The shared advice check retains the existing validator's summary, driver, falsifier, and unknown-field scope.
It is a phrase guard, not a complete test of research quality or every source claim.
`NO_NEW_EVIDENCE` requires a pinned comparison baseline. Missing evidence must remain explicit.

A timeout, lost lease, or uncertain dispatch keeps usage reservations and creates a gate.
A late output becomes an immutable local receipt. It cannot accept evidence or a thesis interpretation.
To reconcile, supply exactly `request_id`, `receipt_sha256`, `reason`, `reconciliation_id`, and `resume` in a private decision file.
Select a retained receipt with measured usage. A receipt with unknown usage cannot release its holds.
Use `resume: false` when you approve accounting only. A resume choice does not approve source rights or research conclusions.

If several unknown requests share one budget window, reconcile all exact receipts first.
Replay any original `resume: true` decision that remained blocked by the shared gate.
Use the same request ID, receipt hash, reason, reconciliation ID, and resume choice.
The ledger checks current source authority, scope, deadline, and attempt limits before queuing the run.
It never charges the same selected receipt twice or reopens a cancelled scope.

The explicit upgrade retains a private snapshot before applying the existing supported-schema migrations.
Earlier request accounting remains marked as legacy. Migration does not invent historical measurement evidence.
Hash and accounting checks detect missing or changed records, not a hostile rewrite of every record and hash.
This candidate stores private data locally without default encryption.

The [local workspace](local-workspace.md) now reads this ledger and saves distinct review actions.
Its HTTP and SQLite checks do not establish visual or native-model acceptance.
The [finite scheduler](local-scheduling.md) can read a caller-supplied retained feed and use the same approved runtime.
The [native research driver](native-research-runtime.md) now accepts exact caller-selected Codex or Claude Code CLI configuration.
Its process-to-Inbox tests use synthetic callers. Real authentication, native research, and Codex cost accounting remain open.
Live source adapters, independent research evaluation, method promotion, and release acceptance remain open.
Human curation still controls the investment question, mechanisms, company roles, evidence applicability, and interpretation.
See [the portable verification boundary](local-verification-status.md). Detailed controller checkpoints remain with the maintainer.
Opt-in [method artifact commands](local-method-artifacts.md) retain regression cases and candidate plans without invoking AI or releasing methods.
