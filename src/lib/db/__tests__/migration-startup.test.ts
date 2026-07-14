import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
} from "../migration-journal";
import {
  baselineJournalLessDatabase,
  prepareMigrationJournal,
  resolveMigrationsFolder,
} from "../index";

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
    for (const migration of repositoryMigrations.slice(0, 54)) {
      for (const statement of migration.sql) first.exec(statement);
    }
    first.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    const second = new Database(filename);
    first.pragma("busy_timeout = 5000");
    second.pragma("busy_timeout = 5000");
    try {
      prepareMigrationJournal(first, repositoryMigrations);
      prepareMigrationJournal(second, repositoryMigrations);
      expect(baselineJournalLessDatabase(first, repositoryMigrations)).toBe(54);
      expect(baselineJournalLessDatabase(second, repositoryMigrations)).toBe(0);
      expect(second.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get())
        .toEqual({ count: 54 });
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
    for (const migration of repositoryMigrations.slice(0, 54)) {
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
      expect((await Promise.all(contenders)).sort()).toEqual(["0", "54"]);
      const verify = new Database(filename);
      try {
        expect(verify.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get())
          .toEqual({ count: 54 });
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
});
