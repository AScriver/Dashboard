# MVP release-verification report

Status: **pass — verified 2026-07-25**

September 7, 2026 scope update: the Data page and public JSON import/export
routes have been removed. Import/export, portable backup, and Data-screen claims
below describe the original release only; those surfaces are no longer part of
the product or its browser gate. See [removal verification](import-export-removal.md)
and [local data](backup-restore.md) for the current state.

This report is the T-007 release decision for the local Windows MVP. It is evidence for the tested environment and declared support boundary, not a tag, published release, installer, or WCAG certification.

## Release definition and decision

The MVP is complete when a clean supported-runtime checkout installs from the lockfile; generates Prisma; loads native SQLite; migrates an empty database; imports and no-op reimports the generic sample seed; starts in development and production modes; shuts down and restarts without orphaned listeners; passes formatting, type, API/domain/integration, browser E2E, automated accessibility, build, migration, and living-plan gates; passes the recorded manual accessibility/responsive/keyboard/state review; proves portable export/restore equivalence; and retains the documented product boundary.

Result: **pass with the limitations below**. No unresolved release blocker was found.

## Environment and exact versions

| Component                    | Verified version                                           |
| ---------------------------- | ---------------------------------------------------------- |
| OS                           | Windows 11 Enterprise 25H2, build 26200.8390, x64          |
| Shell                        | PowerShell 7.6.3                                           |
| Intended Node runtime        | Node.js 24.18.0; npm 11.16.0; Corepack 0.35.0              |
| Additional supported runtime | Node.js 22.19.0; npm 10.9.3                                |
| Package manager              | pnpm 11.9.0, pinned by `packageManager`                    |
| Prisma                       | CLI/client 7.9.0                                           |
| Native SQLite driver         | `better-sqlite3` 12.11.1                                   |
| Browser runner               | Playwright 1.61.1; Chromium 149.0.7827.55                  |
| Installed browsers           | Microsoft Edge 150.0.4078.83; Google Chrome 150.0.7871.182 |

The official Node 24.18.0 Windows x64 archive used for the isolated proof matched the published SHA-256 value `0AE68406B42D7725661DA979B1403EC9926DA205C6770827F33AAC9D8F26E821`.

## Runtime support decision

The enforced runtime range is Node `>=22.19.0 <25` with pnpm `11.9.0`. Node 24.18.0 is the intended release runtime selected by `.node-version`; Node 22.19.0 is also supported because it passed the same clean install and complete gate. Earlier Node 22 implementation use was not treated as proof. Node versions below 22.19.0 or 25 and later are outside this release claim.

## Clean-checkout results

Disposable worktrees used paths containing spaces:

- `...\Actionables T007 clean proof\Node 24 checkout`
- `...\Actionables T007 clean proof\Node 22 checkout`

Each began without `node_modules`, generated Prisma output, build output, or a database. Each used a new isolated pnpm store and ran `pnpm install --frozen-lockfile`. Both installs downloaded 394 locked packages; the native driver install completed and an in-memory `select 1` returned `1`.

Under **each** Node runtime, the final `pnpm run verify:release` passed as one uninterrupted command:

- Prettier check: pass.
- TypeScript and Prisma generation: pass.
- Vitest: 5 files, 39 tests passed.
- Chromium E2E: 16 tests passed.
- Axe/Playwright: 3 suites passed with zero reported violations and no disabled rules.
- Production build: pass; main JavaScript 393.56 kB / 112.87 kB gzip, lazy Markdown 154.00 kB / 45.88 kB gzip, CSS 47.68 kB / 10.03 kB gzip.
- Fresh database: every repository migration applied and `prisma migrate status` reported up to date.
- Generic sample seed: first import created 32; second import reported 0 created, 0 updated, 32 unchanged.
- Direct `better-sqlite3` load/query: pass.
- Living-plan validation: pass.

September 11, 2026 Markdown maintenance: rendering now lives directly in
`src/Markdown.tsx`, with no separate lazy chunk or formatted-text loading state.
The production build produces one JavaScript bundle at 629.12 kB / 177.84 kB
gzip, compared with 476.16 kB / 132.49 kB gzip plus a 154.00 kB / 45.88 kB gzip
Markdown chunk immediately before this change. This moves Markdown into the
initial download and triggers Vite's existing 500 kB chunk-size warning; the
build succeeds and the warning threshold is unchanged.

The E2E web server exercised the documented development setup and browser access during both complete gates. Production-mode proof ran the documented build, migration, seed, and `node scripts/start-production.mjs` sequence: the UI at port 4173 proxied `/api/health` to port 4174 and returned HTTP 200 with database health and a correlation ID. A 2026-09-01 maintenance update made `status: ok`, `database: ok`, and `schema: current` the readiness contract. `Ctrl+C` closed both listeners; a second start returned health 200 again. The desktop PTY reports Ctrl+C as exit code 1 even for a control process that handles SIGINT and explicitly exits 0, so shutdown success was asserted by both ports closing and the successful restart.

Representative import/export and keyboard workflows also passed using the installed `msedge` and `chrome` Playwright channels.

## Browser, accessibility, responsive, keyboard, and state results

The structured criteria-level record is in [accessibility audit](accessibility-audit.md). The final maintained-default-rules axe gate has 3 passing suites covering representative dashboard, list/detail, forms, dialogs, lifecycle, validation, relationship, archive, Data, initial loading, offline, background refresh, archive-impact failure, invalid import, archived detail, filtered no-results, API error/retry, mobile, and reflow states. It reports zero violations and disables no rules. The manual audit found no unresolved WCAG 2.2 AA blocker on the audited surfaces.

