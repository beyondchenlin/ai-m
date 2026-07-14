/**
 * v2.0 资源租约与防旧写令牌
 *
 * 手册 §13：工作领取租约与资源槽位租约分离，使用单调防旧写令牌。
 * 进程内锁不能保护显卡，资源所有权必须持久化。
 */

import { db, type DB } from "@/lib/db";
import {
  resourcePoolSlots,
  resourceReconciliationProofs,
  generationJobs,
  generationAttempts,
} from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  applyExpiredJobCandidates,
  readExpiredJobCandidates,
  type RecoveryScanOutcome,
} from "@/lib/generation/jobs/recovery-candidates";
import { id as genId } from "@/lib/id";

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
  ownerAttemptId: string,
  leaseToken: string,
  fencingToken: number,
): Promise<boolean> {
  return db.transaction((tx) => {
    const now = Date.now();
    const attempt = tx.select().from(generationAttempts)
      .where(eq(generationAttempts.id, ownerAttemptId)).get();
    if (!attempt) return false;
    const safeBeforeSubmission = ["CREATED", "LEASED", "PREPARING"].includes(attempt.phase)
      && attempt.externalJobId === null;
    const proof = !attempt?.externalJobId ? undefined : tx.select().from(resourceReconciliationProofs)
      .where(and(
        eq(resourceReconciliationProofs.attemptId, ownerAttemptId),
        eq(resourceReconciliationProofs.backendId, attempt.backendId),
        eq(resourceReconciliationProofs.externalJobId, attempt.externalJobId),
        eq(resourceReconciliationProofs.resourcePoolId, resourcePoolId),
        eq(resourceReconciliationProofs.resourceSlotNo, slotNo),
        eq(resourceReconciliationProofs.resourceLeaseToken, leaseToken),
        eq(resourceReconciliationProofs.resourceFencingToken, fencingToken),
        eq(resourceReconciliationProofs.disposition, "retained"),
      )).get();
    if (!safeBeforeSubmission && !proof) return false;
    const updated = tx.update(resourcePoolSlots).set({
      ownerAttemptId: null,
      leaseToken: null,
      expiresAtMs: null,
      updatedAtMs: now,
    }).where(and(
      eq(resourcePoolSlots.resourcePoolId, resourcePoolId),
      eq(resourcePoolSlots.slotNo, slotNo),
      eq(resourcePoolSlots.ownerAttemptId, ownerAttemptId),
      eq(resourcePoolSlots.leaseToken, leaseToken),
      eq(resourcePoolSlots.fencingToken, fencingToken),
    )).returning({ slotNo: resourcePoolSlots.slotNo }).all();
    if (updated.length !== 1) return false;
    if (proof) {
      const reconciled = tx.update(resourceReconciliationProofs).set({
        disposition: "reconciled",
        reconciledAtMs: now,
      }).where(and(
        eq(resourceReconciliationProofs.id, proof.id),
        eq(resourceReconciliationProofs.disposition, "retained"),
      )).returning({ id: resourceReconciliationProofs.id }).all();
      if (reconciled.length !== 1) throw new SlotReconciliationRollback();
    }
    return true;
  }, { behavior: "immediate" });
}

export interface ResourceTerminationProofInput {
  attemptId: string;
  backendId: string;
  externalJobId: string;
  proofKind: typeof resourceReconciliationProofs.$inferInsert.proofKind;
  observedAtMs: number;
  resourcePoolId: string;
  resourceSlotNo: number;
  resourceLeaseToken: string;
  resourceFencingToken: number;
}

