/** Durable ComfyUI execution worker with fenced writes and immutable workflows. */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  executionBackends,
  generationAttempts,
  generationEvents,
  generationJobs,
  workflowBackendValidations,
} from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { isEnabled, FF } from "@/lib/feature-flags";
import {
  ComfyUIExecutionOrchestrator,
  ExecutionCallbackPersistenceError,
  acquireResourceSlot,
  createComfyUITransport,
  probeBackendFeatures,
  probeModelFolder,
  releaseResourceSlot,
  renewResourceSlot,
  streamCommitArtifact,
  materializeWorkflowInputs,
} from "@/lib/generation";
import type { BackendFeatureSnapshot, ComfyUITransport, ExecutionCallbacks, OrchestratorPhase } from "@/lib/generation";
import { bindWorkflow, loadActiveWorkflowPackage } from "@/lib/generation/workflows";
import { resolveBackendAuthHeaders } from "@/lib/security";
import { linkArtifactToBusinessEntity, mergeGenerationJobMetadata } from "@/lib/generation/business-adapter";
import { selectPrimaryArtifact, type CollectedArtifactCandidate } from "@/lib/generation/artifact-selection";
import {
  attachOwnedAttempt,
  finalizeOwnedExecution,
  finalizeOwnedJob,
  type AttemptPhase,
  type OwnedAttemptPatch,
} from "@/lib/generation/jobs/state-transitions";
import {
  applyOwnedAttemptTransition,
  CONFIRMED_CANCELLATION_PREDECESSORS,
  transitionForOrchestratorPhase,
  type OwnedAttemptTransition,
} from "@/lib/generation/jobs/attempt-transitions";
import {
  finalizeGenerationFailure,
  finalizeGenerationSuccess,
  ownershipLostResult,
  OwnedTransitionError,
  requireApplied,
  type JobExecutionResult,
} from "@/lib/generation/jobs/worker-finalization";
export type { JobExecutionResult } from "@/lib/generation/jobs/worker-finalization";

function mimeForOutput(
  filename: string,
  expectedKind: "image" | "video" | "audio",
): { mimeType: string; kind: "image" | "video" | "audio" } {
  const lower = filename.toLowerCase();
  const detected = lower.endsWith(".png") ? { mimeType: "image/png", kind: "image" as const }
    : lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? { mimeType: "image/jpeg", kind: "image" as const }
    : lower.endsWith(".webp") ? { mimeType: "image/webp", kind: "image" as const }
    : lower.endsWith(".gif") ? { mimeType: "image/gif", kind: "image" as const }
    : lower.endsWith(".wav") ? { mimeType: "audio/wav", kind: "audio" as const }
    : lower.endsWith(".mp3") ? { mimeType: "audio/mpeg", kind: "audio" as const }
    : lower.endsWith(".mp4") ? { mimeType: "video/mp4", kind: "video" as const }
    : null;
  if (!detected) throw new Error(`Unsupported output filename: ${filename}`);
  if (detected.kind !== expectedKind) {
    throw new Error(`Output media contract mismatch: expected ${expectedKind}, received ${detected.kind}`);
  }
  return detected;
}

function applyAttemptTransition(
  jobId: string,
  attemptId: string,
  workerId: string,
  jobFencingToken: number,
  transition: OwnedAttemptTransition,
  values: OwnedAttemptPatch = {},
  event?: {
    eventType: string;
    severity: typeof generationEvents.$inferInsert.severity;
    safePayloadJson: Record<string, unknown>;
  },
): ReturnType<typeof applyOwnedAttemptTransition> {
  return applyOwnedAttemptTransition(
    { jobId, attemptId, workerId, jobFencingToken },
    transition,
    { values, event },
  );
}

