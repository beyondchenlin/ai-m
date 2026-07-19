import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, lt, lte } from "drizzle-orm";
import { db, getSqlite } from "@/lib/db";
import {
  generationJobSourceAssets,
  generationJobs,
  jobInputArtifacts,
  sourceAssetQuotaReservations,
  sourceMediaAssets,
  voiceProfiles,
} from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { detectMimeType } from "./archiving/content-detection";
import { probeAudioMetadata } from "./media-probe";

export const MAX_VOICE_REFERENCE_BYTES = 50 * 1024 * 1024;
const SOURCE_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const QUOTA_RESERVATION_TTL_MS = 5 * 60 * 1000;

const verifiedFileCache = new Map<string, {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  sha256: string;
}>();
const VERIFIED_CACHE_LIMIT = 512;

function rememberVerifiedFile(pathname: string, value: { size: number; mtimeMs: number; ctimeMs: number; ino: number; sha256: string }): void {
  verifiedFileCache.delete(pathname);
  verifiedFileCache.set(pathname, value);
  while (verifiedFileCache.size > VERIFIED_CACHE_LIMIT) {
    const oldest = verifiedFileCache.keys().next().value as string | undefined;
    if (!oldest) break;
    verifiedFileCache.delete(oldest);
  }
}

const MIME_EXTENSION: Record<string, string> = {
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};

export class SourceAssetError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 404 | 409 | 410 | 413 | 500 | 507 = 400,
  ) {
    super(message);
    this.name = "SourceAssetError";
  }
}

export interface SourceMediaAssetView {
  id: string;
  projectId: string;
  kind: "audio";
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  durationMs: number | null;
  url: string;
  createdAtMs: number;
}

interface VoiceReferenceStreamInput {
  projectId: string;
  userId: string;
  stream: ReadableStream<Uint8Array>;
  originalName: string;
  declaredSize?: number;
  signal?: AbortSignal;
}

function root(): string {
  return path.resolve(process.env.UPLOAD_DIR || "./uploads", "source-assets");
}

function storagePath(storageKey: string): string {
  if (!/^[A-Za-z0-9._/-]{1,500}$/.test(storageKey) || storageKey.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new SourceAssetError("Invalid source asset storage key", "INVALID_STORAGE_KEY", 500);
  }
  const resolved = path.resolve(root(), ...storageKey.split("/"));
  if (!resolved.startsWith(`${root()}${path.sep}`)) {
    throw new SourceAssetError("Source asset path escapes storage root", "STORAGE_PATH_ESCAPE", 500);
  }
  return resolved;
}


function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function projectQuotaBytes(): number {
  return positiveIntegerEnv("AI_M_SOURCE_ASSET_PROJECT_QUOTA_BYTES", 1024 * 1024 * 1024);
}

function minimumFreeBytes(): number {
  return positiveIntegerEnv("AI_M_SOURCE_ASSET_MIN_FREE_BYTES", 512 * 1024 * 1024);
}

async function assertStorageCapacity(requiredBytes: number): Promise<void> {
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  const stats = await fs.statfs(root());
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(available) || available < requiredBytes + minimumFreeBytes()) {
    throw new SourceAssetError("Insufficient storage capacity for reference audio", "SOURCE_STORAGE_EXHAUSTED", 507);
  }
}

function safeOriginalName(value: string): string {
  const normalized = value.replace(/[\/\\\0\r\n]/g, "_").trim().slice(0, 240);
  return normalized || "voice-reference";
}

