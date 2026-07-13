/**
 * v2.0 ComfyUI 执行编排器
 *
 * 手册 §10.6、§10.7、§14：
 * - 按阶段轮询策略
 * - 超时分层
 * - 状态机推进
 * - 进度合并写入
 *
 * 这是 Worker 与 ComfyUI 传输层之间的中间层，
 * 负责编排整个外部执行生命周期。
 */

import type { ComfyUITransport, ComfyExecutionResult, ComfyWSMessage } from "./comfyui";
import { submitPrompt, probeHistory, downloadOutput } from "./comfyui";
import type { BackendFeatureSnapshot } from "./comfyui-behavior-probe";
import {
  ComfyUIConnectionManager,
  connectionManagerRegistry,
} from "./comfyui-connection-manager";
import { safeCancelJob } from "./comfyui-cancellation";
import {
  reconcileSubmission,
  shouldEscalateToAttention,
  nextReconciliationDelay,
  classifySubmissionError,
} from "./comfyui-reconciliation";
import type { CancellationResult } from "./comfyui-cancellation";
import type { ReconciliationResult } from "./comfyui-reconciliation";

/** 编排器状态（对应 attempt.phase） */
export type OrchestratorPhase =
  | "CREATED"
  | "SUBMITTING"
  | "SUBMISSION_UNKNOWN"
  | "EXTERNAL_QUEUED"
  | "EXTERNAL_RUNNING"
  | "COLLECTING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

/** 执行进度回调 */
export interface ExecutionCallbacks {
  onPhaseChange?: (phase: OrchestratorPhase) => void | Promise<void>;
  onProgress?: (data: {
    node: string | null;
    value: number;
    max: number;
    percent: number;
  }) => void | Promise<void>;
  onReconciliation?: (result: ReconciliationResult) => void | Promise<void>;
  onOutputReady?: (output: {
    nodeId: string;
    filename: string;
    subfolder: string;
    type: string;
    data: ArrayBuffer;
  }) => void | Promise<void>;
  onError?: (error: Error, errorClass: string) => void | Promise<void>;
}

/** 执行配置 */
export interface ExecutionConfig {
  /** 提交超时（ms） */
  submitTimeoutMs: number;
  /** 外部排队轮询间隔（ms） */
  queuedPollIntervalMs: number;
  /** 外部运行轮询间隔（ms） */
  runningPollIntervalMs: number;
  /** 执行总时限（ms） */
  totalExecutionTimeoutMs: number;
  /** 输出收集超时（ms） */
  collectionTimeoutMs: number;
  /** 输出首字节超时（ms） */
  firstByteTimeoutMs: number;
  /** 对账宽限（ms） */
  reconciliationGraceMs: number;
  /** 对账间隔（ms） */
  reconciliationIntervalMs: number;
  /** 最大对账次数 */
  maxReconciliationAttempts: number;
}

const DEFAULT_CONFIG: ExecutionConfig = {
  submitTimeoutMs: 30_000,
  queuedPollIntervalMs: 5_000,
  runningPollIntervalMs: 2_000,
  totalExecutionTimeoutMs: 30 * 60 * 1000,
  collectionTimeoutMs: 5 * 60 * 1000,
  firstByteTimeoutMs: 30_000,
  reconciliationGraceMs: 30_000,
  reconciliationIntervalMs: 30_000,
  maxReconciliationAttempts: 10,
};

/** 编排器结果 */
export interface OrchestratorResult {
  success: boolean;
  phase: OrchestratorPhase;
  externalJobId?: string;
  executionResult?: ComfyExecutionResult;
  outputs?: Array<{
    nodeId: string;
    filename: string;
    subfolder: string;
    type: string;
    data?: ArrayBuffer;
  }>;
  errorMessage?: string;
  errorClass?: string;
  cancellationRequested?: boolean;
  needsAttention?: boolean;
}