export async function executeGenerationJob(
  job: typeof generationJobs.$inferSelect,
  workerId: string,
  jobFencingToken: number,
  abortSignal?: AbortSignal,
): Promise<JobExecutionResult> {
  if (job.cancelRequestedAtMs) {
    await cancelQueuedJob(job.id, workerId, jobFencingToken);
    return { success: false, finalPhase: "CANCELLED", needsAttention: false, claimDisposition: "release-terminal" };
  }
  if (!isEnabled(FF.V2_COMFYUI_TRANSPORT)) {
    return failJob(job.id, "", workerId, jobFencingToken, "ComfyUI transport is not enabled", "config_error");
  }

  const attemptId = genId();
  let resourceSlot: { slotNo: number; leaseToken: string; fencingToken: number } | null = null;
  let resourceTimer: ReturnType<typeof setInterval> | null = null;
  let retainResource = false;
  let orchestrator: ComfyUIExecutionOrchestrator | null = null;
  let transport: ComfyUITransport | null = null;
  let resourceRenewalInFlight = false;
  let inputCleanup: (() => Promise<void>) | null = null;
  const committedArtifacts: CollectedArtifactCandidate[] = [];
  let outputSequence = 0;

  try {
    if (abortSignal?.aborted) throw new Error("execution_aborted_before_start");
    const snapshot = job.executionSnapshotJson as Record<string, unknown>;
    const backendId = typeof snapshot.executionBackendId === "string" ? snapshot.executionBackendId : "";
    const workflowDigest = typeof snapshot.workflowPackageDigest === "string" ? snapshot.workflowPackageDigest : "";
    const request = snapshot.request && typeof snapshot.request === "object" ? snapshot.request as Record<string, unknown> : {};
    const config = snapshot.configJson && typeof snapshot.configJson === "object" ? snapshot.configJson as Record<string, unknown> : {};
    if (!backendId || !workflowDigest) return failJob(job.id, "", workerId, jobFencingToken, "Backend and active workflow package are required", "config_error");

    const [backend] = await db.select().from(executionBackends).where(eq(executionBackends.id, backendId));
    if (!backend || !backend.enabled) return failJob(job.id, "", workerId, jobFencingToken, "Execution backend is missing or disabled", "config_error");
    const workflowPackage = await loadActiveWorkflowPackage(workflowDigest);
    if (workflowPackage.manifest.capability !== job.capability) return failJob(job.id, "", workerId, jobFencingToken, "Workflow capability does not match job", "config_error");
    const [backendValidation] = await db.select().from(workflowBackendValidations).where(and(
      eq(workflowBackendValidations.workflowPackageDigest, workflowDigest),
      eq(workflowBackendValidations.executionBackendId, backendId),
    ));
    if (!backendValidation
      || backendValidation.environmentFingerprint !== backend.environmentFingerprint
      || backendValidation.environmentLockDigest !== workflowPackage.revision.environmentLockDigest) {
      return failJob(
        job.id, "", workerId, jobFencingToken,
        "Workflow package is not validated for the exact backend environment",
        "workflow_backend_validation_missing", true,
      );
    }

    const authHeaders = await resolveBackendAuthHeaders(backend.authType, backend.authConfigJson);
    transport = await createComfyUITransport(
      backend.baseUrl, backend.topology, authHeaders,
      Array.isArray((backend.networkPolicyJson as { resolvedAddresses?: unknown }).resolvedAddresses)
        ? ((backend.networkPolicyJson as { resolvedAddresses: unknown[] }).resolvedAddresses.filter((value): value is string => typeof value === "string"))
        : [],
    );
    const activeTransport = transport;
    const features: BackendFeatureSnapshot = await probeBackendFeatures(activeTransport);
    if (backend.environmentFingerprint && backend.environmentFingerprint !== features.environmentFingerprint) {
      return failJob(job.id, "", workerId, jobFencingToken, "Backend environment fingerprint drifted after workflow activation", "environment_drift", true);
    }
    const modelFolders = new Map<string, string[]>();
    for (const model of workflowPackage.manifest.requirements.models) {
      if (!modelFolders.has(model.folder)) {
        modelFolders.set(model.folder, await probeModelFolder(activeTransport, model.folder));
      }
      if (!modelFolders.get(model.folder)?.includes(model.filename.replace(/\\/g, "/"))) {
        return failJob(
          job.id, "", workerId, jobFencingToken,
          `Required workflow model is no longer available: ${model.folder}/${model.filename}`,
          "environment_model_drift", true,
        );
      }
    }

    const attemptNo = await getNextAttemptNo(job.id);
    const correlationId = `corr-${attemptId}`;
    const outputPrefix = `ai-m/${job.id}/${attemptNo}`;
    const attemptCreatedAtMs = Date.now();
    const attached = attachOwnedAttempt({
      jobId: job.id,
      workerId,
      jobFencingToken,
    }, {
      attempt: {
        id: attemptId,
        jobId: job.id,
        attemptNo,
        jobClaimFencingToken: jobFencingToken,
        phase: "PREPARING",
        backendId: backend.id,
        backendFeatureSnapshotJson: features as unknown as Record<string, unknown>,
        environmentFingerprint: features.environmentFingerprint,
        submissionCorrelationId: correlationId,
        externalIdStrategy: features.externalIdStrategy,
        systemOutputPrefix: outputPrefix,
        resourcePoolId: backend.resourcePoolId,
        resourceSlotNo: 0,
        resourceLeaseToken: `pending-${attemptId}`,
        resourceFencingToken: 0,
        createdAtMs: attemptCreatedAtMs,
        updatedAtMs: attemptCreatedAtMs,
      },
    });
    requireApplied(attached, "job_claim_lost_before_attempt_attachment");

    resourceSlot = await acquireResourceSlot(backend.resourcePoolId, attemptId, workerId);
    if (!resourceSlot) return failJob(job.id, attemptId, workerId, jobFencingToken, "No resource slot available", "resource_exhausted");
    requireApplied(applyAttemptTransition(job.id, attemptId, workerId, jobFencingToken, "begin-submission", {
      resourceSlotNo: resourceSlot.slotNo,
      resourceLeaseToken: resourceSlot.leaseToken,
      resourceFencingToken: resourceSlot.fencingToken,
    }), "job_claim_lost_before_submission_boundary");

    resourceTimer = setInterval(async () => {
      if (!resourceSlot || resourceRenewalInFlight) return;
      resourceRenewalInFlight = true;
      try {
        const renewed = await renewResourceSlot(
          backend.resourcePoolId, resourceSlot.slotNo, resourceSlot.leaseToken, resourceSlot.fencingToken,
        ).catch(() => false);
        if (!renewed) {
          retainResource = true;
          orchestrator?.stop();
        }
      } finally {
        resourceRenewalInFlight = false;
      }
    }, 30_000);

    const defaults = config.defaultParameters && typeof config.defaultParameters === "object"
      ? config.defaultParameters as Record<string, unknown>
      : {};
    const materialized = await materializeWorkflowInputs({
      job,
      attemptId,
      compiled: workflowPackage.compiled,
      transport: activeTransport,
      request: { ...defaults, ...request },
      metadata: job.metadataJson as Record<string, unknown>,
      maxReferenceInputs: workflowPackage.manifest.limits.maxBatch,
    });
    inputCleanup = materialized.cleanup;
    const workflow = bindWorkflow(
      workflowPackage.workflow,
      workflowPackage.compiled,
      materialized.parameters,
      outputPrefix,
    );

    const durableCallbacks: ExecutionCallbacks = {
      onPhaseChange: async (phase: OrchestratorPhase) => {
        const mapped = phase === "CREATED" ? "PREPARING" : phase;
        if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(mapped)) return;
        const transition = transitionForOrchestratorPhase(mapped as AttemptPhase);
        if (!transition) throw new Error(`unsupported_orchestrator_phase:${mapped}`);
        requireApplied(applyAttemptTransition(job.id, attemptId, workerId, jobFencingToken, transition),
          "job_claim_lost_during_phase_change");
      },
      onExternalJobId: async (externalJobId) => {
        retainResource = true;
        requireApplied(applyAttemptTransition(job.id, attemptId, workerId, jobFencingToken, "record-external-queued", {
          externalJobId,
          submittedAtMs: Date.now(),
        }), "job_claim_lost_recording_external_id");
      },
      onProgress: async (progress) => {
        requireApplied(applyAttemptTransition(job.id, attemptId, workerId, jobFencingToken, "record-progress", {
          progressSnapshotJson: progress as unknown as Record<string, unknown>,
        }), "job_claim_lost_recording_progress");
      },
      onReconciliation: async (result) => {
        if (result.discoveredExternalJobId) retainResource = true;
        requireApplied(applyAttemptTransition(
          job.id, attemptId, workerId, jobFencingToken,
          result.exists ? "record-external-queued" : "mark-submission-unknown", {
          externalJobId: result.discoveredExternalJobId ?? undefined,
        }), "job_claim_lost_during_reconciliation");
      },
      isCancellationRequested: async () => {
        const now = Date.now();
        const [current] = await db
          .select({ cancelRequestedAtMs: generationJobs.cancelRequestedAtMs })
          .from(generationJobs)
          .where(and(
            eq(generationJobs.id, job.id),
            eq(generationJobs.currentAttemptId, attemptId),
            eq(generationJobs.claimOwner, workerId),
            eq(generationJobs.claimFencingToken, jobFencingToken),
            sql`${generationJobs.claimUntilMs} >= ${now}`,
          ));
        if (!current) throw new Error("job_claim_lost_during_cancellation_probe");
        return Boolean(current.cancelRequestedAtMs);
      },
      onCancellationResult: async (result) => {
        requireApplied(applyAttemptTransition(job.id, attemptId, workerId, jobFencingToken, "record-cancellation-intent", {}, {
          eventType: "external_cancellation_requested",
          severity: result.needsReconciliation ? "warning" : "info",
          safePayloadJson: {
            requested: result.requested,
            method: result.method,
            needsReconciliation: result.needsReconciliation,
            safeMessage: result.safeMessage.slice(0, 200),
          },
        }), "job_claim_lost_recording_cancellation_request");
      },
      onOutputStream: async (output) => {
        requireApplied(applyAttemptTransition(
          job.id, attemptId, workerId, jobFencingToken, "commit-collected-output",
        ), "job_claim_lost_before_artifact_commit");
        const sequence = outputSequence++;
        const media = mimeForOutput(output.filename, output.mediaKind);
        const contentLength = Number(output.response.headers.get("content-length") ?? 0);
        if (contentLength > workflowPackage.manifest.limits.maxOutputBytes) throw new Error("Output exceeds workflow package limit");
        if (!output.response.body) throw new Error("Output response has no body");
        const committed = await streamCommitArtifact({
          attemptId,
          expectedJobClaimFencingToken: jobFencingToken,
          logicalName: `${output.nodeId}_${output.filename}`,
          kind: media.kind,
          mimeType: media.mimeType,
          visibility: "project",
          maxSizeBytes: workflowPackage.manifest.limits.maxOutputBytes,
          metadata: {
            nodeId: output.nodeId, outputKey: output.outputKey, outputField: output.field,
            mediaKind: output.mediaKind, originalFilename: output.filename,
          },
          read: () => output.response.body!,
        });
        committedArtifacts.push({
          artifactId: committed.id,
          nodeId: output.nodeId,
          outputKey: output.outputKey,
          field: output.field,
          sequence,
        });
      },
    };
    const callbacks = new Proxy(durableCallbacks, {
      get(target, property, receiver) {
        const callback = Reflect.get(target, property, receiver);
        if (typeof callback !== "function") return callback;
        return (...args: unknown[]) => Promise.resolve(Reflect.apply(callback, target, args))
          .catch((error: unknown) => { throw new ExecutionCallbackPersistenceError(error); });
      },
    });

    orchestrator = new ComfyUIExecutionOrchestrator(activeTransport, features, backend.baseUrl, callbacks, {
      totalExecutionTimeoutMs: workflowPackage.manifest.limits.maxJobMs,
      collectionTimeoutMs: Math.min(workflowPackage.manifest.limits.maxJobMs, 5 * 60 * 1000),
      isSharedBackend: backend.sharingMode === "shared",
      maxOutputs: workflowPackage.manifest.limits.maxOutputs,
      approvedOutputs: workflowPackage.compiled.outputs.map((output) => ({
        key: output.key, nodeId: output.nodeId, field: output.field,
        mediaKind: output.mediaKind, maxItems: output.maxItems,
      })),
    }, correlationId);
    const abortListener = () => orchestrator?.stop();
    abortSignal?.addEventListener("abort", abortListener, { once: true });
    try {
      const result = await orchestrator.execute(workflow);
      if (abortSignal?.aborted) {
        retainResource = true;
        return failJob(
          job.id, attemptId, workerId, jobFencingToken,
          "Execution ownership was lost", "ownership_lost", true,
        );
      }
      if (result.success) {
        retainResource = false;
        const primaryArtifact = selectPrimaryArtifact(committedArtifacts, workflowPackage.compiled.outputs);
        const artifactId = await finalizeGenerationSuccess({
          jobId: job.id,
          attemptId,
          workerId,
          fencingToken: jobFencingToken,
          artifactId: primaryArtifact.artifactId,
        });
        try {
          await linkArtifactToBusinessEntity(job.id, artifactId);
          await mergeGenerationJobMetadata(job.id, {
            businessProjectionStatus: "succeeded",
            businessProjectedAtMs: Date.now(),
            businessProjectionError: null,
          });
        } catch (projectionError) {
          await db.insert(generationEvents).values({
            id: genId(), jobId: job.id, attemptId, eventType: "business_projection_pending", severity: "warning",
            safePayloadJson: { message: projectionError instanceof Error ? projectionError.message.slice(0, 200) : "projection_failed" },
            createdAtMs: Date.now(),
          }).catch(() => undefined);
        }
        return { success: true, finalPhase: "SUCCEEDED", needsAttention: false, claimDisposition: "release-terminal" };
      }
      if (result.cancellationRequested && result.phase === "CANCELLED") {
        retainResource = false;
        await cancelJob(job.id, attemptId, workerId, jobFencingToken);
        return { success: false, finalPhase: "CANCELLED", needsAttention: false, claimDisposition: "release-terminal" };
      }
      retainResource = retainResource || result.needsAttention || result.phase === "SUBMISSION_UNKNOWN";
      return failJob(job.id, attemptId, workerId, jobFencingToken, result.errorMessage ?? `Execution ended in ${result.phase}`, result.errorClass ?? "execution_error", retainResource);
    } finally {
      abortSignal?.removeEventListener("abort", abortListener);
    }
  } catch (error) {
    if (error instanceof OwnedTransitionError
      && (error.transitionStatus === "lost-race" || error.transitionStatus === "ownership-lost")) {
      retainResource = true;
      return ownershipLostResult();
    }
    retainResource = true;
    throw error;
  } finally {
    if (resourceTimer) clearInterval(resourceTimer);
    transport?.close();
    if (!retainResource && inputCleanup) await inputCleanup().catch(() => undefined);
    if (resourceSlot && !retainResource) {
      const snapshot = job.executionSnapshotJson as Record<string, unknown>;
      const backendId = snapshot.executionBackendId as string;
      const [backend] = backendId ? await db.select().from(executionBackends).where(eq(executionBackends.id, backendId)) : [];
      if (backend) await releaseResourceSlot(backend.resourcePoolId, resourceSlot.slotNo, resourceSlot.leaseToken, resourceSlot.fencingToken).catch(() => false);
    }
  }
}


