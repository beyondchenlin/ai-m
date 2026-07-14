/**
 * PR-11: Worker 进程优雅关闭与信号处理测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isEnabledMock = vi.fn();

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: (...args: unknown[]) => isEnabledMock(...args),
  FF: { V2_DURABLE_EXECUTION: "V2_DURABLE_EXECUTION", V2_COMFYUI_TRANSPORT: "V2_COMFYUI_TRANSPORT" },
}));

vi.mock("@/lib/db", () => ({
  db: {
    delete: vi.fn(() => ({ where: vi.fn() })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => []) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    insert: vi.fn(() => ({ values: vi.fn() })),
  },
}));

vi.mock("@/lib/generation/resources/leases", () => ({
  claimJob: vi.fn(() => Promise.resolve(null)),
  renewJobClaim: vi.fn(() => Promise.resolve(true)),
  releaseJobClaim: vi.fn(() => Promise.resolve(true)),
  scanExpiredClaims: vi.fn(() => Promise.resolve({
    requeuedJobs: [], attentionJobs: [], cancelledJobs: [], releasedSlots: [],
  })),
  LEASE_CONFIG: {
    CLAIM_LEASE_MS: 30_000,
    RESOURCE_LEASE_MS: 120_000,
    HEARTBEAT_INTERVAL_MS: 10_000,
    GRACE_PERIOD_MS: 5_000,
  },
}));

vi.mock("@/lib/generation/worker-executor", () => ({
  executeGenerationJob: vi.fn(() => Promise.resolve({ success: true, finalPhase: "SUCCEEDED" })),
}));

describe("PR-11: Worker 信号处理", () => {
  beforeEach(() => {
    isEnabledMock.mockImplementation((flag: unknown) => flag === "V2_DURABLE_EXECUTION");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("收到 SIGINT 应调用 process.exit", async () => {
    // 动态导入 worker，触发监听器注册
    await import("../index");

    // 等待 mainLoop 进入轮询
    await new Promise((r) => setTimeout(r, 50));

    process.emit("SIGINT");

    // 等待 gracefulShutdown 中的异步清理
    await new Promise((r) => setTimeout(r, 100));

    expect(process.exitCode).toBe(0);
  });

  it("收到 SIGTERM 应调用 process.exit", async () => {
    await import("../index");
    await new Promise((r) => setTimeout(r, 50));

    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));

    expect(process.exitCode).toBe(0);
  });
});
