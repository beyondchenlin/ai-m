import { and, eq, isNull } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { generationAttempts, generationEvents, generationJobs } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";

type JobStatus = typeof generationJobs.$inferSelect.status;
type AttemptPhase = typeof generationAttempts.$inferSelect.phase;
export type OwnedAttemptValues = Partial<Omit<typeof generationAttempts.$inferInsert,
  "id" | "jobId" | "attemptNo" | "jobClaimFencingToken" | "createdAtMs">>;

export type TransitionResult<T extends object = object> =
  | ({ status: "applied" } & T)
  | { status: "lost-race" }
  | { status: "invalid-transition" }
  | { status: "ownership-lost" };

export interface ExpiredJobSnapshot {
  jobId: string;
  jobStatus: "RUNNING" | "CANCEL_REQUESTED";
  claimOwner: string;
  claimUntilMs: number;
  claimFencingToken: number;
  currentAttemptId: string | null;
  attempt: null | {
    id: string;
    phase: AttemptPhase;
    jobClaimFencingToken: number;
    externalJobId: string | null;
  };
}

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

const PRE_SUBMISSION_PHASES = new Set<AttemptPhase>(["CREATED", "LEASED", "PREPARING"]);

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

/**
 * Apply one expired-claim decision against the exact job/attempt snapshot the
 * scanner observed. The immediate transaction acquires the writer lock before
 * re-reading, so a worker phase write and recovery can never both commit.
 */
