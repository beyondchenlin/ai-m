import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import fs from "node:fs";
import path from "node:path";
import {
  detectJournalLessBaselineMigrationCount,
  selectLegacyVisualSubjectJournalRepair,
  validateMigrationJournal,
  type MigrationJournalRow,
  type MigrationMetadata,
} from "./migration-journal";

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
type SqliteConnection = import("better-sqlite3").Database;
const globalForDb = globalThis as unknown as {
  sqlite: SqliteConnection | undefined;
  drizzleDb: DrizzleDB | undefined;
};

function resolveDbPath() {
  // Dynamic require to avoid loading native binary at build time
  const dbPath = process.env.DATABASE_URL?.replace("file:", "") || "./data/aicomic.db";
  return path.resolve(dbPath);
}

export function getSqlite(): SqliteConnection {
  if (globalForDb.sqlite) return globalForDb.sqlite;

  // Dynamic require to avoid loading native binary at build time
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const absolutePath = resolveDbPath();

  // Ensure the directory exists before opening the database
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const sqlite = new Database(absolutePath);
  // Cache one connection per process in every environment. The worker and web
  // processes are isolated, while opening a connection for every property
  // access in production leaks file descriptors and defeats WAL coordination.
  globalForDb.sqlite = sqlite;

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Web and worker processes share the same SQLite file. Give short-lived
  // writers time to finish instead of surfacing transient SQLITE_BUSY errors.
  sqlite.pragma("busy_timeout = 5000");

  return sqlite;
}

function createDb(): DrizzleDB {
  if (globalForDb.drizzleDb) return globalForDb.drizzleDb;

  const sqlite = getSqlite();
  const instance = drizzle(sqlite, { schema });
  globalForDb.drizzleDb = instance;
  return instance;
}

function tableExists(sqlite: SqliteConnection, tableName: string) {
  const row = sqlite
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName);

  return Boolean(row);
}

function ensureMigrationsTable(sqlite: SqliteConnection) {
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `).run();
}

function getRecordedMigrationCount(sqlite: SqliteConnection) {
  const row = sqlite
    .prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM "__drizzle_migrations"',
    )
    .get();

  return Number(row?.count ?? 0);
}

function getAppTableCount(sqlite: SqliteConnection) {
  const row = sqlite
    .prepare<[], { count: number }>(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name != '__drizzle_migrations'
    `)
    .get();

  return Number(row?.count ?? 0);
}

function baselineMigrations(
  sqlite: SqliteConnection,
  migrations: MigrationMetadata[],
  confirmedCount: number,
) {
  if (confirmedCount > migrations.length) {
    throw new Error(`Confirmed migration count ${confirmedCount} exceeds available migrations ${migrations.length}`);
  }
  const insert = sqlite.prepare<[string, number]>(
    'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
  );

  sqlite.transaction(() => {
    for (const migration of migrations.slice(0, confirmedCount)) {
      insert.run(migration.hash, migration.folderMillis);
    }
  })();
}

function readMigrationJournal(sqlite: SqliteConnection): MigrationJournalRow[] {
  return sqlite.prepare<[], MigrationJournalRow>(
    'SELECT hash, created_at AS createdAt FROM "__drizzle_migrations" ORDER BY rowid',
  ).all();
}

function validateRecordedMigrationJournal(
  sqlite: SqliteConnection,
  migrations: MigrationMetadata[],
): void {
  const rows = sqlite.prepare<[], { hash: string; createdAt: number }>(
    'SELECT hash, created_at AS createdAt FROM "__drizzle_migrations" ORDER BY rowid',
  ).all();
  validateMigrationJournal(rows, migrations);
}

function readTableColumns(sqlite: SqliteConnection, tableName: string): string[] | null {
  if (!tableExists(sqlite, tableName)) return null;
  const escapedName = tableName.replace(/"/g, '""');
  return sqlite.prepare<[], { name: string }>(`PRAGMA table_info("${escapedName}")`)
    .all().map((column) => column.name);
}

function reconcileLegacyVisualSubjectJournalGap(
  sqlite: SqliteConnection,
  migrations: MigrationMetadata[],
): void {
  let repaired = false;
  sqlite.transaction(() => {
    const tables: Record<string, string[]> = {};
    for (const tableName of ["visual_subjects", "visual_subject_versions"]) {
      const columns = readTableColumns(sqlite, tableName);
      if (columns) tables[tableName] = columns;
    }
    const repair = selectLegacyVisualSubjectJournalRepair({
      journalRows: readMigrationJournal(sqlite),
      tables,
    }, migrations);
    if (!repair) return;
    sqlite.prepare<[string, number]>(
      'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
    ).run(repair.hash, repair.folderMillis);
    repaired = true;
  }).immediate();
  if (repaired) console.log("[DB] Reconciled legacy 0056 journal gap after strict schema verification");
}

/** Validate both sides of the sole supported legacy journal repair. */
export function prepareMigrationJournal(
  sqlite: SqliteConnection,
  migrations: MigrationMetadata[],
): void {
  validateRecordedMigrationJournal(sqlite, migrations);
  reconcileLegacyVisualSubjectJournalGap(sqlite, migrations);
  validateRecordedMigrationJournal(sqlite, migrations);
}

export function runMigrations() {
  const sqlite = getSqlite();
  const migrationsFolder = path.resolve("drizzle");
  ensureMigrationsTable(sqlite);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readMigrationFiles } = require("drizzle-orm/migrator") as {
    readMigrationFiles: (config: { migrationsFolder: string }) => MigrationMetadata[];
  };
  const migrations = readMigrationFiles({ migrationsFolder });
  prepareMigrationJournal(sqlite, migrations);

  const confirmedBaselineCount = detectJournalLessBaselineMigrationCount({
    journalRowCount: getRecordedMigrationCount(sqlite),
    appTableCount: getAppTableCount(sqlite),
    readActualInventory: () => sqlite,
  }, migrations);
  if (confirmedBaselineCount > 0) {
    console.log(`[DB] Existing schema detected. Baselining ${confirmedBaselineCount} confirmed migrations...`);
    baselineMigrations(sqlite, migrations, confirmedBaselineCount);
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { migrate } = require("drizzle-orm/better-sqlite3/migrator");
  migrate(createDb(), { migrationsFolder });
}

// Proxy preserves the `db` export API — lazy-inits on first property access
export const db: DrizzleDB = new Proxy({} as DrizzleDB, {
  get(_, prop) {
    const instance = createDb();
    const value = (instance as never)[prop];
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(instance);
    }
    return value;
  },
});

export type DB = typeof db;
