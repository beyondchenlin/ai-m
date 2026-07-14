import { db, type DB } from "@/lib/db";
import { generationEvents } from "@/lib/db/schema";
import {
  updateOwnedAttempt,
  type AttemptPhase,
  type OwnedAttemptIdentity,
  type OwnedAttemptPatch,
  type TransitionResult,
} from "./state-transitions";

export type OwnedAttemptTransition =
  | "begin-submission"
  | "mark-submission-unknown"
  | "record-external-queued"
  | "record-external-running"
  | "collect-completed-output"
  | "commit-collected-output"
  | "record-progress"
  | "record-cancellation-intent"
  | "record-cancellation-confirmation"
  | "wait-before-retry";

interface AttemptTransitionPolicy {
  expectedPhases: readonly AttemptPhase[];
  nextPhase?: AttemptPhase;
}

export const OWNED_ATTEMPT_TRANSITION_POLICY: Record<OwnedAttemptTransition, AttemptTransitionPolicy> = {
  "begin-submission": { expectedPhases: ["PREPARING", "SUBMITTING"], nextPhase: "SUBMITTING" },
  "mark-submission-unknown": {
    expectedPhases: ["SUBMITTING", "SUBMISSION_UNKNOWN"],
    nextPhase: "SUBMISSION_UNKNOWN",
  },
  "record-external-queued": {
    expectedPhases: ["SUBMITTING", "SUBMISSION_UNKNOWN", "EXTERNAL_QUEUED"],
    nextPhase: "EXTERNAL_QUEUED",
  },
  "record-external-running": {
    expectedPhases: ["EXTERNAL_QUEUED", "EXTERNAL_RUNNING"],
    nextPhase: "EXTERNAL_RUNNING",
  },
  "collect-completed-output": {
    expectedPhases: ["EXTERNAL_RUNNING", "COLLECTING"],
    nextPhase: "COLLECTING",
  },
  "commit-collected-output": {
    expectedPhases: ["COLLECTING", "COMMITTING"],
    nextPhase: "COMMITTING",
  },
  "record-progress": { expectedPhases: ["EXTERNAL_QUEUED", "EXTERNAL_RUNNING"] },
  // Cancellation is intent, not external execution state. Preserve the physical
  // phase until external evidence proves either completion or cancellation.
  "record-cancellation-intent": {
    expectedPhases: ["SUBMISSION_UNKNOWN", "EXTERNAL_QUEUED", "EXTERNAL_RUNNING"],
  },
  "record-cancellation-confirmation": {
    expectedPhases: ["EXTERNAL_QUEUED", "EXTERNAL_RUNNING"],
  },
  "wait-before-retry": {
    expectedPhases: ["SUBMITTING", "SUBMISSION_UNKNOWN", "RETRY_WAIT"],
    nextPhase: "RETRY_WAIT",
  },
};

export const CONFIRMED_CANCELLATION_PREDECESSORS = [
  "EXTERNAL_QUEUED",
  "EXTERNAL_RUNNING",
] as const satisfies readonly AttemptPhase[];

export function transitionForOrchestratorPhase(
  phase: AttemptPhase,
): OwnedAttemptTransition | null {
  switch (phase) {
    case "SUBMITTING": return "begin-submission";
    case "SUBMISSION_UNKNOWN": return "mark-submission-unknown";
    case "EXTERNAL_QUEUED": return "record-external-queued";
    case "EXTERNAL_RUNNING": return "record-external-running";
    case "COLLECTING": return "collect-completed-output";
    case "COMMITTING": return "commit-collected-output";
    default: return null;
  }
}

export function applyOwnedAttemptTransition(
  identity: OwnedAttemptIdentity,
  transition: OwnedAttemptTransition,
  input: {
    values?: OwnedAttemptPatch;
    event?: {
      eventType: string;
      severity: typeof generationEvents.$inferInsert.severity;
      safePayloadJson: Record<string, unknown>;
    };
    clock?: () => number;
  } = {},
  database: DB = db,
): TransitionResult {
  const policy = OWNED_ATTEMPT_TRANSITION_POLICY[transition];
  return updateOwnedAttempt(identity, {
    clock: input.clock,
    expectedPhases: policy.expectedPhases,
    nextPhase: policy.nextPhase,
    values: input.values ?? {},
    event: input.event,
  }, database);
}
