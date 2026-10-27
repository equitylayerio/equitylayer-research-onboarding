# Local method artifacts

These opt-in commands retain historical cases, candidate metadata, and frozen regression plans in the private research ledger.
They do not run an evaluation or release a method.
The current release gate is `HUMAN_METHOD_APPROVAL_REQUIRED`. The founder approved the workflow, not any exact method.
Older frozen plans retain their historical `D12_UNANSWERED` field without a rewrite.
No promotion command exists.

Use the [local execution CLI](local-execution.md) with Node 22.13 or later on a supported POSIX system.
These commands require an existing workspace with retained methods and source or run records.
The commands make no AI or network requests.
They grant no source rights, payment authority, or trading authority.

## Commands and private files

Each workspace path must be absolute.
Each write command requires exactly `--workspace` and `--input`.
The status command requires exactly `--workspace`.
The CLI rejects extra, missing, or repeated flags.

```sh
npm run research:local -- method-capture --workspace /absolute/private/workspace --input /absolute/private/case.json
npm run research:local -- method-candidate --workspace /absolute/private/workspace --input /absolute/private/candidate.json
npm run research:local -- method-plan --workspace /absolute/private/workspace --input /absolute/private/plan.json
npm run research:local -- method-status --workspace /absolute/private/workspace
```

Keep input files outside Git.
Use `0600` file permissions and a `0700` workspace directory.
The input must be an owned regular file with one hard link and no symbolic link.
The CLI rejects group or world access and input files larger than 1,000,000 bytes.
Input JSON must use the exact fields below.
Unknown fields fail the command.
The database retains private data without default encryption.

## Capture a historical case

`method-capture` requires `case_id`, `origin`, `note`, and `author_id`.
The `origin` object requires `kind` and `id`.

| Origin kind | Required retained record |
|---|---|
| `source_gate` | A gated source decision, identified by its decision ID. |
| `run` | A gated or cancelled run, identified by its run ID. |
| `review` | An explicit `revisit` or `reject` review, identified by its review ID. |

For example, replace the origin ID with the retained decision ID from source intake:

```json
{
  "case_id": "case-001",
  "origin": { "kind": "source_gate", "id": "RETAINED_DECISION_ID" },
  "note": "Check the retained source gate.",
  "author_id": "local-reviewer"
}
```

The case fixes its scope, private context, method hash, source references, and available execution records.
It retains available checkpoints, request responses, receipts, and delivery data for run origins.
It does not invent missing snapshots or recover unavailable invalid raw model output.
Its classification is `regression`.
Its curation status is `founder_review_required`.
The artifact does not authenticate its author.

The CLI prints only `artifact_id`, `sha256`, and `reused`.
Use the artifact hash as `case_sha256` in later requests.
The `case_id` in those requests is the original case ID, without the `case:` prefix.

## Retain a candidate

`method-candidate` requires these fields:

| Field | Requirement |
|---|---|
| `candidate_id` | A bounded local identifier. |
| `bundle` | A complete method bundle that passes the existing method contract and content hashes. |
| `parent_method_sha256` | The exact hash of a retained parent method. |
| `case_refs` | One to 100 distinct objects with `case_id` and `case_sha256`. |
| `reason` | Private text that explains the proposed change. |
| `author_id` | A bounded local identifier. |

The candidate must differ from its parent and use a different bundle version.
Each changed profile also needs a new three-part numeric version. Candidate metadata and curation gates remain unchanged.
Each case reference must match a retained case and its exact artifact hash.
A candidate method has one retained parent.
Parent links cannot form a cycle.

The CLI prints `artifact_id`, `sha256`, `reused`, and `status: "candidate"`.
The artifact hash identifies the retained candidate record, not the bundle hash.
Retention does not select an active method or approve a release.
The command does not alter a retained run or its pinned method.

## Freeze a regression plan

`method-plan` requires these fields:

| Field | Requirement |
|---|---|
| `plan_id` | A bounded local identifier. |
| `incumbent_method_sha256` | The exact hash of a retained comparison method. |
| `case_refs` | One to 100 distinct objects with `case_id`, `case_sha256`, and `partition`. |
| `rubric` | The exact rubric object described below. |
| `evaluation_at` | A real UTC timestamp with millisecond precision, such as `2026-10-12T00:00:00.000Z`. |
| `repetitions` | An integer from one to ten. |
| `runtime_policy_sha256` | A lowercase SHA-256 hash that identifies the proposed runtime policy. |
| `author_id` | A bounded local identifier. |

The rubric requires `version`, `criteria`, `minimum_score_bps`, `critical_regression_veto`, and `comparison_rule`.
Each criterion requires `id`, `description`, `critical`, and `weight`.
Use one to 20 distinct criteria.
Use a boolean `critical` value and an integer weight from one to 100.
Use an integer `minimum_score_bps` from zero to 10,000.
Set `critical_regression_veto` to `true`.
Set `comparison_rule` to `paired_incumbent_no_regression`.

Captured historical cases are exposed material.
Set each accepted partition to `regression`.
A `holdout` request fails with `METHOD_HOLDOUT_EXPOSED`.
Relabeling an exposed case cannot create unseen evaluation evidence.
The ledger also rejects repeated input families under different case IDs.

The frozen plan fixes case references, rubric, comparison method, time, repetitions, and the runtime policy hash.
The hash records a declared policy reference. It does not configure or authenticate a runtime.
New plans retain `evaluation_status: "not_executed"` and `release_gate: "HUMAN_METHOD_APPROVAL_REQUIRED"`.
The command does not invoke the runtime, assign scores, or approve the candidate.

The CLI prints `artifact_id`, `sha256`, `reused`, `status: "gated"`, and `gate_code: "HUMAN_METHOD_APPROVAL_REQUIRED"`.
Exit code `2` reports the release gate even when the ledger retained the plan successfully.

## Status, replay, and errors

`method-status` prints artifact counts, `status: "gated"`, and `gate_code: "HUMAN_METHOD_APPROVAL_REQUIRED"`.
The current method status is `not_verified`, even when engineering trial outputs exist. Frozen plan records preserve their initial `not_executed` capture status.
It returns exit code `2`, including when all artifact counts are zero.
Counts report retained cases, candidates, and plans. They do not report evaluation success.

Replay the exact input with the same artifact ID to recover an uncertain reply.
The ledger reuses an identical retained request after restart and returns `reused: true`.
Changed content with the same artifact ID fails with `METHOD_ARTIFACT_CONFLICT`.
Use a new ID for a different record.

Exit code `0` reports a retained case or candidate.
Exit code `1` reports an operation error through a bounded error code.
CLI output excludes record bodies, private context, notes, reasons, source data, and runtime output.
Method artifacts require founder review and independent evaluation before any future release decision.
Unseen evaluation and active method release remain unimplemented in this stage.
