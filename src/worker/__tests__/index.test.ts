/**
 * PR-11: Worker 进程优雅关闭与信号处理测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { settleClaimedJob } from "../claim-settlement";
import { JobRuntimeBoundary } from "../job-runtime-boundary";
import type { JobExecutionResult } from "@/lib/generation/jobs/worker-finalization";

const isEnabledMock = vi.fn();
const closeAllConnectionsMock = vi.fn();
const parseManagedConfigMock = vi.fn((env: Record<string, string | undefined>) => {
  void env;
  return { enabled: false as const };
});

vi.mock("@/lib/generation/runtime/managed-comfyui-runtime", () => ({
  parseManagedComfyUIRuntimeConfig: (env: Record<string, string | undefined>) => parseManagedConfigMock(env),
  ManagedComfyUIRuntime: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: (...args: unknown[]) => isEnabledMock(...args),
  FF: { V2_DURABLE_EXECUTION: "V2_DURABLE_EXECUTION", V2_COMFYUI_TRANSPORT: "V2_COMFYUI_TRANSPORT" },
}));

vi.mock("@/lib/db", () => ({
  waitForCurrentMigrationBundle: vi.fn(() => Promise.resolve()),
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
    requeuedJobs: [], attentionJobs: [], cancelledJobs: [], releasedSlots: [], outcomes: [],
  })),
  LEASE_CONFIG: {
    CLAIM_LEASE_MS: 30_000,
    RESOURCE_LEASE_MS: 120_000,
    HEARTBEAT_INTERVAL_MS: 10_000,
    GRACE_PERIOD_MS: 5_000,
  },
}));

vi.mock("@/lib/generation/worker-executor", () => ({
  executeGenerationJob: vi.fn(() => Promise.resolve({
    success: true,
    finalPhase: "SUCCEEDED",
    needsAttention: false,
    claimDisposition: "release-terminal",
  })),
}));

vi.mock("@/lib/generation/archiving", () => ({
  parseLegacyArtifactRecoveryBeforeMs: vi.fn(() => undefined),
  recoverStagingArtifacts: vi.fn(() => Promise.resolve({ claimed: 0, committed: 0, quarantined: 0 })),
}));
vi.mock("@/lib/generation/input-materializer", () => ({ cleanupTerminalSharedInputs: vi.fn(() => Promise.resolve(0)) }));
vi.mock("@/lib/generation/source-assets", () => ({
  recoverSourceMediaAssets: vi.fn(() => Promise.resolve({ committed: 0, quarantined: 0 })),
  cleanupSourceAssetStorage: vi.fn(() => Promise.resolve({ deletedFiles: 0, orphanStagingFiles: 0, abandonedAssets: 0 })),
}));
vi.mock("@/lib/generation/business-adapter", () => ({
  reconcileBusinessArtifactProjections: vi.fn(() => Promise.resolve({ projected: 0, failed: 0 })),
}));
vi.mock("@/lib/generation/transports/comfyui-connection-manager", () => ({
  connectionManagerRegistry: { closeAll: closeAllConnectionsMock },
}));

describe("PR-11: Worker 信号处理", () => {
  beforeEach(() => {
    isEnabledMock.mockImplementation((flag: unknown) => flag === "V2_DURABLE_EXECUTION");
  });

  afterEach(() => {
    isEnabledMock.mockClear();
    closeAllConnectionsMock.mockClear();
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
    expect(closeAllConnectionsMock).toHaveBeenCalledOnce();
  });

  it("收到 SIGTERM 应调用 process.exit", async () => {
    await import("../index");
    await new Promise((r) => setTimeout(r, 50));

    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));

    expect(process.exitCode).toBe(0);
  });
});

describe("managed single-endpoint worker startup", () => {
  it("parses managed runtime configuration exactly once per worker module", async () => {
    await import("../index");
    expect(parseManagedConfigMock).toHaveBeenCalledOnce();
    expect(parseManagedConfigMock).toHaveBeenCalledWith(process.env);
  });

  it("allows multiple enabled rows only for one physical endpoint and one capacity-one pool", async () => {
    const { validateManagedWorkerBackendConfiguration } = await import("../index");
    expect(() => validateManagedWorkerBackendConfiguration(
      "http://127.0.0.1:8000",
      [
        { id: "image", adapterKind: "comfyui", baseUrl: "http://127.0.0.1:8000", resourcePoolId: "gpu", enabled: true },
        { id: "speech", adapterKind: "comfyui", baseUrl: "http://127.0.0.1:8000", resourcePoolId: "gpu", enabled: true },
      ],
      [{ id: "gpu", capacity: 1 }],
    )).not.toThrow();
  });

  it.each([
    {
      name: "no enabled canonical backend",
      backends: [{ id: "off", adapterKind: "comfyui", baseUrl: "http://127.0.0.1:8000", resourcePoolId: "gpu", enabled: false }],
      pools: [{ id: "gpu", capacity: 1 }],
    },
    {
      name: "an additional enabled ComfyUI endpoint",
      backends: [
        { id: "managed", adapterKind: "comfyui", baseUrl: "http://127.0.0.1:8000", resourcePoolId: "gpu", enabled: true },
        { id: "other", adapterKind: "comfyui", baseUrl: "http://127.0.0.1:8001", resourcePoolId: "gpu", enabled: true },
      ],
      pools: [{ id: "gpu", capacity: 1 }],
    },
    {
      name: "canonical rows assigned to different pools",
      backends: [
        { id: "image", adapterKind: "comfyui", baseUrl: "http://127.0.0.1:8000", resourcePoolId: "gpu-a", enabled: true },
        { id: "speech", adapterKind: "comfyui", baseUrl: "http://127.0.0.1:8000", resourcePoolId: "gpu-b", enabled: true },
      ],
      pools: [{ id: "gpu-a", capacity: 1 }, { id: "gpu-b", capacity: 1 }],
    },
    {
      name: "a pool capacity other than one",
      backends: [{ id: "managed", adapterKind: "comfyui", baseUrl: "http://127.0.0.1:8000", resourcePoolId: "gpu", enabled: true }],
      pools: [{ id: "gpu", capacity: 2 }],
    },
  ])("fails closed for $name", async ({ backends, pools }) => {
    const { validateManagedWorkerBackendConfiguration } = await import("../index");
    expect(() => validateManagedWorkerBackendConfiguration("http://127.0.0.1:8000", backends, pools))
      .toThrow(/managed_comfyui_worker_configuration_invalid/);
  });

  it("adapts the production transport into an awaitable readiness probe", async () => {
    const { createManagedProbeFactory } = await import("../index");
    let closeResolved = false;
    const close = vi.fn(async () => { await Promise.resolve(); closeResolved = true; });
    const get = vi.fn(async () => new Response("{}"));
    const createTransport = vi.fn(async () => ({ get, close }));
    const probe = createManagedProbeFactory(createTransport)("http://127.0.0.1:8000");

    await probe.get("/system_stats");
    await probe.close();

    expect(createTransport).toHaveBeenCalledWith(
      "http://127.0.0.1:8000",
      "same-host",
      {},
      ["127.0.0.1"],
      expect.objectContaining({ policyRevision: "managed-loopback-v1" }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(closeResolved).toBe(true);
  });

  it("does not construct the managed controller until explicit post-validation initialization", async () => {
    const { initializeManagedRuntime } = await import("../index");
    const runtime = { restartAfterJob: vi.fn(async () => undefined), getEndpointState: () => ({ state: "idle" as const }) };
    const runtimeFactory = vi.fn(() => runtime);

    expect(runtimeFactory).not.toHaveBeenCalled();
    const initialized = initializeManagedRuntime({
      config: {
        enabled: true,
        baseUrl: "http://127.0.0.1:8000",
        pixelleRoot: "C:\\pixelle",
        dataRoot: "C:\\data",
        pythonExe: "C:\\python.exe",
        commandTimeoutMs: 1,
        readyTimeoutMs: 1,
      },
      runtimeFactory,
      execute: async () => ({ claimDisposition: "release-terminal" as const }),
      closeConnections: async () => undefined,
    });

    expect(runtimeFactory).toHaveBeenCalledOnce();
    expect(initialized.runtime).toBe(runtime);
  });

  it("gates the second managed claim through execute, terminal release, close, stop/start, and readiness", async () => {
    const { pollWorkerJobs } = await import("../index");
    type Settled = JobExecutionResult;
    type Job = { id: string; execute: () => Promise<Settled>; release: () => Promise<boolean> };
    const execution = deferred<Settled>();
    const release = deferred<boolean>();
    const readiness = deferred<void>();
    const events: string[] = [];
    let keepPolling = true;
    const releaseFirstClaim = vi.fn(() => release.promise);
    const jobs: Job[] = [
      { id: "one", execute: () => execution.promise, release: releaseFirstClaim },
      {
        id: "two",
        execute: async () => ({
          success: true,
          finalPhase: "SUCCEEDED",
          needsAttention: false,
          claimDisposition: "release-terminal",
        }),
        release: async () => { keepPolling = false; return true; },
      },
    ];
    const claim = vi.fn(async () => jobs.shift() ?? null);
    const boundary = new JobRuntimeBoundary<Job, Settled>({
      execute: (job) => settleClaimedJob({ execute: job.execute, release: job.release }),
      closeConnections: async () => { events.push("close"); },
      restart: async () => {
        events.push("stop");
        events.push("start");
        await readiness.promise;
        events.push("ready");
      },
    });

    const polling = pollWorkerJobs({
      boundary,
      claim,
      process: async (job) => { await boundary.run(job); },
      shouldContinue: () => keepPolling,
      wait: async () => undefined,
    });

    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
    expect(events).toEqual([]);
    execution.resolve({
      success: true,
      finalPhase: "SUCCEEDED",
      needsAttention: false,
      claimDisposition: "release-terminal",
    });
    await vi.waitFor(() => expect(releaseFirstClaim).toHaveBeenCalledOnce());
    expect(boundary.state).toBe("running-job");
    expect(events).toEqual([]);
    release.resolve(true);
    await vi.waitFor(() => expect(events).toEqual(["close", "stop", "start"]));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(() => boundary.assertReadyToClaim()).toThrow(/restarting/);

    readiness.resolve();
    await polling;
    expect(claim).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["close", "stop", "start", "ready", "close", "stop", "start", "ready"]);
  });

  it("continues to the next unmanaged claim after an unexpected execution exception without reset", async () => {
    const { pollWorkerJobs } = await import("../index");
    const closeConnections = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    let keepPolling = true;
    const claim = vi.fn()
      .mockResolvedValueOnce("job-1")
      .mockResolvedValueOnce("job-2");
    const boundary = new JobRuntimeBoundary<string, { claimDisposition: "release-terminal" }>({
      execute: async (job) => {
        if (job === "job-1") throw new Error("unexpected");
        keepPolling = false;
        return { claimDisposition: "release-terminal" };
      },
      closeConnections,
      restart,
      policy: { restartAfterJob: false, blockOnExecutionError: false },
    });

    await pollWorkerJobs({
      boundary,
      claim,
      process: async (job) => { await boundary.run(job).catch(() => undefined); },
      shouldContinue: () => keepPolling,
      wait: async () => undefined,
    });

    expect(claim).toHaveBeenCalledTimes(2);
    expect(boundary.state).toBe("ready");
    expect(closeConnections).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
