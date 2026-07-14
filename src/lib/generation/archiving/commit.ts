/** Durable, streamed, two-phase media artifact commit. */
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { generationArtifacts, generationAttempts, generationJobs, projects } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { isEnabled, FF } from "@/lib/feature-flags";
import type { ArtifactKind, ArtifactVisibility } from "@/lib/generation/naming";
import { writeAuditEvent, AuditAction, AuditTargetType } from "@/lib/security/audit";
import { probeMediaDurationMs } from "../media-probe";
import { validateCompleteMediaFile } from "./media-completeness";

export const ContentType = { IMAGE_PNG: "image/png", IMAGE_JPEG: "image/jpeg", IMAGE_WEBP: "image/webp", IMAGE_GIF: "image/gif", VIDEO_MP4: "video/mp4", AUDIO_WAV: "audio/wav", AUDIO_MP3: "audio/mpeg" } as const;
/** @deprecated Use ContentType. Kept for source compatibility until the next major release. */
export const ContenType = ContentType;

const MAGIC: Record<string, Array<{ offset: number; bytes: number[] }>> = {
  "image/png": [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  "image/jpeg": [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  "image/webp": [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }],
  "image/gif": [],
  "video/mp4": [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }],
  "audio/wav": [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] }],
  "audio/mpeg": [{ offset: 0, bytes: [0x49, 0x44, 0x33] }],
};

const EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "audio/wav": "wav", "audio/mpeg": "mp3",
};

export interface ArtifactStreamInput {
  attemptId: string;
  /** Required for worker commits; prevents a stale worker from publishing output. */
  expectedJobClaimFencingToken?: number;
  logicalName: string;
  kind: ArtifactKind;
  mimeType: string;
  visibility: ArtifactVisibility;
  parentArtifactId?: string;
  read: () => ReadableStream<Uint8Array>;
  maxSizeBytes?: number;
  /** Trusted decoded-body length evidence (for example, identity HTTP Content-Length). */
  expectedSizeBytes?: number;
  /** Maximum wait for each upstream chunk; prevents a stalled backend holding a worker forever. */
  readTimeoutMs?: number;
  metadata?: Record<string, unknown>;
  /** Stable worker identity used to own and renew the pre-publication lease. */
  writerOwner?: string;
}

export interface ArtifactCommitResult {
  id: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface ArtifactRecoveryOptions {
  recoveryOwner: string;
  database?: DB;
  now?: () => number;
  writerGraceMs?: number;
  recoveryLeaseMs?: number;
  legacyRecoveryBeforeMs?: number;
  /** Synchronous seam used to model Windows open-handle deletion failures. */
  removeRecoveryFile?: (filePath: string) => void;
  /** Crash-injection seam after durable files are gone but before the terminal DB CAS. */
  afterRecoveryFilesRemoved?: () => void;
}

export interface ArtifactRecoveryResult {
  claimed: number;
  committed: number;
  quarantined: number;
}

export interface ArtifactCommitDependencies {
  openStagingFile?: (filePath: string) => Promise<FileHandle>;
}

const WRITER_LEASE_MS = 30_000;
const WRITER_RENEW_INTERVAL_MS = 10_000;
const RECOVERY_LEASE_MS = 30_000;
const LEGACY_STAGING_GRACE_MS = 30_000;

export function parseLegacyArtifactRecoveryBeforeMs(
  raw: string | undefined,
  now = Date.now(),
  warn: (message: string) => void = console.warn,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > now) {
    warn("[artifact-recovery] Ignoring invalid or future AI_M_LEGACY_ARTIFACT_RECOVERY_BEFORE_MS; legacy rows remain fenced");
    return undefined;
  }
  return value;
}

export function getArtifactRoot(): string {
  return path.resolve(process.env.UPLOAD_DIR || "./uploads", "generation-artifacts");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "artifact";
}

export function isArtifactStorageKeySafe(storageKey: string): boolean {
  if (!storageKey || path.isAbsolute(storageKey) || storageKey.includes("\0")) return false;
  const normalized = storageKey.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments.length > 0
    && segments.every((segment) => /^[A-Za-z0-9._-]{1,200}$/.test(segment) && segment !== "." && segment !== "..");
}

export function resolveArtifactStoragePath(storageKey: string): string {
  if (!isArtifactStorageKeySafe(storageKey)) throw new Error("Invalid artifact storage key");
  const normalized = storageKey.replace(/\\/g, "/");
  const root = getArtifactRoot();
  const resolved = path.resolve(root, ...normalized.split("/"));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Artifact path escapes storage root");
  return resolved;
}

export function validateMagicBytes(header: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/gif") {
    const signature = String.fromCharCode(...header.subarray(0, 6));
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "audio/mpeg") {
    const hasId3 = header.length >= 3 && header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33;
    const hasFrameSync = header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0;
    return hasId3 || hasFrameSync;
  }
  const alternatives = MAGIC[mimeType];
  if (!alternatives) return false;
  return alternatives.every(({ offset, bytes }) =>
    header.length >= offset + bytes.length && bytes.every((byte, index) => header[offset + index] === byte),
  );
}

