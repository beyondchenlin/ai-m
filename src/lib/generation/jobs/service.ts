/** Durable generation job service with authorization and idempotency. */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  businessTaskGenerationJobs,
  generationArtifacts,
  generationAttempts,
  generationJobs,
  generationProfileRevisions,
  generationProfileStates,
  executionBackends,
  workflowBackendValidations,
  workflowPackageRevisions,
  workflowPackageStates,
  projects,
  sourceMediaAssets,
  generationJobSourceAssets,
  jobInputArtifacts,
} from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { isEnabledForProject, FF } from "@/lib/feature-flags";
import type { Actor, ArtifactRef, CreateGenerationJobInput, GenerationJobView, RetryMode } from "@/lib/generation/contracts";
import type { JobStatus } from "@/lib/generation/naming";
import { parseCompiledBindings, sha256Canonical } from "@/lib/generation/workflows";
import {
  allowedWorkflowValidationKinds,
  selectApplicableWorkflowValidation,
} from "@/lib/generation/workflows";
import { buildIdempotencyRequestDigest, legacySnapshotIdempotencyDigest } from "./idempotency";
import {
  GenerationRequestValidationError,
  normalizeCompiledWorkflowRequest,
} from "./request-validation";
import {
  GenerationInputAccessError,
  loadAccessibleGenerationArtifactInputs,
  loadAccessibleSourceMediaInputs,
} from "../input-access";

export class GenerationJobServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413,
    readonly code: string,
  ) {
    super(message);
    this.name = "GenerationJobServiceError";
  }
}

function isAdmin(actor: Actor): boolean {
  return actor.roles.includes("admin");
}

async function assertProjectAccess(projectId: string, actor: Actor): Promise<void> {
  const [project] = await db.select({ userId: projects.userId }).from(projects).where(eq(projects.id, projectId));
  if (!project || (!isAdmin(actor) && project.userId !== actor.userId)) {
    throw new GenerationJobServiceError("Project not found", 404, "project_not_found");
  }
}

async function loadAuthorizedJob(jobId: string, actor: Actor) {
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  if (!job) return null;
  if (!job.projectId) {
    if (!isAdmin(actor)) throw new GenerationJobServiceError("Generation job not found", 404, "job_not_found");
  } else {
    await assertProjectAccess(job.projectId, actor);
  }
  return job;
}

function normalizeIdempotencyKey(input: CreateGenerationJobInput): string | null {
  if (input.idempotencyKey?.trim()) {
    const value = input.idempotencyKey.trim();
    if (value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
      throw new GenerationJobServiceError(
        "idempotencyKey has an invalid format",
        400,
        "idempotency_key_invalid",
      );
    }
    return value;
  }
  return null;
}

function normalizeSourceAssets(input: CreateGenerationJobInput): Array<{ id: string; role: string }> {
  if (!input.sourceAssets?.length) return [];
  if (input.sourceAssets.length > 16) {
    throw new GenerationJobServiceError("Too many source assets", 400, "too_many_source_assets");
  }
  const normalized = input.sourceAssets.map((item) => {
    const id = item.id?.trim();
    const role = item.role?.trim();
    if (!id || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) {
      throw new GenerationJobServiceError("Source asset id is invalid", 400, "source_asset_invalid");
    }
    if (!role || role.length > 80 || !/^[a-z][a-z0-9._-]*$/.test(role)) {
      throw new GenerationJobServiceError("Source asset role is invalid", 400, "source_asset_role_invalid");
    }
    return { id, role };
  });
  return [...new Map(normalized.map((item) => [`${item.id}:${item.role}`, item])).values()];
}

type SourceAccessRow = {
  id: string;
  projectId: string;
  userId: string;
  status: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
};

function validateSourceAssetRows(
  rows: SourceAccessRow[],
  ids: string[],
  projectId: string,
  actor: Actor,
): void {
  if (rows.length !== ids.length || rows.some((row) => (
    row.projectId !== projectId
    || row.status !== "COMMITTED"
    || (!isAdmin(actor) && row.userId !== actor.userId)
  ))) {
    throw new GenerationJobServiceError("One or more source assets are unavailable", 409, "source_asset_unavailable");
  }
}

