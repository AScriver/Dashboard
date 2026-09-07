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
- Preview and reconcile portable JSON imports before saving, and export the
  complete local state for backup.
- Let Codex create and coordinate scoped tasks through an authenticated,
  loopback-only MCP endpoint.

The sidebar lists repositories with their branches/worktrees underneath. Each
repository can be expanded or collapsed independently. Project scopes remain
available through the top-bar selector and repository setup.

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

## Data and backups

Application state is stored in the local SQLite database. Portable JSON is the
supported backup and restore format; exports can contain source text, technical
paths, and research notes, so handle them as sensitive project data.

- [Backup and restore](docs/backup-restore.md)
- [Portable data format](docs/portable-data-format.md)

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
