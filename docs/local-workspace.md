# Local research workspace

This candidate supplies an Inbox for your own research records.
It uses the same private SQLite workspace as the [local execution CLI](local-execution.md).
It does not need the private EquityLayer backend.

Use Node 22.13 or later on a supported POSIX system.
Local checks cover macOS on Node 22.13 and 25.2.1. Other environments need CI evidence.
The interface uses English and the existing EquityLayer body typeface and colors.

## Start

From the repository root, run:

```sh
npm run research:workspace -- --workspace /absolute/private/workspace --show-link
```

Open `private_session_link` from the command output in your browser.
The server chooses a free local port. You can set a specific port with `--port 3104`.
It binds only `127.0.0.1`. It does not open a browser automatically.
Stop the process with Ctrl+C. Start it again to create a new session link.

The workspace path must be absolute. The ledger creates an empty workspace if the directory is new.
Use a private directory outside Git. The directory uses `0700` permissions and database files use `0600`.
The database is not encrypted by default.

Without `--show-link`, startup prints only the local origin and permission status.
The private link contains a bearer token in its fragment. Do not share the link or save its output in public logs.
The interface removes that fragment from the address bar and keeps only the token in session storage.
Private research stays in memory while the interface is open. It does not enter browser local storage.
Select **Lock workspace** to clear the token and visible private text.
Restarting the server invalidates older links. A locked interface needs a current session link.

## Connect your existing AI session

### Who controls research time

Your AI client selects the model and controls research duration and provider charges.
The local session MCP serves permitted evidence and receives results. It does not invoke or stop the model.
Its bounded reads and connection checks are not a research-session timer or a billing ceiling.
There is no automatic 120-second research limit for this connection.

Set any research limit in your own client. Reserve time for the final result and submission-status check.
An incomplete task must identify processing limits and unread evidence, not invent claims or report no change.
No submission means no new research record. A completed client process does not prove Inbox delivery.
The [local session instructions](../prompts/local-session-research.md) describe this return boundary.

A separately configured background runner follows its explicit execution, lease, and runtime limits.
Its unknown-usage reservations remain separate from external-session results.
An external return does not settle or authorize a retry of an old runner request.

### Prepare a research connection

The unpublished local candidate includes a private MCP server over stdio.
Use an AI client that can launch a local stdio MCP process.
This is separate from the hosted EquityLayer MCP. It does not send your private question to the hosted service.
It is not a remote connector for the ChatGPT website.

Open a watch and use **Research with my AI**:

1. Select a retained method and up to 30 permitted retained sources. Load more options if necessary.
2. Confirm private task access and candidate-method use. Select result return only if you want your AI to submit to this Inbox.
3. Select **Prepare connection**. Add the displayed local stdio connection in your AI client.

No method, source, or permission is selected by default. A blocked source remains visible but cannot be selected.
If you select no sources, confirm the evidence gap. That task can report missing evidence, not establish an investment conclusion.
Preparation does not start AI, fetch sources, change source permissions, or accept research.
The panel does not configure source access or import a missing method. Complete local setup first.
Expand **Prepared tasks** to restore a current-scope selection or open its returned result.
Restoring a selection requires fresh permission confirmation. A new scope needs a new task.
Use **Refresh task options** to reload retained options and prepared tasks.

The CLI remains available for exact retained identities:

```sh
equitylayer session prepare --workspace /absolute/private/workspace \
  --watch WATCH_UUID --revision 1 --method METHOD_SHA256 \
  --source-event RETAINED_EVENT_ID \
  --preparation-id PREPARATION_UUID \
  --allow-private-context --allow-candidate-method --allow-external-submission
```

Replace the uppercase values with the exact retained identities and a new preparation UUID.
Repeat `--source-event` for up to 30 selected events. Omit it when evidence is unavailable.
Reusing the same preparation UUID and inputs recovers the original task after an uncertain preparation reply.
Changed inputs require a new preparation UUID. Preparation does not fetch sources or invoke a model.
The dashboard generates the preparation UUID and supplies the selected retained identities.

The output contains `mcp_command.command` and `mcp_command.args` for your AI client's local MCP configuration.
These values point to the Node executable and this installed client by absolute path.
Keep the output private. It contains your workspace path and task identity, but does not print the private question or source body.
Your AI client owns model selection, credentials, inference, and any associated charges.
The EquityLayer server does not start another model process.

### Read the prepared task