async function assertSourceAssetsAccessible(
  sourceAssets: Array<{ id: string; role: string }>,
  projectId: string,
  actor: Actor,
): Promise<SourceAccessRow[]> {
  if (!sourceAssets.length) return [];
  const ids = [...new Set(sourceAssets.map((item) => item.id))];
  try {
    return await loadAccessibleSourceMediaInputs({
      ids,
      projectId,
      actor: { userId: actor.userId, isAdmin: isAdmin(actor) },
    });
  } catch (error) {
    if (!(error instanceof GenerationInputAccessError)) throw error;
    throw new GenerationJobServiceError(
      "One or more source assets are unavailable", 409, "source_asset_unavailable",
    );
  }
}

const DEFAULT_JOB_INPUT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function jobInputRetentionMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment.AI_M_JOB_INPUT_RETENTION_MS?.trim();
  if (!raw) return DEFAULT_JOB_INPUT_RETENTION_MS;
  const value = Number(raw);
  const minimum = 24 * 60 * 60 * 1000;
  const maximum = 365 * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("AI_M_JOB_INPUT_RETENTION_MS must be between one day and one year");
  }
  return value;
}

function generationArtifactReferences(metadata: Record<string, unknown> | undefined): Array<{ id: string; role: string }> {
  if (!metadata) return [];
  const references: Array<{ id: string; role: string }> = [];
  if (Array.isArray(metadata.referenceImages)) {
    metadata.referenceImages.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)
        && typeof (item as Record<string, unknown>).artifactId === "string") {
        references.push({
          id: (item as Record<string, unknown>).artifactId as string,
          role: `reference-image:${index}`,
        });
      }
    });
  }
  if (typeof metadata.voiceReferenceArtifactId === "string") {
    references.push({ id: metadata.voiceReferenceArtifactId, role: "voice-reference" });
  }
  return [...new Map(references.map((item) => [`${item.id}:${item.role}`, item])).values()];
}

