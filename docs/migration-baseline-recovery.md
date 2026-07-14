# Manual migration baseline recovery

Automatic recovery refuses databases whose historical DML provenance cannot be proven. Never edit `__drizzle_migrations` manually.

1. Stop every application process using the database.
2. Inspect the exact schema boundary: `corepack pnpm tsx scripts/approve-migration-baseline.ts --db <db> --boundary 54`.
3. Review the database path, identity, repository prefix digest, schema-evidence digest, and boundary. Preserve the JSON in the incident record.
4. Approve that unchanged identity and create a backup: `corepack pnpm tsx scripts/approve-migration-baseline.ts --db <db> --boundary 54 --approve <approvalToken> --backup <new-backup-path>`.
5. Restart one application process and verify the journal before restoring normal concurrency.

The approval token becomes invalid if the database file identity, schema evidence, migration prefix, boundary, or journal changes. Approval runs under `BEGIN IMMEDIATE` and seeds only the reviewed prefix after the backup succeeds.

## Backup file security

The backup is first written to a cryptographically unique temporary file in the destination directory, verified, and published with an atomic no-replace hard link. An existing file, directory, symlink, or concurrently created destination is never overwritten.

- On Windows, approval removes ACL inheritance before any database bytes are written, sets the current Windows SID as owner, and grants only that SID explicit Full Control. It does not preserve broad `Everyone`, `Users`, or `Authenticated Users` access, nor extra `SYSTEM` or Administrators entries. The ACL is verified after backup and again after hard-link publication. PowerShell receives the path through JSON on standard input; it is never interpolated into a command or passed through a shell.
- On non-Windows platforms, approval applies mode `0600` before backup and verifies the mode after backup and publication.

If the platform security tool is unavailable, permission application fails, or verification is inconclusive, approval fails closed before journal seeding. Unpublished temporary files are removed. Operators should treat inability to establish this policy as a host configuration incident rather than weakening backup permissions.