async function cancelQueuedJob(jobId: string, workerId: string, fencingToken: number): Promise<void> {
  const now = Date.now();
  const result = finalizeOwnedJob({ jobId, workerId, jobFencingToken: fencingToken }, {
    expectedJobStatuses: ["RUNNING", "CANCEL_REQUESTED"],
    jobValues: { status: "CANCELLED", completedAtMs: now },
    event: {
      eventType: "job_cancelled_before_submission",
      severity: "info",
      safePayloadJson: {},
    },
  });
  requireApplied(result, "job_claim_lost_cancelling_before_submission");
}

async function getNextAttemptNo(jobId: string): Promise<number> {
  const rows = await db.select({ attemptNo: generationAttempts.attemptNo }).from(generationAttempts)
    .where(eq(generationAttempts.jobId, jobId)).orderBy(desc(generationAttempts.attemptNo)).limit(1);
  return (rows[0]?.attemptNo ?? 0) + 1;
}

async function failJob(
  jobId: string,
  attemptId: string,
  workerId: string,
  fencingToken: number,
  errorMessage: string,
  errorClass: string,
  needsAttention = false,
): Promise<JobExecutionResult> {
  return finalizeGenerationFailure({
    jobId,
    attemptId,
    workerId,
    fencingToken,
    errorMessage,
    errorClass,
    needsAttention,
  });
}

async function cancelJob(jobId: string, attemptId: string, workerId: string, fencingToken: number): Promise<void> {
  const now = Date.now();
  const result = finalizeOwnedExecution({ jobId, attemptId, workerId, jobFencingToken: fencingToken }, {
    expectedJobStatuses: ["RUNNING", "CANCEL_REQUESTED"],
    expectedAttemptPhases: CONFIRMED_CANCELLATION_PREDECESSORS,
    attemptValues: { phase: "CANCELLED", finishedAtMs: now },
    jobValues: { status: "CANCELLED", completedAtMs: now },
    event: { eventType: "job_cancelled", severity: "info", safePayloadJson: {} },
  });
  requireApplied(result, "job_claim_lost_finalizing_cancellation");
}
