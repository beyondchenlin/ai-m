/**
 * PR-05 传输层模块单元测试
 *
 * 覆盖：连接管理器、取消策略、对账机制、错误分类等纯逻辑模块。
 */

import { describe, it, expect } from "vitest";
import { ComfyUIConnectionManager } from "@/lib/generation/transports/comfyui-connection-manager";
import {
  safeCancelJob,
  resolveCancelCompletionRace,
  classifyCancellationError,
} from "@/lib/generation/transports/comfyui-cancellation";
import {
  shouldEscalateToAttention,
  nextReconciliationDelay,
  classifySubmissionError,
} from "@/lib/generation/transports/comfyui-reconciliation";
import { isProbeFresh } from "@/lib/generation/transports/comfyui-behavior-probe";
import type { BackendFeatureSnapshot } from "@/lib/generation/transports/comfyui-behavior-probe";

describe("PR-05: ComfyUI 连接管理器", () => {
  it("初始状态为 disconnected 且 generation 为 0", () => {
    const mgr = new ComfyUIConnectionManager("http://localhost:8188", "test-client");
    expect(mgr.getState()).toBe("disconnected");
    expect(mgr.getGeneration()).toBe(0);
  });

  it("registerTaskHandler 返回清理函数并创建进度快照", () => {
    const mgr = new ComfyUIConnectionManager("http://localhost:8188", "test-client");
    const unregister = mgr.registerTaskHandler("test-prompt-1", () => {});
    expect(typeof unregister).toBe("function");

    const snap = mgr.getProgressSnapshot("test-prompt-1");
    expect(snap).toBeDefined();
    expect(snap?.promptId).toBe("test-prompt-1");
    expect(snap?.status).toBe("queued");

    mgr.clearTaskSnapshot("test-prompt-1");
    expect(mgr.getProgressSnapshot("test-prompt-1")).toBeUndefined();
  });

  it("disconnect 后状态为 disconnected 且 generation 递增", () => {
    const mgr = new ComfyUIConnectionManager("http://localhost:8188", "test-client");
    mgr.disconnect();
    expect(mgr.getState()).toBe("disconnected");
    expect(mgr.getGeneration()).toBe(1);
  });
});

describe("PR-05: 取消策略", () => {
  const mockTransport = {
    post: async (_path: string, _body: unknown) => new Response("{}", { status: 200 }),
    getFile: async () => new Response(),
    connectWebSocket: () => new WebSocket("ws://localhost"),
    cancel: async () => {},
    interrupt: async () => {},
    close: () => {},
  };

  const sharedFeatures: BackendFeatureSnapshot = {
    environmentFingerprint: "env:test123",
    externalIdStrategy: "server-assigned",
    cancellation: {
      supportsPerTaskCancel: true,
      hasGlobalInterrupt: true,
      safeForShared: true,
    },
    output: {
      readMethod: "view",
      supportsStreaming: false,
      maxOutputSizeBytesEstimate: 100 * 1024 * 1024,
    },
    nodeCategories: [],
    devicesSummary: [],
    probedAtMs: Date.now(),
    validUntilMs: Date.now() + 3600_000,
  };

  it("共享后端优先使用按任务取消", async () => {
    const result = await safeCancelJob(mockTransport, sharedFeatures, "test-id", { isShared: true });
    expect(result.method).toBe("per-task");
    expect(result.requested).toBe(true);
    expect(result.needsReconciliation).toBe(true);
  });

  it("专用后端无按任务取消时尝试全局中断", async () => {
    const dedicatedFeatures: BackendFeatureSnapshot = {
      ...sharedFeatures,
      cancellation: {
        supportsPerTaskCancel: false,
        hasGlobalInterrupt: true,
        safeForShared: false,
      },
    };
    const result = await safeCancelJob(mockTransport, dedicatedFeatures, "test-id", { isShared: false });
    expect(result.method).not.toBe("none");
  });

  it("共享后端无按任务取消时禁止取消", async () => {
    const sharedNoPerTask: BackendFeatureSnapshot = {
      ...sharedFeatures,
      cancellation: {
        supportsPerTaskCancel: false,
        hasGlobalInterrupt: true,
        safeForShared: false,
      },
    };
    const result = await safeCancelJob(mockTransport, sharedNoPerTask, "test-id", { isShared: true });
    expect(result.method).toBe("none");
    expect(result.requested).toBe(false);
  });

  it("取消与完成竞态按规则裁决", () => {
    expect(resolveCancelCompletionRace(true, 1000, 2000)).toBe("completed");
    expect(resolveCancelCompletionRace(false, 1000, 2000)).toBe("cancelled");
    expect(resolveCancelCompletionRace(false, 3000, 2000)).toBe("completed");
  });

  it("取消错误分类正确", () => {
    const netErr = new Error("Network error: ECONNREFUSED");
    expect(classifyCancellationError(netErr)).toEqual({ retryable: true, errorClass: "transient_network" });

    const notFoundErr = new Error("Failed with status 404");
    expect(classifyCancellationError(notFoundErr)).toEqual({ retryable: false, errorClass: "not_found" });
  });
});

