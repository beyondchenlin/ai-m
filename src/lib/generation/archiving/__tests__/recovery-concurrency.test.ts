import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
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
import { recoverStagingArtifacts, resolveArtifactStoragePath } from "../commit";

const pngBytes = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

async function createExecution() {
  const now = Date.now();
  const projectId = randomUUID();
  const poolId = randomUUID();
  const backendId = randomUUID();
  const jobId = randomUUID();
  const attemptId = randomUUID();
  await db.insert(projects).values({ id: projectId, userId: "owner", title: "recovery-race" });
  await db.insert(resourcePools).values({
    id: poolId, displayName: "race-pool", capacity: 1, policyJson: {}, createdAtMs: now, updatedAtMs: now,
  });
  await db.insert(executionBackends).values({
    id: backendId, displayName: "race-backend", adapterKind: "comfyui", baseUrl: "http://localhost:8188",
    topology: "same-host", sharingMode: "dedicated", authType: "none", authConfigJson: {}, tlsConfigJson: {},
    networkPolicyJson: {}, resourcePoolId: poolId, capabilitiesJson: { capabilities: ["image"] },
    createdAtMs: now, updatedAtMs: now,
  });
  await db.insert(generationJobs).values({
    id: jobId, projectId, requestedBy: "owner", capability: "image", status: "RUNNING",
    executionSnapshotJson: { backendId }, inputDigest: "digest", currentAttemptId: null,
    claimOwner: "worker", claimUntilMs: now + 60_000, claimFencingToken: 1,
    createdAtMs: now, updatedAtMs: now,
  });
  await db.insert(generationAttempts).values({
    id: attemptId, jobId, attemptNo: 1, jobClaimFencingToken: 1, phase: "COMMITTING", backendId,
    backendFeatureSnapshotJson: {}, environmentFingerprint: "env:test", submissionCorrelationId: `corr-${attemptId}`,
    externalIdStrategy: "server-assigned", systemOutputPrefix: `prefix-${attemptId}`, resourcePoolId: poolId,
    resourceSlotNo: 1, resourceLeaseToken: `lease-${attemptId}`, resourceFencingToken: 1,
    createdAtMs: now, updatedAtMs: now,
  });
  await db.update(generationJobs).set({ currentAttemptId: attemptId }).where(eq(generationJobs.id, jobId));
  return { attemptId };
}

async function createStaleArtifact(attemptId: string, logicalName: string) {
  const artifactId = randomUUID();
  const storageKey = `${attemptId}/${artifactId}.png`;
  const writerToken = `expired-${artifactId}`;
  const stagingKey = `.staging/${attemptId}/${artifactId}.${writerToken}.ready`;
  const stagingPath = resolveArtifactStoragePath(stagingKey);
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  await fs.writeFile(stagingPath, pngBytes);
  await db.insert(generationArtifacts).values({
    id: artifactId, attemptId, logicalName, kind: "image", status: "STAGING", storageKey,
    visibility: "project", mimeType: "image/png", sizeBytes: 0, sha256: "pending",
    metadataJson: { readyPath: stagingKey, maxSizeBytes: 1024 },
    writerLeaseOwner: "expired-writer", writerLeaseToken: writerToken,
    writerLeaseExpiresAtMs: Date.now() - 1,
    createdAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 60_000,
  });
  return { artifactId, storageKey, stagingPath };
}

async function createInvalidStagingPair(attemptId: string) {
  const artifactId = randomUUID();
  const token = `expired-${artifactId}`;
  const writingKey = `.staging/${attemptId}/${artifactId}.${token}.writing`;
  const readyKey = `.staging/${attemptId}/${artifactId}.${token}.ready`;
  const writingPath = resolveArtifactStoragePath(writingKey);
  const readyPath = resolveArtifactStoragePath(readyKey);
  await fs.mkdir(path.dirname(writingPath), { recursive: true });
  await fs.writeFile(writingPath, Buffer.alloc(1024, 0x41));
  await fs.writeFile(readyPath, pngBytes.subarray(0, 16));
  await db.insert(generationArtifacts).values({
    id: artifactId, attemptId, logicalName: "invalid-ready.png", kind: "image", status: "STAGING",
    storageKey: `${attemptId}/${artifactId}.png`, visibility: "project", mimeType: "image/png",
    sizeBytes: 0, sha256: "pending", metadataJson: { writingPath: writingKey, readyPath: readyKey },
    writerLeaseOwner: "expired-writer", writerLeaseToken: token, writerLeaseExpiresAtMs: 999,
    createdAtMs: 1, updatedAtMs: 1,
  });
  return { artifactId, writingPath, readyPath };
}

