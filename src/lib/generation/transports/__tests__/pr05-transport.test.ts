/**
 * PR-05 传输层模块单元测试
 *
 * 使用 tsx 直接运行，不依赖测试框架。
 * 覆盖：连接管理器、取消策略、对账机制、错误分类等纯逻辑模块。
 */

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

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

async function runAllTests(): Promise<void> {
  console.log("\n=== ComfyUI Connection Manager Tests ===");

{
  const mgr = new ComfyUIConnectionManager("http://localhost:8188", "test-client");
  assert(mgr.getState() === "disconnected", "initial state is disconnected");
  assert(mgr.getGeneration() === 0, "initial generation is 0");

  let stateChanges = 0;
  mgr.addListener((e) => {
    if (e.type === "state_change") stateChanges++;
  });

  const unregister = mgr.registerTaskHandler("test-prompt-1", () => {});
  assert(typeof unregister === "function", "registerTaskHandler returns cleanup function");

  const snap = mgr.getProgressSnapshot("test-prompt-1");
  assert(snap !== undefined, "progress snapshot created for registered task");
  assert(snap?.promptId === "test-prompt-1", "snapshot has correct promptId");
  assert(snap?.status === "queued", "initial status is queued");

  mgr.clearTaskSnapshot("test-prompt-1");
  assert(mgr.getProgressSnapshot("test-prompt-1") === undefined, "snapshot cleared after cleanup");

  mgr.disconnect();
  assert(mgr.getState() === "disconnected", "state is disconnected after disconnect");
  assert(mgr.getGeneration() === 1, "generation increments on disconnect");
}

console.log("\n=== Cancellation Policy Tests ===");

{
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

  const result1 = await safeCancelJob(mockTransport, sharedFeatures, "test-id", {
    isShared: true,
  });
  assert(result1.method === "per-task", "shared backend uses per-task cancel");
  assert(result1.requested === true, "per-task cancel requested");
  assert(result1.needsReconciliation === true, "cancel needs reconciliation");

  const dedicatedFeatures: BackendFeatureSnapshot = {
    ...sharedFeatures,
    cancellation: {
      supportsPerTaskCancel: false,
      hasGlobalInterrupt: true,
      safeForShared: false,
    },
  };

  const result2 = await safeCancelJob(mockTransport, dedicatedFeatures, "test-id", {
    isShared: false,
  });
  assert(result2.method !== "none", "dedicated backend without per-task cancel tries global interrupt");

  const sharedNoPerTask: BackendFeatureSnapshot = {
    ...sharedFeatures,
    cancellation: {
      supportsPerTaskCancel: false,
      hasGlobalInterrupt: true,
      safeForShared: false,
    },
  };

  const result3 = await safeCancelJob(mockTransport, sharedNoPerTask, "test-id", {
    isShared: true,
  });
  assert(result3.method === "none", "shared backend without per-task cancel is blocked");
  assert(result3.requested === false, "shared backend cancel not requested");

  assert(
    resolveCancelCompletionRace(true, 1000, 2000) === "completed",
    "has artifacts -> completed wins",
  );
  assert(
    resolveCancelCompletionRace(false, 1000, 2000) === "cancelled",
    "no artifacts + cancel first -> cancelled",
  );
  assert(
    resolveCancelCompletionRace(false, 3000, 2000) === "completed",
    "no artifacts + complete first -> completed",
  );

  const netErr = new Error("Network error: ECONNREFUSED");
  const netClass = classifyCancellationError(netErr);
  assert(netClass.retryable === true, "network error is retryable");

  const notFoundErr = new Error("Failed with status 404");
  const nfClass = classifyCancellationError(notFoundErr);
  assert(nfClass.retryable === false, "404 error is not retryable");
  assert(nfClass.errorClass === "not_found", "404 error class is not_found");
}

console.log("\n=== Reconciliation Logic Tests ===");

{
  const now = Date.now();

  assert(
    shouldEscalateToAttention(now - 1000, 2, "weak", { attentionAfterMs: 60000 }) === false,
    "early reconciliation does not escalate",
  );
  assert(
    shouldEscalateToAttention(now - 600_000, 5, "weak", { attentionAfterMs: 300_000 }) === true,
    "long-running weak evidence escalates to attention",
  );
  assert(
    shouldEscalateToAttention(now - 600_000, 5, "conclusive", { attentionAfterMs: 300_000 }) === false,
    "conclusive evidence does not escalate",
  );
  assert(
    shouldEscalateToAttention(now - 1000, 20, "moderate", { maxAttempts: 10 }) === true,
    "exceeding max attempts escalates",
  );

  const delay1 = nextReconciliationDelay(1, { intervalMs: 30_000 });
  const delay5 = nextReconciliationDelay(5, { intervalMs: 30_000 });
  assert(delay1 >= 30_000 && delay1 <= 70_000, "first delay in expected range with backoff and jitter");
  assert(delay5 > delay1, "delay increases with attempts (backoff)");

  const clientErr = new Error("Submission failed (400): bad request");
  const clientClass = classifySubmissionError(clientErr);
  assert(clientClass.retryable === false, "4xx error is not retryable");
  assert(clientClass.retryScope === "none", "4xx error scope is none");

  const serverErr = new Error("Submission failed (503): service unavailable");
  const serverClass = classifySubmissionError(serverErr);
  assert(serverClass.retryable === true, "5xx error is retryable");
  assert(serverClass.retryScope === "submission_only", "5xx error scope is submission_only");

  const wfErr = new Error("ComfyUI workflow validation errors");
  const wfClass = classifySubmissionError(wfErr);
  assert(wfClass.retryable === false, "workflow error is not retryable");
  assert(wfClass.errorClass === "workflow_error", "workflow error class correct");
}

console.log("\n=== Behavior Probe Tests ===");

{
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
  assert(isProbeFresh(fresh) === true, "recent probe is fresh");

  const expired: BackendFeatureSnapshot = {
    ...fresh,
    probedAtMs: Date.now() - 7200_000,
    validUntilMs: Date.now() - 3600_000,
  };
  assert(isProbeFresh(expired) === false, "expired probe is not fresh");
}

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