async function writeStreamBounded(
  stream: ReadableStream<Uint8Array>,
  destination: string,
  maxBytes: number,
  signal?: AbortSignal,
  readTimeoutMs = 30_000,
  totalTimeoutMs = 5 * 60_000,
  onProgress?: () => void,
): Promise<{ sizeBytes: number; sha256: string; header: Uint8Array }> {
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1_000 || readTimeoutMs > 120_000) {
    throw new SourceAssetError("Invalid source upload read timeout", "UPLOAD_TIMEOUT_INVALID", 500);
  }
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < readTimeoutMs || totalTimeoutMs > 30 * 60_000) {
    throw new SourceAssetError("Invalid source upload total timeout", "UPLOAD_TIMEOUT_INVALID", 500);
  }
  const reader = stream.getReader();
  const handle = await fs.open(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let header = new Uint8Array(0);
  const deadline = Date.now() + totalTimeoutMs;
  try {
    while (true) {
      if (signal?.aborted) throw new SourceAssetError("Reference audio upload was aborted", "UPLOAD_ABORTED", 400);
      if (Date.now() >= deadline) throw new SourceAssetError("Reference audio upload timed out", "UPLOAD_TIMEOUT", 400);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(
            new SourceAssetError("Reference audio upload stalled", "UPLOAD_STALLED", 400),
          ), Math.min(readTimeoutMs, Math.max(1, deadline - Date.now())));
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (done) break;
      sizeBytes += value.byteLength;
      onProgress?.();
      if (sizeBytes > maxBytes) {
        throw new SourceAssetError(`Reference audio exceeds ${maxBytes} bytes`, "SOURCE_TOO_LARGE", 413);
      }
      if (header.length < 64) {
        const combined = new Uint8Array(Math.min(64, header.length + value.length));
        combined.set(header);
        combined.set(value.subarray(0, combined.length - header.length), header.length);
        header = combined;
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        if (bytesWritten <= 0) throw new SourceAssetError("Reference audio write made no progress", "WRITE_STALLED", 500);
        offset += bytesWritten;
      }
    }
    if (sizeBytes <= 0) throw new SourceAssetError("Reference audio is empty", "SOURCE_EMPTY");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  await handle.close();
  return { sizeBytes, sha256: hash.digest("hex"), header };
}

export function reserveSourceAssetQuota(projectId: string, userId: string, reservedBytes: number): {
  id: string;
  token: string;
} {
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes <= 0) {
    throw new SourceAssetError("Invalid source-audio quota reservation", "INVALID_QUOTA_RESERVATION", 500);
  }
  const sqlite = getSqlite();
  const id = genId();
  const token = genId();
  sqlite.transaction(() => {
    const now = Date.now();
    sqlite.prepare(
      "UPDATE source_asset_quota_reservations SET status='RELEASED', updated_at_ms=? WHERE status='RESERVED' AND expires_at_ms<=?",
    ).run(now, now);
    const committed = sqlite.prepare<
      [string],
      { total_bytes: number }
    >("SELECT coalesce(sum(size_bytes), 0) AS total_bytes FROM source_media_assets WHERE project_id=? AND status IN ('STAGING','COMMITTED')")
      .get(projectId)?.total_bytes ?? 0;
    const reserved = sqlite.prepare<
      [string, number],
      { total_bytes: number }
    >("SELECT coalesce(sum(reserved_bytes), 0) AS total_bytes FROM source_asset_quota_reservations WHERE project_id=? AND status='RESERVED' AND expires_at_ms>?")
      .get(projectId, now)?.total_bytes ?? 0;
    if (!Number.isSafeInteger(committed) || !Number.isSafeInteger(reserved)
      || committed + reserved + reservedBytes > projectQuotaBytes()) {
      throw new SourceAssetError("Project source-audio quota exceeded", "SOURCE_PROJECT_QUOTA_EXCEEDED", 413);
    }
    sqlite.prepare(
      "INSERT INTO source_asset_quota_reservations (id, project_id, user_id, upload_token, reserved_bytes, status, expires_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?)",
    ).run(id, projectId, userId, token, reservedBytes, now + QUOTA_RESERVATION_TTL_MS, now, now);
  }).immediate();
  return { id, token };
}

export function renewSourceAssetQuotaReservation(id: string, token: string): void {
  const now = Date.now();
  getSqlite().prepare(
    "UPDATE source_asset_quota_reservations SET expires_at_ms=?, updated_at_ms=? WHERE id=? AND upload_token=? AND status='RESERVED'",
  ).run(now + QUOTA_RESERVATION_TTL_MS, now, id, token);
}

