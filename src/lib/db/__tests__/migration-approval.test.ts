import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approveBaseline, inspectBaselineApproval } from "../migration-baseline-approval";

describe("audited manual baseline approval", () => {
  const migrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });

  it("binds approval to database identity, exact prefix, evidence, and a completed backup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-approval-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    const backupPath = path.join(directory, "legacy.backup.sqlite");
    const sqlite = new Database(databasePath);
    for (const migration of migrations.slice(0, 54)) for (const statement of migration.sql) sqlite.exec(statement);
    sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    try {
      const manifest = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
      expect(manifest.prefixDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
      await expect(approveBaseline(
        sqlite, databasePath, migrations, 54, "wrong-token", backupPath,
      )).rejects.toThrow(/approval token/i);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 0 });
      await approveBaseline(sqlite, databasePath, migrations, 54, manifest.approvalToken, backupPath);
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 54 });
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