async function loadGenerationArtifactSnapshots(
  references: Array<{ id: string; role: string }>,
  projectId: string,
  actor: Actor,
): Promise<Array<{ id: string; role: string; storageKey: string; sha256: string; sizeBytes: number; mimeType: string }>> {
  if (!references.length) return [];
  const ids = [...new Set(references.map((item) => item.id))];
  let rows;
  try {
    rows = await loadAccessibleGenerationArtifactInputs({
      ids,
      projectId,
      actor: { userId: actor.userId, isAdmin: isAdmin(actor) },
    });
  } catch (error) {
    if (!(error instanceof GenerationInputAccessError)) throw error;
    throw new GenerationJobServiceError(
      "One or more input artifacts are unavailable",
      409,
      "input_artifact_unavailable",
    );
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return references.map((reference) => ({ ...byId.get(reference.id)!, role: reference.role }));
}

export async function createGenerationJob(input: CreateGenerationJobInput, actor: Actor): Promise<GenerationJobView> {
  if (!isEnabledForProject(FF.V2_DURABLE_EXECUTION, input.projectId)) {
    throw new Error("v2.0 durable execution is not enabled for this project");
  }
  await assertProjectAccess(input.projectId, actor);
  const sourceAssets = normalizeSourceAssets(input);
  const sourceAssetRows = await assertSourceAssetsAccessible(sourceAssets, input.projectId, actor);
  const artifactSnapshots = await loadGenerationArtifactSnapshots(
    generationArtifactReferences(input.metadata),
    input.projectId,
    actor,
  );
  const [profile] = await db.select({
    revision: generationProfileRevisions,
    visibility: generationProfileStates.visibility,
    compiledBindingsJson: workflowPackageRevisions.compiledBindingsJson,
  })
    .from(generationProfileRevisions)
    .innerJoin(
      generationProfileStates,
      eq(generationProfileStates.generationProfileRevisionId, generationProfileRevisions.id),
    )
    .leftJoin(
      workflowPackageRevisions,
      eq(workflowPackageRevisions.digest, generationProfileRevisions.workflowPackageDigest),
    )
    .where(and(
      eq(generationProfileRevisions.id, input.profileRevisionId),
      eq(generationProfileStates.enabled, 1),
    ));
  if (!profile || (!isAdmin(actor) && profile.visibility !== "workspace")) {
    throw new GenerationJobServiceError("Generation profile is unavailable", 400, "profile_unavailable");
  }
  if (profile.revision.capability !== input.capability) {
    throw new GenerationJobServiceError("Profile capability does not match request capability", 400, "profile_capability_mismatch");
  }
  const profileRevision = profile.revision;
  let normalizedRequest = structuredClone(input.request) as unknown as Record<string, unknown>;
  if (profileRevision.adapterKind === "comfyui") {
    if (!profileRevision.executionBackendId || !profileRevision.workflowPackageDigest || !profile.compiledBindingsJson) {
      throw new GenerationJobServiceError("ComfyUI profile is incomplete", 409, "profile_incomplete");
    }
    try {
      const config = profileRevision.configJson && typeof profileRevision.configJson === "object"
        ? profileRevision.configJson as Record<string, unknown>
        : {};
      const defaults = config.defaultParameters && typeof config.defaultParameters === "object"
        ? config.defaultParameters
        : {};
      normalizedRequest = normalizeCompiledWorkflowRequest(
        parseCompiledBindings(profile.compiledBindingsJson),
        input.request,
        defaults,
      );
    } catch (error) {
      if (error instanceof GenerationRequestValidationError) {
        throw new GenerationJobServiceError(error.message, error.status, error.code);
      }
      throw new GenerationJobServiceError(
        "Compiled workflow input contract is invalid",
        409,
        "workflow_input_contract_invalid",
      );
    }
    const runtimes = await db.select({
      backendEnabled: executionBackends.enabled,
      backendFingerprint: executionBackends.environmentFingerprint,
      validationFingerprint: workflowBackendValidations.environmentFingerprint,
      validationLockDigest: workflowBackendValidations.environmentLockDigest,
      validationKind: workflowBackendValidations.validationKind,
      workflowLockDigest: workflowPackageRevisions.environmentLockDigest,
      workflowState: workflowPackageStates.state,
    }).from(executionBackends)
      .innerJoin(workflowBackendValidations, and(
        eq(workflowBackendValidations.executionBackendId, executionBackends.id),
        eq(workflowBackendValidations.workflowPackageDigest, profileRevision.workflowPackageDigest),
      ))
      .innerJoin(workflowPackageRevisions, eq(workflowPackageRevisions.digest, profileRevision.workflowPackageDigest))
      .innerJoin(
        workflowPackageStates,
        eq(workflowPackageStates.workflowPackageDigest, workflowPackageRevisions.digest),
      )
      .where(and(
        eq(executionBackends.id, profileRevision.executionBackendId),
        inArray(workflowBackendValidations.validationKind, allowedWorkflowValidationKinds()),
      ));
    const runtime = runtimes[0];
    const applicableValidation = runtime && selectApplicableWorkflowValidation(
      runtimes.map((candidate) => ({
        validationKind: candidate.validationKind,
        environmentFingerprint: candidate.validationFingerprint,
        environmentLockDigest: candidate.validationLockDigest,
      })),
      {
        workflowState: runtime.workflowState,
        backendFingerprint: runtime.backendFingerprint,
        workflowLockDigest: runtime.workflowLockDigest,
      },
    );
    if (!runtime?.backendEnabled || !applicableValidation) {
      throw new GenerationJobServiceError(
        "Generation profile is not validated for its current backend environment",
        409, "profile_environment_unvalidated",
      );
    }
  }

  const normalizedInput: CreateGenerationJobInput = {
    ...input,
    request: normalizedRequest as unknown as CreateGenerationJobInput["request"],
  };
  const inputDigest = sha256Canonical({ request: normalizedRequest, metadata: input.metadata ?? null, sourceAssets });
  const idempotencyRequestDigest = buildIdempotencyRequestDigest(normalizedInput, sourceAssets);
  // v1 digests hashed caller input before compiled defaults were resolved.
  // Keep a dual-read during rollout so an existing key remains reusable.
  const legacyCallerRequestDigest = buildIdempotencyRequestDigest(input, sourceAssets);
  const idempotencyKey = normalizeIdempotencyKey(input);
  if (idempotencyKey) {
    const [existing] = await db.select({
      id: generationJobs.id,
      requestDigest: generationJobs.idempotencyRequestDigest,
      executionSnapshotJson: generationJobs.executionSnapshotJson,
    }).from(generationJobs).where(and(
      eq(generationJobs.projectId, input.projectId),
      eq(generationJobs.capability, input.capability),
      eq(generationJobs.idempotencyKey, idempotencyKey),
    ));
    if (existing) {
      const existingDigest = existing.requestDigest
        ?? legacySnapshotIdempotencyDigest(input.capability, existing.executionSnapshotJson);
      if (existingDigest !== idempotencyRequestDigest && existingDigest !== legacyCallerRequestDigest) {
        throw new GenerationJobServiceError(
          "Idempotency key was already used for a different generation request",
          409,
          "idempotency_key_conflict",
        );
      }
      if (!existing.requestDigest) {
        await db.update(generationJobs)
          .set({ idempotencyRequestDigest, updatedAtMs: Date.now() })
          .where(and(eq(generationJobs.id, existing.id), isNull(generationJobs.idempotencyRequestDigest)));
      }
      return buildJobView(existing.id, actor);
    }
  }

  const jobId = genId();
  const traceId = `trace-${jobId}`;
  const now = Date.now();
  const dedupeScope = sha256Canonical({
    projectId: input.projectId,
    capability: input.capability,
    profileRevisionId: input.profileRevisionId,
    businessContext: input.businessContext ?? null,
    inputDigest,
  });
  if (!idempotencyKey) {
    const [activeDuplicate] = await db.select({ id: generationJobs.id }).from(generationJobs).where(and(
      eq(generationJobs.projectId, input.projectId),
      eq(generationJobs.dedupeScope, dedupeScope),
      inArray(generationJobs.status, ["QUEUED", "RUNNING", "CANCEL_REQUESTED"]),
    ));
    if (activeDuplicate) return buildJobView(activeDuplicate.id, actor);
  }
  let createdByThisCall = false;
  db.transaction((tx) => {
    // Revalidate inside the write transaction so deletion cannot race job input capture.
    if (sourceAssets.length) {
      const ids = [...new Set(sourceAssets.map((item) => item.id))];
      const rows = tx.select({
        id: sourceMediaAssets.id,
        projectId: sourceMediaAssets.projectId,
        userId: sourceMediaAssets.userId,
        status: sourceMediaAssets.status,
        storageKey: sourceMediaAssets.storageKey,
        sha256: sourceMediaAssets.sha256,
        sizeBytes: sourceMediaAssets.sizeBytes,
        mimeType: sourceMediaAssets.mimeType,
      }).from(sourceMediaAssets).where(inArray(sourceMediaAssets.id, ids)).all();
      validateSourceAssetRows(rows, ids, input.projectId, actor);
    }
    tx.insert(generationJobs).values({
      id: jobId,
      projectId: input.projectId,
      requestedBy: actor.userId,
      idempotencyKey,
      idempotencyRequestDigest: idempotencyKey ? idempotencyRequestDigest : null,
      metadataJson: {
        ...(input.metadata ? structuredClone(input.metadata) : {}),
        traceId,
      },
      capability: input.capability,
      status: "QUEUED",
      executionSnapshotJson: {
        requestDigestVersion: profileRevision.adapterKind === "comfyui" ? 2 : 1,
        profileRevisionId: input.profileRevisionId,
        adapterKind: profileRevision.adapterKind,
        executionBackendId: profileRevision.executionBackendId,
        workflowPackageDigest: profileRevision.workflowPackageDigest,
        configJson: profileRevision.configJson,
        request: structuredClone(normalizedRequest),
        metadata: {
          ...(input.metadata ? structuredClone(input.metadata) : {}),
          traceId,
        },
        sourceAssets: structuredClone(sourceAssets),
        businessContext: input.businessContext ? structuredClone(input.businessContext) : undefined,
      },
      inputDigest,
      dedupeScope,
      inputRetentionUntilMs: now + jobInputRetentionMs(),
      createdAtMs: now,
      updatedAtMs: now,
    }).onConflictDoNothing().run();

    const [created] = tx.select({ id: generationJobs.id }).from(generationJobs).where(eq(generationJobs.id, jobId)).all();
    if (!created) return;
    createdByThisCall = true;
    if (input.businessContext?.id) {
      tx.insert(businessTaskGenerationJobs).values({
        businessTaskId: input.businessContext.id,
        generationJobId: jobId,
        relationKind: input.businessContext.kind,
        createdAtMs: now,
      }).onConflictDoNothing().run();
    }
    if (sourceAssets.length) {
      tx.insert(generationJobSourceAssets).values(sourceAssets.map((item) => ({
        jobId,
        sourceAssetId: item.id,
        role: item.role,
        createdAtMs: now,
      }))).run();
    }
    const sourceById = new Map(sourceAssetRows.map((row) => [row.id, row]));
    const inputSnapshots = [
      ...sourceAssets.map((item) => {
        const descriptor = sourceById.get(item.id)!;
        return {
          jobId,
          artifactKind: "source-media" as const,
          artifactId: item.id,
          role: item.role,
          storageKey: descriptor.storageKey,
          sha256: descriptor.sha256,
          sizeBytes: descriptor.sizeBytes,
          mimeType: descriptor.mimeType,
          createdAtMs: now,
        };
      }),
      ...artifactSnapshots.map((descriptor) => ({
        jobId,
        artifactKind: "generation-artifact" as const,
        artifactId: descriptor.id,
        role: descriptor.role,
        storageKey: descriptor.storageKey,
        sha256: descriptor.sha256,
        sizeBytes: descriptor.sizeBytes,
        mimeType: descriptor.mimeType,
        createdAtMs: now,
      })),
    ];
    if (inputSnapshots.length) tx.insert(jobInputArtifacts).values(inputSnapshots).run();
  });

  let effectiveJobId = jobId;
  if (!createdByThisCall) {
    const [winner] = idempotencyKey
      ? await db.select({ id: generationJobs.id }).from(generationJobs).where(and(
          eq(generationJobs.projectId, input.projectId),
          eq(generationJobs.capability, input.capability),
          eq(generationJobs.idempotencyKey, idempotencyKey),
        ))
      : await db.select({ id: generationJobs.id }).from(generationJobs).where(and(
          eq(generationJobs.projectId, input.projectId),
          eq(generationJobs.dedupeScope, dedupeScope),
          inArray(generationJobs.status, ["QUEUED", "RUNNING", "CANCEL_REQUESTED"]),
        ));
    if (!winner) throw new Error("Failed to resolve the concurrent generation job winner");
    if (idempotencyKey) {
      const [winnerDetail] = await db.select({
        requestDigest: generationJobs.idempotencyRequestDigest,
        executionSnapshotJson: generationJobs.executionSnapshotJson,
      }).from(generationJobs).where(eq(generationJobs.id, winner.id));
      const winnerDigest = winnerDetail?.requestDigest
        ?? legacySnapshotIdempotencyDigest(input.capability, winnerDetail?.executionSnapshotJson);
      if (winnerDigest !== idempotencyRequestDigest && winnerDigest !== legacyCallerRequestDigest) {
        throw new GenerationJobServiceError(
          "Idempotency key was concurrently used for a different generation request",
          409,
          "idempotency_key_conflict",
        );
      }
    }
    effectiveJobId = winner.id;
  }
  return buildJobView(effectiveJobId, actor);
}

export async function getGenerationJob(jobId: string, actor: Actor): Promise<GenerationJobView | null> {
  const job = await loadAuthorizedJob(jobId, actor);
  return job ? buildJobView(job.id, actor) : null;
}

export async function cancelGenerationJob(jobId: string, actor: Actor): Promise<GenerationJobView> {
  const job = await loadAuthorizedJob(jobId, actor);
  if (!job) throw new GenerationJobServiceError("Generation job not found", 404, "job_not_found");
  if (!(["QUEUED", "RUNNING"] as JobStatus[]).includes(job.status as JobStatus)) {
    throw new GenerationJobServiceError(`Job cannot be cancelled in status ${job.status}`, 409, "job_not_cancellable");
  }
  const now = Date.now();
  const changed = await db.update(generationJobs).set(job.status === "QUEUED"
    ? { status: "CANCELLED", completedAtMs: now, updatedAtMs: now }
    : { status: "CANCEL_REQUESTED", cancelRequestedAtMs: now, updatedAtMs: now })
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, job.status)))
    .returning({ id: generationJobs.id });
  if (!changed[0]) {
    throw new GenerationJobServiceError("Job state changed while cancellation was requested", 409, "job_cancel_race");
  }
  return buildJobView(jobId, actor);
}