describe("PR-05: 对账逻辑", () => {
  it("证据强度不足时不升级，强证据时不升级", () => {
    const now = Date.now();
    expect(shouldEscalateToAttention(now - 1000, 2, "weak", { attentionAfterMs: 60000 })).toBe(false);
    expect(shouldEscalateToAttention(now - 600_000, 5, "weak", { attentionAfterMs: 300_000 })).toBe(true);
    expect(shouldEscalateToAttention(now - 600_000, 5, "conclusive", { attentionAfterMs: 300_000 })).toBe(false);
    expect(shouldEscalateToAttention(now - 1000, 20, "moderate", { maxAttempts: 10 })).toBe(true);
  });

  it("下次对账延迟随尝试次数递增", () => {
    const delay1 = nextReconciliationDelay(1, { intervalMs: 30_000 });
    const delay5 = nextReconciliationDelay(5, { intervalMs: 30_000 });
    expect(delay1).toBeGreaterThanOrEqual(30_000);
    expect(delay5).toBeGreaterThan(delay1);
  });

  it("提交错误分类正确", () => {
    const clientErr = new Error("Submission failed (400): bad request");
    expect(classifySubmissionError(clientErr)).toEqual({ errorClass: "client_error", retryable: false, retryScope: "none" });

    const serverErr = new Error("Submission failed (503): service unavailable");
    expect(classifySubmissionError(serverErr)).toEqual({ errorClass: "server_error", retryable: true, retryScope: "submission_only" });

    const wfErr = new Error("ComfyUI workflow validation errors");
    expect(classifySubmissionError(wfErr)).toEqual({ errorClass: "workflow_error", retryable: false, retryScope: "none" });
  });
});

describe("PR-05: 行为探测", () => {
  it("探测结果有效期判断正确", () => {
    const fresh: BackendFeatureSnapshot = {
      environmentFingerprint: "env:test",
      externalIdStrategy: "server-assigned",
      cancellation: { supportsPerTaskCancel: false, hasGlobalInterrupt: false, safeForShared: false },
      output: { readMethod: "view", supportsStreaming: false, maxOutputSizeBytesEstimate: 0 },
      nodeCategories: [],
      devicesSummary: [],
      probedAtMs: Date.now() - 1000,
      validUntilMs: Date.now() + 3600_000,
    };
    expect(isProbeFresh(fresh)).toBe(true);

    const expired: BackendFeatureSnapshot = {
      ...fresh,
      probedAtMs: Date.now() - 7200_000,
      validUntilMs: Date.now() - 3600_000,
    };
    expect(isProbeFresh(expired)).toBe(false);
  });
});
