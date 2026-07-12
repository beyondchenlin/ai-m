/**
 * v2.0 资源租约与防旧写令牌
 *
 * 手册 §13：工作领取租约与资源槽位租约分离，使用单调防旧写令牌。
 * 进程内锁不能保护显卡，资源所有权必须持久化。
 */

import { db } from "@/lib/db";
import { resourcePoolSlots, generationJobs, generationAttempts } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";

/** 租约配置 */
export const LEASE_CONFIG = {
  /** 工作领取租约时长 (ms) */
  CLAIM_LEASE_MS: 30_000,
  /** 资源槽位租约时长 (ms) */
  RESOURCE_LEASE_MS: 120_000,
  /** 心跳间隔 (ms) */
  HEARTBEAT_INTERVAL_MS: 10_000,
  /** 租约过期宽限期 (ms) */
  GRACE_PERIOD_MS: 5_000,
} as const;

/** 原子领取资源槽位 */
export async function acquireResourceSlot(
  resourcePoolId: string,
  attemptId: string,
  workerId: string,
): Promise<{
  slotNo: number;
  leaseToken: string;
  fencingToken: number;
  expiresAtMs: number;
} | null> {
  const now = Date.now();
  const leaseToken = `${workerId}_${now}_${Math.random().toString(36).slice(2, 10)}`;
  const expiresAtMs = now + LEASE_CONFIG.RESOURCE_LEASE_MS;

  // 原子领取：找到第一个空闲或过期槽位
  const [slot] = await db
    .update(resourcePoolSlots)
    .set({
      ownerAttemptId: attemptId,
      leaseToken,
      fencingToken: sql`${resourcePoolSlots.fencingToken} + 1`,
      expiresAtMs,
      updatedAtMs: now,
    })
    .where(
      and(
        eq(resourcePoolSlots.resourcePoolId, resourcePoolId),
        // 空闲 或 租约已过期
        sql`(${resourcePoolSlots.ownerAttemptId} IS NULL OR ${resourcePoolSlots.expiresAtMs} < ${now})`,
      ),
    )
    .returning();

  if (!slot) return null;

  return {
    slotNo: slot.slotNo,
    leaseToken: slot.leaseToken!,
    fencingToken: slot.fencingToken,
    expiresAtMs: slot.expiresAtMs!,
  };
}

/** 续租资源槽位 */
export async function renewResourceSlot(
  resourcePoolId: string,
  slotNo: number,
  leaseToken: string,
  fencingToken: number,
): Promise<boolean> {
  const now = Date.now();
  const expiresAtMs = now + LEASE_CONFIG.RESOURCE_LEASE_MS;

  const [updated] = await db
    .update(resourcePoolSlots)
    .set({ expiresAtMs, updatedAtMs: now })
    .where(
      and(
        eq(resourcePoolSlots.resourcePoolId, resourcePoolId),
        eq(resourcePoolSlots.slotNo, slotNo),
        eq(resourcePoolSlots.leaseToken, leaseToken),
        eq(resourcePoolSlots.fencingToken, fencingToken),
      ),
    )
    .returning();

  return !!updated;
}

/** 释放资源槽位 */
export async function releaseResourceSlot(
  resourcePoolId: string,
  slotNo: number,
  leaseToken: string,
  fencingToken: number,
): Promise<boolean> {
  const [updated] = await db
    .update(resourcePoolSlots)
    .set({
      ownerAttemptId: null,
      leaseToken: null,
      expiresAtMs: null,
      updatedAtMs: Date.now(),
    })
    .where(
      and(
        eq(resourcePoolSlots.resourcePoolId, resourcePoolId),
        eq(resourcePoolSlots.slotNo, slotNo),
        eq(resourcePoolSlots.leaseToken, leaseToken),
        eq(resourcePoolSlots.fencingToken, fencingToken),
      ),
    )
    .returning();

  return !!updated;
}

/** 原子领取任务（含防旧写令牌递增） */
export async function claimJob(
  workerId: string,
  capability: string,
): Promise<typeof generationJobs.$inferSelect | null> {
  const now = Date.now();
  const claimUntilMs = now + LEASE_CONFIG.CLAIM_LEASE_MS;

  // 原子领取：找到第一个可领取的任务
  // 条件：状态为 QUEUED、无未过期租约、无取消请求
  const [job] = await db
    .update(generationJobs)
    .set({
      status: "RUNNING",
      claimOwner: workerId,
      claimUntilMs,
      claimFencingToken: sql`${generationJobs.claimFencingToken} + 1`,
      updatedAtMs: now,
    })
    .where(
      and(
        eq(generationJobs.status, "QUEUED"),
        eq(generationJobs.capability, capability),
        // 无未过期租约 OR 租约已过期
        sql`(${generationJobs.claimOwner} IS NULL OR ${generationJobs.claimUntilMs} < ${now})`,
      ),
    )
    .returning();

  return job || null;
}

/** 续租工作领取 */
export async function renewJobClaim(
  jobId: string,
  workerId: string,
  fencingToken: number,
): Promise<boolean> {
  const now = Date.now();
  const claimUntilMs = now + LEASE_CONFIG.CLAIM_LEASE_MS;

  const [updated] = await db
    .update(generationJobs)
    .set({ claimUntilMs, updatedAtMs: now })
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.claimOwner, workerId),
        eq(generationJobs.claimFencingToken, fencingToken),
      ),
    )
    .returning();

  return !!updated;
}

/** 释放工作领取 */
export async function releaseJobClaim(
  jobId: string,
  workerId: string,
  fencingToken: number,
): Promise<boolean> {
  const [updated] = await db
    .update(generationJobs)
    .set({
      claimOwner: null,
      claimUntilMs: null,
      updatedAtMs: Date.now(),
    })
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.claimOwner, workerId),
        eq(generationJobs.claimFencingToken, fencingToken),
      ),
    )
    .returning();

  return !!updated;
}

/** 扫描过期租约并恢复（恢复扫描器） */
export async function scanExpiredClaims(): Promise<{
  expiredJobs: string[];
  expiredSlots: { poolId: string; slotNo: number }[];
}> {
  const now = Date.now();

  // 过期工作领取 → 重置为 QUEUED（允许其他 Worker 领取）
  const expiredJobs = await db
    .update(generationJobs)
    .set({
      status: "QUEUED",
      claimOwner: null,
      claimUntilMs: null,
      updatedAtMs: now,
    })
    .where(
      and(
        eq(generationJobs.status, "RUNNING"),
        sql`${generationJobs.claimUntilMs} < ${now}`,
      ),
    )
    .returning({ id: generationJobs.id });

  // 过期资源槽位 → 释放
  const expiredSlots = await db
    .update(resourcePoolSlots)
    .set({
      ownerAttemptId: null,
      leaseToken: null,
      expiresAtMs: null,
      updatedAtMs: now,
    })
    .where(
      sql`${resourcePoolSlots.expiresAtMs} < ${now} AND ${resourcePoolSlots.ownerAttemptId} IS NOT NULL`,
    )
    .returning({
      poolId: resourcePoolSlots.resourcePoolId,
      slotNo: resourcePoolSlots.slotNo,
    });

  return {
    expiredJobs: expiredJobs.map((j) => j.id),
    expiredSlots: expiredSlots.map((s) => ({
      poolId: s.poolId,
      slotNo: s.slotNo,
    })),
  };
}