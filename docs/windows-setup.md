# Windows setup and local operation

## Prerequisites

- Supported 64-bit Windows version and Node runtime listed in [support policy](support-policy.md).
- PowerShell 7.
- Current Microsoft Edge or Google Chrome.
- Git for a source checkout.

The repository pins pnpm through `package.json` and the intended Node release line through `.node-version`. Do not install project packages globally.

No `.env` file is required. The default database is `file:./data/actionables.db`; set `DATABASE_URL` only when an isolated database is intentional.

The agent MCP endpoint is disabled unless `ACTIONABLES_MCP_TOKEN` is set. See [Agent task MCP endpoint](mcp-agent-tasks.md) for the local token and Codex configuration.

## Optional Codex instructions and workflow skill

On first use, Actionables offers two independent, unchecked choices:

- **Actionables agent instructions** append a managed Actionables coordination section to `%USERPROFILE%\.codex\AGENTS.md`.
- **Actionables workflow skill** creates `%USERPROFILE%\.agents\skills\actionables-workflow\SKILL.md`.

Neither file is installed automatically. Choose either component, both, or **Not now**. The same installation controls and current file paths remain available under **Settings → Actionables agent integration**.

Installation is idempotent. Existing unrelated content in `AGENTS.md` is preserved, and an already matching component is left unchanged. A skill file that exactly matches a known older bundled copy is shown as **Update available** and is replaced only when you explicitly select the update. If a managed instructions section or skill file has any other difference, Actionables reports that manual review is required and does not overwrite it. Reconcile the target with the bundled files under `resources\agent-integration`, then retry from Settings.

Set `ACTIONABLES_AGENT_HOME` before starting the API only when Actionables should use a profile root other than the current Windows user's home directory. This override is primarily intended for isolated validation.

The optional Inbox triager, note groomer, and relationship auditor require the
local Codex CLI to be installed and signed in. Verify it from the same Windows
user account that runs Actionables:

```powershell
codex --version
```

Actionables invokes Codex once per helper task with an explicit model, a
read-only sandbox, an ephemeral session, an isolated temporary working
directory, and a required JSON output schema. The default model is
`gpt-5.6-terra`. To select another available lower-tier model, set
`ACTIONABLES_ASSISTANT_MODEL` before starting the app:

```powershell
$env:ACTIONABLES_ASSISTANT_MODEL = 'gpt-5.6-terra'
```

If `codex` is not on `PATH`, set `ACTIONABLES_CODEX_PATH` to the absolute
`codex.exe` path. Restart Actionables after changing either setting.

Configure **Settings → Triage Inbox with local Codex**, including **Tasks per
run**, then open the Dashboard and choose **Triage up to N** on **Inbox requiring
triage**. Each run selects at most that many active, unarchived Inbox tasks from
the current dashboard scope in queue order. A valid result updates only that
task's finding, description, priority, effort, evidence state, tags, and planned
validation; Research notes are never changed. The application applies each task
atomically and moves it from `Inbox` to `Researching`. One task failure does not
undo other successful triage, and the Dashboard reports completed, empty,
partial, and failed batches separately.

Note generation never saves an Actionable directly: review and explicitly apply
a note proposal in the Research notes tab. Relationship-audit recommendations
are limited to one top-level work item and its direct subtasks, and the audit UI
has no relationship mutation controls. No `OPENAI_API_KEY` is required for
these local-CLI integrations.

Settings can independently override the model, reasoning level, enabled state,
and prompt for all three helpers. Choosing the environment/default model keeps
using `ACTIONABLES_ASSISTANT_MODEL` (or the built-in fallback), and choosing the
selected-model reasoning default leaves Codex's model-specific reasoning level
unchanged. The shared local Codex timeout applies to each task in a bulk Inbox
triage run.

## Clean setup

Run from a normal Windows path; spaces are supported.

```powershell
git clone <repository-url> 'C:\Users\<you>\Documents\Actionables Dashboard'
Set-Location -LiteralPath 'C:\Users\<you>\Documents\Actionables Dashboard'
node --version
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm --version
pnpm install --frozen-lockfile
pnpm run db:generate
pnpm run db:migrate
pnpm run db:seed
pnpm run db:seed
```

