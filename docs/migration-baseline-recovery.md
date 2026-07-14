# Manual migration baseline recovery

Automatic recovery refuses databases whose historical DML provenance cannot be proven. Never edit `__drizzle_migrations` manually.
It also refuses journal-less boundaries that cross destructive DDL such as `DROP TABLE` or `ALTER TABLE ... DROP COLUMN`: the absence of the old object cannot prove that its historical data was migrated correctly. Migration 0051 therefore requires this audited manual workflow.

1. Stop every application process using the database.
2. Inspect the exact schema boundary: `corepack pnpm tsx scripts/approve-migration-baseline.ts --db <db> --boundary 54`.
3. Review the database path, identity, repository prefix digest, schema-evidence digest, and boundary. Preserve the JSON in the incident record.
4. Approve that unchanged identity and create a backup: `corepack pnpm tsx scripts/approve-migration-baseline.ts --db <db> --boundary 54 --approve <approvalToken> --backup <new-backup-path>`.
5. Restart one application process and verify the journal before restoring normal concurrency.

The approval token becomes invalid if the database file identity, schema evidence, migration prefix, boundary, or journal changes. Approval runs under `BEGIN IMMEDIATE` and seeds only the reviewed prefix after the backup succeeds.

## Backup file security

The backup is first written to a cryptographically unique temporary file in the destination directory, verified, and published with an atomic no-replace hard link. The final path is then reopened and its identity, integrity, complete schema/data evidence, and permissions are verified again before journal writes. An existing file, directory, symlink, concurrently created destination, or replaced artifact is never trusted or overwritten.

- On Windows, approval removes ACL inheritance before any database bytes are written, sets the current Windows SID as owner, and grants only that SID explicit Full Control. It does not preserve broad `Everyone`, `Users`, or `Authenticated Users` access, nor extra `SYSTEM` or Administrators entries. The ACL is verified after backup and again after hard-link publication. PowerShell receives the path through JSON on standard input; it is never interpolated into a command or passed through a shell.
- On non-Windows platforms, approval applies mode `0600` before backup and verifies the mode after backup and publication.

If the platform security tool is unavailable, permission application fails, or verification is inconclusive, approval fails closed before journal seeding. Unpublished temporary files are removed. Operators should treat inability to establish this policy as a host configuration incident rather than weakening backup permissions.

The destination parent must also be private and stable. On POSIX it must be a real directory owned by the current uid and not writable by group or others; create one with `install -d -m 700 <backup-directory>`. On Windows it must have inheritance disabled and exactly one explicit Full Control rule for the current SID. A PowerShell administrator can create it as follows (replace the literal path before running):

```powershell
$path = 'C:\private\ai-m-backups'
New-Item -ItemType Directory -Path $path -Force | Out-Null
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
```

Shared, inherited, group-writable, `Everyone`-writable, or `Authenticated Users`-writable parents are rejected even if an individual child file could be locked down.

## Capacity and maintenance-window planning

Inspection and final approval compute full schema and logical-data evidence for every application table. The locked approval pass runs under `BEGIN IMMEDIATE`, so it can hold the database write lock for the duration of a whole-database scan and deterministic SQLite sorts. Large tables may require substantial SQLite temporary-sort space in addition to normal WAL growth.

Before approving a production database:

1. Measure the database, WAL, and largest tables, and benchmark both inspection and approval against a recent copy on equivalent storage. Do not infer production duration from a small development database.
2. Schedule a maintenance window long enough for the complete locked scan, final backup verification, and rollback margin. Keep every application writer stopped until post-approval journal verification finishes.
3. Reserve space for the complete backup plus SQLite temporary sorting and WAL/checkpoint growth. As a conservative starting point, keep several times the database size free on both the database volume and backup destination, then replace that estimate with measurements from the rehearsal.
4. Verify that the temporary directory used by SQLite has sufficient space and is on trusted local storage. A disk-full or permission error is expected to fail approval without journal writes, but it still consumes maintenance time.
5. Rehearse restore and startup from the published backup before the live window. For a database too large to scan and sort within the allowed write-lock window, stop and design an operator-specific offline recovery rather than bypassing evidence checks.
