/**
 * PR-11: ComfyUI 执行编排器假后端集成测试
 *
 * 使用 FakeComfyUITransport 验证完整执行闭环、
 * 提交不确定（SUBMISSION_UNKNOWN）与对账、以及取消路径。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ComfyUIExecutionOrchestrator,
  ExecutionCallbackPersistenceError,
} from "../comfyui-execution-orchestrator";
import { connectionManagerRegistry } from "../comfyui-connection-manager";
import {
  FakeComfyUITransport,
  defaultBackendFeatures,
  installFakeWebSocket,
} from "@/lib/test-helpers/fake-comfyui";
import type { ExecutionConfig } from "../comfyui-execution-orchestrator";

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
  0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const pngArrayBuffer = new Uint8Array(pngBytes).buffer;

const workflow = {
  nodes: [{ class_type: "KSampler", inputs: {} }],
  outputs: [{ name: "preview" }],
};

function fastConfig(): Partial<ExecutionConfig> {
  return {
    submitTimeoutMs: 1_000,
    queuedPollIntervalMs: 50,
    runningPollIntervalMs: 50,
    totalExecutionTimeoutMs: 5_000,
    collectionTimeoutMs: 5_000,
    reconciliationGraceMs: 10,
    reconciliationIntervalMs: 50,
    maxReconciliationAttempts: 3,
    approvedOutputs: [{ key: "primary", nodeId: "node-1", field: "images", mediaKind: "image", maxItems: 1 }],
    maxOutputs: 1,
  };
}

function makeCompletedHistory(promptId: string) {
  return {
    [promptId]: {
      promptId,
      outputs: {
        "node-1": {
          images: [{ filename: "preview.png", subfolder: "", type: "output" }],
        },
      },
      status: { statusStr: "success", completed: true },
    },
  };
}

function makeTerminalHistory(
  promptId: string,
  statusStr: string,
  completed: boolean,
  messageType?: string,
) {
  return {
    [promptId]: {
      promptId,
      outputs: {},
      status: {
        statusStr,
        completed,
        messages: messageType ? [[messageType, {}] as [string, Record<string, unknown>]] : [],
      },
    },
  };
}

function makeCorrelationTerminalTransport(promptId: string, correlationId: string) {
  class CorrelationTerminalTransport extends FakeComfyUITransport {
    private queueProbes = 0;

    override async get(path: string): Promise<Response> {
      if (path === "/queue") {
        this.queueProbes++;
        this.scenario.queueRunning = this.queueProbes === 1
          ? [{ prompt_id: promptId, correlation_id: correlationId }]
          : [];
      }
      return super.get(path);
    }
  }

  return new CorrelationTerminalTransport({
    submitError: new Error("timeout"),
    promptId,
    queueRunning: [{ prompt_id: promptId, correlation_id: correlationId }],
    history: makeTerminalHistory(promptId, "error", false, "execution_interrupted"),
  });
}

describe("PR-11: 编排器假后端集成", () => {
  let restoreWebSocket: (() => void) | null = null;

  beforeEach(() => {
    restoreWebSocket = installFakeWebSocket();
  });

  afterEach(() => {
    restoreWebSocket?.();
    connectionManagerRegistry.closeAll();
  });

  it("成功闭环：提交 → 运行 → 完成 → 收集输出", async () => {
    const promptId = "closed-loop-ok";
    const transport = new FakeComfyUITransport({
      promptId,
      queueRunning: [{ prompt_id: promptId }],
      history: makeCompletedHistory(promptId),
      fileBytes: pngArrayBuffer,
    });

    const outputs: ArrayBuffer[] = [];
    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        onOutputStream: async (output) => {
          outputs.push(await output.response.arrayBuffer());
        },
      },
      fastConfig(),
    );

    const result = await orchestrator.execute(workflow);

    expect(result.success).toBe(true);
    expect(result.phase).toBe("SUCCEEDED");
    expect(result.externalJobId).toBe(promptId);
    expect(outputs).toHaveLength(1);
  });

  it("propagates durable callback failures instead of classifying them as execution errors", async () => {
    const transport = new FakeComfyUITransport({ promptId: "callback-failure" });
    const injected = new Error("database write failed");
    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        onPhaseChange: () => { throw new ExecutionCallbackPersistenceError(injected); },
      },
      fastConfig(),
    );

    await expect(orchestrator.execute(workflow)).rejects.toMatchObject({ cause: injected });
  });

  it("提交响应丢失后应对账发现任务正在运行并完成", async () => {
    const promptId = "sub-unknown-running";
    const correlationId = "corr-sub-unknown-running";
    const transport = new FakeComfyUITransport({
      submitError: new Error("timeout"),
      promptId,
      queueRunning: [{ prompt_id: promptId, correlation_id: correlationId }],
      history: makeCompletedHistory(promptId),
      fileBytes: pngArrayBuffer,
    });

    const reconciliations: string[] = [];
    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        onReconciliation: (r) => { reconciliations.push(r.evidenceStrength); },
        onOutputStream: async (output) => { await output.response.arrayBuffer(); },
      },
      fastConfig(),
      correlationId,
    );

    const result = await orchestrator.execute(workflow);

    expect(result.success).toBe(true);
    expect(result.phase).toBe("SUCCEEDED");
    expect(result.externalJobId).toBe(promptId);
    expect(reconciliations.length).toBeGreaterThan(0);
    expect(reconciliations[0]).toBe("conclusive");
  });

  it("提交丢失且始终无证据时应升级人工处理", async () => {
    const promptId = "sub-unknown-escalate";
    const transport = new FakeComfyUITransport({
      submitError: new Error("timeout"),
      promptId,
      history: {},
      queueRunning: [],
      queuePending: [],
    });

    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      defaultBackendFeatures(),
      "http://localhost:8188",
      {},
      {
        ...fastConfig(),
        maxReconciliationAttempts: 1,
      },
    );

    const result = await orchestrator.execute(workflow);

    expect(result.success).toBe(false);
    expect(result.phase).toBe("FAILED");
    expect(result.needsAttention).toBe(true);
  });


  it("取消与完成竞态中已完成输出应优先提交", async () => {
    const promptId = "cancel-race-completed";
    const transport = new FakeComfyUITransport({
      promptId,
      queueRunning: [{ prompt_id: promptId }],
      history: makeCompletedHistory(promptId),
      fileBytes: pngArrayBuffer,
    });
    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        onPhaseChange: (phase) => { if (phase === "EXTERNAL_RUNNING") void orchestrator.requestCancel(); },
        onOutputStream: async (output) => { await output.response.arrayBuffer(); },
      },
      fastConfig(),
    );
    const result = await orchestrator.execute(workflow);
    expect(result.phase).toBe("SUCCEEDED");
    expect(result.cancellationRequested).toBe(true);
  });

  it("escalates when cancellation termination remains unconfirmed", async () => {
    const promptId = "cancel-during-run";
    const transport = new FakeComfyUITransport({
      promptId,
      queueRunning: [{ prompt_id: promptId }],
      history: {},
      fileBytes: pngArrayBuffer,
    });

    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        onPhaseChange: (phase) => {
          if (phase === "EXTERNAL_RUNNING") {
            void orchestrator.requestCancel();
          }
        },
      },
      { ...fastConfig(), totalExecutionTimeoutMs: 200 },
    );

    const result = await orchestrator.execute(workflow);

    expect(result.phase).toBe("FAILED");
    expect(result.needsAttention).toBe(true);
    expect(result.cancellationRequested).toBe(true);
  });

  it("confirms a correlated interrupted history only in cancellation context", async () => {
    const promptId = "correlated-interrupted-cancel";
    const correlationId = "corr-interrupted-cancel";
    const confirmations: string[] = [];
    const reconciliationOutcomes: Array<string | undefined> = [];
    const orchestrator = new ComfyUIExecutionOrchestrator(
      makeCorrelationTerminalTransport(promptId, correlationId),
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        isCancellationRequested: () => true,
        onCancellationConfirmed: (evidence) => { confirmations.push(evidence.externalJobId); },
        onReconciliation: (result) => { reconciliationOutcomes.push(result.historyOutcome); },
      },
      fastConfig(),
      correlationId,
    );

    const result = await orchestrator.execute(workflow);

    expect(result.phase).toBe("CANCELLED");
    expect(result.externalJobId).toBe(promptId);
    expect(confirmations).toEqual([promptId]);
    expect(reconciliationOutcomes).toEqual(["cancelled"]);
  });

  it("treats a correlated interrupted history as failure without cancellation context", async () => {
    const promptId = "correlated-interrupted-no-cancel";
    const correlationId = "corr-interrupted-no-cancel";
    const confirmations: string[] = [];
    const reconciliationOutcomes: Array<string | undefined> = [];
    const orchestrator = new ComfyUIExecutionOrchestrator(
      makeCorrelationTerminalTransport(promptId, correlationId),
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        onCancellationConfirmed: (evidence) => { confirmations.push(evidence.externalJobId); },
        onReconciliation: (result) => { reconciliationOutcomes.push(result.historyOutcome); },
      },
      fastConfig(),
      correlationId,
    );

    const result = await orchestrator.execute(workflow);

    expect(result.phase).toBe("FAILED");
    expect(result.needsAttention).toBe(true);
    expect(result.externalJobId).toBe(promptId);
    expect(confirmations).toEqual([]);
    expect(reconciliationOutcomes).toEqual(["cancelled"]);
  });

  it("confirms cancellation only from an explicit cancelled history terminal", async () => {
    const promptId = "cancel-history-terminal";
    const confirmations: string[] = [];
    const transport = new FakeComfyUITransport({
      promptId,
      queueRunning: [{ prompt_id: promptId }],
      history: makeTerminalHistory(promptId, "error", false, "execution_interrupted"),
    });
    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        onPhaseChange: (phase) => {
          if (phase === "EXTERNAL_RUNNING") void orchestrator.requestCancel();
        },
        onCancellationConfirmed: (evidence) => { confirmations.push(evidence.source); },
      },
      { ...fastConfig(), totalExecutionTimeoutMs: 200 },
    );

    const result = await orchestrator.execute(workflow);

    expect(result.phase).toBe("CANCELLED");
    expect(confirmations).toEqual(["history-terminal-cancelled"]);
  });

  it("classifies an ordinary failed history terminal as failure, not cancellation", async () => {
    const promptId = "cancel-race-failed";
    const confirmations: string[] = [];
    let historyProbes = 0;
    class CountingTransport extends FakeComfyUITransport {
      override async get(path: string): Promise<Response> {
        if (path === `/history/${promptId}`) historyProbes++;
        return super.get(path);
      }
    }
    const transport = new CountingTransport({
      promptId,
      queueRunning: [{ prompt_id: promptId }],
      history: makeTerminalHistory(promptId, "error", false, "execution_error"),
    });
    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        onCancellationConfirmed: (evidence) => { confirmations.push(evidence.source); },
      },
      { ...fastConfig(), totalExecutionTimeoutMs: 200 },
    );

    const result = await orchestrator.execute(workflow);

    expect(result.phase).toBe("FAILED");
    expect(result.needsAttention).toBe(false);
    expect(confirmations).toEqual([]);
    expect(historyProbes).toBe(1);
  });

  it("does not confirm contradictory success plus interruption history", async () => {
    const promptId = "cancel-race-contradictory";
    const confirmations: string[] = [];
    const transport = new FakeComfyUITransport({
      promptId,
      queueRunning: [{ prompt_id: promptId }],
      history: makeTerminalHistory(promptId, "success", true, "execution_interrupted"),
    });
    const orchestrator = new ComfyUIExecutionOrchestrator(
      transport,
      defaultBackendFeatures(),
      "http://localhost:8188",
      {
        onPhaseChange: (phase) => {
          if (phase === "EXTERNAL_RUNNING") void orchestrator.requestCancel();
        },
        onCancellationConfirmed: (evidence) => { confirmations.push(evidence.source); },
      },
      { ...fastConfig(), totalExecutionTimeoutMs: 200 },
    );

    const result = await orchestrator.execute(workflow);

    expect(result.phase).toBe("FAILED");
    expect(result.needsAttention).toBe(true);
    expect(confirmations).toEqual([]);
  });
});