The second seed import must report `0 created, 0 updated, 32 unchanged`.

The default database is `data/actionables.db`. To isolate a database for testing or recovery:

```powershell
$env:DATABASE_URL = 'file:./data/actionables-recovery.db'
pnpm run db:migrate
pnpm run db:seed
```

Unset the override when finished:

```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

## Development operation

```powershell
pnpm run dev
```

This migrates and seeds the configured database, then starts on these defaults
when they are available:

- Web: `http://127.0.0.1:4173`
- API: `http://127.0.0.1:4174`
- Health: `http://127.0.0.1:4173/api/health`

If either default is busy, Actionables reserves the next deterministic adjacent
loopback pair, saves the effective pair in `data/runtime-ports.json`, and reports
the selected web and API ports before starting both services. Later development
and production launches prefer that saved pair while it remains available. An
unavailable saved pair is replaced without stopping or changing the occupying
process.

To use explicit custom ports, set either or both variables to a whole number
from 1 through 65535 before startup. The web listener, API listener, proxy,
setup/status UI, and reported web, API, health, and MCP URLs then use the same
normalized pair:

```powershell
$env:WEB_PORT = '4273'
$env:API_PORT = '4274'
pnpm run dev
```

Blank, zero, nonnumeric, fractional, exponential, and out-of-range values fail
at startup with a variable-specific `WEB_PORT` or `API_PORT` validation error.
Both services remain bound to `127.0.0.1`. An explicit occupied port fails
startup and is never silently replaced. When only one variable is set, its
value is preserved while Actionables safely resolves the other port.

Stop with `Ctrl+C`. A repeat `pnpm run dev` is the supported restart.

### Scheduled development operation

When the optional `Actionables Dashboard` Windows Scheduled Task is registered,
its wrapper runs the same `pnpm run dev` command described above. The task is
the logon host; its wrapper is the only restart owner. An unexpected nonzero
exit is retried after one minute, up to three times. A run that remains active
for five minutes resets the consecutive-failure count. Launcher output and
wrapper start/exit messages are appended to
`%LOCALAPPDATA%\ActionablesDashboard\dashboard.log`; Task Scheduler's
Operational event log records the outer task start and exit.

Use Task Scheduler's stop operation for an intentional shutdown. A manually
stopped task remains stopped, is not treated as a crash, and its cleanup
watchdog terminates the development process tree. Start it again with:

```powershell
Start-ScheduledTask -TaskName 'Actionables Dashboard'
```

If MCP was enabled after the app started, restart the app so the API reads the new token.

## Production-mode local operation

```powershell
pnpm run build
pnpm run db:migrate
pnpm run start
```

`pnpm run start` also honors valid inherited `WEB_PORT` and `API_PORT` values
and uses the same saved-pair selection and persistence behavior as development.
It passes the resulting normalized pair to the API and Vite preview processes.

