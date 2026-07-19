/** Durable ComfyUI execution worker with fenced writes and immutable workflows. */
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  executionBackends,
  generationAttempts,
  generationEvents,
  generationJobs,
  resourcePools,
  resourcePoolSlots,
  workflowBackendValidations,
  workflowPackageRevisions,
  workflowPackageStates,
} from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { isEnabled, FF } from "@/lib/feature-flags";
import {
  ComfyUIExecutionOrchestrator,
  ComfyUIOperationError,
  ExecutionCallbackPersistenceError,
  acquireResourceSlot,
  adaptComfyWorkflowRuntimeChoices,
  createComfyUITransport,
  probeBackendFeatures,
  probeModelFolder,
  releaseResourceSlot,
  recordResourceTerminationProof,
  renewResourceSlot,
  streamCommitArtifact,
  materializeWorkflowInputs,
  parseComfyUIOperationTimeouts,
} from "@/lib/generation";
import type { BackendFeatureSnapshot, ComfyUITransport, ExecutionCallbacks, OrchestratorPhase } from "@/lib/generation";
import { InvalidResourceCardinalityError } from "@/lib/generation/resources/leases";
import {
  allowedWorkflowValidationKinds,
  bindWorkflow,
  loadValidatedWorkflowPackage,
  selectApplicableWorkflowValidation,
} from "@/lib/generation/workflows";
import { sha256Canonical } from "@/lib/generation/workflows/canonical";
import { resolveBackendAuthHeaders } from "@/lib/security";
import { linkArtifactToBusinessEntity, mergeGenerationJobMetadata } from "@/lib/generation/business-adapter";
import { selectPrimaryArtifact, type CollectedArtifactCandidate } from "@/lib/generation/artifact-selection";
import { verifyRequiredModelFilesCached } from "@/lib/generation/model-file-inventory";
import {
  attachOwnedAttempt,
  beginOwnedAttemptSubmission,
  cancelOwnedJobBeforeAttempt,
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

export interface GenerationJobLifecycleHooks {
  beforeTerminalResourceRelease?: (identity: {
    jobId: string;
    attemptId: string;
    resourcePoolId: string;
    slotNo: number;
  }) => Promise<void>;
  managedEndpoint?: { baseUrl: string; modelsRoot?: string };
}

function parsePersistedBackendFeatures(value: unknown, fingerprint: string | null): BackendFeatureSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !fingerprint) return null;
  const candidate = value as Partial<BackendFeatureSnapshot>;
  const cancellation = candidate.cancellation;
  const output = candidate.output;
  if (candidate.environmentFingerprint !== fingerprint
    || !["client-assigned", "server-assigned", "not-applicable"].includes(String(candidate.externalIdStrategy))
    || !cancellation || typeof cancellation.supportsPerTaskCancel !== "boolean"
    || typeof cancellation.hasGlobalInterrupt !== "boolean" || typeof cancellation.safeForShared !== "boolean"
    || !output || !["view", "api", "both"].includes(String(output.readMethod))
    || typeof output.supportsStreaming !== "boolean" || !Number.isFinite(output.maxOutputSizeBytesEstimate)
    || !Array.isArray(candidate.nodeCategories) || !candidate.nodeCategories.every((item) => typeof item === "string")
    || !Array.isArray(candidate.devicesSummary) || !candidate.devicesSummary.every((item) => typeof item === "string")
    || (candidate.comfyVersion !== undefined && typeof candidate.comfyVersion !== "string")
    || !Number.isSafeInteger(candidate.probedAtMs) || !Number.isSafeInteger(candidate.validUntilMs)
    || candidate.validUntilMs! < candidate.probedAtMs!) return null;
  return structuredClone(candidate) as BackendFeatureSnapshot;
}

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
  lifecycle: GenerationJobLifecycleHooks = {},
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
  let resourcePoolIdForSlot: string | null = null;
  let resourceTimer: ReturnType<typeof setInterval> | null = null;
  let retainResource = false;
  let resourceLeaseLost = false;
  let orchestrator: ComfyUIExecutionOrchestrator | null = null;
  let transport: ComfyUITransport | null = null;
  const executionController = new AbortController();
  const executionSignal = executionController.signal;
  const forwardExternalAbort = () => executionController.abort(abortSignal?.reason);
  if (abortSignal?.aborted) forwardExternalAbort();
  else abortSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
  const lifecycleState: { completedResult: JobExecutionResult | null } = { completedResult: null };
  const complete = (result: JobExecutionResult): JobExecutionResult => {
    lifecycleState.completedResult = result;
    return result;
  };
  let resourceRenewalInFlight: Promise<void> | null = null;
  let inputCleanup: (() => Promise<void>) | null = null;
  const committedArtifacts: CollectedArtifactCandidate[] = [];
  let outputSequence = 0;

  try {
    if (executionSignal.aborted) throw new Error("execution_aborted_before_start");
    const snapshot = job.executionSnapshotJson as Record<string, unknown>;
    const backendId = typeof snapshot.executionBackendId === "string" ? snapshot.executionBackendId : "";
    const workflowDigest = typeof snapshot.workflowPackageDigest === "string" ? snapshot.workflowPackageDigest : "";
    const request = snapshot.request && typeof snapshot.request === "object" ? snapshot.request as Record<string, unknown> : {};
    const config = snapshot.configJson && typeof snapshot.configJson === "object" ? snapshot.configJson as Record<string, unknown> : {};
    const jobMetadata = job.metadataJson && typeof job.metadataJson === "object"
      ? job.metadataJson as Record<string, unknown>
      : {};
    const traceId = typeof jobMetadata.traceId === "string"
      && /^trace-[A-Za-z0-9._:-]{1,160}$/.test(jobMetadata.traceId)
      ? jobMetadata.traceId
      : `trace-${job.id}`;
    if (!backendId || !workflowDigest) return failJob(job.id, "", workerId, jobFencingToken, "Backend and active workflow package are required", "config_error");

    const capturedConfiguration = db.transaction((tx) => {
      const backendRow = tx.select().from(executionBackends).where(eq(executionBackends.id, backendId)).get();
      const validationRows = tx.select().from(workflowBackendValidations).where(and(
        eq(workflowBackendValidations.workflowPackageDigest, workflowDigest),
        eq(workflowBackendValidations.executionBackendId, backendId),
        inArray(workflowBackendValidations.validationKind, allowedWorkflowValidationKinds()),
      )).all();
      const workflowRevision = tx.select({
        state: workflowPackageStates.state,
        lockDigest: workflowPackageRevisions.environmentLockDigest,
      }).from(workflowPackageRevisions).innerJoin(
        workflowPackageStates,
        eq(workflowPackageStates.workflowPackageDigest, workflowPackageRevisions.digest),
      ).where(eq(workflowPackageRevisions.digest, workflowDigest)).get();
      const validationRow = workflowRevision && backendRow
        ? selectApplicableWorkflowValidation(validationRows, {
            workflowState: workflowRevision.state,
            backendFingerprint: backendRow.environmentFingerprint,
            workflowLockDigest: workflowRevision.lockDigest,
          })
        : null;
      const poolRow = backendRow
        ? tx.select().from(resourcePools).where(eq(resourcePools.id, backendRow.resourcePoolId)).get()
        : undefined;
      const physicalSlots = backendRow
        ? tx.select().from(resourcePoolSlots).where(eq(resourcePoolSlots.resourcePoolId, backendRow.resourcePoolId)).all()
        : [];
      return {
        backend: backendRow ? structuredClone(backendRow) : undefined,
        validation: validationRow ? structuredClone(validationRow) : undefined,
        pool: poolRow ? structuredClone(poolRow) : undefined,
        physicalSlotCount: physicalSlots.length,
      };
    });
    const backend = capturedConfiguration.backend ? Object.freeze(capturedConfiguration.backend) : undefined;
    if (!backend || !backend.enabled) return failJob(job.id, "", workerId, jobFencingToken, "Execution backend is missing or disabled", "config_error");
    if (lifecycle.managedEndpoint && (backend.adapterKind !== "comfyui"
      || backend.baseUrl !== lifecycle.managedEndpoint.baseUrl
      || capturedConfiguration.pool?.id !== backend.resourcePoolId
      || capturedConfiguration.pool.capacity !== 1
      || capturedConfiguration.physicalSlotCount !== 1)) {
      return failJob(job.id, "", workerId, jobFencingToken, "Managed backend configuration does not match the worker endpoint", "config_error");
    }
    const persistedFeatures = parsePersistedBackendFeatures(backend.featureSnapshotJson, backend.environmentFingerprint);
    if (!persistedFeatures) {
      return failJob(job.id, "", workerId, jobFencingToken, "Execution backend feature snapshot is missing or invalid", "config_error");
    }
    const backendValidation = capturedConfiguration.validation;
    if (!backendValidation) {
      return failJob(
        job.id, "", workerId, jobFencingToken,
        "Workflow package is not validated for the exact backend environment",
        "workflow_backend_validation_missing", true,
      );
    }
    const workflowPackage = await loadValidatedWorkflowPackage(
      workflowDigest,
      backendValidation.validationKind,
    );
    if (workflowPackage.manifest.capability !== job.capability) return failJob(job.id, "", workerId, jobFencingToken, "Workflow capability does not match job", "config_error");
    if (backendValidation.environmentFingerprint !== backend.environmentFingerprint
      || backendValidation.environmentLockDigest !== workflowPackage.revision.environmentLockDigest) {
      return failJob(
        job.id, "", workerId, jobFencingToken,
        "Workflow package is not validated for the exact backend environment",
        "workflow_backend_validation_missing", true,
      );
    }

    const attemptNo = await getNextAttemptNo(job.id);
    const correlationId = `${traceId}.attempt-${attemptId}`.slice(0, 320);
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
        backendFeatureSnapshotJson: persistedFeatures as unknown as Record<string, unknown>,
        environmentFingerprint: persistedFeatures.environmentFingerprint,
        submissionCorrelationId: correlationId,
        externalIdStrategy: persistedFeatures.externalIdStrategy,
        systemOutputPrefix: outputPrefix,
        resourcePoolId: backend.resourcePoolId,
        resourceSlotNo: 0,
        resourceLeaseToken: `pending-${attemptId}`,
        resourceFencingToken: 0,
        createdAtMs: attemptCreatedAtMs,
        updatedAtMs: attemptCreatedAtMs,
      },
    });
    if (attached.status !== "applied") {
      const cancelled = cancelOwnedJobBeforeAttempt({ jobId: job.id, workerId, jobFencingToken });
      if (cancelled.status === "applied") return preSubmissionCancelledResult();
      requireApplied(attached, "job_claim_lost_before_attempt_attachment");
    }

    resourceSlot = await acquireResourceSlot(backend.resourcePoolId, attemptId, workerId);
    if (!resourceSlot) {
      return failJob(job.id, attemptId, workerId, jobFencingToken, "No resource slot available", "resource_exhausted");
    }
    resourcePoolIdForSlot = backend.resourcePoolId;
    const begun = beginOwnedAttemptSubmission({
      jobId: job.id,
      attemptId,
      workerId,
      jobFencingToken,
    }, {
      resourcePoolId: backend.resourcePoolId,
      slotNo: resourceSlot.slotNo,
      leaseToken: resourceSlot.leaseToken,
      fencingToken: resourceSlot.fencingToken,
    });
    if (begun.status === "cancelled-before-submission") {
      resourceSlot = null;
      return preSubmissionCancelledResult();
    }
    if (begun.status === "invalid-resource-cardinality") return invalidResourceCardinalityResult();
    requireApplied(begun, "job_or_resource_lease_lost_before_submission_boundary");

    resourceTimer = setInterval(() => {
      if (!resourceSlot || resourceRenewalInFlight) return;
      resourceRenewalInFlight = (async () => {
        const renewed = await renewResourceSlot(
          backend.resourcePoolId, resourceSlot.slotNo, resourceSlot.leaseToken, resourceSlot.fencingToken, workerId,
        ).catch(() => false);
        if (!renewed) {
          resourceLeaseLost = true;
          retainResource = true;
          executionController.abort(new Error("resource_lease_lost"));
          orchestrator?.stop();
        }
      })().finally(() => { resourceRenewalInFlight = null; });
    }, 30_000);

    const authHeaders = await resolveBackendAuthHeaders(backend.authType, backend.authConfigJson);
    transport = await createComfyUITransport(
      backend.baseUrl, backend.topology, authHeaders,
      Array.isArray((backend.networkPolicyJson as { resolvedAddresses?: unknown }).resolvedAddresses)
        ? ((backend.networkPolicyJson as { resolvedAddresses: unknown[] }).resolvedAddresses.filter((value): value is string => typeof value === "string"))
        : [],
      {
        policyRevision: sha256Canonical(backend.networkPolicyJson),
        ...parseComfyUIOperationTimeouts(backend.networkPolicyJson),
        lifecycleSignal: executionSignal,
      },
    );
    const activeTransport = transport;
    let runtimeObjectInfo: import("@/lib/generation").ComfyObjectInfo = {};
    const features: BackendFeatureSnapshot = await probeBackendFeatures(
      activeTransport,
      {},
      (objectInfo) => { runtimeObjectInfo = objectInfo; },
    );
    if (backend.environmentFingerprint !== features.environmentFingerprint) {
      return complete(await failJob(
        job.id,
        attemptId,
        workerId,
        jobFencingToken,
        "Backend environment fingerprint drifted after workflow activation",
        "environment_drift",
        true,
      ));
    }
    const modelFolders = new Map<string, string[]>();
    for (const model of workflowPackage.manifest.requirements.models) {
      if (model.runtimeVisible === false) continue;
      const runtimeFolder = model.runtimeFolder ?? model.folder;
      if (!modelFolders.has(runtimeFolder)) {
        modelFolders.set(runtimeFolder, await probeModelFolder(activeTransport, runtimeFolder));
      }
      if (!modelFolders.get(runtimeFolder)?.includes(model.filename.replace(/\\/g, "/"))) {
        return complete(await failJob(
          job.id, attemptId, workerId, jobFencingToken,
          `Required workflow model is no longer available: ${model.folder}/${model.filename}`,
          "environment_model_drift", true,
        ));
      }
    }
    if (workflowPackage.manifest.requirements.models.length > 0) {
      if (workflowPackage.manifest.requirements.models.some((model) => !model.sha256 || !model.sizeBytes)) {
        return complete(await failJob(
          job.id, attemptId, workerId, jobFencingToken,
          "Required workflow models do not have immutable size and SHA-256 identities",
          "environment_model_inventory_missing", true,
        ));
      }
      const modelsRoot = lifecycle.managedEndpoint?.modelsRoot?.trim()
        || process.env.AI_M_MANAGED_COMFYUI_MODELS_ROOT?.trim()
        || (process.env.AI_M_MANAGED_COMFYUI_DATA_ROOT?.trim()
          ? path.resolve(process.env.AI_M_MANAGED_COMFYUI_DATA_ROOT, "models")
          : "");
      if (!modelsRoot) {
        return complete(await failJob(
          job.id, attemptId, workerId, jobFencingToken,
          "Managed ComfyUI data root is unavailable for model integrity verification",
          "environment_model_inventory_missing", true,
        ));
      }
      try {
        await verifyRequiredModelFilesCached(
          path.resolve(modelsRoot),
          workflowPackage.manifest.requirements.models,
        );
      } catch {
        return complete(await failJob(
          job.id, attemptId, workerId, jobFencingToken,
          "Required workflow model bytes drifted from the activated manifest",
          "environment_model_drift", true,
        ));
      }
    }

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
      maxReferenceInputs: workflowPackage.manifest.limits.maxReferenceInputs
        ?? workflowPackage.manifest.limits.maxBatch,
      signal: executionSignal,
    });
    inputCleanup = materialized.cleanup;
    const workflow = adaptComfyWorkflowRuntimeChoices(
      bindWorkflow(
        workflowPackage.workflow,
        workflowPackage.compiled,
        materialized.parameters,
        outputPrefix,
      ),
      runtimeObjectInfo,
      new Set(workflowPackage.compiled.bindings
        .filter((binding) => binding.source !== "request")
        .map((binding) => `${binding.nodeId}:${binding.inputName}`)),
    );

    const durableCallbacks: ExecutionCallbacks = {
      onPhaseChange: async (phase: OrchestratorPhase) => {
        const mapped = phase === "CREATED" ? "PREPARING" : phase;
        if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(mapped)) return;
        // SUBMITTING was already persisted by the resource-bound atomic boundary.
        if (mapped === "SUBMITTING") return;
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
            sql`${generationJobs.claimUntilMs} > ${now}`,
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
            evidenceKind: result.evidenceKind,
            safeMessage: result.safeMessage.slice(0, 200),
          },
        }), "job_claim_lost_recording_cancellation_request");
      },
      onCancellationConfirmed: async (evidence) => {
        requireApplied(applyAttemptTransition(
          job.id, attemptId, workerId, jobFencingToken, "record-cancellation-confirmation", {}, {
            eventType: "external_cancellation_confirmed",
            severity: "info",
            safePayloadJson: { ...evidence },
          },
        ), "job_claim_lost_recording_cancellation_confirmation");
      },
      onExternalTerminationEvidence: async (evidence) => {
        if (!resourceSlot || !recordResourceTerminationProof({
          attemptId,
          backendId: backend.id,
          externalJobId: evidence.externalJobId,
          proofKind: evidence.proofKind,
          observedAtMs: evidence.observedAtMs,
          resourcePoolId: backend.resourcePoolId,
          resourceSlotNo: resourceSlot.slotNo,
          resourceLeaseToken: resourceSlot.leaseToken,
          resourceFencingToken: resourceSlot.fencingToken,
        })) throw new Error("external_termination_proof_persistence_failed");
        retainResource = false;
      },
      onOutputStream: async (output) => {
        requireApplied(applyAttemptTransition(
          job.id, attemptId, workerId, jobFencingToken, "commit-collected-output",
        ), "job_claim_lost_before_artifact_commit");
        const sequence = outputSequence++;
        const media = mimeForOutput(output.filename, output.mediaKind);
        const contentLengthHeader = output.response.headers.get("content-length");
        let contentLength: number | undefined;
        if (contentLengthHeader !== null) {
          if (!/^\d+$/.test(contentLengthHeader)) throw new Error("Output returned an invalid Content-Length");
          contentLength = Number(contentLengthHeader);
          if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
            throw new Error("Output returned an invalid Content-Length");
          }
          if (contentLength > workflowPackage.manifest.limits.maxOutputBytes) {
            throw new Error("Output exceeds workflow package limit");
          }
        }
        const contentEncoding = output.response.headers.get("content-encoding")?.trim().toLowerCase();
        const expectedSizeBytes = contentLength !== undefined
          && (contentEncoding === undefined || contentEncoding === "identity")
          ? contentLength
          : undefined;
        if (!output.response.body) throw new Error("Output response has no body");
        const committed = await streamCommitArtifact({
          attemptId,
          expectedJobClaimFencingToken: jobFencingToken,
          writerOwner: workerId,
          logicalName: `${output.nodeId}_${output.filename}`,
          kind: media.kind,
          mimeType: media.mimeType,
          visibility: "project",
          maxSizeBytes: workflowPackage.manifest.limits.maxOutputBytes,
          ...(expectedSizeBytes !== undefined ? { expectedSizeBytes } : {}),
          metadata: {
            nodeId: output.nodeId, outputKey: output.outputKey, outputField: output.field,
            mediaKind: output.mediaKind, originalFilename: output.filename,
            traceId,
            submissionCorrelationId: correlationId,
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

    orchestrator = new ComfyUIExecutionOrchestrator(activeTransport, features, callbacks, {
      totalExecutionTimeoutMs: workflowPackage.manifest.limits.maxJobMs,
      collectionTimeoutMs: Math.min(workflowPackage.manifest.limits.maxJobMs, 5 * 60 * 1000),
      isSharedBackend: backend.sharingMode === "shared",
      maxOutputs: workflowPackage.manifest.limits.maxOutputs,
      approvedOutputs: workflowPackage.compiled.outputs.map((output) => ({
        key: output.key, nodeId: output.nodeId, field: output.field,
        mediaKind: output.mediaKind, maxItems: output.maxItems,
      })),
    }, correlationId, executionSignal);
    const abortListener = () => orchestrator?.stop();
    executionSignal.addEventListener("abort", abortListener, { once: true });
    try {
      const result = await orchestrator.execute(workflow);
      if (resourceLeaseLost) return ownershipLostResult();
      if (executionSignal.aborted) {
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
        return complete({ success: true, finalPhase: "SUCCEEDED", needsAttention: false, claimDisposition: "release-terminal" });
      }
      if (result.cancellationRequested && result.phase === "CANCELLED") {
        retainResource = false;
        await cancelJob(job.id, attemptId, workerId, jobFencingToken);
        return complete({ success: false, finalPhase: "CANCELLED", needsAttention: false, claimDisposition: "release-terminal" });
      }
      retainResource = retainResource
        || result.submissionDisposition === "submission-uncertain"
        || result.needsAttention
        || result.phase === "SUBMISSION_UNKNOWN";
      return complete(await failJob(job.id, attemptId, workerId, jobFencingToken, result.errorMessage ?? `Execution ended in ${result.phase}`, result.errorClass ?? "execution_error", retainResource));
    } finally {
      executionSignal.removeEventListener("abort", abortListener);
    }
  } catch (error) {
    if (error instanceof OwnedTransitionError
      && (error.transitionStatus === "lost-race" || error.transitionStatus === "ownership-lost")) {
      retainResource = true;
      return ownershipLostResult();
    }
    if (resourceLeaseLost) {
      retainResource = true;
      return ownershipLostResult();
    }
    const cleanupOnFailure = error && typeof error === "object"
      ? (error as { cleanupOnFailure?: unknown }).cleanupOnFailure
      : undefined;
    if (typeof cleanupOnFailure === "function") {
      await Promise.resolve(cleanupOnFailure()).catch(() => undefined);
    }
    const materializationCause = typeof cleanupOnFailure === "function"
      && error instanceof Error
      && error.cause instanceof ComfyUIOperationError
      ? error.cause
      : null;
    if (materializationCause?.submissionDisposition === "definitely-not-submitted") {
      retainResource = false;
      return complete(await failJob(
        job.id, attemptId, workerId, jobFencingToken,
        "Input upload was not submitted before its operation deadline",
        "input_upload_not_sent",
      ));
    }
    retainResource = true;
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", forwardExternalAbort);
    if (resourceTimer) clearInterval(resourceTimer);
    try { await resourceRenewalInFlight; } catch { /* renewal failure already fences this execution */ }
    transport?.close();
    if (!retainResource && inputCleanup) await inputCleanup().catch(() => undefined);
    if (resourceSlot && resourcePoolIdForSlot && !retainResource
      && lifecycleState.completedResult?.claimDisposition === "release-terminal"
      && lifecycle.beforeTerminalResourceRelease) {
      try {
        await lifecycle.beforeTerminalResourceRelease({
          jobId: job.id,
          attemptId,
          resourcePoolId: resourcePoolIdForSlot,
          slotNo: resourceSlot.slotNo,
        });
      } catch (error) {
        retainResource = true;
        throw error;
      }
    }
    if (resourceSlot && resourcePoolIdForSlot && !retainResource) {
      await releaseResourceSlot(
        resourcePoolIdForSlot,
        resourceSlot.slotNo,
        attemptId,
        resourceSlot.leaseToken,
        resourceSlot.fencingToken,
      ).catch((error: unknown) => {
        if (error instanceof InvalidResourceCardinalityError) {
          console.error(
            "[generation] retained resource leases after terminal release cardinality failure",
            { code: error.code, attemptId: error.attemptId, slotCount: error.slotCount },
          );
        }
        return false;
      });
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

function preSubmissionCancelledResult(): JobExecutionResult {
  return {
    success: false,
    finalPhase: "CANCELLED",
    needsAttention: false,
    claimDisposition: "release-terminal",
  };
}

function invalidResourceCardinalityResult(): JobExecutionResult {
  return {
    success: false,
    finalPhase: "ORPHANED",
    needsAttention: true,
    claimDisposition: "retain-recovery",
  };
}

async function cancelJob(jobId: string, attemptId: string, workerId: string, fencingToken: number): Promise<void> {
  const now = Date.now();
  const result = finalizeOwnedExecution({ jobId, attemptId, workerId, jobFencingToken: fencingToken }, {
    expectedJobStatuses: ["RUNNING", "CANCEL_REQUESTED"],
    expectedAttemptPhases: CONFIRMED_CANCELLATION_PREDECESSORS,
    requiredPriorEventType: "external_cancellation_confirmed",
    attemptValues: { phase: "CANCELLED", finishedAtMs: now },
    jobValues: { status: "CANCELLED", completedAtMs: now },
    event: { eventType: "job_cancelled", severity: "info", safePayloadJson: {} },
  });
  requireApplied(result, "job_claim_lost_finalizing_cancellation");
}
