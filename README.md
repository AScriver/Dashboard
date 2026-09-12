# Actionables

> Give Codex a persistent, evidence-backed execution queue.

Actionables is a local, single-user Windows companion for Codex. It turns
findings from reviews, audits, and investigations into scoped work that Codex
can research, claim, implement, and validate. The original evidence, decisions,
dependencies, and activity history stay attached to each item across Codex
tasks instead of disappearing into chat history or a flat to-do list.

![Actionables showing a selected Ready task and a wide Start with Codex handoff panel](docs/images/actionables-codex-workflow.png)

_The execution queue, lifecycle controls, recorded research and validation, and
built-in Codex handoff._

## What Actionables gives Codex

- A durable task record with priorities, intended outcomes, source references,
  file locations, research notes, and planned validation.
- Organize work by project, repository, and worktree, with one level of
  scoped subtasks so Codex only discovers work from the selected feature or bug.
- An explicit lifecycle—`Inbox` → `Researching` → `Ready` → `In progress` →
  `Done`—with blocked and dismissed states.
- Ownership claims, dependencies, validation requirements, handoff context, and
  an auditable activity history.
- Dashboard queues, stale-work alerts, search, and include/exclude filters for
  deciding what should be handed to Codex next.
- Archive completed scopes and restore them later.
- Let Codex create and coordinate scoped tasks through an authenticated,
  loopback-only MCP endpoint.

The sidebar lists repositories with their branches/worktrees underneath. Each
repository can be expanded or collapsed independently. Project scopes remain
available through the top-bar selector and repository setup. Choosing
**Actionables** clears the project, repository, and worktree filters while
preserving other filters; the existing **Done** shortcut still returns to active
work when you choose **Actionables**. **Settings** is at the bottom of the
sidebar and remains available in its collapsed navigation rail. Repository
archive actions are no longer shown in the sidebar; scope archival through the
API is unchanged.

## Requirements

- 64-bit Windows
- Node.js `>=22.19.0 <25` (`24.18.0` is the intended runtime)
- pnpm `11.9.0`
- PowerShell 7
- Current Microsoft Edge or Google Chrome

See the [support policy](docs/support-policy.md) for the versions verified by
the project.

## Run Actionables locally

From the repository root:

```powershell
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm run db:setup
pnpm run dev
```