export function releaseSourceAssetQuotaReservation(id: string, token: string): void {
  getSqlite().prepare(
    "UPDATE source_asset_quota_reservations SET status='RELEASED', updated_at_ms=? WHERE id=? AND upload_token=? AND status='RESERVED'",
  ).run(Date.now(), id, token);
}

async function verifyRegularFile(
  absolutePath: string,
  expected: { sizeBytes: number; sha256: string },
): Promise<void> {
  const info = await fs.lstat(absolutePath);
  if (info.isSymbolicLink() || !info.isFile() || info.size !== expected.sizeBytes) {
    verifiedFileCache.delete(absolutePath);
    throw new SourceAssetError("Source asset file failed structural verification", "SOURCE_STRUCTURE_INVALID", 410);
  }
  const cached = verifiedFileCache.get(absolutePath);
  if (cached
    && cached.size === info.size
    && cached.mtimeMs === info.mtimeMs
    && cached.ctimeMs === info.ctimeMs
    && cached.ino === info.ino
    && cached.sha256 === expected.sha256) {
    return;
  }
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(absolutePath)) {
    const bytes = chunk as Buffer;
    sizeBytes += bytes.byteLength;
    if (sizeBytes > expected.sizeBytes) throw new SourceAssetError("Source asset changed while being verified", "SOURCE_MUTATED", 410);
    hash.update(bytes);
  }
  const digest = hash.digest("hex");
  const after = await fs.lstat(absolutePath);
  if (after.isSymbolicLink() || !after.isFile()
    || after.size !== info.size
    || after.mtimeMs !== info.mtimeMs
    || after.ctimeMs !== info.ctimeMs
    || after.ino !== info.ino
    || sizeBytes !== expected.sizeBytes
    || digest !== expected.sha256) {
    verifiedFileCache.delete(absolutePath);
    throw new SourceAssetError("Source asset integrity verification failed", "SOURCE_INTEGRITY_FAILED", 410);
  }
  rememberVerifiedFile(absolutePath, {
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
    ino: after.ino,
    sha256: digest,
  });
}


async function markSourceAssetCommitted(id: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const updated = await db.update(sourceMediaAssets)
        .set({ status: "COMMITTED", updatedAtMs: Date.now() })
        .where(and(eq(sourceMediaAssets.id, id), eq(sourceMediaAssets.status, "STAGING")))
        .returning({ id: sourceMediaAssets.id });
      if (updated.length > 0) return true;
      const [row] = await db.select({ status: sourceMediaAssets.status }).from(sourceMediaAssets)
        .where(eq(sourceMediaAssets.id, id));
      if (row?.status === "COMMITTED") return true;
    } catch {
      // SQLite may be briefly busy while the worker or web process commits another transaction.
    }
    await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
  }
  return false;
}

function stagingKeyFor(id: string): string {
  return path.posix.join(".staging", `${id}.part`);
}

async function removeUntrustedStorageEntry(absolutePath: string): Promise<boolean> {
  const info = await fs.lstat(absolutePath).catch(() => null);
  if (!info || info.isDirectory()) return false;
  await fs.rm(absolutePath, { force: true });
  verifiedFileCache.delete(absolutePath);
  return true;
}

