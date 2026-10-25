# TWSE monthly source for local research

Internal candidate on `codex/thesis-local-run`. This adapter is not in the public hackathon release or production.
It supplies issuer-reported monthly fields to the existing SQLite scheduler. It does not provide a curated AI Compute conclusion.

## Source and permission

The adapter requests only `https://openapi.twse.com.tw/v1/opendata/t187ap05_L`, with redirects disabled.
There is no MOPS archive, alternate endpoint, paid provider, or authentication fallback.
The request includes a 20-second deadline and a 2 MB response limit. The schedule deadline can stop it sooner.

The local source policy must identify `twse_listed_monthly_revenue_v1` and the exact adapter/parser version `twse-local-monthly-1.0.0`.
HOLD, UNKNOWN, a missing policy, or a denied `local_research` purpose stops the request before network access.
The product source registry still holds commercial reuse and redistribution. This module grants neither.
Do not copy a synthetic test policy into a real workspace as rights approval.

## Setup within the existing watch

Complete the [local execution setup](local-execution.md) first. Keep the user's selected US and Asian symbols.
After first-use setup, `equitylayer sources --workspace /absolute/private/workspace` can generate the policy and observation schedule interactively.
It requires a separate caller declaration for permitted local use. It cannot replace an existing HOLD policy or approve commercial redistribution.
Every selected four-digit `.TW` symbol requires an exact issuer mapping, such as `"2383.TW": "2383"`.
The live source reads all selected TWSE companies, not only the three companies in the paid Pack.
It does not fetch US, Japan, Korea, or `.TWO` data. A company absent from this API creates a gate.

The source policy can select the following metric IDs:

```text
twse.monthly.current_revenue
twse.monthly.previous_month_revenue
twse.monthly.previous_year_revenue
twse.monthly.mom_percent
twse.monthly.yoy_percent
twse.monthly.ytd_revenue
twse.monthly.previous_ytd_revenue
twse.monthly.ytd_yoy_percent
twse.monthly.company_name
twse.monthly.industry
twse.monthly.issuer_note
```

Use `allowed_evidence_states: ["PROVISIONAL"]`. These fields are issuer-reported, not independently verified investment evidence.
Their identities preserve the original source-field name. Prior-month, prior-year, and cumulative columns retain those distinct definitions.
Revenue amounts use TWD thousands. Percentages do not become revenue amounts or derived product mix.

In the [schedule configuration](local-scheduling.md), replace only the feed and corresponding source fields:

```json
{
  "source_id": "twse_listed_monthly_revenue_v1",
  "feed": { "kind": "twse_monthly_revenue_api" },
  "interval_ms": 86400000
}
```

This fragment is not a complete schedule. Preserve its watch revision, retained method hash, budget, deadline, and run limits.
Configure a new immutable schedule revision when an existing schedule changes.
Start with `max_runs: 0` and `runtime_sha256: null` to observe without model calls.
For research execution, pin the [caller runtime](native-research-runtime.md) and grant the required private-input consent explicitly.
No model installation, login, or cost approval occurs through this source setup.

## Evidence and recovery

The adapter retains exact bytes, their hash, retrieval time, selected company rows, and normalized facts.
Missing or duplicate rows, invalid numbers, conflicting periods, changed keys, invalid publication dates, and malformed JSON enter a schema gate.
A policy change after a request still blocks research during transactional intake.
Live policy reads check the stored hash and indexed identities before network access and again after the request.
Stopping, replacing, or expiring the parent schedule prevents an in-flight fetch from creating a research job.

The local calendar rule requires the previous completed Taipei month. Older reports enter `STALE_REPORTING_PERIOD`, even with new retrieval bytes.
The rule does not assert a statutory publication deadline or verify that no newer official release exists.
At a month boundary, the monitor can wait for the next period while the accepted evidence remains unchanged.

Same-period byte changes use retained correction lineage. A conflict needs review rather than baseline replacement.
After those checks, unchanged selected evidence does not create another AI request. Unrelated company rows and a TWSE publication-day refresh do not change that evidence.
Changed selected values, company metadata, or issuer notes can trigger research. A new reporting period also triggers a new eligible run.
Repeated malformed bytes retain one matching source-gate notice, while the event history remains available.

See [the source-check verification boundary](local-verification-status.md#source-checks-and-workers). Exact retained-data outputs remain in the maintainer's audit records.

Use the existing `schedule-status`, `schedule-run`, `schedule-observe`, and `schedule-stop` commands.
The finite worker remains process-bound. The [opt-in continuous worker](local-background-worker.md) supplies separate background controls.
The dashboard has tracking health and guarded stop. Source setup does not start either worker or install an OS service.
Network failure remains a failure in schedule history, never a completed no-change result.

Total company revenue does not establish AI/CCL exposure, product qualification, shipments, margin, or a customer relationship.
You still review evidence and thesis interpretation separately. No source tick accepts either decision.

- [ ] Run quality control checkpoint
