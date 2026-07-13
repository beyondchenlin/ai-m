/**
 * v2.0 ComfyUI 提交对账机制
 *
 * 手册 §14.3、§14.4：提交响应丢失不自动重提，进入对账。
 * 对账证据：预分配任务编号历史、外部队列、实时事件、系统输出前缀、外部审计记录。
 * 证据强度不足时保持不确定，进入人工处理。
 */

import type { ComfyUITransport, ComfyExecutionResult } from "./comfyui";
import { probeHistory, probeQueueStatus } from "./comfyui";
import type { BackendFeatureSnapshot } from "./comfyui-behavior-probe";

/** 对账证据强度 */
export type EvidenceStrength = "none" | "weak" | "moderate" | "strong" | "conclusive";

/** 对账结论 */
export interface ReconciliationResult {
  /** 外部任务是否存在 */
  exists: boolean;
  /** 证据强度 */
  evidenceStrength: EvidenceStrength;
  /** 外部任务状态（如找到） */
  externalStatus?: "queued" | "running" | "completed" | "failed";
  /** 历史记录（如找到） */
  executionResult?: ComfyExecutionResult;
  /** 对账过程中发现的外部任务编号（提交响应丢失时用于恢复） */
  discoveredExternalJobId?: string;
  /** 收集到的证据列表 */
  evidence: ReconciliationEvidence[];
  /** 是否已完成对账时间戳 */
  reconciledAtMs: number;
}

/** 单项对账证据 */
export interface ReconciliationEvidence {
  source: "history_api" | "queue_running" | "queue_pending" | "ws_event" | "output_prefix" | "audit_log";
  strength: EvidenceStrength;
  description: string;
  collectedAtMs: number;
}

/** 对账配置 */
export interface ReconciliationConfig {
  /** 对账宽限期（ms）：提交后多久开始第一次对账 */
  gracePeriodMs: number;
  /** 对账间隔（ms） */
  intervalMs: number;
  /** 最大对账次数 */
  maxAttempts: number;
  /** 进入人工处理前的最短观察时长（ms） */
  attentionAfterMs: number;
}

const DEFAULT_CONFIG: ReconciliationConfig = {
  gracePeriodMs: 30_000,
  intervalMs: 30_000,
  maxAttempts: 10,
  attentionAfterMs: 10 * 60 * 1000,
};

/**
 * 执行一次对账检查
 *
 * 收集所有可能的证据并给出综合结论
 */
export async function reconcileSubmission(
  transport: ComfyUITransport,
  externalJobId: string | null,
  _features: BackendFeatureSnapshot,
  _config: Partial<ReconciliationConfig> = {},
  correlationId?: string,
): Promise<ReconciliationResult> {
  const evidence: ReconciliationEvidence[] = [];
  const now = Date.now();

  let foundInHistory = false;
  let foundInQueueRunning = false;
  let foundInQueuePending = false;
  let executionResult: ComfyExecutionResult | undefined;
  let discoveredExternalJobId: string | undefined;

  // 提交响应丢失时，先通过关联编号发现外部任务编号
  if (!externalJobId && correlationId) {
    try {
      const queue = await probeQueueStatus(transport, correlationId);
      const running = (queue.queueRunning ?? []) as Array<{ prompt_id?: string; correlation_id?: string }>;
      const pending = (queue.queuePending ?? []) as Array<{ prompt_id?: string; correlation_id?: string }>;
      const match = running.find((q) => q.correlation_id === correlationId) ??
        pending.find((q) => q.correlation_id === correlationId) ??
        running.find((q) => q.prompt_id) ??
        pending.find((q) => q.prompt_id);
      if (match?.prompt_id) {
        discoveredExternalJobId = match.prompt_id;
        evidence.push({
          source: "queue_running",
          strength: "strong",
          description: `Discovered external job id ${match.prompt_id} via correlation id`,
          collectedAtMs: now,
        });
      }
    } catch (err) {
      evidence.push({
        source: "queue_running",
        strength: "none",
        description: `Correlation discovery error: ${(err as Error).message.slice(0, 100)}`,
        collectedAtMs: now,
      });
    }
  }

  const resolvedExternalJobId = externalJobId ?? discoveredExternalJobId;

  if (!resolvedExternalJobId) {
    return {
      exists: false,
      evidenceStrength: "none",
      evidence,
      reconciledAtMs: now,
    };
  }

  try {
    const history = await probeHistory(transport, resolvedExternalJobId, correlationId);
    if (history[resolvedExternalJobId]) {
      foundInHistory = true;
      executionResult = history[resolvedExternalJobId];
      evidence.push({
        source: "history_api",
        strength: "strong",
        description: `Found in history API with status: ${executionResult.status.statusStr}`,
        collectedAtMs: now,
      });
    } else {
      evidence.push({
        source: "history_api",
        strength: "weak",
        description: "Not found in history API (may not have completed yet)",
        collectedAtMs: now,
      });
    }
  } catch (err) {
    evidence.push({
      source: "history_api",
      strength: "none",
      description: `History API error: ${(err as Error).message.slice(0, 100)}`,
      collectedAtMs: now,
    });
  }

  try {
    const queue = await probeQueueStatus(transport, correlationId);
    const running = (queue.queueRunning ?? []) as Array<{ prompt_id?: string; correlation_id?: string }>;
    const pending = (queue.queuePending ?? []) as Array<{ prompt_id?: string; correlation_id?: string }>;

    foundInQueueRunning = running.some((item) => item.prompt_id === resolvedExternalJobId);
    foundInQueuePending = pending.some((item) => item.prompt_id === resolvedExternalJobId);

    if (foundInQueueRunning) {
      evidence.push({
        source: "queue_running",
        strength: "conclusive",
        description: "Found in running queue",
        collectedAtMs: now,
      });
    }
    if (foundInQueuePending) {
      evidence.push({
        source: "queue_pending",
        strength: "strong",
        description: "Found in pending queue",
        collectedAtMs: now,
      });
    }
    if (!foundInQueueRunning && !foundInQueuePending) {
      evidence.push({
        source: "queue_running",
        strength: "moderate",
        description: "Not found in running or pending queue",
        collectedAtMs: now,
      });
    }
  } catch (err) {
    evidence.push({
      source: "queue_running",
      strength: "none",
      description: `Queue API error: ${(err as Error).message.slice(0, 100)}`,
      collectedAtMs: now,
    });
  }

  const exists = foundInHistory || foundInQueueRunning || foundInQueuePending;

  let externalStatus: ReconciliationResult["externalStatus"];
  if (foundInQueueRunning) {
    externalStatus = "running";
  } else if (foundInQueuePending) {
    externalStatus = "queued";
  } else if (executionResult) {
    if (executionResult.status.completed) {
      externalStatus = executionResult.status.statusStr === "error" ? "failed" : "completed";
    } else {
      externalStatus = "queued";
    }
  }

  const evidenceStrength = computeOverallStrength(evidence, exists);

  return {
    exists,
    evidenceStrength,
    externalStatus,
    executionResult,
    discoveredExternalJobId,
    evidence,
    reconciledAtMs: now,
  };
}