async function writeWebStreamToFile(
  stream: ReadableStream<Uint8Array>,
  fileHandle: FileHandle,
  maxBytes: number,
  readTimeoutMs: number,
): Promise<{ sizeBytes: number; sha256: string; header: Uint8Array }> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  let sizeBytes = 0;
  let header = new Uint8Array(0);
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Artifact stream stalled for ${readTimeoutMs}ms`)), readTimeoutMs);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      const { done, value } = chunk;
      if (done) break;
      sizeBytes += value.byteLength;
      if (sizeBytes > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`);
      if (header.byteLength < 64) {
        const combined = new Uint8Array(Math.min(64, header.byteLength + value.byteLength));
        combined.set(header);
        combined.set(value.subarray(0, combined.byteLength - header.byteLength), header.byteLength);
        header = combined;
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await fileHandle.write(value, offset, value.byteLength - offset, null);
        if (bytesWritten <= 0) throw new Error("Artifact staging write made no progress");
        offset += bytesWritten;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (sizeBytes === 0) throw new Error("Artifact is empty");
  return { sizeBytes, sha256: hash.digest("hex"), header };
}

async function inspectFile(filePath: string, maxBytes = 1024 * 1024 * 1024): Promise<{ sizeBytes: number; sha256: string; header: Uint8Array }> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error("Artifact recovery file size is invalid");
  const hash = createHash("sha256");
  let header = new Uint8Array(0);
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const value = new Uint8Array(chunk as Buffer);
    sizeBytes += value.byteLength;
    if (sizeBytes > maxBytes) throw new Error("Artifact recovery file exceeds limit");
    if (header.byteLength < 64) {
      const combined = new Uint8Array(Math.min(64, header.byteLength + value.byteLength));
      combined.set(header);
      combined.set(value.subarray(0, combined.byteLength - header.byteLength), header.byteLength);
      header = combined;
    }
    hash.update(value);
  }
  return { sizeBytes, sha256: hash.digest("hex"), header };
}

async function syncDirectory(directory: string): Promise<void> {
  // Directory fsync closes the rename durability window on POSIX. Windows may
  // reject directory handles, so the database recovery path remains the fallback.
  const handle = await fs.open(directory, "r").catch(() => null);
  if (!handle) return;
  try { await handle.sync(); } catch { /* platform does not support directory fsync */ } finally { await handle.close(); }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (process.platform !== "win32" || !["EPERM", "EINVAL", "ENOTSUP"].includes(code)) throw error;
  } finally {
    await handle.close();
  }
}

async function assertAttemptFence(attemptId: string, expectedToken: number | undefined): Promise<void> {
  if (expectedToken === undefined) return;
  const [row] = await db
    .select({
      attemptToken: generationAttempts.jobClaimFencingToken,
      currentAttemptId: generationJobs.currentAttemptId,
      jobToken: generationJobs.claimFencingToken,
    })
    .from(generationAttempts)
    .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
    .where(eq(generationAttempts.id, attemptId));
  if (!row || row.attemptToken !== expectedToken || row.jobToken !== expectedToken || row.currentAttemptId !== attemptId) {
    throw new Error("Artifact commit rejected because the execution fence is stale");
  }
}

async function renewWriterLease(
  artifactId: string,
  owner: string,
  token: string,
  now: number,
): Promise<boolean> {
  const changed = await db.update(generationArtifacts).set({
    writerLeaseExpiresAtMs: now + WRITER_LEASE_MS,
  }).where(and(
    eq(generationArtifacts.id, artifactId),
    eq(generationArtifacts.status, "STAGING"),
    eq(generationArtifacts.writerLeaseOwner, owner),
    eq(generationArtifacts.writerLeaseToken, token),
    gt(generationArtifacts.writerLeaseExpiresAtMs, now),
  )).returning({ id: generationArtifacts.id });
  return Boolean(changed[0]);
}

type OwnedStagingIdentity = Readonly<{ dev: string; ino: string; size: string }>;

function stagingIdentity(stat: Awaited<ReturnType<FileHandle["stat"]>>): OwnedStagingIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) };
}

async function removeOwnedStagingFile(filePath: string, identity: OwnedStagingIdentity): Promise<void> {
  const current = await fs.lstat(filePath).catch(() => null);
  if (!current || !stagingPathMatchesIdentity(current, identity)) return;
  await fs.unlink(filePath).catch(() => undefined);
}

function stagingPathMatchesIdentity(
  current: Awaited<ReturnType<typeof fs.lstat>>,
  identity: OwnedStagingIdentity,
): boolean {
  return !current.isSymbolicLink() && current.isFile()
    && String(current.dev) === identity.dev
    && String(current.ino) === identity.ino
    && String(current.size) === identity.size;
}

async function ownsStagingPath(filePath: string, identity: OwnedStagingIdentity): Promise<boolean> {
  const current = await fs.lstat(filePath).catch(() => null);
  return Boolean(current && stagingPathMatchesIdentity(current, identity));
}

