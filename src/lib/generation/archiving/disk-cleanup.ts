/** Safe artifact storage cleanup. Committed business artifacts are never expired implicitly. */
import { lstat, readdir, statfs, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { generationArtifacts } from "@/lib/db/schema";
import { and, eq, inArray, lt } from "drizzle-orm";

export interface CleanupConfig {
  diskUsageThreshold: number;
  maxRetentionDays: number;
  batchSize: number;
  cleanupIntervalMs: number;
  orphanGraceMs: number;
}

export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  diskUsageThreshold: 0.85,
  maxRetentionDays: 30,
  batchSize: 100,
  cleanupIntervalMs: 60 * 60 * 1000,
  orphanGraceMs: 24 * 60 * 60 * 1000,
};

export interface CleanupStats { scannedFiles: number; deletedFiles: number; freedBytes: number; durationMs: number }

function validateRoot(root: string): string {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) throw new Error("Artifact cleanup root cannot be a filesystem root");
  return resolved;
}

function resolveWithin(root: string, storageKey: string): string {
  if (!storageKey || path.isAbsolute(storageKey) || storageKey.includes("\0")) throw new Error("Invalid storage key");
  const normalized = storageKey.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) throw new Error("Invalid storage key");
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Storage key escapes cleanup root");
  return resolved;
}

function validateConfig(config: Partial<CleanupConfig>): CleanupConfig {
  const cfg = { ...DEFAULT_CLEANUP_CONFIG, ...config };
  if (!(cfg.diskUsageThreshold > 0 && cfg.diskUsageThreshold <= 1)) throw new Error("diskUsageThreshold must be in (0,1]");
  if (!Number.isInteger(cfg.maxRetentionDays) || cfg.maxRetentionDays < 1) throw new Error("maxRetentionDays must be a positive integer");
  if (!Number.isInteger(cfg.batchSize) || cfg.batchSize < 1 || cfg.batchSize > 10_000) throw new Error("batchSize is invalid");
  if (!Number.isSafeInteger(cfg.orphanGraceMs) || cfg.orphanGraceMs < 60_000) throw new Error("orphanGraceMs is too small");
  return cfg;
}

export async function cleanupExpiredArtifacts(artifactsRoot: string, config: Partial<CleanupConfig> = {}): Promise<CleanupStats> {
  const cfg = validateConfig(config);
  const root = validateRoot(artifactsRoot);
  const started = Date.now();
  const result: CleanupStats = { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, durationMs: 0 };
  // Only already-deleted or quarantined records are physical-cleanup candidates.
  // COMMITTED media is a project fact and requires an explicit product deletion flow.
  const cutoff = Date.now() - cfg.maxRetentionDays * 86_400_000;
  const candidates = await db.select({ id: generationArtifacts.id, storageKey: generationArtifacts.storageKey })
    .from(generationArtifacts)
    .where(and(inArray(generationArtifacts.status, ["DELETED", "QUARANTINED"]), lt(generationArtifacts.updatedAtMs, cutoff)))
    .limit(cfg.batchSize);
  result.scannedFiles = candidates.length;
  for (const artifact of candidates) {
    try {
      const file = resolveWithin(root, artifact.storageKey);
      const info = await lstat(file).catch(() => null);
      if (info?.isSymbolicLink()) throw new Error("Refusing to delete a symbolic-link artifact");
      if (info?.isFile()) {
        await unlink(file);
        result.deletedFiles++;
        result.freedBytes += info.size;
      }
      await db.update(generationArtifacts).set({ status: "DELETED", updatedAtMs: Date.now() }).where(eq(generationArtifacts.id, artifact.id));
    } catch (error) {
      console.warn(`[artifact-cleanup] failed for ${artifact.id}:`, error instanceof Error ? error.message : "unknown error");
    }
  }
  await cleanupEmptyDirectories(root, root);
  result.durationMs = Date.now() - started;
  return result;
}

export async function cleanupOrphanedArtifacts(artifactsRoot: string, config: Partial<CleanupConfig> = {}): Promise<CleanupStats> {
  const cfg = validateConfig(config);
  const root = validateRoot(artifactsRoot);
  const started = Date.now();
  const result: CleanupStats = { scannedFiles: 0, deletedFiles: 0, freedBytes: 0, durationMs: 0 };
  const files = await scanDirectory(root);
  result.scannedFiles = files.length;
  const cutoff = Date.now() - cfg.orphanGraceMs;
  for (const file of files) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    if (!relative || relative.startsWith("../") || relative.startsWith(".staging/")) continue;
    const info = await lstat(file).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile() || info.mtimeMs > cutoff) continue;
    const [artifact] = await db.select({ id: generationArtifacts.id }).from(generationArtifacts)
      .where(eq(generationArtifacts.storageKey, relative)).limit(1);
    if (artifact) continue;
    try {
      await unlink(file);
      result.deletedFiles++;
      result.freedBytes += info.size;
    } catch (error) {
      console.warn(`[artifact-cleanup] orphan delete failed:`, error instanceof Error ? error.message : "unknown error");
    }
  }
  await cleanupEmptyDirectories(root, root);
  result.durationMs = Date.now() - started;
  return result;
}

async function scanDirectory(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await scanDirectory(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function cleanupEmptyDirectories(root: string, dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) await cleanupEmptyDirectories(root, path.join(dir, entry.name));
  if (dir !== root) {
    const remaining = await readdir(dir).catch(() => ["unreadable"]);
    if (remaining.length === 0) await rmdir(dir).catch(() => undefined);
  }
}

export async function checkDiskUsage(targetPath: string): Promise<number | null> {
  try {
    const info = await statfs(validateRoot(targetPath));
    const total = Number(info.blocks) * Number(info.bsize);
    const available = Number(info.bavail) * Number(info.bsize);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available)) return null;
    return Math.max(0, Math.min(1, 1 - available / total));
  } catch (error) {
    console.warn("[artifact-cleanup] disk usage unavailable:", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

export function startPeriodicCleanup(artifactsRoot: string, config: Partial<CleanupConfig> = {}): ReturnType<typeof setInterval> {
  const cfg = validateConfig(config);
  let running = false;
  const task = async () => {
    if (running) return;
    running = true;
    try {
      const usage = await checkDiskUsage(artifactsRoot);
      if (usage !== null && usage < cfg.diskUsageThreshold) return;
      await cleanupExpiredArtifacts(artifactsRoot, cfg);
      await cleanupOrphanedArtifacts(artifactsRoot, cfg);
    } finally {
      running = false;
    }
  };
  void task();
  return setInterval(() => void task(), cfg.cleanupIntervalMs);
}
