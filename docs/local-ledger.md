# Local research ledger: candidate library

The library preserves research execution records in a caller-owned SQLite workspace.
It does not replace the caller's AI or act as a general memory service.
The [local execution CLI](local-execution.md) and [local workspace](local-workspace.md) use this ledger.
Direct SDK callers must select their own creation and migration policy. Normal installed commands require explicit copy-upgrade for older schemas.

## Storage and execution boundaries

`ResearchLedger` requires an absolute private directory owned by the current user.
It creates `research.sqlite` with mode 0600 and uses WAL transactions with full synchronization.
Existing symlinks, database hard links, shared permissions, foreign database identities, and unsupported schemas fail.
The local directory, database, sidecars, and backups contain private data. They are not encrypted by this library.
Windows needs a verified permission policy and currently fails the platform guard.

Watch revisions are immutable. Retained methods, source events, raw bytes, checkpoints, and deliveries reject conflicting replacements.
The reference bridge checks raw byte length and SHA-256, event identity, and profile/bundle hashes.
Hashes do not prove source authenticity, usage rights, or financial claims.
Context-bound correction validation detects inconsistent lineage. Conflicting or unknown corrections remain gated.
Candidate method metadata remains founder-review-required. Retention is not promotion.

Configure a bounded watch budget before enqueueing a run.
A worker must claim a lease, reserve its request budget, and mark dispatch before any external request.
The separate executor enforces that protocol. The ledger itself makes no model or network request.
Tokens, cost, wall time, and request count remain separate dimensions. Costs use integer micro-USD.
Lease fencing prevents expired workers from changing active checkpoints or creating a new delivery.

Undispatched reservations can recover after lease loss.
A dispatched request without confirmed usage keeps its holds and gates the budget rather than retry automatically.
Unknown or excessive usage cannot become a completed no-change report.
The controller supports explicit accounting reconciliation and bounded cancellation. Missing measured usage does not permit reconciliation to zero.

Observed, queued, and completed cursor references have different meanings.
Their order follows local retention sequence, not source chronology, completeness, or financial validity.
Do not skip an event solely because a later cursor exists. Check its specific run and pinned source references.

## Results, review, and recovery

The local result-file parser checks the supported version-one shape before inbox delivery.
Result and outbox writes share one transaction, so an exact replay returns the original delivery.
Structural validation does not certify source claims or agent-reported receipts.

Receiving a result, accepting evidence, accepting an interpretation, requesting another check, and rejecting a result are separate review actions.
Revisit and rejection do not replace accepted A. Evidence and interpretation keep independent references.
Current-scope and missing-source gates apply to acceptance. Review revisions prevent a stale browser decision from replacing a newer one.

Inbox pages do not delete older history. Backups use SQLite snapshots and private file permissions.
Restore requires a new directory and checks schema identity, SQLite integrity, and foreign-key references.
Startup, backup, and restore also check source bytes, method hashes, scope/context hashes, run references, results, checkpoints, and retained review content.
Each verification uses one read snapshot so another worker's valid review cannot cause a false mismatch.
These checks do not use an external trusted manifest. They cannot detect an attacker who changes content and all matching hashes.
Mutable execution state and request usage are not an authenticated audit log.
After a storage error, inspect durable state before retrying rather than assume the transaction failed.

## Historical legacy migration

