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
import { classifyComfyHistory, submitPrompt, probeHistory, probeQueueStatus } from "./comfyui";
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
  onExternalJobId?: (externalJobId: string) => void | Promise<void>;
  onOutputStream?: (output: {
    nodeId: string;
    outputKey: string;
    field: string;
    mediaKind: "image" | "video" | "audio";
    filename: string;
    subfolder: string;
    type: string;
    response: Response;
  }) => void | Promise<void>;
  onError?: (error: Error, errorClass: string) => void | Promise<void>;
  /** Persistent cancellation probe supplied by the durable worker. */
  isCancellationRequested?: () => boolean | Promise<boolean>;
  /** Records the exact cancellation method/evidence selected by policy. */
  onCancellationResult?: (result: CancellationResult) => void | Promise<void>;
  /** Persists strong terminal evidence before the attempt may become CANCELLED. */
  onCancellationConfirmed?: (evidence: CancellationConfirmationEvidence) => void | Promise<void>;
}

export interface CancellationConfirmationEvidence {
  outcome: "confirmed-cancelled";
  source: "history-terminal-cancelled" | "strong-cancel-receipt";
  externalJobId: string;
  method: CancellationResult["method"];
  observedAtMs: number;
}

type CancellationOutcome =
  | { outcome: "pending" | "unknown" | "completed" | "failed" }
  | { outcome: "confirmed-cancelled"; evidence: CancellationConfirmationEvidence };

/** A durable callback failed; callers must retain ownership for recovery. */
export class ExecutionCallbackPersistenceError extends Error {
  constructor(cause: unknown) {
    super("execution_callback_persistence_failed", { cause });
  }
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
  /** 对账宽限（ms） */
  reconciliationGraceMs: number;
  /** 对账间隔（ms） */
  reconciliationIntervalMs: number;
  /** 最大对账次数 */
  maxReconciliationAttempts: number;
  /** 后端是否为共享实例；共享实例禁止全局中断 */
  isSharedBackend: boolean;
  /** 单次执行允许收集的最大输出数量 */
  maxOutputs: number;
  /** Only compiler-approved output fields may be archived. */
  approvedOutputs: Array<{
    key: string;
    nodeId: string;
    field: string;
    mediaKind: "image" | "video" | "audio";
    maxItems: number;
  }>;
}

