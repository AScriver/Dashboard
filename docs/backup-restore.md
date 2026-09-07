# Local data and historical backups

The Data page and public JSON import/export routes were removed on September 7,
2026. This version has no built-in backup or restore workflow. Application data
continues to live in the configured local SQLite database; the removal does not
delete existing records, source evidence, or provenance.

Keep any portable JSON backups created by earlier versions. Those files require
a version that supports their format to restore; the current app cannot load them.

The [internal seed format](portable-data-format.md) remains in use by the bundled
sample-data initializer. It is not a user-facing import/export interface.
