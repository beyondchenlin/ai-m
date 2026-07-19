import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";
import {
  type MigrationMetadata,
} from "../migration-journal";
import {
  buildExpectedSchemaInventories,
  detectJournalLessBaselineMigrationCount,
  normalizeSqlForComparison,
} from "../migration-schema-evidence";
import {
  DATA_POSTCONDITION_REGISTRY,
  runDataPostconditionReadOnly,
  splitSqlStatements,
  topLevelStatementKind,
  validateDataPostconditionRegistry,
  validateMigrationStatementEvidence,
} from "../migration-data-evidence";
import {
  baselineJournalLessDatabase,
  prepareMigrationJournal,
} from "../index";

describe("SQL evidence normalization", () => {
  it("preserves whitespace and escaped quotes inside string literals", () => {
    expect(normalizeSqlForComparison("CHECK (message = 'two  spaces and it''s exact')"))
      .toContain("'two  spaces and it''s exact'");
    expect(normalizeSqlForComparison("CHECK (message = 'two spaces and it''s exact')"))
      .not.toBe(normalizeSqlForComparison("CHECK (message = 'two  spaces and it''s exact')"));
  });

  it("normalizes formatting and identifier quoting without changing literal semantics", () => {
    expect(normalizeSqlForComparison('CREATE VIEW "Example" AS SELECT "value" FROM "items"'))
      .toBe(normalizeSqlForComparison(" create   view [example] as select `value` from items "));
  });

  it("dequotes only safe simple identifiers and preserves spaced, keyword, and escaped identifiers", () => {
    expect(normalizeSqlForComparison('SELECT "safe_name" FROM "items"'))
      .toBe(normalizeSqlForComparison("select safe_name from items"));
    expect(normalizeSqlForComparison('SELECT "a b" FROM items')).not.toBe(normalizeSqlForComparison("SELECT a b FROM items"));
    expect(normalizeSqlForComparison('SELECT "select" FROM items')).not.toBe(normalizeSqlForComparison("SELECT select FROM items"));
    expect(normalizeSqlForComparison('SELECT "a""b" FROM items')).toContain('"a""b"');
  });
});