Verify health:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4273/api/health'
```

A ready response is HTTP 200 with `status: ok`, `database: ok`, and
`schema: current`. The schema value is based on the migration ledger of the
active configured database, not on a default path or a basic connectivity
query.

Stop with `Ctrl+C`; repeat `pnpm run start` to verify a clean restart.

## Release gate

```powershell
pnpm run verify:release
```

Individual diagnostics:

```powershell
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm run test:e2e
pnpm run test:a11y
pnpm run build
pnpm run verify:migrations
pnpm run verify:living-plan
```

## Troubleshooting

### Native SQLite installation or load

Always install from the lockfile under a supported Node runtime. Clear only the checkout-local install and reinstall if the ABI changed:

```powershell
Remove-Item -LiteralPath '.\node_modules' -Recurse -Force
pnpm install --frozen-lockfile
pnpm --filter @actionables/api exec node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); console.log(db.prepare('select 1 as value').get()); db.close();"
```

pnpm can retain native-package side effects in a shared store. The release proof found that a store populated under Node 22 could reuse an incompatible native ABI artifact under Node 24 even after checkout-local `node_modules` was removed. Repeat the install with a new runtime-specific store:

```powershell
Remove-Item -LiteralPath '.\node_modules' -Recurse -Force
$runtimeStore = Join-Path $env:LOCALAPPDATA 'Actionables\pnpm-store-node24'
pnpm install --frozen-lockfile --store-dir $runtimeStore
pnpm --filter @actionables/api exec node -e "const Database = require('better-sqlite3'); const db=new Database(':memory:'); console.log(db.prepare('select 1 as value').get()); db.close();"
```

The verified clean Node 24 install used the package's prebuilt binary. If installation attempts unexpected local compilation or the load still fails, record Node, pnpm, architecture, store path, and the full output. Do not work around the gate with an unreviewed package upgrade.

### Ports 4173 or 4174 are busy

```powershell
Get-NetTCPConnection -LocalPort 4173,4174 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,State,OwningProcess
```

When the variables are omitted, `pnpm run dev` and `pnpm run start` leave the
known process untouched and select another adjacent loopback pair. Startup
reports the effective ports and saves them in `data/runtime-ports.json`. If a
saved port later becomes busy, Actionables selects and saves another pair
without terminating the occupying listener.

When that fallback changes the saved API port, startup also checks the current
user's `%USERPROFILE%\.codex\config.toml`. It updates only an exact,
previously managed Actionables MCP entry and preserves every unrelated byte.
After a successful change, startup tells you to restart Codex. A matching
current entry and a missing Actionables entry are left unchanged. Malformed,
ambiguous, or user-managed entries are never overwritten; startup reports the
configuration path, stale endpoint, replacement endpoint, and manual restart
steps instead.

Set explicit `WEB_PORT` and/or `API_PORT` values when a particular port is
required. Explicit values are authoritative and fail clearly when occupied; the
startup process never stops an unrelated listener. To reset only the saved
preference, stop Actionables and remove `data\runtime-ports.json`; the next
launch tries 4173/4174 first.

### MCP returns 401, 403, or 404

- `404`: setup/status should report `Disabled`; set a non-empty
  `ACTIONABLES_MCP_TOKEN` and restart the app.
- `401`: make the MCP client read the same token and send it as a bearer token.
- `403`: use the effective loopback endpoint reported by first-run setup or
  **Settings → Actionables agent integration**. The MCP route rejects
  non-loopback Host and Origin values.

### Migrations fail

```powershell
pnpm exec prisma migrate status
pnpm run verify:migrations
```

`/api/health` returns HTTP 503 with `SCHEMA_MIGRATION_REQUIRED` when the active
database is missing a repository migration, has an incomplete migration, or
contains an unexpected migration. Actionables refuses mutations while that
condition remains. Confirm that `DATABASE_URL` identifies the intended database,
then inspect both `errors.migrations` and `pnpm exec prisma migrate status`. If
the history only has missing migrations, apply them to that same configured
database with `pnpm run db:migrate`. For incomplete history, preserve a backup
and use Prisma's documented migration-recovery workflow; for unexpected history,
use the matching application version or restore a verified compatible backup.
Retry only after health reports `schema: current`. Do not switch databases or
hand-edit the migration ledger merely to bypass the readiness check.

For missing migrations only:

```powershell
pnpm run db:migrate
```

Never edit an already-applied migration. Preserve populated databases before recovery. The former JSON import/export workflow has been removed; see [local data and historical backups](backup-restore.md).

### Database reset or recovery

Use a new explicit `DATABASE_URL` for diagnostic or reset runs, preserving populated databases. The current app has no built-in JSON restore workflow. See [local data and historical backups](backup-restore.md).

### Browser does not start

Open the web URL reported by startup in a supported browser and verify
`/api/health`. On the default pair this is `http://127.0.0.1:4173`; persisted or
explicit ports use their reported web URL. For Playwright:

```powershell
pnpm exec playwright install chromium
pnpm run test:e2e
```