export async function streamCommitArtifact(
  input: ArtifactStreamInput,
  dependencies: ArtifactCommitDependencies = {},
): Promise<ArtifactCommitResult> {
  if (!isEnabled(FF.V2_MEDIA_ARCHIVING)) throw new Error("v2.0 media archiving is not enabled");
  if (!EXTENSIONS[input.mimeType]) throw new Error(`Unsupported artifact MIME type: ${input.mimeType}`);
  const expectedKind = input.mimeType.startsWith("image/") ? "image"
    : input.mimeType.startsWith("video/") ? "video"
    : input.mimeType.startsWith("audio/") ? "audio" : null;
  if (!expectedKind || input.kind !== expectedKind) throw new Error("Artifact kind does not match MIME type");
  if (!input.logicalName || input.logicalName.length > 240 || input.logicalName.includes("\0")) throw new Error("Invalid artifact logical name");
  await assertAttemptFence(input.attemptId, input.expectedJobClaimFencingToken);
  const maxBytes = input.maxSizeBytes ?? 100 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 10 * 1024 * 1024 * 1024) throw new Error("Invalid artifact size limit");
  const expectedSizeBytes = input.expectedSizeBytes;
  if (expectedSizeBytes !== undefined
    && (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes <= 0 || expectedSizeBytes > maxBytes)) {
    throw new Error("Invalid artifact expected size");
  }
  const callerMetadata = Object.fromEntries(
    Object.entries(input.metadata ?? {}).filter(([key]) => key !== "expectedSizeBytes"),
  );
  const artifactMetadata = {
    ...callerMetadata,
    ...(expectedSizeBytes !== undefined ? { expectedSizeBytes } : {}),
  };
  if (JSON.stringify(artifactMetadata).length > 64 * 1024) throw new Error("Artifact metadata exceeds 64 KiB");
  const id = genId();
  const writerOwner = input.writerOwner?.trim() || `writer-${process.pid}`;
  const writerToken = genId();
  const relativeFinal = path.posix.join(safeSegment(input.attemptId), `${id}.${EXTENSIONS[input.mimeType]}`);
  const finalPath = resolveArtifactStoragePath(relativeFinal);
  const writingKey = path.posix.join(".staging", safeSegment(input.attemptId), `${id}.${safeSegment(writerToken)}.writing`);
  const readyKey = path.posix.join(".staging", safeSegment(input.attemptId), `${id}.${safeSegment(writerToken)}.ready`);
  const writingPath = resolveArtifactStoragePath(writingKey);
  const readyPath = resolveArtifactStoragePath(readyKey);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.mkdir(path.dirname(writingPath), { recursive: true });

  const now = Date.now();
  await db.insert(generationArtifacts).values({
    id, attemptId: input.attemptId, logicalName: input.logicalName, kind: input.kind,
    status: "STAGING", storageKey: relativeFinal, visibility: input.visibility,
    mimeType: input.mimeType, sizeBytes: 0, sha256: "pending", width: null, height: null,
    durationMs: null, metadataJson: {
      ...artifactMetadata,
      writingPath: writingKey,
      readyPath: readyKey,
      maxSizeBytes: maxBytes,
    },
    parentArtifactId: input.parentArtifactId ?? null, committedAtMs: null,
    writerLeaseOwner: writerOwner, writerLeaseToken: writerToken,
    writerLeaseExpiresAtMs: now + WRITER_LEASE_MS,
    recoveryLeaseOwner: null, recoveryLeaseToken: null, recoveryLeaseExpiresAtMs: null,
    createdAtMs: now, updatedAtMs: now,
  });

  let renamed = false;
  let readyPublished = false;
  let stagingHandle: FileHandle | null = null;
  let ownedStagingIdentity: OwnedStagingIdentity | null = null;
  let leaseLost = false;
  let renewal = Promise.resolve();
  const renewalTimer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (!await renewWriterLease(id, writerOwner, writerToken, Date.now())) leaseLost = true;
    }).catch(() => { leaseLost = true; });
  }, WRITER_RENEW_INTERVAL_MS);
  renewalTimer.unref?.();
  try {
    const readTimeoutMs = input.readTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1_000 || readTimeoutMs > 5 * 60 * 1000) throw new Error("Invalid artifact read timeout");
    if (!await renewWriterLease(id, writerOwner, writerToken, Date.now())) {
      throw new Error("Artifact writer lease was lost before staging open");
    }
    stagingHandle = await (dependencies.openStagingFile
      ? dependencies.openStagingFile(writingPath)
      : fs.open(writingPath, "wx", 0o600));
    const openedStat = await stagingHandle.stat();
    if (!openedStat.isFile()) throw new Error("Artifact staging handle is not a regular file");
    ownedStagingIdentity = stagingIdentity(openedStat);
    if (!await renewWriterLease(id, writerOwner, writerToken, Date.now())) {
      throw new Error("Artifact writer lease was lost after staging open");
    }
    const written = await writeWebStreamToFile(input.read(), stagingHandle, maxBytes, readTimeoutMs);
    await stagingHandle.sync();
    ownedStagingIdentity = stagingIdentity(await stagingHandle.stat());
    await stagingHandle.close();
    stagingHandle = null;
    if (expectedSizeBytes !== undefined && written.sizeBytes !== expectedSizeBytes) {
      throw new Error(`Artifact expected size ${expectedSizeBytes} bytes but received ${written.sizeBytes}`);
    }
    await renewal;
    if (leaseLost || !await renewWriterLease(id, writerOwner, writerToken, Date.now())) {
      throw new Error("Artifact writer lease was lost before container validation");
    }
    if (!ownedStagingIdentity || !await ownsStagingPath(writingPath, ownedStagingIdentity)) {
      throw new Error("Artifact staging file ownership was lost before container validation");
    }
    if (!await validateCompleteMediaFile(writingPath, input.mimeType, written.sizeBytes)) {
      throw new Error(`Artifact container is incomplete for ${input.mimeType}`);
    }
    await renewal;
    if (leaseLost || !await renewWriterLease(id, writerOwner, writerToken, Date.now())) {
      throw new Error("Artifact writer lease was lost");
    }
    if (!validateMagicBytes(written.header, input.mimeType)) throw new Error(`Content signature does not match ${input.mimeType}`);
    await assertAttemptFence(input.attemptId, input.expectedJobClaimFencingToken);
    await renewal;
    if (leaseLost || !await renewWriterLease(id, writerOwner, writerToken, Date.now())) {
      throw new Error("Artifact writer lease was lost before publish");
    }
    if (!ownedStagingIdentity || !await ownsStagingPath(writingPath, ownedStagingIdentity)) {
      throw new Error("Artifact staging file ownership was lost before publish");
    }
    await fs.rename(writingPath, readyPath);
    await syncDirectory(path.dirname(readyPath));
    readyPublished = true;
    await renewal;
    if (leaseLost || !await renewWriterLease(id, writerOwner, writerToken, Date.now())) {
      throw new Error("Artifact writer lease was lost after ready publish");
    }
    if (!await ownsStagingPath(readyPath, ownedStagingIdentity)) throw new Error("Artifact ready file ownership was lost");
    await fs.rename(readyPath, finalPath);
    await syncDirectory(path.dirname(finalPath));
    renamed = true;
    const durationMs = input.kind === "audio"
      ? await probeMediaDurationMs(finalPath, { maxDurationMs: 6 * 60 * 60 * 1000 })
      : null;
    clearInterval(renewalTimer);
    await renewal;
    const committedAtMs = Date.now();
    if (leaseLost || !await renewWriterLease(id, writerOwner, writerToken, committedAtMs)) {
      throw new Error("Artifact writer lease was lost before commit");
    }
    const updated = db.transaction((tx) => {
      if (input.expectedJobClaimFencingToken !== undefined) {
        const [fence] = tx
          .select({
            attemptToken: generationAttempts.jobClaimFencingToken,
            currentAttemptId: generationJobs.currentAttemptId,
            jobToken: generationJobs.claimFencingToken,
          })
          .from(generationAttempts)
          .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
          .where(eq(generationAttempts.id, input.attemptId))
          .all();
        if (!fence || fence.attemptToken !== input.expectedJobClaimFencingToken
          || fence.jobToken !== input.expectedJobClaimFencingToken || fence.currentAttemptId !== input.attemptId) {
          throw new Error("Artifact commit rejected because the execution fence is stale");
        }
      }
      return tx.update(generationArtifacts).set({
        status: "COMMITTED", sizeBytes: written.sizeBytes, sha256: written.sha256,
        durationMs, committedAtMs, updatedAtMs: committedAtMs, metadataJson: artifactMetadata,
        writerLeaseOwner: null, writerLeaseToken: null, writerLeaseExpiresAtMs: null,
      }).where(and(
        eq(generationArtifacts.id, id),
        eq(generationArtifacts.status, "STAGING"),
        eq(generationArtifacts.writerLeaseOwner, writerOwner),
        eq(generationArtifacts.writerLeaseToken, writerToken),
        gt(generationArtifacts.writerLeaseExpiresAtMs, committedAtMs),
      )).returning({ id: generationArtifacts.id }).all();
    });
    if (!updated[0]) throw new Error("Artifact commit lost its STAGING state");
    await writeAuditEvent({
      action: "artifact.committed" as AuditAction, targetType: AuditTargetType.ARTIFACT, targetId: id,
      detailsSafe: { kind: input.kind, mimeType: input.mimeType, sizeBytes: written.sizeBytes, sha256: written.sha256 },
    });
    return {
      id,
      storageKey: relativeFinal,
      sha256: written.sha256,
      sizeBytes: written.sizeBytes,
      mimeType: input.mimeType,
      ...(durationMs !== null ? { durationMs } : {}),
    };
  } catch (error) {
    clearInterval(renewalTimer);
    await renewal.catch(() => undefined);
    if (stagingHandle) {
      ownedStagingIdentity = await stagingHandle.stat().then(stagingIdentity).catch(() => ownedStagingIdentity);
      await stagingHandle.close().catch(() => undefined);
      stagingHandle = null;
    }
    if (renamed || readyPublished) {
      // Preserve STAGING: startup reconciliation can finish the rename/database
      // crash window without losing a valid immutable output.
      await db.update(generationArtifacts).set({
        metadataJson: {
          ...artifactMetadata, writingPath: writingKey, readyPath: readyKey, maxSizeBytes: maxBytes, recoveryRequired: true,
        }, updatedAtMs: Date.now(),
      }).where(and(
        eq(generationArtifacts.id, id), eq(generationArtifacts.status, "STAGING"),
        eq(generationArtifacts.writerLeaseOwner, writerOwner), eq(generationArtifacts.writerLeaseToken, writerToken),
      )).catch(() => undefined);
    } else {
      const failedAt = Date.now();
      await db.update(generationArtifacts).set({
        status: "QUARANTINED",
        metadataJson: { ...artifactMetadata, failure: error instanceof Error ? error.message.slice(0, 300) : "artifact_commit_failed" },
        writerLeaseOwner: null, writerLeaseToken: null, writerLeaseExpiresAtMs: null,
        updatedAtMs: failedAt,
      }).where(and(
        eq(generationArtifacts.id, id), eq(generationArtifacts.status, "STAGING"),
        eq(generationArtifacts.writerLeaseOwner, writerOwner), eq(generationArtifacts.writerLeaseToken, writerToken),
        gt(generationArtifacts.writerLeaseExpiresAtMs, failedAt),
      )).catch(() => undefined);
      if (ownedStagingIdentity) await removeOwnedStagingFile(writingPath, ownedStagingIdentity);
    }
    throw error;
  }
}

