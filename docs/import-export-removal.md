# Import/export removal

Removed at the user's request on September 7, 2026, after sidebar tasks #410–#413.
No tracker records were created or changed.

- UI commit `5043548` removes Data navigation, the Data page, upload/download
  controls, their browser client, and unused styles. Settings retains its layout.
  Old `/data` URLs use the existing Actionables fallback and retain query filters.
- The API-removal commit containing this record removes all four `/api/data/*`
  routes and their route-only service setup and error handling. Regression tests
  verify 404 responses with unchanged stored-record counts. Shared JSON request
  validation remains covered on `/api/actionables`.
- Internal reconciliation and snapshot helpers remain because the sample-data
  initializer uses them. Existing records, imported evidence, database schemas,
  migrations, and provenance are unchanged. Internal tests are now named
  `seed-reconciliation.test.ts`; obsolete public-route tests are removed.

The exact staged UI snapshot passed type checking, changed-file formatting, and
all 52 Edge browser tests, including accessibility. Desktop Settings was also
visually reviewed. The API-removal commit message records its staged-tree
validation, including type checking, API tests, and the production build.

Validation used separate scratch checkouts, explicit
`DATABASE_URL=file:./data/actionables-e2e.db`, isolated agent profiles, and loopback
ports 4193/4194. Logs and snapshot manifests are in
`C:\Users\Austin\AppData\Local\Temp\actionables-remove-data-20260907`.
The protected default database hash was checked before and after each slice.
The earlier repository-wide formatting failures were outside this removal.
