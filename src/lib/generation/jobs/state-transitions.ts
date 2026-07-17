import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { generationAttempts, generationEvents, generationJobs, resourcePoolSlots } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";

type JobStatus = typeof generationJobs.$inferSelect.status;
export type AttemptPhase = typeof generationAttempts.$inferSelect.phase;
export type OwnedAttemptValues = Partial<Omit<typeof generationAttempts.$inferInsert,
  "id" | "jobId" | "attemptNo" | "jobClaimFencingToken" | "createdAtMs">>;
export type OwnedAttemptPatch = Omit<OwnedAttemptValues, "phase">;

export type TransitionResult<T extends object = object> =
  | ({ status: "applied" } & T)
  | { status: "lost-race" }
  | { status: "invalid-transition" }
  | { status: "ownership-lost" };

export type RecoveryTransitionResult<T extends object = object> =
  | TransitionResult<T>
  | { status: "deferred-resource-slot" };

interface ExpiredJobSnapshotBase {
  jobId: string;
  jobStatus: "RUNNING" | "CANCEL_REQUESTED";
  claimFencingToken: number;
  currentAttemptId: string | null;
  attempt: null | {
    id: string;
    phase: AttemptPhase;
    jobClaimFencingToken: number;
    externalJobId: string | null;
  };
}

export type ExpiredJobSnapshot = ExpiredJobSnapshotBase & (
  | { claimKind: "expired"; claimOwner: string; claimUntilMs: number }
  | { claimKind: "malformed-ownerless"; claimOwner: null; claimUntilMs: number | null }
  | { claimKind: "malformed-missing-expiry"; claimOwner: string; claimUntilMs: null }
);

export interface OwnedAttemptIdentity {
  jobId: string;
  attemptId: string;
  workerId: string;
  jobFencingToken: number;
}

export interface OwnedJobIdentity {
  jobId: string;
  workerId: string;
  jobFencingToken: number;
}

export interface SubmissionResourceIdentity {
  resourcePoolId: string;
  slotNo: number;
  leaseToken: string;
  fencingToken: number;
  clock?: () => number;
}

export type InvalidResourceCardinalityResult = { status: "invalid-resource-cardinality" };
export type BeginSubmissionResult = TransitionResult
  | { status: "cancelled-before-submission" }
  | InvalidResourceCardinalityResult;

const PRE_SUBMISSION_PHASES = new Set<AttemptPhase>(["CREATED", "LEASED", "PREPARING"]);

export type PreSubmissionRecoveryDisposition = "requeued" | "cancelled" | "needs-attention";

/** Shared recovery semantics for claims that are known to be pre-submission. */
export function planPreSubmissionRecovery(
  jobStatus: "RUNNING" | "CANCEL_REQUESTED",
  cause: "expired_claim" | "invalid_claim_lease",
  now: number,
): {
  disposition: PreSubmissionRecoveryDisposition;
  attemptPatch: Partial<typeof generationAttempts.$inferInsert>;
  jobPatch: Partial<typeof generationJobs.$inferInsert>;
  terminalEventType?: "job_cancelled";
} {
  if (cause === "invalid_claim_lease") {
    return {
      disposition: "needs-attention",
      attemptPatch: {
        phase: "ORPHANED",
        errorClass: "invalid_claim_lease",
        errorCode: "invalid_claim_lease",
        errorMessageSafe: "The worker claim has an owner but no expiry",
        finishedAtMs: now,
        updatedAtMs: now,
      },
      jobPatch: {
        status: "NEEDS_ATTENTION",
        needsAttentionReason: "invalid_claim_lease",
        updatedAtMs: now,
      },
    };
  }
  if (jobStatus === "CANCEL_REQUESTED") {
    return {
      disposition: "cancelled",
      attemptPatch: { phase: "CANCELLED", finishedAtMs: now, updatedAtMs: now },
      jobPatch: { status: "CANCELLED", completedAtMs: now, updatedAtMs: now },
      terminalEventType: "job_cancelled",
    };
  }
  return {
    disposition: "requeued",
    attemptPatch: {
      phase: "ORPHANED",
      errorClass: "expired_pre_submission_claim",
      errorCode: "expired_pre_submission_claim",
      errorMessageSafe: "The previous worker lost ownership before external submission",
      finishedAtMs: now,
      updatedAtMs: now,
    },
    jobPatch: { status: "QUEUED", currentAttemptId: null, updatedAtMs: now },
  };
}

