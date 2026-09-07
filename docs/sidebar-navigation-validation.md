# Sidebar changes: local completion evidence

Verified September 7, 2026 in `C:\Code\Actionables`, starting from clean commit
`f1202b8` on branch `AScriver`. These IDs refer to the unavailable work-PC
tracker. No tracker records were created, claimed, or updated. At the user's
subsequent request, the changes were committed locally in ID order; nothing was
pushed. Fixture records were created only in isolated test databases.

## Results by external ID

| ID | Local result and evidence |
| --- | --- |
| #410 | Project rows and their unused menu were removed. Repositories are direct sidebar parents, with independently collapsible worktree children. Browser tests verify repository/worktree selection, URL navigation, back/forward history, refresh, keyboard expansion, sidebar collapse, adding repositories, and preservation of project scopes in the top-bar selector. |
| #411 | Repository archive/restore buttons and their sidebar-only wrapper were removed. The intermediate #410 implementation passed type checking and seven focused browser tests at approximately 08:32 America/Phoenix, before #411 implementation began. The archive buttons were still present at that verification point. A new browser/API regression verifies repository archive/restore, inherited actionable archival, and unchanged workflow status outside the sidebar. |
| #412 | Actionables clears `project`, `repository`, and `worktree` through the existing query helper. Two repository fixtures appear afterward; search, status, priority exclusion, effort, tag, and sort remain intact. Tests reapply project and worktree scopes, cover entry from Dashboard, and verify the existing Done-to-active shortcut, which the user explicitly requested retaining. |
| #413 | Settings is the only shortcut in `.sidebar-status`; the prior placement and status text are removed. Tests verify a single button, keyboard tab order, Enter/Space activation, the existing Settings destination, preserved query state, and availability on desktop, in the collapsed rail, and on mobile. Offline warnings remain in the existing content banner. |

## Changed files

- [Application](../src/App.tsx) and [sidebar styles](../src/styles.css).
- [New sidebar regressions](../tests/e2e/sidebar-navigation.spec.ts).
- Existing [daily-shell](../tests/e2e/daily-shell.spec.ts),
  [repository-tracking](../tests/e2e/repository-tracking.spec.ts), and
  [accessibility](../tests/e2e/accessibility.spec.ts) tests.
- [README](../README.md) navigation guidance and this evidence record.

The existing Done-navigation fixture now supplies the Resolution required by
the current lifecycle contract. The sidebar test waits for its CSS transition,
and repository tests scope repeated Default worktree labels to their repository.

## Local commit sequence

Each slice was exported from the exact staged Git tree into a separate scratch
checkout and verified before committing. Later changes remained unstaged in the
original checkout throughout the sequence.

| External ID | Local commit | Verification of that slice |
| --- | --- | --- |
| #410 | `970b502` | Type check, 7 focused Edge tests, and changed-file Prettier checks passed while repository archive buttons were still present. |
| #411 | `b3c6d55` | Type check, 3 focused Edge tests, and changed-file Prettier checks passed after #410 was committed. |
| #412 | `ef29920` | Type check, 4 focused Edge tests, and changed-file Prettier checks passed. |
| #413 | The Settings commit containing this record | Its commit body records the exact staged-tree verification results. |

The first isolated #411 run exposed an order-dependent assertion in the new
hierarchy test: `.last()` could select the repository just collapsed instead of
the independent sibling. The assertion now selects the sibling by its unique
fixture name. All three #411 tests then passed; the failed snapshot and log were
retained for evidence. This was a test correction, with no additional product
behavior change.

Per-slice archives, JSON validation results, and logs are under
`C:\Users\Austin\AppData\Local\Temp\actionables-commits-20260907`.
These runs use the same `typecheck` and `build` package scripts via `npm run` and
Playwright's installed CLI directly because the scratch copies reuse installed
dependency directories. They explicitly set
`DATABASE_URL=file:./data/actionables-e2e.db`, keep that database inside each
scratch checkout, and use ports 4193/4194 with separate agent profiles. The
protected default database hash was checked before and after each slice.

## Actual verification

| Check | Result |
| --- | --- |
| Intermediate #410 type check and focused Playwright run | Passed; 7 browser tests before #411 edits. |
| Final focused navigation run | Passed; 6 tests, including all 4 new regressions. |
| `pnpm run typecheck` | Passed for the final application changes. |
| `pnpm run build` | Passed; Vite production bundle generated. |
| `pnpm run test` | Passed; 210 tests in 14 files. |
| `pnpm exec playwright test` | 51 passed, 2 failed initially. The obsolete footer Offline assertion was removed; its complete accessibility scenario then passed in a focused rerun. The remaining import/export failure also reproduces on the original checkout, as described below. |
| Prettier on all changed TypeScript/CSS files | Passed. |
| `pnpm run format:check` | Fails on 27 unchanged files; no unrelated formatting changes were made. |
| `git diff --check` | Passed. |
| Visual browser review | Reviewed repository hierarchy and footer Settings in the in-app browser; reviewed the collapsed Settings screenshot from Edge. |

Browser verification used installed Microsoft Edge via `PLAYWRIGHT_CHANNEL=msedge`.
The runtime was Node `24.14.1` and pnpm `11.9.0`. The validation environment set
`DATABASE_URL=file:./data/actionables-e2e.db` explicitly, used loopback ports
4183/4184, and isolated `ACTIONABLES_AGENT_HOME` under task scratch. MCP was
disabled in those validation processes. API tests also created their own
isolated databases.

The root Prisma config imports `dotenv/config`, but dotenv is declared in the
API package rather than the root package. A frozen-lockfile install did not
change that. Validation succeeded with `NODE_PATH` pointing to
`C:\Code\Actionables\apps\api\node_modules`; dependency declarations and
lockfiles were left unchanged.

## Broader-suite issues at sidebar completion

The user subsequently requested removal of the app's import/export feature. The
obsolete import/export browser tests were removed with that feature; the full
remaining 52-test browser suite now passes. See [removal verification](import-export-removal.md).
The reproduction below remains a record of the earlier sidebar validation.

The unchanged import/export test assumes `portable.actionables[0]` is a seeded
record with a trusted import baseline. After the capture/triage tests, that
element is a newly created task. Import preview correctly classifies its edited
description as a conflict, so the test's expected `safe-update` is absent.

This exact failure reproduced with 6 other tests passing against a separate
archive of original commit `f1202b8`, using the original application and tests,
an isolated database, and ports 4193/4194. The reproduction ran Playwright's CLI
with `capture-triage.spec.ts` followed by `import-export.spec.ts`. It did not
contain the sidebar changes. This unrelated fixture issue and the 27 existing
formatting failures prevent describing the entire release gate as clean.

## Local evidence and data protection

Run logs, validated PowerShell helpers, the baseline reproduction, and database
backups are in
`C:\Users\Austin\AppData\Local\Temp\actionables-sidebar-20260907`.
Relevant logs are `Phase410.log`, `Focused.log`, `Typecheck.log`, `Build.log`,
`Api.log`, `E2E.log`, `A11yRecheck.log`, `baseline-import.log`, and
`FormatCheck.log`. Browser screenshots are under `output/playwright/`.

The default database retained SHA-256
`33BD992D63A830D0390A8238A019D3AE39DB12F171AB067150D2C2F3542A827D`.
Validation listeners were stopped and the pre-existing E2E database was restored.