On a clean checkout, open
[http://127.0.0.1:4173](http://127.0.0.1:4173). If either default loopback port
is busy, startup selects and reports another adjacent web/API pair, saves it in
`data/runtime-ports.json`, and reuses it on later launches while available.
Press `Ctrl+C` in the terminal to stop the web and API processes.

Set `WEB_PORT` and/or `API_PORT` before startup to use explicit custom loopback
ports. Explicit values must be whole numbers from 1 through 65535 and are never
silently replaced when occupied. Explicit values override the corresponding
saved values. See the startup output or Windows operation guide for the
effective URL and troubleshooting details.

No `.env` file is required. The default SQLite database is created at
`data/actionables.db`. For detailed setup, restart, recovery, and
troubleshooting instructions, see
[Windows setup and local operation](docs/windows-setup.md).

Manage existing repository assignments under **Settings → Repository projects**.
Choose another active project or **No project**, then **Save assignment**.
Removing an assignment keeps the repository available under No project, with
the same local path, worktrees, Actionable IDs, history and workflow status.
Release active or expired agent claims before moving their repository; restore
an archived repository or project before changing its assignment. These changes
affect dashboard organization only and never move folders or modify Git.

For a monorepo, set **Project directory** when adding a repository or under
**Settings → Repository projects**. Enter a relative directory such as
`apps/web`; blank keeps the existing checkout-root behavior. Track sibling
projects as separately named repository entries with the same local checkout
and their own project directories. The selected entry determines the project;
Actionables does not infer ownership from titles or attached files.

**Open in Codex** resolves that directory inside the selected worktree (or the
repository path when no worktree path is saved). It checks that the directory
exists and stays inside that checkout, including junction resolution. An
unavailable or invalid configured directory shows an error and retry action;
it never silently launches at the broader root. Codex loads the applicable
`AGENTS.md` chain through this working directory, including project-specific
guidance. A directory moved on disk must be corrected in Settings.

For MCP creation with `ensureScope`, pass a path inside the intended project.
The deepest matching registered project directory wins; sibling projects stay
separate. Ambiguous registrations or a checkout-root path that does not select
any registered project return a correction error. Explicit scope IDs retain
their existing behavior. Directory edits require released claims and advance
the affected scope/task versions without changing their IDs or lifecycle.

## Work-item progress

Parents with direct tasks show **Work-item progress** in the **Relationships**
tab: completed, dismissed, open, blocked, unclaimed and validation-ready counts.
All attached direct tasks count, including archived tasks. Blocked and unclaimed
are subsets of open; an expired claim remains claimed until released.
Validation ready means a current, unsuperseded Passed record under the existing
completion policy. The parent still needs its own validation and every direct
task must be Done or Dismissed before parent completion.

## Default scope for new Actionables

Under **Settings → Default actionable scope**, select a project / repository /
worktree and choose **Save default scope**. This preference is saved in the
current browser. A current scope selection takes precedence; without one,
creation uses the saved worktree or the first complete active scope if that
worktree was archived or removed. Repository reassignment follows the same
worktree under its current project. **Clear default scope** restores the normal
available-scope fallback. New items still start as Inbox, with Unset priority,
Unknown effort and Unclassified evidence. Existing items are unaffected.

## Connect Codex

The Codex connection is opt-in. Generate an `ACTIONABLES_MCP_TOKEN` by following
[Agent task MCP endpoint](docs/mcp-agent-tasks.md#enable-it), then restart
Actionables. The default MCP endpoint is `http://127.0.0.1:4174/mcp`. If
`API_PORT` is set before startup, use the effective endpoint shown by first-run
setup or **Settings → Actionables agent integration** instead.

Add the server to `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.actionables]
# Replace this default URL when Settings reports a custom effective endpoint.
url = "http://127.0.0.1:4174/mcp"
bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"
enabled = true
required = false
```

Restart Codex after changing its configuration. On first use, or later under
**Settings → Actionables agent integration**, Actionables can also install its
Codex coordination instructions and workflow skill. Both components are
optional, unchecked by default, and installed without replacing unrelated
instructions. Known unmodified older skill copies can be updated explicitly;
customized files are never overwritten. After installing the workflow skill,
choose **Open Skills in Codex** to inspect it in the documented Skills view.
This does not replace the required Codex restart after MCP configuration
changes.

If a saved API port later becomes unavailable, startup selects and persists a
new endpoint. When `%USERPROFILE%\.codex\config.toml` contains the previously
managed Actionables entry, startup updates only that URL and tells you to
restart Codex. Matching configuration is left byte-identical. Malformed,
ambiguous, or user-managed Actionables entries are never overwritten; startup
instead reports the file, stale endpoint, replacement endpoint, and required
manual review.

The endpoint stays disabled until a non-empty token is configured and only
accepts loopback connections. Setup and Settings report `Disabled` in that
state; the URL is not usable until Actionables is restarted with the token. Do
not print, paste into task records, or commit the token. See
[Agent task MCP endpoint](docs/mcp-agent-tasks.md) for token generation,
security details, and troubleshooting.

## Hand work to Codex

1. Capture a top-level feature or bug in `Inbox` with its intended outcome,
   evidence, sources, relevant files, and planned validation. Add direct
   subtasks when the work needs independent execution units.
2. Open an eligible, unclaimed Actionable in `Inbox`, `Researching`, `Ready`, or
   `In progress` and choose **Open in Codex** to prepare a local chat with the
   displayed prompt and, when valid, the tracked workspace. Codex leaves the
   prompt in the composer for review rather than sending it. **Copy prompt**
   exposes the same text. Manual or dependency blockers, archived or terminal
   tasks, and active or expired claims show the relevant unblock, existing
   claim, or release guidance instead of start actions. For example, an `Inbox`
   prompt begins:

   ```text
   Use Actionables work item #42. Claim task #47 and begin the Researching phase.
   ```

3. Review and send the prepared prompt, or paste the copied prompt into Codex.
   It names the governing work item and task, tells Codex to treat the
   Actionable as authoritative, and keeps discovery inside that feature or bug.
4. Codex claims the task, records research, and moves it through `Ready` and
   `In progress` before editing. It records actual validation before marking the
   work `Done`, or saves handoff context when another task must continue.

For a task that is already `Researching` or `In progress`, Actionables generates
a prompt that resumes its recorded phase. A `Ready` prompt directs Codex to
confirm the recorded scope and move to `In progress` before editing. Claims
prevent two Codex tasks from silently working the same item, while leases and
handoffs make interrupted work visible.

Customize these prompts under **Settings → Codex start prompts**. Research and
implementation templates are saved independently of the three local helper
prompts. Each **Reset to default** button resets only its template; choose
**Save settings** to persist the change. Existing installations use the current
application defaults until a custom template is saved.

Templates accept the following literal, case-sensitive variables. Include both
ID variables to identify the correct work. Unknown names, malformed double
braces and missing IDs are rejected. Expressions are not evaluated, and inserted
titles are never interpreted as template syntax.

| Variable | Value |
| --- | --- |
| `{{workItemId}}` | Governing top-level Actionable ID (required) |
| `{{taskId}}` | Selected Actionable ID (required) |
| `{{taskTitle}}` | Selected title as literal text |
| `{{phaseAction}}` | Begin/resume research or continue/resume implementation |
| `{{splitInstructions}}` | Root or direct-task research splitting guidance |
| `{{implementationInstructions}}` | Ready preflight and implementation or coordination-root finalization guidance |

The defaults retain the existing lifecycle, scope, splitting, validation and
handoff instructions. Custom templates affect both **Open in Codex** and
**Copy prompt** without changing workspace selection or claim eligibility.
Start actions wait for valid saved settings; a loading failure offers a retry.

The dashboard derives its queues and alerts from lifecycle, validation,
hierarchy, dependency, and claim state, so stalled or blocked work remains
visible.

## Optional local Codex helpers

Inbox triage, note grooming, and relationship auditing can use a signed-in local
Codex CLI. From the Dashboard, **Triage up to N** processes the configured
number of active tasks from the current **Inbox requiring triage** queue,
updates each task's triage fields without changing Research notes, and moves
successful tasks to `Researching`. Per-task failures are reported without
rolling back other successful tasks or falsely reporting the batch as complete.
The other helpers remain review-only proposals. All helpers run only when
requested and use a read-only Codex sandbox. See
[Windows setup and local operation](docs/windows-setup.md#optional-codex-instructions-and-workflow-skill)
for configuration, invocation, and troubleshooting.

## Local data

Application state is stored in the local SQLite database. The app no longer
provides a Data page or JSON import/export interface. Existing records and
source evidence remain available.

- [Local data and historical backups](docs/backup-restore.md)
- [Internal seed reconciliation format](docs/portable-data-format.md)

## Production-mode local run

```powershell
pnpm run build
pnpm run db:migrate
pnpm run start
```

The supported deployment remains local and single-user. There is currently no
installer, updater, published binary, hosted service, or supported non-Windows
deployment.

## Development and verification

Run the complete release gate with:

```powershell
pnpm run verify:release
```

This checks formatting, types, API and integration tests, browser end-to-end
tests, automated accessibility, the production build, migrations, SQLite
loading, seed idempotence, and the living plan.

Additional project documentation:

- [Windows setup and troubleshooting](docs/windows-setup.md)
- [Runtime and browser support](docs/support-policy.md)
- [Accessibility audit](docs/accessibility-audit.md)
- [Release-verification report](docs/release-verification.md)

## Current scope

Actionables is deliberately focused on local execution coordination. It does
not provide user accounts, team collaboration, notifications, cloud sync,
hosted deployment, Git operations, automatic relationship changes, or generic
project-management features.
