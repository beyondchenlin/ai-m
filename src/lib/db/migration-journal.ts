export type MigrationMetadata = {
  folderMillis: number;
  hash: string;
  sql?: string[];
};

export type MigrationJournalRow = {
  createdAt: number;
  hash: string;
};

export type LegacyVisualSubjectSnapshot = {
  journalRows: MigrationJournalRow[];
  tables: Record<string, string[]>;
};

type SqliteDatabase = import("better-sqlite3").Database;

type ColumnSignature = {
  name: string;
  type: string;
  notnull: number;
  defaultValue: string | number | null;
  primaryKey: number;
  hidden: number;
};

type TableSignature = {
  definition: string;
  columns: ColumnSignature[];
};

export type SchemaInventory = {
  tables: Record<string, TableSignature>;
  indexes: Record<string, string>;
  triggers: Record<string, string>;
};

type ManagedSchemaUniverse = {
  tables: Set<string>;
  indexes: Set<string>;
  triggers: Set<string>;
};

export type ExpectedSchemaInventories = {
  boundaries: SchemaInventory[];
  managed: ManagedSchemaUniverse;
};

export type JournalLessBaselineFacts = {
  journalRowCount: number;
  appTableCount: number;
  readActualInventory: () => SqliteDatabase;
};

/** Timestamp recorded by the historical 0055 key-references migration. */
export const LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP = 1783854021421;

/** Timestamp recorded by 0056, whose schema was once shipped without its journal row. */
export const LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP = 1783854500000;

export function validateMigrationJournal(
  rows: MigrationJournalRow[],
  migrations: MigrationMetadata[],
): void {
  if (rows.length > migrations.length) {
    throw new Error("Migration journal is ahead of this application build");
  }

  const migrationsByTimestamp = new Map<number, MigrationMetadata>();
  for (const migration of migrations) {
    if (migrationsByTimestamp.has(migration.folderMillis)) {
      throw new Error(`Duplicate migration metadata timestamp ${migration.folderMillis}`);
    }
    migrationsByTimestamp.set(migration.folderMillis, migration);
  }

  const recordedTimestamps = new Set<number>();
  for (const row of rows) {
    const timestamp = Number(row.createdAt);
    if (recordedTimestamps.has(timestamp)) {
      throw new Error(`Duplicate recorded migration timestamp ${timestamp}`);
    }
    recordedTimestamps.add(timestamp);

    const migration = migrationsByTimestamp.get(timestamp);
    if (!migration) throw new Error(`Unknown migration timestamp ${timestamp}`);
    if (row.hash !== migration.hash) {
      throw new Error(`Migration hash mismatch at timestamp ${timestamp}`);
    }
  }
}

export function selectLegacyVisualSubjectJournalRepair(
  snapshot: LegacyVisualSubjectSnapshot,
  migrations: MigrationMetadata[],
): MigrationMetadata | null {
  if (snapshot.journalRows.some(
    (row) => Number(row.createdAt) === LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
  )) return null;
  if (snapshot.journalRows.length !== 56) return null;
  const latestTimestamp = Math.max(...snapshot.journalRows.map((row) => Number(row.createdAt)));
  if (latestTimestamp !== LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP) return null;

  const requiredSchema: Record<string, string[]> = {
    visual_subjects: ["identity_anchors_json", "multi_angle_references_json"],
    visual_subject_versions: ["snapshot_json"],
  };
  for (const [table, requiredColumns] of Object.entries(requiredSchema)) {
    const actualColumns = snapshot.tables[table];
    if (!actualColumns || requiredColumns.some((column) => !actualColumns.includes(column))) return null;
  }

  const matchingMetadata = migrations.filter(
    (migration) => migration.folderMillis === LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
  );
  if (matchingMetadata.length > 1) {
    throw new Error(`Duplicate migration metadata timestamp ${LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP}`);
  }
  return matchingMetadata[0] ?? null;
}