/** 综合所有证据得出总强度 */
function computeOverallStrength(
  evidence: ReconciliationEvidence[],
  exists: boolean,
): EvidenceStrength {
  const conclusive = evidence.filter((e) => e.strength === "conclusive");
  const strong = evidence.filter((e) => e.strength === "strong");
  const moderate = evidence.filter((e) => e.strength === "moderate");

  if (conclusive.length > 0) return "conclusive";
  if (strong.length >= 2) return "strong";
  if (strong.length === 1 && moderate.length >= 1) return "strong";
  if (strong.length === 1) return "moderate";
  if (moderate.length >= 2) return exists ? "moderate" : "weak";
  if (moderate.length === 1) return "weak";
  return "none";
}

/**
 * 判断是否应进入人工处理状态
 *
 * 手册 §14.4：证据强度不足时保持不确定，
 * 超过观察时长后进入人工处理。
 */
export function shouldEscalateToAttention(
  submissionTimeMs: number,
  reconciliationCount: number,
  latestStrength: EvidenceStrength,
  config: Partial<ReconciliationConfig> = {},
): boolean {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const elapsed = Date.now() - submissionTimeMs;

  if (latestStrength === "conclusive" || latestStrength === "strong") {
    return false;
  }

  if (reconciliationCount >= cfg.maxAttempts) return true;
  if (elapsed > cfg.attentionAfterMs) return true;

  return false;
}

/**
 * 计算下一次对账的延迟时间（带退避） */
export function nextReconciliationDelay(
  attempt: number,
  config: Partial<ReconciliationConfig> = {},
): number {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const baseDelay = cfg.intervalMs;
  const backoff = Math.pow(1.5, Math.min(attempt, 5));
  const jitter = baseDelay * 0.2 * (Math.random() - 0.5);
  return Math.round(baseDelay * backoff + jitter);
}

/** 错误分类：提交相关错误 */
export function classifySubmissionError(error: Error): {
  errorClass: string;
  retryable: boolean;
  retryScope: "none" | "submission_only" | "full";
} {
  const msg = error.message.toLowerCase();
  const statusMatch = msg.match(/\((\d{3})\)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { errorClass: "client_error", retryable: false, retryScope: "none" };
  }

  if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
    return { errorClass: "server_error", retryable: true, retryScope: "submission_only" };
  }

  if (
    msg.includes("network") ||
    msg.includes("econn") ||
    msg.includes("timeout") ||
    msg.includes("fetch failed")
  ) {
    return { errorClass: "network_error", retryable: true, retryScope: "submission_only" };
  }

  if (msg.includes("validation") || msg.includes("workflow") || msg.includes("node error")) {
    return { errorClass: "workflow_error", retryable: false, retryScope: "none" };
  }

  return { errorClass: "unknown", retryable: false, retryScope: "none" };
}