class TransitionRollback extends Error {
  readonly transitionStatus: "lost-race";

  constructor(status: "lost-race") {
    super(status);
    this.transitionStatus = status;
  }
}

function rollbackLostRace(): never {
  throw new TransitionRollback("lost-race");
}

function quarantineInvalidResourceCardinality(
  database: DB,
  identity: OwnedAttemptIdentity,
  current: { attemptPhase: AttemptPhase; jobStatus: JobStatus; claimFencingToken: number },
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
    eq(generationAttempts.id, identity.attemptId),
    eq(generationAttempts.phase, current.attemptPhase),
    eq(generationAttempts.jobClaimFencingToken, identity.jobFencingToken),
  )).run();
  if (attemptChanged.changes !== 1) rollbackLostRace();
  const jobChanged = database.update(generationJobs).set({
    status: "NEEDS_ATTENTION",
    claimOwner: null,
    claimUntilMs: null,
    claimFencingToken: current.claimFencingToken + 1,
    needsAttentionReason: "invalid_resource_cardinality",
    updatedAtMs: now,
  }).where(and(
    eq(generationJobs.id, identity.jobId),
    eq(generationJobs.status, current.jobStatus),
    eq(generationJobs.currentAttemptId, identity.attemptId),
    eq(generationJobs.claimFencingToken, current.claimFencingToken),
  )).run();
  if (jobChanged.changes !== 1) rollbackLostRace();
  database.insert(generationEvents).values({
    id: genId(),
    jobId: identity.jobId,
    attemptId: identity.attemptId,
    eventType: "invalid_resource_cardinality",
    severity: "error",
    safePayloadJson: {},
    createdAtMs: now,
  }).run();
}

/**
 * Apply one expired-claim decision against the exact job/attempt snapshot the
 * scanner observed. The immediate transaction acquires the writer lock before
 * re-reading, so a worker phase write and recovery can never both commit.
 */