describe("DML postcondition registry", () => {
  const repositoryMigrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });

  it("exactly binds all repository top-level DML by timestamp and hash", () => {
    expect(() => validateDataPostconditionRegistry(repositoryMigrations, DATA_POSTCONDITION_REGISTRY))
      .not.toThrow();
    expect(DATA_POSTCONDITION_REGISTRY.map((entry) => entry.folderMillis)).toEqual([
      repositoryMigrations[7].folderMillis,
      repositoryMigrations[10].folderMillis,
      repositoryMigrations[57].folderMillis,
      repositoryMigrations[58].folderMillis,
      repositoryMigrations[51].folderMillis,
      repositoryMigrations[69].folderMillis,
      repositoryMigrations[70].folderMillis,
    ]);
  });

  it("ignores DML words inside comments, strings, identifiers, and CREATE TRIGGER bodies", () => {
    expect(topLevelStatementKind("CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET y=1; END"))
      .toBe("CREATE");
    expect(topLevelStatementKind("CREATE TABLE x ([update] text DEFAULT 'DELETE FROM x') -- INSERT"))
      .toBe("CREATE");
    expect(topLevelStatementKind("WITH source AS (SELECT 1) UPDATE x SET y=1")).toBe("UPDATE");
  });

  it("checks every statement and rejects CTAS, writable PRAGMA, and ambiguous state changes", () => {
    expect(splitSqlStatements("CREATE TABLE x(id); INSERT INTO x VALUES(1)")).toHaveLength(2);
    const registration = [{ folderMillis: 1, hash: "multi", verify: () => null }];
    expect(() => validateMigrationStatementEvidence([{ folderMillis: 1, hash: "multi", sql: [
      "CREATE TABLE x(id); INSERT INTO x VALUES(1)",
    ] }], registration)).not.toThrow();
    expect(() => validateMigrationStatementEvidence([{ folderMillis: 2, hash: "ctas", sql: [
      "CREATE TABLE copied AS SELECT * FROM source",
    ] }], [])).toThrow(/data-bearing create/i);
    for (const sql of [
      "CREATE TEMP TABLE copied AS SELECT * FROM source",
      "CREATE TEMPORARY TABLE copied AS WITH rows AS (SELECT 1) SELECT * FROM rows",
      "CREATE TABLE IF NOT EXISTS copied AS VALUES (1), (2)",
    ]) {
      expect(() => validateMigrationStatementEvidence([{ folderMillis: 2, hash: "ctas", sql: [sql] }], []))
        .toThrow(/data-bearing create/i);
    }
    expect(() => validateMigrationStatementEvidence([{ folderMillis: 3, hash: "pragma", sql: [
      "PRAGMA writable_schema=ON",
    ] }], [])).toThrow(/unsupported state-changing/i);
    expect(splitSqlStatements(`CREATE TRIGGER t AFTER INSERT ON x BEGIN
      SELECT CASE WHEN NEW.id=1 THEN 'a; b' ELSE 'c' END;
    END; PRAGMA writable_schema=ON`)).toHaveLength(2);
  });

  it("rejects unregistered, changed-hash, stale, and duplicate registrations", () => {
    const dmlMigration: MigrationMetadata = {
      folderMillis: 1,
      hash: "one",
      sql: ["CREATE TABLE x (id integer)", "INSERT INTO x VALUES (1)"],
    };
    expect(() => validateDataPostconditionRegistry([dmlMigration], [])).toThrow(/does not exactly match/i);
    expect(() => validateDataPostconditionRegistry([dmlMigration], [{
      folderMillis: 1, hash: "changed", verify: () => null,
    }])).toThrow(/does not exactly match/i);
    expect(() => validateDataPostconditionRegistry([], [{
      folderMillis: 1, hash: "one", verify: () => null,
    }])).toThrow(/does not exactly match/i);
    const registration = { folderMillis: 1, hash: "one", verify: () => null };
    expect(() => validateDataPostconditionRegistry([dmlMigration], [registration, registration]))
      .toThrow(/duplicate dml postcondition/i);
  });

  it("runs postcondition verifiers with SQLite writes disabled", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE protected_data (id integer)");
    try {
      expect(() => runDataPostconditionReadOnly(sqlite, {
        folderMillis: 1,
        hash: "mutating",
        verify: (connection) => {
          connection.exec("INSERT INTO protected_data VALUES (1)");
          return null;
        },
      })).toThrow(/readonly database/i);
      expect(sqlite.prepare("SELECT COUNT(*) count FROM protected_data").get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("allows 0007 and 0010 only for vacuous empty copy sources", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE projects (id text);
      CREATE TABLE shots (id text);
      CREATE TABLE storyboard_versions (id text);
      CREATE TABLE episodes (id text);
      CREATE TABLE tasks (id text);
    `);
    try {
      expect(runDataPostconditionReadOnly(sqlite, DATA_POSTCONDITION_REGISTRY[0])).toBeNull();
      expect(runDataPostconditionReadOnly(sqlite, DATA_POSTCONDITION_REGISTRY[1])).toBeNull();
      sqlite.exec("INSERT INTO projects VALUES ('nonempty')");
      expect(runDataPostconditionReadOnly(sqlite, DATA_POSTCONDITION_REGISTRY[0]))
        .toMatch(/operator-only.*nonempty/i);
      expect(runDataPostconditionReadOnly(sqlite, DATA_POSTCONDITION_REGISTRY[1]))
        .toMatch(/operator-only.*nonempty/i);
    } finally {
      sqlite.close();
    }
  });

  it("verifies all safety-equivalent 0057 backfill postconditions", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE workflow_package_revisions (digest text, workflow_api_json text);
      CREATE TABLE workflow_package_states (workflow_package_digest text, state text, validation_report_json text);
      CREATE TABLE generation_artifacts (updated_at_ms integer);
      CREATE TABLE business_task_generation_jobs (generation_job_id text);
      CREATE TABLE generation_profile_revisions (id text, adapter_kind text);
      CREATE TABLE generation_profile_states (generation_profile_revision_id text, enabled integer, visibility text);
      CREATE TABLE default_generation_profile_pointers (generation_profile_revision_id text);
      INSERT INTO workflow_package_revisions VALUES ('w', '{}');
      INSERT INTO workflow_package_states VALUES (
        'w', 'invalid', json_array('PR-12 requires re-importing a real workflow.api.json package')
      );
      INSERT INTO generation_artifacts VALUES (10);
      INSERT INTO business_task_generation_jobs VALUES ('j1');
      INSERT INTO generation_profile_revisions VALUES ('p', 'zimage');
      INSERT INTO generation_profile_states VALUES ('p', 0, 'admin');
    `);
    try {
      expect(runDataPostconditionReadOnly(sqlite, DATA_POSTCONDITION_REGISTRY[2])).toBeNull();
      sqlite.exec("UPDATE generation_profile_states SET enabled=1");
      expect(runDataPostconditionReadOnly(sqlite, DATA_POSTCONDITION_REGISTRY[2]))
        .toMatch(/0057.*incomplete/i);
    } finally {
      sqlite.close();
    }
  });

  it("operator-refuses nonempty 0058 because its dropped copy source is unprovable", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE voice_profiles (id text)");
    try {
      expect(runDataPostconditionReadOnly(sqlite, DATA_POSTCONDITION_REGISTRY[3]))
        .toMatch(/never independently provable/i);
      sqlite.exec("INSERT INTO voice_profiles VALUES ('copied-but-unprovable')");
      expect(runDataPostconditionReadOnly(sqlite, DATA_POSTCONDITION_REGISTRY[3]))
        .toMatch(/never independently provable/i);
    } finally {
      sqlite.close();
    }
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

  it("refuses automatic recovery across destructive legacy migration 0051", () => {
    const sqlite = databaseAtBoundary(54);
    try {
      expect(() => detect(sqlite)).toThrow(/0051.*never independently provable/i);
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

  it("does not expose mutable cached inventory internals", () => {
    const first = buildExpectedSchemaInventories(repositoryMigrations);
    first.boundaries.length = 0;
    expect(buildExpectedSchemaInventories(repositoryMigrations).boundaries).toHaveLength(repositoryMigrations.length);
  });

  it("invalidates the single-build cache when migration SQL changes", () => {
    const original = [{ folderMillis: 1, hash: "a", sql: ["CREATE TABLE cache_test (id text)"] }];
    const changed = [{ folderMillis: 1, hash: "a", sql: ["CREATE TABLE cache_test (id integer)"] }];
    expect(buildExpectedSchemaInventories(original)).not.toEqual(buildExpectedSchemaInventories(changed));
  });

  it("recognizes equivalent formatting but rejects changed CHECK literal semantics", () => {
    const semanticMigrations: MigrationMetadata[] = [{
      folderMillis: 1,
      hash: "semantic",
      sql: ["CREATE TABLE semantic_test (value text CHECK (value <> 'two  spaces'))"],
    }];
    const equivalent = new Database(":memory:");
    const changed = new Database(":memory:");
    try {
      equivalent.exec("CREATE TABLE [semantic_test] ([value] TEXT CHECK([value]<>'two  spaces'))");
      changed.exec("CREATE TABLE semantic_test (value text CHECK(value <> 'two spaces'))");
      const facts = (sqlite: Database.Database) => ({
        journalRowCount: 0,
        appTableCount: 1,
        readActualInventory: () => sqlite,
      });
      expect(detectJournalLessBaselineMigrationCount(facts(equivalent), semanticMigrations)).toBe(1);
      expect(() => detectJournalLessBaselineMigrationCount(facts(changed), semanticMigrations))
        .toThrow(/does not match any complete migration boundary/i);
    } finally {
      equivalent.close();
      changed.close();
    }
  });

  it("inventories views and rejects a partially present future view", () => {
    const viewMigrations: MigrationMetadata[] = [
      { folderMillis: 1, hash: "table", sql: ["CREATE TABLE view_source (id text)"] },
      { folderMillis: 2, hash: "view", sql: ["CREATE VIEW active_view AS SELECT id FROM view_source WHERE id <> 'x  y'"] },
    ];
    const complete = new Database(":memory:");
    const partial = new Database(":memory:");
    try {
      complete.exec(viewMigrations.flatMap((migration) => migration.sql ?? []).join(";"));
      partial.exec("CREATE TABLE view_source (id text); CREATE VIEW active_view AS SELECT id FROM view_source");
      const facts = (sqlite: Database.Database) => ({
        journalRowCount: 0,
        appTableCount: 1,
        readActualInventory: () => sqlite,
      });
      expect(detectJournalLessBaselineMigrationCount(facts(complete), viewMigrations)).toBe(2);
      expect(() => detectJournalLessBaselineMigrationCount(facts(partial), viewMigrations))
        .toThrow(/does not match any complete migration boundary/i);
    } finally {
      complete.close();
      partial.close();
    }
  });

  it("uses FK and expression-index semantics while tolerating equivalent quoting and case", () => {
    const semanticMigrations: MigrationMetadata[] = [{
      folderMillis: 1,
      hash: "fk-index",
      sql: [
        "CREATE TABLE parent (id text PRIMARY KEY)",
        "CREATE TABLE child (id text, parent_id text REFERENCES parent(id) ON DELETE CASCADE, value text)",
        "CREATE UNIQUE INDEX child_expr ON child(lower(value)) WHERE value <> 'x  y'",
      ],
    }];
    const make = (foreignKey: string, index: string) => {
      const sqlite = new Database(":memory:");
      sqlite.exec(`CREATE TABLE [PARENT] ([ID] TEXT PRIMARY KEY);
        CREATE TABLE [CHILD] ([ID] TEXT, [PARENT_ID] TEXT REFERENCES [PARENT]([ID]) ${foreignKey}, [VALUE] TEXT);
        ${index}`);
      return sqlite;
    };
    const equivalent = make("ON DELETE CASCADE", "CREATE UNIQUE INDEX [CHILD_EXPR] ON [CHILD](lower([VALUE])) WHERE [VALUE]<>'x  y'");
    const changedForeignKey = make("ON DELETE RESTRICT", "CREATE UNIQUE INDEX child_expr ON child(lower(value)) WHERE value<>'x  y'");
    const changedIndex = make("ON DELETE CASCADE", "CREATE INDEX child_expr ON child(lower(value)) WHERE value<>'x  y'");
    try {
      const facts = (sqlite: Database.Database) => ({ journalRowCount: 0, appTableCount: 2, readActualInventory: () => sqlite });
      expect(detectJournalLessBaselineMigrationCount(facts(equivalent), semanticMigrations)).toBe(1);
      expect(() => detectJournalLessBaselineMigrationCount(facts(changedForeignKey), semanticMigrations)).toThrow();
      expect(() => detectJournalLessBaselineMigrationCount(facts(changedIndex), semanticMigrations)).toThrow();
    } finally {
      equivalent.close();
      changedForeignKey.close();
      changedIndex.close();
    }
  });

  it.each([
    ["generated expression", "CREATE TABLE advanced (id integer PRIMARY KEY, value integer, derived integer GENERATED ALWAYS AS (value + 2) STORED)"],
    ["inline unique", "CREATE TABLE advanced (id integer PRIMARY KEY, value text UNIQUE)"],
    ["STRICT option", "CREATE TABLE advanced (id integer PRIMARY KEY, value text) STRICT"],
    ["WITHOUT ROWID option", "CREATE TABLE advanced (id integer PRIMARY KEY, value text) WITHOUT ROWID"],
    ["column collation", "CREATE TABLE advanced (id integer PRIMARY KEY, value text COLLATE NOCASE)"],
    ["FK deferrability", "CREATE TABLE parent (id integer PRIMARY KEY); CREATE TABLE advanced (id integer PRIMARY KEY, parent_id integer REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)"],
  ])("rejects changed %s semantics", (_label, changedSql) => {
    const expectedSql = "CREATE TABLE parent (id integer PRIMARY KEY); CREATE TABLE advanced (id integer PRIMARY KEY, value text)";
    const migrations: MigrationMetadata[] = [{ folderMillis: 1, hash: "advanced", sql: expectedSql.split("; ") }];
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(changedSql);
      expect(() => detectJournalLessBaselineMigrationCount({
        journalRowCount: 0, appTableCount: 1, readActualInventory: () => sqlite,
      }, migrations)).toThrow(/does not match any complete migration boundary/i);
    } finally { sqlite.close(); }
  });

  it("captures virtual-table module arguments and index target tables", () => {
    const migrations: MigrationMetadata[] = [{
      folderMillis: 1, hash: "virtual", sql: ["CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='porter')"],
    }];
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='unicode61')");
    try {
      expect(() => detectJournalLessBaselineMigrationCount({
        journalRowCount: 0, appTableCount: 1, readActualInventory: () => sqlite,
      }, migrations)).toThrow(/data-bearing create|complete migration boundary/i);
    } finally { sqlite.close(); }
  });

  it("keeps the journal empty when nonempty 0007 provenance requires operator action", () => {
    const sqlite = databaseAtBoundary(54);
    sqlite.exec(`
      CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
      INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p','project',1,1);
    `);
    try {
      prepareMigrationJournal(sqlite, repositoryMigrations);
      expect(() => baselineJournalLessDatabase(sqlite, repositoryMigrations))
        .toThrow(/0007.*operator-only/i);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("keeps the journal empty when a later boundary crosses destructive 0051", () => {
    const sqlite = databaseAtBoundary(59);
    sqlite.pragma("foreign_keys = OFF");
    sqlite.exec(`
      CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
      INSERT INTO voice_profiles (
        id,project_id,user_id,name,provider,reference_artifact_id,reference_source_asset_id,
        language,default_speed_milli,default_pitch_milli,consent_confirmed_at_ms,created_at_ms,updated_at_ms
      ) VALUES ('v','p','u','voice','indextts2','artifact',NULL,'zh-CN',1000,1000,1,1,1);
    `);
    try {
      prepareMigrationJournal(sqlite, repositoryMigrations);
      expect(() => baselineJournalLessDatabase(sqlite, repositoryMigrations))
        .toThrow(/0051.*never independently provable/i);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    "DROP TABLE doomed",
    "/* prefix */ DROP TABLE [doomed]",
    "ALTER TABLE doomed DROP COLUMN secret",
  ])("refuses a journal-less create-then-destructive boundary: %s", (destructive) => {
    const migrations: MigrationMetadata[] = [
      { folderMillis: 1, hash: "create", sql: ["CREATE TABLE doomed (id integer, secret text)"] },
      { folderMillis: 2, hash: "destroy", sql: [destructive] },
    ];
    const sqlite = new Database(":memory:");
    for (const migration of migrations) for (const statement of migration.sql ?? []) sqlite.exec(statement);
    try {
      expect(() => detectJournalLessBaselineMigrationCount({
        journalRowCount: 0, appTableCount: 1, readActualInventory: () => sqlite,
      }, migrations)).toThrow(/destructive|operator|registry/i);
    } finally { sqlite.close(); }
  });
});
