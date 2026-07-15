import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_EPOCH_OFFSET_MS = BigInt("11644473600000");
const FILETIME_TICKS_PER_MS = BigInt(10_000);

export type PixelleProcessIdentity = string | "missing" | "unknown";
export type PixelleProcessLiveness = boolean | "unknown";

/** Canonical identity shared by prepare, GC and Task 4 locks. */
export async function getPixelleProcessIdentity(pid: number): Promise<PixelleProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  if (process.platform === "win32") {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue;if(-not $p){[Console]::Out.Write('missing');exit};$o=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop;[Console]::Out.Write('win:'+([DateTimeOffset]$o.LastBootUpTime).UtcDateTime.ToFileTimeUtc().ToString()+':'+([DateTimeOffset]$p.CreationDate).UtcDateTime.ToFileTimeUtc().ToString())`;
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 });
      const value = stdout.trim();
      return value === "missing" ? "missing" : normalizePixelleProcessIdentity(value, pid) ?? "unknown";
    } catch { return "unknown"; }
  }
  try {
    const [bootId, stat] = await Promise.all([fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"), fs.readFile(`/proc/${pid}/stat`, "utf8")]);
    const close = stat.lastIndexOf(")"); const fields = stat.slice(close + 2).split(" "); const startTicks = fields[19]; const boot = bootId.trim().toLowerCase();
    if (!/^[a-f0-9-]{8,64}$/.test(boot) || !/^\d+$/.test(startTicks)) return "unknown";
    return `linux:${boot}:${startTicks}`;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown"; }
}

export async function getPixelleProcessLiveness(pid: number): Promise<PixelleProcessLiveness> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : "unknown"; }
}

/**
 * Schema 2 originally had two Windows encodings. Preserve both: prepare's
 * FileTime encoding is canonical; Task 4's legacy epoch-ms encoding is
 * losslessly migrated for comparison. Unknown schema-2 encodings return null
 * so a live stale lock fails closed instead of being stolen.
 */
export function normalizePixelleProcessIdentity(identity: string, pid: number): string | null {
  if (/^win:\d{15,20}:\d{15,20}$/.test(identity) || /^linux:[a-f0-9-]{8,64}:\d+$/.test(identity)) return identity.toLowerCase();
  const legacyWindows = /^windows-(\d{10,16}):(\d+):(\d{10,16})$/.exec(identity);
  if (!legacyWindows || Number(legacyWindows[2]) !== pid) return null;
  try {
    const boot = (BigInt(legacyWindows[1]) + WINDOWS_EPOCH_OFFSET_MS) * FILETIME_TICKS_PER_MS;
    const created = (BigInt(legacyWindows[3]) + WINDOWS_EPOCH_OFFSET_MS) * FILETIME_TICKS_PER_MS;
    return `win:${boot}:${created}`;
  } catch { return null; }
}

export function comparePixelleProcessIdentity(stored: string, observed: string, pid: number): boolean | "unknown" {
  const left = normalizePixelleProcessIdentity(stored, pid); const right = normalizePixelleProcessIdentity(observed, pid);
  return left && right ? left === right : "unknown";
}
