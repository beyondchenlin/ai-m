import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { generationAttempts, generationJobs } from "@/lib/db/schema";
import {
  recoverExpiredJob,
  type ExpiredJobSnapshot,
  type RecoveryTransitionResult,
} from "./state-transitions";

export interface RecoveryScanOutcome {
  jobId: string;
  status: RecoveryTransitionResult["status"];
  disposition?: "requeued" | "cancelled" | "needs-attention";
}

export interface JobRecoveryResult {
  requeuedJobs: string[];
  attentionJobs: string[];
  cancelledJobs: string[];
  outcomes: RecoveryScanOutcome[];
}

/** Read immutable joined candidates. No transition decision is made here. */
export async function readExpiredJobCandidates(
  observedAtMs: number,
  database: DB = db,
): Promise<ExpiredJobSnapshot[]> {
  const expired = await database.select({ job: generationJobs, attempt: generationAttempts })
    .from(generationJobs)
    .leftJoin(generationAttempts, eq(generationAttempts.id, generationJobs.currentAttemptId))
    .where(and(
      inArray(generationJobs.status, ["RUNNING", "CANCEL_REQUESTED"]),
      or(
        sql`${generationJobs.claimOwner} IS NULL`,
        sql`${generationJobs.claimUntilMs} IS NULL`,
        sql`${generationJobs.claimUntilMs} < ${observedAtMs}`,
      ),
    ));

  return expired.flatMap<ExpiredJobSnapshot>(({ job, attempt }) => {
    if (job.status !== "RUNNING" && job.status !== "CANCEL_REQUESTED") return [];
    const base = {
      jobId: job.id,
      jobStatus: job.status,
      claimFencingToken: job.claimFencingToken,
      currentAttemptId: job.currentAttemptId,
      attempt: attempt ? {
        id: attempt.id,
        phase: attempt.phase,
        jobClaimFencingToken: attempt.jobClaimFencingToken,
        externalJobId: attempt.externalJobId,
      } : null,
    };
    if (job.claimOwner === null) return [{
      ...base,
      claimKind: "malformed-ownerless",
      claimOwner: null,
      claimUntilMs: job.claimUntilMs,
    } satisfies ExpiredJobSnapshot];
    if (job.claimUntilMs === null) return [{
      ...base,
      claimKind: "malformed-missing-expiry",
      claimOwner: job.claimOwner,
      claimUntilMs: null,
    } satisfies ExpiredJobSnapshot];
    if (job.claimUntilMs >= observedAtMs) return [];
    return [{
      ...base,
      claimKind: "expired",
      claimOwner: job.claimOwner,
      claimUntilMs: job.claimUntilMs,
    } satisfies ExpiredJobSnapshot];
  });
}

/** Apply the production fenced recovery transition to previously read candidates. */
export async function applyExpiredJobCandidates(
  candidates: readonly ExpiredJobSnapshot[],
  database: DB = db,
  clock: () => number = Date.now,
): Promise<JobRecoveryResult> {
  const requeuedJobs: string[] = [];
  const attentionJobs: string[] = [];
  const cancelledJobs: string[] = [];
  const outcomes: RecoveryScanOutcome[] = [];

  for (const snapshot of candidates) {
    const result = recoverExpiredJob(snapshot, database, clock);
    outcomes.push(result.status === "applied"
      ? { jobId: snapshot.jobId, status: result.status, disposition: result.disposition }
      : { jobId: snapshot.jobId, status: result.status });
    if (result.status !== "applied") continue;
    if (result.disposition === "requeued") requeuedJobs.push(snapshot.jobId);
    else if (result.disposition === "cancelled") cancelledJobs.push(snapshot.jobId);
    else attentionJobs.push(snapshot.jobId);
  }

  return { requeuedJobs, attentionJobs, cancelledJobs, outcomes };
}