describe("artifact recovery lease concurrency", () => {
  let ctx: ReturnType<typeof setupTestDb>;
  let uploadRoot: string;

  beforeAll(() => {
    uploadRoot = path.join(os.tmpdir(), `ai-m-recovery-race-${randomUUID()}`);
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

  afterEach(async () => fs.rm(uploadRoot, { recursive: true, force: true }));

  it("allows exactly one independent scanner to claim and terminally commit", async () => {
    const execution = await createExecution();
    const artifact = await createStaleArtifact(execution.attemptId, "scanner-race.png");
    const sqliteA = new Database(ctx.dbPath);
    const sqliteB = new Database(ctx.dbPath);
    const dbA = drizzle(sqliteA, { schema });
    const dbB = drizzle(sqliteB, { schema });
    try {
      const results = await Promise.all([
        recoverStagingArtifacts({ recoveryOwner: "scanner-a", database: dbA }),
        recoverStagingArtifacts({ recoveryOwner: "scanner-b", database: dbB }),
      ]);
      expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
      expect(results.reduce((sum, result) => sum + result.committed, 0)).toBe(1);
      expect(results.reduce((sum, result) => sum + result.quarantined, 0)).toBe(0);
    } finally {
      sqliteA.close();
      sqliteB.close();
    }
    const [row] = await db.select().from(generationArtifacts).where(eq(generationArtifacts.id, artifact.artifactId));
    expect(row).toMatchObject({ status: "COMMITTED", recoveryLeaseOwner: null, recoveryLeaseToken: null });
    await expect(fs.readFile(resolveArtifactStoragePath(artifact.storageKey))).resolves.toEqual(Buffer.from(pngBytes));
  });

  it("requires an explicit drain cutoff before claiming a lease-less legacy part", async () => {
    const execution = await createExecution();
    const artifactId = randomUUID();
    const partKey = `.staging/${execution.attemptId}/${artifactId}.part`;
    const partPath = resolveArtifactStoragePath(partKey);
    await fs.mkdir(path.dirname(partPath), { recursive: true });
    await fs.writeFile(partPath, pngBytes);
    let now = Date.now();
    const createdAtMs = now - 60_000;
    await db.insert(generationArtifacts).values({
      id: artifactId, attemptId: execution.attemptId, logicalName: "legacy.png", kind: "image",
      status: "STAGING", storageKey: `${execution.attemptId}/${artifactId}.png`, visibility: "project",
      mimeType: "image/png", sizeBytes: 0, sha256: "pending",
      metadataJson: { stagingPath: partKey, maxSizeBytes: 1024 }, createdAtMs, updatedAtMs: createdAtMs,
    });
    await expect(recoverStagingArtifacts({ recoveryOwner: "mixed-version-scanner" }))
      .resolves.toEqual({ claimed: 0, committed: 0, quarantined: 0 });
    await expect(recoverStagingArtifacts({
      recoveryOwner: "drained-legacy-scanner", legacyRecoveryBeforeMs: createdAtMs,
      now: () => now, recoveryLeaseMs: 1_000,
      removeRecoveryFile: () => { throw Object.assign(new Error("legacy file busy"), { code: "EBUSY" }); },
    })).resolves.toEqual({ claimed: 1, committed: 0, quarantined: 0 });
    expect((await db.select().from(generationArtifacts))[0].status).toBe("RECOVERING");
    await expect(fs.stat(partPath)).resolves.toBeDefined();
    now += 1_001;
    await expect(recoverStagingArtifacts({
      recoveryOwner: "legacy-retry-scanner", now: () => now, recoveryLeaseMs: 1_000,
    })).resolves.toEqual({ claimed: 1, committed: 0, quarantined: 1 });
    await expect(fs.stat(partPath)).rejects.toThrow();
  });

  it("quarantines truncated PNG and MP4 ready files instead of publishing magic-byte prefixes", async () => {
    const execution = await createExecution();
    const cases = [
      { id: randomUUID(), kind: "image" as const, mimeType: "image/png", bytes: pngBytes.subarray(0, 16), ext: "png" },
      { id: randomUUID(), kind: "image" as const, mimeType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]), ext: "jpg" },
      { id: randomUUID(), kind: "image" as const, mimeType: "image/webp", bytes: new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x20, 10, 0, 0, 0,
      ]), ext: "webp" },
      { id: randomUUID(), kind: "image" as const, mimeType: "image/gif", bytes: new Uint8Array([
        ...Buffer.from("GIF89a"), 1, 0, 1, 0, 0, 0, 0,
      ]), ext: "gif" },
      { id: randomUUID(), kind: "video" as const, mimeType: "video/mp4", bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), ext: "mp4" },
    ];
    for (const item of cases) {
      const writerToken = `expired-${item.id}`;
      const readyKey = `.staging/${execution.attemptId}/${item.id}.${writerToken}.ready`;
      const readyPath = resolveArtifactStoragePath(readyKey);
      await fs.mkdir(path.dirname(readyPath), { recursive: true });
      await fs.writeFile(readyPath, item.bytes);
      await db.insert(generationArtifacts).values({
        id: item.id, attemptId: execution.attemptId, logicalName: `truncated.${item.ext}`, kind: item.kind,
        status: "STAGING", storageKey: `${execution.attemptId}/${item.id}.${item.ext}`, visibility: "project",
        mimeType: item.mimeType, sizeBytes: 0, sha256: "pending", metadataJson: { readyPath: readyKey },
        writerLeaseOwner: "expired-writer", writerLeaseToken: writerToken,
        writerLeaseExpiresAtMs: Date.now() - 1, createdAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 60_000,
      });
    }
    await expect(recoverStagingArtifacts({ recoveryOwner: "container-validator" }))
      .resolves.toEqual({ claimed: 5, committed: 0, quarantined: 5 });
    expect((await db.select().from(generationArtifacts)).map((row) => row.status))
      .toEqual(Array(5).fill("QUARANTINED"));
  });

  it("removes token-bound writing and invalid ready files before terminal quarantine", async () => {
    const execution = await createExecution();
    const artifact = await createInvalidStagingPair(execution.attemptId);
    await expect(recoverStagingArtifacts({ recoveryOwner: "cleanup-scanner", now: () => 1_000 }))
      .resolves.toEqual({ claimed: 1, committed: 0, quarantined: 1 });
    await expect(fs.stat(artifact.writingPath)).rejects.toThrow();
    await expect(fs.stat(artifact.readyPath)).rejects.toThrow();
  });

  it("keeps RECOVERING on an open-handle unlink failure and retries after lease expiry", async () => {
    const execution = await createExecution();
    const artifact = await createInvalidStagingPair(execution.attemptId);
    const openHandle = await fs.open(artifact.writingPath, "r");
    let now = 1_000;
    try {
      await expect(recoverStagingArtifacts({
        recoveryOwner: "busy-cleaner", now: () => now, recoveryLeaseMs: 1_000,
        removeRecoveryFile: (filePath: string) => {
          if (filePath === artifact.writingPath) throw Object.assign(new Error("open handle"), { code: "EBUSY" });
          rmSync(filePath, { force: true });
        },
      })).resolves.toEqual({ claimed: 1, committed: 0, quarantined: 0 });
      expect((await db.select().from(generationArtifacts))[0].status).toBe("RECOVERING");
      await expect(fs.stat(artifact.writingPath)).resolves.toBeDefined();
    } finally {
      await openHandle.close();
    }
    now += 1_001;
    await expect(recoverStagingArtifacts({ recoveryOwner: "retry-cleaner", now: () => now, recoveryLeaseMs: 1_000 }))
      .resolves.toEqual({ claimed: 1, committed: 0, quarantined: 1 });
    expect((await db.select().from(generationArtifacts))[0].status).toBe("QUARANTINED");
    await expect(fs.stat(artifact.writingPath)).rejects.toThrow();
    await expect(fs.stat(artifact.readyPath)).rejects.toThrow();
  });

  it("recovers a delete-to-database crash window without leaving staging files", async () => {
    const execution = await createExecution();
    const artifact = await createInvalidStagingPair(execution.attemptId);
    let now = 1_000;
    await expect(recoverStagingArtifacts({
      recoveryOwner: "crashing-cleaner", now: () => now, recoveryLeaseMs: 1_000,
      afterRecoveryFilesRemoved: () => { throw new Error("injected cleanup crash"); },
    })).resolves.toEqual({ claimed: 1, committed: 0, quarantined: 0 });
    expect((await db.select().from(generationArtifacts))[0].status).toBe("RECOVERING");
    await expect(fs.stat(artifact.writingPath)).rejects.toThrow();
    await expect(fs.stat(artifact.readyPath)).rejects.toThrow();
    now += 1_001;
    await expect(recoverStagingArtifacts({ recoveryOwner: "post-crash-cleaner", now: () => now, recoveryLeaseMs: 1_000 }))
      .resolves.toEqual({ claimed: 1, committed: 0, quarantined: 1 });
    expect((await db.select().from(generationArtifacts))[0].status).toBe("QUARANTINED");
  });

  it("retries ready cleanup before COMMITTED after final publication", async () => {
    const execution = await createExecution();
    const artifact = await createStaleArtifact(execution.attemptId, "busy-ready.png");
    let now = Date.now();
    await expect(recoverStagingArtifacts({
      recoveryOwner: "commit-cleaner", now: () => now, recoveryLeaseMs: 1_000,
      removeRecoveryFile: (filePath: string) => {
        if (filePath === artifact.stagingPath) throw Object.assign(new Error("open ready"), { code: "EBUSY" });
        rmSync(filePath, { force: true });
      },
    })).resolves.toEqual({ claimed: 1, committed: 0, quarantined: 0 });
    expect((await db.select().from(generationArtifacts))[0].status).toBe("RECOVERING");
    await expect(fs.stat(resolveArtifactStoragePath(artifact.storageKey))).resolves.toBeDefined();
    await expect(fs.stat(artifact.stagingPath)).resolves.toBeDefined();
    now += 1_001;
    await expect(recoverStagingArtifacts({ recoveryOwner: "commit-retry", now: () => now, recoveryLeaseMs: 1_000 }))
      .resolves.toEqual({ claimed: 1, committed: 1, quarantined: 0 });
    expect((await db.select().from(generationArtifacts))[0].status).toBe("COMMITTED");
    await expect(fs.stat(artifact.stagingPath)).rejects.toThrow();
  });

  it("fences a paused loser after token loss and reclaims the successor after lease expiry", async () => {
    const execution = await createExecution();
    const artifact = await createStaleArtifact(execution.attemptId, "lost-recovery.png");
    const originalLstat = fs.lstat.bind(fs);
    let releaseInspection!: () => void;
    let inspectionPaused!: () => void;
    const paused = new Promise<void>((resolve) => { inspectionPaused = resolve; });
    const release = new Promise<void>((resolve) => { releaseInspection = resolve; });
    let intercepted = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (target, options?) => {
      if (!intercepted && String(target).includes(`${path.sep}.recovery${path.sep}`)) {
        intercepted = true;
        inspectionPaused();
        await release;
      }
      return originalLstat(target, options as never);
    });
    try {
      const losingScan = recoverStagingArtifacts({ recoveryOwner: "scanner-loser" });
      await paused;
      await db.update(generationArtifacts).set({
        recoveryLeaseOwner: "scanner-successor", recoveryLeaseToken: "successor-token",
        recoveryLeaseExpiresAtMs: Date.now() + 30_000,
      }).where(eq(generationArtifacts.id, artifact.artifactId));
      releaseInspection();
      await expect(losingScan).resolves.toEqual({ claimed: 1, committed: 0, quarantined: 0 });
      await expect(fs.readFile(artifact.stagingPath)).resolves.toEqual(Buffer.from(pngBytes));
      await expect(fs.stat(resolveArtifactStoragePath(artifact.storageKey))).rejects.toThrow();
      const recoveryDir = resolveArtifactStoragePath(`.recovery/${execution.attemptId}`);
      await expect(fs.readdir(recoveryDir)).resolves.toEqual([]);

      await db.update(generationArtifacts).set({ recoveryLeaseExpiresAtMs: Date.now() - 1 })
        .where(eq(generationArtifacts.id, artifact.artifactId));
      await expect(recoverStagingArtifacts({ recoveryOwner: "scanner-reclaimer" }))
        .resolves.toEqual({ claimed: 1, committed: 1, quarantined: 0 });
    } finally {
      lstatSpy.mockRestore();
    }
    const [row] = await db.select().from(generationArtifacts).where(eq(generationArtifacts.id, artifact.artifactId));
    expect(row).toMatchObject({ status: "COMMITTED", recoveryLeaseOwner: null, recoveryLeaseToken: null });
  });
});
