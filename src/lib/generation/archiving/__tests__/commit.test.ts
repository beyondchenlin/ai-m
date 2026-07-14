import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  executionBackends,
  generationArtifacts,
  generationAttempts,
  generationJobs,
  projects,
  resourcePools,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import { ArtifactKind, ArtifactVisibility } from "@/lib/generation/naming";
import {
  checkArtifactAccess,
  commitArtifactFromBuffer,
  recoverStagingArtifacts,
  resolveArtifactStoragePath,
  streamCommitArtifact,
  validateMagicBytes,
} from "../commit";

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

async function createExecution(ownerId = "owner") {
  const now = Date.now();
  const projectId = randomUUID();
  const poolId = randomUUID();
  const backendId = randomUUID();
  const jobId = randomUUID();
  const attemptId = randomUUID();

  await db.insert(projects).values({ id: projectId, userId: ownerId, title: "artifact-test" });
  await db.insert(resourcePools).values({
    id: poolId, displayName: "test-pool", capacity: 1, policyJson: {}, createdAtMs: now, updatedAtMs: now,
  });
  await db.insert(executionBackends).values({
    id: backendId, displayName: "test-backend", adapterKind: "comfyui",
    baseUrl: "http://localhost:8188", topology: "same-host", sharingMode: "dedicated",
    authType: "none", authConfigJson: {}, tlsConfigJson: {}, networkPolicyJson: {},
    resourcePoolId: poolId, capabilitiesJson: { capabilities: ["image"] }, createdAtMs: now, updatedAtMs: now,
  });
  await db.insert(generationJobs).values({
    id: jobId, projectId, requestedBy: ownerId, capability: "image", status: "RUNNING",
    executionSnapshotJson: { backendId }, inputDigest: "digest", currentAttemptId: null,
    claimOwner: "worker", claimUntilMs: now + 60_000, claimFencingToken: 1,
    createdAtMs: now, updatedAtMs: now,
  });
  await db.insert(generationAttempts).values({
    id: attemptId, jobId, attemptNo: 1, jobClaimFencingToken: 1, phase: "COMMITTING",
    backendId, backendFeatureSnapshotJson: {}, environmentFingerprint: "env:test",
    submissionCorrelationId: `corr-${attemptId}`, externalIdStrategy: "server-assigned",
    systemOutputPrefix: `prefix-${attemptId}`, resourcePoolId: poolId, resourceSlotNo: 1,
    resourceLeaseToken: `lease-${attemptId}`, resourceFencingToken: 1,
    createdAtMs: now, updatedAtMs: now,
  });
  await db.update(generationJobs).set({ currentAttemptId: attemptId }).where(eq(generationJobs.id, jobId));
  return { ownerId, projectId, poolId, backendId, jobId, attemptId };
}

describe("PR-12 media signature validation", () => {
  it("accepts exact supported signatures", () => {
    expect(validateMagicBytes(pngBytes, "image/png")).toBe(true);
    expect(validateMagicBytes(jpegBytes, "image/jpeg")).toBe(true);
    expect(validateMagicBytes(new TextEncoder().encode("GIF89a"), "image/gif")).toBe(true);
    expect(validateMagicBytes(new Uint8Array([0xff, 0xfb]), "audio/mpeg")).toBe(true);
  });

  it("rejects unknown, truncated, and partial RIFF signatures", () => {
    expect(validateMagicBytes(new Uint8Array([0x00, 0x01]), "application/octet-stream")).toBe(false);
    expect(validateMagicBytes(new Uint8Array([0x89]), "image/png")).toBe(false);
    const riffOnly = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(validateMagicBytes(riffOnly, "image/webp")).toBe(false);
    expect(validateMagicBytes(riffOnly, "audio/wav")).toBe(false);
    expect(validateMagicBytes(new TextEncoder().encode("GIF88a"), "image/gif")).toBe(false);
  });
});