function normalizeSql(sql: string | null): string {
  return (sql ?? "").replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function readSchemaInventory(sqlite: SqliteDatabase): SchemaInventory {
  const objects = sqlite.prepare<[], { type: "table" | "index" | "trigger"; name: string; sql: string | null }>(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger')
      AND name NOT LIKE 'sqlite_%'
      AND name != '__drizzle_migrations'
    ORDER BY type, name
  `).all();
  const inventory: SchemaInventory = { tables: {}, indexes: {}, triggers: {} };

  for (const object of objects) {
    if (object.type === "table") {
      const escapedName = object.name.replace(/"/g, '""');
      const columns = sqlite.prepare<[], {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | number | null;
        pk: number;
        hidden: number;
      }>(`PRAGMA table_xinfo("${escapedName}")`).all().map((column) => ({
        name: column.name,
        type: column.type,
        notnull: Number(column.notnull),
        defaultValue: column.dflt_value,
        primaryKey: Number(column.pk),
        hidden: Number(column.hidden),
      }));
      inventory.tables[object.name] = {
        definition: normalizeSql(object.sql),
        columns,
      };
    } else if (object.type === "index" && object.sql) {
      inventory.indexes[object.name] = normalizeSql(object.sql);
    } else if (object.type === "trigger" && object.sql) {
      inventory.triggers[object.name] = normalizeSql(object.sql);
    }
  }
  return inventory;
}

const expectedInventoryCache = new Map<string, ExpectedSchemaInventories>();

function migrationBuildKey(migrations: MigrationMetadata[]): string {
  return JSON.stringify(migrations.map((migration) => [
    migration.folderMillis,
    migration.hash,
    migration.sql ?? [],
  ]));
}

/** Build complete repository-managed schema evidence once for each migration build. */
export function buildExpectedSchemaInventories(
  migrations: MigrationMetadata[],
): ExpectedSchemaInventories {
  const cacheKey = migrationBuildKey(migrations);
  const cached = expectedInventoryCache.get(cacheKey);
  if (cached) return cached;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const sqlite = new Database(":memory:");
  const boundaries: SchemaInventory[] = [];
  const managed: ManagedSchemaUniverse = {
    tables: new Set(),
    indexes: new Set(),
    triggers: new Set(),
  };
  try {
    for (const migration of migrations) {
      if (!migration.sql) throw new Error(`Migration ${migration.folderMillis} has no SQL metadata`);
      for (const statement of migration.sql) sqlite.exec(statement);
      const inventory = readSchemaInventory(sqlite);
      boundaries.push(inventory);
      Object.keys(inventory.tables).forEach((name) => managed.tables.add(name));
      Object.keys(inventory.indexes).forEach((name) => managed.indexes.add(name));
      Object.keys(inventory.triggers).forEach((name) => managed.triggers.add(name));
    }
  } finally {
    sqlite.close();
  }

  const result = { boundaries, managed };
  expectedInventoryCache.set(cacheKey, result);
  return result;
}

function recordsEqual<T>(left: T | undefined, right: T | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inventoryMatchesBoundary(
  actual: SchemaInventory,
  expected: SchemaInventory,
  managed: ManagedSchemaUniverse,
): boolean {
  for (const name of managed.tables) {
    if (!recordsEqual(actual.tables[name], expected.tables[name])) return false;
  }
  for (const name of managed.indexes) {
    if (actual.indexes[name] !== expected.indexes[name]) return false;
  }
  for (const name of managed.triggers) {
    if (actual.triggers[name] !== expected.triggers[name]) return false;
  }
  return true;
}

/**
 * Return the exact repository migration boundary represented by a journal-less
 * database. Repository-managed future objects make every older boundary fail.
 */
export function detectJournalLessBaselineMigrationCount(
  facts: JournalLessBaselineFacts,
  migrations: MigrationMetadata[],
): number {
  if (facts.journalRowCount !== 0 || facts.appTableCount === 0) return 0;

  const expected = buildExpectedSchemaInventories(migrations);
  const actual = readSchemaInventory(facts.readActualInventory());
  for (let index = expected.boundaries.length - 1; index >= 0; index -= 1) {
    if (inventoryMatchesBoundary(actual, expected.boundaries[index], expected.managed)) return index + 1;
  }
  throw new Error("Journal-less database schema does not match any complete migration boundary");
}
