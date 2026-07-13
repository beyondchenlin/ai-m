/**
 * PR-11: 磁盘清理与大文件边界测试
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { db } from "@/lib/db";
import { generationArtifacts, generationAttempts, generationJobs, resourcePools, executionBackends } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { setupTestDb } from "@/lib/test-helpers/db";
import { cleanupExpiredArtifacts, cleanupOrphanedArtifacts } from "../disk-cleanup";
import { commitArtifactFromBuffer } from "../commit";
import { ArtifactKind, ArtifactVisibility } from "@/lib/generation/naming";

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
  0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function createMinimalAttempt() {
  const now = Date.now();
  const poolId = randomUUID();
  const backendId = randomUUID();
  const jobId = randomUUID();
  const attemptId = randomUUID();

  await db.insert(resourcePools).values({
    id: poolId,
    displayName: "test-pool",
    capacity: 1,
    policyJson: {},
    createdAtMs: now,
    updatedAtMs: now,
  });

  await db.insert(executionBackends).values({
    id: backendId,
    displayName: "test-backend",
    adapterKind: "zimage-http",
    baseUrl: "http://localhost:8188",
    topology: "same-host",
    sharingMode: "dedicated",
    authType: "none",
    authConfigJson: {},
    tlsConfigJson: {},
    networkPolicyJson: {},
    resourcePoolId: poolId,
    capabilitiesJson: ["image"],
    createdAtMs: now,
    updatedAtMs: now,
  });

  await db.insert(generationJobs).values({
    id: jobId,
    capability: "image",
    status: "QUEUED",
    executionSnapshotJson: {},
    inputDigest: "digest",
    claimFencingToken: 0,
    createdAtMs: now,
    updatedAtMs: now,
  });

  await db.insert(generationAttempts).values({
    id: attemptId,
    jobId,
    attemptNo: 1,
    phase: "SUBMITTING",
    backendId,
    backendFeatureSnapshotJson: {},
    environmentFingerprint: "env:test",
    submissionCorrelationId: `corr-${attemptId}`,
    externalIdStrategy: "server-assigned",
    systemOutputPrefix: `prefix-${attemptId}`,
    resourcePoolId: poolId,
    resourceSlotNo: 0,
    resourceLeaseToken: `token-${attemptId}`,
    resourceFencingToken: 0,
    createdAtMs: now,
    updatedAtMs: now,
  });

  return { attemptId, jobId };
}

describe("PR-11: 磁盘清理", () => {
  let ctx: ReturnType<typeof setupTestDb>;
  let artifactsRoot: string;

  beforeAll(() => {
    ctx = setupTestDb();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  beforeEach(async () => {
    await db.delete(generationArtifacts);
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
    if (artifactsRoot) {
      await fs.rm(artifactsRoot, { recursive: true, force: true });
    }
    artifactsRoot = path.join(os.tmpdir(), `ai-m-cleanup-${randomUUID()}`);
  });

  it("应清理过期工件并更新数据库状态", async () => {
    const { attemptId } = await createMinimalAttempt();
    const artifactId = randomUUID();
    const storageKey = `expired-${artifactId}.png`;
    const filePath = path.join(artifactsRoot, storageKey);
    await fs.mkdir(artifactsRoot, { recursive: true });
    await fs.writeFile(filePath, pngBytes);

    await db.insert(generationArtifacts).values({
      id: artifactId,
      attemptId,
      logicalName: "preview.png",
      kind: "image",
      storageKey,
      mimeType: "image/png",
      sizeBytes: pngBytes.length,
      sha256: "sha",
      status: "COMMITTED",
      visibility: "project",
      metadataJson: {},
      createdAtMs: 1,
      committedAtMs: 1,
    });

    const stats = await cleanupExpiredArtifacts(artifactsRoot, {
      maxRetentionDays: 1,
      batchSize: 100,
    });

    expect(stats.deletedFiles).toBe(1);

    const [row] = await db.select().from(generationArtifacts).where(eq(generationArtifacts.id, artifactId));
    expect(row.status).toBe("DELETED");
  });

  it("应清理孤立文件", async () => {
    const orphanDir = path.join(artifactsRoot, "orphan");
    await fs.mkdir(orphanDir, { recursive: true });
    const orphanFile = path.join(orphanDir, "lonely.png");
    await fs.writeFile(orphanFile, pngBytes);

    const stats = await cleanupOrphanedArtifacts(artifactsRoot);

    expect(stats.deletedFiles).toBe(1);
    await expect(fs.access(orphanFile)).rejects.toThrow();
  });
});

describe("PR-11: 大文件边界", () => {
  let ctx: ReturnType<typeof setupTestDb>;

  beforeAll(() => {
    ctx = setupTestDb();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  beforeEach(async () => {
    await db.delete(generationArtifacts);
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
  });

  it("应拒绝超过 maxSizeBytes 的大文件", async () => {
    const { attemptId } = await createMinimalAttempt();
    const bigBuffer = new Uint8Array(1024);

    await expect(
      commitArtifactFromBuffer(bigBuffer, {
        attemptId,
        logicalName: "big.png",
        kind: ArtifactKind.IMAGE,
        mimeType: "image/png",
        visibility: ArtifactVisibility.PROJECT,
        maxSizeBytes: 100,
      }),
    ).rejects.toThrow(/exceeds max size/);
  });
});
