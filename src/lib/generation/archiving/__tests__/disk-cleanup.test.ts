import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import {
  executionBackends,
  generationArtifacts,
  generationAttempts,
  generationJobs,
  projects,
  resourcePools,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { setupTestDb } from "@/lib/test-helpers/db";
import { cleanupExpiredArtifacts, cleanupOrphanedArtifacts } from "../disk-cleanup";
import { commitArtifactFromBuffer } from "../commit";
import { ArtifactKind, ArtifactVisibility } from "@/lib/generation/naming";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function createMinimalAttempt() {
  const now = Date.now();
  const projectId = randomUUID();
  const poolId = randomUUID();
  const backendId = randomUUID();
  const jobId = randomUUID();
  const attemptId = randomUUID();
  await db.insert(projects).values({ id: projectId, userId: "owner", title: "cleanup-test" });
  await db.insert(resourcePools).values({ id: poolId, displayName: "pool", capacity: 1, policyJson: {}, createdAtMs: now, updatedAtMs: now });
  await db.insert(executionBackends).values({
    id: backendId, displayName: "backend", adapterKind: "comfyui", baseUrl: "http://localhost:8188",
    topology: "same-host", sharingMode: "dedicated", authType: "none", authConfigJson: {}, tlsConfigJson: {},
    networkPolicyJson: {}, resourcePoolId: poolId, capabilitiesJson: { capabilities: ["image"] }, createdAtMs: now, updatedAtMs: now,
  });
  await db.insert(generationJobs).values({
    id: jobId, projectId, requestedBy: "owner", capability: "image", status: "RUNNING", executionSnapshotJson: {},
    inputDigest: "digest", currentAttemptId: null, claimFencingToken: 1, createdAtMs: now, updatedAtMs: now,
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

describe("PR-12 disk cleanup safety", () => {
  let ctx: ReturnType<typeof setupTestDb>;
  let root: string;

  beforeAll(() => {
    ctx = setupTestDb();
    process.env.FF_V2_MEDIA_ARCHIVING = "true";
  });
  afterAll(() => ctx.cleanup());

  beforeEach(async () => {
    await db.delete(generationArtifacts);
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
    await db.delete(projects);
    root = path.join(os.tmpdir(), `ai-m-cleanup-${randomUUID()}`);
    process.env.UPLOAD_DIR = root;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("never expires a committed business artifact implicitly", async () => {
    const { attemptId } = await createMinimalAttempt();
    const artifactId = randomUUID();
    const storageKey = `${attemptId}/${artifactId}.png`;
    const file = path.join(root, "generation-artifacts", storageKey);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, pngBytes);
    await db.insert(generationArtifacts).values({
      id: artifactId, attemptId, logicalName: "keep.png", kind: "image", storageKey,
      mimeType: "image/png", sizeBytes: pngBytes.length, sha256: "a".repeat(64), status: "COMMITTED",
      visibility: "project", metadataJson: {}, createdAtMs: 1, updatedAtMs: 1, committedAtMs: 1,
    });
    const stats = await cleanupExpiredArtifacts(path.join(root, "generation-artifacts"), { maxRetentionDays: 1 });
    expect(stats.deletedFiles).toBe(0);
    await expect(fs.access(file)).resolves.toBeUndefined();
  });

  it("physically removes only old quarantined or deleted records", async () => {
    const { attemptId } = await createMinimalAttempt();
    const artifactId = randomUUID();
    const storageKey = `${attemptId}/${artifactId}.png`;
    const artifactRoot = path.join(root, "generation-artifacts");
    const file = path.join(artifactRoot, storageKey);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, pngBytes);
    await db.insert(generationArtifacts).values({
      id: artifactId, attemptId, logicalName: "quarantine.png", kind: "image", storageKey,
      mimeType: "image/png", sizeBytes: pngBytes.length, sha256: "b".repeat(64), status: "QUARANTINED",
      visibility: "project", metadataJson: {}, createdAtMs: 1, updatedAtMs: 1,
    });
    const stats = await cleanupExpiredArtifacts(artifactRoot, { maxRetentionDays: 1 });
    expect(stats.deletedFiles).toBe(1);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("deletes only orphan files older than the grace period", async () => {
    const artifactRoot = path.join(root, "generation-artifacts");
    const file = path.join(artifactRoot, "orphan", "lonely.png");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, pngBytes);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(file, old, old);
    const stats = await cleanupOrphanedArtifacts(artifactRoot, { orphanGraceMs: 60_000 });
    expect(stats.deletedFiles).toBe(1);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("rejects content beyond the configured stream limit", async () => {
    const { attemptId } = await createMinimalAttempt();
    await expect(commitArtifactFromBuffer(new Uint8Array(1024), {
      attemptId, expectedJobClaimFencingToken: 1, logicalName: "big.png", kind: ArtifactKind.IMAGE,
      mimeType: "image/png", visibility: ArtifactVisibility.PROJECT, maxSizeBytes: 100,
    })).rejects.toThrow(/Artifact exceeds 100 bytes/);
  });
});
