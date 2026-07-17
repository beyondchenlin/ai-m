import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { buildSync } from "esbuild";
import {
  LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
} from "../migration-journal";
import {
  baselineJournalLessDatabase,
  applyPendingMigrations,
  computeMigrationsManifestDigest,
  initializeOwnedSqliteConnection,
  loadValidatedMigrationBundle,
  prepareMigrationJournal,
  resolveMigrationsFolder,
  waitForCurrentMigrationBundle,
} from "../index";
import {
  MIGRATION_PRECONDITION_REGISTRY,
  validateMigrationPreconditionRegistry,
} from "../migration-preconditions";

describe("migration journal startup ordering", () => {
  const repositoryMigrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });
  const repositoryBundle = loadValidatedMigrationBundle(path.resolve("drizzle"));
  const OLD_0060_HASH = "92abf3be9aac6c6591cd7c5ca7cc9527cf42baa04bd79b4aeb6790797dadef23";
  const OLD_0060_TIMESTAMP = 1784209200000;
  const PUBLISHED_0061_HASH = "1616ca4c54d5af31ced5ca321a016f3124a0dc2b36a1941c4710e3ade010221f";

  it("preserves exact published 0060 bytes and binds the precondition to additive 0061", () => {
    expect(createHash("sha256").update(fs.readFileSync(
      path.resolve("drizzle/0060_resource_reconciliation_proof.sql"),
    )).digest("hex")).toBe(OLD_0060_HASH);
    expect(repositoryBundle.migrations[60]).toMatchObject({
      folderMillis: OLD_0060_TIMESTAMP,
      hash: OLD_0060_HASH,
    });
    expect(createHash("sha256").update(fs.readFileSync(
      path.resolve("drizzle/0061_resource_slot_owner_unique.sql"),
    )).digest("hex")).toBe(PUBLISHED_0061_HASH);
    expect(repositoryBundle.migrations).toHaveLength(63);
    expect(MIGRATION_PRECONDITION_REGISTRY.map(({ folderMillis, hash }) => ({ folderMillis, hash })))
      .toEqual([{
        folderMillis: repositoryBundle.migrations[61].folderMillis,
        hash: repositoryBundle.migrations[61].hash,
      }]);
    expect(() => validateMigrationPreconditionRegistry(
      repositoryBundle.migrations,
      MIGRATION_PRECONDITION_REGISTRY,
    )).not.toThrow();
    expect(() => validateMigrationPreconditionRegistry(
      repositoryBundle.migrations.map((migration, index) => index === 61
        ? { ...migration, hash: "changed-0061-hash" }
        : migration),
      MIGRATION_PRECONDITION_REGISTRY,
    )).toThrow(/precondition registry.*exact migration identity/i);
  });

  function databaseRecordedThroughPublished0060(): Database.Database {
    const sqlite = new Database(":memory:");
    sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    const insert = sqlite.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)');
    for (const migration of repositoryBundle.migrations.slice(0, 60)) {
      for (const statement of migration.sql ?? []) sqlite.exec(statement);
      insert.run(migration.hash, migration.folderMillis);
    }
    const candidate0060 = repositoryBundle.migrations[60];
    for (const statement of candidate0060.sql ?? []) {
      if (!statement.includes("resource_pool_slots_owner_attempt_unique")) sqlite.exec(statement);
    }
    insert.run(OLD_0060_HASH, OLD_0060_TIMESTAMP);
    return sqlite;
  }

  function databaseRecordedThroughPublished0061(): Database.Database {
    const sqlite = new Database(":memory:");
    sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    const insert = sqlite.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)');
    for (const migration of repositoryBundle.migrations.slice(0, 62)) {
      for (const statement of migration.sql ?? []) sqlite.exec(statement);
      insert.run(migration.hash, migration.folderMillis);
    }
    return sqlite;
  }

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
    ["SQLITE_BUSY", false, 3, 0, 2],
    ["SQLITE_LOCKED", false, 3, 0, 2],
    ["SQLITE_BUSY", true, 1, 1, 0],
    ["SQLITE_LOCKED", true, 1, 1, 0],
    ["SQLITE_IOERR", false, 1, 1, 0],
  ])("handles WAL initialization error %s (timeout=%s)", (code, timeout, expectedAttempts, expectedCloses, expectedWaits) => {
    let walAttempts = 0;
    let closes = 0;
    let waits = 0;
    let nowCalls = 0;
    const sqlite = {
      pragma(value: string) {
        if (value !== "journal_mode = WAL") return;
        walAttempts += 1;
        if (timeout || walAttempts < 3 || code === "SQLITE_IOERR") {
          throw Object.assign(new Error("wal failed"), { code });
        }
      },
      close() { closes += 1; },
    };
    let caught: unknown;
    try {
      initializeOwnedSqliteConnection(sqlite as unknown as Parameters<typeof initializeOwnedSqliteConnection>[0], {
        now: () => timeout && nowCalls++ > 0 ? 6_000 : 0,
        wait: () => { waits += 1; },
        timeoutMilliseconds: 5_000,
      });
    } catch (error) { caught = error; }
    expect({
      walAttempts,
      closes,
      waits,
      ...(expectedCloses ? { code: (caught as { code?: string })?.code } : {}),
    }).toEqual({ walAttempts: expectedAttempts, closes: expectedCloses, waits: expectedWaits,
      ...(expectedCloses ? { code } : {}) });
  });

  it.each(["busy_timeout = 5000", "foreign_keys = ON"])(
    "closes exactly once when %s initialization fails and preserves the original error",
    (failedPragma) => {
      let closes = 0;
      const sqlite = {
        pragma(value: string) {
          if (value === failedPragma) throw Object.assign(new Error("original setup failure"), { code: "SQLITE_IOERR" });
        },
        close() { closes += 1; throw new Error("close failure"); },
      };
      let caught: unknown;
      try {
        initializeOwnedSqliteConnection(sqlite as unknown as Parameters<typeof initializeOwnedSqliteConnection>[0]);
      } catch (error) { caught = error; }
      const aggregate = caught as AggregateError;
      expect(closes).toBe(1);
      expect([aggregate.message, (aggregate.cause as Error)?.message,
        ...((aggregate.errors ?? []) as Error[]).map((error) => error.message)])
        .toContain("original setup failure");
    },
  );

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

  it.each([
    ['CREATE INDEX "__drizzle_migrations_created_at_unique" ON "__drizzle_migrations" (hash)'],
    ['CREATE UNIQUE INDEX "__drizzle_migrations_created_at_unique" ON "__drizzle_migrations" (created_at) WHERE created_at IS NOT NULL'],
    ['CREATE UNIQUE INDEX "__drizzle_migrations_created_at_unique" ON "__drizzle_migrations" (created_at, hash)'],
    ['CREATE UNIQUE INDEX "__drizzle_migrations_created_at_unique" ON "__drizzle_migrations" (created_at DESC)'],
    ['CREATE UNIQUE INDEX "__drizzle_migrations_created_at_unique" ON "__drizzle_migrations" (created_at COLLATE NOCASE)'],
  ])("fails closed when the timestamp index name is occupied by: %s", (indexSql) => {
    const sqlite = legacyVisualDatabase([]);
    sqlite.exec(indexSql);
    try {
      expect(() => prepareMigrationJournal(sqlite, repositoryMigrations)).toThrow(/incompatible definition/i);
    } finally { sqlite.close(); }
  });

  it("applies a pending repository prefix atomically with the journal", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    try {
      prepareMigrationJournal(sqlite, repositoryMigrations);
      expect(applyPendingMigrations(sqlite, repositoryBundle)).toBe(repositoryMigrations.length);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get())
        .toEqual({ count: repositoryMigrations.length });
    } finally { sqlite.close(); }
  });

  it("rolls back schema and journal together when migration application fails", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    try {
      expect(() => applyPendingMigrations(sqlite, { migrations: [{
        folderMillis: 1,
        hash: "broken",
        sql: ["CREATE TABLE rolled_back (id text)", "INSERT INTO missing_table VALUES (1)"],
      }], folder: "fake", manifestDigest: "fake" })).toThrow(/validated loader/i);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='rolled_back'").get()).toBeUndefined();
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 0 });
    } finally { sqlite.close(); }
  });

  it("rejects a known migration gap before Drizzle can permanently skip it", () => {
    const sqlite = legacyVisualDatabase([
      validLegacyRows[0],
      validLegacyRows[2],
    ]);
    try {
      expect(() => prepareMigrationJournal(sqlite, repositoryMigrations))
        .toThrow(/contiguous repository prefix/i);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get())
        .toEqual({ count: 2 });
    } finally {
      sqlite.close();
    }
  });

  it("serializes two connection contenders and baselines exactly once", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-baseline-race-"));
    const filename = path.join(directory, "legacy.sqlite");
    const first = new Database(filename);
    for (const migration of repositoryMigrations.slice(0, 51)) {
      for (const statement of migration.sql) first.exec(statement);
    }
    first.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    const second = new Database(filename);
    first.pragma("busy_timeout = 5000");
    second.pragma("busy_timeout = 5000");
    try {
      prepareMigrationJournal(first, repositoryMigrations);
      prepareMigrationJournal(second, repositoryMigrations);
      expect(baselineJournalLessDatabase(first, repositoryMigrations)).toBe(51);
      expect(baselineJournalLessDatabase(second, repositoryMigrations)).toBe(0);
      expect(second.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get())
        .toEqual({ count: 51 });
      expect(second.prepare(`
        SELECT COUNT(*) count FROM (
          SELECT created_at FROM "__drizzle_migrations" GROUP BY created_at HAVING COUNT(*) > 1
        )
      `).get()).toEqual({ count: 0 });
    } finally {
      first.close();
      second.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes overlapping baseline attempts from two processes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-baseline-process-race-"));
    const filename = path.join(directory, "legacy.sqlite");
    const setup = new Database(filename);
    for (const migration of repositoryMigrations.slice(0, 51)) {
      for (const statement of migration.sql) setup.exec(statement);
    }
    setup.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    setup.close();

    const releaseFile = path.join(directory, "release");
    const scriptFor = (readyFile: string) => `
      const Database = require('better-sqlite3');
      const fs = require('node:fs');
      const { readMigrationFiles } = require('drizzle-orm/migrator');
      const { baselineJournalLessDatabase, prepareMigrationJournal, resolveMigrationsFolder } = require('./src/lib/db/index.ts');
      const sqlite = new Database(${JSON.stringify(filename)});
      sqlite.pragma('busy_timeout = 10000');
      const migrations = readMigrationFiles({ migrationsFolder: resolveMigrationsFolder() });
      prepareMigrationJournal(sqlite, migrations);
      fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
      while (!fs.existsSync(${JSON.stringify(releaseFile)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      const count = baselineJournalLessDatabase(sqlite, migrations);
      sqlite.close();
      process.stdout.write(String(count));
    `;
    const runContender = (readyFile: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "-e", scriptFor(readyFile)], {
        cwd: path.resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });

    try {
      const readyFiles = [path.join(directory, "ready-1"), path.join(directory, "ready-2")];
      const contenders = readyFiles.map(runContender);
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const poll = setInterval(() => {
          if (readyFiles.every((readyFile) => fs.existsSync(readyFile))) {
            clearInterval(poll);
            resolve();
          } else if (Date.now() > deadline) {
            clearInterval(poll);
            reject(new Error("Contenders did not reach the baseline barrier"));
          }
        }, 20);
      });
      fs.writeFileSync(releaseFile, "go");
      expect((await Promise.all(contenders)).sort()).toEqual(["0", "51"]);
      const verify = new Database(filename);
      try {
        expect(verify.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get())
          .toEqual({ count: 51 });
      } finally {
        verify.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("resolves repository migrations independently of the current working directory", () => {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-cwd-"));
    try {
      process.chdir(directory);
      expect(resolveMigrationsFolder()).toBe(path.resolve(originalCwd, "drizzle"));
      expect(fs.existsSync(path.join(resolveMigrationsFolder(), "meta", "_journal.json"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs real startup safely from six concurrent processes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-run-six-"));
    const filename = path.join(directory, "app.sqlite");
    const release = path.join(directory, "release");
    const migrationRoot = path.resolve("drizzle");
    const journalHash = computeMigrationsManifestDigest(migrationRoot);
    const run = (index: number) => new Promise<void>((resolve, reject) => {
      const ready = path.join(directory, `ready-${index}`);
      const script = `
        const fs=require('node:fs');
        fs.writeFileSync(${JSON.stringify(ready)},'ready');
        while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
        require('./src/lib/db/index.ts').runMigrations();
      `;
      const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "-e", script], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          DATABASE_URL: filename,
          AI_M_MIGRATIONS_DIR: migrationRoot,
          AI_M_MIGRATIONS_SHA256: journalHash,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      child.on("error", reject);
    });
    try {
      const runs = Array.from({ length: 6 }, (_, index) => run(index));
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline
        && !Array.from({ length: 6 }, (_, index) => fs.existsSync(path.join(directory, `ready-${index}`))).every(Boolean)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      fs.writeFileSync(release, "go");
      await Promise.all(runs);
      const sqlite = new Database(filename);
      try {
        expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get())
          .toEqual({ count: repositoryMigrations.length });
      } finally { sqlite.close(); }
    } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }, 30_000);

  it("resolves and validates an explicit migration root from an actual bundle", () => {
    const directory = fs.mkdtempSync(path.join(path.resolve("."), ".bundle-root-test-"));
    const outfile = path.join(directory, "db.cjs");
    const migrationRoot = path.resolve("drizzle");
    const journalHash = computeMigrationsManifestDigest(migrationRoot);
    try {
      buildSync({
        entryPoints: [path.resolve("src/lib/db/index.ts")],
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["better-sqlite3"],
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bundled = require(outfile) as { resolveMigrationsFolder: () => string };
      const previousDir = process.env.AI_M_MIGRATIONS_DIR;
      const previousHash = process.env.AI_M_MIGRATIONS_SHA256;
      const previousCwd = process.cwd();
      try {
        process.env.AI_M_MIGRATIONS_DIR = migrationRoot;
        process.env.AI_M_MIGRATIONS_SHA256 = journalHash;
        process.chdir(directory);
        expect(bundled.resolveMigrationsFolder()).toBe(migrationRoot);
      } finally {
        process.chdir(previousCwd);
        if (previousDir === undefined) delete process.env.AI_M_MIGRATIONS_DIR; else process.env.AI_M_MIGRATIONS_DIR = previousDir;
        if (previousHash === undefined) delete process.env.AI_M_MIGRATIONS_SHA256; else process.env.AI_M_MIGRATIONS_SHA256 = previousHash;
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("binds migration identity to ordered journal and every exact SQL byte", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-manifest-"));
    const copy = path.join(directory, "drizzle");
    fs.cpSync(path.resolve("drizzle"), copy, { recursive: true });
    const originalDigest = computeMigrationsManifestDigest(copy);
    const previousDir = process.env.AI_M_MIGRATIONS_DIR;
    const previousHash = process.env.AI_M_MIGRATIONS_SHA256;
    try {
      process.env.AI_M_MIGRATIONS_DIR = copy;
      process.env.AI_M_MIGRATIONS_SHA256 = originalDigest;
      expect(resolveMigrationsFolder()).toBe(copy);

      fs.appendFileSync(path.join(copy, "0059_pr13_review2_hardening.sql"), "\n-- changed byte");
      expect(computeMigrationsManifestDigest(copy)).not.toBe(originalDigest);
      expect(() => resolveMigrationsFolder()).toThrow(/identity/i);

      fs.rmSync(copy, { recursive: true, force: true });
      fs.cpSync(path.resolve("drizzle"), copy, { recursive: true });
      fs.writeFileSync(path.join(copy, "9999_extra.sql"), "SELECT 1");
      expect(() => resolveMigrationsFolder()).toThrow(/structure/i);

      fs.rmSync(path.join(copy, "9999_extra.sql"));
      fs.rmSync(path.join(copy, "0059_pr13_review2_hardening.sql"));
      expect(() => resolveMigrationsFolder()).toThrow();

      fs.rmSync(copy, { recursive: true, force: true });
      fs.cpSync(path.resolve("drizzle"), copy, { recursive: true });
      const journalPath = path.join(copy, "meta", "_journal.json");
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: unknown[] };
      [journal.entries[0], journal.entries[1]] = [journal.entries[1], journal.entries[0]];
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      expect(() => resolveMigrationsFolder()).toThrow(/identity|structure/i);
    } finally {
      if (previousDir === undefined) delete process.env.AI_M_MIGRATIONS_DIR; else process.env.AI_M_MIGRATIONS_DIR = previousDir;
      if (previousHash === undefined) delete process.env.AI_M_MIGRATIONS_SHA256; else process.env.AI_M_MIGRATIONS_SHA256 = previousHash;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("executes the frozen bytes that passed validation even if disk changes afterward", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-bundle-snapshot-"));
    const copy = path.join(directory, "drizzle");
    fs.cpSync(path.resolve("drizzle"), copy, { recursive: true });
    try {
      const bundle = loadValidatedMigrationBundle(copy);
      expect(Object.isFrozen(bundle)).toBe(true);
      expect(Object.isFrozen(bundle.migrations)).toBe(true);
      expect(Object.isFrozen(bundle.migrations[59])).toBe(true);
      expect(Object.isFrozen(bundle.migrations[59].sql)).toBe(true);

      fs.appendFileSync(path.join(copy, "0059_pr13_review2_hardening.sql"),
        "\n--> statement-breakpoint\nCREATE TABLE disk_mutation_was_executed (id integer);");
      const sqlite = new Database(":memory:");
      sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
      try {
        expect(applyPendingMigrations(sqlite, bundle)).toBe(bundle.migrations.length);
        expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='disk_mutation_was_executed'").get())
          .toBeUndefined();
      } finally { sqlite.close(); }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("upgrades a database recorded through published 0060 by applying additive 0061 and 0062", () => {
    const sqlite = databaseRecordedThroughPublished0060();
    try {
      expect(applyPendingMigrations(sqlite, repositoryBundle)).toBe(2);
      expect(sqlite.prepare<[], { count: number }>(
        'SELECT COUNT(*) AS count FROM "__drizzle_migrations"',
      ).get()).toEqual({ count: 63 });
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='resource_pool_slots_owner_attempt_unique'",
      ).get()).toBeDefined();
      expect(sqlite.prepare<[number], { hash: string }>(
        'SELECT hash FROM "__drizzle_migrations" WHERE created_at=?',
      ).get(OLD_0060_TIMESTAMP)).toEqual({ hash: OLD_0060_HASH });
    } finally { sqlite.close(); }
  });

  it("aborts 0061 before DDL or journal writes on duplicate owners and retries after repair", () => {
    const sqlite = databaseRecordedThroughPublished0060();
    try {
      sqlite.pragma("foreign_keys = OFF");
      sqlite.exec(`
        INSERT INTO resource_pool_slots
          (resource_pool_id, slot_no, owner_attempt_id, lease_token, fencing_token, expires_at_ms, updated_at_ms)
        VALUES
          ('legacy-pool-a', 1, 'legacy-attempt-duplicate', 'legacy-token-a', 7, 999999, 1),
          ('legacy-pool-b', 2, 'legacy-attempt-duplicate', 'legacy-token-b', 9, 999999, 1)
      `);

      expect(() => applyPendingMigrations(sqlite, repositoryBundle)).toThrow(
        /legacy-attempt-duplicate[\s\S]*legacy-pool-a[\s\S]*slot(?:_no)?=1[\s\S]*legacy-pool-b[\s\S]*slot(?:_no)?=2/i,
      );
      expect(sqlite.prepare(
        "SELECT resource_pool_id, slot_no, lease_token FROM resource_pool_slots ORDER BY resource_pool_id",
      ).all()).toEqual([
        { resource_pool_id: "legacy-pool-a", slot_no: 1, lease_token: "legacy-token-a" },
        { resource_pool_id: "legacy-pool-b", slot_no: 2, lease_token: "legacy-token-b" },
      ]);
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='resource_pool_slots_owner_attempt_unique'",
      ).get()).toBeUndefined();
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='resource_reconciliation_proofs'",
      ).get()).toBeDefined();
      expect(sqlite.prepare<[], { count: number }>(
        'SELECT COUNT(*) AS count FROM "__drizzle_migrations"',
      ).get()).toEqual({ count: 61 });
      expect(sqlite.prepare<[number], { hash: string }>(
        'SELECT hash FROM "__drizzle_migrations" WHERE created_at=?',
      ).get(OLD_0060_TIMESTAMP)).toEqual({ hash: OLD_0060_HASH });

      sqlite.prepare("DELETE FROM resource_pool_slots WHERE resource_pool_id=? AND slot_no=?")
        .run("legacy-pool-b", 2);
      expect(applyPendingMigrations(sqlite, repositoryBundle)).toBe(2);
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='resource_pool_slots_owner_attempt_unique'",
      ).get()).toBeDefined();
      expect(sqlite.prepare<[], { count: number }>(
        'SELECT COUNT(*) AS count FROM "__drizzle_migrations"',
      ).get()).toEqual({ count: 63 });
    } finally { sqlite.close(); }
  });

  it("upgrades a database recorded through published 0061 by applying only 0062", () => {
    const sqlite = databaseRecordedThroughPublished0061();
    try {
      expect(applyPendingMigrations(sqlite, repositoryBundle)).toBe(1);
      const columns = sqlite.prepare<[], { name: string }>("PRAGMA table_info('generation_artifacts')")
        .all().map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining([
        "writer_lease_owner", "writer_lease_token", "writer_lease_expires_at_ms",
        "recovery_lease_owner", "recovery_lease_token", "recovery_lease_expires_at_ms",
      ]));
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='generation_artifacts_lease_validate_update'",
      ).get()).toBeDefined();
    } finally { sqlite.close(); }
  });

  it("keeps concurrent worker connections waiting at 0061 and releases both after 0062", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-worker-journal-"));
    const databasePath = path.join(directory, "worker.sqlite");
    const writer = new Database(databasePath);
    const observerA = new Database(databasePath);
    const observerB = new Database(databasePath);
    try {
      writer.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
      const insert = writer.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)');
      for (const migration of repositoryBundle.migrations.slice(0, 62)) {
        for (const statement of migration.sql ?? []) writer.exec(statement);
        insert.run(migration.hash, migration.folderMillis);
      }
      let released = 0;
      const waits = [observerA, observerB].map((sqlite) => waitForCurrentMigrationBundle({
        sqlite, bundle: repositoryBundle, timeoutMs: 2_000, pollIntervalMs: 10,
      }).then(() => { released++; }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(released).toBe(0);
      const migration0062 = repositoryBundle.migrations[62];
      writer.transaction(() => {
        for (const statement of migration0062.sql ?? []) writer.exec(statement);
        insert.run(migration0062.hash, migration0062.folderMillis);
      })();
      await Promise.all(waits);
      expect(released).toBe(2);
    } finally {
      observerA.close(); observerB.close(); writer.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("installs a partial unique owner index used by resource-slot owner lookups", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    try {
      applyPendingMigrations(sqlite, repositoryBundle);
      const ownerIndex = sqlite.prepare<[], { name: string; unique: number; partial: number }>(
        'PRAGMA index_list("resource_pool_slots")',
      ).all().find((candidate) => candidate.name === "resource_pool_slots_owner_attempt_unique");
      expect(ownerIndex).toMatchObject({ unique: 1, partial: 1 });
      expect(sqlite.prepare<[], { name: string; key: number }>(
        'PRAGMA index_xinfo("resource_pool_slots_owner_attempt_unique")',
      ).all().filter((column) => column.key === 1).map((column) => column.name)).toEqual(["owner_attempt_id"]);
      const plan = sqlite.prepare<[], { detail: string }>(
        "EXPLAIN QUERY PLAN SELECT slot_no FROM resource_pool_slots WHERE owner_attempt_id='attempt-index-probe'",
      ).all().map((row) => row.detail).join(" ");
      expect(plan).toMatch(/resource_pool_slots_owner_attempt_unique/i);
    } finally { sqlite.close(); }
  });

  it.each(["COMMIT", "ROLLBACK", "BEGIN", "SAVEPOINT x", "RELEASE x", "END", "ATTACH ':memory:' AS x", "DETACH x", "VACUUM", "PRAGMA journal_mode=DELETE"])(
    "rejects top-level migration connection control: %s",
    (dangerous) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-dangerous-migration-"));
      const copy = path.join(directory, "drizzle");
      fs.cpSync(path.resolve("drizzle"), copy, { recursive: true });
      fs.appendFileSync(path.join(copy, "0059_pr13_review2_hardening.sql"),
        `\n--> statement-breakpoint\nCREATE TABLE escaped_before (id integer); ${dangerous}; CREATE TABLE escaped_after (id integer);`);
      try { expect(() => loadValidatedMigrationBundle(copy)).toThrow(/unsupported|transaction|connection/i); }
      finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  );
});
