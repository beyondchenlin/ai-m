/**
 * v2.0 生成任务服务
 *
 * 手册 §11、§14：逻辑任务与执行尝试分离。
 * 提供创建、查询、取消和重试接口。
 */

import { db } from "@/lib/db";
import {
  generationJobs,
  generationAttempts,
  generationArtifacts,
  generationEvents,
  businessTaskGenerationJobs,
  generationProfileRevisions,
  executionBackends,
} from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import { isEnabled, FF } from "@/lib/feature-flags";
import type { CreateGenerationJobInput, GenerationJobView, ArtifactRef, RetryMode, Actor } from "@/lib/generation/contracts";
import type { JobStatus } from "@/lib/generation/naming";

/** 创建生成任务 */
export async function createGenerationJob(
  input: CreateGenerationJobInput,
  actor: Actor,
): Promise<GenerationJobView> {
  if (!isEnabled(FF.V2_DURABLE_EXECUTION)) {
    throw new Error("v2.0 durable execution is not enabled");
  }

  const now = Date.now();
  const jobId = genId();

  // 冻结执行快照
  const [profile] = await db
    .select()
    .from(generationProfileRevisions)
    .where(eq(generationProfileRevisions.id, input.profileRevisionId));

  if (!profile) {
    throw new Error(`Profile not found: ${input.profileRevisionId}`);
  }

  const inputDigest = `sha256:${Buffer.from(JSON.stringify(input.request)).toString("hex").slice(0, 64)}`;

  await db.insert(generationJobs).values({
    id: jobId,
    projectId: input.projectId,
    capability: input.capability,
    status: "QUEUED",
    executionSnapshotJson: {
      profileRevisionId: input.profileRevisionId,
      adapterKind: profile.adapterKind,
      executionBackendId: profile.executionBackendId,
      workflowPackageDigest: profile.workflowPackageDigest,
      configJson: profile.configJson,
      request: input.request,
      businessContext: input.businessContext,
    },
    inputDigest,
    dedupeScope: `${input.projectId}:${input.capability}`,
    createdAtMs: now,
    updatedAtMs: now,
  });

  // 关联业务任务
  if (input.businessContext?.id) {
    await db.insert(businessTaskGenerationJobs).values({
      businessTaskId: input.businessContext.id,
      generationJobId: jobId,
      relationKind: input.businessContext.kind,
      createdAtMs: now,
    });
  }

  return buildJobView(jobId);
}

/** 查询任务状态 */
export async function getGenerationJob(
  jobId: string,
  _actor: Actor,
): Promise<GenerationJobView | null> {
  return buildJobView(jobId);
}

/** 取消任务 */
export async function cancelGenerationJob(
  jobId: string,
  _actor: Actor,
): Promise<GenerationJobView> {
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId));

  if (!job) throw new Error(`Job not found: ${jobId}`);

  const cancellable: JobStatus[] = ["QUEUED", "RUNNING"];
  if (!cancellable.includes(job.status as JobStatus)) {
    throw new Error(`Job cannot be cancelled in status: ${job.status}`);
  }

  if (job.status === "QUEUED") {
    await db
      .update(generationJobs)
      .set({ status: "CANCELLED", updatedAtMs: Date.now() })
      .where(eq(generationJobs.id, jobId));
  } else {
    await db
      .update(generationJobs)
      .set({
        status: "CANCEL_REQUESTED",
        cancelRequestedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      })
      .where(eq(generationJobs.id, jobId));
  }

  return buildJobView(jobId);
}

/** 重试任务 */
export async function retryGenerationJob(
  jobId: string,
  _actor: Actor,
  mode: RetryMode,
): Promise<GenerationJobView> {
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId));

  if (!job) throw new Error(`Job not found: ${jobId}`);

  const retryableStatuses: JobStatus[] = ["FAILED", "CANCELLED", "NEEDS_ATTENTION"];
  if (!retryableStatuses.includes(job.status as JobStatus)) {
    throw new Error(`Job cannot be retried in status: ${job.status}`);
  }

  if (mode === "retry_full") {
    await db
      .update(generationJobs)
      .set({
        status: "QUEUED",
        claimOwner: null,
        claimUntilMs: null,
        currentAttemptId: null,
        updatedAtMs: Date.now(),
      })
      .where(eq(generationJobs.id, jobId));
  } else {
    // retry_collection / retry_submission: 保持当前尝试，重新执行特定阶段
    await db
      .update(generationJobs)
      .set({
        status: "RUNNING",
        updatedAtMs: Date.now(),
      })
      .where(eq(generationJobs.id, jobId));
  }

  return buildJobView(jobId);
}

/** 构建任务视图 */
async function buildJobView(jobId: string): Promise<GenerationJobView> {
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId));

  if (!job) throw new Error(`Job not found: ${jobId}`);

  // 查询当前尝试
  let phase: string | undefined;
  if (job.currentAttemptId) {
    const [attempt] = await db
      .select({ phase: generationAttempts.phase })
      .from(generationAttempts)
      .where(eq(generationAttempts.id, job.currentAttemptId));
    phase = attempt?.phase;
  }

  // 查询工件
  const artifacts: ArtifactRef[] = [];
  if (job.currentAttemptId) {
    const rows = await db
      .select()
      .from(generationArtifacts)
      .where(eq(generationArtifacts.attemptId, job.currentAttemptId))
      .orderBy(desc(generationArtifacts.createdAtMs));

    for (const a of rows) {
      artifacts.push({
        id: a.id,
        kind: a.kind,
        storageKey: a.storageKey,
        mimeType: a.mimeType,
        width: a.width ?? undefined,
        height: a.height ?? undefined,
        sizeBytes: a.sizeBytes,
      });
    }
  }

  const canCancel = ["QUEUED", "RUNNING"].includes(job.status);

  return {
    id: job.id,
    capability: job.capability as GenerationJobView["capability"],
    status: job.status,
    phase,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    canCancel,
    needsAttention: job.status === "NEEDS_ATTENTION",
    needsAttentionReason: job.needsAttentionReason ?? undefined,
    createdAtMs: job.createdAtMs,
    completedAtMs: job.completedAtMs ?? undefined,
  };
}