/**
 * PR-11: 租约、原子领取与防旧写令牌测试
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { db, getSqlite } from "@/lib/db";
import {
  resourcePools,
  resourcePoolSlots,
  executionBackends,
  generationJobs,
  generationAttempts,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import { terminateChildProcess } from "@/lib/test-helpers/child-process";
import {
  acquireResourceSlot,
  InvalidResourceCardinalityError,
  renewResourceSlot,
  releaseResourceSlot,
  claimJob,
  renewJobClaim,
  releaseJobClaim,
  scanExpiredClaims,
} from "../leases";
import { recoverExpiredJob } from "@/lib/generation/jobs/state-transitions";

const renewOwnedResourceSlot = renewResourceSlot as unknown as (
  resourcePoolId: string,
  slotNo: number,
  leaseToken: string,
  fencingToken: number,
  workerId: string,
) => Promise<boolean>;

function spawnAcquireProcess(input: {
  dbPath: string;
  poolId: string;
  attemptId: string;
  workerId: string;
  readyPath: string;
  goPath: string;
}): {
  child: ChildProcess;
  result: Promise<Awaited<ReturnType<typeof acquireResourceSlot>>>;
} {
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { acquireResourceSlot } from "./src/lib/generation/resources/leases.ts";
    void (async () => {
      writeFileSync(${JSON.stringify(input.readyPath)}, "ready");
      while (!existsSync(${JSON.stringify(input.goPath)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const result = await acquireResourceSlot(
        ${JSON.stringify(input.poolId)},
        ${JSON.stringify(input.attemptId)},
        ${JSON.stringify(input.workerId)},
      );
      process.stdout.write(JSON.stringify(result));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${input.dbPath}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = new Promise<Awaited<ReturnType<typeof acquireResourceSlot>>>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`acquire child exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout) as Awaited<ReturnType<typeof acquireResourceSlot>>);
    });
  });
  return { child, result };
}

async function waitForFiles(paths: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for acquire barriers: ${paths.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
    capabilitiesJson: { capabilities: [capability] },
    createdAtMs: now,
    updatedAtMs: now,
  });

  return { poolId, backendId };
}

async function createQueuedJob(capability: typeof generationJobs.$inferInsert.capability = "image") {
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

async function createAttempt(
  jobId: string,
  backendId: string,
  poolId: string,
  overrides: Partial<typeof generationAttempts.$inferInsert> = {},
  workerId = "worker-1",
) {
  const attemptId = crypto.randomUUID();
  const now = Date.now();
  await db.insert(generationAttempts).values({
    id: attemptId,
    jobId,
    attemptNo: 1,
    phase: "PREPARING",
    backendId,
    backendFeatureSnapshotJson: {},
    environmentFingerprint: "env:test",
    submissionCorrelationId: `corr-${attemptId}`,
    externalIdStrategy: "server-assigned",
    systemOutputPrefix: `prefix-${attemptId}`,
    resourcePoolId: poolId,
    resourceSlotNo: 0,
    resourceLeaseToken: `pending-${attemptId}`,
    resourceFencingToken: 0,
    createdAtMs: now,
    updatedAtMs: now,
    ...overrides,
  });
  await db.update(generationJobs).set({
    status: "RUNNING",
    currentAttemptId: attemptId,
    claimOwner: workerId,
    claimUntilMs: now + 60_000,
    claimFencingToken: overrides.jobClaimFencingToken ?? 0,
  }).where(eq(generationJobs.id, jobId));
  return attemptId;
}

async function createOwnedPreparingAttempt(input: { claimUntilMs: number; workerId?: string }) {
  const workerId = input.workerId ?? "worker-1";
  const { poolId, backendId } = await createBackendAndPool("image", 1);
  const jobId = await createQueuedJob();
  const attemptId = await createAttempt(jobId, backendId, poolId, {
    phase: "PREPARING",
    jobClaimFencingToken: 4,
    resourceSlotNo: 0,
    resourceLeaseToken: "pending-placeholder",
    resourceFencingToken: 0,
  });
  await db.update(generationAttempts).set({
    resourceLeaseToken: `pending-${attemptId}`,
  }).where(eq(generationAttempts.id, attemptId));
  await db.update(generationJobs).set({
    status: "RUNNING",
    currentAttemptId: attemptId,
    claimOwner: workerId,
    claimUntilMs: input.claimUntilMs,
    claimFencingToken: 4,
  }).where(eq(generationJobs.id, jobId));
  return { poolId, backendId, jobId, attemptId, workerId };
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
    getSqlite().exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS resource_pool_slots_owner_attempt_unique
      ON resource_pool_slots (owner_attempt_id) WHERE owner_attempt_id IS NOT NULL
    `);
  });

  it("rejects an old resource acquisition after job recovery commits first", async () => {
    const now = Date.now();
    const seeded = await createOwnedPreparingAttempt({ claimUntilMs: now - 1 });
    const result = recoverExpiredJob({
      claimKind: "expired",
      jobId: seeded.jobId,
      jobStatus: "RUNNING",
      claimOwner: seeded.workerId,
      claimUntilMs: now - 1,
      claimFencingToken: 4,
      currentAttemptId: seeded.attemptId,
      attempt: {
        id: seeded.attemptId,
        phase: "PREPARING",
        jobClaimFencingToken: 4,
        externalJobId: null,
      },
    }, undefined, () => now);
    expect(result).toEqual({ status: "applied", disposition: "requeued" });

    expect(await acquireResourceSlot(seeded.poolId, seeded.attemptId, seeded.workerId)).toBeNull();
  });

  it("rejects resource acquisition from a malformed preparing identity", async () => {
    const seeded = await createOwnedPreparingAttempt({ claimUntilMs: Date.now() + 60_000 });
    await db.update(generationAttempts).set({ resourceLeaseToken: "not-a-placeholder" })
      .where(eq(generationAttempts.id, seeded.attemptId));

    expect(await acquireResourceSlot(seeded.poolId, seeded.attemptId, seeded.workerId)).toBeNull();
  });

  it("rejects slot renewal after the owning job claim expires", async () => {
    const now = Date.now();
    const seeded = await createOwnedPreparingAttempt({ claimUntilMs: now + 60_000 });
    const slot = await acquireResourceSlot(seeded.poolId, seeded.attemptId, seeded.workerId);
    expect(slot).not.toBeNull();
    await db.update(generationAttempts).set({
      resourceSlotNo: slot!.slotNo,
      resourceLeaseToken: slot!.leaseToken,
      resourceFencingToken: slot!.fencingToken,
    }).where(eq(generationAttempts.id, seeded.attemptId));
    await db.update(generationJobs).set({ claimUntilMs: now - 1 })
      .where(eq(generationJobs.id, seeded.jobId));

    expect(await renewOwnedResourceSlot(
      seeded.poolId,
      slot!.slotNo,
      slot!.leaseToken,
      slot!.fencingToken,
      seeded.workerId,
    )).toBe(false);
  });

  it("does not resurrect a resource lease at its exact expiry boundary", async () => {
    const now = Date.now();
    const seeded = await createOwnedPreparingAttempt({ claimUntilMs: now + 60_000 });
    const slot = await acquireResourceSlot(seeded.poolId, seeded.attemptId, seeded.workerId);
    expect(slot).not.toBeNull();
    await db.update(generationAttempts).set({
      resourceSlotNo: slot!.slotNo,
      resourceLeaseToken: slot!.leaseToken,
      resourceFencingToken: slot!.fencingToken,
    }).where(eq(generationAttempts.id, seeded.attemptId));
    await db.update(resourcePoolSlots).set({ expiresAtMs: now })
      .where(and(
        eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
        eq(resourcePoolSlots.slotNo, slot!.slotNo),
      ));

    expect(await renewResourceSlot(
      seeded.poolId,
      slot!.slotNo,
      slot!.leaseToken,
      slot!.fencingToken,
      seeded.workerId,
      db,
      () => now,
    )).toBe(false);
  });

  it("renews a terminal attempt slot while its claim is held for managed restart readiness", async () => {
    const seeded = await createOwnedPreparingAttempt({ claimUntilMs: Date.now() + 60_000 });
    const slot = (await acquireResourceSlot(seeded.poolId, seeded.attemptId, seeded.workerId))!;
    await db.update(generationAttempts).set({
      phase: "SUCCEEDED",
      resourceSlotNo: slot.slotNo,
      resourceLeaseToken: slot.leaseToken,
      resourceFencingToken: slot.fencingToken,
    }).where(eq(generationAttempts.id, seeded.attemptId));
    await db.update(generationJobs).set({ status: "SUCCEEDED" }).where(eq(generationJobs.id, seeded.jobId));

    expect(await renewOwnedResourceSlot(
      seeded.poolId, slot.slotNo, slot.leaseToken, slot.fencingToken, seeded.workerId,
    )).toBe(true);
  });

  it("空闲槽位应被原子领取", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId, { phase: "PREPARING" });

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

  it("returns the same physical lease when one attempt acquires twice sequentially", async () => {
    const { poolId, backendId } = await createBackendAndPool("image", 2);
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId, { phase: "PREPARING" });

    const first = await acquireResourceSlot(poolId, attemptId, "worker-1");
    const second = await acquireResourceSlot(poolId, attemptId, "worker-1");

    expect(second).toEqual(first);
    const owned = await db.select().from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.ownerAttemptId, attemptId));
    expect(owned).toHaveLength(1);

    const nextJobId = await createQueuedJob();
    const nextAttemptId = await createAttempt(nextJobId, backendId, poolId, {}, "worker-2");
    const next = await acquireResourceSlot(poolId, nextAttemptId, "worker-2");
    expect(next?.slotNo).toBe(2);
  });

  it("returns exactly one physical lease across truly concurrent process acquisitions", async () => {
    const { poolId, backendId } = await createBackendAndPool("image", 2);
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId, { phase: "PREPARING" });
    const barrierId = crypto.randomUUID();
    const goPath = `${ctx.dbPath}.${barrierId}.go`;
    const readyPaths = [1, 2].map((number) => `${ctx.dbPath}.${barrierId}.ready-${number}`);
    const acquisitions = readyPaths.map((readyPath) => spawnAcquireProcess({
      dbPath: ctx.dbPath,
      poolId,
      attemptId,
      workerId: "worker-1",
      readyPath,
      goPath,
    }));
    try {
      await waitForFiles(readyPaths);
      writeFileSync(goPath, "go");
      const [left, right] = await Promise.all(acquisitions.map(({ result }) => result));

      expect(left).toEqual(right);
      const owned = await db.select().from(resourcePoolSlots)
        .where(eq(resourcePoolSlots.ownerAttemptId, attemptId));
      expect(owned).toHaveLength(1);
    } finally {
      await Promise.allSettled(acquisitions.map(({ child }) => terminateChildProcess(child)));
      rmSync(goPath, { force: true });
      for (const readyPath of readyPaths) rmSync(readyPath, { force: true });
    }
  }, 20_000);

  it("keeps a second worker out while the first worker holds the slot through managed readiness", async () => {
    const { poolId, backendId } = await createBackendAndPool("image", 1);
    const firstJobId = await createQueuedJob();
    const firstAttemptId = await createAttempt(firstJobId, backendId, poolId, { phase: "PREPARING" });
    const first = (await acquireResourceSlot(poolId, firstAttemptId, "worker-1"))!;
    const secondJobId = await createQueuedJob();
    const secondAttemptId = await createAttempt(secondJobId, backendId, poolId, { phase: "PREPARING" }, "worker-2");
    const barrierId = crypto.randomUUID();
    const readyPath = `${ctx.dbPath}.${barrierId}.ready`;
    const goPath = `${ctx.dbPath}.${barrierId}.go`;
    const competing = spawnAcquireProcess({
      dbPath: ctx.dbPath,
      poolId,
      attemptId: secondAttemptId,
      workerId: "worker-2",
      readyPath,
      goPath,
    });
    try {
      await waitForFiles([readyPath]);
      writeFileSync(goPath, "readiness-still-pending");
      await expect(competing.result).resolves.toBeNull();

      expect(await releaseResourceSlot(
        poolId, first.slotNo, firstAttemptId, first.leaseToken, first.fencingToken,
      )).toBe(true);
      await expect(acquireResourceSlot(poolId, secondAttemptId, "worker-2")).resolves.not.toBeNull();
    } finally {
      await terminateChildProcess(competing.child);
      rmSync(goPath, { force: true });
      rmSync(readyPath, { force: true });
    }
  }, 20_000);

  it("槽位占满后应返回 null", async () => {
    const { poolId, backendId } = await createBackendAndPool("image", 1);
    const jobId1 = await createQueuedJob();
    const attemptId1 = await createAttempt(jobId1, backendId, poolId, { phase: "PREPARING" });
    await acquireResourceSlot(poolId, attemptId1, "worker-1");

    const jobId2 = await createQueuedJob();
    const attemptId2 = await createAttempt(jobId2, backendId, poolId, {}, "worker-2");
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
    const newAttempt = await createAttempt(newJobId, backendId, poolId, {}, "worker-2");
    const slot = await acquireResourceSlot(poolId, newAttempt, "worker-2");
    expect(slot).not.toBeNull();
    // Expiry alone cannot prove that external inference stopped. The retained
    // slot stays fenced; another genuinely free slot may still be used.
    expect(slot!.fencingToken).toBe(1);
    expect(slot!.slotNo).toBe(2);
  });

  it("续租必须使用正确的 leaseToken 和 fencingToken", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId);
    const slot = (await acquireResourceSlot(poolId, attemptId, "worker-1"))!;
    await db.update(generationAttempts).set({
      resourceSlotNo: slot.slotNo,
      resourceLeaseToken: slot.leaseToken,
      resourceFencingToken: slot.fencingToken,
    }).where(eq(generationAttempts.id, attemptId));

    const ok = await renewResourceSlot(poolId, slot.slotNo, slot.leaseToken, slot.fencingToken, "worker-1");
    expect(ok).toBe(true);

    const wrongToken = await renewResourceSlot(poolId, slot.slotNo, "wrong-token", slot.fencingToken, "worker-1");
    expect(wrongToken).toBe(false);

    const wrongFencing = await renewResourceSlot(poolId, slot.slotNo, slot.leaseToken, 999, "worker-1");
    expect(wrongFencing).toBe(false);
  });

  it("quarantines and retains every legacy duplicate slot instead of renewing one", async () => {
    const { poolId, backendId } = await createBackendAndPool("image", 2);
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId);
    const slot = (await acquireResourceSlot(poolId, attemptId, "worker-1"))!;
    await db.update(generationAttempts).set({
      resourceSlotNo: slot.slotNo,
      resourceLeaseToken: slot.leaseToken,
      resourceFencingToken: slot.fencingToken,
    }).where(eq(generationAttempts.id, attemptId));
    getSqlite().exec("DROP INDEX resource_pool_slots_owner_attempt_unique");
    await db.update(resourcePoolSlots).set({
      ownerAttemptId: attemptId,
      leaseToken: `legacy-renew-extra-${attemptId}`,
      fencingToken: 31,
      expiresAtMs: Date.now() + 60_000,
    }).where(and(eq(resourcePoolSlots.resourcePoolId, poolId), eq(resourcePoolSlots.slotNo, 2)));

    expect(await renewResourceSlot(
      poolId, slot.slotNo, slot.leaseToken, slot.fencingToken, "worker-1",
    )).toBe(false);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(job.status).toBe("NEEDS_ATTENTION");
    expect(attempt).toMatchObject({ phase: "ORPHANED", errorCode: "invalid_resource_cardinality" });
    expect(await db.select().from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.ownerAttemptId, attemptId))).toHaveLength(2);
  });

  it("quarantines and retains every legacy duplicate slot instead of releasing one", async () => {
    const { poolId, backendId } = await createBackendAndPool("image", 2);
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId);
    const slot = (await acquireResourceSlot(poolId, attemptId, "worker-1"))!;
    getSqlite().exec("DROP INDEX resource_pool_slots_owner_attempt_unique");
    await db.update(resourcePoolSlots).set({
      ownerAttemptId: attemptId,
      leaseToken: `legacy-release-extra-${attemptId}`,
      fencingToken: 37,
      expiresAtMs: Date.now() + 60_000,
    }).where(and(eq(resourcePoolSlots.resourcePoolId, poolId), eq(resourcePoolSlots.slotNo, 2)));

    expect(await releaseResourceSlot(
      poolId, slot.slotNo, attemptId, slot.leaseToken, slot.fencingToken,
    )).toBe(false);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(job.status).toBe("NEEDS_ATTENTION");
    expect(attempt).toMatchObject({ phase: "ORPHANED", errorCode: "invalid_resource_cardinality" });
    expect(await db.select().from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.ownerAttemptId, attemptId))).toHaveLength(2);
  });

  it.each([
    ["SUCCEEDED", "SUCCEEDED"],
    ["CANCELLED", "CANCELLED"],
    ["FAILED", "FAILED"],
  ] as const)("retains terminal %s state and every legacy duplicate slot on release", async (jobStatus, attemptPhase) => {
    const { poolId, backendId } = await createBackendAndPool("image", 2);
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId);
    const slot = (await acquireResourceSlot(poolId, attemptId, "worker-1"))!;
    getSqlite().exec("DROP INDEX resource_pool_slots_owner_attempt_unique");
    await db.update(resourcePoolSlots).set({
      ownerAttemptId: attemptId,
      leaseToken: `legacy-terminal-extra-${attemptId}`,
      fencingToken: 41,
      expiresAtMs: Date.now() + 60_000,
    }).where(and(eq(resourcePoolSlots.resourcePoolId, poolId), eq(resourcePoolSlots.slotNo, 2)));
    await db.update(generationAttempts).set({
      phase: attemptPhase,
      resourceSlotNo: slot.slotNo,
      resourceLeaseToken: slot.leaseToken,
      resourceFencingToken: slot.fencingToken,
      finishedAtMs: Date.now(),
    }).where(eq(generationAttempts.id, attemptId));
    await db.update(generationJobs).set({ status: jobStatus, completedAtMs: Date.now() })
      .where(eq(generationJobs.id, jobId));

    await expect(releaseResourceSlot(
      poolId, slot.slotNo, attemptId, slot.leaseToken, slot.fencingToken,
    )).rejects.toMatchObject({
      name: "InvalidResourceCardinalityError",
      code: "invalid_resource_cardinality",
      attemptId,
      slotCount: 2,
    } satisfies Partial<InvalidResourceCardinalityError>);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(job.status).toBe(jobStatus);
    expect(attempt.phase).toBe(attemptPhase);
    expect(await db.select().from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.ownerAttemptId, attemptId))).toHaveLength(2);
  });

  it("释放槽位必须使用正确的令牌", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId);
    const slot = (await acquireResourceSlot(poolId, attemptId, "worker-1"))!;

    await db.update(generationAttempts).set({ phase: "PREPARING" }).where(eq(generationAttempts.id, attemptId));
    const wrong = await releaseResourceSlot(poolId, slot.slotNo, attemptId, "wrong-token", slot.fencingToken);
    expect(wrong).toBe(false);

    const ok = await releaseResourceSlot(poolId, slot.slotNo, attemptId, slot.leaseToken, slot.fencingToken);
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

    await db.update(generationAttempts).set({ phase: "PREPARING" }).where(eq(generationAttempts.id, attemptId1));

    await releaseResourceSlot(poolId, slot1.slotNo, attemptId1, slot1.leaseToken, slot1.fencingToken);

    const jobId2 = await createQueuedJob();
    const attemptId2 = await createAttempt(jobId2, backendId, poolId, {}, "worker-2");
    const slot2 = await acquireResourceSlot(poolId, attemptId2, "worker-2");
    expect(slot2!.fencingToken).toBe(2);
  });

  it("并发领取时只应有一个 worker 成功", async () => {
    const { poolId, backendId } = await createBackendAndPool("image", 1);
    const jobs = await Promise.all([createQueuedJob(), createQueuedJob(), createQueuedJob()]);
    const attempts = await Promise.all(jobs.map((jobId, i) => createAttempt(jobId, backendId, poolId, {}, `worker-${i}`)));

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

  it("does not resurrect an expired job claim but renews a held terminal restart window", async () => {
    const now = Date.now();
    const jobId = await createQueuedJob();
    await db.update(generationJobs).set({
      status: "RUNNING",
      claimOwner: "worker-1",
      claimUntilMs: now,
      claimFencingToken: 9,
    }).where(eq(generationJobs.id, jobId));

    expect(await renewJobClaim(jobId, "worker-1", 9, db, () => now)).toBe(false);

    await db.update(generationJobs).set({
      status: "SUCCEEDED",
      claimUntilMs: now + 60_000,
    }).where(eq(generationJobs.id, jobId));
    expect(await renewJobClaim(jobId, "worker-1", 9, db, () => now)).toBe(true);
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
    expect(second.claimFencingToken).toBe(first.claimFencingToken + 2);

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
    const attemptId = await createAttempt(jobId, backendId, poolId, {
      phase: "PREPARING",
      jobClaimFencingToken: 1,
    });
    const now = Date.now();

    await db
      .update(generationJobs)
      .set({
        status: "RUNNING",
        currentAttemptId: attemptId,
        claimOwner: "ghost-worker",
        claimUntilMs: now - 1,
        claimFencingToken: 1,
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
    await db.update(generationAttempts).set({
      resourceSlotNo: 1,
      resourceLeaseToken: "old-token",
      resourceFencingToken: 0,
    }).where(eq(generationAttempts.id, attemptId));

    const result = await scanExpiredClaims();

    expect(result.requeuedJobs).toContain(jobId);
    expect(result.releasedSlots).toContainEqual({ poolId, slotNo: 1 });

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
  it("应将过期且尚未提交的取消请求终结为 CANCELLED", async () => {
    const { poolId, backendId } = await createBackendAndPool();
    const jobId = await createQueuedJob();
    const attemptId = await createAttempt(jobId, backendId, poolId, {
      phase: "PREPARING",
      jobClaimFencingToken: 3,
      externalJobId: null,
    });
    const now = Date.now();
    await db.update(generationJobs).set({
      status: "CANCEL_REQUESTED",
      currentAttemptId: attemptId,
      claimOwner: "dead-worker",
      claimUntilMs: now - 1,
      claimFencingToken: 3,
      cancelRequestedAtMs: now - 1000,
      updatedAtMs: now,
    }).where(eq(generationJobs.id, jobId));

    const result = await scanExpiredClaims();
    expect(result.cancelledJobs).toContain(jobId);
    expect(result.requeuedJobs).not.toContain(jobId);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(job.status).toBe("CANCELLED");
    expect(attempt.phase).toBe("CANCELLED");
  });

});
