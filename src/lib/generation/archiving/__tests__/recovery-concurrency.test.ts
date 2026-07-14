import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
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
  const stagingKey = `.staging/${attemptId}/${artifactId}.ready`;
  const stagingPath = resolveArtifactStoragePath(stagingKey);
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  await fs.writeFile(stagingPath, pngBytes);
  await db.insert(generationArtifacts).values({
    id: artifactId, attemptId, logicalName, kind: "image", status: "STAGING", storageKey,
    visibility: "project", mimeType: "image/png", sizeBytes: 0, sha256: "pending",
    metadataJson: { readyPath: stagingKey, maxSizeBytes: 1024 },
    writerLeaseOwner: "expired-writer", writerLeaseToken: `expired-${artifactId}`,
    writerLeaseExpiresAtMs: Date.now() - 1,
    createdAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 60_000,
  });
  return { artifactId, storageKey, stagingPath };
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
    const createdAtMs = Date.now() - 60_000;
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
    })).resolves.toEqual({ claimed: 1, committed: 0, quarantined: 1 });
  });

  it("quarantines truncated PNG and MP4 ready files instead of publishing magic-byte prefixes", async () => {
    const execution = await createExecution();
    const cases = [
      { id: randomUUID(), kind: "image" as const, mimeType: "image/png", bytes: pngBytes.subarray(0, 16), ext: "png" },
      { id: randomUUID(), kind: "video" as const, mimeType: "video/mp4", bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), ext: "mp4" },
    ];
    for (const item of cases) {
      const readyKey = `.staging/${execution.attemptId}/${item.id}.ready`;
      const readyPath = resolveArtifactStoragePath(readyKey);
      await fs.mkdir(path.dirname(readyPath), { recursive: true });
      await fs.writeFile(readyPath, item.bytes);
      await db.insert(generationArtifacts).values({
        id: item.id, attemptId: execution.attemptId, logicalName: `truncated.${item.ext}`, kind: item.kind,
        status: "STAGING", storageKey: `${execution.attemptId}/${item.id}.${item.ext}`, visibility: "project",
        mimeType: item.mimeType, sizeBytes: 0, sha256: "pending", metadataJson: { readyPath: readyKey },
        writerLeaseOwner: "expired-writer", writerLeaseToken: `expired-${item.id}`,
        writerLeaseExpiresAtMs: Date.now() - 1, createdAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 60_000,
      });
    }
    await expect(recoverStagingArtifacts({ recoveryOwner: "container-validator" }))
      .resolves.toEqual({ claimed: 2, committed: 0, quarantined: 2 });
    expect((await db.select().from(generationArtifacts)).map((row) => row.status))
      .toEqual(["QUARANTINED", "QUARANTINED"]);
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