Use the [local session instructions](../prompts/local-session-research.md) with the connection you prepared.
These instructions do not start AI or grant access. Review your AI client's permissions and charges before use.
The local.16 contract returns a manifest first, not inline source bodies.

1. Call `get_research_task` with these arguments:

```json
{}
```

2. Read the required task sections. Copy the matching section hash from `sections` into `sha256`:

```json
{"view":"read","section":"citation_dates","sha256":"MANIFEST_SECTION_SHA256","offset":0,"limit":2048}
```

Replace the placeholder before use. Read `private_context`, `method`, `baselines`, and `citation_dates` before research.
Read `instructions` for this task's requirements. Read `source_metadata` and `facts` when those sections are necessary.
For each section, continue with `offset: next_offset` until `next_offset` is null.
Concatenate the returned text before parsing a JSON section. Do not parse each incomplete range as a complete JSON object.

3. Find relevant source text with its listed event ID and artifact hash:

```json
{"view":"find","source_event_id":"MANIFEST_SOURCE_EVENT_ID","sha256":"MANIFEST_SOURCE_SHA256","query":"Operating cash flow","offset":0}
```

4. Read the source near a match:

```json
{"view":"read","source_event_id":"MANIFEST_SOURCE_EVENT_ID","sha256":"MANIFEST_SOURCE_SHA256","offset":0,"limit":2048}
```

Replace both placeholders. Set `offset` to the match's `context_start` for the first nearby range.
Continue with `next_offset` when necessary. Read relevant table headers, periods, units, and footnotes before citing a number.
Offsets count UTF-8 bytes, not characters. Use only returned continuation offsets to avoid splitting a character.

Each read returns at most 2048 content bytes. Search returns at most three literal matches per page.
Continue source lists with `cursor: next_source_cursor`. Continue search results with `offset: next_offset`.
Search is case-sensitive over original text. Tags or entities can prevent a match in retained HTML.
A miss does not prove missing issuer disclosure. An available source is not a reviewed source.
Partial ranges do not establish complete coverage or claim support.

A changed hash, source gate, or scope change stops access. Report the exact limitation rather than inventing financial facts.
An oversized manifest returns `SESSION_READ_RESPONSE_LIMIT`, not a truncated success. Do not bypass the selected scope.
If `submit_research` is available, use its declared schema for the result. Do not return a manually edited workspace archive.
After submission, check `get_submission_status`. Review the retained result in this workspace before accepting anything.
The read-only connection cannot submit. Preparation, reading, and submission never accept evidence or a thesis judgment.

### Citation dates

In Sources, external research shows one date label: `Published (reported)`, `Retrieved · publication date unknown`, `Date basis varies by source version`, or `Date basis not recorded`.
The last label applies to legacy records without a saved date basis. A date match does not establish claim support.

New preparations use external context version 2.
Read the `citation_dates` section through `get_research_task` to obtain dates and their basis.
Use the listed UTC date for the source URL. A declared `published_at` supplies `declared_publication`.
When that value is unknown, retained `retrieved_at` supplies `retained_retrieval`.
A retrieval date is not a publication date or independently verified historical availability.
The policy does not grant source rights, make unsupported PDF content readable, or establish claim support.

The seven return fields and four citation fields remain unchanged.
Version 2 rejects a citation date that matches no retained metadata for its URL.
The resulting external record uses version 2 and stores derived `source_dates` outside the research result.
Each entry lists all matching source events, artifact hashes, and bases. Multiple matches do not establish unique claim attribution.
Accepted evidence preserves these date bases in the next task's comparison context.
Usage, source authenticity, and research quality remain unverified. Human review is still required.

Existing version 1 contexts and records retain their exact validation and hashes.
Their `citation_dates` section reports `enforced: false`. The client does not apply a new date basis to old citations.
The submission envelope remains version 1. SQLite remains schema 12, without a migration for this addition.

### Check the local connection without AI

Preparation also returns `check_command.command` and `check_command.args`.
Use those exact values, or run the equivalent command with your prepared context ID:

```sh
equitylayer session check --workspace /absolute/private/workspace \
  --context PREPARED_CONTEXT_ID \
  --allow-private-context --allow-candidate-method --allow-external-submission
```

Omit `--allow-external-submission` when checking a read-only connection.
The check starts this installed server, checks the MCP protocol and expected tools, reads submission status, and closes the process.
It does not call `get_research_task` or `submit_research`. It does not invoke AI, fetch sources, change review state, or settle model usage.
It refuses storage that requires migration. SQLite can touch journal metadata; this is not a filesystem read-only sandbox.
It uses fixed diagnostic codes and does not print child diagnostics or task content.

