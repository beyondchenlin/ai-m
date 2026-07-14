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
} from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { isEnabled, FF } from "@/lib/feature-flags";
import type { Actor, ArtifactRef, CreateGenerationJobInput, GenerationJobView, RetryMode } from "@/lib/generation/contracts";
import type { JobStatus } from "@/lib/generation/naming";
import { canonicalize, sha256 } from "@/lib/generation/workflows";
import { buildIdempotencyRequestDigest, legacySnapshotIdempotencyDigest } from "./idempotency";

export class GenerationJobServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
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
): Promise<void> {
  if (!sourceAssets.length) return;
  const ids = [...new Set(sourceAssets.map((item) => item.id))];
  const rows = await db.select({
    id: sourceMediaAssets.id,
    projectId: sourceMediaAssets.projectId,
    userId: sourceMediaAssets.userId,
    status: sourceMediaAssets.status,
  }).from(sourceMediaAssets).where(inArray(sourceMediaAssets.id, ids));
  validateSourceAssetRows(rows, ids, projectId, actor);
}

export async function createGenerationJob(input: CreateGenerationJobInput, actor: Actor): Promise<GenerationJobView> {
  if (!isEnabled(FF.V2_DURABLE_EXECUTION)) throw new Error("v2.0 durable execution is not enabled");
  await assertProjectAccess(input.projectId, actor);
  const sourceAssets = normalizeSourceAssets(input);
  await assertSourceAssetsAccessible(sourceAssets, input.projectId, actor);
  const [profile] = await db.select({
    revision: generationProfileRevisions,
    visibility: generationProfileStates.visibility,
  })
    .from(generationProfileRevisions)
    .innerJoin(
      generationProfileStates,
      eq(generationProfileStates.generationProfileRevisionId, generationProfileRevisions.id),
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
  if (profileRevision.adapterKind === "comfyui") {
    if (!profileRevision.executionBackendId || !profileRevision.workflowPackageDigest) {
      throw new GenerationJobServiceError("ComfyUI profile is incomplete", 409, "profile_incomplete");
    }
    const [runtime] = await db.select({
      backendEnabled: executionBackends.enabled,
      backendFingerprint: executionBackends.environmentFingerprint,
      validationFingerprint: workflowBackendValidations.environmentFingerprint,
      validationLockDigest: workflowBackendValidations.environmentLockDigest,
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
      .where(eq(executionBackends.id, profileRevision.executionBackendId));
    if (!runtime || !runtime.backendEnabled
      || runtime.workflowState !== "active"
      || !runtime.backendFingerprint
      || runtime.backendFingerprint !== runtime.validationFingerprint
      || runtime.validationLockDigest !== runtime.workflowLockDigest) {
      throw new GenerationJobServiceError(
        "Generation profile is not validated for its current backend environment",
        409, "profile_environment_unvalidated",
      );
    }
  }

  const inputDigest = sha256(canonicalize({ request: input.request, metadata: input.metadata ?? null, sourceAssets }));
  const idempotencyRequestDigest = buildIdempotencyRequestDigest(input, sourceAssets);
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
      if (existingDigest !== idempotencyRequestDigest) {
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
  const now = Date.now();
  const dedupeScope = sha256(canonicalize({
    projectId: input.projectId,
    capability: input.capability,
    profileRevisionId: input.profileRevisionId,
    businessContext: input.businessContext ?? null,
    inputDigest,
  }));
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
      }).from(sourceMediaAssets).where(inArray(sourceMediaAssets.id, ids)).all();
      validateSourceAssetRows(rows, ids, input.projectId, actor);
    }
    tx.insert(generationJobs).values({
      id: jobId,
      projectId: input.projectId,
      requestedBy: actor.userId,
      idempotencyKey,
      idempotencyRequestDigest: idempotencyKey ? idempotencyRequestDigest : null,
      metadataJson: input.metadata ? structuredClone(input.metadata) : {},
      capability: input.capability,
      status: "QUEUED",
      executionSnapshotJson: {
        profileRevisionId: input.profileRevisionId,
        adapterKind: profileRevision.adapterKind,
        executionBackendId: profileRevision.executionBackendId,
        workflowPackageDigest: profileRevision.workflowPackageDigest,
        configJson: profileRevision.configJson,
        request: structuredClone(input.request),
        metadata: input.metadata ? structuredClone(input.metadata) : undefined,
        sourceAssets: structuredClone(sourceAssets),
        businessContext: input.businessContext ? structuredClone(input.businessContext) : undefined,
      },
      inputDigest,
      dedupeScope,
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
      if (winnerDigest !== idempotencyRequestDigest) {
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
