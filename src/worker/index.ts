/**
 * v2.0 独立 Worker 进程
 *
 * 手册 §12：与 Next.js 网页进程分离，通过数据库原子领取任务。
 * 支持优雅关闭、租约续期、恢复扫描和取消响应。
 *
 * 开发: corepack pnpm worker:dev（直接运行 tsx --env-file=.env src/worker/index.ts）
 * 生产: corepack pnpm worker（运行 dist/worker/index.cjs，不自动加载开发 .env）
 */

import { claimJob, renewJobClaim, releaseJobClaim, scanExpiredClaims, LEASE_CONFIG } from "@/lib/generation/resources/leases";
import { executeGenerationJob } from "@/lib/generation/worker-executor";
import { parseLegacyArtifactRecoveryBeforeMs, recoverStagingArtifacts } from "@/lib/generation/archiving";
import { cleanupTerminalSharedInputs } from "@/lib/generation/input-materializer";
import { cleanupSourceAssetStorage, recoverSourceMediaAssets } from "@/lib/generation/source-assets";
import { db, waitForCurrentMigrationBundle } from "@/lib/db";
import { reconcileBusinessArtifactProjections } from "@/lib/generation/business-adapter";
import { isEnabled, FF } from "@/lib/feature-flags";
import { settleClaimedJob } from "./claim-settlement";
import { connectionManagerRegistry } from "@/lib/generation/transports/comfyui-connection-manager";
import { executionBackends, resourcePools } from "@/lib/db/schema";
import {
  ManagedComfyUIRuntime,
  parseManagedComfyUIRuntimeConfig,
  type ManagedProbeTransport,
} from "@/lib/generation/runtime/managed-comfyui-runtime";
import { createComfyUITransport, type ComfyUITransport } from "@/lib/generation/transports/comfyui";
import { JobRuntimeBoundary } from "./job-runtime-boundary";

// Worker 标识
const WORKER_ID = `worker-${process.pid}-${Date.now().toString(36)}`;
const LEGACY_ARTIFACT_RECOVERY_BEFORE_MS = parseLegacyArtifactRecoveryBeforeMs(
  process.env.AI_M_LEGACY_ARTIFACT_RECOVERY_BEFORE_MS,
);
const SUPPORTED_CAPABILITIES = ["image", "text", "video", "speech"] as const;
const managedRuntimeConfig = parseManagedComfyUIRuntimeConfig(process.env);

type ManagedBackendRow = {
  id: string;
  adapterKind: string;
  baseUrl: string;
  resourcePoolId: string;
  enabled: boolean | number;
};

type ManagedPoolRow = { id: string; capacity: number };

export function validateManagedWorkerBackendConfiguration(
  baseUrl: "http://127.0.0.1:8000",
  backends: readonly ManagedBackendRow[],
  pools: readonly ManagedPoolRow[],
): void {
  const enabledComfyUI = backends.filter((backend) => (backend.enabled === true || backend.enabled === 1)
    && backend.adapterKind === "comfyui");
  const canonical = enabledComfyUI.filter((backend) => backend.baseUrl === baseUrl);
  const poolIds = new Set(canonical.map((backend) => backend.resourcePoolId));
  const pool = poolIds.size === 1 ? pools.find((candidate) => candidate.id === canonical[0]?.resourcePoolId) : undefined;
  if (canonical.length === 0
    || canonical.length !== enabledComfyUI.length
    || poolIds.size !== 1
    || pool?.capacity !== 1) {
    throw new Error("managed_comfyui_worker_configuration_invalid");
  }
}

type ProbeTransportCreator = (
  baseUrl: string,
  topology: string,
  headers: Record<string, string>,
  expectedResolvedAddresses: readonly string[],
  options: {
    policyRevision: string;
    resolver: (hostname: string, signal?: AbortSignal) => Promise<readonly { address: string; family: 4 | 6 }[]>;
  },
) => Promise<Pick<ComfyUITransport, "get" | "close">>;