`connection_ok` verifies this local connection only. Source access, AI authentication, model availability, research quality, and actual return remain unchecked.
The standalone check has a five-second process limit. A stopped or failed check is not evidence of successful research.
Keep the generated command private because it contains your workspace path and context identity.

The connection exposes only these tools:

| Tool | Effect |
| --- | --- |
| `get_research_task` | Read the manifest, then find or read pinned task sections and permitted source ranges. |
| `submit_research` | Save one external result for human review. It does not adopt its evidence or interpretation. |
| `get_submission_status` | Read whether this task has a retained result, without reading private source content. |

Omit `--allow-external-submission` to create a read-only connection. That connection does not advertise the submission tool.
The connection cannot select another context, change a watch, grant rights, invoke a model, release budgets, pay, or trade.
Source text is data, not instructions. Raw source text is not automatically verified financial evidence.
Source and scope changes can block task access or a new submission while the connection is open.

After a lost submission reply, call `get_submission_status`.
An exact retry must reuse the same submission UUID, session declarations, and research content.
A changed result cannot replace an existing result for that task. Prepare another task for a new research attempt.
Exact committed replay and submission status remain available after HOLD. They grant no new access to the source body.

External session identity remains caller-declared. Usage, source authenticity, and research quality remain unverified.
An external result never settles a native request with unknown usage or releases its reservation.
The current draft stores the external result and a separate review notice in SQLite.
External results appear in the same Inbox as runner results and thesis candidates.
Open the result to read its declared client and model, source pins, and unverified-usage status.
The Inbox sorts external research by its local SQLite receipt time, not the task preparation time.
The list shows **Received**. The detail shows **Received** and **Task prepared** separately.
An exact submission replay preserves the original receipt time. Reopening does not make an old result new.
If no valid local receipt time is available, the interface shows **Not recorded** without substituting the task preparation time.
**Proposed next check** is a research suggestion, not a scheduled check or an extension of source permission or freshness.
Use the five human review actions below. The session MCP cannot call those actions.
Submission alone never accepts research or acknowledges its notice.

External and runner results share the current evidence and interpretation selections, but keep separate records and review journals.
Accepting external B's evidence does not change the accepted interpretation of A.
Receiving, revisiting, or rejecting B changes neither selection.
The next prepared task or scheduled run can use explicitly accepted evidence as a pinned comparison baseline.
Baseline source rights are checked again before its content is supplied, including after a cached execution context exists.
Historical comparison content does not become current evidence merely because it was previously accepted.

Protocol, persistence, and installed byte checks do not establish successful financial updating or unaided customer use.
Verify actual research and a later evidence update separately. Do not describe those checks as complete product acceptance.