The following notes describe the original schema-two migration. They do not authorize an automatic upgrade through normal installed commands.
Use [explicit copy-upgrade](installable-client.md#backup-before-an-upgrade) for current client recovery.

Schema version two adds legacy archives and complete review hashes.
Opening a supported version-one workspace first checks retained records and saves a private snapshot before upgrade.
The upgrade uses a transaction. A lost reply does not mean the upgrade failed.
Version-one review request hashes must match their retained per-watch order before migration.
The new schema records that existing order and hashes complete review records without changing their actions.

`importLegacyWorkspace(rawBytes)` accepts an explicit version-one browser JSON export within a 2 MB byte limit.
It preserves exact bytes, original review snapshots, and the original accepted-result reference.
Legacy acceptance remains `legacy-unclassified`. It does not become new evidence or interpretation acceptance.
Legacy results have unknown method, source-reference, and run provenance.
An older result can retain its old public scope, but migration does not invent its missing private revision context.

The importer preserves more than 30 results and reviews when the archive fits the byte limit.
`legacyHistory` provides pages without deleting records. `legacyWorkspace` returns the retained archive and typed records.
An identical byte replay reuses the archive. Different raw formatting creates another archive, but identical result IDs do not duplicate results.
A conflicting result, scope, or private context rejects the entire import.
Import cannot advance an existing watch revision or replace its accepted references.
No command reads browser storage automatically. The library and local dashboard accept an explicit legacy archive import.

## Verification and remaining integration

Run `npm test`. The suite includes two-process races, 20 initialization pairs, transaction-boundary SIGKILL cases, and synthetic storage faults.
See [the portable verification boundary](local-verification-status.md#what-the-checks-establish) for component evidence and remaining acceptance limits.

Node 22.13 is the minimum tested runtime. Its built-in SQLite API remains experimental in that version.
[Node SQLite documentation](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)

Legacy import exists in the library and dashboard, not as a local CLI command. Imported acceptance remains legacy-unclassified.
Event intake, deterministic relevance, source-policy gates, and durable event-job deduplication now exist as libraries.
Execution, fixed source adapters, the local dashboard, local notices, scheduling, and method evaluation components now exist.
Real caller acceptance, broader permitted source coverage, research-quality acceptance, and external notification delivery remain open.
Installing this candidate does not enable monitoring, payment, trading, or method promotion.

## Source-event intake

Schema version three adds normalized facts, source policies, event decisions, and unique event-job links.
Supported schema-one and schema-two workspaces keep private backups before upgrade.
`configureSourcePolicy` records an explicit caller-owned policy revision. This API is not a remote agent tool.
Source text cannot grant permissions. ALLOWED, HOLD, UNKNOWN, and denied purpose have separate outcomes.
The policy can grant local research only. It does not grant redistribution, trading, payment, or method promotion.
Candidate trials require an explicit local setting and remain founder-review-required.

`intakeSourceEvent` retains the source bytes and supplied facts, observes the event, and stores a decision in one transaction.
Eligible decisions create one run per watch revision, method, and immutable event reference, even across different evaluation times.
Missing facts, source rights, parser changes, retrieval age, unknown budget usage, and correction conflicts create named gates.
The retrieval-age check is not a financial reporting-period freshness guarantee.

Relevance uses explicit company-to-issuer mapping and metric IDs. It does not infer supplier relationships or product revenue.
Different market companies remain selected even when this source covers only some of them.
Unrelated events do not call a model. Repeated unchanged observations compare with the latest eligible retained job, not the last observed cursor.
Identical raw bytes with different parsed facts create a conflict rather than a quiet no-change claim.

The correction graph core is a generated copy of the private authoritative core.
Its header records the source hash. Update it through TypeScript transpilation, not manual edits.
Both schema wrappers validate records before the core runs. Current event facts and artifacts cannot be replaced by supplied context copies.
Legal multi-issuer corrections remain valid. Missing context, cross-source/period edges, conflicting definitions, cycles, and overlapping forks require review.
Raw artifacts and historical decisions remain retained. Correction acceptance does not replace the investment baseline.

Changing a source policy stops pending work and preserves uncertain dispatched usage.
A later explicit local authority restoration can resume an undispatched job under its original ID and pins.
The original deadline and retry limits still apply. Unknown dispatch usage cannot resume automatically.
Source-fact manifests and decision references detect deleted retained fact and event-job rows during startup, backup, and restore.
These references are consistency checks, not external signatures or proof of financial truth.

The ledger stores schedule state. Separate adapters and workers perform permitted checks and approved model calls.
It contains no trading executor. See [source-check verification limits](local-verification-status.md#source-checks-and-workers).
