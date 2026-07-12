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
import { isEnabled, FF } from "@/lib/feature-flags";

// Worker 标识
const WORKER_ID = `worker-${process.pid}-${Date.now().toString(36)}`;
const SUPPORTED_CAPABILITIES = ["image", "text", "video", "speech"];

// 运行状态
let running = true;
let currentJobId: string | null = null;
let currentFencingToken: number | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;

/** 心跳续期循环 */
function startHeartbeat(jobId: string, fencingToken: number) {
  stopHeartbeat();

  heartbeatTimer = setInterval(async () => {
    try {
      const ok = await renewJobClaim(jobId, WORKER_ID, fencingToken);
      if (!ok) {
        console.error(`[${WORKER_ID}] Heartbeat failed for job ${jobId}, fencing token mismatch`);
        // 租约丢失，安全退出
        currentJobId = null;
        currentFencingToken = null;
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
    try {
      const result = await scanExpiredClaims();
      if (result.expiredJobs.length > 0) {
        console.log(`[${WORKER_ID}] Recovery: freed ${result.expiredJobs.length} expired jobs`);
      }
      if (result.expiredSlots.length > 0) {
        console.log(`[${WORKER_ID}] Recovery: freed ${result.expiredSlots.length} expired slots`);
      }
    } catch (err) {
      console.error(`[${WORKER_ID}] Recovery scanner error:`, err);
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

    // 启动心跳
    startHeartbeat(job.id, fencingToken);

    // 检查取消请求
    if (job.cancelRequestedAtMs) {
      console.log(`[${WORKER_ID}] Job ${job.id} cancelled before execution`);
      await releaseJobClaim(job.id, WORKER_ID, fencingToken);
      return;
    }

    // TODO: PR-05 实现实际执行逻辑
    // 1. 创建 generationAttempts 记录
    // 2. 解析 executionSnapshotJson
    // 3. 根据 adapterKind 调用对应适配器
    // 4. 收集输出工件
    // 5. 原子提交工件
    // 6. 记录 generationEvents

    // 模拟执行（占位）
    console.log(`[${WORKER_ID}] Processing job ${job.id}...`);

    // 执行完成后释放
    await releaseJobClaim(job.id, WORKER_ID, fencingToken);
    console.log(`[${WORKER_ID}] Completed job ${job.id}`);
  } catch (err) {
    console.error(`[${WORKER_ID}] Error processing job ${job.id}:`, err);
    // 释放租约让其他 Worker 重试
    if (currentFencingToken !== null) {
      await releaseJobClaim(job.id, WORKER_ID, currentFencingToken).catch(() => {});
    }
  } finally {
    stopHeartbeat();
    currentJobId = null;
    currentFencingToken = null;
  }
}

/** 主循环 */
async function mainLoop() {
  if (!isEnabled(FF.V2_DURABLE_EXECUTION)) {
    console.log(`[${WORKER_ID}] v2.0 durable execution is not enabled, exiting`);
    return;
  }

  console.log(`[${WORKER_ID}] Worker started, polling for jobs...`);

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
        await processJob(job);
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
  console.log(`[${WORKER_ID}] Received ${signal}, shutting down gracefully...`);
  running = false;

  stopHeartbeat();

  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }

  // 释放当前任务
  if (currentJobId && currentFencingToken !== null) {
    console.log(`[${WORKER_ID}] Releasing current job ${currentJobId}...`);
    await releaseJobClaim(currentJobId, WORKER_ID, currentFencingToken).catch(() => {});
  }

  console.log(`[${WORKER_ID}] Shutdown complete`);
  process.exit(0);
}

// 注册信号处理
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// 启动
mainLoop().catch((err) => {
  console.error(`[${WORKER_ID}] Fatal error:`, err);
  process.exit(1);
});