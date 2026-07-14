import { and, eq } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { generationArtifacts } from "@/lib/db/schema";
import {
  finalizeOwnedExecution,
  finalizeOwnedJob,
  type TransitionResult,
} from "./state-transitions";

const OWNED_ACTIVE_ATTEMPT_PHASES = [
  "CREATED", "LEASED", "PREPARING", "SUBMITTING", "SUBMISSION_UNKNOWN",
  "EXTERNAL_QUEUED", "EXTERNAL_RUNNING", "COLLECTING", "COMMITTING",
  "RETRY_WAIT", "CANCEL_REQUESTED",
] as const;

export type ClaimDisposition = "release-terminal" | "retain-recovery";

export interface JobExecutionResult {
  success: boolean;
  finalPhase: string;
  errorMessage?: string;
  errorClass?: string;
  needsAttention: boolean;
  claimDisposition: ClaimDisposition;
}

export class OwnedTransitionError extends Error {
  constructor(
    readonly operation: string,
    readonly transitionStatus: "lost-race" | "ownership-lost" | "invalid-transition",
  ) {
    super(`${operation}:${transitionStatus}`);
  }
}

export function requireApplied(result: TransitionResult, operation: string): void {
  if (result.status !== "applied") throw new OwnedTransitionError(operation, result.status);
}

export function ownershipLostResult(): JobExecutionResult {
  return {
    success: false,
    finalPhase: "OWNERSHIP_LOST",
    errorMessage: "Execution ownership was lost before the terminal transition",
    errorClass: "ownership_lost",
    needsAttention: true,
    claimDisposition: "retain-recovery",
  };
}

function mapTerminalTransition(
  transition: TransitionResult,
  terminal: Omit<JobExecutionResult, "claimDisposition">,
): JobExecutionResult {
  if (transition.status === "applied") {
    return { ...terminal, claimDisposition: "release-terminal" };
  }
  if (transition.status === "lost-race" || transition.status === "ownership-lost") {
    return ownershipLostResult();
  }
  throw new OwnedTransitionError("finalize_generation_failure", transition.status);
}

export function finalizeGenerationFailure(
  input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    fencingToken: number;
    errorMessage: string;
    errorClass: string;
    needsAttention?: boolean;
    now?: number;
  },
  database: DB = db,
): JobExecutionResult {
  const now = input.now ?? Date.now();
  const needsAttention = input.needsAttention ?? false;
  const event = {
    eventType: needsAttention ? "job_needs_attention" : "job_failed",
    severity: needsAttention ? "warning" as const : "error" as const,
    safePayloadJson: {
      errorClass: input.errorClass,
      errorMessage: input.errorMessage.slice(0, 200),
    },
  };
  const transition = input.attemptId
    ? finalizeOwnedExecution({
      jobId: input.jobId,
      attemptId: input.attemptId,
      workerId: input.workerId,
      jobFencingToken: input.fencingToken,
    }, {
      clock: input.now === undefined ? undefined : () => input.now!,
      expectedJobStatuses: ["RUNNING", "CANCEL_REQUESTED"],
      expectedAttemptPhases: OWNED_ACTIVE_ATTEMPT_PHASES,
      attemptValues: {
        phase: needsAttention ? "ORPHANED" : "FAILED",
        errorClass: input.errorClass,
        errorMessageSafe: input.errorMessage.slice(0, 500),
        finishedAtMs: needsAttention ? null : now,
      },
      jobValues: {
        status: needsAttention ? "NEEDS_ATTENTION" : "FAILED",
        needsAttentionReason: needsAttention
          ? `${input.errorClass}:${input.errorMessage.slice(0, 200)}`
          : null,
        completedAtMs: needsAttention ? null : now,
      },
      event,
    }, database)
    : finalizeOwnedJob({
      jobId: input.jobId,
      workerId: input.workerId,
      jobFencingToken: input.fencingToken,
    }, {
      clock: input.now === undefined ? undefined : () => input.now!,
      expectedJobStatuses: ["RUNNING", "CANCEL_REQUESTED"],
      jobValues: {
        status: needsAttention ? "NEEDS_ATTENTION" : "FAILED",
        needsAttentionReason: needsAttention
          ? `${input.errorClass}:${input.errorMessage.slice(0, 200)}`
          : null,
        completedAtMs: needsAttention ? null : now,
      },
      event,
    }, database);

  return mapTerminalTransition(transition, {
    success: false,
    finalPhase: needsAttention ? "NEEDS_ATTENTION" : "FAILED",
    errorMessage: input.errorMessage,
    errorClass: input.errorClass,
    needsAttention,
  });
}

export async function finalizeGenerationSuccess(
  input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    fencingToken: number;
    artifactId: string;
    now?: number;
  },
  database: DB = db,
): Promise<string> {
  const now = input.now ?? Date.now();
  const [artifact] = await database.select({ id: generationArtifacts.id }).from(generationArtifacts)
    .where(and(
      eq(generationArtifacts.id, input.artifactId),
      eq(generationArtifacts.attemptId, input.attemptId),
      eq(generationArtifacts.status, "COMMITTED"),
    ));
  if (!artifact) throw new Error("Selected primary artifact is not committed for this execution attempt");
  const result = finalizeOwnedExecution({
    jobId: input.jobId,
    attemptId: input.attemptId,
    workerId: input.workerId,
    jobFencingToken: input.fencingToken,
  }, {
    clock: input.now === undefined ? undefined : () => input.now!,
    expectedJobStatuses: ["RUNNING", "CANCEL_REQUESTED"],
    expectedAttemptPhases: OWNED_ACTIVE_ATTEMPT_PHASES,
    attemptValues: { phase: "SUCCEEDED", finishedAtMs: now },
    jobValues: { status: "SUCCEEDED", currentArtifactId: artifact.id, completedAtMs: now },
    event: { eventType: "job_succeeded", severity: "info", safePayloadJson: {} },
  }, database);
  requireApplied(result, "job_claim_lost_finalizing_success");
  return artifact.id;
}
