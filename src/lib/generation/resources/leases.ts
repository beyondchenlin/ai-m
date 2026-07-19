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
  generationEvents,
} from "@/lib/db/schema";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import {
  applyExpiredJobCandidates,
  readExpiredJobCandidates,
  type RecoveryScanOutcome,
} from "@/lib/generation/jobs/recovery-candidates";
import { id as genId } from "@/lib/id";
import { planPreSubmissionRecovery } from "@/lib/generation/jobs/state-transitions";

/** 租约配置 */
export const LEASE_CONFIG = {
  /** 工作领取租约时长 (ms) */
  CLAIM_LEASE_MS: 30_000,
  /** 资源槽位租约时长 (ms) */
  RESOURCE_LEASE_MS: 120_000,
  /** 心跳间隔 (ms) */
  HEARTBEAT_INTERVAL_MS: 10_000,
  /** Default cap for simultaneously leased jobs from one project. */
  MAX_RUNNING_JOBS_PER_PROJECT: 2,
  /** An older queued job crosses the fairness starvation boundary. */
  PROJECT_STARVATION_MS: 5 * 60_000,
} as const;

class ResourceCardinalityRollback extends Error {}

function boundedEnvironmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export class InvalidResourceCardinalityError extends Error {
  readonly name = "InvalidResourceCardinalityError";
  readonly code = "invalid_resource_cardinality";

  constructor(
    readonly attemptId: string,
    readonly slotCount: number,
  ) {
    super(`Attempt ${attemptId} owns ${slotCount} physical resource slots; all leases were retained`);
  }
}

function quarantineInvalidResourceCardinality(
  database: DB,
  attempt: typeof generationAttempts.$inferSelect,
  job: typeof generationJobs.$inferSelect,
  now: number,
): void {
  const attemptChanged = database.update(generationAttempts).set({
    phase: "ORPHANED",
    errorClass: "invalid_resource_cardinality",
    errorCode: "invalid_resource_cardinality",
    errorMessageSafe: "The attempt owns an invalid number of physical resource slots",
    finishedAtMs: now,
    updatedAtMs: now,
  }).where(and(
    eq(generationAttempts.id, attempt.id),
    eq(generationAttempts.phase, attempt.phase),
    eq(generationAttempts.jobClaimFencingToken, attempt.jobClaimFencingToken),
  )).run();
  if (attemptChanged.changes !== 1) throw new ResourceCardinalityRollback();
  const jobChanged = database.update(generationJobs).set({
    status: "NEEDS_ATTENTION",
    claimOwner: null,
    claimUntilMs: null,
    claimFencingToken: job.claimFencingToken + 1,
    needsAttentionReason: "invalid_resource_cardinality",
    updatedAtMs: now,
  }).where(and(
    eq(generationJobs.id, job.id),
    eq(generationJobs.status, job.status),
    eq(generationJobs.currentAttemptId, attempt.id),
    eq(generationJobs.claimFencingToken, job.claimFencingToken),
  )).run();
  if (jobChanged.changes !== 1) throw new ResourceCardinalityRollback();
  database.insert(generationEvents).values({
    id: genId(),
    jobId: job.id,
    attemptId: attempt.id,
    eventType: "invalid_resource_cardinality",
    severity: "error",
    safePayloadJson: {},
    createdAtMs: now,
  }).run();
}