export async function importVoiceReferenceStream(input: VoiceReferenceStreamInput): Promise<SourceMediaAssetView> {
  if (input.declaredSize !== undefined) {
    if (!Number.isSafeInteger(input.declaredSize) || input.declaredSize <= 0) {
      throw new SourceAssetError("Invalid Content-Length", "INVALID_CONTENT_LENGTH");
    }
    if (input.declaredSize > MAX_VOICE_REFERENCE_BYTES) {
      throw new SourceAssetError("Reference audio exceeds 50 MB", "SOURCE_TOO_LARGE", 413);
    }
  }

  await assertStorageCapacity(MAX_VOICE_REFERENCE_BYTES);
  const id = genId();
  const stagingKey = stagingKeyFor(id);
  const stagingPath = storagePath(stagingKey);
  await fs.mkdir(path.dirname(stagingPath), { recursive: true, mode: 0o700 });
  const quotaReservation = reserveSourceAssetQuota(
    input.projectId,
    input.userId,
    input.declaredSize ?? MAX_VOICE_REFERENCE_BYTES,
  );
  let lastRenewedAt = Date.now();
  let written: Awaited<ReturnType<typeof writeStreamBounded>>;
  try {
    written = await writeStreamBounded(
      input.stream,
      stagingPath,
      input.declaredSize ?? MAX_VOICE_REFERENCE_BYTES,
      input.signal,
      30_000,
      5 * 60_000,
      () => {
        if (Date.now() - lastRenewedAt >= 5_000) {
          renewSourceAssetQuotaReservation(quotaReservation.id, quotaReservation.token);
          lastRenewedAt = Date.now();
        }
      },
    );
  } catch (error) {
    releaseSourceAssetQuotaReservation(quotaReservation.id, quotaReservation.token);
    throw error;
  }
  if (input.declaredSize !== undefined && written.sizeBytes !== input.declaredSize) {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    releaseSourceAssetQuotaReservation(quotaReservation.id, quotaReservation.token);
    throw new SourceAssetError("Content-Length does not match the uploaded body", "CONTENT_LENGTH_MISMATCH");
  }
  const detected = detectMimeType(written.header);
  if (!detected || !MIME_EXTENSION[detected]) {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    releaseSourceAssetQuotaReservation(quotaReservation.id, quotaReservation.token);
    throw new SourceAssetError("Only real WAV and MP3 reference audio is supported", "UNSUPPORTED_AUDIO_TYPE");
  }

  let audioMetadata: Awaited<ReturnType<typeof probeAudioMetadata>>;
  try {
    audioMetadata = await probeAudioMetadata(stagingPath, { maxDurationMs: 60_000 });
  } catch {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    releaseSourceAssetQuotaReservation(quotaReservation.id, quotaReservation.token);
    throw new SourceAssetError("Reference audio could not be decoded", "AUDIO_PROBE_FAILED");
  }
  if (audioMetadata.durationMs < 3_000 || audioMetadata.durationMs > 60_000) {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    releaseSourceAssetQuotaReservation(quotaReservation.id, quotaReservation.token);
    throw new SourceAssetError("Reference audio must be between 3 and 60 seconds", "AUDIO_DURATION_INVALID");
  }

  const extension = MIME_EXTENSION[detected];
  const storageKey = path.posix.join(input.projectId.replace(/[^A-Za-z0-9._-]/g, "_"), `${id}.${extension}`);
  const finalPath = storagePath(storageKey);
  const now = Date.now();
  const metadataJson = {
    originalName: safeOriginalName(input.originalName),
    sampleRate: audioMetadata.sampleRate,
    channels: audioMetadata.channels,
    codecName: audioMetadata.codecName,
    stagingKey,
    pendingPurpose: "voice-profile-reference",
    expiresAtMs: now + SOURCE_STAGING_MAX_AGE_MS,
  };

  try {
    db.transaction((tx) => {
      tx.insert(sourceMediaAssets).values({
        id,
        projectId: input.projectId,
        userId: input.userId,
        kind: "audio",
        status: "STAGING",
        storageKey,
        mimeType: detected,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
        durationMs: audioMetadata.durationMs,
        metadataJson,
        createdAtMs: now,
        updatedAtMs: now,
      }).run();
      const finalized = tx.update(sourceAssetQuotaReservations).set({
        status: "COMMITTED",
        actualBytes: written.sizeBytes,
        updatedAtMs: now,
      }).where(and(
        eq(sourceAssetQuotaReservations.id, quotaReservation.id),
        eq(sourceAssetQuotaReservations.uploadToken, quotaReservation.token),
        eq(sourceAssetQuotaReservations.status, "RESERVED"),
      )).returning({ id: sourceAssetQuotaReservations.id }).all();
      if (finalized.length !== 1) throw new SourceAssetError(
        "Upload quota reservation expired",
        "SOURCE_QUOTA_RESERVATION_LOST",
        409,
      );
    });
  } catch (error) {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    releaseSourceAssetQuotaReservation(quotaReservation.id, quotaReservation.token);
    throw error;
  }

  try {
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.rename(stagingPath, finalPath);
    verifiedFileCache.delete(stagingPath);
    verifiedFileCache.delete(finalPath);
    if (!(await markSourceAssetCommitted(id))) {
      throw new Error("source_asset_commit_not_persisted");
    }
  } catch (error) {
    console.error("[source-assets] import requires recovery", {
      assetId: id,
      name: error instanceof Error ? error.name : "UnknownError",
    });
    throw new SourceAssetError("Reference audio was staged but could not be committed; recovery will retry", "SOURCE_COMMIT_PENDING", 500);
  }

  return {
    id,
    projectId: input.projectId,
    kind: "audio",
    mimeType: detected,
    sizeBytes: written.sizeBytes,
    sha256: written.sha256,
    durationMs: audioMetadata.durationMs,
    url: `/api/source-assets/${encodeURIComponent(id)}`,
    createdAtMs: now,
  };
}