const DEFAULT_CONFIG: ExecutionConfig = {
  submitTimeoutMs: 30_000,
  queuedPollIntervalMs: 5_000,
  runningPollIntervalMs: 2_000,
  totalExecutionTimeoutMs: 30 * 60 * 1000,
  collectionTimeoutMs: 5 * 60 * 1000,
  reconciliationGraceMs: 30_000,
  reconciliationIntervalMs: 30_000,
  maxReconciliationAttempts: 10,
  isSharedBackend: true,
  maxOutputs: 20,
  approvedOutputs: [],
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
  private cancellationDispatched = false;
  private cancellationWithoutIdReported = false;
  private cancellationResult: CancellationResult | null = null;
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
      await this.setPhase("SUBMITTING");
      await this.connectionMgr.connect();

      const submitResult = await this.submitWithTimeout(workflow);
      if (!submitResult.success) {
        if (submitResult.needsReconciliation) {
          await this.setPhase("SUBMISSION_UNKNOWN");
          const reconciled = await this.runReconciliationLoop();
          if (!reconciled) {
            return this.buildResult();
          }
        } else {
          return this.buildResult();
        }
      }

      await this.setPhase("EXTERNAL_QUEUED");
      const started = await this.waitForExecutionStart();
      if (!started) {
        return this.buildResult();
      }

      await this.setPhase("EXTERNAL_RUNNING");
      const completed = await this.waitForExecutionComplete();
      if (!completed) {
        return this.buildResult();
      }

      await this.setPhase("COLLECTING");
      const collected = await this.collectOutputs();
      if (!collected) {
        this.phase = "FAILED";
        return this.buildResult();
      }

      await this.setPhase("SUCCEEDED");
      return this.buildResult();
    } catch (err) {
      if (err instanceof ExecutionCallbackPersistenceError) throw err;
      const error = err instanceof Error ? err : new Error(String(err));
      const classification = classifySubmissionError(error);
      await this.callbacks.onError?.(error, classification.errorClass);
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
      const result: CancellationResult = {
        requested: false,
        method: "none",
        safeMessage: "Cancellation is awaiting correlation reconciliation for an external job ID",
        needsReconciliation: true,
        evidenceKind: "unknown",
      };
      this.cancellationResult = result;
      if (!this.cancellationWithoutIdReported) {
        this.cancellationWithoutIdReported = true;
        await this.callbacks.onCancellationResult?.(result);
      }
      return result;
    }

    if (this.cancellationDispatched) {
      return this.cancellationResult ?? {
        requested: true,
        method: "none",
        safeMessage: "Cancellation was already dispatched; awaiting reconciliation",
        needsReconciliation: true,
        evidenceKind: "unknown",
      };
    }

    this.cancellationDispatched = true;
    const result = await safeCancelJob(this.transport, this.features, this.externalJobId, {
      isShared: this.config.isSharedBackend,
    });
    this.cancellationResult = result;
    await this.callbacks.onCancellationResult?.(result);
    return result;
  }

  /** 停止编排器（内部使用） */
  stop(): void {
    this.stopped = true;
  }

  private async setPhase(phase: OrchestratorPhase): Promise<void> {
    if (this.phase === phase) return;
    this.phase = phase;
    await this.callbacks.onPhaseChange?.(phase);
  }

  private async submitWithTimeout(
    workflow: Record<string, unknown>,
  ): Promise<{ success: boolean; needsReconciliation: boolean }> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Do not abort the underlying request on timeout: the server may already
      // have accepted the prompt.  A local timeout is therefore classified as
      // submission-unknown and reconciled by correlation ID.
      const result = await Promise.race([
        submitPrompt(this.transport, workflow, this.clientId, this.correlationId),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("submission_timeout")), this.config.submitTimeoutMs);
        }),
      ]);
      this.externalJobId = result.promptId;
      await this.callbacks.onExternalJobId?.(result.promptId);
      this.submitTimeMs = Date.now();
      return { success: true, needsReconciliation: false };
    } catch (err) {
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
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async runReconciliationLoop(): Promise<boolean> {
    await new Promise((r) => setTimeout(r, this.config.reconciliationGraceMs));

    while (!this.stopped && this.reconciliationCount < this.config.maxReconciliationAttempts) {
      await this.refreshCancellationState();

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
        await this.callbacks.onExternalJobId?.(result.discoveredExternalJobId);
        if (this.cancelRequested) await this.requestCancel();
      }

      await this.callbacks.onReconciliation?.(result);

      if (result.exists && result.externalStatus) {
        if (result.externalStatus === "queued" || result.externalStatus === "running") {
          return true;
        }
        if (result.externalStatus === "completed") {
          return true;
        }
        if (result.externalStatus === "cancelled") {
          const cancellation = this.classifyCancellationHistory(result.executionResult);
          if (this.cancelRequested && cancellation?.outcome === "confirmed-cancelled") {
            await this.confirmCancellation(cancellation);
            return false;
          }
          this.phase = "FAILED";
          return false;
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
      await this.sleepCancellable(delay, false);
    }

    this.phase = "FAILED";
    return false;
  }

  private async waitForExecutionStart(): Promise<boolean> {
    if (!this.externalJobId) return false;

    this.registerWSListener();
    const startTime = Date.now();

    while (!this.stopped) {
      if (await this.refreshCancellationState()) {
        const cancellation = await this.resolveCancellationOutcome();
        if (cancellation.outcome === "completed") return true;
        if (cancellation.outcome === "failed") {
          this.phase = "FAILED";
          return false;
        }
        if (cancellation.outcome === "confirmed-cancelled") {
          await this.confirmCancellation(cancellation);
          return false;
        }
      }

      if (Date.now() - startTime > this.config.totalExecutionTimeoutMs) {
        this.phase = "FAILED";
        return false;
      }

      try {
        const data = await probeQueueStatus(this.transport);
        {
          const running = data.queueRunning.some((q) => q.promptId === this.externalJobId);
          if (running) {
            return true;
          }

          const history = await probeHistory(this.transport, this.externalJobId);
          const historyOutcome = classifyComfyHistory(history[this.externalJobId!]);
          if (historyOutcome === "completed") return true;
          if (historyOutcome === "failed" || historyOutcome === "cancelled") {
            this.phase = "FAILED";
            return false;
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
      if (await this.refreshCancellationState()) {
        const cancellation = await this.resolveCancellationOutcome();
        if (cancellation.outcome === "completed") return true;
        if (cancellation.outcome === "failed") {
          this.phase = "FAILED";
          return false;
        }
        if (cancellation.outcome === "confirmed-cancelled") {
          await this.confirmCancellation(cancellation);
          return false;
        }
      }

      if (Date.now() - startTime > this.config.totalExecutionTimeoutMs) {
        this.phase = "FAILED";
        return false;
      }

      try {
        const history = await probeHistory(this.transport, this.externalJobId);
        const historyOutcome = classifyComfyHistory(history[this.externalJobId]);
        if (historyOutcome === "completed") return true;
        if (historyOutcome === "failed" || historyOutcome === "cancelled") {
          this.phase = "FAILED";
          return false;
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
        await this.callbacks.onProgress?.({
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

      if (this.config.approvedOutputs.length === 0) {
        await this.callbacks.onError?.(new Error("Workflow has no compiler-approved output contracts"), "output_contract_error");
        return false;
      }
      let collectedOutputCount = 0;
      for (const contract of this.config.approvedOutputs) {
        const output = result.outputs[contract.nodeId] as Record<string, unknown> | undefined;
        if (!output) continue;
        // Once ComfyUI reports completion, committed output wins the cancel race.
        // Continue collecting immutable outputs instead of discarding completed work.
        if (Date.now() - startTime > this.config.collectionTimeoutMs) {
          this.phase = "FAILED";
          return false;
        }
        const rawFiles = output[contract.field];
        if (rawFiles === undefined) continue;
        if (!Array.isArray(rawFiles)) {
          await this.callbacks.onError?.(
            new Error(`Approved output ${contract.key} is not a file array`),
            "output_contract_error",
          );
          return false;
        }
        if (rawFiles.length > contract.maxItems) {
          await this.callbacks.onError?.(
            new Error(`Approved output ${contract.key} exceeded its ${contract.maxItems}-item limit`),
            "output_limit_exceeded",
          );
          return false;
        }

        for (const rawFile of rawFiles) {
          if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) {
            await this.callbacks.onError?.(new Error(`Approved output ${contract.key} contains an invalid file descriptor`), "output_contract_error");
            return false;
          }
          const record = rawFile as Record<string, unknown>;
          const file = {
            filename: typeof record.filename === "string" ? record.filename : "",
            subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
            type: typeof record.type === "string" ? record.type : "",
          };
          if (!file.filename || !file.type) {
            await this.callbacks.onError?.(new Error(`Approved output ${contract.key} contains an incomplete file descriptor`), "output_contract_error");
            return false;
          }
          collectedOutputCount += 1;
          if (collectedOutputCount > this.config.maxOutputs) {
            await this.callbacks.onError?.(
              new Error(`Workflow produced more than ${this.config.maxOutputs} outputs`),
              "output_limit_exceeded",
            );
            return false;
          }
          try {
            if (!this.callbacks.onOutputStream) {
              throw new Error("A streaming output consumer is required");
            }
            const response = await this.transport.getFile(file);
            if (!response.ok || !response.body) {
              throw new Error(`Output download failed (${response.status})`);
            }
            await this.callbacks.onOutputStream({
              nodeId: contract.nodeId, outputKey: contract.key, field: contract.field, mediaKind: contract.mediaKind,
              filename: file.filename, subfolder: file.subfolder, type: file.type, response,
            });
          } catch (error) {
            if (error instanceof ExecutionCallbackPersistenceError) throw error;
            const failure = error instanceof Error ? error : new Error(String(error));
            await this.callbacks.onError?.(failure, "collection_error");
            return false;
          }
        }
      }

      if (collectedOutputCount === 0) {
        await this.callbacks.onError?.(new Error("Workflow completed without an approved output"), "output_contract_error");
        return false;
      }
      this.outputCollected = true;
      return true;
    } catch (err) {
      if (err instanceof ExecutionCallbackPersistenceError) throw err;
      const error = err instanceof Error ? err : new Error(String(err));
      await this.callbacks.onError?.(error, "collection_error");
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
          void this.callbacks.onProgress?.({
            node: msg.data.node,
            value: msg.data.value,
            max: msg.data.max,
            percent: msg.data.max > 0 ? (msg.data.value / msg.data.max) * 100 : 0,
          });
        }
        if (msg.type === "execution_start") {
          void this.setPhase("EXTERNAL_RUNNING");
        }
        if (msg.type === "execution_error") {
          this.phase = "FAILED";
        }
        void snapshot;
      },
    );
  }

  private async resolveCancellationOutcome(): Promise<CancellationOutcome> {
    if (!this.cancelRequested) return { outcome: "pending" };
    if (!this.externalJobId) return { outcome: "unknown" };

    try {
      const history = await probeHistory(this.transport, this.externalJobId);
      const result = history[this.externalJobId];
      const terminal = this.classifyCancellationHistory(result);
      if (terminal) return terminal;
    } catch {
      // Fall through to queue evidence.
    }

    try {
      const queue = await probeQueueStatus(this.transport);
      const ids = [...queue.queueRunning, ...queue.queuePending].map((entry) => entry.promptId);
      if (ids.includes(this.externalJobId)) return { outcome: "pending" };
      const history = await probeHistory(this.transport, this.externalJobId);
      const terminal = this.classifyCancellationHistory(history[this.externalJobId]);
      if (terminal) return terminal;
    } catch {
      // Absence of evidence is not evidence of cancellation.
    }
    return { outcome: "unknown" };
  }

  private classifyCancellationHistory(result: ComfyExecutionResult | undefined): CancellationOutcome | null {
    const historyOutcome = classifyComfyHistory(result);
    if (historyOutcome === "cancelled") {
      return {
        outcome: "confirmed-cancelled",
        evidence: {
          outcome: "confirmed-cancelled",
          source: "history-terminal-cancelled",
          externalJobId: this.externalJobId!,
          method: this.cancellationResult?.method ?? "none",
          observedAtMs: Date.now(),
        },
      };
    }

    if (historyOutcome === "failed") return { outcome: "failed" };
    if (historyOutcome === "completed") return { outcome: "completed" };
    return null;
  }

  private async confirmCancellation(
    cancellation: Extract<CancellationOutcome, { outcome: "confirmed-cancelled" }>,
  ): Promise<void> {
    await this.callbacks.onCancellationConfirmed?.(cancellation.evidence);
    this.phase = "CANCELLED";
  }

  private async refreshCancellationState(): Promise<boolean> {
    if (!this.cancelRequested && (await this.callbacks.isCancellationRequested?.())) {
      this.cancelRequested = true;
    }
    if (this.cancelRequested && !this.cancellationDispatched) await this.requestCancel();
    return this.cancelRequested;
  }

  private async sleepCancellable(ms: number, interruptOnCancellation = true): Promise<void> {
    if (!interruptOnCancellation) {
      await this.refreshCancellationState();
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }
    const interval = 100;
    const steps = Math.ceil(ms / interval);
    for (let i = 0; i < steps && !this.stopped; i++) {
      const cancellationWasRequested = this.cancelRequested;
      const cancellationRequested = await this.refreshCancellationState();
      if (cancellationRequested && !cancellationWasRequested && interruptOnCancellation) break;
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
      needsAttention:
        (this.phase === "FAILED" && (this.reconciliationCount > 0 || this.cancelRequested))
        || (this.stopped && Boolean(this.externalJobId) && this.phase !== "SUCCEEDED" && this.phase !== "CANCELLED"),
      outputs: this.outputCollected ? [] : undefined,
    };
  }
}
