/**
 * v2.0 Worker 任务执行器
 *
 * 手册 §12、§14：Worker 领取任务后，执行器负责完整的生命周期：
 * - 创建执行尝试
 * - 选择并探测执行后端
 * - 分配资源槽位
 * - 提交工作流并跟踪
 * - 收集输出并原子提交工件
 * - 处理取消、失败和对账
 */

import { db } from "@/lib/db";
import {
  generationAttempts,
  generationJobs,
  generationArtifacts,
  generationEvents,
  executionBackends,
  resourcePoolSlots,
} from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import { isEnabled, FF } from "@/lib/feature-flags";
import type {
  ComfyUITransport,
  BackendFeatureSnapshot,
  OrchestratorPhase,
  ExecutionCallbacks,
} from "@/lib/generation";
import {
  createComfyUITransport,
  probeBackendFeatures,
  ComfyUIExecutionOrchestrator,
  acquireResourceSlot,
  renewResourceSlot,
  releaseResourceSlot,
  commitArtifactFromBuffer,
} from "@/lib/generation";
import {
  buildZImageWorkflow,
  createZImageAdapter,
} from "@/lib/generation/adapters/zimage";
import {
  buildSpeechWorkflow,
  createLocalSpeechAdapter,
} from "@/lib/generation/adapters/local-speech";

/** 执行结果 */
export interface JobExecutionResult {
  success: boolean;
  finalPhase: string;
  errorMessage?: string;
  errorClass?: string;
  needsAttention: boolean;
}

/**
 * 执行单个生成任务
 *
 * 这是 Worker processJob 的核心实现，处理完整的生命周期。
 */
