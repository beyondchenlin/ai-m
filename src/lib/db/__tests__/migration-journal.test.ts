import { describe, expect, it } from "vitest";
import {
  buildExpectedSchemaInventories,
  detectJournalLessBaselineMigrationCount,
  LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
  LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP,
  selectLegacyVisualSubjectJournalRepair,
  validateMigrationJournal,
  type MigrationMetadata,
} from "../migration-journal";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";
import { prepareMigrationJournal } from "../index";

const migrations: MigrationMetadata[] = [
  { folderMillis: 30, hash: "three" },
  { folderMillis: 10, hash: "one" },
  { folderMillis: 20, hash: "two" },
];

describe("validateMigrationJournal", () => {
  it("accepts valid rows independently of insertion order", () => {
    expect(() => validateMigrationJournal([
      { createdAt: 20, hash: "two" },
      { createdAt: 30, hash: "three" },
      { createdAt: 10, hash: "one" },
    ], migrations)).not.toThrow();
  });

  it("rejects an unknown recorded timestamp", () => {
    expect(() => validateMigrationJournal([{ createdAt: 40, hash: "four" }], migrations))
      .toThrow(/unknown migration timestamp 40/i);
  });

  it("rejects a hash that does not match its immutable timestamp", () => {
    expect(() => validateMigrationJournal([{ createdAt: 20, hash: "wrong" }], migrations))
      .toThrow(/hash mismatch.*20/i);
  });

  it("rejects duplicate recorded timestamps", () => {
    expect(() => validateMigrationJournal([
      { createdAt: 20, hash: "two" },
      { createdAt: 20, hash: "two" },
    ], migrations)).toThrow(/duplicate recorded migration timestamp 20/i);
  });

  it("rejects duplicate migration metadata timestamps", () => {
    expect(() => validateMigrationJournal([], [...migrations, { folderMillis: 20, hash: "other" }]))
      .toThrow(/duplicate migration metadata timestamp 20/i);
  });

  it("rejects a journal with more rows than the application build", () => {
    expect(() => validateMigrationJournal([
      { createdAt: 10, hash: "one" },
      { createdAt: 20, hash: "two" },
      { createdAt: 30, hash: "three" },
      { createdAt: 40, hash: "four" },
    ], migrations)).toThrow(/ahead of this application build/i);
  });
});

describe("selectLegacyVisualSubjectJournalRepair", () => {
  const visualMigration = {
    folderMillis: LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
    hash: "visual-hash",
  };
  const completeSnapshot = {
    journalRows: Array.from({ length: 56 }, (_, index) => ({
      createdAt: index === 55 ? LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP : index,
      hash: `hash-${index}`,
    })),
    tables: {
      visual_subjects: ["id", "identity_anchors_json", "multi_angle_references_json"],
      visual_subject_versions: ["id", "snapshot_json"],
    },
  };

  it("selects the exact 0056 metadata when every legacy condition is met", () => {
    expect(selectLegacyVisualSubjectJournalRepair(completeSnapshot, [visualMigration]))
      .toEqual(visualMigration);
  });

  it.each([
    ["0056 is already recorded", {
      ...completeSnapshot,
      journalRows: [...completeSnapshot.journalRows, {
        createdAt: LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
        hash: "visual-hash",
      }],
    }],
    ["the row count is not exactly 56", {
      ...completeSnapshot,
      journalRows: completeSnapshot.journalRows.slice(1),
    }],
    ["the latest timestamp is not exact 0055", {
      ...completeSnapshot,
      journalRows: completeSnapshot.journalRows.map((row, index) => index === 55
        ? { ...row, createdAt: LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP + 1 }
        : row),
    }],
    ["visual_subjects is absent", {
      ...completeSnapshot,
      tables: { visual_subject_versions: completeSnapshot.tables.visual_subject_versions },
    }],
    ["visual_subject_versions is absent", {
      ...completeSnapshot,
      tables: { visual_subjects: completeSnapshot.tables.visual_subjects },
    }],
    ["identity_anchors_json is absent", {
      ...completeSnapshot,
      tables: {
        ...completeSnapshot.tables,
        visual_subjects: ["id", "multi_angle_references_json"],
      },
    }],
    ["multi_angle_references_json is absent", {
      ...completeSnapshot,
      tables: {
        ...completeSnapshot.tables,
        visual_subjects: ["id", "identity_anchors_json"],
      },
    }],
    ["snapshot_json is absent", {
      ...completeSnapshot,
      tables: {
        ...completeSnapshot.tables,
        visual_subject_versions: ["id"],
      },
    }],
  ])("does not repair when %s", (_name, snapshot) => {
    expect(selectLegacyVisualSubjectJournalRepair(snapshot, [visualMigration])).toBeNull();
  });

  it("does not repair without exact 0056 migration metadata", () => {
    expect(selectLegacyVisualSubjectJournalRepair(completeSnapshot, [])).toBeNull();
  });

  it("rejects ambiguous duplicate 0056 migration metadata", () => {
    expect(() => selectLegacyVisualSubjectJournalRepair(completeSnapshot, [visualMigration, visualMigration]))
      .toThrow(/duplicate migration metadata timestamp/i);
  });
});

