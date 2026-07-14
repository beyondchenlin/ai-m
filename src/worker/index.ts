/**
 * v2.0 独立 Worker 进程
 *
 * 手册 §12：与 Next.js 网页进程分离，通过数据库原子领取任务。
 * 支持优雅关闭、租约续期、恢复扫描和取消响应。
 *
 * 启动: npx tsx src/worker/index.ts
 * 生产: node dist/worker/index.js
 */

import { claimJob, renewJobClaim, releaseJobClaim, scanExpiredClaims, LEASE_CONFIG } from "@/lib/generation/resources/leases";
import { executeGenerationJob } from "@/lib/generation/worker-executor";
import { recoverStagingArtifacts } from "@/lib/generation/archiving";
import { cleanupTerminalSharedInputs } from "@/lib/generation/input-materializer";
import { cleanupSourceAssetStorage, recoverSourceMediaAssets } from "@/lib/generation/source-assets";
import { getSqlite } from "@/lib/db";
import { reconcileBusinessArtifactProjections } from "@/lib/generation/business-adapter";
import { isEnabled, FF } from "@/lib/feature-flags";

// Worker 标识
const WORKER_ID = `worker-${process.pid}-${Date.now().toString(36)}`;
const SUPPORTED_CAPABILITIES = ["image", "text", "video", "speech"] as const;

// 运行状态
let running = true;
let currentJobId: string | null = null;
let currentFencingToken: number | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let currentAbortController: AbortController | null = null;
let currentJobPromise: Promise<void> | null = null;
let shutdownStarted = false;
let recoveryScanRunning = false;

/** 心跳续期循环 */
function startHeartbeat(jobId: string, fencingToken: number) {
  stopHeartbeat();

  heartbeatTimer = setInterval(async () => {
    try {
      const ok = await renewJobClaim(jobId, WORKER_ID, fencingToken);
      if (!ok) {
        console.error(`[${WORKER_ID}] Heartbeat failed for job ${jobId}, fencing token mismatch`);
        // Ownership was lost. Abort local coordination; external state will be reconciled.
        currentAbortController?.abort(new Error("job_claim_lost"));
        stopHeartbeat();
      }
    } catch (err) {
      console.error(`[${WORKER_ID}] Heartbeat error:`, err);
    }
  }, LEASE_CONFIG.HEARTBEAT_INTERVAL_MS);
}

/** 停止心跳 */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** 恢复扫描器 */
function startRecoveryScanner() {
  recoveryTimer = setInterval(async () => {
    if (recoveryScanRunning) return;
    recoveryScanRunning = true;
    try {
      const result = await scanExpiredClaims();
      const projections = await reconcileBusinessArtifactProjections();
      const cleanedSharedInputs = await cleanupTerminalSharedInputs();
      const sourceRecovery = await recoverSourceMediaAssets();
      const sourceCleanup = await cleanupSourceAssetStorage();
      if (projections.projected > 0 || projections.failed > 0) {
        console.log(`[${WORKER_ID}] Business projections: projected=${projections.projected}, pending=${projections.failed}`);
      }
      if (result.requeuedJobs.length > 0) console.log(`[${WORKER_ID}] Recovery: requeued ${result.requeuedJobs.length} pre-submission jobs`);
      if (result.attentionJobs.length > 0) console.warn(`[${WORKER_ID}] Recovery: escalated ${result.attentionJobs.length} externally-uncertain jobs`);
      if (result.cancelledJobs.length > 0) console.log(`[${WORKER_ID}] Recovery: finalized ${result.cancelledJobs.length} pre-submission cancellations`);
      if (result.releasedSlots.length > 0) console.log(`[${WORKER_ID}] Recovery: released ${result.releasedSlots.length} terminal slots`);
      if (cleanedSharedInputs > 0) console.log(`[${WORKER_ID}] Recovery: removed ${cleanedSharedInputs} terminal shared-input namespaces`);
      if (sourceRecovery.committed || sourceRecovery.quarantined) {
        console.log(`[${WORKER_ID}] Source recovery: committed=${sourceRecovery.committed}, quarantined=${sourceRecovery.quarantined}`);
      }
      if (sourceCleanup.deletedFiles || sourceCleanup.orphanStagingFiles || sourceCleanup.abandonedAssets) {
        console.log(`[${WORKER_ID}] Source cleanup: deleted=${sourceCleanup.deletedFiles}, orphanStaging=${sourceCleanup.orphanStagingFiles}, abandoned=${sourceCleanup.abandonedAssets}`);
      }
    } catch (err) {
      console.error(`[${WORKER_ID}] Recovery scanner error:`, err);
    } finally {
      recoveryScanRunning = false;
    }
  }, LEASE_CONFIG.CLAIM_LEASE_MS);
}

