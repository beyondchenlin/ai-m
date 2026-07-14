import { describe, expect, it } from "vitest";
import type { execFileSync } from "node:child_process";
import { createBackupFileSecurityPolicy } from "../backup-file-security";

describe("backup file security policy", () => {
  it("passes an untrusted Windows path through stdin rather than command arguments", () => {
    const filename = String.raw`C:\directory with spaces\backup ; Write-Output injected.sqlite`;
    let executable = "";
    let args: readonly string[] = [];
    let input = "";
    const run = ((file: string, values: readonly string[], options: { input?: string }) => {
      executable = file;
      args = values;
      input = String(options.input);
      return JSON.stringify({ ok: true, sid: "S-1-5-21-1", owner: "S-1-5-21-1", ruleCount: 1 });
    }) as unknown as typeof execFileSync;
    createBackupFileSecurityPolicy({ platform: "win32", run }).protect(filename);
    expect(executable).toBe("powershell.exe");
    expect(args).not.toContain(filename);
    expect(JSON.parse(input)).toEqual({ action: "protect", path: filename });
  });

  it("rejects missing or unverifiable Windows ACL tooling", () => {
    const missing = (() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }) as typeof execFileSync;
    expect(() => createBackupFileSecurityPolicy({ platform: "win32", run: missing }).protect("backup.sqlite"))
      .toThrow(/missing/);
    const invalid = (() => "not-json") as unknown as typeof execFileSync;
    expect(() => createBackupFileSecurityPolicy({ platform: "win32", run: invalid }).verify("backup.sqlite"))
      .toThrow(/invalid output/i);
  });

  it("applies and verifies exact 0600 mode on non-Windows platforms", () => {
    let mode = 0o644;
    const policy = createBackupFileSecurityPolicy({
      platform: "linux",
      chmod: (_filename, nextMode) => { mode = Number(nextMode); },
      stat: () => ({ mode }),
    });
    policy.protect("backup.sqlite");
    expect(mode).toBe(0o600);
    mode = 0o640;
    expect(() => policy.verify("backup.sqlite")).toThrow(/0600/);
  });
});