The bounded transport implements the [MCP stdio framing](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
[initialization lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle), and [tools interface](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
It negotiates protocol versions 2025-06-18 and 2025-03-26. It does not implement HTTP, resources, sampling, or elicitation.

## Use the Inbox

1. Save a watch with a theme, company symbols, private question, and trigger.
2. Configure permitted retained sources and methods. Prepare a private session task, or separately authorize a configured runner and its budget.
3. Read the external research or runner result in the Inbox.
4. Select a review action and supply a reason.

Saving a watch does not authorize AI execution.
The interface permits 1 to 20 selected symbols across markets. It does not limit AI Compute to three Taiwan issuers.
Editing a watch creates its next immutable scope revision.

The left column filters themes, companies, and watches. The right column shows research details and review controls.
The middle column shows results, current gates, and unacknowledged notices.
The Inbox starts with the latest 50 retained entries from each research collection: runner results, external research, and theses.
Each collection uses descending append sequence, not an attested wall clock. The mixed list then sorts the loaded entries by their displayed times.
Select **Load older results**, **Load older external results**, or **Load older theses** to read earlier entries.
New arrivals during pagination appear after Refresh. They do not change an existing older-page cursor.
The watch filter applies before pagination. Theme and company filters apply only to loaded pages.
Load older pages to inspect additional retained records that match a theme or company.
Refresh returns lists to their current first page. Load older pages again instead of retaining stale review snapshots.
Pagination changes the view, not the retained history.

The three research list endpoints accept `order=newest` or `order=oldest`.
Omitting `order` preserves the ascending API behavior and response shape.
For newest pages, `after=0` starts at the latest retained entry. Use `next_after` with the same order to read lower sequences.
An empty final page preserves the cursor. A full page can require one further read to confirm the end.
Other list endpoints do not accept `order`.

Opening a result does not acknowledge or accept it.
Review actions have separate effects:

| Action | Effect |
|---|---|
| Received | Record receipt. Preserve accepted evidence and interpretation. |
| Accept evidence | Change the evidence reference only. |
| Accept interpretation | Change the interpretation reference only. |
| Revisit | Record a request to recheck. Preserve prior acceptance. |
| Reject | Record rejection. Preserve prior acceptance. |

A review saves its journal entry and acknowledges that delivery notice in one transaction.
Acknowledging another notice does not change source rights or research acceptance.
`SOURCE_NEEDED` and old-scope results cannot replace current accepted evidence or interpretation.
Both result types require current local source permission before new acceptance. External acceptance also rechecks its pinned method, facts, source versions, and current authority.
A HOLD remains a current gate after its notification is acknowledged.

Schema 12 adds the external review journal. Workspace startup verifies current-schema storage but refuses an older schema.
Use the [explicit copy-upgrade procedure](installable-client.md#backup-before-an-upgrade) before opening older storage with the new client.
Keep backups outside Git. No real workspace migration is claimed by the synthetic migration tests.

## Recovery

An uncertain reply retains the exact request in interface memory.
Read the refreshed record, then select **Retry exact request**.
The ledger does not duplicate an identical committed review.
Do not reload while a request remains uncertain. Reload clears its in-memory request.
After a reload, inspect the complete review journal before submitting a new decision.

If another window changes the record, the server rejects the stale review.
Read the refreshed record before submitting a new review. The interface does not adopt a new revision silently.
The complete journal remains paginated. Recent detail previews show at most ten entries.

The legacy import accepts a JSON archive of at most 2 MB.
It preserves original bytes, original acceptance, and unknown provenance.
Legacy acceptance remains `legacy-unclassified`. It does not become a new accepted evidence reference.

## Local security and remaining boundaries

Every API read and write needs the session token. Writes also need same-origin request headers.
The server rejects foreign hosts, origins, proxy headers, and cross-site requests.
It exposes fixed routes only. It has no model, source-policy approval, payment, order, or trading route.
Assets and the Inter font load from the same local origin, not a font CDN.

The token protects against unauthenticated local requests. It does not protect against a compromised caller process or malicious browser extension.
Do not treat loopback binding as an operating-system sandbox.

Visible-tab refresh checks local records every 30 seconds for at most 120 checks.
It pauses during edits and pending writes. Select **Refresh** after the automatic checks stop.
This is Inbox refresh, not a background source scheduler or AI invocation.

## Tracking

Expand **Tracking** above the current gates to read the loaded schedule records.
Each record shows its source, scope, last check, next due time, permission, and worker state.
Dates use the browser's local time zone. Filters apply to loaded pages.
A watch selection starts with that watch's first tracking page.

Configured status does not prove that a background worker runs.
The [continuous worker](local-background-worker.md) now records a renewable heartbeat while it waits between checks.
**Monitoring** means that a current worker heartbeat exists, not that sources are fresh or research is complete.
**Worker offline** means that no current continuous heartbeat exists. A live finite check still shows **Checking now**.
Source permission and failed-check warnings remain visible even when a worker runs.
The [finite scheduler](local-scheduling.md) also writes to this same SQLite record. Both need a running process.
The panel does not configure, enable, or execute a schedule.

**Stop tracking** checks the exact schedule revision and configuration hash before it disables that schedule.
It preserves research history, accepted evidence, and accepted interpretation.
A stale stop cannot disable a replacement configuration.
After an uncertain reply, inspect the current state before you select **Retry exact request**.
Do not reload while the exact request remains in memory. A replacement requires a new stop action after refresh.
To enable a stopped schedule, use the CLI to save its next immutable configuration revision.

Tracking read failures remain in this panel. They do not replace valid Inbox content with a load error.
The guarded stop has no AI, payment, or order action.

Controlled Chromium checks cover stop, server restart, lock, focus, and desktop/mobile viewports with synthetic records.
They do not prove native mobile behavior, real research, or background execution.
Other live adapters, real native AI research, independent research evaluation, method promotion, and release verification remain open.
Historical maintainer reports remain in the source checkout only:
`docs/2026-10-12-local-workspace-verification.md` and `docs/2026-10-13-tracking-workspace-verification.md`.
The installed package excludes these audit reports. They do not verify a later release or a new research run.