export async function retryGenerationJob(jobId: string, actor: Actor, mode: RetryMode): Promise<GenerationJobView> {
  const job = await loadAuthorizedJob(jobId, actor);
  if (!job) throw new GenerationJobServiceError("Generation job not found", 404, "job_not_found");
  if (mode !== "retry_full") {
    throw new GenerationJobServiceError("Only full retry is supported; collection and submission recovery are automatic", 400, "retry_mode_unsupported");
  }
  if (!(["FAILED", "CANCELLED"] as JobStatus[]).includes(job.status as JobStatus)) {
    const reason = job.status === "NEEDS_ATTENTION"
      ? "Jobs requiring attention must be reconciled by an administrator before retry"
      : `Job cannot be retried in status ${job.status}`;
    throw new GenerationJobServiceError(reason, 409, "job_not_retryable");
  }
  if (job.inputsReleasedAtMs || !job.inputRetentionUntilMs || job.inputRetentionUntilMs <= Date.now()) {
    throw new GenerationJobServiceError(
      "Job input retention expired; create a new generation job with current inputs",
      409,
      "job_inputs_expired",
    );
  }
  const sourceRows = await db.select({ status: sourceMediaAssets.status })
    .from(generationJobSourceAssets)
    .innerJoin(sourceMediaAssets, eq(sourceMediaAssets.id, generationJobSourceAssets.sourceAssetId))
    .where(eq(generationJobSourceAssets.jobId, jobId));
  if (sourceRows.some((row) => row.status !== "COMMITTED")) {
    throw new GenerationJobServiceError(
      "Job cannot be retried because a required source asset was deleted",
      409,
      "job_source_asset_unavailable",
    );
  }
  const metadata = { ...(job.metadataJson as Record<string, unknown>), retryMode: mode, retryRequestedBy: actor.userId, retryRequestedAtMs: Date.now() };
  const updated = await db.update(generationJobs).set({
    status: "QUEUED",
    claimOwner: null,
    claimUntilMs: null,
    currentAttemptId: null,
    currentArtifactId: null,
    cancelRequestedAtMs: null,
    metadataJson: metadata,
    completedAtMs: null,
    needsAttentionReason: null,
    updatedAtMs: Date.now(),
  }).where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, job.status)))
    .returning({ id: generationJobs.id });
  if (!updated[0]) {
    throw new GenerationJobServiceError(
      "Job status changed while the retry was being requested",
      409,
      "job_retry_race",
    );
  }
  return buildJobView(jobId, actor);
}

