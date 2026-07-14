/**
 * v2.0 ComfyUI 安全取消策略
 *
 * 手册 §14.6：优先使用经探测确认的按任务取消。
 * 共享后端一律禁用全局中断；专用后端必须验证当前运行任务就是目标任务。
 * 取消与完成竞态以已提交工件和事务顺序裁决。
 */

import type { ComfyUITransport } from "./comfyui";
import { probeQueueStatus, readTextLimited } from "./comfyui";
import type { BackendFeatureSnapshot } from "./comfyui-behavior-probe";

/** 取消请求结果 */
export interface CancellationResult {
  /** 是否成功发起取消 */
  requested: boolean;
  /** 取消方式 */
  method: "per-task" | "global-interrupt" | "none";
  /** 安全消息（可展示给用户） */
  safeMessage: string;
  /** 是否需要对账确认 */
  needsReconciliation: boolean;
  /** What this call actually proved; dispatch is not terminal confirmation. */
  evidenceKind: "unknown" | "dispatch-acknowledged" | "dispatch-failed" | "unsupported";
}

/** 取消策略配置 */
export interface CancellationPolicyConfig {
  /** 是否为共享后端 */
  isShared: boolean;
  /** 取消确认超时（ms） */
  confirmTimeoutMs: number;
  /** 全局中断前验证目标任务的最大尝试次数 */
  targetVerifyAttempts: number;
}

const DEFAULT_CONFIG: CancellationPolicyConfig = {
  isShared: true,
  confirmTimeoutMs: 10_000,
  targetVerifyAttempts: 3,
};

/**
 * 安全取消：按手册策略选择取消方式
 *
 * 优先级：
 * 1. 按任务取消（最安全，共享后端也可用）
 * 2. 全局中断（仅专用后端，且必须验证目标任务）
 * 3. 不执行（共享后端且无按任务取消能力）
 */
export async function safeCancelJob(
  transport: ComfyUITransport,
  features: BackendFeatureSnapshot,
  externalJobId: string,
  config: Partial<CancellationPolicyConfig> = {},
): Promise<CancellationResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (features.cancellation.supportsPerTaskCancel) {
    return cancelByTaskId(transport, externalJobId, cfg);
  }

  if (!cfg.isShared && features.cancellation.hasGlobalInterrupt) {
    return cancelWithGlobalInterruptVerified(transport, externalJobId, features, cfg);
  }

  return {
    requested: false,
    method: "none",
    safeMessage:
      cfg.isShared
        ? "Shared backend cannot be cancelled safely (no per-task cancel support)"
        : "Cancellation not supported by this backend",
    needsReconciliation: true,
    evidenceKind: "unsupported",
  };
}

/** 按任务 ID 取消（推荐方式） */
async function cancelByTaskId(
  transport: ComfyUITransport,
  promptId: string,
  _cfg: CancellationPolicyConfig,
): Promise<CancellationResult> {
  try {
    const response = await transport.post("/queue", { delete: [promptId] });

    if (!response.ok && response.status !== 404 && response.status !== 400) {
      const text = await readTextLimited(response, 16 * 1024).catch(() => "");
      throw new Error(`Queue delete failed (${response.status}): ${text.slice(0, 200)}`);
    }

    return {
      requested: true,
      method: "per-task",
      safeMessage: "Cancellation requested via per-task queue API",
      needsReconciliation: true,
      evidenceKind: "dispatch-acknowledged",
    };
  } catch (err) {
    return {
      requested: false,
      method: "per-task",
      safeMessage: `Failed to request cancellation: ${(err as Error).message.slice(0, 100)}`,
      needsReconciliation: true,
      evidenceKind: "dispatch-failed",
    };
  }
}

/**
 * 全局中断（仅限专用后端）
 *
 * 必须：
 * 1. 在资源租约内执行
 * 2. 中断前验证当前运行任务就是目标任务
 * 3. 取消结果仍要对账
 */
async function cancelWithGlobalInterruptVerified(
  transport: ComfyUITransport,
  targetPromptId: string,
  _features: BackendFeatureSnapshot,
  cfg: CancellationPolicyConfig,
): Promise<CancellationResult> {
  for (let attempt = 0; attempt < cfg.targetVerifyAttempts; attempt++) {
    try {
      const queueData = await probeQueueStatus(transport);
      const running = queueData.queueRunning;

      if (running.length > 0) {
        const currentId = running[0]?.promptId;
        if (currentId === targetPromptId) {
          return doGlobalInterrupt(transport);
        } else {
          return {
            requested: false,
            method: "global-interrupt",
            safeMessage: "Cannot cancel: currently running task is not the target",
            needsReconciliation: false,
            evidenceKind: "unsupported",
          };
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return {
    requested: false,
    method: "global-interrupt",
    safeMessage: "Cannot verify target task for global interrupt",
    needsReconciliation: true,
    evidenceKind: "unknown",
  };
}

async function doGlobalInterrupt(transport: ComfyUITransport): Promise<CancellationResult> {
  try {
    const response = await transport.post("/interrupt", {});
    if (!response.ok && response.status !== 400) {
      throw new Error(`Interrupt failed (${response.status})`);
    }
    return {
      requested: true,
      method: "global-interrupt",
      safeMessage: "Global interrupt sent (dedicated backend)",
      needsReconciliation: true,
      evidenceKind: "dispatch-acknowledged",
    };
  } catch (err) {
    return {
      requested: false,
      method: "global-interrupt",
      safeMessage: `Interrupt failed: ${(err as Error).message.slice(0, 100)}`,
      needsReconciliation: true,
      evidenceKind: "dispatch-failed",
    };
  }
}

/**
 * 检查取消与完成的竞态
 *
 * 手册 §14.6：完成与取消竞态以已提交工件和事务顺序裁决。
 * 已提交工件不会被取消逻辑删除。
 */
export function resolveCancelCompletionRace(
  hasCommittedArtifacts: boolean,
  cancelRequestedAtMs: number,
  completionDetectedAtMs: number,
): "cancelled" | "completed" {
  if (hasCommittedArtifacts) {
    return "completed";
  }
  return cancelRequestedAtMs <= completionDetectedAtMs ? "cancelled" : "completed";
}

/** 错误分类：判断取消相关错误是否可重试 */
export function classifyCancellationError(error: Error): {
  retryable: boolean;
  errorClass: string;
} {
  const msg = error.message.toLowerCase();

  if (msg.includes("network") || msg.includes("fetch") || msg.includes("econn")) {
    return { retryable: true, errorClass: "transient_network" };
  }
  if (msg.includes("404") || msg.includes("not found")) {
    return { retryable: false, errorClass: "not_found" };
  }
  if (msg.includes("403") || msg.includes("forbidden") || msg.includes("unauthorized")) {
    return { retryable: false, errorClass: "permission_denied" };
  }

  return { retryable: false, errorClass: "unknown" };
}
