import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  selectLegacyVisualSubjectJournalRepair,
  validateMigrationJournal,
  type MigrationJournalRow,
  type MigrationMetadata,
} from "./migration-journal";
import { detectJournalLessBaselineMigrationCount } from "./migration-schema-evidence";
import { validateMigrationExecutionStatements } from "./migration-data-evidence";
import {
  MIGRATION_PRECONDITION_REGISTRY,
  runMigrationPrecondition,
  validateMigrationPreconditionRegistry,
} from "./migration-preconditions";

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
type SqliteConnection = import("better-sqlite3").Database;
const globalForDb = globalThis as unknown as {
  sqlite: SqliteConnection | undefined;
  drizzleDb: DrizzleDB | undefined;
};

type SqliteInitializationOptions = {
  now?: () => number;
  wait?: (milliseconds: number) => void;
  timeoutMilliseconds?: number;
};

export function initializeOwnedSqliteConnection<T extends Pick<SqliteConnection, "pragma" | "close">>(
  sqlite: T,
  options: SqliteInitializationOptions = {},
): T {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  });
  try {
    sqlite.pragma("busy_timeout = 5000");
    const deadline = now() + (options.timeoutMilliseconds ?? 5_000);
    for (;;) {
      try {
        sqlite.pragma("journal_mode = WAL");
        break;
      } catch (error) {
        let code: unknown;
        try { code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined; }
        catch { code = undefined; }
        if ((code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") || now() >= deadline) throw error;
        wait(20);
      }
    }
    sqlite.pragma("foreign_keys = ON");
    return sqlite;
  } catch (initializationError) {
    try { sqlite.close(); }
    catch (closeError) {
      throw new AggregateError(
        [initializationError, closeError],
        "SQLite initialization and cleanup both failed",
        { cause: initializationError },
      );
    }
    throw initializationError;
  }
}

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

  const sqlite = initializeOwnedSqliteConnection(new Database(absolutePath));
  // Ownership transfers to the process cache only after every setup step succeeds.
  globalForDb.sqlite = sqlite;

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

export function baselineJournalLessDatabase(
  sqlite: SqliteConnection,
  migrations: MigrationMetadata[],
): number {
  let confirmedCount = 0;
  const insert = sqlite.prepare<[string, number]>(
    'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
  );

  sqlite.transaction(() => {
    const recordedMigrationCount = getRecordedMigrationCount(sqlite);
    if (recordedMigrationCount !== 0) {
      validateRecordedMigrationJournal(sqlite, migrations);
      return;
    }
    confirmedCount = detectJournalLessBaselineMigrationCount({
      journalRowCount: recordedMigrationCount,
      appTableCount: getAppTableCount(sqlite),
      readActualInventory: () => sqlite,
    }, migrations);
    if (confirmedCount === 0) return;
    for (const migration of migrations.slice(0, confirmedCount)) {
      insert.run(migration.hash, migration.folderMillis);
    }
    validateRecordedMigrationJournal(sqlite, migrations);
  }).immediate();
  return confirmedCount;
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
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS "__drizzle_migrations_created_at_unique"
    ON "__drizzle_migrations" (created_at)
  `);
  const index = sqlite.prepare<[], { name: string; unique: number; partial: number; origin: string }>(
    'PRAGMA index_list("__drizzle_migrations")',
  ).all().find((candidate) => candidate.name === "__drizzle_migrations_created_at_unique");
  const keyColumns = sqlite.prepare<[], { name: string | null; key: number; cid: number; desc: number; coll: string | null }>(
    'PRAGMA index_xinfo("__drizzle_migrations_created_at_unique")',
  ).all().filter((column) => Number(column.key) === 1);
  if (Number(index?.unique) !== 1 || Number(index?.partial) !== 0 || index?.origin !== "c"
    || keyColumns.length !== 1 || keyColumns[0].name !== "created_at"
    || Number(keyColumns[0].cid) < 0 || Number(keyColumns[0].desc) !== 0
    || keyColumns[0].coll?.toLowerCase() !== "binary") {
    throw new Error("Migration timestamp index exists with an incompatible definition");
  }
}

export type ValidatedMigrationBundle = Readonly<{
  folder: string;
  manifestDigest: string;
  migrations: readonly Readonly<MigrationMetadata>[];
}>;
const validatedMigrationBundles = new WeakSet<object>();

function migrationFolderCandidate(): string {
  return process.env.AI_M_MIGRATIONS_DIR
    ? path.resolve(process.env.AI_M_MIGRATIONS_DIR)
    : path.resolve(__dirname, "../../../drizzle");
}

function readValidatedMigrationBundle(folder: string, expectedManifestDigest?: string): ValidatedMigrationBundle {
  const journalPath = path.join(folder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) throw new Error(`Migration journal not found at ${journalPath}`);
  const journalBytes = fs.readFileSync(journalPath);
  const journal = JSON.parse(journalBytes.toString("utf8")) as {
    entries?: Array<{ idx: number; tag: string; when: number; breakpoints: boolean }>;
  };
  const expectedFiles = journal.entries?.map((entry) => `${entry.tag}.sql`) ?? [];
  const actualFiles = fs.readdirSync(folder).filter((name) => name.endsWith(".sql")).sort();
  if (!journal.entries?.length || journal.entries.some((entry, index) => entry.idx !== index
    || typeof entry.tag !== "string" || !/^\d{4}_[a-z0-9_]+$/i.test(entry.tag)
    || !Number.isSafeInteger(entry.when) || typeof entry.breakpoints !== "boolean")
    || JSON.stringify([...expectedFiles].sort()) !== JSON.stringify(actualFiles)) {
    throw new Error("Migration journal structure does not match its SQL files");
  }
  const hash = createHash("sha256");
  const frame = (name: string, bytes: Buffer) => {
    const nameBytes = Buffer.from(name, "utf8");
    const lengths = Buffer.alloc(16);
    lengths.writeBigUInt64BE(BigInt(nameBytes.length), 0);
    lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
    hash.update(lengths).update(nameBytes).update(bytes);
  };
  frame("meta/_journal.json", journalBytes);
  const migrations: MigrationMetadata[] = [];
  for (const entry of journal.entries) {
    const name = `${entry.tag}.sql`;
    const bytes = fs.readFileSync(path.join(folder, name));
    frame(name, bytes);
    const source = bytes.toString("utf8");
    migrations.push(Object.freeze({
      folderMillis: entry.when,
      hash: createHash("sha256").update(bytes).digest("hex"),
      sql: Object.freeze(source.split("--> statement-breakpoint")) as unknown as string[],
    }));
  }
  const manifestDigest = hash.digest("hex");
  if (expectedManifestDigest !== undefined) {
    if (!expectedManifestDigest || expectedManifestDigest.toLowerCase() !== manifestDigest) {
      throw new Error("Configured migrations directory identity does not match AI_M_MIGRATIONS_SHA256");
    }
  }
  validateMigrationExecutionStatements(migrations);
  validateMigrationPreconditionRegistry(migrations, MIGRATION_PRECONDITION_REGISTRY);
  const bundle = Object.freeze({ folder, manifestDigest, migrations: Object.freeze(migrations) });
  validatedMigrationBundles.add(bundle);
  return bundle;
}

export function loadValidatedMigrationBundle(folder = migrationFolderCandidate()): ValidatedMigrationBundle {
  const resolvedFolder = path.resolve(folder);
  const configuredFolder = process.env.AI_M_MIGRATIONS_DIR
    ? path.resolve(process.env.AI_M_MIGRATIONS_DIR)
    : undefined;
  const expectedDigest = configuredFolder === resolvedFolder
    ? (process.env.AI_M_MIGRATIONS_SHA256 ?? "")
    : undefined;
  return readValidatedMigrationBundle(resolvedFolder, expectedDigest);
}

export function resolveMigrationsFolder(): string {
  return loadValidatedMigrationBundle().folder;
}

export function computeMigrationsManifestDigest(folder: string): string {
  return readValidatedMigrationBundle(path.resolve(folder)).manifestDigest;
}

export function applyPendingMigrations(
  sqlite: SqliteConnection,
  bundle: ValidatedMigrationBundle,
): number {
  if (!validatedMigrationBundles.has(bundle)) throw new Error("Migration bundle was not produced by validated loader");
  const migrations = bundle.migrations as unknown as MigrationMetadata[];
  let applied = 0;
  sqlite.transaction(() => {
    validateRecordedMigrationJournal(sqlite, migrations);
    const recordedCount = getRecordedMigrationCount(sqlite);
    const insert = sqlite.prepare<[string, number]>(
      'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
    );
    for (const migration of migrations.slice(recordedCount)) {
      if (!migration.sql) throw new Error(`Migration ${migration.folderMillis} has no SQL metadata`);
      runMigrationPrecondition(sqlite, migration);
      for (const statement of migration.sql) sqlite.exec(statement);
      insert.run(migration.hash, migration.folderMillis);
      applied += 1;
    }
    validateRecordedMigrationJournal(sqlite, migrations);
  }).immediate();
  return applied;
}

export function runMigrations() {
  const sqlite = getSqlite();
  const bundle = loadValidatedMigrationBundle();
  ensureMigrationsTable(sqlite);
  const migrations = bundle.migrations as unknown as MigrationMetadata[];
  prepareMigrationJournal(sqlite, migrations);

  const confirmedBaselineCount = baselineJournalLessDatabase(sqlite, migrations);
  if (confirmedBaselineCount > 0) {
    console.log(`[DB] Existing schema detected. Baselining ${confirmedBaselineCount} confirmed migrations...`);
  }

  applyPendingMigrations(sqlite, bundle);
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
