/**
 * PR-11: 安全媒体归档与工件权限测试
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import {
  resourcePools,
  executionBackends,
  generationJobs,
  generationAttempts,
  generationArtifacts,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import { eq } from "drizzle-orm";
import {
  validateMagicBytes,
  streamCommitArtifact,
  commitArtifactFromBuffer,
  checkArtifactAccess,
  cleanupStagingDir,
} from "../commit";
import { ArtifactKind, ArtifactVisibility } from "@/lib/generation/naming";

const artifactsDir = path.resolve(process.cwd(), "data", "artifacts");

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

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

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
    networkPolicyJson: { allowRedirect: false, allowedHosts: [], allowedCidrs: [] },
    resourcePoolId: poolId,
    capabilitiesJson: ["image"],
    createdAtMs: now,
    updatedAtMs: now,
  });

  await db.insert(generationJobs).values({
    id: jobId,
    capability: "image",
    status: "RUNNING",
    executionSnapshotJson: { backendId },
    inputDigest: "digest",
    claimFencingToken: 1,
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
    systemOutputPrefix: "prefix",
    resourcePoolId: poolId,
    resourceSlotNo: 1,
    resourceLeaseToken: `token-${attemptId}`,
    resourceFencingToken: 1,
    createdAtMs: now,
    updatedAtMs: now,
  });

  return { attemptId, jobId };
}

describe("PR-11: 魔数校验", () => {
  it("应识别 PNG 魔数", () => {
    expect(validateMagicBytes(pngBytes, "image/png")).toBe(true);
  });

  it("应识别 JPEG 魔数", () => {
    expect(validateMagicBytes(jpegBytes, "image/jpeg")).toBe(true);
  });

  it("声明 PNG 但提供 JPEG 魔数时应失败", () => {
    expect(validateMagicBytes(jpegBytes, "image/png")).toBe(false);
  });

  it("未知 MIME 类型应跳过魔数校验", () => {
    expect(validateMagicBytes(new Uint8Array([0x00, 0x01]), "application/octet-stream")).toBe(true);
  });

  it("过小的缓冲区应失败", () => {
    expect(validateMagicBytes(new Uint8Array([0x89]), "image/png")).toBe(false);
  });
});

describe("PR-11: 流式工件提交", () => {
  let ctx: ReturnType<typeof setupTestDb>;

  beforeAll(() => {
    ctx = setupTestDb();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  beforeEach(async () => {
    await db.delete(generationArtifacts);
  });

  afterEach(async () => {
    // 清理测试产生的数据目录
    try {
      await fs.rm(path.resolve(process.cwd(), "data", "task-staging"), { recursive: true, force: true });
      await fs.rm(path.resolve(process.cwd(), "data", "artifacts"), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("应成功提交 PNG 工件并写入数据库", async () => {
    const { attemptId } = await createMinimalAttempt();

    const result = await commitArtifactFromBuffer(pngBytes, {
      attemptId,
      logicalName: "preview.png",
      kind: ArtifactKind.IMAGE,
      mimeType: "image/png",
      visibility: ArtifactVisibility.PROJECT,
    });

    expect(result.sizeBytes).toBe(pngBytes.length);
    expect(result.mimeType).toBe("image/png");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(path.join(artifactsDir, result.storageKey))).toBe(true);

    const [row] = await db
      .select()
      .from(generationArtifacts)
      .where(eq(generationArtifacts.id, result.id));

    expect(row).toBeDefined();
    expect(row.status).toBe("COMMITTED");
    expect(row.visibility).toBe("project");
  });

  it("超过 maxSizeBytes 应拒绝且不出现在发布目录", async () => {
    const { attemptId } = await createMinimalAttempt();

    await expect(
      commitArtifactFromBuffer(pngBytes, {
        attemptId,
        logicalName: "preview.png",
        kind: ArtifactKind.IMAGE,
        mimeType: "image/png",
        visibility: ArtifactVisibility.PROJECT,
        maxSizeBytes: 10,
      }),
    ).rejects.toThrow(/exceeds max size/);

    const rows = await db.select().from(generationArtifacts);
    expect(rows).toHaveLength(0);
  });

  it("空工件应被拒绝", async () => {
    const { attemptId } = await createMinimalAttempt();

    await expect(
      commitArtifactFromBuffer(new Uint8Array(0), {
        attemptId,
        logicalName: "empty.png",
        kind: ArtifactKind.IMAGE,
        mimeType: "image/png",
        visibility: ArtifactVisibility.PROJECT,
      }),
    ).rejects.toThrow(/Artifact is empty/);
  });

  it("魔数不匹配应被拒绝", async () => {
    const { attemptId } = await createMinimalAttempt();

    await expect(
      commitArtifactFromBuffer(jpegBytes, {
        attemptId,
        logicalName: "fake.png",
        kind: ArtifactKind.IMAGE,
        mimeType: "image/png",
        visibility: ArtifactVisibility.PROJECT,
      }),
    ).rejects.toThrow(/Magic bytes validation failed/);
  });

  it("应清理指定尝试的暂存目录", async () => {
    const { attemptId } = await createMinimalAttempt();
    const stagingDir = path.resolve(process.cwd(), "data", "task-staging", attemptId);
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(path.join(stagingDir, "temp.tmp"), "temp");

    await cleanupStagingDir(attemptId);

    expect(existsSync(stagingDir)).toBe(false);
  });
});

describe("PR-11: 工件访问控制", () => {
  let ctx: ReturnType<typeof setupTestDb>;
  let attemptId: string;

  beforeAll(async () => {
    ctx = setupTestDb();
    const created = await createMinimalAttempt();
    attemptId = created.attemptId;
  });

  afterAll(() => {
    ctx.cleanup();
  });

  it("不存在的工件应被拒绝", async () => {
    const access = await checkArtifactAccess("non-existent-id", "user-1", "project-1");
    expect(access.allowed).toBe(false);
    expect(access.reason).toMatch(/Artifact not found/);
  });

  it("非 COMMITTED 状态的工件应被拒绝", async () => {
    const id = randomUUID();
    await db.insert(generationArtifacts).values({
      id,
      attemptId,
      logicalName: "staging.png",
      kind: ArtifactKind.IMAGE,
      status: "STAGING",
      storageKey: "artifacts/staging.png",
      visibility: ArtifactVisibility.PROJECT,
      mimeType: "image/png",
      sizeBytes: 100,
      sha256: "a".repeat(64),
      metadataJson: {},
      createdAtMs: Date.now(),
    });

    const access = await checkArtifactAccess(id, "user-1", "project-1");
    expect(access.allowed).toBe(false);
    expect(access.reason).toMatch(/not available/);
  });

  it("private-original 工件应被拒绝公开访问", async () => {
    const id = randomUUID();
    await db.insert(generationArtifacts).values({
      id,
      attemptId,
      logicalName: "private.png",
      kind: ArtifactKind.IMAGE,
      status: "COMMITTED",
      storageKey: "artifacts/private.png",
      visibility: ArtifactVisibility.PRIVATE_ORIGINAL,
      mimeType: "image/png",
      sizeBytes: 100,
      sha256: "b".repeat(64),
      metadataJson: {},
      createdAtMs: Date.now(),
      committedAtMs: Date.now(),
    });

    const access = await checkArtifactAccess(id, "user-1", "project-1");
    expect(access.allowed).toBe(false);
    expect(access.reason).toMatch(/private/);
  });

  it("COMMITTED 且 project 可见性的工件应允许访问", async () => {
    const id = randomUUID();
    await db.insert(generationArtifacts).values({
      id,
      attemptId,
      logicalName: "public.png",
      kind: ArtifactKind.IMAGE,
      status: "COMMITTED",
      storageKey: "artifacts/public.png",
      visibility: ArtifactVisibility.PROJECT,
      mimeType: "image/png",
      sizeBytes: 100,
      sha256: "c".repeat(64),
      metadataJson: {},
      createdAtMs: Date.now(),
      committedAtMs: Date.now(),
    });

    const access = await checkArtifactAccess(id, "user-1", "project-1");
    expect(access.allowed).toBe(true);
  });
});