export async function commitArtifactFromBuffer(buffer: Uint8Array, input: Omit<ArtifactStreamInput, "read">): Promise<ArtifactCommitResult> {
  return streamCommitArtifact({
    ...input,
    read: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(buffer); controller.close(); } }),
  });
}

async function renewRecoveryLease(
  database: DB,
  artifactId: string,
  owner: string,
  token: string,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  const changed = await database.update(generationArtifacts).set({
    recoveryLeaseExpiresAtMs: now + leaseMs,
  }).where(and(
    eq(generationArtifacts.id, artifactId),
    eq(generationArtifacts.status, "RECOVERING"),
    eq(generationArtifacts.recoveryLeaseOwner, owner),
    eq(generationArtifacts.recoveryLeaseToken, token),
    gt(generationArtifacts.recoveryLeaseExpiresAtMs, now),
  )).returning({ id: generationArtifacts.id });
  return Boolean(changed[0]);
}

function recoveryStagingCleanupPaths(
  artifact: typeof generationArtifacts.$inferSelect,
  metadata: Record<string, unknown>,
  legacyClaimAuthorized: boolean,
): string[] {
  const attempt = safeSegment(artifact.attemptId);
  const artifactId = safeSegment(artifact.id);
  const prefix = `.staging/${attempt}/${artifactId}`;
  const modernKeys = [metadata.writingPath, metadata.readyPath]
    .filter((value): value is string => typeof value === "string");
  const modernPrefixes = new Set<string>();
  const resolved = new Set<string>();
  for (const key of modernKeys) {
    const normalized = key.replace(/\\/g, "/");
    const suffix = normalized.endsWith(".writing") ? ".writing"
      : normalized.endsWith(".ready") ? ".ready" : null;
    if (!suffix) throw new Error("unsafe_recovery_cleanup_path");
    const pathPrefix = normalized.slice(0, -suffix.length);
    const token = pathPrefix.startsWith(`${prefix}.`) ? pathPrefix.slice(prefix.length + 1) : "";
    if (!token || token !== safeSegment(token)) {
      throw new Error("unsafe_recovery_cleanup_path");
    }
    modernPrefixes.add(pathPrefix);
    resolved.add(resolveArtifactStoragePath(normalized));
    resolved.add(resolveArtifactStoragePath(`${pathPrefix}.writing`));
    resolved.add(resolveArtifactStoragePath(`${pathPrefix}.ready`));
  }
  if (modernPrefixes.size > 1) throw new Error("mismatched_recovery_cleanup_tokens");
  if (legacyClaimAuthorized && typeof metadata.stagingPath === "string") {
    const normalized = metadata.stagingPath.replace(/\\/g, "/");
    const basename = normalized.startsWith(`${prefix}.`) ? normalized.slice(prefix.length + 1) : "";
    if (!(normalized === `${prefix}.part`
      || (basename.endsWith(".part") && basename.slice(0, -5) === safeSegment(basename.slice(0, -5))))) {
      throw new Error("unsafe_legacy_recovery_cleanup_path");
    }
    resolved.add(resolveArtifactStoragePath(normalized));
  }
  return [...resolved];
}