/** Persist explicit backend terminal evidence only when it binds to the current attempt lease identity. */
export function recordResourceTerminationProof(
  input: ResourceTerminationProofInput,
  database: DB = db,
  clock: () => number = Date.now,
): boolean {
  if (!input.externalJobId || input.observedAtMs <= 0) return false;
  return database.transaction((tx) => {
    const attempt = tx.select().from(generationAttempts)
      .where(eq(generationAttempts.id, input.attemptId)).get();
    if (!attempt
      || attempt.backendId !== input.backendId
      || attempt.externalJobId !== input.externalJobId
      || attempt.resourcePoolId !== input.resourcePoolId
      || attempt.resourceSlotNo !== input.resourceSlotNo
      || attempt.resourceLeaseToken !== input.resourceLeaseToken
      || attempt.resourceFencingToken !== input.resourceFencingToken) return false;

    const inserted = tx.insert(resourceReconciliationProofs).values({
      id: genId(),
      ...input,
      disposition: "retained",
      createdAtMs: clock(),
    }).onConflictDoNothing().returning({ id: resourceReconciliationProofs.id }).all();
    if (inserted.length === 1) return true;
    const existing = tx.select({ id: resourceReconciliationProofs.id })
      .from(resourceReconciliationProofs).where(and(
        eq(resourceReconciliationProofs.attemptId, input.attemptId),
        eq(resourceReconciliationProofs.backendId, input.backendId),
        eq(resourceReconciliationProofs.externalJobId, input.externalJobId),
        eq(resourceReconciliationProofs.proofKind, input.proofKind),
        eq(resourceReconciliationProofs.resourcePoolId, input.resourcePoolId),
        eq(resourceReconciliationProofs.resourceSlotNo, input.resourceSlotNo),
        eq(resourceReconciliationProofs.resourceLeaseToken, input.resourceLeaseToken),
        eq(resourceReconciliationProofs.resourceFencingToken, input.resourceFencingToken),
      )).get();
    return Boolean(existing);
  }, { behavior: "immediate" });
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
export type { RecoveryScanOutcome } from "@/lib/generation/jobs/recovery-candidates";

export interface RecoveryScanResult {
  requeuedJobs: string[];
  attentionJobs: string[];
  cancelledJobs: string[];
  releasedSlots: { poolId: string; slotNo: number }[];
  outcomes: RecoveryScanOutcome[];
}

export interface ExpiredSlotSnapshot {
  resourcePoolId: string;
  slotNo: number;
  ownerAttemptId: string;
  leaseToken: string;
  fencingToken: number;
  expiresAtMs: number;
  attemptPhase: typeof generationAttempts.$inferSelect.phase | null;
  backendId: string | null;
  externalJobId: string | null;
  jobStatus: typeof generationJobs.$inferSelect.status | null;
}

export interface SlotReconciliationOutcome {
  resourcePoolId: string;
  slotNo: number;
  ownerAttemptId: string;
  disposition: "retained" | "reconciled";
  reason: "pre-submission-safe" | "termination-proven" | "termination-proof-missing" | "slot-changed";
}

class SlotReconciliationRollback extends Error {}

export async function readExpiredSlotCandidates(
  scanNow: number,
  database: DB = db,
): Promise<ExpiredSlotSnapshot[]> {
  const rows = await database.select({
    slot: resourcePoolSlots,
    attemptPhase: generationAttempts.phase,
    backendId: generationAttempts.backendId,
    externalJobId: generationAttempts.externalJobId,
    jobStatus: generationJobs.status,
  }).from(resourcePoolSlots)
    .leftJoin(generationAttempts, eq(generationAttempts.id, resourcePoolSlots.ownerAttemptId))
    .leftJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
    .where(sql`${resourcePoolSlots.expiresAtMs} < ${scanNow} AND ${resourcePoolSlots.ownerAttemptId} IS NOT NULL`);

  return rows.flatMap(({ slot, attemptPhase, backendId, externalJobId, jobStatus }) => {
    if (!slot.ownerAttemptId || !slot.leaseToken || slot.expiresAtMs === null) return [];
    return [{
      resourcePoolId: slot.resourcePoolId,
      slotNo: slot.slotNo,
      ownerAttemptId: slot.ownerAttemptId,
      leaseToken: slot.leaseToken,
      fencingToken: slot.fencingToken,
      expiresAtMs: slot.expiresAtMs,
      attemptPhase,
      backendId,
      externalJobId,
      jobStatus,
    }];
  });
}

export async function applyExpiredSlotCandidates(
  candidates: readonly ExpiredSlotSnapshot[],
  database: DB = db,
  clock: () => number = Date.now,
): Promise<SlotReconciliationOutcome[]> {
  const outcomes: SlotReconciliationOutcome[] = [];
  const preSubmissionPhases = new Set(["CREATED", "LEASED", "PREPARING"]);
  for (const slot of candidates) {
    try {
      const outcome = database.transaction((tx) => {
        const scanNow = clock();
        const currentAttempt = tx.select().from(generationAttempts)
          .where(eq(generationAttempts.id, slot.ownerAttemptId)).get();
        if (!currentAttempt
          || currentAttempt.phase !== slot.attemptPhase
          || currentAttempt.backendId !== slot.backendId
          || currentAttempt.externalJobId !== slot.externalJobId
          || currentAttempt.resourcePoolId !== slot.resourcePoolId
          || currentAttempt.resourceSlotNo !== slot.slotNo
          || currentAttempt.resourceLeaseToken !== slot.leaseToken
          || currentAttempt.resourceFencingToken !== slot.fencingToken) {
          return { disposition: "retained", reason: "slot-changed" } as const;
        }

        const safeBeforeSubmission = preSubmissionPhases.has(currentAttempt.phase)
          && currentAttempt.externalJobId === null;
        const proof = safeBeforeSubmission ? undefined : tx.select().from(resourceReconciliationProofs)
          .where(and(
            eq(resourceReconciliationProofs.attemptId, currentAttempt.id),
            eq(resourceReconciliationProofs.backendId, currentAttempt.backendId),
            eq(resourceReconciliationProofs.externalJobId, currentAttempt.externalJobId ?? ""),
            eq(resourceReconciliationProofs.resourcePoolId, slot.resourcePoolId),
            eq(resourceReconciliationProofs.resourceSlotNo, slot.slotNo),
            eq(resourceReconciliationProofs.resourceLeaseToken, slot.leaseToken),
            eq(resourceReconciliationProofs.resourceFencingToken, slot.fencingToken),
            eq(resourceReconciliationProofs.disposition, "retained"),
          )).get();
        if (!safeBeforeSubmission && !proof) {
          return { disposition: "retained", reason: "termination-proof-missing" } as const;
        }

        const released = tx.update(resourcePoolSlots).set({
          ownerAttemptId: null,
          leaseToken: null,
          expiresAtMs: null,
          fencingToken: sql`${resourcePoolSlots.fencingToken} + 1`,
          updatedAtMs: scanNow,
        }).where(and(
          eq(resourcePoolSlots.resourcePoolId, slot.resourcePoolId),
          eq(resourcePoolSlots.slotNo, slot.slotNo),
          eq(resourcePoolSlots.ownerAttemptId, slot.ownerAttemptId),
          eq(resourcePoolSlots.leaseToken, slot.leaseToken),
          eq(resourcePoolSlots.fencingToken, slot.fencingToken),
          eq(resourcePoolSlots.expiresAtMs, slot.expiresAtMs),
          sql`${resourcePoolSlots.expiresAtMs} < ${scanNow}`,
        )).returning({ slotNo: resourcePoolSlots.slotNo }).all();
        if (released.length !== 1) {
          return { disposition: "retained", reason: "slot-changed" } as const;
        }

        if (proof) {
          const reconciled = tx.update(resourceReconciliationProofs).set({
            disposition: "reconciled",
            reconciledAtMs: scanNow,
          }).where(and(
            eq(resourceReconciliationProofs.id, proof.id),
            eq(resourceReconciliationProofs.disposition, "retained"),
          )).returning({ id: resourceReconciliationProofs.id }).all();
          if (reconciled.length !== 1) throw new SlotReconciliationRollback();
        }
        return {
          disposition: "reconciled",
          reason: safeBeforeSubmission ? "pre-submission-safe" : "termination-proven",
        } as const;
      }, { behavior: "immediate" });
      outcomes.push({
        resourcePoolId: slot.resourcePoolId,
        slotNo: slot.slotNo,
        ownerAttemptId: slot.ownerAttemptId,
        ...outcome,
      });
    } catch (error) {
      if (!(error instanceof SlotReconciliationRollback)) throw error;
      outcomes.push({
        resourcePoolId: slot.resourcePoolId,
        slotNo: slot.slotNo,
        ownerAttemptId: slot.ownerAttemptId,
        disposition: "retained",
        reason: "slot-changed",
      });
    }
  }
  return outcomes;
}

export async function scanExpiredClaims(): Promise<RecoveryScanResult> {
  const now = Date.now();
  const expiredSlots = await readExpiredSlotCandidates(now);
  const candidates = await readExpiredJobCandidates(now);
  const slotOutcomes = await applyExpiredSlotCandidates(expiredSlots, db, () => now);
  const jobRecovery = await applyExpiredJobCandidates(candidates);
  const releasedSlots = slotOutcomes
    .filter((outcome) => outcome.disposition === "reconciled")
    .map((outcome) => ({ poolId: outcome.resourcePoolId, slotNo: outcome.slotNo }));
  return { ...jobRecovery, releasedSlots };
}
