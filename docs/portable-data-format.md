# Internal seed reconciliation format

The generic 32-item sample seed uses the `actionables-portable` preview, selection-authorization, reconciliation, and transaction service. The Data page and public import/export routes were removed on September 7, 2026. The schemas and snapshot helpers described below remain internal to seed reconciliation and its regression tests; they are not a supported user backup interface.
The bundled project names, source references, file paths, and findings are fictional examples intended for public demonstration.

## Compatibility

- Current schema version: `1`.
- Documents must contain `format: "actionables-portable"` and `schemaVersion: 1`.
- A future or older unsupported version is rejected. The importer never guesses a migration.
- Version handling is isolated before schema parsing so an explicit migration can be added later without weakening version 1 validation.
- Internal JSON validation limits nesting to 40 levels.

## Stable identity and ordering

Projects, repositories, worktrees, and actionables use opaque `portableId` values that remain stable across databases. History, validation, source, activity, hierarchy, and dependency records also have stable portable identifiers. References use these identifiers, never titles, array positions, database row numbers, or mutable display text.

Export arrays are ordered by portable identifier. Tags and source-file records are ordered canonically. JSON object property order and input record order do not affect the content digest after parsing. Research and validation note order is preserved because it is user-authored sequence.

Semantic equivalence compares canonical normalized documents while excluding:

- `exportedAt`, which is regenerated for each download;
- `metadata.sourceName`, which describes the transfer rather than domain state;
- database-local optimistic-concurrency versions, row identifiers, derived dashboard queues, and legacy display labels.
- active agent task claims, claim-token hashes, and lease timestamps, which are transient coordination state.

No other domain fields are excluded. Relationships, lifecycle and activity history (including agent claim, release, and observed-expiry events), validation supersession, archive state, source evidence, Markdown, tags, user sources, waivers, and provenance participate in the semantic snapshot.

## Reconciliation

Every imported actionable field has an explicit ownership value and an accepted-source baseline.

- Current value equals incoming value: no-op.
- Current value equals the prior source baseline and the source changed: safe update.
- Incoming value equals the baseline but the current value differs: preserve the local user edit as a no-op.
- Both current and source values changed from the baseline: field-level conflict; the local value is preserved.
- A differing record with no trusted baseline is a conflict.

Conflicting Markdown and relationships are never silently merged. Immutable history and provenance records are created by stable identifier, treated as no-ops when equal, and treated as conflicts when the same identifier differs.

## Preview and commit

Preview parses and validates without writing any database row, timestamp, activity, identifier, or import summary. Its expiring in-memory token binds the canonical document digest and a fingerprint of database versions.

Lifecycle integrity is validated during preview. A `Ready` actionable requires a non-empty finding, description, Research note, and validation plan.

The internal caller then authorizes skipped conflicts and relationship suggestions. This produces a separate expiring commit authorization bound to the exact selections. Commit rejects:

- changed content or digest;
- expired or stale database state;
- changed or unknown selections;
- missing selection authorization;
- replay of an already used commit authorization.

Commit re-runs validation inside one database transaction. Scopes, actionables, history, provenance, explicit relationships, confirmed suggestions, and the import summary commit together. Any failed validation or write rolls back the entire transaction. The import summary is inserted last.

## Relationships

Explicit hierarchy and dependency records in a trusted portable document are restored after the server validates self, duplicate, scope, depth, and cycle rules.

Inferred relationships are separate `relationshipSuggestions`. They never create domain facts unless individually selected. Confirmation records provenance in the relationship and associated activity. Export emits confirmed relationships as explicit relationships and does not infer them again.

## Archive and derived state

Exports include direct archive timestamps and the inherited project/repository/worktree archive sources visible at export time. Import restores direct archive state. Inherited state, dependency blocking, child progress, and dashboard queues are recomputed from restored domain facts.

## Security

Filenames and JSON values are display data only. The importer never reads or writes a filesystem path found inside JSON. Unsafe or malformed URL locators are preserved for faithful restoration but remain inert because the existing source-link allowlist exposes navigation only for approved `http`, `https`, and `codex` protocols. Prototype-pollution-style keys are rejected. Markdown is preserved as text and remains subject to the existing safe renderer, which does not execute raw HTML.

Portable exports can contain local technical paths, source wording, research notes, commands, and other sensitive project information. Store and share them accordingly.