/** 原子领取资源槽位 */
export async function acquireResourceSlot(
  resourcePoolId: string,
  attemptId: string,
  workerId: string,
  database: DB = db,
  clock: () => number = Date.now,
): Promise<{
  slotNo: number;
  leaseToken: string;
  fencingToken: number;
  expiresAtMs: number;
} | null> {
  // 原子领取：通过 rowid 子查询只更新第一个空闲或过期槽位，避免同时更新多个槽位导致 lease_token UNIQUE 冲突。
  let slot: typeof resourcePoolSlots.$inferSelect | undefined;
  try {
    slot = database.transaction((tx) => {
    const now = clock();
    const leaseToken = `${workerId}_${attemptId}_${now}_${Math.random().toString(36).slice(2, 10)}`;
    const expiresAtMs = now + LEASE_CONFIG.RESOURCE_LEASE_MS;
    const attempt = tx.select().from(generationAttempts)
      .where(eq(generationAttempts.id, attemptId)).get();
    if (!attempt
      || attempt.phase !== "PREPARING"
      || attempt.resourcePoolId !== resourcePoolId
      || attempt.resourceSlotNo !== 0
      || attempt.resourceLeaseToken !== `pending-${attempt.id}`
      || attempt.resourceFencingToken !== 0) return undefined;
    const job = tx.select().from(generationJobs).where(eq(generationJobs.id, attempt.jobId)).get();
    if (!job
      || job.currentAttemptId !== attempt.id
      || job.status !== "RUNNING"
      || job.claimOwner !== workerId
      || job.claimUntilMs === null
      || job.claimUntilMs <= now
      || job.claimFencingToken !== attempt.jobClaimFencingToken) return undefined;
    const ownedSlots = tx.select().from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.ownerAttemptId, attemptId)).all();
    if (ownedSlots.length > 1) {
      quarantineInvalidResourceCardinality(tx as unknown as DB, attempt, job, now);
      return undefined;
    }
    if (ownedSlots.length === 1) {
      const existing = ownedSlots[0];
      if (existing.resourcePoolId !== resourcePoolId
        || existing.leaseToken === null
        || existing.expiresAtMs === null) return undefined;
      return existing;
    }
    return tx.update(resourcePoolSlots)
      .set({
        ownerAttemptId: attemptId,
        leaseToken,
        fencingToken: sql`${resourcePoolSlots.fencingToken} + 1`,
        expiresAtMs,
        updatedAtMs: now,
      })
      .where(and(
        eq(resourcePoolSlots.resourcePoolId, resourcePoolId),
        sql`${resourcePoolSlots}."rowid" = (
          SELECT "rowid" FROM ${resourcePoolSlots}
          WHERE ${resourcePoolSlots.resourcePoolId} = ${resourcePoolId}
            AND ${resourcePoolSlots.ownerAttemptId} IS NULL
          ORDER BY ${resourcePoolSlots.slotNo}
          LIMIT 1
        )`,
      ))
      .returning().get();
    }, { behavior: "immediate" });
  } catch (error) {
    if (!(error instanceof ResourceCardinalityRollback)) throw error;
    return null;
  }

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
  workerId: string,
  database: DB = db,
  clock: () => number = Date.now,
): Promise<boolean> {
  try {
    return database.transaction((tx) => {
    const now = clock();
    const expiresAtMs = now + LEASE_CONFIG.RESOURCE_LEASE_MS;
    const slot = tx.select().from(resourcePoolSlots).where(and(
      eq(resourcePoolSlots.resourcePoolId, resourcePoolId),
      eq(resourcePoolSlots.slotNo, slotNo),
      eq(resourcePoolSlots.leaseToken, leaseToken),
      eq(resourcePoolSlots.fencingToken, fencingToken),
    )).get();
    if (!slot?.ownerAttemptId) return false;
    if (slot.expiresAtMs === null || slot.expiresAtMs <= now) return false;
    const attempt = tx.select().from(generationAttempts)
      .where(eq(generationAttempts.id, slot.ownerAttemptId)).get();
    if (!attempt
      || attempt.resourcePoolId !== resourcePoolId
      || attempt.resourceSlotNo !== slotNo
      || attempt.resourceLeaseToken !== leaseToken
      || attempt.resourceFencingToken !== fencingToken) return false;
    const job = tx.select().from(generationJobs).where(eq(generationJobs.id, attempt.jobId)).get();
    const activeJob = job?.status === "RUNNING" || job?.status === "CANCEL_REQUESTED";
    const terminalRestartWindow = (job?.status === "SUCCEEDED" && attempt.phase === "SUCCEEDED")
      || (job?.status === "CANCELLED" && attempt.phase === "CANCELLED")
      || (job?.status === "FAILED" && attempt.phase === "FAILED");
    if (!job
      || job.currentAttemptId !== attempt.id
      || (!activeJob && !terminalRestartWindow)
      || job.claimOwner !== workerId
      || job.claimUntilMs === null
      || job.claimUntilMs <= now
      || job.claimFencingToken !== attempt.jobClaimFencingToken) return false;
    const ownedSlots = tx.select().from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.ownerAttemptId, attempt.id)).all();
    if (ownedSlots.length !== 1) {
      quarantineInvalidResourceCardinality(tx as unknown as DB, attempt, job, now);
      return false;
    }
    const updated = tx.update(resourcePoolSlots)
      .set({ expiresAtMs, updatedAtMs: now })
      .where(and(
        eq(resourcePoolSlots.resourcePoolId, resourcePoolId),
        eq(resourcePoolSlots.slotNo, slotNo),
        eq(resourcePoolSlots.ownerAttemptId, attempt.id),
        eq(resourcePoolSlots.leaseToken, leaseToken),
        eq(resourcePoolSlots.fencingToken, fencingToken),
      ))
      .returning({ slotNo: resourcePoolSlots.slotNo }).all();
    return updated.length === 1;
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof ResourceCardinalityRollback) return false;
    throw error;
  }
}