function terminalizeRecoveredArtifact(options: {
  database: DB;
  artifact: typeof generationArtifacts.$inferSelect;
  recoveryOwner: string;
  recoveryToken: string;
  terminalAt: number;
  status: "COMMITTED" | "QUARANTINED";
  values: Partial<typeof generationArtifacts.$inferInsert>;
  cleanupPaths: string[];
  removeFile?: (filePath: string) => void;
  afterFilesRemoved?: () => void;
}): boolean {
  try {
    return options.database.transaction((tx) => {
      const owned = tx.select({ id: generationArtifacts.id }).from(generationArtifacts).where(and(
        eq(generationArtifacts.id, options.artifact.id),
        eq(generationArtifacts.status, "RECOVERING"),
        eq(generationArtifacts.recoveryLeaseOwner, options.recoveryOwner),
        eq(generationArtifacts.recoveryLeaseToken, options.recoveryToken),
        gt(generationArtifacts.recoveryLeaseExpiresAtMs, options.terminalAt),
      )).get();
      if (!owned) return false;
      const removeFile = options.removeFile ?? ((filePath: string) => rmSync(filePath, { force: true }));
      for (const filePath of options.cleanupPaths) removeFile(filePath);
      options.afterFilesRemoved?.();
      const changed = tx.update(generationArtifacts).set({
        ...options.values,
        status: options.status,
        updatedAtMs: options.terminalAt,
        recoveryLeaseOwner: null,
        recoveryLeaseToken: null,
        recoveryLeaseExpiresAtMs: null,
      }).where(and(
        eq(generationArtifacts.id, options.artifact.id),
        eq(generationArtifacts.status, "RECOVERING"),
        eq(generationArtifacts.recoveryLeaseOwner, options.recoveryOwner),
        eq(generationArtifacts.recoveryLeaseToken, options.recoveryToken),
        gt(generationArtifacts.recoveryLeaseExpiresAtMs, options.terminalAt),
      )).returning({ id: generationArtifacts.id }).get();
      if (!changed) throw new Error("recovery_terminal_cas_lost");
      return true;
    }, { behavior: "immediate" });
  } catch {
    return false;
  }
}

