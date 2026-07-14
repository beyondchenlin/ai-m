import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
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
} from "../index";

describe("migration journal startup ordering", () => {
  const repositoryMigrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });
  const repositoryBundle = loadValidatedMigrationBundle(path.resolve("drizzle"));

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
      expect(applyPendingMigrations(sqlite, repositoryBundle)).toBe(60);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 60 });
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
        expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 60 });
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
        expect(applyPendingMigrations(sqlite, bundle)).toBe(60);
        expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='disk_mutation_was_executed'").get())
          .toBeUndefined();
      } finally { sqlite.close(); }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