export function createManagedProbeFactory(createTransport: ProbeTransportCreator) {
  return (baseUrl: "http://127.0.0.1:8000"): ManagedProbeTransport => {
    const transport = createTransport(baseUrl, "same-host", {}, ["127.0.0.1"], {
      policyRevision: "managed-loopback-v1",
      resolver: async (hostname) => {
        if (hostname !== "127.0.0.1") throw new Error("managed_comfyui_probe_non_loopback_host");
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    return {
      get: async (path, options) => (await transport).get(path, options),
      close: async () => { await Promise.resolve((await transport).close()); },
    };
  };
}

const managedRuntime = managedRuntimeConfig.enabled
  ? new ManagedComfyUIRuntime(managedRuntimeConfig, {
      probeFactory: createManagedProbeFactory(createComfyUITransport),
    })
  : null;

// 运行状态
let running = true;
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
      const artifactRecovery = await recoverStagingArtifacts({
        recoveryOwner: WORKER_ID, legacyRecoveryBeforeMs: LEGACY_ARTIFACT_RECOVERY_BEFORE_MS,
      });
      const result = await scanExpiredClaims();
      const projections = await reconcileBusinessArtifactProjections();
      const cleanedSharedInputs = await cleanupTerminalSharedInputs();
      const sourceRecovery = await recoverSourceMediaAssets();
      const sourceCleanup = await cleanupSourceAssetStorage();
      if (projections.projected > 0 || projections.failed > 0) {
        console.log(`[${WORKER_ID}] Business projections: projected=${projections.projected}, pending=${projections.failed}`);
      }
      if (artifactRecovery.claimed > 0) {
        console.log(`[${WORKER_ID}] Artifact recovery: claimed=${artifactRecovery.claimed}, committed=${artifactRecovery.committed}, quarantined=${artifactRecovery.quarantined}`);
      }
      if (result.requeuedJobs.length > 0) console.log(`[${WORKER_ID}] Recovery: requeued ${result.requeuedJobs.length} pre-submission jobs`);
      if (result.attentionJobs.length > 0) console.warn(`[${WORKER_ID}] Recovery: escalated ${result.attentionJobs.length} externally-uncertain jobs`);
      if (result.cancelledJobs.length > 0) console.log(`[${WORKER_ID}] Recovery: finalized ${result.cancelledJobs.length} pre-submission cancellations`);
      if (result.releasedSlots.length > 0) console.log(`[${WORKER_ID}] Recovery: released ${result.releasedSlots.length} terminal slots`);
      const nonAppliedRecoveries = result.outcomes.filter((outcome) => outcome.status !== "applied").length;
      if (nonAppliedRecoveries > 0) console.warn(`[${WORKER_ID}] Recovery: ${nonAppliedRecoveries} candidates changed before transition`);
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
type ClaimedJob = NonNullable<Awaited<ReturnType<typeof claimJob>>>;

async function executeClaimedJob(job: ClaimedJob, boundarySignal: AbortSignal) {
  const abortExecution = () => currentAbortController?.abort(boundarySignal.reason);
  try {
    const fencingToken = job.claimFencingToken;

    console.log(`[${WORKER_ID}] Claimed job ${job.id} (capability: ${job.capability}, project: ${job.projectId})`);

    currentAbortController = new AbortController();
    if (boundarySignal.aborted) abortExecution();
    else boundarySignal.addEventListener("abort", abortExecution, { once: true });
    // 启动心跳
    startHeartbeat(job.id, fencingToken);

    // Worker must never silently skip a claimed job.  The executor owns feature
    // checks and persists a terminal/attention state before ownership is released.
    console.log(`[${WORKER_ID}] Executing job ${job.id}...`);
    const result = await settleClaimedJob({
      execute: () => executeGenerationJob(job, WORKER_ID, fencingToken, currentAbortController!.signal),
      release: () => releaseJobClaim(job.id, WORKER_ID, fencingToken),
    });
    console.log(`[${WORKER_ID}] Job ${job.id} finished: ${result.finalPhase}`);
    if (result.claimDisposition === "release-terminal") {
      console.log(`[${WORKER_ID}] Completed job ${job.id}`);
    } else {
      console.warn(`[${WORKER_ID}] Retained job ${job.id} for fenced recovery`);
    }
    return result;
  } finally {
    boundarySignal.removeEventListener("abort", abortExecution);
    stopHeartbeat();
    currentAbortController = null;
  }
}


/** 主循环 */
function safeErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : "unknown_error";
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 512);
}

const jobRuntimeBoundary = new JobRuntimeBoundary<ClaimedJob, Awaited<ReturnType<typeof executeClaimedJob>>>({
  execute: executeClaimedJob,
  closeConnections: async () => {
    if (managedRuntime) connectionManagerRegistry.closeAll();
  },
  restart: async (signal) => {
    if (managedRuntime) await managedRuntime.restartAfterJob(signal);
  },
});

async function processJob(job: ClaimedJob) {
  try {
    await jobRuntimeBoundary.run(job);
  } catch (error) {
    console.error(`[${WORKER_ID}] Job runtime boundary blocked: ${safeErrorSummary(error)}`);
  }
}

async function mainLoop() {
  if (!isEnabled(FF.V2_DURABLE_EXECUTION)) {
    console.log(`[${WORKER_ID}] v2.0 durable execution is not enabled, exiting`);
    return;
  }

  console.log(`[${WORKER_ID}] Worker started, waiting for platform schema...`);
  await waitForCurrentMigrationBundle();
  if (managedRuntimeConfig.enabled) {
    const backends = await db.select({
      id: executionBackends.id,
      adapterKind: executionBackends.adapterKind,
      baseUrl: executionBackends.baseUrl,
      resourcePoolId: executionBackends.resourcePoolId,
      enabled: executionBackends.enabled,
    }).from(executionBackends);
    const pools = await db.select({ id: resourcePools.id, capacity: resourcePools.capacity }).from(resourcePools);
    validateManagedWorkerBackendConfiguration(managedRuntimeConfig.baseUrl, backends, pools);
    if (managedRuntime?.getEndpointState().state === "blocked") {
      throw new Error("managed_comfyui_worker_registry_blocked");
    }
    console.log(`[${WORKER_ID}] Managed ComfyUI single-endpoint configuration validated`);
  }
  console.log(`[${WORKER_ID}] Platform schema ready, polling for jobs...`);

  const artifactRecovery = await recoverStagingArtifacts({
    recoveryOwner: WORKER_ID, legacyRecoveryBeforeMs: LEGACY_ARTIFACT_RECOVERY_BEFORE_MS,
  });
  const cleanedSharedInputs = await cleanupTerminalSharedInputs();
  const sourceRecovery = await recoverSourceMediaAssets();
  const sourceCleanup = await cleanupSourceAssetStorage();
  if (artifactRecovery.committed || artifactRecovery.quarantined) {
    console.log(
      `[${WORKER_ID}] Artifact recovery: claimed=${artifactRecovery.claimed}, committed=${artifactRecovery.committed}, quarantined=${artifactRecovery.quarantined}`,
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
      jobRuntimeBoundary.assertReadyToClaim();
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
        if (jobRuntimeBoundary.state === "blocked") {
          console.error(`[${WORKER_ID}] Polling blocked by job runtime boundary`);
          break;
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
  const configuredGraceMs = Number(process.env.AI_M_WORKER_SHUTDOWN_GRACE_MS ?? 25_000);
  const graceMs = Number.isSafeInteger(configuredGraceMs) && configuredGraceMs >= 5_000 && configuredGraceMs <= 120_000
    ? configuredGraceMs
    : 25_000;
  await jobRuntimeBoundary.stop(graceMs);
  connectionManagerRegistry.closeAll();
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