/**
 * ComfyUI 执行编排器
 *
 * 管理一次完整的外部执行生命周期：
 * 提交 → （对账） → 排队 → 运行 → 收集 → 完成
 *
 * 按手册要求：
 * - 实时消息优先，轮询兜底
 * - 提交不确定进入对账，不盲重试
 * - 取消按策略执行，禁止共享后端全局中断
 */
export class ComfyUIExecutionOrchestrator {
  private readonly transport: ComfyUITransport;
  private readonly features: BackendFeatureSnapshot;
  private readonly config: ExecutionConfig;
  private readonly callbacks: ExecutionCallbacks;
  private readonly connectionMgr: ComfyUIConnectionManager;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly correlationId?: string;

  private phase: OrchestratorPhase = "CREATED";
  private externalJobId: string | null = null;
  private cancelRequested = false;
  private stopped = false;
  private startTimeMs = 0;
  private submitTimeMs = 0;
  private reconciliationCount = 0;
  private outputCollected = false;

  private wsUnregister: (() => void) | null = null;
  private progressListener: (() => void) | null = null;

  constructor(
    transport: ComfyUITransport & { getClientId?: () => string },
    features: BackendFeatureSnapshot,
    baseUrl: string,
    callbacks: ExecutionCallbacks = {},
    config: Partial<ExecutionConfig> = {},
    correlationId?: string,
  ) {
    this.transport = transport;
    this.features = features;
    this.baseUrl = baseUrl;
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.clientId =
      (transport as { getClientId?: () => string }).getClientId?.() ??
      `orchestrator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.correlationId = correlationId;
    this.connectionMgr = connectionManagerRegistry.getOrCreate(baseUrl, this.clientId);
  }

  /**
   * 执行工作流
   *
   * @param workflow 工作流 API JSON
   * @returns 执行结果
   */
  async execute(workflow: Record<string, unknown>): Promise<OrchestratorResult> {
    this.startTimeMs = Date.now();
    this.stopped = false;

    try {
      this.setPhase("SUBMITTING");
      await this.connectionMgr.connect();

      const submitResult = await this.submitWithTimeout(workflow);
      if (!submitResult.success) {
        if (submitResult.needsReconciliation) {
          this.setPhase("SUBMISSION_UNKNOWN");
          const reconciled = await this.runReconciliationLoop();
          if (!reconciled) {
            return this.buildResult();
          }
        } else {
          return this.buildResult();
        }
      }

      this.setPhase("EXTERNAL_QUEUED");
      const started = await this.waitForExecutionStart();
      if (!started) {
        return this.buildResult();
      }

      this.setPhase("EXTERNAL_RUNNING");
      const completed = await this.waitForExecutionComplete();
      if (!completed) {
        return this.buildResult();
      }

      this.setPhase("COLLECTING");
      const collected = await this.collectOutputs();
      if (!collected) {
        return this.buildResult();
      }

      this.setPhase("SUCCEEDED");
      return this.buildResult();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const classification = classifySubmissionError(error);
      this.callbacks.onError?.(error, classification.errorClass);
      this.phase = "FAILED";
      return this.buildResult(error.message, classification.errorClass);
    } finally {
      this.cleanup();
    }
  }

  /** 请求取消（异步，结果需通过对账确认） */
  async requestCancel(): Promise<CancellationResult> {
    this.cancelRequested = true;

    if (!this.externalJobId) {
      return {
        requested: false,
        method: "none",
        safeMessage: "No external job ID yet, cannot cancel",
        needsReconciliation: false,
      };
    }

    return safeCancelJob(this.transport, this.features, this.externalJobId, {
      isShared: true,
    });
  }

  /** 停止编排器（内部使用） */
  stop(): void {
    this.stopped = true;
  }

  private setPhase(phase: OrchestratorPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.callbacks.onPhaseChange?.(phase);
  }

  private async submitWithTimeout(
    workflow: Record<string, unknown>,
  ): Promise<{ success: boolean; needsReconciliation: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.submitTimeoutMs);

    try {
      const result = await submitPrompt(this.transport, workflow, this.clientId, this.correlationId);
      clearTimeout(timeout);
      this.externalJobId = result.promptId;
      this.submitTimeMs = Date.now();
      return { success: true, needsReconciliation: false };
    } catch (err) {
      clearTimeout(timeout);
      const error = err instanceof Error ? err : new Error(String(err));
      const classification = classifySubmissionError(error);

      if (
        error.message.includes("timeout") ||
        error.message.includes("aborted") ||
        error.message.includes("Failed to fetch") ||
        classification.errorClass === "network_error"
      ) {
        this.submitTimeMs = Date.now();
        return { success: false, needsReconciliation: true };
      }

      if (classification.retryable) {
        return { success: false, needsReconciliation: true };
      }

      throw error;
    }
  }

  private async runReconciliationLoop(): Promise<boolean> {
    await new Promise((r) => setTimeout(r, this.config.reconciliationGraceMs));

    while (!this.stopped && this.reconciliationCount < this.config.maxReconciliationAttempts) {
      if (this.cancelRequested) return false;

      this.reconciliationCount++;

      const result = await reconcileSubmission(
        this.transport,
        this.externalJobId,
        this.features,
        {
          intervalMs: this.config.reconciliationIntervalMs,
          maxAttempts: this.config.maxReconciliationAttempts,
        },
        this.correlationId,
      );

      // 对账过程中发现了外部任务编号（提交响应丢失场景）
      if (result.discoveredExternalJobId && !this.externalJobId) {
        this.externalJobId = result.discoveredExternalJobId;
      }

      this.callbacks.onReconciliation?.(result);

      if (result.exists && result.externalStatus) {
        if (result.externalStatus === "queued" || result.externalStatus === "running") {
          return true;
        }
        if (result.externalStatus === "completed") {
          return true;
        }
        if (result.externalStatus === "failed") {
          this.phase = "FAILED";
          return false;
        }
      }

      if (shouldEscalateToAttention(this.submitTimeMs, this.reconciliationCount, result.evidenceStrength)) {
        this.phase = "FAILED";
        return false;
      }

      const delay = nextReconciliationDelay(this.reconciliationCount, {
        intervalMs: this.config.reconciliationIntervalMs,
      });
      await this.sleepCancellable(delay);
    }

    this.phase = "FAILED";
    return false;
  }

  private async waitForExecutionStart(): Promise<boolean> {
    if (!this.externalJobId) return false;

    this.registerWSListener();
    const startTime = Date.now();

    while (!this.stopped) {
      if (this.cancelRequested) {
        this.phase = "CANCELLED";
        return false;
      }

      if (Date.now() - startTime > this.config.totalExecutionTimeoutMs) {
        this.phase = "FAILED";
        return false;
      }

      try {
        const queue = await this.transport.post("/queue", {});
        if (queue.ok) {
          const data = (await queue.json()) as {
            queue_running?: Array<{ prompt_id: string }>;
            queue_pending?: Array<{ prompt_id: string }>;
          };

          const running = (data.queue_running ?? []).some((q) => q.prompt_id === this.externalJobId);
          if (running) {
            return true;
          }

          const history = await probeHistory(this.transport, this.externalJobId);
          if (history[this.externalJobId!]) {
            return true;
          }
        }
      } catch {
        // 轮询失败时用 WebSocket 事件兜底
      }

      const snap = this.connectionMgr.getProgressSnapshot(this.externalJobId);
      if (snap && snap.status === "running") {
        return true;
      }

      await this.sleepCancellable(this.config.queuedPollIntervalMs);
    }

    return false;
  }

  private async waitForExecutionComplete(): Promise<boolean> {
    if (!this.externalJobId) return false;

    const startTime = Date.now();

    while (!this.stopped) {
      if (this.cancelRequested) {
        this.phase = "CANCELLED";
        return false;
      }

      if (Date.now() - startTime > this.config.totalExecutionTimeoutMs) {
        this.phase = "FAILED";
        return false;
      }

      try {
        const history = await probeHistory(this.transport, this.externalJobId);
        if (history[this.externalJobId]) {
          const result = history[this.externalJobId];
          if (result.status.completed) {
            if (result.status.statusStr === "error") {
              this.phase = "FAILED";
              return false;
            }
            return true;
          }
        }
      } catch {
        // 轮询失败继续
      }

      const snap = this.connectionMgr.getProgressSnapshot(this.externalJobId);
      if (snap) {
        if (snap.status === "error") {
          this.phase = "FAILED";
          return false;
        }
        this.callbacks.onProgress?.({
          node: snap.currentNode,
          value: snap.progressValue,
          max: snap.progressMax,
          percent: snap.progressMax > 0 ? (snap.progressValue / snap.progressMax) * 100 : 0,
        });
      }

      await this.sleepCancellable(this.config.runningPollIntervalMs);
    }

    return false;
  }

  private async collectOutputs(): Promise<boolean> {
    if (!this.externalJobId) return false;

    const startTime = Date.now();

    try {
      const history = await probeHistory(this.transport, this.externalJobId);
      const result = history[this.externalJobId];

      if (!result) {
        this.phase = "FAILED";
        return false;
      }

      for (const [nodeId, output] of Object.entries(result.outputs)) {
        if (this.cancelRequested) {
          this.phase = "CANCELLED";
          return false;
        }

        if (Date.now() - startTime > this.config.collectionTimeoutMs) {
          this.phase = "FAILED";
          return false;
        }

        const files = [
          ...(output.images ?? []),
          ...(output.gifs ?? []),
          ...(output.audio ?? []),
        ];

        for (const file of files) {
          try {
            const data = await downloadOutput(this.transport, file);
            await this.callbacks.onOutputReady?.({
              nodeId,
              filename: file.filename,
              subfolder: file.subfolder,
              type: file.type,
              data,
            });
          } catch {
            // 单个文件下载失败不影响整体
          }
        }
      }

      this.outputCollected = true;
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.callbacks.onError?.(error, "collection_error");
      return false;
    }
  }

  private registerWSListener(): void {
    if (!this.externalJobId) return;
    if (this.wsUnregister) return;

    this.wsUnregister = this.connectionMgr.registerTaskHandler(
      this.externalJobId,
      (msg: ComfyWSMessage, snapshot) => {
        if (msg.type === "progress") {
          this.callbacks.onProgress?.({
            node: msg.data.node,
            value: msg.data.value,
            max: msg.data.max,
            percent: msg.data.max > 0 ? (msg.data.value / msg.data.max) * 100 : 0,
          });
        }
        if (msg.type === "execution_start") {
          this.setPhase("EXTERNAL_RUNNING");
        }
        if (msg.type === "execution_error") {
          this.phase = "FAILED";
        }
        void snapshot;
      },
    );
  }

  private async sleepCancellable(ms: number): Promise<void> {
    const interval = 100;
    const steps = Math.ceil(ms / interval);
    for (let i = 0; i < steps && !this.stopped && !this.cancelRequested; i++) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  private cleanup(): void {
    if (this.wsUnregister) {
      this.wsUnregister();
      this.wsUnregister = null;
    }
    if (this.externalJobId) {
      this.connectionMgr.clearTaskSnapshot(this.externalJobId);
    }
    if (this.progressListener) {
      this.progressListener();
      this.progressListener = null;
    }
  }

  private buildResult(errorMessage?: string, errorClass?: string): OrchestratorResult {
    return {
      success: this.phase === "SUCCEEDED",
      phase: this.phase,
      externalJobId: this.externalJobId ?? undefined,
      errorMessage,
      errorClass,
      cancellationRequested: this.cancelRequested,
      needsAttention: this.phase === "FAILED" && this.reconciliationCount > 0,
      outputs: this.outputCollected ? [] : undefined,
    };
  }
}