Responsive screenshots and interaction checks passed at 1586×990 desktop, 1280×800 laptop, 900×800 pane collapse, 390×844 mobile, and 640×480 as a 200%-zoom reflow equivalent. No page-level horizontal overflow, obscured primary action, inaccessible content, or lost focus was observed.

Keyboard-only coverage passed for capture/triage, stale-draft recovery, lifecycle/validation, hierarchy/dependencies, search/filter/sort, archive/restore, and import preview/commit/export. `/`, `j/k`, Enter, `e`, and `c` are discoverable and suppressed while editing, in content-editable elements, with modifiers, and while a dialog is active.

| State contract                                            | Evidence and result                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial/background loading and pending actions            | Live-region/disabled-state semantic inspection plus E2E transition coverage; pass.                                                                                                 |
| Empty scope/database presentation and filtered no-results | Filtered no-results received rendered axe/manual coverage; the same semantic empty-row component is used for a zero-record result. A separate zero-record axe fixture was not run. |
| API 500/unreachable, retry, and correlation ID            | Route-failure E2E, retry recovery, visible request ID, and live error semantics; pass.                                                                                             |
| Draft validation and stale write conflict                 | API and two-browser E2E preserve values and permit explicit reapply; pass.                                                                                                         |
| Archive confirmation, archived deep link, restore         | Dialog containment, impact review, persistence, and focus return E2E; pass.                                                                                                        |
| Import parse/conflict/stale/rollback safety               | API integration tests prove no partial mutation; Data UI proves preview, review, and explicit commit.                                                                              |
| Browser console                                           | Representative full/focused runs reported no application console errors.                                                                                                           |

## Backup and restore proof

The release proof combines the user-facing browser workflow with a public-API fresh-database continuity test:

- Browser export produced a timestamped `actionables-backup-YYYYMMDD-HHMMSSZ.json`.
- The Data UI selected the file, rendered a non-mutating preview, required review/authorization, and committed only after the explicit keyboard-activated **Commit reviewed import** action.
- A source app and a separately migrated fresh target database exercised GET export → POST preview → POST selections → POST commit → GET re-export through public endpoints.
- The restored inventory included projects, repositories, worktrees, imported and manual actionables, user edits, evidence, sources, tags, hierarchy, dependencies and waiver, validation supersession, lifecycle/status history, activity, archive state, import provenance, and stable portable identities.
- Canonical semantic snapshots of the source export and restored re-export matched. Expected generated export timestamps and database-local identifiers were excluded from that comparison.

The focused API suite contains eight portable-data tests, including the representative full-state semantic equivalence and public-route continuity proofs. Schema version 1 is the only supported portable format. The operational procedure and failure handling are in [backup and restore](backup-restore.md).

## Defects found and remediated

- `better-sqlite3` was only transitively reachable: declared the already-locked driver directly in the API package and proved native loads on both runtimes.
- A shared pnpm side-effects store reused a Node 22 native ABI artifact during the first Node 24 attempt: repeated both clean installs with isolated stores and documented the remediation.
- Missing document title/language, contrast failures, invalid header/tab/table semantics, duplicate dialog landmark, incomplete dialog focus isolation/containment, absent skip navigation/shortcut discovery, undersized targets, and a scope-loading race: fixed and retested with axe and full E2E.
- Browser-test state leaked through a persistent disposable database: reset the exact E2E database before each server run.
- Production orchestration and preview proxy were absent: added the local built-mode start harness and API proxy, then proved health/shutdown/restart.
- Formatting, fresh-migration/native-load, and living-plan checks were not part of one ordered gate: added and executed them.

A 2026-09-01 maintenance check uses an intentionally non-current active database and
expects HTTP 503 with `SCHEMA_MIGRATION_REQUIRED` before any mutation runs.
Restoring that isolated ledger to its previously migrated state produces health
200 with `schema: current`, proving failures are rechecked rather than cached.
Raw Prisma errors such as `P2021` are no longer the readiness contract. A real
pending-migration deployment remains covered by the migration runbook rather
than claimed as part of this recorded verification.

## Known limitations

- The verified platform is Windows 11 Enterprise 25H2 x64. Other Windows versions were not independently tested.
- Firefox, Safari, macOS, Linux, and mobile operating systems are unverified.
- Automated axe and semantic/keyboard inspection do not establish WCAG certification. No separate screen-reader product session was performed.
- Concurrency-only stale-write messages and every millisecond-scale pending label were validated by focused API/E2E semantics, not captured in a dedicated axe snapshot. The no-results axe fixture used a filter over seeded data rather than a separate zero-record database.
- Mobile is a usable companion surface; dense desktop authoring remains the primary workflow.
- Portable JSON is the supported backup workflow. Automatic backups and raw SQLite copying are unsupported.
- This task did not produce a tag, hosted release, archive, installer, updater, or binary.

## Scope audit

Repository, UI, manifest, and dependency review found no authentication/accounts, permissions, collaboration/assignment, notifications, cloud synchronization, hosted deployment, live Codex integration, Git mutation, AI-generated priorities/dependencies, generic project-management expansion, installer, updater, or distribution binary. Repository/worktree records are local metadata; the application does not run Git commands. Codex provenance and source links are stored evidence, not a live integration.

T-007 added only release verification, documentation, test determinism, accessibility/keyboard correctness, and local operational hardening. It did not mutate the representative `WWW` repository or add a new MVP feature.