export function recoverExpiredJob(
  snapshot: ExpiredJobSnapshot,
  database: DB = db,
  clock: () => number = Date.now,
): RecoveryTransitionResult<{
  disposition: "requeued" | "cancelled" | "needs-attention";
  reason?: "invalid-resource-lease-identity";
}> {
  try {
    return database.transaction((tx) => {
      const now = clock();
      const currentJob = tx.select().from(generationJobs)
        .where(eq(generationJobs.id, snapshot.jobId)).get();
      if (!currentJob) return { status: "lost-race" } as const;

      if (currentJob.status !== snapshot.jobStatus
        || currentJob.claimOwner !== snapshot.claimOwner
        || currentJob.claimUntilMs !== snapshot.claimUntilMs
        || currentJob.claimFencingToken !== snapshot.claimFencingToken
        || currentJob.currentAttemptId !== snapshot.currentAttemptId) {
        return { status: "lost-race" } as const;
      }
      if (snapshot.claimKind === "expired"
        && (currentJob.claimUntilMs === null || currentJob.claimUntilMs > now)) {
        return { status: "invalid-transition" } as const;
      }

      const currentAttempt = snapshot.currentAttemptId
        ? tx.select().from(generationAttempts)
          .where(eq(generationAttempts.id, snapshot.currentAttemptId)).get()
        : undefined;
      if (snapshot.attempt === null) {
        if (currentAttempt) return { status: "lost-race" } as const;
      } else if (!currentAttempt
        || currentAttempt.id !== snapshot.attempt.id
        || currentAttempt.jobId !== snapshot.jobId
        || currentAttempt.phase !== snapshot.attempt.phase
        || currentAttempt.jobClaimFencingToken !== snapshot.attempt.jobClaimFencingToken
        || currentAttempt.externalJobId !== snapshot.attempt.externalJobId) {
        return { status: "lost-race" } as const;
      }

      const safeBeforeSubmission = !currentAttempt
        || (PRE_SUBMISSION_PHASES.has(currentAttempt.phase) && !currentAttempt.externalJobId);
      if (safeBeforeSubmission) {
        if (currentAttempt) {
          const ownedSlots = tx.select().from(resourcePoolSlots)
            .where(eq(resourcePoolSlots.ownerAttemptId, currentAttempt.id)).all();
          const occupiedSlots = ownedSlots.filter((slot) => slot.leaseToken !== null && slot.expiresAtMs !== null);
          const ownsRecoverableSlot = occupiedSlots.some((slot) => {
            // Expired is still occupied: only the slot scanner may recover all
            // three records atomically after validating this physical identity.
            const placeholderIdentity = currentAttempt.phase === "PREPARING"
              && currentAttempt.resourcePoolId === slot.resourcePoolId
              && currentAttempt.resourceSlotNo === 0
              && currentAttempt.resourceLeaseToken === `pending-${currentAttempt.id}`
              && currentAttempt.resourceFencingToken === 0;
            const boundIdentity = currentAttempt.resourcePoolId === slot.resourcePoolId
              && currentAttempt.resourceSlotNo === slot.slotNo
              && currentAttempt.resourceLeaseToken === slot.leaseToken
              && currentAttempt.resourceFencingToken === slot.fencingToken;
            return placeholderIdentity || boundIdentity;
          });
          if (ownsRecoverableSlot) return { status: "deferred-resource-slot" } as const;
          if (occupiedSlots.length > 0) {
            const attemptChanged = tx.update(generationAttempts).set({
              phase: "ORPHANED",
              errorClass: "invalid_resource_lease_identity",
              errorCode: "invalid_resource_lease_identity",
              errorMessageSafe: "The persisted attempt identity does not match its occupied resource slot",
              finishedAtMs: now,
              updatedAtMs: now,
            }).where(and(
              eq(generationAttempts.id, currentAttempt.id),
              eq(generationAttempts.phase, currentAttempt.phase),
              eq(generationAttempts.jobClaimFencingToken, snapshot.attempt!.jobClaimFencingToken),
            )).run();
            if (attemptChanged.changes !== 1) rollbackLostRace();
            const jobChanged = tx.update(generationJobs).set({
              status: "NEEDS_ATTENTION",
              claimOwner: null,
              claimUntilMs: null,
              claimFencingToken: snapshot.claimFencingToken + 1,
              needsAttentionReason: "invalid_resource_lease_identity",
              updatedAtMs: now,
            }).where(eq(generationJobs.id, snapshot.jobId)).run();
            if (jobChanged.changes !== 1) rollbackLostRace();
            return {
              status: "applied",
              disposition: "needs-attention",
              reason: "invalid-resource-lease-identity",
            } as const;
          }
        }
        const plan = planPreSubmissionRecovery(
          currentJob.status,
          snapshot.claimKind === "malformed-missing-expiry" ? "invalid_claim_lease" : "expired_claim",
          now,
        );
        if (currentAttempt) {
          const attemptChanged = tx.update(generationAttempts).set(plan.attemptPatch).where(and(
            eq(generationAttempts.id, currentAttempt.id),
            eq(generationAttempts.phase, currentAttempt.phase),
            eq(generationAttempts.jobClaimFencingToken, snapshot.attempt!.jobClaimFencingToken),
          )).run();
          if (attemptChanged.changes !== 1) rollbackLostRace();
        }
        const jobChanged = tx.update(generationJobs).set({
          ...plan.jobPatch,
          claimOwner: null,
          claimUntilMs: null,
          claimFencingToken: snapshot.claimFencingToken + 1,
        }).where(eq(generationJobs.id, snapshot.jobId)).run();
        if (jobChanged.changes !== 1) rollbackLostRace();
        if (plan.terminalEventType) {
          tx.insert(generationEvents).values({
            id: genId(),
            jobId: snapshot.jobId,
            attemptId: currentAttempt?.id ?? null,
            eventType: plan.terminalEventType,
            severity: "info",
            safePayloadJson: {},
            createdAtMs: now,
          }).run();
        }
        return { status: "applied", disposition: plan.disposition } as const;
      }

      if (!currentAttempt) return { status: "invalid-transition" } as const;
      const jobChanged = tx.update(generationJobs).set({
        status: "NEEDS_ATTENTION",
        claimOwner: null,
        claimUntilMs: null,
        claimFencingToken: snapshot.claimFencingToken + 1,
        needsAttentionReason: `expired_claim:${currentAttempt.phase}:external=${currentAttempt.externalJobId ?? "unknown"}`,
        updatedAtMs: now,
      }).where(eq(generationJobs.id, snapshot.jobId)).run();
      if (jobChanged.changes !== 1) rollbackLostRace();
      return { status: "applied", disposition: "needs-attention" } as const;
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof TransitionRollback) return { status: error.transitionStatus };
    throw error;
  }
}

/** Atomically create an attempt and bind it as the owned job's current attempt. */
export function attachOwnedAttempt(
  identity: OwnedJobIdentity,
  input: {
    clock?: () => number;
    attempt: typeof generationAttempts.$inferInsert;
  },
  database: DB = db,
): TransitionResult {
  if (input.attempt.jobId !== identity.jobId
    || input.attempt.jobClaimFencingToken !== identity.jobFencingToken
    || input.attempt.phase !== "PREPARING") {
    return { status: "invalid-transition" };
  }
  try {
    return database.transaction((tx) => {
      const now = input.clock?.() ?? Date.now();
      const current = tx.select().from(generationJobs)
        .where(eq(generationJobs.id, identity.jobId)).get();
      if (!current
        || current.currentAttemptId !== null
        || current.claimOwner !== identity.workerId
        || current.claimFencingToken !== identity.jobFencingToken
        || current.claimUntilMs === null
        || current.claimUntilMs <= now
        || current.status !== "RUNNING") {
        return { status: "ownership-lost" } as const;
      }

      const inserted = tx.insert(generationAttempts).values(input.attempt)
        .onConflictDoNothing().returning({ id: generationAttempts.id }).all();
      if (inserted.length !== 1) rollbackLostRace();

      const attached = tx.update(generationJobs).set({
        currentAttemptId: input.attempt.id,
        updatedAtMs: now,
      }).where(and(
        eq(generationJobs.id, identity.jobId),
        eq(generationJobs.status, "RUNNING"),
        eq(generationJobs.claimOwner, identity.workerId),
        eq(generationJobs.claimFencingToken, identity.jobFencingToken),
        isNull(generationJobs.currentAttemptId),
      )).returning({ id: generationJobs.id }).all();
      if (attached.length !== 1) rollbackLostRace();
      return { status: "applied" } as const;
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof TransitionRollback) return { status: error.transitionStatus };
    throw error;
  }
}

/** Cancel an owned request that was cancelled before an attempt could attach. */
export function cancelOwnedJobBeforeAttempt(
  identity: OwnedJobIdentity,
  database: DB = db,
  clock: () => number = Date.now,
): TransitionResult {
  return database.transaction((tx) => {
    const now = clock();
    const current = tx.select().from(generationJobs)
      .where(eq(generationJobs.id, identity.jobId)).get();
    if (!current
      || current.currentAttemptId !== null
      || current.claimOwner !== identity.workerId
      || current.claimFencingToken !== identity.jobFencingToken
      || current.claimUntilMs === null
      || current.claimUntilMs <= now) return { status: "ownership-lost" } as const;
    if (current.status !== "CANCEL_REQUESTED") return { status: "invalid-transition" } as const;
    const changed = tx.update(generationJobs).set({
      status: "CANCELLED",
      completedAtMs: now,
      updatedAtMs: now,
    }).where(and(
      eq(generationJobs.id, identity.jobId),
      eq(generationJobs.status, "CANCEL_REQUESTED"),
      eq(generationJobs.claimOwner, identity.workerId),
      eq(generationJobs.claimFencingToken, identity.jobFencingToken),
      isNull(generationJobs.currentAttemptId),
    )).returning({ id: generationJobs.id }).all();
    if (!changed[0]) return { status: "lost-race" } as const;
    tx.insert(generationEvents).values({
      id: genId(),
      jobId: identity.jobId,
      attemptId: null,
      eventType: "job_cancelled_before_submission",
      severity: "info",
      safePayloadJson: {},
      createdAtMs: now,
    }).run();
    return { status: "applied" } as const;
  }, { behavior: "immediate" });
}

/** Cancel an attached placeholder before it owns any physical resource slot. */
export function cancelOwnedAttemptBeforeSubmission(
  identity: OwnedAttemptIdentity,
  database: DB = db,
  clock: () => number = Date.now,
): TransitionResult | InvalidResourceCardinalityResult {
  try {
    return database.transaction((tx) => {
      const now = clock();
      const current = tx.select({ attempt: generationAttempts, job: generationJobs })
        .from(generationAttempts)
        .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
        .where(eq(generationAttempts.id, identity.attemptId)).get();
      if (!current
        || current.attempt.jobId !== identity.jobId
        || current.job.currentAttemptId !== identity.attemptId
        || current.job.claimOwner !== identity.workerId
        || current.job.claimFencingToken !== identity.jobFencingToken
        || current.attempt.jobClaimFencingToken !== identity.jobFencingToken
        || current.job.claimUntilMs === null
        || current.job.claimUntilMs <= now) return { status: "ownership-lost" } as const;
      if (current.job.status !== "CANCEL_REQUESTED") return { status: "invalid-transition" } as const;
      if (current.attempt.phase !== "PREPARING"
        || current.attempt.externalJobId !== null
        || current.attempt.resourceSlotNo !== 0
        || current.attempt.resourceLeaseToken !== `pending-${current.attempt.id}`
        || current.attempt.resourceFencingToken !== 0) return { status: "invalid-transition" } as const;
      const occupied = tx.select({ slotNo: resourcePoolSlots.slotNo }).from(resourcePoolSlots)
        .where(eq(resourcePoolSlots.ownerAttemptId, identity.attemptId)).all();
      if (occupied.length > 1) {
        quarantineInvalidResourceCardinality(tx as unknown as DB, identity, {
          attemptPhase: current.attempt.phase,
          jobStatus: current.job.status,
          claimFencingToken: current.job.claimFencingToken,
        }, now);
        return { status: "invalid-resource-cardinality" } as const;
      }
      if (occupied.length === 1) return { status: "invalid-transition" } as const;

      const attemptChanged = tx.update(generationAttempts).set({
        phase: "CANCELLED",
        finishedAtMs: now,
        updatedAtMs: now,
      }).where(and(
        eq(generationAttempts.id, identity.attemptId),
        eq(generationAttempts.phase, "PREPARING"),
        eq(generationAttempts.jobClaimFencingToken, identity.jobFencingToken),
      )).run();
      if (attemptChanged.changes !== 1) rollbackLostRace();
      const jobChanged = tx.update(generationJobs).set({
        status: "CANCELLED",
        completedAtMs: now,
        updatedAtMs: now,
      }).where(and(
        eq(generationJobs.id, identity.jobId),
        eq(generationJobs.status, "CANCEL_REQUESTED"),
        eq(generationJobs.currentAttemptId, identity.attemptId),
        eq(generationJobs.claimOwner, identity.workerId),
        eq(generationJobs.claimFencingToken, identity.jobFencingToken),
      )).run();
      if (jobChanged.changes !== 1) rollbackLostRace();
      tx.insert(generationEvents).values({
        id: genId(),
        jobId: identity.jobId,
        attemptId: identity.attemptId,
        eventType: "job_cancelled_before_submission",
        severity: "info",
        safePayloadJson: {},
        createdAtMs: now,
      }).run();
      return { status: "applied" } as const;
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof TransitionRollback) return { status: error.transitionStatus };
    throw error;
  }
}

/**
 * Cross the external submission boundary only while both logical job ownership
 * and the exact physical resource lease are live in the same writer transaction.
 */
export function beginOwnedAttemptSubmission(
  identity: OwnedAttemptIdentity,
  resource: SubmissionResourceIdentity,
  database: DB = db,
): BeginSubmissionResult {
  try {
    return database.transaction((tx) => {
    const now = resource.clock?.() ?? Date.now();
    const current = tx.select({
      attemptPhase: generationAttempts.phase,
      attemptToken: generationAttempts.jobClaimFencingToken,
      attemptJobId: generationAttempts.jobId,
      attemptResourcePoolId: generationAttempts.resourcePoolId,
      attemptResourceSlotNo: generationAttempts.resourceSlotNo,
      attemptResourceLeaseToken: generationAttempts.resourceLeaseToken,
      attemptResourceFencingToken: generationAttempts.resourceFencingToken,
      attemptExternalJobId: generationAttempts.externalJobId,
      jobStatus: generationJobs.status,
      currentAttemptId: generationJobs.currentAttemptId,
      claimOwner: generationJobs.claimOwner,
      claimUntilMs: generationJobs.claimUntilMs,
      claimFencingToken: generationJobs.claimFencingToken,
    }).from(generationAttempts)
      .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
      .where(eq(generationAttempts.id, identity.attemptId)).get();

    if (!current
      || current.attemptJobId !== identity.jobId
      || current.currentAttemptId !== identity.attemptId
      || current.claimOwner !== identity.workerId
      || current.claimFencingToken !== identity.jobFencingToken
      || current.attemptToken !== identity.jobFencingToken
      || current.claimUntilMs === null
      || current.claimUntilMs <= now
      || (current.jobStatus !== "RUNNING" && current.jobStatus !== "CANCEL_REQUESTED")) {
      return { status: "ownership-lost" } as const;
    }
    if (current.attemptPhase !== "PREPARING") return { status: "invalid-transition" } as const;
    const ownedSlots = tx.select().from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.ownerAttemptId, identity.attemptId)).all();
    if (ownedSlots.length !== 1) {
      quarantineInvalidResourceCardinality(tx as unknown as DB, identity, {
        attemptPhase: current.attemptPhase,
        jobStatus: current.jobStatus,
        claimFencingToken: current.claimFencingToken,
      }, now);
      return { status: "invalid-resource-cardinality" } as const;
    }
    if (current.attemptResourcePoolId !== resource.resourcePoolId) {
      return { status: "ownership-lost" } as const;
    }

    const slot = tx.select().from(resourcePoolSlots).where(and(
      eq(resourcePoolSlots.resourcePoolId, resource.resourcePoolId),
      eq(resourcePoolSlots.slotNo, resource.slotNo),
    )).get();
    if (!slot
      || slot.ownerAttemptId !== identity.attemptId
      || slot.leaseToken !== resource.leaseToken
      || slot.fencingToken !== resource.fencingToken
      || slot.expiresAtMs === null
      || slot.expiresAtMs <= now) {
      return { status: "ownership-lost" } as const;
    }

    if (current.jobStatus === "CANCEL_REQUESTED") {
      if (current.attemptExternalJobId !== null
        || current.attemptResourceSlotNo !== 0
        || current.attemptResourceLeaseToken !== `pending-${identity.attemptId}`
        || current.attemptResourceFencingToken !== 0) {
        return { status: "invalid-transition" } as const;
      }
      const attemptChanged = tx.update(generationAttempts).set({
        phase: "CANCELLED",
        finishedAtMs: now,
        updatedAtMs: now,
      }).where(and(
        eq(generationAttempts.id, identity.attemptId),
        eq(generationAttempts.phase, "PREPARING"),
        eq(generationAttempts.jobClaimFencingToken, identity.jobFencingToken),
      )).run();
      if (attemptChanged.changes !== 1) rollbackLostRace();
      const jobChanged = tx.update(generationJobs).set({
        status: "CANCELLED",
        completedAtMs: now,
        updatedAtMs: now,
      }).where(and(
        eq(generationJobs.id, identity.jobId),
        eq(generationJobs.status, "CANCEL_REQUESTED"),
        eq(generationJobs.currentAttemptId, identity.attemptId),
        eq(generationJobs.claimOwner, identity.workerId),
        eq(generationJobs.claimFencingToken, identity.jobFencingToken),
      )).run();
      if (jobChanged.changes !== 1) rollbackLostRace();
      const slotChanged = tx.update(resourcePoolSlots).set({
        ownerAttemptId: null,
        leaseToken: null,
        expiresAtMs: null,
        fencingToken: sql`${resourcePoolSlots.fencingToken} + 1`,
        updatedAtMs: now,
      }).where(and(
        eq(resourcePoolSlots.resourcePoolId, resource.resourcePoolId),
        eq(resourcePoolSlots.slotNo, resource.slotNo),
        eq(resourcePoolSlots.ownerAttemptId, identity.attemptId),
        eq(resourcePoolSlots.leaseToken, resource.leaseToken),
        eq(resourcePoolSlots.fencingToken, resource.fencingToken),
      )).run();
      if (slotChanged.changes !== 1) rollbackLostRace();
      tx.insert(generationEvents).values({
        id: genId(),
        jobId: identity.jobId,
        attemptId: identity.attemptId,
        eventType: "job_cancelled_before_submission",
        severity: "info",
        safePayloadJson: {},
        createdAtMs: now,
      }).run();
      return { status: "cancelled-before-submission" } as const;
    }

    const changed = tx.update(generationAttempts).set({
      phase: "SUBMITTING",
      resourceSlotNo: resource.slotNo,
      resourceLeaseToken: resource.leaseToken,
      resourceFencingToken: resource.fencingToken,
      updatedAtMs: now,
    }).where(and(
      eq(generationAttempts.id, identity.attemptId),
      eq(generationAttempts.jobClaimFencingToken, identity.jobFencingToken),
      eq(generationAttempts.phase, "PREPARING"),
      eq(generationAttempts.resourcePoolId, resource.resourcePoolId),
    )).returning({ id: generationAttempts.id }).all();
    return changed.length === 1 ? { status: "applied" } as const : { status: "lost-race" } as const;
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof TransitionRollback) return { status: error.transitionStatus };
    throw error;
  }
}

/** Update a worker-owned attempt only while it remains the live job attempt. */
export function updateOwnedAttempt(
  identity: OwnedAttemptIdentity,
  input: {
    clock?: () => number;
    expectedPhases: readonly AttemptPhase[];
    nextPhase?: AttemptPhase;
    values: OwnedAttemptPatch;
    event?: {
      eventType: string;
      severity: typeof generationEvents.$inferInsert.severity;
      safePayloadJson: Record<string, unknown>;
    };
  },
  database: DB = db,
): TransitionResult {
  return database.transaction((tx) => {
    const now = input.clock?.() ?? Date.now();
    const current = tx.select({
      attemptPhase: generationAttempts.phase,
      attemptToken: generationAttempts.jobClaimFencingToken,
      attemptJobId: generationAttempts.jobId,
      attemptResourceSlotNo: generationAttempts.resourceSlotNo,
      attemptResourceLeaseToken: generationAttempts.resourceLeaseToken,
      attemptResourceFencingToken: generationAttempts.resourceFencingToken,
      jobStatus: generationJobs.status,
      currentAttemptId: generationJobs.currentAttemptId,
      claimOwner: generationJobs.claimOwner,
      claimUntilMs: generationJobs.claimUntilMs,
      claimFencingToken: generationJobs.claimFencingToken,
    }).from(generationAttempts)
      .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
      .where(eq(generationAttempts.id, identity.attemptId)).get();

    if (!current
      || current.attemptJobId !== identity.jobId
      || current.currentAttemptId !== identity.attemptId
      || current.claimOwner !== identity.workerId
      || current.claimFencingToken !== identity.jobFencingToken
      || current.attemptToken !== identity.jobFencingToken
      || current.attemptResourceSlotNo <= 0
      || !current.attemptResourceLeaseToken
      || current.attemptResourceLeaseToken.startsWith("pending-")
      || current.attemptResourceFencingToken <= 0
      || current.claimUntilMs === null
      || current.claimUntilMs <= now
      || !(["RUNNING", "CANCEL_REQUESTED"] as JobStatus[]).includes(current.jobStatus)) {
      return { status: "ownership-lost" } as const;
    }
    if (!input.expectedPhases.includes(current.attemptPhase)) {
      return { status: "invalid-transition" } as const;
    }

    const changed = tx.update(generationAttempts).set({
      ...input.values,
      ...(input.nextPhase ? { phase: input.nextPhase } : {}),
      updatedAtMs: now,
    }).where(and(
      eq(generationAttempts.id, identity.attemptId),
      eq(generationAttempts.jobClaimFencingToken, identity.jobFencingToken),
      eq(generationAttempts.phase, current.attemptPhase),
    )).returning({ id: generationAttempts.id }).all();
    if (!changed[0]) return { status: "lost-race" } as const;

    if (input.event) {
      tx.insert(generationEvents).values({
        id: genId(),
        jobId: identity.jobId,
        attemptId: identity.attemptId,
        ...input.event,
        createdAtMs: now,
      }).run();
    }
    return { status: "applied" } as const;
  }, { behavior: "immediate" });
}

/** Finalize a worker-owned attempt, its job, and the matching event atomically. */
export function finalizeOwnedExecution(
  identity: OwnedAttemptIdentity,
  input: {
    clock?: () => number;
    expectedJobStatuses: readonly ("RUNNING" | "CANCEL_REQUESTED")[];
    expectedAttemptPhases: readonly AttemptPhase[];
    requiredPriorEventType?: string;
    attemptValues: OwnedAttemptValues;
    jobValues: Partial<Omit<typeof generationJobs.$inferInsert,
      "id" | "currentAttemptId" | "claimOwner" | "claimUntilMs" | "claimFencingToken" | "createdAtMs">>;
    event: {
      eventType: string;
      severity: typeof generationEvents.$inferInsert.severity;
      safePayloadJson: Record<string, unknown>;
    };
  },
  database: DB = db,
): TransitionResult {
  try {
    return database.transaction((tx) => {
      const now = input.clock?.() ?? Date.now();
      const current = tx.select({
        attemptPhase: generationAttempts.phase,
        attemptToken: generationAttempts.jobClaimFencingToken,
        attemptJobId: generationAttempts.jobId,
        jobStatus: generationJobs.status,
        currentAttemptId: generationJobs.currentAttemptId,
        claimOwner: generationJobs.claimOwner,
        claimUntilMs: generationJobs.claimUntilMs,
        claimFencingToken: generationJobs.claimFencingToken,
      }).from(generationAttempts)
        .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
        .where(eq(generationAttempts.id, identity.attemptId)).get();

      if (!current
        || current.attemptJobId !== identity.jobId
        || current.currentAttemptId !== identity.attemptId
        || current.claimOwner !== identity.workerId
        || current.claimFencingToken !== identity.jobFencingToken
        || current.attemptToken !== identity.jobFencingToken
        || current.claimUntilMs === null
        || current.claimUntilMs <= now
        || (current.jobStatus !== "RUNNING" && current.jobStatus !== "CANCEL_REQUESTED")) {
        return { status: "ownership-lost" } as const;
      }
      if (!input.expectedJobStatuses.includes(current.jobStatus)
        || !input.expectedAttemptPhases.includes(current.attemptPhase)) {
        return { status: "invalid-transition" } as const;
      }
      if (input.requiredPriorEventType) {
        const evidence = tx.select({ id: generationEvents.id }).from(generationEvents).where(and(
          eq(generationEvents.jobId, identity.jobId),
          eq(generationEvents.attemptId, identity.attemptId),
          eq(generationEvents.eventType, input.requiredPriorEventType),
        )).get();
        if (!evidence) return { status: "invalid-transition" } as const;
      }

      const attemptChanged = tx.update(generationAttempts).set({
        ...input.attemptValues,
        updatedAtMs: now,
      }).where(and(
        eq(generationAttempts.id, identity.attemptId),
        eq(generationAttempts.jobClaimFencingToken, identity.jobFencingToken),
        eq(generationAttempts.phase, current.attemptPhase),
      )).returning({ id: generationAttempts.id }).all();
      if (!attemptChanged[0]) rollbackLostRace();

      const jobChanged = tx.update(generationJobs).set({
        ...input.jobValues,
        updatedAtMs: now,
      }).where(and(
        eq(generationJobs.id, identity.jobId),
        eq(generationJobs.status, current.jobStatus),
        eq(generationJobs.currentAttemptId, identity.attemptId),
        eq(generationJobs.claimOwner, identity.workerId),
        eq(generationJobs.claimFencingToken, identity.jobFencingToken),
      )).returning({ id: generationJobs.id }).all();
      if (!jobChanged[0]) rollbackLostRace();

      tx.insert(generationEvents).values({
        id: genId(),
        jobId: identity.jobId,
        attemptId: identity.attemptId,
        ...input.event,
        createdAtMs: now,
      }).run();
      return { status: "applied" } as const;
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof TransitionRollback) return { status: error.transitionStatus };
    throw error;
  }
}

/** Finalize an owned job that has no current attempt, with its event. */
export function finalizeOwnedJob(
  identity: OwnedJobIdentity,
  input: {
    clock?: () => number;
    expectedJobStatuses: readonly ("RUNNING" | "CANCEL_REQUESTED")[];
    jobValues: Partial<Omit<typeof generationJobs.$inferInsert,
      "id" | "currentAttemptId" | "claimOwner" | "claimUntilMs" | "claimFencingToken" | "createdAtMs">>;
    event: {
      eventType: string;
      severity: typeof generationEvents.$inferInsert.severity;
      safePayloadJson: Record<string, unknown>;
    };
  },
  database: DB = db,
): TransitionResult {
  return database.transaction((tx) => {
    const now = input.clock?.() ?? Date.now();
    const current = tx.select().from(generationJobs)
      .where(eq(generationJobs.id, identity.jobId)).get();
    if (!current
      || current.currentAttemptId !== null
      || current.claimOwner !== identity.workerId
      || current.claimFencingToken !== identity.jobFencingToken
      || current.claimUntilMs === null
      || current.claimUntilMs <= now
      || (current.status !== "RUNNING" && current.status !== "CANCEL_REQUESTED")) {
      return { status: "ownership-lost" } as const;
    }
    if (!input.expectedJobStatuses.includes(current.status)) {
      return { status: "invalid-transition" } as const;
    }
    const changed = tx.update(generationJobs).set({
      ...input.jobValues,
      updatedAtMs: now,
    }).where(and(
      eq(generationJobs.id, identity.jobId),
      eq(generationJobs.status, current.status),
      eq(generationJobs.claimOwner, identity.workerId),
      eq(generationJobs.claimFencingToken, identity.jobFencingToken),
    )).returning({ id: generationJobs.id }).all();
    if (!changed[0]) return { status: "lost-race" } as const;
    tx.insert(generationEvents).values({
      id: genId(),
      jobId: identity.jobId,
      attemptId: null,
      ...input.event,
      createdAtMs: now,
    }).run();
    return { status: "applied" } as const;
  }, { behavior: "immediate" });
}