export async function importVoiceReference(input: {
  projectId: string;
  userId: string;
  file: File;
}): Promise<SourceMediaAssetView> {
  return importVoiceReferenceStream({
    projectId: input.projectId,
    userId: input.userId,
    stream: input.file.stream(),
    originalName: input.file.name,
    declaredSize: input.file.size,
  });
}

export async function recoverSourceMediaAssets(limit = 100): Promise<{ committed: number; quarantined: number }> {
  const rows = await db.select().from(sourceMediaAssets)
    .where(eq(sourceMediaAssets.status, "STAGING"))
    .limit(Math.max(1, Math.min(limit, 1_000)));
  let committed = 0;
  let quarantined = 0;
  for (const row of rows) {
    const finalPath = storagePath(row.storageKey);
    const metadata = row.metadataJson as Record<string, unknown>;
    const stagingKey = typeof metadata.stagingKey === "string" ? metadata.stagingKey : stagingKeyFor(row.id);
    const stagingPath = storagePath(stagingKey);
    try {
      const finalInfo = await fs.lstat(finalPath).catch(() => null);
      if (finalInfo) {
        await verifyRegularFile(finalPath, row);
      } else {
        await verifyRegularFile(stagingPath, row);
        await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
        await fs.rename(stagingPath, finalPath);
      }
      if (!(await markSourceAssetCommitted(row.id))) {
        throw new Error("source_asset_recovery_commit_not_persisted");
      }
      committed += 1;
    } catch (error) {
      const stagingInfo = await fs.lstat(stagingPath).catch(() => null);
      const finalInfo = await fs.lstat(finalPath).catch(() => null);
      const integrityFailure = error instanceof SourceAssetError;
      if (integrityFailure || (!stagingInfo && !finalInfo)) {
        const changed = await db.update(sourceMediaAssets)
          .set({ status: "QUARANTINED", updatedAtMs: Date.now() })
          .where(and(eq(sourceMediaAssets.id, row.id), eq(sourceMediaAssets.status, "STAGING")))
          .returning({ id: sourceMediaAssets.id });
        if (changed.length > 0) {
          await removeUntrustedStorageEntry(stagingPath).catch(() => undefined);
          await removeUntrustedStorageEntry(finalPath).catch(() => undefined);
          quarantined += 1;
        }
      } else {
        console.error("[source-assets] staged asset recovery deferred", {
          assetId: row.id,
          name: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }
  return { committed, quarantined };
}

export async function cleanupSourceAssetStorage(): Promise<{ deletedFiles: number; quarantinedFiles: number; orphanStagingFiles: number; abandonedAssets: number }> {
  await releaseExpiredJobInputSnapshots();
  let deletedFiles = 0;
  let quarantinedFiles = 0;
  let abandonedAssets = 0;
  const abandonedCutoff = Date.now() - SOURCE_STAGING_MAX_AGE_MS;
  const abandonedCandidates = await db.select({
    id: sourceMediaAssets.id,
    metadataJson: sourceMediaAssets.metadataJson,
  }).from(sourceMediaAssets)
    .where(and(eq(sourceMediaAssets.status, "COMMITTED"), lt(sourceMediaAssets.createdAtMs, abandonedCutoff)))
    .limit(100);
  for (const candidate of abandonedCandidates) {
    const metadata = candidate.metadataJson as Record<string, unknown>;
    const explicitlyTemporary = metadata.pendingPurpose === "voice-profile-reference"
      && typeof metadata.expiresAtMs === "number"
      && Number.isSafeInteger(metadata.expiresAtMs)
      && metadata.expiresAtMs <= Date.now();
    if (!explicitlyTemporary) continue;
    const [profileReference] = await db.select({ id: voiceProfiles.id }).from(voiceProfiles)
      .where(eq(voiceProfiles.referenceSourceAssetId, candidate.id)).limit(1);
    const [jobReference] = await db.select({ jobId: generationJobSourceAssets.jobId }).from(generationJobSourceAssets)
      .where(eq(generationJobSourceAssets.sourceAssetId, candidate.id)).limit(1);
    if (!profileReference && !jobReference) {
      const changed = await db.update(sourceMediaAssets).set({ status: "DELETED", updatedAtMs: Date.now() })
        .where(and(eq(sourceMediaAssets.id, candidate.id), eq(sourceMediaAssets.status, "COMMITTED")))
        .returning({ id: sourceMediaAssets.id });
      if (changed.length > 0) abandonedAssets += 1;
    }
  }

  const deleted = await db.select().from(sourceMediaAssets).where(eq(sourceMediaAssets.status, "DELETED")).limit(200);
  for (const row of deleted) {
    const absolutePath = storagePath(row.storageKey);
    if (await removeUntrustedStorageEntry(absolutePath).catch(() => false)) {
      deletedFiles += 1;
    }
  }

  const quarantined = await db.select().from(sourceMediaAssets)
    .where(eq(sourceMediaAssets.status, "QUARANTINED")).limit(200);
  for (const row of quarantined) {
    const metadata = row.metadataJson as Record<string, unknown>;
    const stagingKey = typeof metadata.stagingKey === "string" ? metadata.stagingKey : stagingKeyFor(row.id);
    for (const key of [row.storageKey, stagingKey]) {
      if (await removeUntrustedStorageEntry(storagePath(key)).catch(() => false)) quarantinedFiles += 1;
    }
  }

  const stagingDir = path.join(root(), ".staging");
  const referenced = new Set(
    (await db.select({ id: sourceMediaAssets.id }).from(sourceMediaAssets).where(eq(sourceMediaAssets.status, "STAGING")))
      .map((row) => `${row.id}.part`),
  );
  let orphanStagingFiles = 0;
  const entries = await fs.readdir(stagingDir, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - SOURCE_STAGING_MAX_AGE_MS;
  for (const entry of entries) {
    if (referenced.has(entry.name) || entry.isDirectory()) continue;
    const candidate = path.join(stagingDir, entry.name);
    const info = await fs.lstat(candidate).catch(() => null);
    if (info && !info.isDirectory() && info.mtimeMs < cutoff
      && await removeUntrustedStorageEntry(candidate).catch(() => false)) {
      orphanStagingFiles += 1;
    }
  }
  return { deletedFiles, quarantinedFiles, orphanStagingFiles, abandonedAssets };
}

export async function releaseExpiredJobInputSnapshots(
  nowMs = Date.now(),
  batchSize = 200,
): Promise<number> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("Job input release arguments are invalid");
  }
  const candidates = await db.select({ id: generationJobs.id })
    .from(generationJobs)
    .where(and(
      inArray(generationJobs.status, ["SUCCEEDED", "FAILED", "CANCELLED"]),
      isNull(generationJobs.inputsReleasedAtMs),
      lte(generationJobs.inputRetentionUntilMs, nowMs),
    ))
    .limit(batchSize);
  let released = 0;
  for (const candidate of candidates) {
    db.transaction((tx) => {
      const changed = tx.update(generationJobs).set({
        inputsReleasedAtMs: nowMs,
        updatedAtMs: nowMs,
      }).where(and(
        eq(generationJobs.id, candidate.id),
        inArray(generationJobs.status, ["SUCCEEDED", "FAILED", "CANCELLED"]),
        isNull(generationJobs.inputsReleasedAtMs),
        lte(generationJobs.inputRetentionUntilMs, nowMs),
      )).run();
      if (changed.changes !== 1) return;
      tx.delete(jobInputArtifacts).where(eq(jobInputArtifacts.jobId, candidate.id)).run();
      tx.delete(generationJobSourceAssets)
        .where(eq(generationJobSourceAssets.jobId, candidate.id)).run();
      released += 1;
    });
  }
  return released;
}

export async function getOwnedSourceAsset(assetId: string, userId: string, projectId?: string) {
  const conditions = [eq(sourceMediaAssets.id, assetId), eq(sourceMediaAssets.userId, userId), eq(sourceMediaAssets.status, "COMMITTED")];
  if (projectId) conditions.push(eq(sourceMediaAssets.projectId, projectId));
  const [asset] = await db.select().from(sourceMediaAssets).where(and(...conditions));
  return asset ?? null;
}

export async function listOwnedSourceAssets(userId: string, projectId: string): Promise<SourceMediaAssetView[]> {
  const rows = await db.select().from(sourceMediaAssets).where(and(
    eq(sourceMediaAssets.userId, userId),
    eq(sourceMediaAssets.projectId, projectId),
    eq(sourceMediaAssets.kind, "audio"),
    eq(sourceMediaAssets.status, "COMMITTED"),
  ));
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as "audio",
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    durationMs: row.durationMs,
    url: `/api/source-assets/${encodeURIComponent(row.id)}`,
    createdAtMs: row.createdAtMs,
  }));
}

