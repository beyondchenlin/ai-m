import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import fs from "node:fs";
import path from "node:path";

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
type SqliteConnection = import("better-sqlite3").Database;
type MigrationMeta = {
  folderMillis: number;
  hash: string;
};

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

function schemaObjectExists(sqlite: SqliteConnection, type: "index" | "trigger", name: string): boolean {
  return Boolean(sqlite.prepare<[string, string], { name: string }>(
    "SELECT name FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
}

function columnExists(
  sqlite: SqliteConnection,
  tableName: string,
  columnName: string,
) {
  if (!tableExists(sqlite, tableName)) return false;

  const columns = sqlite
    .prepare<[], { name: string }>(`PRAGMA table_info("${tableName}")`)
    .all();

  return columns.some((column) => column.name === columnName);
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

function isCurrentSchemaSnapshot(sqlite: SqliteConnection) {
  return (
    columnExists(sqlite, "projects", "user_id") &&
    columnExists(sqlite, "projects", "world_setting") &&
    tableExists(sqlite, "episodes") &&
    tableExists(sqlite, "shot_assets") &&
    tableExists(sqlite, "agents") &&
    columnExists(sqlite, "agents", "platform") &&
    tableExists(sqlite, "agent_bindings")
  );
}

function detectConfirmedBaselineMigrationCount(sqlite: SqliteConnection): number {
  if (getRecordedMigrationCount(sqlite) !== 0 || getAppTableCount(sqlite) === 0) return 0;
  if (!isCurrentSchemaSnapshot(sqlite)) return 0;

  // Legacy application schema is confirmed through 0053. Newer platform
  // migrations are recorded only when their own tables/columns exist. Never
  // mark migrations as applied merely because an unrelated application table
  // exists.
  const markers = [
    tableExists(sqlite, "resource_pools")
      && tableExists(sqlite, "generation_jobs")
      && tableExists(sqlite, "workflow_package_revisions"),
    tableExists(sqlite, "key_references"),
    tableExists(sqlite, "visual_subjects") && tableExists(sqlite, "visual_subject_versions"),
    columnExists(sqlite, "workflow_package_revisions", "workflow_api_json")
      && columnExists(sqlite, "generation_jobs", "idempotency_key")
      && columnExists(sqlite, "generation_attempts", "job_claim_fencing_token")
      && tableExists(sqlite, "voice_profiles")
      && tableExists(sqlite, "workflow_backend_validations")
      && schemaObjectExists(sqlite, "index", "generation_jobs_idempotency_unique")
      && schemaObjectExists(sqlite, "index", "generation_jobs_active_dedupe_unique")
      && schemaObjectExists(sqlite, "trigger", "generation_job_terminal_status_guard"),
    tableExists(sqlite, "source_media_assets")
      && tableExists(sqlite, "generation_job_source_assets")
      && columnExists(sqlite, "voice_profiles", "reference_source_asset_id")
      && schemaObjectExists(sqlite, "index", "source_media_assets_storage_key_unique")
      && schemaObjectExists(sqlite, "index", "source_media_assets_owner_project_idx")
      && schemaObjectExists(sqlite, "index", "generation_job_source_assets_asset_idx"),
    columnExists(sqlite, "generation_jobs", "idempotency_request_digest")
      && columnExists(sqlite, "voice_profiles", "consent_statement_version")
      && schemaObjectExists(sqlite, "index", "source_media_assets_status_updated_idx")
      && schemaObjectExists(sqlite, "index", "voice_profiles_reference_source_asset_idx")
      && schemaObjectExists(sqlite, "index", "generation_jobs_claim_queue_idx")
      && [
        "source_media_assets_validate_insert", "source_media_assets_validate_update",
        "source_media_assets_status_transition_guard", "voice_profiles_validate_insert",
        "voice_profiles_validate_update", "voice_profiles_immutable_identity_guard",
        "voice_profiles_source_reference_guard_insert", "voice_profiles_source_reference_guard_update",
        "generation_job_source_assets_guard_insert", "source_media_assets_delete_reference_guard",
        "source_media_assets_immutable_content_guard", "generation_jobs_idempotency_digest_guard_insert",
        "generation_jobs_idempotency_digest_guard_update", "generation_jobs_idempotency_identity_guard",
      ].every((name) => schemaObjectExists(sqlite, "trigger", name)),
  ];
  const firstMissing = markers.indexOf(false);
  if (firstMissing >= 0 && markers.slice(firstMissing + 1).some(Boolean)) {
    throw new Error(`Database schema drift: migration ${55 + firstMissing} is incomplete while a later migration is present`);
  }
  return 54 + (firstMissing < 0 ? markers.length : firstMissing);
}

function baselineMigrations(
  sqlite: SqliteConnection,
  migrationsFolder: string,
  confirmedCount: number,
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readMigrationFiles } = require("drizzle-orm/migrator") as {
    readMigrationFiles: (config: { migrationsFolder: string }) => MigrationMeta[];
  };

  const migrations = readMigrationFiles({ migrationsFolder });
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

function validateRecordedMigrationPrefix(sqlite: SqliteConnection, migrationsFolder: string): void {
  const rows = sqlite.prepare<[], { hash: string; createdAt: number }>(
    'SELECT hash, created_at AS createdAt FROM "__drizzle_migrations" ORDER BY created_at, rowid',
  ).all();
  if (!rows.length) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readMigrationFiles } = require("drizzle-orm/migrator") as {
    readMigrationFiles: (config: { migrationsFolder: string }) => MigrationMeta[];
  };
  const migrations = readMigrationFiles({ migrationsFolder });
  if (rows.length > migrations.length) throw new Error("Migration journal is ahead of this application build");
  rows.forEach((row, index) => {
    const expected = migrations[index];
    if (row.hash !== expected.hash || Number(row.createdAt) !== expected.folderMillis) {
      throw new Error(`Migration journal drift at index ${index}; refusing to guess schema state`);
    }
  });
}

export function runMigrations() {
  const sqlite = getSqlite();
  const migrationsFolder = path.resolve("drizzle");
  ensureMigrationsTable(sqlite);
  validateRecordedMigrationPrefix(sqlite, migrationsFolder);

  const confirmedBaselineCount = detectConfirmedBaselineMigrationCount(sqlite);
  if (confirmedBaselineCount > 0) {
    console.log(`[DB] Existing schema detected. Baselining ${confirmedBaselineCount} confirmed migrations...`);
    baselineMigrations(sqlite, migrationsFolder, confirmedBaselineCount);
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