/** 释放资源槽位 */
export async function releaseResourceSlot(
  resourcePoolId: string,
  slotNo: number,
  ownerAttemptId: string,
  leaseToken: string,
  fencingToken: number,
): Promise<boolean> {
  try {
    return db.transaction((tx) => {
    const now = Date.now();
    const attempt = tx.select().from(generationAttempts)
      .where(eq(generationAttempts.id, ownerAttemptId)).get();
    if (!attempt) return false;
    const job = tx.select().from(generationJobs).where(eq(generationJobs.id, attempt.jobId)).get();
    if (!job || job.currentAttemptId !== attempt.id) return false;
    const ownedSlots = tx.select().from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.ownerAttemptId, attempt.id)).all();
    if (ownedSlots.length !== 1) {
      if (["SUCCEEDED", "CANCELLED", "FAILED", "NEEDS_ATTENTION"].includes(job.status)) {
        throw new InvalidResourceCardinalityError(attempt.id, ownedSlots.length);
      }
      quarantineInvalidResourceCardinality(tx as unknown as DB, attempt, job, now);
      return false;
    }
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
  } catch (error) {
    if (error instanceof ResourceCardinalityRollback) return false;
    throw error;
  }
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
  options: {
    maxRunningJobsPerProject?: number;
    projectStarvationMs?: number;
    executionBackendIds?: readonly string[];
    clock?: () => number;
  } = {},
): Promise<typeof generationJobs.$inferSelect | null> {
  const executionBackendIds = options.executionBackendIds
    ? [...new Set(options.executionBackendIds)]
    : undefined;
  if (executionBackendIds && (executionBackendIds.length === 0
    || executionBackendIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)))) {
    throw new Error("executionBackendIds must contain one or more valid backend identities");
  }
  const maxRunningJobsPerProject = options.maxRunningJobsPerProject
    ?? boundedEnvironmentInteger(
      "AI_M_MAX_RUNNING_JOBS_PER_PROJECT",
      LEASE_CONFIG.MAX_RUNNING_JOBS_PER_PROJECT,
      1,
      32,
    );
  const projectStarvationMs = options.projectStarvationMs
    ?? boundedEnvironmentInteger(
      "AI_M_PROJECT_STARVATION_MS",
      LEASE_CONFIG.PROJECT_STARVATION_MS,
      1_000,
      24 * 60 * 60_000,
    );
  if (!Number.isSafeInteger(maxRunningJobsPerProject)
    || maxRunningJobsPerProject < 1
    || maxRunningJobsPerProject > 32) {
    throw new Error("maxRunningJobsPerProject must be an integer between 1 and 32");
  }
  if (!Number.isSafeInteger(projectStarvationMs)
    || projectStarvationMs < 1_000
    || projectStarvationMs > 24 * 60 * 60_000) {
    throw new Error("projectStarvationMs must be between one second and 24 hours");
  }
  const now = (options.clock ?? Date.now)();
  const claimUntilMs = now + LEASE_CONFIG.CLAIM_LEASE_MS;
  const starvationCutoffMs = now - projectStarvationMs;

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
            ${executionBackendIds
              ? sql`AND json_extract(${generationJobs.executionSnapshotJson}, '$.executionBackendId') IN (${sql.join(executionBackendIds.map((id) => sql`${id}`), sql`, `)})`
              : sql``}
            AND (${generationJobs.claimOwner} IS NULL OR ${generationJobs.claimUntilMs} <= ${now})
            AND (
              ${generationJobs.projectId} IS NULL
              OR (
                SELECT COUNT(*)
                FROM generation_jobs AS active_project_job
                WHERE active_project_job.project_id = ${generationJobs.projectId}
                  AND active_project_job.status IN ('RUNNING', 'CANCEL_REQUESTED')
                  AND active_project_job.claim_until_ms > ${now}
              ) < ${maxRunningJobsPerProject}
            )
          ORDER BY
            CASE WHEN ${generationJobs.createdAtMs} <= ${starvationCutoffMs} THEN 0 ELSE 1 END,
            (
              SELECT COUNT(*)
              FROM generation_jobs AS active_project_job
              WHERE active_project_job.project_id = ${generationJobs.projectId}
                AND active_project_job.status IN ('RUNNING', 'CANCEL_REQUESTED')
                AND active_project_job.claim_until_ms > ${now}
            ),
            ${generationJobs.createdAtMs},
            ${generationJobs.id}
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
  database: DB = db,
  clock: () => number = Date.now,
): Promise<boolean> {
  const now = clock();
  const claimUntilMs = now + LEASE_CONFIG.CLAIM_LEASE_MS;

  const [updated] = await database
    .update(generationJobs)
    .set({ claimUntilMs, updatedAtMs: now })
    .where(
      and(
        eq(generationJobs.id, jobId),
        // The worker intentionally retains ownership through managed-runtime
        // restart/readiness after durable terminal finalization.
        inArray(generationJobs.status, ["RUNNING", "CANCEL_REQUESTED", "SUCCEEDED", "CANCELLED", "FAILED"]),
        eq(generationJobs.claimOwner, workerId),
        eq(generationJobs.claimFencingToken, fencingToken),
        sql`${generationJobs.claimUntilMs} > ${now}`,
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
  attemptJobClaimFencingToken: number | null;
  attemptResourcePoolId: string | null;
  attemptResourceSlotNo: number | null;
  attemptResourceLeaseToken: string | null;
  attemptResourceFencingToken: number | null;
  jobStatus: typeof generationJobs.$inferSelect.status | null;
}

export interface SlotReconciliationOutcome {
  resourcePoolId: string;
  slotNo: number;
  ownerAttemptId: string;
  disposition: "retained" | "reconciled";
  reason: "pre-submission-safe" | "pre-submission-placeholder" | "invalid-claim-placeholder" | "termination-proven" | "termination-proof-missing" | "slot-changed" | "live-job-claim";
  jobId?: string;
  jobDisposition?: "requeued" | "cancelled" | "needs-attention";
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
    attemptJobClaimFencingToken: generationAttempts.jobClaimFencingToken,
    attemptResourcePoolId: generationAttempts.resourcePoolId,
    attemptResourceSlotNo: generationAttempts.resourceSlotNo,
    attemptResourceLeaseToken: generationAttempts.resourceLeaseToken,
    attemptResourceFencingToken: generationAttempts.resourceFencingToken,
    jobStatus: generationJobs.status,
  }).from(resourcePoolSlots)
    .leftJoin(generationAttempts, eq(generationAttempts.id, resourcePoolSlots.ownerAttemptId))
    .leftJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
    .where(sql`${resourcePoolSlots.expiresAtMs} <= ${scanNow} AND ${resourcePoolSlots.ownerAttemptId} IS NOT NULL`);

  return rows.flatMap(({
    slot,
    attemptPhase,
    backendId,
    externalJobId,
    attemptJobClaimFencingToken,
    attemptResourcePoolId,
    attemptResourceSlotNo,
    attemptResourceLeaseToken,
    attemptResourceFencingToken,
    jobStatus,
  }) => {
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
      attemptJobClaimFencingToken,
      attemptResourcePoolId,
      attemptResourceSlotNo,
      attemptResourceLeaseToken,
      attemptResourceFencingToken,
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
          || currentAttempt.jobClaimFencingToken !== slot.attemptJobClaimFencingToken
          || currentAttempt.resourcePoolId !== slot.attemptResourcePoolId
          || currentAttempt.resourceSlotNo !== slot.attemptResourceSlotNo
          || currentAttempt.resourceLeaseToken !== slot.attemptResourceLeaseToken
          || currentAttempt.resourceFencingToken !== slot.attemptResourceFencingToken) {
          return { disposition: "retained", reason: "slot-changed" } as const;
        }

        const isUnboundPlaceholder = currentAttempt.phase === "PREPARING"
          && currentAttempt.externalJobId === null
          && currentAttempt.resourcePoolId === slot.resourcePoolId
          && currentAttempt.resourceSlotNo === 0
          && currentAttempt.resourceLeaseToken === `pending-${currentAttempt.id}`
          && currentAttempt.resourceFencingToken === 0;
        if (!isUnboundPlaceholder
          && (currentAttempt.resourcePoolId !== slot.resourcePoolId
            || currentAttempt.resourceSlotNo !== slot.slotNo
            || currentAttempt.resourceLeaseToken !== slot.leaseToken
            || currentAttempt.resourceFencingToken !== slot.fencingToken)) {
          return { disposition: "retained", reason: "slot-changed" } as const;
        }

        const safeBeforeSubmission = preSubmissionPhases.has(currentAttempt.phase)
          && currentAttempt.externalJobId === null;
        const currentJob = safeBeforeSubmission ? tx.select({
          status: generationJobs.status,
          currentAttemptId: generationJobs.currentAttemptId,
          claimOwner: generationJobs.claimOwner,
          claimUntilMs: generationJobs.claimUntilMs,
          claimFencingToken: generationJobs.claimFencingToken,
        }).from(generationJobs).where(eq(generationJobs.id, currentAttempt.jobId)).get() : undefined;
        if (safeBeforeSubmission && (!currentJob
          || currentJob.currentAttemptId !== currentAttempt.id
          || (currentJob.status !== "RUNNING" && currentJob.status !== "CANCEL_REQUESTED")
          || currentJob.claimFencingToken !== currentAttempt.jobClaimFencingToken)) {
          return { disposition: "retained", reason: "slot-changed" } as const;
        }
        if (currentJob?.currentAttemptId === currentAttempt.id
          && currentJob.claimOwner !== null
          && currentJob.claimUntilMs !== null
          && currentJob.claimUntilMs > scanNow) {
          return { disposition: "retained", reason: "live-job-claim" } as const;
        }

        if (safeBeforeSubmission && currentJob) {
          const invalidClaimLease = currentJob.claimOwner !== null && currentJob.claimUntilMs === null;
          const recoverableJobStatus = currentJob.status === "CANCEL_REQUESTED"
            ? "CANCEL_REQUESTED" : "RUNNING";
          const plan = planPreSubmissionRecovery(
            recoverableJobStatus,
            invalidClaimLease ? "invalid_claim_lease" : "expired_claim",
            scanNow,
          );
          const jobDisposition = plan.disposition;
          const attemptChanged = tx.update(generationAttempts).set(plan.attemptPatch).where(and(
            eq(generationAttempts.id, currentAttempt.id),
            eq(generationAttempts.jobId, currentAttempt.jobId),
            eq(generationAttempts.phase, currentAttempt.phase),
            eq(generationAttempts.jobClaimFencingToken, currentAttempt.jobClaimFencingToken),
            isNull(generationAttempts.externalJobId),
            eq(generationAttempts.resourcePoolId, currentAttempt.resourcePoolId!),
            eq(generationAttempts.resourceSlotNo, currentAttempt.resourceSlotNo!),
            eq(generationAttempts.resourceLeaseToken, currentAttempt.resourceLeaseToken!),
            eq(generationAttempts.resourceFencingToken, currentAttempt.resourceFencingToken!),
          )).run();
          if (attemptChanged.changes !== 1) throw new SlotReconciliationRollback();

          const claimOwnerPredicate = currentJob.claimOwner === null
            ? isNull(generationJobs.claimOwner)
            : eq(generationJobs.claimOwner, currentJob.claimOwner);
          const claimUntilPredicate = currentJob.claimUntilMs === null
            ? isNull(generationJobs.claimUntilMs)
            : eq(generationJobs.claimUntilMs, currentJob.claimUntilMs);
          const jobChanged = tx.update(generationJobs).set({
            ...plan.jobPatch,
            claimOwner: null,
            claimUntilMs: null,
            claimFencingToken: currentJob.claimFencingToken + 1,
          }).where(and(
            eq(generationJobs.id, currentAttempt.jobId),
            eq(generationJobs.status, currentJob.status),
            eq(generationJobs.currentAttemptId, currentAttempt.id),
            eq(generationJobs.claimFencingToken, currentJob.claimFencingToken),
            claimOwnerPredicate,
            claimUntilPredicate,
          )).run();
          if (jobChanged.changes !== 1) throw new SlotReconciliationRollback();

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
            sql`${resourcePoolSlots.expiresAtMs} <= ${scanNow}`,
          )).run();
          if (released.changes !== 1) throw new SlotReconciliationRollback();

          if (plan.terminalEventType) {
            tx.insert(generationEvents).values({
              id: genId(),
              jobId: currentAttempt.jobId,
              attemptId: currentAttempt.id,
              eventType: plan.terminalEventType,
              severity: "info",
              safePayloadJson: {},
              createdAtMs: scanNow,
            }).run();
          }
          return {
            disposition: "reconciled",
            reason: invalidClaimLease ? "invalid-claim-placeholder"
              : isUnboundPlaceholder ? "pre-submission-placeholder" : "pre-submission-safe",
            jobId: currentAttempt.jobId,
            jobDisposition,
          } as const;
        }
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
          sql`${resourcePoolSlots.expiresAtMs} <= ${scanNow}`,
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
          reason: isUnboundPlaceholder
            ? "pre-submission-placeholder"
            : safeBeforeSubmission ? "pre-submission-safe" : "termination-proven",
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
  const atomicSlotRecoveries = slotOutcomes.filter((outcome) => outcome.disposition === "reconciled"
    && outcome.jobId !== undefined && outcome.jobDisposition !== undefined);
  const handledJobIds = new Set(atomicSlotRecoveries.map((outcome) => outcome.jobId!));
  const jobRecovery = await applyExpiredJobCandidates(
    candidates.filter((candidate) => !handledJobIds.has(candidate.jobId)),
  );
  for (const outcome of atomicSlotRecoveries) {
    const jobId = outcome.jobId!;
    jobRecovery.outcomes.push({ jobId, status: "applied", disposition: outcome.jobDisposition });
    if (outcome.jobDisposition === "requeued") jobRecovery.requeuedJobs.push(jobId);
    else if (outcome.jobDisposition === "cancelled") jobRecovery.cancelledJobs.push(jobId);
    else jobRecovery.attentionJobs.push(jobId);
  }
  const releasedSlots = slotOutcomes
    .filter((outcome) => outcome.disposition === "reconciled")
    .map((outcome) => ({ poolId: outcome.resourcePoolId, slotNo: outcome.slotNo }));
  return { ...jobRecovery, releasedSlots };
}
