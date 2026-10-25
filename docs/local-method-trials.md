# Local paired method trials

This controller compares two method versions against one retained historical input.
It does not approve a method, prove research quality, or perform a securities transaction.
Use Node 22.13 or later on the supported POSIX platform.

## Prepare the local inputs

1. Retain an original research case, a candidate, and a frozen plan with the method-artifact commands.
2. Configure a separate budget window with the `method-trial:` prefix. The existing `init` command can retain this budget.
3. Declare a trusted local command in a private runtime JSON file. Set all five execution fields explicitly.
4. Read the declared policy with `method-runtime-policy`. Freeze its exact hash in the plan.
5. Enqueue the pair with `method-enqueue`. Supply the exact plan, case, candidate, repetition, runtime policy, budget window, and run policy.

The original case needs its retained execution snapshot or exact source-decision fact references.
Missing snapshots do not become current broad source inputs. Exposed historical cases remain regression cases, not unseen holdouts.
Both roles pin the candidate identity. Different candidate comparisons cannot share an incumbent run.

The runtime policy contains this structure:

```json
{
  "schema_version": 1,
  "runtime": {"identity": "caller-runtime-name", "config_sha256": "<declared SHA-256>"},
  "execution": {
    "estimate": {"tokens": 1000, "cost_microusd": 10000, "wall_ms": 30000},
    "timeout_ms": 30000,
    "lease_ms": 30000,
    "heartbeat_ms": 5000,
    "retry_delay_ms": 1000
  }
}
```

These values are an example, not a recommendation or provider bill.
The controller checks declared settings. It does not authenticate a model, binary, or provider usage report.
The command adapter does not provide an operating-system sandbox.

## Execute and inspect

```sh
node client/local-cli.mjs method-runtime-policy --workspace /absolute/private/workspace --runtime /absolute/private/runtime.json
node client/local-cli.mjs method-enqueue --workspace /absolute/private/workspace --input /absolute/private/pair-request.json
node client/local-cli.mjs method-run --workspace /absolute/private/workspace --run-id <role-run-id> --runtime /absolute/private/runtime.json --allow-private-context --allow-candidate-method --allow-method-trial
node client/local-cli.mjs method-pair-status --workspace /absolute/private/workspace --pair-id <pair-id>
```

Run each role separately. A caller can invoke multiple workers against the same SQLite workspace.
The runtime consumes the existing bounded research input and returns the existing seven agent fields with measured usage or `null`.
The source policy must permit local research, candidate trials, each selected issuer, the metric, and the evidence state.
Current authority and source age are checked at context creation, dispatch, completion, and reconciled resume.
Historical semantic time remains fixed. Actual deadlines and accounting use the current execution clock.

Trial outputs remain in `method_trial_outputs`. They do not become Inbox deliveries, cursor progress, or accepted evidence or interpretations.
Ordinary research entries cannot enqueue, claim, execute, or finish a trial.
Status records label the purpose as `research` or `method_trial`.

## Recovery

Expired leases use the dedicated trial claim. Settled responses can survive a restart without another charge.
Unknown usage retains its budget hold. The existing `reconcile` command requires a selected measured receipt and an explicit resume decision.
Do not substitute estimated usage for a missing receipt.

A resolved source or consent gate requires an explicit `method-resume` request:

```json
{"run_id":"<trial-run-id>","decision_id":"<unique-decision-id>","reason":"Explain why this exact trial can resume."}
```

```sh
node client/local-cli.mjs method-resume --workspace /absolute/private/workspace --input /absolute/private/resume.json
```

Resume does not grant source rights, clear unresolved usage, extend a deadline, increase attempts, or change the frozen inputs.
Replay of the exact decision is idempotent. Changed content under the same decision ID is a conflict.
Schema 1–5 upgrades preserve a private backup before adding schema 6.

## Remaining product acceptance

- [ ] Validate actual caller AI connections and scheduled source execution.
- [ ] Curate unseen cases and calibrate the independent evaluator.
- [ ] Obtain exact human approval before method promotion. Preserve rollback history.
- [ ] Complete installation, permitted user-operation checks, CI, and release verification.
- [ ] Run quality control checkpoint

Engineering tests and deterministic synthetic runtimes do not satisfy these remaining acceptance items.