/** 处理单个任务 */
async function processJob(job: NonNullable<Awaited<ReturnType<typeof claimJob>>>) {
  try {
    currentJobId = job.id;
    const fencingToken = job.claimFencingToken;
    currentFencingToken = fencingToken;

    console.log(`[${WORKER_ID}] Claimed job ${job.id} (capability: ${job.capability}, project: ${job.projectId})`);

    currentAbortController = new AbortController();
    // 启动心跳
    startHeartbeat(job.id, fencingToken);

    // Worker must never silently skip a claimed job.  The executor owns feature
    // checks and persists a terminal/attention state before ownership is released.
    console.log(`[${WORKER_ID}] Executing job ${job.id}...`);
    const result = await executeGenerationJob(job, WORKER_ID, fencingToken, currentAbortController.signal);
    console.log(`[${WORKER_ID}] Job ${job.id} finished: ${result.finalPhase}`);

    // Release only after the executor has durably recorded the outcome.
    await releaseJobClaim(job.id, WORKER_ID, fencingToken);
    console.log(`[${WORKER_ID}] Completed job ${job.id}`);
  } catch (err) {
    console.error(`[${WORKER_ID}] Error processing job ${job.id}:`, err);
    // Do not release ownership after an unexpected failure.  The external submit
    // may have succeeded even when the local response was lost.  Recovery must
    // classify the persisted attempt before another worker may act.
  } finally {
    stopHeartbeat();
    currentJobId = null;
    currentFencingToken = null;
    currentAbortController = null;
  }
}


async function waitForPlatformSchema(timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      const sqlite = getSqlite();
      const tables = sqlite.prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('generation_jobs','generation_attempts','generation_artifacts','workflow_package_revisions','workflow_backend_validations','voice_profiles','source_media_assets','generation_job_source_assets')",
      ).all();
      const names = new Set(tables.map((row) => row.name));
      if ([
        "generation_jobs",
        "generation_attempts",
        "generation_artifacts",
        "workflow_package_revisions",
        "workflow_backend_validations",
        "voice_profiles",
        "source_media_assets",
        "generation_job_source_assets",
      ].every((name) => names.has(name))) return;
    } catch {
      // The web process may still be applying migrations. Retry until timeout.
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Platform schema is not ready. Run application migrations before starting the worker.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** 主循环 */
async function mainLoop() {
  if (!isEnabled(FF.V2_DURABLE_EXECUTION)) {
    console.log(`[${WORKER_ID}] v2.0 durable execution is not enabled, exiting`);
    return;
  }

  console.log(`[${WORKER_ID}] Worker started, waiting for platform schema...`);
  await waitForPlatformSchema();
  console.log(`[${WORKER_ID}] Platform schema ready, polling for jobs...`);

  const artifactRecovery = await recoverStagingArtifacts();
  const cleanedSharedInputs = await cleanupTerminalSharedInputs();
  const sourceRecovery = await recoverSourceMediaAssets();
  const sourceCleanup = await cleanupSourceAssetStorage();
  if (artifactRecovery.committed || artifactRecovery.quarantined) {
    console.log(
      `[${WORKER_ID}] Artifact recovery: committed=${artifactRecovery.committed}, quarantined=${artifactRecovery.quarantined}`,
    );
  }

  if (cleanedSharedInputs > 0) {
    console.log(`[${WORKER_ID}] Shared-input recovery: removed=${cleanedSharedInputs}`);
  }
  if (sourceRecovery.committed || sourceRecovery.quarantined) {
    console.log(`[${WORKER_ID}] Source recovery: committed=${sourceRecovery.committed}, quarantined=${sourceRecovery.quarantined}`);
  }
  if (sourceCleanup.deletedFiles || sourceCleanup.orphanStagingFiles || sourceCleanup.abandonedAssets) {
    console.log(`[${WORKER_ID}] Source cleanup: deleted=${sourceCleanup.deletedFiles}, orphanStaging=${sourceCleanup.orphanStagingFiles}, abandoned=${sourceCleanup.abandonedAssets}`);
  }

  // 启动恢复扫描
  startRecoveryScanner();

  while (running) {
    try {
      // 按优先级轮询能力
      let job = null;
      for (const capability of SUPPORTED_CAPABILITIES) {
        job = await claimJob(WORKER_ID, capability);
        if (job) break;
      }

      if (job) {
        currentJobPromise = processJob(job);
        try {
          await currentJobPromise;
        } finally {
          currentJobPromise = null;
        }
      } else {
        // 没有任务，等待
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (err) {
      console.error(`[${WORKER_ID}] Main loop error:`, err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

/** 优雅关闭 */
async function gracefulShutdown(signal: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[${WORKER_ID}] Received ${signal}, shutting down gracefully...`);
  running = false;

  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }

  // Preserve the claim while the executor persists an attention/terminal state.
  currentAbortController?.abort(new Error(`worker_shutdown:${signal}`));
  if (currentJobPromise) {
    const graceMs = Math.max(5_000, Number(process.env.AI_M_WORKER_SHUTDOWN_GRACE_MS ?? 25_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      currentJobPromise.then(() => false, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), graceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      console.warn(`[${WORKER_ID}] Graceful shutdown timed out; durable recovery will reconcile the retained claim`);
    }
  }
  stopHeartbeat();
  console.log(`[${WORKER_ID}] Shutdown coordination complete`);
  process.exitCode = 0;
}

// 注册信号处理
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

// 启动
mainLoop().catch((err) => {
  console.error(`[${WORKER_ID}] Fatal error:`, err);
  process.exit(1);
});