export async function executeGenerationJob(
  job: typeof generationJobs.$inferSelect,
  workerId: string,
  jobFencingToken: number,
): Promise<JobExecutionResult> {
  if (!isEnabled(FF.V2_COMFYUI_TRANSPORT)) {
    return {
      success: false,
      finalPhase: "FAILED",
      errorMessage: "ComfyUI transport not enabled",
      needsAttention: false,
    };
  }

  const attemptId = genId();
  let transport: ComfyUITransport | null = null;
  let features: BackendFeatureSnapshot | null = null;
  let resourceSlot: {
    slotNo: number;
    leaseToken: string;
    fencingToken: number;
  } | null = null;
  let resourceLeaseTimer: ReturnType<typeof setInterval> | null = null;

  try {
    const snapshot = job.executionSnapshotJson as Record<string, unknown>;
    const backendId = snapshot.executionBackendId as string;
    const adapterKind = snapshot.adapterKind as string;
    const configJson = snapshot.configJson as Record<string, unknown>;
    const request = snapshot.request as Record<string, unknown>;
    const resourcePoolId = snapshot.resourcePoolId as string | undefined;

    if (!backendId) {
      return failJob(job.id, attemptId, "No backend specified", "config_error", jobFencingToken);
    }

    const [backend] = await db
      .select()
      .from(executionBackends)
      .where(eq(executionBackends.id, backendId));

    if (!backend) {
      return failJob(job.id, attemptId, "Backend not found", "config_error", jobFencingToken);
    }

    transport = await createComfyUITransport(
      backend.baseUrl,
      backend.topology,
    );

    features = await probeBackendFeatures(transport);

    if (resourcePoolId) {
      const slot = await acquireResourceSlot(resourcePoolId, attemptId, workerId);
      if (!slot) {
        return failJob(
          job.id,
          attemptId,
          "No resource slot available",
          "resource_exhausted",
          jobFencingToken,
        );
      }
      resourceSlot = slot;

      resourceLeaseTimer = setInterval(async () => {
        if (resourceSlot) {
          const ok = await renewResourceSlot(
            resourcePoolId,
            resourceSlot.slotNo,
            resourceSlot.leaseToken,
            resourceSlot.fencingToken,
          );
          if (!ok) {
            console.error(`[${workerId}] Resource lease renewal failed for slot ${resourceSlot.slotNo}`);
          }
        }
      }, 30_000);
    }

    const attemptNo = await getNextAttemptNo(job.id);

    await db.insert(generationAttempts).values({
      id: attemptId,
      jobId: job.id,
      attemptNo,
      phase: "SUBMITTING",
      backendId: backend.id,
      backendFeatureSnapshotJson: features as unknown as Record<string, unknown>,
      environmentFingerprint: features.environmentFingerprint,
      submissionCorrelationId: `corr-${attemptId}`,
      externalIdStrategy: features.externalIdStrategy,
      systemOutputPrefix: `job-${job.id}-${attemptNo}`,
      resourcePoolId: resourcePoolId ?? "default",
      resourceSlotNo: resourceSlot?.slotNo ?? 0,
      resourceLeaseToken: resourceSlot?.leaseToken ?? "none",
      resourceFencingToken: resourceSlot?.fencingToken ?? 0,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });

    await db
      .update(generationJobs)
      .set({
        currentAttemptId: attemptId,
        updatedAtMs: Date.now(),
      })
      .where(
        and(
          eq(generationJobs.id, job.id),
          eq(generationJobs.claimFencingToken, jobFencingToken),
        ),
      );

    let workflow: Record<string, unknown>;
    switch (adapterKind) {
      case "zimage": {
        const adapter = await createZImageAdapter();
        workflow = await buildZImageWorkflow(adapter, {
          prompt: (request.prompt as string) ?? "",
          negativePrompt: (request.negativePrompt as string) ?? "",
          width: (request.width as number) ?? 1024,
          height: (request.height as number) ?? 1024,
          seed: (request.seed as string) ?? undefined,
          quality: (request.quality as string) ?? "standard",
        });
        break;
      }
      case "local-speech": {
        const adapter = await createLocalSpeechAdapter();
        workflow = await buildSpeechWorkflow(adapter, {
          text: (request.text as string) ?? "",
          voiceProfileId: (request.voiceProfileId as string) ?? "",
          speed: (request.speed as number) ?? 1.0,
        });
        break;
      }
      default:
        return failJob(
          job.id,
          attemptId,
          `Unsupported adapter: ${adapterKind}`,
          "config_error",
          jobFencingToken,
        );
    }

    const callbacks: ExecutionCallbacks = {
      onPhaseChange: (phase: OrchestratorPhase) => {
        updateAttemptPhase(attemptId, phase);
      },
      onProgress: (data) => {
        db.update(generationAttempts)
          .set({
            progressSnapshotJson: data as unknown as Record<string, unknown>,
            updatedAtMs: Date.now(),
          })
          .where(eq(generationAttempts.id, attemptId))
          .catch(() => {});
      },
      onOutputReady: async (output) => {
        const artifactId = genId();
        await commitArtifactFromBuffer({
          id: artifactId,
          attemptId,
          logicalName: `${output.nodeId}_${output.filename}`,
          kind: output.type === "image" ? "image" : output.type === "audio" ? "audio" : "archive",
          buffer: Buffer.from(output.data),
          mimeType: output.type === "image" ? "image/png" : "audio/wav",
          visibility: "project",
          projectId: job.projectId,
        });
      },
    };

    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      features,
      backend.baseUrl,
      callbacks,
    );

    const cancelCheckTimer = setInterval(async () => {
      const [currentJob] = await db
        .select({ status: generationJobs.status, cancelRequestedAtMs: generationJobs.cancelRequestedAtMs })
        .from(generationJobs)
        .where(eq(generationJobs.id, job.id));

      if (currentJob?.status === "CANCEL_REQUESTED" || currentJob?.cancelRequestedAtMs) {
        orchestrator.requestCancel().catch(() => {});
      }
    }, 2_000);

    try {
      const result = await orchestrator.execute(workflow);

      if (result.success) {
        await succeedJob(job.id, attemptId, jobFencingToken);
        return {
          success: true,
          finalPhase: "SUCCEEDED",
          needsAttention: false,
        };
      } else if (result.cancellationRequested) {
        await cancelJob(job.id, attemptId, jobFencingToken);
        return {
          success: false,
          finalPhase: "CANCELLED",
          needsAttention: false,
        };
      } else {
        return failJob(
          job.id,
          attemptId,
          result.errorMessage ?? "Execution failed",
          result.errorClass ?? "unknown",
          jobFencingToken,
          result.needsAttention,
        );
      }
    } finally {
      clearInterval(cancelCheckTimer);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return failJob(
      job.id,
      attemptId,
      error.message,
      "unexpected_error",
      jobFencingToken,
    );
  } finally {
    if (resourceLeaseTimer) {
      clearInterval(resourceLeaseTimer);
    }
    if (resourceSlot && job.executionSnapshotJson) {
      const snapshot = job.executionSnapshotJson as Record<string, unknown>;
      const resourcePoolId = snapshot.resourcePoolId as string | undefined;
      if (resourcePoolId) {
        await releaseResourceSlot(
          resourcePoolId,
          resourceSlot.slotNo,
          resourceSlot.leaseToken,
          resourceSlot.fencingToken,
        ).catch(() => {});
      }
    }
  }
}