describe("journal-less full-schema evidence", () => {
  const repositoryMigrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });

  function databaseAtBoundary(count: number): Database.Database {
    const sqlite = new Database(":memory:");
    for (const migration of repositoryMigrations.slice(0, count)) {
      for (const statement of migration.sql) sqlite.exec(statement);
    }
    return sqlite;
  }

  function detect(sqlite: Database.Database): number {
    return detectJournalLessBaselineMigrationCount({
      journalRowCount: 0,
      appTableCount: Number(sqlite.prepare<[], { count: number }>(
        "SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).get()?.count ?? 0),
      readActualInventory: () => sqlite,
    }, repositoryMigrations);
  }

  it("recognizes a complete legacy 0053 boundary", () => {
    const sqlite = databaseAtBoundary(54);
    try {
      expect(detect(sqlite)).toBe(54);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["table", "DROP TABLE source_media_assets"],
    ["column", "ALTER TABLE visual_subjects DROP COLUMN identity_anchors_json"],
    ["index", "DROP INDEX source_media_assets_status_updated_idx"],
    ["trigger", "DROP TRIGGER source_media_assets_validate_insert"],
  ])("never baselines past a missing expected %s", (_kind, mutation) => {
    const sqlite = databaseAtBoundary(repositoryMigrations.length);
    try {
      sqlite.exec(mutation);
      expect(() => detect(sqlite)).toThrow(/does not match any complete migration boundary/i);
    } finally {
      sqlite.close();
    }
  });

  it("fails closed when a later migration is only partially present", () => {
    const sqlite = databaseAtBoundary(54);
    try {
      sqlite.exec(repositoryMigrations[54].sql[0]);
      expect(() => detect(sqlite)).toThrow(/does not match any complete migration boundary/i);
    } finally {
      sqlite.close();
    }
  });

  it("does not build expected inventories on the normal journal path", () => {
    let snapshotReads = 0;
    expect(detectJournalLessBaselineMigrationCount({
      journalRowCount: 1,
      appTableCount: 20,
      readActualInventory: () => {
        snapshotReads += 1;
        throw new Error("must not inspect schema");
      },
    }, repositoryMigrations)).toBe(0);
    expect(snapshotReads).toBe(0);
  });

  it("caches immutable expected inventories safely per migration build", () => {
    expect(buildExpectedSchemaInventories(repositoryMigrations))
      .toBe(buildExpectedSchemaInventories(repositoryMigrations));
  });
});

describe("migration journal startup ordering", () => {
  const repositoryMigrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });

  function legacyVisualDatabase(rows: Array<{ hash: string; createdAt: number }>): Database.Database {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE "__drizzle_migrations" (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      );
      CREATE TABLE visual_subjects (
        id text PRIMARY KEY,
        identity_anchors_json text NOT NULL,
        multi_angle_references_json text NOT NULL
      );
      CREATE TABLE visual_subject_versions (
        id text PRIMARY KEY,
        snapshot_json text NOT NULL
      );
    `);
    const insert = sqlite.prepare(
      'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
    );
    for (const row of rows) insert.run(row.hash, row.createdAt);
    return sqlite;
  }

  const validLegacyRows = repositoryMigrations.slice(0, 56).map((migration) => ({
    hash: migration.hash,
    createdAt: migration.folderMillis,
  }));

  it.each([
    ["bad prior hash", validLegacyRows.map((row, index) => index === 20
      ? { ...row, hash: "bad-prior-hash" }
      : row), /hash mismatch/i],
    ["duplicate timestamp", validLegacyRows.map((row, index) => index === 20
      ? { ...row, createdAt: validLegacyRows[19].createdAt, hash: validLegacyRows[19].hash }
      : row), /duplicate recorded migration timestamp/i],
    ["unknown timestamp", validLegacyRows.map((row, index) => index === 20
      ? { ...row, createdAt: 123456789, hash: "unknown" }
      : row), /unknown migration timestamp/i],
  ])("does not mutate a 56-row legacy journal with a %s", (_name, rows, error) => {
    const sqlite = legacyVisualDatabase(rows);
    try {
      expect(() => prepareMigrationJournal(sqlite, repositoryMigrations)).toThrow(error);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get())
        .toEqual({ count: 56 });
      expect(sqlite.prepare(
        'SELECT COUNT(*) count FROM "__drizzle_migrations" WHERE created_at = ?',
      ).get(LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP)).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("validates, inserts exact 0056, and validates the repaired journal", () => {
    const sqlite = legacyVisualDatabase(validLegacyRows);
    try {
      prepareMigrationJournal(sqlite, repositoryMigrations);
      expect(sqlite.prepare(
        'SELECT hash, created_at createdAt FROM "__drizzle_migrations" WHERE created_at = ?',
      ).get(LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP)).toEqual({
        hash: repositoryMigrations[56].hash,
        createdAt: LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
      });
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get())
        .toEqual({ count: 57 });
    } finally {
      sqlite.close();
    }
  });
});