function artifactRef(artifact: typeof generationArtifacts.$inferSelect): ArtifactRef {
  return {
    id: artifact.id,
    kind: artifact.kind,
    url: `/api/generation/artifacts/${encodeURIComponent(artifact.id)}`,
    mimeType: artifact.mimeType,
    width: artifact.width ?? undefined,
    height: artifact.height ?? undefined,
    durationMs: artifact.durationMs ?? undefined,
    sizeBytes: artifact.sizeBytes,
  };
}

function toJobView(
  job: typeof generationJobs.$inferSelect,
  attempt: typeof generationAttempts.$inferSelect | undefined,
  artifacts: Array<typeof generationArtifacts.$inferSelect>,
): GenerationJobView {
  const snapshot = attempt?.progressSnapshotJson as { percent?: unknown } | null;
  const progress = typeof snapshot?.percent === "number"
    ? Math.max(0, Math.min(100, snapshot.percent))
    : undefined;
  return {
    id: job.id,
    capability: job.capability as GenerationJobView["capability"],
    status: job.status,
    phase: attempt?.phase,
    progress,
    errorMessageSafe: attempt?.errorMessageSafe ?? undefined,
    artifacts: artifacts.length ? artifacts.map(artifactRef) : undefined,
    canCancel: ["QUEUED", "RUNNING"].includes(job.status),
    needsAttention: job.status === "NEEDS_ATTENTION",
    needsAttentionReason: job.needsAttentionReason ?? undefined,
    createdAtMs: job.createdAtMs,
    completedAtMs: job.completedAtMs ?? undefined,
  };
}

