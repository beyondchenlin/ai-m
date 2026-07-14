import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MigrationMetadata } from "./migration-journal";
import { assertExactSchemaBoundary } from "./migration-schema-evidence";

type SqliteDatabase = import("better-sqlite3").Database;
export type BaselineApprovalManifest = {
  databasePath: string;
  databaseIdentity: string;
  boundaryCount: number;
  prefixDigest: string;
  evidenceDigest: string;
  journalRowCount: number;
  approvalToken: string;
};

function scalar(sqlite: SqliteDatabase, pragma: string): number {
  return Number(sqlite.pragma(pragma, { simple: true }));
}

export function inspectBaselineApproval(
  sqlite: SqliteDatabase,
  databasePath: string,
  migrations: MigrationMetadata[],
  boundaryCount: number,
): BaselineApprovalManifest {
  const absolutePath = path.resolve(databasePath);
  const journalRowCount = Number(sqlite.prepare<[], { count: number }>(
    'SELECT COUNT(*) count FROM "__drizzle_migrations"',
  ).get()?.count ?? 0);
  if (journalRowCount !== 0) throw new Error("Manual baseline approval requires an empty migration journal");
  const evidenceDigest = assertExactSchemaBoundary(sqlite, migrations, boundaryCount);
  const prefixDigest = createHash("sha256").update(JSON.stringify(
    migrations.slice(0, boundaryCount).map((migration) => [migration.folderMillis, migration.hash]),
  )).digest("hex");
  const stat = fs.statSync(absolutePath);
  const databaseIdentity = createHash("sha256").update(JSON.stringify({
    absolutePath,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    schemaVersion: scalar(sqlite, "schema_version"),
    pageCount: scalar(sqlite, "page_count"),
    freelistCount: scalar(sqlite, "freelist_count"),
    applicationId: scalar(sqlite, "application_id"),
  })).digest("hex");
  const unsigned = { databasePath: absolutePath, databaseIdentity, boundaryCount, prefixDigest, evidenceDigest, journalRowCount };
  return {
    ...unsigned,
    approvalToken: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
}

export async function approveBaseline(
  sqlite: SqliteDatabase,
  databasePath: string,
  migrations: MigrationMetadata[],
  boundaryCount: number,
  approvalToken: string,
  backupPath: string,
): Promise<void> {
  await sqlite.backup(path.resolve(backupPath));
  sqlite.transaction(() => {
    const manifest = inspectBaselineApproval(sqlite, databasePath, migrations, boundaryCount);
    if (manifest.approvalToken !== approvalToken) {
      throw new Error("Approval token does not match current database identity, prefix, and evidence");
    }
    const insert = sqlite.prepare<[string, number]>(
      'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
    );
    for (const migration of migrations.slice(0, boundaryCount)) insert.run(migration.hash, migration.folderMillis);
  }).immediate();
}