async function getNextAttemptNo(jobId: string): Promise<number> {
  const attempts = await db
    .select({ attemptNo: generationAttempts.attemptNo })
    .from(generationAttempts)
    .where(eq(generationAttempts.jobId, jobId))
    .orderBy(desc(generationAttempts.attemptNo))
    .limit(1);

  return (attempts[0]?.attemptNo ?? 0) + 1;
}

async function updateAttemptPhase(attemptId: string, phase: string): Promise<void> {
  await db
    .update(generationAttempts)
    .set({ phase, updatedAtMs: Date.now() })
    .where(eq(generationAttempts.id, attemptId))
    .catch(() => {});
}

async function failJob(
  jobId: string,
  attemptId: string,
  errorMessage: string,
  errorClass: string,
  _fencingToken: number,
  needsAttention = false,
): Promise<JobExecutionResult> {
  const now = Date.now();

  await db
    .update(generationAttempts)
    .set({
      phase: "FAILED",
      errorClass,
      errorMessageSafe: errorMessage.slice(0, 500),
      finishedAtMs: now,
      updatedAtMs: now,
    })
    .where(eq(generationAttempts.id, attemptId))
    .catch(() => {});

  await db
    .update(generationJobs)
    .set({
      status: needsAttention ? "NEEDS_ATTENTION" : "FAILED",
      needsAttentionReason: needsAttention ? `${errorClass}: ${errorMessage.slice(0, 200)}` : null,
      completedAtMs: now,
      updatedAtMs: now,
    })
    .where(eq(generationJobs.id, jobId))
    .catch(() => {});

  await db
    .insert(generationEvents)
    .values({
      id: genId(),
      jobId,
      attemptId,
      eventType: "job_failed",
      severity: "error",
      safePayloadJson: { errorClass, errorMessage: errorMessage.slice(0, 200) },
      createdAtMs: now,
    })
    .catch(() => {});

  return {
    success: false,
    finalPhase: "FAILED",
    errorMessage,
    errorClass,
    needsAttention,
  };
}

async function succeedJob(
  jobId: string,
  attemptId: string,
  _fencingToken: number,
): Promise<void> {
  const now = Date.now();

  const [artifact] = await db
    .select({ id: generationArtifacts.id })
    .from(generationArtifacts)
    .where(eq(generationArtifacts.attemptId, attemptId))
    .orderBy(desc(generationArtifacts.createdAtMs))
    .limit(1);

  await db
    .update(generationAttempts)
    .set({
      phase: "SUCCEEDED",
      finishedAtMs: now,
      updatedAtMs: now,
    })
    .where(eq(generationAttempts.id, attemptId))
    .catch(() => {});

  await db
    .update(generationJobs)
    .set({
      status: "SUCCEEDED",
      currentArtifactId: artifact?.id ?? null,
      completedAtMs: now,
      updatedAtMs: now,
    })
    .where(eq(generationJobs.id, jobId))
    .catch(() => {});

  await db
    .insert(generationEvents)
    .values({
      id: genId(),
      jobId,
      attemptId,
      eventType: "job_succeeded",
      severity: "info",
      safePayloadJson: {},
      createdAtMs: now,
    })
    .catch(() => {});
}

async function cancelJob(
  jobId: string,
  attemptId: string,
  _fencingToken: number,
): Promise<void> {
  const now = Date.now();

  await db
    .update(generationAttempts)
    .set({
      phase: "CANCELLED",
      finishedAtMs: now,
      updatedAtMs: now,
    })
    .where(eq(generationAttempts.id, attemptId))
    .catch(() => {});

  await db
    .update(generationJobs)
    .set({
      status: "CANCELLED",
      completedAtMs: now,
      updatedAtMs: now,
    })
    .where(eq(generationJobs.id, jobId))
    .catch(() => {});

  await db
    .insert(generationEvents)
    .values({
      id: genId(),
      jobId,
      attemptId,
      eventType: "job_cancelled",
      severity: "info",
      safePayloadJson: {},
      createdAtMs: now,
    })
    .catch(() => {});
}
