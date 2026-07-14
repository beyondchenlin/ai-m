import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MigrationMetadata } from "./migration-journal";
import { assertExactSchemaBoundary } from "./migration-schema-evidence";
import {
  createBackupFileSecurityPolicy,
  type BackupFileSecurityPolicy,
} from "./backup-file-security";

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

export type BaselineApprovalHooks = {
  afterBackup?: () => void;
  beforeBackupPublish?: () => void;
  afterBackupPublish?: () => void;
  securityPolicy?: BackupFileSecurityPolicy;
};

type FileIdentity = { device: bigint; inode: bigint };
function pathIdentity(filename: string): FileIdentity {
  const info = fs.lstatSync(filename, { bigint: true });
  return { device: info.dev, inode: info.ino };
}
function fileIdentity(filename: string): FileIdentity {
  const info = fs.lstatSync(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Backup artifact must be a regular non-symlink file");
  return { device: info.dev, inode: info.ino };
}
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function scalar(sqlite: SqliteDatabase, pragma: string): number {
  return Number(sqlite.pragma(pragma, { simple: true }));
}

function quoteIdentifier(value: string): string { return `"${value.replace(/"/g, '""')}"`; }

function frame(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

function logicalDataDigest(sqlite: SqliteDatabase): string {
  const tables = sqlite.prepare<[], { name: string }>(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      AND name!='__drizzle_migrations' ORDER BY name
  `).all();
  const hash = createHash("sha256");
  for (const { name } of tables) {
    const columns = sqlite.prepare<[], { name: string; type: string }>(
      `PRAGMA table_xinfo(${quoteIdentifier(name)})`,
    ).all();
    frame(hash, name);
    for (const column of columns) {
      frame(hash, column.name);
      frame(hash, column.type);
    }
    const canonical = columns.map((column) => {
      const identifier = quoteIdentifier(column.name);
      return `CASE typeof(${identifier})
        WHEN 'null' THEN '0:'
        WHEN 'integer' THEN '1:' || printf('%lld', ${identifier})
        WHEN 'real' THEN '2:' || printf('%!.26g', ${identifier})
        WHEN 'text' THEN '3:' || hex(CAST(${identifier} AS BLOB))
        WHEN 'blob' THEN '4:' || hex(${identifier}) END`;
    });
    const projections = canonical.map((expression, index) => `${expression} AS c${index}`).join(",");
    const orderBy = canonical.join(",");
    for (const row of sqlite.prepare<[], Record<string, string>>(
      `SELECT ${projections} FROM ${quoteIdentifier(name)} ORDER BY ${orderBy}`,
    ).iterate()) {
      frame(hash, "row");
      for (let index = 0; index < columns.length; index += 1) frame(hash, row[`c${index}`]);
    }
  }
  return hash.digest("hex");
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
  hooks: BaselineApprovalHooks = {},
): Promise<void> {
  const requestedBackupPath = path.resolve(backupPath);
  const realParent = fs.realpathSync.native(path.dirname(requestedBackupPath));
  const absoluteBackupPath = path.join(realParent, path.basename(requestedBackupPath));
  if (absoluteBackupPath === path.resolve(databasePath)) throw new Error("Backup path must differ from the live database");
  const temporaryBackupPath = path.join(
    path.dirname(absoluteBackupPath),
    `.${path.basename(absoluteBackupPath)}.backup-tmp-${randomUUID()}`,
  );
  let temporaryExists = false;
  let primaryError: unknown;
  try {
    const securityPolicy = hooks.securityPolicy ?? createBackupFileSecurityPolicy();
    securityPolicy.verifyParent(realParent);
    const parentIdentity = pathIdentity(realParent);
    const reservation = fs.openSync(temporaryBackupPath, "wx", 0o600);
    temporaryExists = true;
    fs.closeSync(reservation);
    securityPolicy.protect(temporaryBackupPath);
    const reservedIdentity = fileIdentity(temporaryBackupPath);
    await sqlite.backup(temporaryBackupPath);
    securityPolicy.verify(temporaryBackupPath);
    if (!sameIdentity(reservedIdentity, fileIdentity(temporaryBackupPath))) {
      throw new Error("Temporary backup identity changed while writing");
    }
    hooks.afterBackup?.();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const inspectArtifact = (filename: string) => {
      const before = fileIdentity(filename);
      const backup = new Database(filename, { readonly: true, fileMustExist: true });
      try {
        const integrity = backup.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${String(integrity)}`);
        const manifest = inspectBaselineApproval(backup, filename, migrations, boundaryCount);
        const after = fileIdentity(filename);
        if (!sameIdentity(before, after)) throw new Error("Backup artifact identity changed during verification");
        return { identity: after, manifest };
      } finally { backup.close(); }
    };
    const temporaryArtifact = inspectArtifact(temporaryBackupPath);

    hooks.beforeBackupPublish?.();
    if (!sameIdentity(parentIdentity, pathIdentity(realParent))) throw new Error("Backup parent directory identity changed");
    if (!sameIdentity(temporaryArtifact.identity, fileIdentity(temporaryBackupPath))) throw new Error("Temporary backup was replaced before publication");
    try { fs.linkSync(temporaryBackupPath, absoluteBackupPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Backup path already exists; refusing to overwrite", { cause: error });
      }
      throw error;
    }
    const publishedIdentity = fileIdentity(absoluteBackupPath);
    hooks.afterBackupPublish?.();
    let finalArtifact: ReturnType<typeof inspectArtifact>;
    try {
      securityPolicy.verify(absoluteBackupPath);
      finalArtifact = inspectArtifact(absoluteBackupPath);
      if (!sameIdentity(publishedIdentity, finalArtifact.identity)
        || !sameIdentity(temporaryArtifact.identity, finalArtifact.identity)) {
        throw new Error("Published backup identity does not match the verified temporary artifact");
      }
    }
    catch (verificationError) {
      try {
        if (sameIdentity(publishedIdentity, fileIdentity(absoluteBackupPath))) fs.unlinkSync(absoluteBackupPath);
      }
      catch (cleanupError) {
        throw new AggregateError([verificationError, cleanupError], "Published backup ACL verification and cleanup failed", {
          cause: verificationError,
        });
      }
      throw verificationError;
    }
    fs.unlinkSync(temporaryBackupPath);
    temporaryExists = false;

    sqlite.transaction(() => {
      const manifest = inspectBaselineApprovalLocked(sqlite, databasePath, migrations, boundaryCount);
      if (manifest.approvalToken !== approvalToken) {
        throw new Error("Approval token does not match current database identity, prefix, and evidence");
      }
      if (finalArtifact.manifest.evidenceDigest !== temporaryArtifact.manifest.evidenceDigest
        || finalArtifact.manifest.dataDigest !== temporaryArtifact.manifest.dataDigest
        || finalArtifact.manifest.prefixDigest !== manifest.prefixDigest
        || finalArtifact.manifest.evidenceDigest !== manifest.evidenceDigest
        || finalArtifact.manifest.dataDigest !== manifest.dataDigest
        || finalArtifact.manifest.journalRowCount !== manifest.journalRowCount) {
        throw new Error("Backup evidence does not match the locked live database state");
      }
      const insert = sqlite.prepare<[string, number]>(
        'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
      );
      for (const migration of migrations.slice(0, boundaryCount)) insert.run(migration.hash, migration.folderMillis);
    }).immediate();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (temporaryExists) {
      try { fs.unlinkSync(temporaryBackupPath); }
      catch (cleanupError) {
        if (primaryError !== undefined) {
          throw new AggregateError([primaryError, cleanupError], "Backup failed and temporary cleanup failed", {
            cause: primaryError,
          });
        }
        throw cleanupError;
      }
    }
  }
}
