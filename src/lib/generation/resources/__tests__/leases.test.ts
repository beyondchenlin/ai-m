/**
 * PR-11: 租约、原子领取与防旧写令牌测试
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  resourcePools,
  resourcePoolSlots,
  executionBackends,
  generationJobs,
  generationAttempts,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import {
  acquireResourceSlot,
  renewResourceSlot,
  releaseResourceSlot,
  claimJob,
  renewJobClaim,
  releaseJobClaim,
  scanExpiredClaims,
  LEASE_CONFIG,
} from "../leases";

async function createPoolWithSlots(capacity: number) {
  const poolId = crypto.randomUUID();
  const now = Date.now();
  await db.insert(resourcePools).values({
    id: poolId,
    displayName: "test-pool",
    capacity,
    policyJson: {},
    createdAtMs: now,
    updatedAtMs: now,
  });

  for (let i = 1; i <= capacity; i++) {
    await db.insert(resourcePoolSlots).values({
      resourcePoolId: poolId,
      slotNo: i,
      ownerAttemptId: null,
      leaseToken: null,
      fencingToken: 0,
      expiresAtMs: null,
      updatedAtMs: now,
    });
  }

  return poolId;
}

async function createBackendAndPool(capability = "image", capacity = 2) {
  const poolId = await createPoolWithSlots(capacity);
  const backendId = crypto.randomUUID();
  const now = Date.now();

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
    capabilitiesJson: [capability],
    createdAtMs: now,
    updatedAtMs: now,
  });

  return { poolId, backendId };
}

async function createQueuedJob(capability = "image") {
  const jobId = crypto.randomUUID();
  const now = Date.now();
  await db.insert(generationJobs).values({
    id: jobId,
    capability,
    status: "QUEUED",
    executionSnapshotJson: {},
    inputDigest: "digest",
    claimFencingToken: 0,
    createdAtMs: now,
    updatedAtMs: now,
  });
  return jobId;
}

async function createAttempt(jobId: string, backendId: string, poolId: string, overrides: Partial<typeof generationAttempts.$inferInsert> = {}) {
  const attemptId = crypto.randomUUID();
  const now = Date.now();
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
    ...overrides,
  });
  return attemptId;
}

describe("PR-11: 资源槽位租约", () => {
  let ctx: ReturnType<typeof setupTestDb>;

  beforeAll(() => {
    ctx = setupTestDb();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  beforeEach(async () => {
    await db.delete(resourcePoolSlots);
    await db.delete(generationAttempts);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
  });

  it("空闲槽位应被原子领取", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId);

    const slot = await acquireResourceSlot(poolId, attemptId, "worker-1");

    expect(slot).not.toBeNull();
    expect(slot!.slotNo).toBe(1);
    expect(slot!.fencingToken).toBe(1);
    expect(typeof slot!.leaseToken).toBe("string");

    const [row] = await db
      .select()
      .from(resourcePoolSlots)
      .where(and(eq(resourcePoolSlots.resourcePoolId, poolId), eq(resourcePoolSlots.slotNo, 1)));

    expect(row.ownerAttemptId).toBe(attemptId);
    expect(row.fencingToken).toBe(1);
  });

  it("槽位占满后应返回 null", async () => {
    const { poolId, backendId } = await createBackendAndPool("image", 1);
    const jobId1 = await createQueuedJob();
    const attemptId1 = await createAttempt(jobId1, backendId, poolId);
    await acquireResourceSlot(poolId, attemptId1, "worker-1");

    const jobId2 = await createQueuedJob();
    const attemptId2 = await createAttempt(jobId2, backendId, poolId);
    const slot = await acquireResourceSlot(poolId, attemptId2, "worker-2");
    expect(slot).toBeNull();
  });

  it("过期槽位应被重新领取", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId = await createQueuedJob();
    const oldAttempt = await createAttempt(jobId, backendId, poolId);
    const now = Date.now();

    await db
      .update(resourcePoolSlots)
      .set({
        ownerAttemptId: oldAttempt,
        leaseToken: "old-token",
        fencingToken: 1,
        expiresAtMs: now - 1,
        updatedAtMs: now,
      })
      .where(and(eq(resourcePoolSlots.resourcePoolId, poolId), eq(resourcePoolSlots.slotNo, 1)));

    const newJobId = await createQueuedJob();
    const newAttempt = await createAttempt(newJobId, backendId, poolId);
    const slot = await acquireResourceSlot(poolId, newAttempt, "worker-2");
    expect(slot).not.toBeNull();
    expect(slot!.fencingToken).toBe(2);
    expect(slot!.slotNo).toBe(1);
  });

  it("续租必须使用正确的 leaseToken 和 fencingToken", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId);
    const slot = (await acquireResourceSlot(poolId, attemptId, "worker-1"))!;

    const ok = await renewResourceSlot(poolId, slot.slotNo, slot.leaseToken, slot.fencingToken);
    expect(ok).toBe(true);

    const wrongToken = await renewResourceSlot(poolId, slot.slotNo, "wrong-token", slot.fencingToken);
    expect(wrongToken).toBe(false);

    const wrongFencing = await renewResourceSlot(poolId, slot.slotNo, slot.leaseToken, 999);
    expect(wrongFencing).toBe(false);
  });

  it("释放槽位必须使用正确的令牌", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId);
    const slot = (await acquireResourceSlot(poolId, attemptId, "worker-1"))!;

    const wrong = await releaseResourceSlot(poolId, slot.slotNo, "wrong-token", slot.fencingToken);
    expect(wrong).toBe(false);

    const ok = await releaseResourceSlot(poolId, slot.slotNo, slot.leaseToken, slot.fencingToken);
    expect(ok).toBe(true);

    const [row] = await db
      .select()
      .from(resourcePoolSlots)
      .where(and(eq(resourcePoolSlots.resourcePoolId, poolId), eq(resourcePoolSlots.slotNo, 1)));

    expect(row.ownerAttemptId).toBeNull();
    expect(row.expiresAtMs).toBeNull();
  });

  it("重复领取应递增 fencingToken", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId1 = await createQueuedJob();
    const attemptId1 = await createAttempt(jobId1, backendId, poolId);
    const slot1 = (await acquireResourceSlot(poolId, attemptId1, "worker-1"))!;

    await releaseResourceSlot(poolId, slot1.slotNo, slot1.leaseToken, slot1.fencingToken);

    const jobId2 = await createQueuedJob();
    const attemptId2 = await createAttempt(jobId2, backendId, poolId);
    const slot2 = await acquireResourceSlot(poolId, attemptId2, "worker-2");
    expect(slot2!.fencingToken).toBe(2);
  });

  it("并发领取时只应有一个 worker 成功", async () => {
    const { poolId, backendId } = await createBackendAndPool("image", 1);
    const jobs = await Promise.all([createQueuedJob(), createQueuedJob(), createQueuedJob()]);
    const attempts = await Promise.all(jobs.map((jobId) => createAttempt(jobId, backendId, poolId)));

    const results = await Promise.all(
      attempts.map((attemptId, i) => acquireResourceSlot(poolId, attemptId, `worker-${i}`)),
    );

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);

    const [row] = await db
      .select()
      .from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.resourcePoolId, poolId));
    expect(row.ownerAttemptId).not.toBeNull();
  });
});

describe("PR-11: 工作任务领取", () => {
  let ctx: ReturnType<typeof setupTestDb>;

  beforeAll(() => {
    ctx = setupTestDb();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  beforeEach(async () => {
    await db.delete(generationJobs);
  });

  it("应原子领取 QUEUED 任务", async () => {
    const jobId = await createQueuedJob();

    const job = await claimJob("worker-1", "image");

    expect(job).not.toBeNull();
    expect(job!.id).toBe(jobId);
    expect(job!.status).toBe("RUNNING");
    expect(job!.claimOwner).toBe("worker-1");
    expect(job!.claimFencingToken).toBe(1);
    expect(job!.claimUntilMs).toBeGreaterThan(Date.now());
  });

  it("无任务时应返回 null", async () => {
    const job = await claimJob("worker-1", "image");
    expect(job).toBeNull();
  });

  it("应只领取匹配 capability 的任务", async () => {
    await createQueuedJob("video");
    const job = await claimJob("worker-1", "image");
    expect(job).toBeNull();
  });

  it("续租应验证 fencingToken", async () => {
    await createQueuedJob();
    const job = (await claimJob("worker-1", "image"))!;

    const ok = await renewJobClaim(job.id, "worker-1", job.claimFencingToken);
    expect(ok).toBe(true);

    const wrong = await renewJobClaim(job.id, "worker-1", 999);
    expect(wrong).toBe(false);
  });

  it("过期回收后旧 fencingToken 应失效", async () => {
    await createQueuedJob();
    const first = (await claimJob("worker-1", "image"))!;

    // 模拟租约过期
    await db
      .update(generationJobs)
      .set({ claimUntilMs: Date.now() - 1 })
      .where(eq(generationJobs.id, first.id));

    // 恢复扫描器将 RUNNING 过期任务重置为 QUEUED
    await scanExpiredClaims();

    const second = (await claimJob("worker-2", "image"))!;
    expect(second.claimFencingToken).toBe(first.claimFencingToken + 1);

    const staleRenew = await renewJobClaim(second.id, "worker-1", first.claimFencingToken);
    expect(staleRenew).toBe(false);
  });

  it("释放任务应清空 claimOwner", async () => {
    await createQueuedJob();
    const job = (await claimJob("worker-1", "image"))!;

    const ok = await releaseJobClaim(job.id, "worker-1", job.claimFencingToken);
    expect(ok).toBe(true);

    const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
    expect(row.claimOwner).toBeNull();
    expect(row.claimUntilMs).toBeNull();
  });

  it("并发 claimJob 时只应有一个 worker 成功", async () => {
    const jobId = await createQueuedJob();

    const results = await Promise.all([
      claimJob("worker-1", "image"),
      claimJob("worker-2", "image"),
      claimJob("worker-3", "image"),
    ]);

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(jobId);
  });
});

describe("PR-11: 过期租约恢复扫描", () => {
  let ctx: ReturnType<typeof setupTestDb>;

  beforeAll(() => {
    ctx = setupTestDb();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  beforeEach(async () => {
    await db.delete(resourcePoolSlots);
    await db.delete(generationAttempts);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
    await db.delete(generationJobs);
  });

  it("应恢复过期工作任务并释放过期资源槽位", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId);
    const now = Date.now();

    await db
      .update(generationJobs)
      .set({
        status: "RUNNING",
        claimOwner: "ghost-worker",
        claimUntilMs: now - 1,
        updatedAtMs: now,
      })
      .where(eq(generationJobs.id, jobId));

    await db
      .update(resourcePoolSlots)
      .set({
        ownerAttemptId: attemptId,
        leaseToken: "old-token",
        expiresAtMs: now - 1,
        updatedAtMs: now,
      })
      .where(and(eq(resourcePoolSlots.resourcePoolId, poolId), eq(resourcePoolSlots.slotNo, 1)));

    const result = await scanExpiredClaims();

    expect(result.expiredJobs).toContain(jobId);
    expect(result.expiredSlots).toContainEqual({ poolId, slotNo: 1 });

    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    expect(job.status).toBe("QUEUED");
    expect(job.claimOwner).toBeNull();

    const [slot] = await db
      .select()
      .from(resourcePoolSlots)
      .where(and(eq(resourcePoolSlots.resourcePoolId, poolId), eq(resourcePoolSlots.slotNo, 1)));
    expect(slot.ownerAttemptId).toBeNull();
    expect(slot.expiresAtMs).toBeNull();
  });
});