export async function deleteOwnedSourceAsset(
  assetId: string,
  userId: string,
  options: { requireUnreferenced?: boolean; retainIfInUse?: boolean } = { requireUnreferenced: true },
): Promise<boolean> {
  const asset = await getOwnedSourceAsset(assetId, userId);
  if (!asset) return false;
  let revoked = false;
  db.transaction((tx) => {
    if (options.requireUnreferenced !== false) {
      const [profileReference] = tx.select({ id: voiceProfiles.id }).from(voiceProfiles)
        .where(eq(voiceProfiles.referenceSourceAssetId, assetId)).limit(1).all();
      const [jobReference] = tx.select({ jobId: generationJobSourceAssets.jobId })
        .from(generationJobSourceAssets)
        .where(eq(generationJobSourceAssets.sourceAssetId, assetId))
        .limit(1).all();
      if (profileReference || jobReference) {
        if (options.retainIfInUse) return;
        throw new SourceAssetError("Source audio is still referenced by a voice profile or generation job", "SOURCE_IN_USE", 409);
      }
    }
    const result = tx.update(sourceMediaAssets).set({ status: "DELETED", updatedAtMs: Date.now() })
      .where(and(eq(sourceMediaAssets.id, assetId), eq(sourceMediaAssets.userId, userId), eq(sourceMediaAssets.status, "COMMITTED"))).run();
    revoked = result.changes === 1;
  });
  if (!revoked) return false;
  await cleanupSourceAssetStorage().catch(() => undefined);
  return true;
}

export async function verifyOwnedSourceAssetFile(
  asset: { storageKey: string; sizeBytes: number; sha256: string },
): Promise<string> {
  const absolutePath = storagePath(asset.storageKey);
  await verifyRegularFile(absolutePath, asset);
  return absolutePath;
}

export function resolveSourceAssetPath(storageKey: string): string {
  return storagePath(storageKey);
}
