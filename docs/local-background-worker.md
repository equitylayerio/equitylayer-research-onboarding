# Local background research worker

Internal candidate. Use Node 22.13 or later on a supported POSIX system.
The current continuous and OS checks ran on macOS with Node 24.19.0 and 25.2.1.
The macOS service planner refuses other platforms. Linux supervision and clean user installation need separate verification.

The worker uses the same private SQLite workspace as your research Inbox.
It checks relevant evidence on the configured interval. It invokes only the explicitly approved caller, within the existing source and budget gates.
An unchanged event does not repeat AI research. No result becomes accepted without your review.
This process does not supply a hosted model account, approve source rights, make payments, or place investment orders.

## Start a continuous process

Complete [local execution setup](local-execution.md) and save a [schedule configuration](local-scheduling.md) first.
In the local workspace, open **Tracking** and select **Set up source checks** for an eligible observation schedule.
The workspace displays a command for the exact saved revision and configuration hash.
Use **Copy start command**, then run it in a separate local terminal. Keep that terminal open.
If clipboard access fails, select and copy the command from its read-only field.
**Hide start instructions** closes the guide. It does not stop or start tracking.
The browser does not start a worker, invoke AI, or install a background service.
Stopped, changed, held, or actively monitored schedules do not offer a new start command.
The command checks its pins again when it starts. A changed configuration requires new instructions.
Keep the command private because it includes your local workspace path.

For manual configuration instead, use the commands below.
Read the exact revision and `config_sha256` with `schedule-status`.
The following identifiers and paths are placeholders. Replace them with your own reviewed configuration.

```sh
npm run research:local -- schedule-daemon-observe --workspace /absolute/private/workspace --schedule-id my-watch --revision 1 --config-sha256 EXACT_RETAINED_HASH --allow-continuous
```

This observation command requires a schedule with `max_runs: 0`. It cannot invoke AI.
For an execution schedule, supply the runtime and both existing research consent flags:

```sh
npm run research:local -- schedule-daemon-run --workspace /absolute/private/workspace --schedule-id my-watch --revision 1 --config-sha256 EXACT_RETAINED_HASH --allow-continuous --runtime /absolute/private/runtime.json --allow-private-context --allow-candidate-method
```

The runtime must match the schedule's exact runtime hash.
These flags authorize the configured caller to receive private inputs. They do not accept research or financial advice.
The process remains active until cancellation, a retained stop, changed scope/configuration, or a fatal worker failure.
Failed or gated source ticks remain in history. They do not terminate monitoring by themselves.
Ctrl+C and SIGTERM end the process without disabling the schedule. The CLI can restart that same configuration explicitly.
`schedule-stop` disables the retained schedule, including in-flight authority. It preserves research and acceptance history.
To enable it again, review and save the next immutable schedule configuration.
For unchanged observation-only tracking, the [guarded resume command](local-scheduling.md#resume-stopped-source-checks) creates that next revision.
It does not start a worker or update an installed OS service. Request new pinned instructions before starting checks again.

## Health and recovery

One continuous owner holds a renewable worker lease.
Its heartbeat continues while it waits between ticks. This records presence, not source freshness or research quality.
The default heartbeat is three seconds. Its lease expires after fifteen seconds without renewal.
The Inbox shows Monitoring, Checking now, Worker offline, and the last worker timestamp.
Current source gates and failed checks retain their warnings.

A restarted process waits at most one minute for the previous lease to expire.
It acquires a newer worker fence only after previous ownership ends or expires.
If another live owner continues renewing its lease, the restarted process returns busy after that bounded wait.
It cannot publish an output under an expired fence.
A live finite check cannot bypass a continuous owner. An old continuous record cannot hide a new finite check.
The check-to-worker binding remains in SQLite. Missing or altered bindings fail verification.

Each startup pins the exact schedule revision and configuration hash.
Changing a runtime file, watch revision, or schedule does not silently retarget the worker.
Unknown usage retains its reservation. Restart does not assume zero cost or erase that gate.
The worker does not run internal method trials or approve a new method.

Schema 10 adds operational worker health and tick bindings. Upgrade saves a private backup before it changes schema 9 or earlier.
Worker health retains the latest operational record. Research, source, tick, and review histories remain retained separately.
Hash checks detect changed records, not a hostile rewrite of every database record and hash.

## macOS service plan

Use the OS service only after you review the generated plan and its exact configuration hash.
The planner produces a property list. It does not write a LaunchAgents file or start a service.

```sh
npm run research:local -- schedule-service-plan --workspace /absolute/private/workspace --schedule-id my-watch --revision 1 --config-sha256 EXACT_RETAINED_HASH --node /absolute/canonical/path/to/node
```

For approved research execution, add `--runtime /absolute/private/runtime.json`.
The output contains `label`, `plist`, and the plan's `sha256`. Keep this output private because it contains local paths.
The planner runs your trusted Node executable with `--version`, a two-second deadline, and a bounded reply.
It rejects versions below Node 22.13 and reports `node_version`. This check does not attest the executable or all dependencies.
An installed agent uses the fixed service entry, not an arbitrary command or shell.
An approved runtime can still execute a local command with OS access. This service is not an OS sandbox.
It inherits no added model credentials from the planner. Native caller credentials still come only from the approved runtime configuration.

Save the exact `plist` as a private owned file named `<label>.plist`.
For a temporary test, place it outside the login LaunchAgents directories, then explicitly run:

```sh
launchctl bootstrap gui/YOUR_UID /absolute/private/path/LABEL.plist
launchctl print gui/YOUR_UID/LABEL
launchctl bootout gui/YOUR_UID/LABEL
```

YOUR_UID and LABEL are placeholders. The planner does not choose an account or install persistence for you.
For login persistence, a user can install the reviewed file in their own `Library/LaunchAgents` directory.
That changes login behavior and needs explicit user approval. This implementation did not enable a real user's research at login.
See [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) for OS agent behavior.

The service restarts after an abnormal process exit, with a ten-second OS throttle.
Handled application gates and deliberate stops exit normally, so the OS does not restart them repeatedly.
The reported research outcome can still be failed or gated. A normal service exit is not a claim of successful research.
Use `schedule-status`, Inbox health, and the retained tick codes to inspect the outcome.
The service creates no default output log containing private research. Configure any diagnostics carefully before sharing them.

## Current limits

Two approved temporary launchd tests used synthetic retained sources and no AI, payment, or order.
They prove local OS restart and retained stop behavior for that scope, not a complete financial monitoring product.
Real caller authentication/accounting, other permitted sources, a second real update, user installation, and pilot use remain open.
See [the portable verification boundary](local-verification-status.md#source-checks-and-workers). Detailed maintainer logs remain separate.