export function recoverExpiredJob(
  snapshot: ExpiredJobSnapshot,
  now: number,
  database: DB = db,
): TransitionResult<{ disposition: "requeued" | "cancelled" | "needs-attention" }> {
  try {
    return database.transaction((tx) => {
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
      if (currentJob.claimUntilMs === null || currentJob.claimUntilMs >= now) {
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
      if (currentJob.status === "CANCEL_REQUESTED" && safeBeforeSubmission) {
        if (currentAttempt) {
          const attemptChanged = tx.update(generationAttempts).set({
            phase: "CANCELLED",
            finishedAtMs: now,
            updatedAtMs: now,
          }).where(and(
            eq(generationAttempts.id, currentAttempt.id),
            eq(generationAttempts.phase, currentAttempt.phase),
            eq(generationAttempts.jobClaimFencingToken, snapshot.attempt!.jobClaimFencingToken),
          )).run();
          if (attemptChanged.changes !== 1) rollbackLostRace();
        }
        const jobChanged = tx.update(generationJobs).set({
          status: "CANCELLED",
          claimOwner: null,
          claimUntilMs: null,
          claimFencingToken: snapshot.claimFencingToken + 1,
          completedAtMs: now,
          updatedAtMs: now,
        }).where(eq(generationJobs.id, snapshot.jobId)).run();
        if (jobChanged.changes !== 1) rollbackLostRace();
        tx.insert(generationEvents).values({
          id: genId(),
          jobId: snapshot.jobId,
          attemptId: currentAttempt?.id ?? null,
          eventType: "job_cancelled",
          severity: "info",
          safePayloadJson: {},
          createdAtMs: now,
        }).run();
        return { status: "applied", disposition: "cancelled" } as const;
      }

      if (currentJob.status === "RUNNING" && safeBeforeSubmission) {
        if (currentAttempt) {
          const attemptChanged = tx.update(generationAttempts).set({
            phase: "ORPHANED",
            errorClass: "expired_pre_submission_claim",
            errorCode: "expired_pre_submission_claim",
            errorMessageSafe: "The previous worker lost ownership before external submission",
            finishedAtMs: now,
            updatedAtMs: now,
          }).where(and(
            eq(generationAttempts.id, currentAttempt.id),
            eq(generationAttempts.phase, currentAttempt.phase),
            eq(generationAttempts.jobClaimFencingToken, snapshot.attempt!.jobClaimFencingToken),
          )).run();
          if (attemptChanged.changes !== 1) rollbackLostRace();
        }
        const jobChanged = tx.update(generationJobs).set({
          status: "QUEUED",
          claimOwner: null,
          claimUntilMs: null,
          claimFencingToken: snapshot.claimFencingToken + 1,
          updatedAtMs: now,
        }).where(eq(generationJobs.id, snapshot.jobId)).run();
        if (jobChanged.changes !== 1) rollbackLostRace();
        return { status: "applied", disposition: "requeued" } as const;
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
    now: number;
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
      const current = tx.select().from(generationJobs)
        .where(eq(generationJobs.id, identity.jobId)).get();
      if (!current
        || current.currentAttemptId !== null
        || current.claimOwner !== identity.workerId
        || current.claimFencingToken !== identity.jobFencingToken
        || current.claimUntilMs === null
        || current.claimUntilMs < input.now
        || current.status !== "RUNNING") {
        return { status: "ownership-lost" } as const;
      }

      const inserted = tx.insert(generationAttempts).values(input.attempt)
        .onConflictDoNothing().returning({ id: generationAttempts.id }).all();
      if (inserted.length !== 1) rollbackLostRace();

      const attached = tx.update(generationJobs).set({
        currentAttemptId: input.attempt.id,
        updatedAtMs: input.now,
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

/** Update a worker-owned attempt only while it remains the live job attempt. */
export function updateOwnedAttempt(
  identity: OwnedAttemptIdentity,
  input: {
    now: number;
    expectedPhases?: readonly AttemptPhase[];
    values: OwnedAttemptValues;
    event?: {
      eventType: string;
      severity: typeof generationEvents.$inferInsert.severity;
      safePayloadJson: Record<string, unknown>;
    };
  },
  database: DB = db,
): TransitionResult {
  return database.transaction((tx) => {
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
      || current.claimUntilMs < input.now
      || !(["RUNNING", "CANCEL_REQUESTED"] as JobStatus[]).includes(current.jobStatus)) {
      return { status: "ownership-lost" } as const;
    }
    if (input.expectedPhases && !input.expectedPhases.includes(current.attemptPhase)) {
      return { status: "invalid-transition" } as const;
    }

    const changed = tx.update(generationAttempts).set({
      ...input.values,
      updatedAtMs: input.now,
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
        createdAtMs: input.now,
      }).run();
    }
    return { status: "applied" } as const;
  }, { behavior: "immediate" });
}

/** Finalize a worker-owned attempt, its job, and the matching event atomically. */
export function finalizeOwnedExecution(
  identity: OwnedAttemptIdentity,
  input: {
    now: number;
    expectedJobStatuses: readonly ("RUNNING" | "CANCEL_REQUESTED")[];
    expectedAttemptPhases: readonly AttemptPhase[];
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
        || current.claimUntilMs < input.now
        || (current.jobStatus !== "RUNNING" && current.jobStatus !== "CANCEL_REQUESTED")) {
        return { status: "ownership-lost" } as const;
      }
      if (!input.expectedJobStatuses.includes(current.jobStatus)
        || !input.expectedAttemptPhases.includes(current.attemptPhase)) {
        return { status: "invalid-transition" } as const;
      }

      const attemptChanged = tx.update(generationAttempts).set({
        ...input.attemptValues,
        updatedAtMs: input.now,
      }).where(and(
        eq(generationAttempts.id, identity.attemptId),
        eq(generationAttempts.jobClaimFencingToken, identity.jobFencingToken),
        eq(generationAttempts.phase, current.attemptPhase),
      )).returning({ id: generationAttempts.id }).all();
      if (!attemptChanged[0]) rollbackLostRace();

      const jobChanged = tx.update(generationJobs).set({
        ...input.jobValues,
        updatedAtMs: input.now,
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
        createdAtMs: input.now,
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
    now: number;
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
    const current = tx.select().from(generationJobs)
      .where(eq(generationJobs.id, identity.jobId)).get();
    if (!current
      || current.currentAttemptId !== null
      || current.claimOwner !== identity.workerId
      || current.claimFencingToken !== identity.jobFencingToken
      || current.claimUntilMs === null
      || current.claimUntilMs < input.now
      || (current.status !== "RUNNING" && current.status !== "CANCEL_REQUESTED")) {
      return { status: "ownership-lost" } as const;
    }
    if (!input.expectedJobStatuses.includes(current.status)) {
      return { status: "invalid-transition" } as const;
    }
    const changed = tx.update(generationJobs).set({
      ...input.jobValues,
      updatedAtMs: input.now,
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
      createdAtMs: input.now,
    }).run();
    return { status: "applied" } as const;
  }, { behavior: "immediate" });
}