/** Atomically claim and recover abandoned writer output. */
export async function recoverStagingArtifacts(options: ArtifactRecoveryOptions): Promise<ArtifactRecoveryResult> {
  const database = options.database ?? db;
  const clock = options.now ?? Date.now;
  const now = clock();
  const graceMs = options.writerGraceMs ?? LEGACY_STAGING_GRACE_MS;
  const leaseMs = options.recoveryLeaseMs ?? RECOVERY_LEASE_MS;
  if (!options.recoveryOwner.trim()) throw new Error("Artifact recovery owner is required");
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error("Invalid artifact recovery grace period");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw new Error("Invalid artifact recovery lease duration");
  const rows = await database.select().from(generationArtifacts)
    .where(inArray(generationArtifacts.status, ["STAGING", "RECOVERING"]));
  let claimed = 0;
  let committed = 0;
  let quarantined = 0;
  for (const candidateRow of rows) {
    const recoveryToken = genId();
    const legacyCutoff = options.legacyRecoveryBeforeMs;
    const initialLegacyClaimAuthorized = candidateRow.status === "STAGING"
      && candidateRow.writerLeaseOwner === null
      && candidateRow.writerLeaseToken === null
      && candidateRow.writerLeaseExpiresAtMs === null
      && legacyCutoff !== undefined
      && Number.isSafeInteger(legacyCutoff)
      && legacyCutoff > 0
      && legacyCutoff <= now
      && candidateRow.createdAtMs <= legacyCutoff
      && candidateRow.updatedAtMs <= now - graceMs;
    const legacyEligible = legacyCutoff !== undefined && Number.isSafeInteger(legacyCutoff)
      && legacyCutoff > 0 && legacyCutoff <= now
      ? and(
        isNull(generationArtifacts.writerLeaseOwner),
        isNull(generationArtifacts.writerLeaseToken),
        isNull(generationArtifacts.writerLeaseExpiresAtMs),
        lte(generationArtifacts.createdAtMs, legacyCutoff),
        lte(generationArtifacts.updatedAtMs, now - graceMs),
      )
      : undefined;
    const eligibleWriter = or(
      legacyEligible,
      lte(generationArtifacts.writerLeaseExpiresAtMs, now),
    );
    const claimCondition = candidateRow.status === "RECOVERING"
      ? and(
        eq(generationArtifacts.status, "RECOVERING"),
        lte(generationArtifacts.recoveryLeaseExpiresAtMs, now),
      )
      : and(eq(generationArtifacts.status, "STAGING"), eligibleWriter);
    const [artifact] = await database.update(generationArtifacts).set({
      status: "RECOVERING",
      writerLeaseOwner: null,
      writerLeaseToken: null,
      writerLeaseExpiresAtMs: null,
      recoveryLeaseOwner: options.recoveryOwner,
      recoveryLeaseToken: recoveryToken,
      recoveryLeaseExpiresAtMs: now + leaseMs,
      metadataJson: initialLegacyClaimAuthorized ? {
        ...(candidateRow.metadataJson as Record<string, unknown>), recoveryLegacyCutoffMs: legacyCutoff,
      } : candidateRow.metadataJson,
      updatedAtMs: now,
    }).where(and(eq(generationArtifacts.id, candidateRow.id), claimCondition))
      .returning();
    if (!artifact) continue;
    claimed++;
    const claimedMetadata = artifact.metadataJson as Record<string, unknown>;
    const persistedLegacyCutoff = claimedMetadata.recoveryLegacyCutoffMs;
    const legacyClaimAuthorized = initialLegacyClaimAuthorized
      || (candidateRow.status === "RECOVERING"
        && typeof persistedLegacyCutoff === "number"
        && Number.isSafeInteger(persistedLegacyCutoff)
        && persistedLegacyCutoff > 0
        && persistedLegacyCutoff <= now
        && artifact.createdAtMs <= persistedLegacyCutoff);
    let recoveryLeaseLost = false;
    let recoveryRenewal = Promise.resolve();
    const recoveryRenewalTimer = setInterval(() => {
      recoveryRenewal = recoveryRenewal.then(async () => {
        if (!await renewRecoveryLease(
          database, artifact.id, options.recoveryOwner, recoveryToken, clock(), leaseMs,
        )) recoveryLeaseLost = true;
      }).catch(() => { recoveryLeaseLost = true; });
    }, Math.max(500, Math.floor(leaseMs / 3)));
    recoveryRenewalTimer.unref?.();
    const finalPath = resolveArtifactStoragePath(artifact.storageKey);
    const metadata = claimedMetadata;
    const readyKey = typeof metadata.readyPath === "string" ? metadata.readyPath : null;
    const readyPath = readyKey ? resolveArtifactStoragePath(readyKey) : null;
    let stagingCleanupPaths: string[];
    try {
      stagingCleanupPaths = recoveryStagingCleanupPaths(artifact, metadata, legacyClaimAuthorized);
    } catch {
      stagingCleanupPaths = [];
      recoveryLeaseLost = true;
    }
    const usableFile = async (filePath: string): Promise<string | null> => {
      const info = await fs.lstat(filePath).catch(() => null);
      return info && !info.isSymbolicLink() && info.isFile() ? filePath : null;
    };
    const sourceCandidate = await usableFile(finalPath) ?? (readyPath ? await usableFile(readyPath) : null);
    if (!sourceCandidate) {
      clearInterval(recoveryRenewalTimer);
      await recoveryRenewal;
      const terminalAt = clock();
      if (!recoveryLeaseLost && terminalizeRecoveredArtifact({
        database, artifact, recoveryOwner: options.recoveryOwner, recoveryToken, terminalAt,
        status: "QUARANTINED", values: { metadataJson: { ...metadata, recovery: "file_missing" } },
        cleanupPaths: stagingCleanupPaths,
        removeFile: options.removeRecoveryFile,
        afterFilesRemoved: options.afterRecoveryFilesRemoved,
      })) quarantined++;
      continue;
    }
    let recoveryTempPath: string | null = null;
    try {
      if (recoveryLeaseLost) throw new Error("recovery_lease_lost");
      const [ownership] = await database
        .select({
          currentAttemptId: generationJobs.currentAttemptId,
          attemptToken: generationAttempts.jobClaimFencingToken,
          jobToken: generationJobs.claimFencingToken,
        })
        .from(generationAttempts)
        .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
        .where(eq(generationAttempts.id, artifact.attemptId));
      if (
        !ownership
        || ownership.currentAttemptId !== artifact.attemptId
        || ownership.attemptToken === null
        || ownership.attemptToken !== ownership.jobToken
      ) throw new Error("stale_attempt_output");
      const recoveryMaxBytes = typeof metadata.maxSizeBytes === "number"
        && Number.isSafeInteger(metadata.maxSizeBytes)
        && metadata.maxSizeBytes > 0
        && metadata.maxSizeBytes <= 10 * 1024 * 1024 * 1024
        ? metadata.maxSizeBytes
        : 1024 * 1024 * 1024;
      let candidate = sourceCandidate;
      if (sourceCandidate !== finalPath) {
        const snapshotAt = clock();
        if (!await renewRecoveryLease(database, artifact.id, options.recoveryOwner, recoveryToken, snapshotAt, leaseMs)) {
          throw new Error("recovery_lease_lost");
        }
        const recoveryTempKey = path.posix.join(
          ".recovery", safeSegment(artifact.attemptId), `${safeSegment(artifact.id)}.${safeSegment(recoveryToken)}.part`,
        );
        recoveryTempPath = resolveArtifactStoragePath(recoveryTempKey);
        await fs.mkdir(path.dirname(recoveryTempPath), { recursive: true });
        await fs.copyFile(sourceCandidate, recoveryTempPath, fsConstants.COPYFILE_EXCL);
        await syncFile(recoveryTempPath);
        candidate = recoveryTempPath;
      }
      const inspected = await inspectFile(candidate, recoveryMaxBytes);
      const expectedSizeBytes = metadata.expectedSizeBytes;
      if (expectedSizeBytes !== undefined
        && (typeof expectedSizeBytes !== "number" || !Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes <= 0
          || expectedSizeBytes > recoveryMaxBytes || inspected.sizeBytes !== expectedSizeBytes)) {
        throw new Error("expected_size_mismatch");
      }
      if (!validateMagicBytes(inspected.header, artifact.mimeType)) throw new Error("content_mismatch");
      if (!await validateCompleteMediaFile(candidate, artifact.mimeType, inspected.sizeBytes)) throw new Error("incomplete_container");
      const expectedKind = artifact.mimeType.startsWith("image/") ? "image"
        : artifact.mimeType.startsWith("video/") ? "video"
        : artifact.mimeType.startsWith("audio/") ? "audio" : null;
      if (!expectedKind || artifact.kind !== expectedKind) throw new Error("kind_mismatch");
      if (candidate !== finalPath) {
        await recoveryRenewal;
        if (recoveryLeaseLost) throw new Error("recovery_lease_lost");
        const renewAt = clock();
        if (!await renewRecoveryLease(database, artifact.id, options.recoveryOwner, recoveryToken, renewAt, leaseMs)) {
          throw new Error("recovery_lease_lost");
        }
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.rename(candidate, finalPath);
        await syncDirectory(path.dirname(finalPath));
      }
      const durationMs = artifact.kind === "audio"
        ? await probeMediaDurationMs(finalPath, { maxDurationMs: 6 * 60 * 60 * 1000 })
        : artifact.durationMs;
      const at = clock();
      await recoveryRenewal;
      if (recoveryLeaseLost) throw new Error("recovery_lease_lost");
      if (!await renewRecoveryLease(database, artifact.id, options.recoveryOwner, recoveryToken, at, leaseMs)) {
        throw new Error("recovery_lease_lost");
      }
      const terminalAt = clock();
      if (terminalizeRecoveredArtifact({
        database, artifact, recoveryOwner: options.recoveryOwner, recoveryToken, terminalAt,
        status: "COMMITTED", values: {
          sizeBytes: inspected.sizeBytes, sha256: inspected.sha256, durationMs, committedAtMs: terminalAt,
          metadataJson: { ...metadata, recovery: "completed" },
        },
        cleanupPaths: [...stagingCleanupPaths, ...(recoveryTempPath ? [recoveryTempPath] : [])],
        removeFile: options.removeRecoveryFile,
        afterFilesRemoved: options.afterRecoveryFilesRemoved,
      })) {
        committed++;
      }
    } catch (error) {
      clearInterval(recoveryRenewalTimer);
      await recoveryRenewal.catch(() => { recoveryLeaseLost = true; });
      const terminalAt = clock();
      if (!recoveryLeaseLost && terminalizeRecoveredArtifact({
        database, artifact, recoveryOwner: options.recoveryOwner, recoveryToken, terminalAt,
        status: "QUARANTINED", values: {
          metadataJson: { ...metadata, recovery: error instanceof Error ? error.message.slice(0, 120) : "recovery_failed" },
        },
        cleanupPaths: [...stagingCleanupPaths, ...(recoveryTempPath ? [recoveryTempPath] : [])],
        removeFile: options.removeRecoveryFile,
        afterFilesRemoved: options.afterRecoveryFilesRemoved,
      })) quarantined++;
    } finally {
      clearInterval(recoveryRenewalTimer);
      await recoveryRenewal.catch(() => undefined);
      if (recoveryTempPath) await fs.rm(recoveryTempPath, { force: true }).catch(() => undefined);
    }
  }
  return { claimed, committed, quarantined };
}

export async function checkArtifactAccess(artifactId: string, userId: string, projectId: string): Promise<{ allowed: boolean; reason?: string }> {
  const [row] = await db.select({ artifact: generationArtifacts, jobProjectId: generationJobs.projectId, projectUserId: projects.userId })
    .from(generationArtifacts)
    .innerJoin(generationAttempts, eq(generationAttempts.id, generationArtifacts.attemptId))
    .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
    .innerJoin(projects, eq(projects.id, generationJobs.projectId))
    .where(eq(generationArtifacts.id, artifactId));
  if (!row) return { allowed: false, reason: "Artifact not found" };
  if (row.artifact.status !== "COMMITTED") return { allowed: false, reason: `Artifact not available (status: ${row.artifact.status})` };
  if (row.jobProjectId !== projectId || row.projectUserId !== userId) return { allowed: false, reason: "Artifact is not accessible" };
  return { allowed: true };
}

export async function cleanupStagingDir(attemptId: string): Promise<void> {
  await fs.rm(resolveArtifactStoragePath(path.posix.join(".staging", safeSegment(attemptId))), { recursive: true, force: true });
}
