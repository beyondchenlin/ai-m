# Manual migration baseline recovery

Automatic recovery refuses databases whose historical DML provenance cannot be proven. Never edit `__drizzle_migrations` manually.

1. Stop every application process using the database.
2. Inspect the exact schema boundary: `corepack pnpm tsx scripts/approve-migration-baseline.ts --db <db> --boundary 54`.
3. Review the database path, identity, repository prefix digest, schema-evidence digest, and boundary. Preserve the JSON in the incident record.
4. Approve that unchanged identity and create a backup: `corepack pnpm tsx scripts/approve-migration-baseline.ts --db <db> --boundary 54 --approve <approvalToken> --backup <new-backup-path>`.
5. Restart one application process and verify the journal before restoring normal concurrency.

The approval token becomes invalid if the database file identity, schema evidence, migration prefix, boundary, or journal changes. Approval runs under `BEGIN IMMEDIATE` and seeds only the reviewed prefix after the backup succeeds.