async function buildJobView(jobId: string, actor: Actor): Promise<GenerationJobView> {
  const job = await loadAuthorizedJob(jobId, actor);
  if (!job) throw new GenerationJobServiceError("Generation job not found", 404, "job_not_found");
  const attempt = job.currentAttemptId
    ? (await db.select().from(generationAttempts)
      .where(eq(generationAttempts.id, job.currentAttemptId)).limit(1))[0]
    : undefined;
  const artifacts = job.currentAttemptId
    ? await db.select().from(generationArtifacts)
      .where(and(
        eq(generationArtifacts.attemptId, job.currentAttemptId),
        eq(generationArtifacts.status, "COMMITTED"),
      ))
      .orderBy(desc(generationArtifacts.createdAtMs))
    : [];
  return toJobView(job, attempt, artifacts);
}

/** List safe job views without exposing execution snapshots, backend addresses, or storage keys. */
export async function listGenerationJobs(
  projectId: string,
  actor: Actor,
  limit: number,
): Promise<GenerationJobView[]> {
  await assertProjectAccess(projectId, actor);
  const jobs = await db.select().from(generationJobs)
    .where(eq(generationJobs.projectId, projectId))
    .orderBy(desc(generationJobs.createdAtMs))
    .limit(Math.max(1, Math.min(limit, 100)));
  if (!jobs.length) return [];

  const attemptIds = jobs.map((job) => job.currentAttemptId).filter((id): id is string => Boolean(id));
  const attempts = attemptIds.length
    ? await db.select().from(generationAttempts).where(inArray(generationAttempts.id, attemptIds))
    : [];
  const artifacts = attemptIds.length
    ? await db.select().from(generationArtifacts).where(and(
        inArray(generationArtifacts.attemptId, attemptIds),
        eq(generationArtifacts.status, "COMMITTED"),
      )).orderBy(desc(generationArtifacts.createdAtMs))
    : [];

  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const artifactsByAttempt = new Map<string, Array<typeof generationArtifacts.$inferSelect>>();
  for (const artifact of artifacts) {
    const list = artifactsByAttempt.get(artifact.attemptId) ?? [];
    list.push(artifact);
    artifactsByAttempt.set(artifact.attemptId, list);
  }
  return jobs.map((job) => toJobView(
    job,
    job.currentAttemptId ? attemptById.get(job.currentAttemptId) : undefined,
    job.currentAttemptId ? artifactsByAttempt.get(job.currentAttemptId) ?? [] : [],
  ));
}
