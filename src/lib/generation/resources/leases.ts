/**
 * v2.0 资源租约与防旧写令牌
 *
 * 手册 §13：工作领取租约与资源槽位租约分离，使用单调防旧写令牌。
 * 进程内锁不能保护显卡，资源所有权必须持久化。
 */

import { db } from "@/lib/db";
import { resourcePoolSlots, generationJobs, generationAttempts } from "@/lib/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";

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
  const leaseToken = `${workerId}_${attemptId}_${now}_${Math.random().toString(36).slice(2, 10)}`;
  const expiresAtMs = now + LEASE_CONFIG.RESOURCE_LEASE_MS;

  // 原子领取：通过 rowid 子查询只更新第一个空闲或过期槽位，避免同时更新多个槽位导致 lease_token UNIQUE 冲突。
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
        sql`${resourcePoolSlots}."rowid" = (
          SELECT "rowid" FROM ${resourcePoolSlots}
          WHERE ${resourcePoolSlots.resourcePoolId} = ${resourcePoolId}
            AND ${resourcePoolSlots.ownerAttemptId} IS NULL
          ORDER BY ${resourcePoolSlots.slotNo}
          LIMIT 1
        )`,
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
  capability: typeof generationJobs.$inferSelect.capability,
): Promise<typeof generationJobs.$inferSelect | null> {
  const now = Date.now();
  const claimUntilMs = now + LEASE_CONFIG.CLAIM_LEASE_MS;

  // 原子领取：通过 rowid 子查询只更新第一个可领取的任务（状态为 QUEUED、无未过期租约）。
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
        sql`${generationJobs}."rowid" = (
          SELECT "rowid" FROM ${generationJobs}
          WHERE ${generationJobs.status} = 'QUEUED'
            AND ${generationJobs.capability} = ${capability}
            AND (${generationJobs.claimOwner} IS NULL OR ${generationJobs.claimUntilMs} < ${now})
          ORDER BY ${generationJobs.createdAtMs}
          LIMIT 1
        )`,
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

/**
 * Scan expired ownership safely.
 *
 * Only pre-submission attempts may be requeued automatically. Once an external
 * execution might exist, the job is escalated for reconciliation and the GPU
 * slot remains reserved. This deliberately prefers a blocked slot over duplicate
 * inference.
 */
export async function scanExpiredClaims(): Promise<{
  requeuedJobs: string[];
  attentionJobs: string[];
  cancelledJobs: string[];
  releasedSlots: { poolId: string; slotNo: number }[];
}> {
  const now = Date.now();
  const expired = await db.select().from(generationJobs).where(and(
    inArray(generationJobs.status, ["RUNNING", "CANCEL_REQUESTED"]),
    sql`${generationJobs.claimUntilMs} < ${now}`,
  ));
  const requeuedJobs: string[] = [];
  const attentionJobs: string[] = [];
  const cancelledJobs: string[] = [];
  const safePreSubmission = new Set(["CREATED", "LEASED", "PREPARING"]);
  const terminalAttemptPhases = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "ORPHANED"]);

  for (const job of expired) {
    const attempt = job.currentAttemptId
      ? (await db.select().from(generationAttempts).where(eq(generationAttempts.id, job.currentAttemptId)))[0]
      : undefined;
    if (job.status === "CANCEL_REQUESTED" && (!attempt || (safePreSubmission.has(attempt.phase) && !attempt.externalJobId))) {
      const cancelled = await db.update(generationJobs).set({
        status: "CANCELLED",
        claimOwner: null,
        claimUntilMs: null,
        claimFencingToken: sql`${generationJobs.claimFencingToken} + 1`,
        completedAtMs: now,
        updatedAtMs: now,
      }).where(and(
        eq(generationJobs.id, job.id),
        eq(generationJobs.status, "CANCEL_REQUESTED"),
        eq(generationJobs.claimOwner, job.claimOwner!),
        eq(generationJobs.claimFencingToken, job.claimFencingToken),
        sql`${generationJobs.claimUntilMs} < ${now}`,
      )).returning({ id: generationJobs.id });
      if (cancelled[0]) {
        if (attempt) await db.update(generationAttempts).set({
          phase: "CANCELLED", finishedAtMs: now, updatedAtMs: now,
        }).where(and(eq(generationAttempts.id, attempt.id), eq(generationAttempts.jobClaimFencingToken, job.claimFencingToken)));
        cancelledJobs.push(job.id);
      }
      continue;
    }

    if (!attempt || (safePreSubmission.has(attempt.phase) && !attempt.externalJobId)) {
      const updated = await db.update(generationJobs).set({
        status: "QUEUED",
        claimOwner: null,
        claimUntilMs: null,
        claimFencingToken: sql`${generationJobs.claimFencingToken} + 1`,
        updatedAtMs: now,
      }).where(and(
        eq(generationJobs.id, job.id),
        eq(generationJobs.status, "RUNNING"),
        eq(generationJobs.claimOwner, job.claimOwner!),
        eq(generationJobs.claimFencingToken, job.claimFencingToken),
        sql`${generationJobs.claimUntilMs} < ${now}`,
      )).returning({ id: generationJobs.id });
      if (updated[0]) {
        if (attempt) await db.update(generationAttempts).set({
          phase: "ORPHANED", errorClass: "expired_pre_submission_claim",
          errorCode: "expired_pre_submission_claim",
          errorMessageSafe: "The previous worker lost ownership before external submission",
          finishedAtMs: now, updatedAtMs: now,
        }).where(and(eq(generationAttempts.id, attempt.id), eq(generationAttempts.jobClaimFencingToken, job.claimFencingToken)));
        requeuedJobs.push(job.id);
      }
      continue;
    }

    const updated = await db.update(generationJobs).set({
      status: "NEEDS_ATTENTION",
      claimOwner: null,
      claimUntilMs: null,
      claimFencingToken: sql`${generationJobs.claimFencingToken} + 1`,
      needsAttentionReason: `expired_claim:${attempt.phase}:external=${attempt.externalJobId ?? "unknown"}`,
      updatedAtMs: now,
    }).where(and(
      eq(generationJobs.id, job.id),
      eq(generationJobs.status, job.status),
      eq(generationJobs.claimOwner, job.claimOwner!),
      eq(generationJobs.claimFencingToken, job.claimFencingToken),
      sql`${generationJobs.claimUntilMs} < ${now}`,
    )).returning({ id: generationJobs.id });
    if (updated[0]) attentionJobs.push(job.id);
  }

  const expiredSlots = await db.select().from(resourcePoolSlots).where(
    sql`${resourcePoolSlots.expiresAtMs} < ${now} AND ${resourcePoolSlots.ownerAttemptId} IS NOT NULL`,
  );
  const releasedSlots: { poolId: string; slotNo: number }[] = [];
  for (const slot of expiredSlots) {
    const attempt = slot.ownerAttemptId
      ? (await db.select({ phase: generationAttempts.phase }).from(generationAttempts).where(eq(generationAttempts.id, slot.ownerAttemptId)))[0]
      : undefined;
    if (!attempt || terminalAttemptPhases.has(attempt.phase)) {
      const released = await db.update(resourcePoolSlots).set({
        ownerAttemptId: null,
        leaseToken: null,
        expiresAtMs: null,
        fencingToken: sql`${resourcePoolSlots.fencingToken} + 1`,
        updatedAtMs: now,
      }).where(and(
        eq(resourcePoolSlots.resourcePoolId, slot.resourcePoolId),
        eq(resourcePoolSlots.slotNo, slot.slotNo),
        eq(resourcePoolSlots.fencingToken, slot.fencingToken),
      )).returning();
      if (released[0]) releasedSlots.push({ poolId: slot.resourcePoolId, slotNo: slot.slotNo });
    }
  }
  return { requeuedJobs, attentionJobs, cancelledJobs, releasedSlots };
}
