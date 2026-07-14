import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { generationAttempts, generationJobs } from "@/lib/db/schema";
import {
  recoverExpiredJob,
  type ExpiredJobSnapshot,
  type TransitionResult,
} from "./state-transitions";

export interface RecoveryScanOutcome {
  jobId: string;
  status: TransitionResult["status"];
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
      sql`${generationJobs.claimUntilMs} < ${observedAtMs}`,
    ));

  return expired.flatMap(({ job, attempt }) => {
    if ((job.status !== "RUNNING" && job.status !== "CANCEL_REQUESTED")
      || job.claimOwner === null || job.claimUntilMs === null) return [];
    return [{
      jobId: job.id,
      jobStatus: job.status,
      claimOwner: job.claimOwner,
      claimUntilMs: job.claimUntilMs,
      claimFencingToken: job.claimFencingToken,
      currentAttemptId: job.currentAttemptId,
      attempt: attempt ? {
        id: attempt.id,
        phase: attempt.phase,
        jobClaimFencingToken: attempt.jobClaimFencingToken,
        externalJobId: attempt.externalJobId,
      } : null,
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