describe("PR-12 fenced two-phase artifact commit", () => {
  let ctx: ReturnType<typeof setupTestDb>;
  let uploadRoot: string;

  beforeAll(() => {
    uploadRoot = path.join(os.tmpdir(), `ai-m-artifact-test-${randomUUID()}`);
    process.env.UPLOAD_DIR = uploadRoot;
    process.env.FF_V2_MEDIA_ARCHIVING = "true";
    ctx = setupTestDb();
  });

  afterAll(() => ctx.cleanup());

  beforeEach(async () => {
    await db.delete(generationArtifacts);
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
    await db.delete(projects);
    await fs.rm(uploadRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(uploadRoot, { recursive: true, force: true });
  });

  it("commits an immutable artifact under the current execution fence", async () => {
    const execution = await createExecution();
    const result = await commitArtifactFromBuffer(pngBytes, {
      attemptId: execution.attemptId,
      expectedJobClaimFencingToken: 1,
      logicalName: "preview.png",
      kind: ArtifactKind.IMAGE,
      mimeType: "image/png",
      visibility: ArtifactVisibility.PROJECT,
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await fs.stat(resolveArtifactStoragePath(result.storageKey))).isFile()).toBe(true);
    const [row] = await db.select().from(generationArtifacts).where(eq(generationArtifacts.id, result.id));
    expect(row.status).toBe("COMMITTED");
  });

  it("rejects oversize content and quarantines the incomplete record", async () => {
    const execution = await createExecution();
    await expect(commitArtifactFromBuffer(pngBytes, {
      attemptId: execution.attemptId,
      expectedJobClaimFencingToken: 1,
      logicalName: "preview.png",
      kind: ArtifactKind.IMAGE,
      mimeType: "image/png",
      visibility: ArtifactVisibility.PROJECT,
      maxSizeBytes: 8,
    })).rejects.toThrow(/Artifact exceeds 8 bytes/);
    const [row] = await db.select().from(generationArtifacts);
    expect(row.status).toBe("QUARANTINED");
  });

  it("rejects stale workers before publishing output", async () => {
    const execution = await createExecution();
    await db.update(generationJobs).set({ claimFencingToken: 2 }).where(eq(generationJobs.id, execution.jobId));
    await expect(commitArtifactFromBuffer(pngBytes, {
      attemptId: execution.attemptId,
      expectedJobClaimFencingToken: 1,
      logicalName: "stale.png",
      kind: ArtifactKind.IMAGE,
      mimeType: "image/png",
      visibility: ArtifactVisibility.PROJECT,
    })).rejects.toThrow(/execution fence is stale/i);
    expect(await db.select().from(generationArtifacts)).toHaveLength(0);
  });

  it("recovers the rename/database crash window only for the current fence", async () => {
    const execution = await createExecution();
    const artifactId = randomUUID();
    const storageKey = `${execution.attemptId}/${artifactId}.png`;
    const finalPath = resolveArtifactStoragePath(storageKey);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, pngBytes);
    await db.insert(generationArtifacts).values({
      id: artifactId, attemptId: execution.attemptId, logicalName: "recover.png", kind: "image",
      status: "STAGING", storageKey, visibility: "project", mimeType: "image/png",
      sizeBytes: 0, sha256: "pending", metadataJson: { maxSizeBytes: 1024 },
      createdAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 60_000,
    });
    expect(await recoverStagingArtifacts({ recoveryOwner: "startup-test" })).toEqual({ claimed: 1, committed: 1, quarantined: 0 });

    const staleId = randomUUID();
    const staleKey = `${execution.attemptId}/${staleId}.png`;
    await fs.writeFile(resolveArtifactStoragePath(staleKey), pngBytes);
    await db.insert(generationArtifacts).values({
      id: staleId, attemptId: execution.attemptId, logicalName: "stale-recover.png", kind: "image",
      status: "STAGING", storageKey: staleKey, visibility: "project", mimeType: "image/png",
      sizeBytes: 0, sha256: "pending", metadataJson: { maxSizeBytes: 1024 },
      createdAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 60_000,
    });
    await db.update(generationJobs).set({ claimFencingToken: 2 }).where(eq(generationJobs.id, execution.jobId));
    expect(await recoverStagingArtifacts({ recoveryOwner: "startup-test" })).toEqual({ claimed: 1, committed: 0, quarantined: 1 });
  });

  it("does not recover a live delayed writer with a renewable STAGING lease", async () => {
    const execution = await createExecution();
    let releaseStream!: () => void;
    let started!: () => void;
    const streamStarted = new Promise<void>((resolve) => { started = resolve; });
    const streamRelease = new Promise<void>((resolve) => { releaseStream = resolve; });
    const writing = streamCommitArtifact({
      attemptId: execution.attemptId,
      expectedJobClaimFencingToken: 1,
      writerOwner: "writer-live",
      logicalName: "delayed.png",
      kind: ArtifactKind.IMAGE,
      mimeType: "image/png",
      visibility: ArtifactVisibility.PROJECT,
      readTimeoutMs: 5_000,
      read: () => new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(pngBytes);
          started();
          await streamRelease;
          controller.close();
        },
      }),
    });
    await streamStarted;

    let staging: typeof generationArtifacts.$inferSelect | undefined;
    for (let retry = 0; retry < 100; retry++) {
      [staging] = await db.select().from(generationArtifacts);
      const stagingKey = (staging?.metadataJson as { stagingPath?: string } | undefined)?.stagingPath;
      const size = stagingKey
        ? (await fs.stat(resolveArtifactStoragePath(stagingKey)).catch(() => null))?.size
        : 0;
      if (staging?.status === "STAGING" && size === pngBytes.byteLength) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(staging).toMatchObject({ status: "STAGING", writerLeaseOwner: "writer-live" });
    expect(staging?.writerLeaseToken).toMatch(/\S/);
    expect(staging?.writerLeaseExpiresAtMs).toBeGreaterThan(Date.now());

    const scannerSqlite = new Database(ctx.dbPath);
    const scannerDb = drizzle(scannerSqlite, { schema });
    try {
      await expect(recoverStagingArtifacts({ recoveryOwner: "startup-concurrent", database: scannerDb }))
        .resolves.toEqual({ claimed: 0, committed: 0, quarantined: 0 });
    } finally {
      scannerSqlite.close();
    }

    releaseStream();
    await expect(writing).resolves.toMatchObject({ mimeType: "image/png" });
    const [committed] = await db.select().from(generationArtifacts);
    expect(committed.status).toBe("COMMITTED");
  });

  it("fences a writer that loses its lease without letting later bytes mutate the recovered file", async () => {
    const execution = await createExecution();
    let releaseStream!: () => void;
    let started!: () => void;
    const streamStarted = new Promise<void>((resolve) => { started = resolve; });
    const streamRelease = new Promise<void>((resolve) => { releaseStream = resolve; });
    const writing = streamCommitArtifact({
      attemptId: execution.attemptId, expectedJobClaimFencingToken: 1, writerOwner: "writer-loser",
      logicalName: "lost-writer.png", kind: ArtifactKind.IMAGE, mimeType: "image/png",
      visibility: ArtifactVisibility.PROJECT, readTimeoutMs: 5_000,
      read: () => new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(pngBytes);
          started();
          await streamRelease;
          controller.enqueue(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
          controller.close();
        },
      }),
    });
    await streamStarted;
    let artifact: typeof generationArtifacts.$inferSelect | undefined;
    for (let retry = 0; retry < 100; retry++) {
      [artifact] = await db.select().from(generationArtifacts);
      if (artifact) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(artifact).toBeDefined();
    await db.update(generationArtifacts).set({
      writerLeaseOwner: "new-owner", writerLeaseToken: "new-token",
      writerLeaseExpiresAtMs: Date.now() - 1,
    }).where(eq(generationArtifacts.id, artifact!.id));
    await expect(recoverStagingArtifacts({ recoveryOwner: "writer-loss-recovery" }))
      .resolves.toEqual({ claimed: 1, committed: 1, quarantined: 0 });
    releaseStream();
    await expect(writing).rejects.toThrow(/writer lease was lost/i);

    const [fenced] = await db.select().from(generationArtifacts).where(eq(generationArtifacts.id, artifact!.id));
    expect(fenced.status).toBe("COMMITTED");
    await expect(fs.readFile(resolveArtifactStoragePath(fenced.storageKey))).resolves.toEqual(Buffer.from(pngBytes));
  });

  it("authorizes by project ownership without exposing files cross-user", async () => {
    const execution = await createExecution("owner-a");
    const result = await commitArtifactFromBuffer(pngBytes, {
      attemptId: execution.attemptId,
      expectedJobClaimFencingToken: 1,
      logicalName: "private.png",
      kind: ArtifactKind.IMAGE,
      mimeType: "image/png",
      visibility: ArtifactVisibility.PRIVATE_ORIGINAL,
    });
    await expect(checkArtifactAccess(result.id, "owner-a", execution.projectId)).resolves.toEqual({ allowed: true });
    await expect(checkArtifactAccess(result.id, "owner-b", execution.projectId)).resolves.toMatchObject({ allowed: false });
  });
});
