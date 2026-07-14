import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { approveBaseline, inspectBaselineApproval } from "../migration-baseline-approval";

describe("audited manual baseline approval", () => {
  const migrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });

  it("binds approval to database identity, exact prefix, evidence, and a completed backup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-approval-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    const backupPath = path.join(directory, "legacy.backup.sqlite");
    const rejectedBackupPath = path.join(directory, "rejected.backup.sqlite");
    const sqlite = new Database(databasePath);
    for (const migration of migrations.slice(0, 54)) for (const statement of migration.sql) sqlite.exec(statement);
    sqlite.exec(`
      CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
      CREATE TABLE approval_values (id integer, text_value text, nullable, blob_value blob, real_value real);
      INSERT INTO approval_values VALUES (1, 'AAAA', NULL, X'00FF', 1.25);
      INSERT INTO approval_values VALUES (3, '', '汉字🙂', X'', -0.5);
    `);
    try {
      const manifest = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
      expect(manifest.prefixDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.dataDigest).toMatch(/^[0-9a-f]{64}$/);
      sqlite.exec("UPDATE approval_values SET text_value='BBBB' WHERE id=1");
      const updated = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
      expect(updated.dataDigest).not.toBe(manifest.dataDigest);
      await expect(approveBaseline(
        sqlite, databasePath, migrations, 54, manifest.approvalToken, rejectedBackupPath,
      )).rejects.toThrow(/approval token/i);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 0 });
      await expect(approveBaseline(
        sqlite, databasePath, migrations, 54, updated.approvalToken, rejectedBackupPath,
      )).rejects.toThrow(/overwrite/i);
      sqlite.exec("INSERT INTO approval_values VALUES (2, 'CCCC', 'not-null', X'01', 2.5)");
      const inserted = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
      expect(inserted.dataDigest).not.toBe(updated.dataDigest);
      sqlite.exec("DELETE FROM approval_values WHERE id=2");
      const restoredRows = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
      expect(restoredRows.dataDigest).toBe(updated.dataDigest);
      await approveBaseline(sqlite, databasePath, migrations, 54, restoredRows.approvalToken, backupPath);
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(fs.readdirSync(directory).filter((name) => name.includes(".backup-tmp-"))).toEqual([]);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 54 });
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("rejects a change made after backup but before the live lock", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-approval-race-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    const backupPath = path.join(directory, "legacy.backup.sqlite");
    const sqlite = new Database(databasePath);
    for (const migration of migrations.slice(0, 54)) for (const statement of migration.sql) sqlite.exec(statement);
    sqlite.exec(`CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
      CREATE TABLE approval_values (value text); INSERT INTO approval_values VALUES ('A' || char(0) || 'B');`);
    try {
      const manifest = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
      await expect(approveBaseline(sqlite, databasePath, migrations, 54, manifest.approvalToken, backupPath, {
        afterBackup: () => sqlite.exec("UPDATE approval_values SET value='A' || char(0) || 'C'"),
      })).rejects.toThrow(/approval token|backup evidence/i);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 0 });
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(backup.prepare("SELECT hex(CAST(value AS BLOB)) value FROM approval_values").get())
          .toEqual({ value: "410042" });
      } finally { backup.close(); }
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("publishes with no-replace semantics when a destination appears after backup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-approval-publish-race-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    const backupPath = path.join(directory, "legacy.backup.sqlite");
    const marker = Buffer.from("do-not-overwrite");
    let markerStat: fs.Stats | undefined;
    const sqlite = new Database(databasePath);
    for (const migration of migrations.slice(0, 54)) for (const statement of migration.sql) sqlite.exec(statement);
    sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    try {
      const manifest = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
      await expect(approveBaseline(sqlite, databasePath, migrations, 54, manifest.approvalToken, backupPath, {
        beforeBackupPublish: () => {
          fs.writeFileSync(backupPath, marker, { flag: "wx" });
          markerStat = fs.statSync(backupPath);
        },
      })).rejects.toThrow();
      expect(fs.readFileSync(backupPath)).toEqual(marker);
      const after = fs.statSync(backupPath);
      expect({ size: after.size, mode: after.mode, mtimeMs: after.mtimeMs, birthtimeMs: after.birthtimeMs })
        .toEqual({ size: markerStat?.size, mode: markerStat?.mode,
          mtimeMs: markerStat?.mtimeMs, birthtimeMs: markerStat?.birthtimeMs });
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 0 });
      expect(fs.readdirSync(directory).filter((name) => name.includes(".backup-tmp-"))).toEqual([]);
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("removes an unpublished temporary backup when publication is interrupted", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-approval-publish-crash-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    const backupPath = path.join(directory, "legacy.backup.sqlite");
    const sqlite = new Database(databasePath);
    for (const migration of migrations.slice(0, 54)) for (const statement of migration.sql) sqlite.exec(statement);
    sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    try {
      const manifest = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
      await expect(approveBaseline(sqlite, databasePath, migrations, 54, manifest.approvalToken, backupPath, {
        beforeBackupPublish: () => { throw new Error("simulated interruption"); },
      })).rejects.toThrow(/interruption/);
      expect(fs.existsSync(backupPath)).toBe(false);
      expect(fs.readdirSync(directory).filter((name) => name.includes(".backup-tmp-"))).toEqual([]);
      expect(sqlite.prepare('SELECT COUNT(*) count FROM "__drizzle_migrations"').get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("fails closed and removes the empty temp before backup when file security cannot be applied", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-approval-security-fail-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    const backupPath = path.join(directory, "legacy.backup.sqlite");
    const sqlite = new Database(databasePath);
    for (const migration of migrations.slice(0, 54)) for (const statement of migration.sql) sqlite.exec(statement);
    sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    const backup = vi.spyOn(sqlite, "backup");
    try {
      const manifest = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
      await expect(approveBaseline(sqlite, databasePath, migrations, 54, manifest.approvalToken, backupPath, {
        securityPolicy: {
          protect: () => { throw new Error("ACL unavailable"); },
          verify: () => { throw new Error("must not verify"); },
        },
      })).rejects.toThrow(/ACL unavailable/);
      expect(backup).not.toHaveBeenCalled();
      expect(fs.existsSync(backupPath)).toBe(false);
      expect(fs.readdirSync(directory).filter((name) => name.includes(".backup-tmp-"))).toEqual([]);
    } finally {
      backup.mockRestore();
      sqlite.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "creates a Windows backup with protected current-SID-only ACL before handling a metacharacter path",
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m approval loose acl "));
      const databasePath = path.join(directory, "legacy.sqlite");
      const backupPath = path.join(directory, "backup ; Write-Output injected.sqlite");
      const loosenDirectory = String.raw`
        $payload = $input | ConvertFrom-Json
        $acl = Get-Acl -LiteralPath $payload.path
        $everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
          $everyone, [System.Security.AccessControl.FileSystemRights]::FullControl,
          [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
          [System.Security.AccessControl.PropagationFlags]::None,
          [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $payload.path -AclObject $acl
      `;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", loosenDirectory], {
        input: JSON.stringify({ path: directory }), windowsHide: true,
      });
      const sqlite = new Database(databasePath);
      for (const migration of migrations.slice(0, 54)) for (const statement of migration.sql) sqlite.exec(statement);
      sqlite.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)');
      try {
        const manifest = inspectBaselineApproval(sqlite, databasePath, migrations, 54);
        await approveBaseline(sqlite, databasePath, migrations, 54, manifest.approvalToken, backupPath);
        const script = String.raw`
          $payload = $input | ConvertFrom-Json
          $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
          $acl = Get-Acl -LiteralPath $payload.path
          $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
            [pscustomobject]@{ sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString() }
          })
          [pscustomobject]@{ sid=$sid; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected; rules=$rules } | ConvertTo-Json -Compress -Depth 4
        `;
        const acl = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          input: JSON.stringify({ path: backupPath }), encoding: "utf8", windowsHide: true,
        })) as { sid: string; owner: string; protected: boolean; rules: Array<{ sid: string; inherited: boolean; type: string }> };
        expect(acl.owner).toBe(acl.sid);
        expect(acl.protected).toBe(true);
        expect(acl.rules.length).toBeGreaterThan(0);
        expect(acl.rules.every((rule) => rule.sid === acl.sid && !rule.inherited && rule.type === "Allow")).toBe(true);
      } finally {
        sqlite.close();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );

  it("hashes no-PK duplicates and large typed data deterministically without row materialization", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-m-stream-digest-"));
    const create = (filename: string, reverse: boolean) => {
      const sqlite = new Database(filename);
      for (const migration of migrations.slice(0, 54)) for (const statement of migration.sql) sqlite.exec(statement);
      sqlite.exec(`CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
        CREATE TABLE stream_values (kind, value);`);
      const rows: Array<[unknown, unknown]> = [
        ["text", ""], ["text", "汉字🙂"], ["text", "A\0B"], ["null", null],
        ["blob", Buffer.from([0, 255])], ["blob", Buffer.alloc(0)], ["real", 1.25], ["integer", 42],
        ["duplicate", "same"], ["duplicate", "same"],
      ];
      const insert = sqlite.prepare("INSERT INTO stream_values VALUES (?, ?)");
      for (const row of reverse ? [...rows].reverse() : rows) insert.run(...row);
      sqlite.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2000)
        INSERT INTO stream_values SELECT 'large', zeroblob(2048) FROM n;`);
      return sqlite;
    };
    const firstPath = path.join(directory, "first.sqlite");
    const secondPath = path.join(directory, "second.sqlite");
    const first = create(firstPath, false);
    const second = create(secondPath, true);
    try {
      const firstManifest = inspectBaselineApproval(first, firstPath, migrations, 54);
      const secondManifest = inspectBaselineApproval(second, secondPath, migrations, 54);
      expect(firstManifest.dataDigest).toBe(secondManifest.dataDigest);
    } finally {
      first.close(); second.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
