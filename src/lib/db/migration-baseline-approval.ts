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
  dataDigest: string;
  journalRowCount: number;
  approvalToken: string;
};

function scalar(sqlite: SqliteDatabase, pragma: string): number {
  return Number(sqlite.pragma(pragma, { simple: true }));
}

function quoteIdentifier(value: string): string { return `"${value.replace(/"/g, '""')}"`; }

function logicalDataDigest(sqlite: SqliteDatabase): string {
  const tables = sqlite.prepare<[], { name: string }>(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      AND name!='__drizzle_migrations' ORDER BY name
  `).all();
  const snapshot = tables.map(({ name }) => {
    const columns = sqlite.prepare<[], { name: string; type: string }>(
      `PRAGMA table_xinfo(${quoteIdentifier(name)})`,
    ).all();
    const projections = columns.flatMap((column, index) => [
      `typeof(${quoteIdentifier(column.name)}) AS t${index}`,
      `quote(${quoteIdentifier(column.name)}) AS q${index}`,
    ]).join(",");
    const rows = sqlite.prepare<[], Record<string, string>>(
      `SELECT ${projections} FROM ${quoteIdentifier(name)}`,
    ).all().map((row) => columns.map((_column, index) => [row[`t${index}`], row[`q${index}`]]));
    rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return { name, columns, rows };
  });
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function inspectBaselineApprovalLocked(
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
  const dataDigest = logicalDataDigest(sqlite);
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
  const unsigned = { databasePath: absolutePath, databaseIdentity, boundaryCount, prefixDigest, evidenceDigest, dataDigest, journalRowCount };
  return {
    ...unsigned,
    approvalToken: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
}

export function inspectBaselineApproval(
  sqlite: SqliteDatabase,
  databasePath: string,
  migrations: MigrationMetadata[],
  boundaryCount: number,
): BaselineApprovalManifest {
  return sqlite.transaction(() => inspectBaselineApprovalLocked(
    sqlite, databasePath, migrations, boundaryCount,
  )).immediate();
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
    const manifest = inspectBaselineApprovalLocked(sqlite, databasePath, migrations, boundaryCount);
    if (manifest.approvalToken !== approvalToken) {
      throw new Error("Approval token does not match current database identity, prefix, and evidence");
    }
    const insert = sqlite.prepare<[string, number]>(
      'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
    );
    for (const migration of migrations.slice(0, boundaryCount)) insert.run(migration.hash, migration.folderMillis);
  }).immediate();
}
