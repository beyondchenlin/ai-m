/** Durable, streamed, two-phase media artifact commit. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationArtifacts, generationAttempts, generationJobs, projects } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { isEnabled, FF } from "@/lib/feature-flags";
import type { ArtifactKind, ArtifactVisibility } from "@/lib/generation/naming";
import { writeAuditEvent, AuditAction, AuditTargetType } from "@/lib/security/audit";
import { probeMediaDurationMs } from "../media-probe";

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
  /** Maximum wait for each upstream chunk; prevents a stalled backend holding a worker forever. */
  readTimeoutMs?: number;
  metadata?: Record<string, unknown>;
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
  filePath: string,
  maxBytes: number,
  readTimeoutMs: number,
): Promise<{ sizeBytes: number; sha256: string; header: Uint8Array }> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  const writer = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
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
      if (!writer.write(value)) await new Promise<void>((resolve) => writer.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => writer.end((error?: Error | null) => error ? reject(error) : resolve()));
  } catch (error) {
    if (!writer.destroyed) {
      await new Promise<void>((resolve) => {
        writer.once("close", resolve);
        writer.destroy();
      });
    }
    throw error;
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

export async function streamCommitArtifact(input: ArtifactStreamInput): Promise<ArtifactCommitResult> {
  if (!isEnabled(FF.V2_MEDIA_ARCHIVING)) throw new Error("v2.0 media archiving is not enabled");
  if (!EXTENSIONS[input.mimeType]) throw new Error(`Unsupported artifact MIME type: ${input.mimeType}`);
  const expectedKind = input.mimeType.startsWith("image/") ? "image"
    : input.mimeType.startsWith("video/") ? "video"
    : input.mimeType.startsWith("audio/") ? "audio" : null;
  if (!expectedKind || input.kind !== expectedKind) throw new Error("Artifact kind does not match MIME type");
  if (!input.logicalName || input.logicalName.length > 240 || input.logicalName.includes("\0")) throw new Error("Invalid artifact logical name");
  if (JSON.stringify(input.metadata ?? {}).length > 64 * 1024) throw new Error("Artifact metadata exceeds 64 KiB");
  await assertAttemptFence(input.attemptId, input.expectedJobClaimFencingToken);
  const maxBytes = input.maxSizeBytes ?? 100 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 10 * 1024 * 1024 * 1024) throw new Error("Invalid artifact size limit");
  const id = genId();
  const relativeFinal = path.posix.join(safeSegment(input.attemptId), `${id}.${EXTENSIONS[input.mimeType]}`);
  const finalPath = resolveArtifactStoragePath(relativeFinal);
  const stagingKey = path.posix.join(".staging", safeSegment(input.attemptId), `${id}.part`);
  const stagingPath = resolveArtifactStoragePath(stagingKey);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });

  const now = Date.now();
  await db.insert(generationArtifacts).values({
    id, attemptId: input.attemptId, logicalName: input.logicalName, kind: input.kind,
    status: "STAGING", storageKey: relativeFinal, visibility: input.visibility,
    mimeType: input.mimeType, sizeBytes: 0, sha256: "pending", width: null, height: null,
    durationMs: null, metadataJson: {
      ...(input.metadata ?? {}),
      stagingPath: stagingKey,
      maxSizeBytes: maxBytes,
    },
    parentArtifactId: input.parentArtifactId ?? null, committedAtMs: null,
    createdAtMs: now, updatedAtMs: now,
  });

  let renamed = false;
  try {
    const readTimeoutMs = input.readTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1_000 || readTimeoutMs > 5 * 60 * 1000) throw new Error("Invalid artifact read timeout");
    const written = await writeWebStreamToFile(input.read(), stagingPath, maxBytes, readTimeoutMs);
    if (!validateMagicBytes(written.header, input.mimeType)) throw new Error(`Content signature does not match ${input.mimeType}`);
    await assertAttemptFence(input.attemptId, input.expectedJobClaimFencingToken);
    await syncFile(stagingPath);
    await fs.rename(stagingPath, finalPath);
    await syncDirectory(path.dirname(finalPath));
    renamed = true;
    const durationMs = input.kind === "audio"
      ? await probeMediaDurationMs(finalPath, { maxDurationMs: 6 * 60 * 60 * 1000 })
      : null;
    const committedAtMs = Date.now();
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
        durationMs, committedAtMs, updatedAtMs: committedAtMs, metadataJson: input.metadata ?? {},
      }).where(and(eq(generationArtifacts.id, id), eq(generationArtifacts.status, "STAGING"))).returning({ id: generationArtifacts.id }).all();
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
    if (renamed) {
      // Preserve STAGING: startup reconciliation can finish the rename/database
      // crash window without losing a valid immutable output.
      await db.update(generationArtifacts).set({
        metadataJson: {
          ...(input.metadata ?? {}), stagingPath: stagingKey, maxSizeBytes: maxBytes, recoveryRequired: true,
        }, updatedAtMs: Date.now(),
      }).where(and(eq(generationArtifacts.id, id), eq(generationArtifacts.status, "STAGING"))).catch(() => undefined);
    } else {
      await fs.rm(stagingPath, { force: true }).catch(() => undefined);
      await db.update(generationArtifacts).set({
        status: "QUARANTINED",
        metadataJson: { ...(input.metadata ?? {}), failure: error instanceof Error ? error.message.slice(0, 300) : "artifact_commit_failed" },
        updatedAtMs: Date.now(),
      }).where(eq(generationArtifacts.id, id)).catch(() => undefined);
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

/** Recover the rename/database crash window for STAGING artifacts. */
export async function recoverStagingArtifacts(): Promise<{ committed: number; quarantined: number }> {
  const rows = await db.select().from(generationArtifacts).where(eq(generationArtifacts.status, "STAGING"));
  let committed = 0;
  let quarantined = 0;
  for (const artifact of rows) {
    const finalPath = resolveArtifactStoragePath(artifact.storageKey);
    const metadata = artifact.metadataJson as Record<string, unknown>;
    const stagingKey = typeof metadata.stagingPath === "string" ? metadata.stagingPath : null;
    const stagingPath = stagingKey ? resolveArtifactStoragePath(stagingKey) : null;
    const usableFile = async (filePath: string): Promise<string | null> => {
      const info = await fs.lstat(filePath).catch(() => null);
      return info && !info.isSymbolicLink() && info.isFile() ? filePath : null;
    };
    const candidate = await usableFile(finalPath) ?? (stagingPath ? await usableFile(stagingPath) : null);
    if (!candidate) {
      const changed = await db.update(generationArtifacts).set({ status: "QUARANTINED", updatedAtMs: Date.now(), metadataJson: { ...metadata, recovery: "file_missing" } }).where(and(eq(generationArtifacts.id, artifact.id), eq(generationArtifacts.status, "STAGING"))).returning({ id: generationArtifacts.id });
      if (changed[0]) quarantined++;
      continue;
    }
    try {
      const [ownership] = await db
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
      const inspected = await inspectFile(candidate, recoveryMaxBytes);
      if (!validateMagicBytes(inspected.header, artifact.mimeType)) throw new Error("content_mismatch");
      const expectedKind = artifact.mimeType.startsWith("image/") ? "image"
        : artifact.mimeType.startsWith("video/") ? "video"
        : artifact.mimeType.startsWith("audio/") ? "audio" : null;
      if (!expectedKind || artifact.kind !== expectedKind) throw new Error("kind_mismatch");
      if (candidate !== finalPath) {
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.rename(candidate, finalPath);
      }
      const durationMs = artifact.kind === "audio"
        ? await probeMediaDurationMs(finalPath, { maxDurationMs: 6 * 60 * 60 * 1000 })
        : artifact.durationMs;
      const at = Date.now();
      const changed = await db.update(generationArtifacts).set({
        status: "COMMITTED", sizeBytes: inspected.sizeBytes, sha256: inspected.sha256,
        durationMs, committedAtMs: at, updatedAtMs: at, metadataJson: { ...metadata, recovery: "completed" },
      }).where(and(eq(generationArtifacts.id, artifact.id), eq(generationArtifacts.status, "STAGING"))).returning({ id: generationArtifacts.id });
      if (changed[0]) committed++;
    } catch (error) {
      const changed = await db.update(generationArtifacts).set({
        status: "QUARANTINED", updatedAtMs: Date.now(),
        metadataJson: { ...metadata, recovery: error instanceof Error ? error.message.slice(0, 120) : "recovery_failed" },
      }).where(and(eq(generationArtifacts.id, artifact.id), eq(generationArtifacts.status, "STAGING"))).returning({ id: generationArtifacts.id });
      if (changed[0]) quarantined++;
    }
  }
  return { committed, quarantined };
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
