import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, getSqlite } from "@/lib/db";
import {
  executionBackends,
  generationArtifacts,
  generationAttempts,
  generationEvents,
  generationJobs,
  resourcePools,
  resourcePoolSlots,
  workflowBackendValidations,
  workflowPackageRevisions,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import {
  FakeComfyUITransport,
  defaultBackendFeatures,
  installFakeWebSocket,
  jsonResponse,
} from "@/lib/test-helpers/fake-comfyui";

const mocks = vi.hoisted(() => ({
  acquireResourceSlot: vi.fn(),
  createComfyUITransport: vi.fn(),
  materializeWorkflowInputs: vi.fn(),
  probeBackendFeatures: vi.fn(),
  releaseResourceSlot: vi.fn(),
  renewResourceSlot: vi.fn(),
  streamCommitArtifact: vi.fn(),
  loadActiveWorkflowPackage: vi.fn(),
  bindWorkflow: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  FF: { V2_COMFYUI_TRANSPORT: "V2_COMFYUI_TRANSPORT" },
}));

vi.mock("@/lib/generation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/generation")>(),
  acquireResourceSlot: mocks.acquireResourceSlot,
  createComfyUITransport: mocks.createComfyUITransport,
  materializeWorkflowInputs: mocks.materializeWorkflowInputs,
  probeBackendFeatures: mocks.probeBackendFeatures,
  releaseResourceSlot: mocks.releaseResourceSlot,
  renewResourceSlot: mocks.renewResourceSlot,
  streamCommitArtifact: mocks.streamCommitArtifact,
}));

vi.mock("@/lib/generation/workflows", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/generation/workflows")>(),
  loadActiveWorkflowPackage: mocks.loadActiveWorkflowPackage,
  bindWorkflow: mocks.bindWorkflow,
}));

vi.mock("@/lib/security", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/security")>(),
  resolveBackendAuthHeaders: vi.fn(async () => ({})),
}));

vi.mock("@/lib/generation/business-adapter", () => ({
  linkArtifactToBusinessEntity: vi.fn(async () => undefined),
  mergeGenerationJobMetadata: vi.fn(async () => undefined),
}));

import { executeGenerationJob } from "../../worker-executor";

describe("worker completion after cancellation intent", () => {
  let ctx: ReturnType<typeof setupTestDb>;
  let restoreWebSocket: (() => void) | null = null;

  beforeAll(() => {
    ctx = setupTestDb();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  beforeEach(async () => {
    restoreWebSocket = installFakeWebSocket();
    await db.delete(generationEvents);
    await db.delete(generationArtifacts);
    await db.delete(resourcePoolSlots);
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(workflowBackendValidations);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
    getSqlite().exec(`
      DROP TRIGGER IF EXISTS audit_attempt_phase;
      DROP TABLE IF EXISTS attempt_phase_audit;
      CREATE TABLE attempt_phase_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT NOT NULL);
      CREATE TRIGGER audit_attempt_phase AFTER UPDATE OF phase ON generation_attempts
      WHEN OLD.phase <> NEW.phase
      BEGIN INSERT INTO attempt_phase_audit(phase) VALUES (NEW.phase); END;
    `);
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreWebSocket?.();
    restoreWebSocket = null;
    getSqlite().exec("DROP TRIGGER IF EXISTS audit_attempt_phase; DROP TABLE IF EXISTS attempt_phase_audit;");
  });

  async function arrangeExecution(
    scenario: "known-completed" | "completion-wins-after-queue-absence"
      | "timeout-discovers-running" | "timeout-stays-unknown",
  ) {
    const now = Date.now();
    const poolId = crypto.randomUUID();
    const backendId = crypto.randomUUID();
    const workflowIdentity = crypto.randomUUID();
    const workflowDigest = `sha256:${workflowIdentity}`;
    const jobId = crypto.randomUUID();
    const promptId = "cancel-completed-prompt";
    const workerId = "worker-cancel-race";
    const fencingToken = 23;
    await db.insert(resourcePools).values({
      id: poolId, displayName: "cancel-race", capacity: 1, policyJson: {}, createdAtMs: now, updatedAtMs: now,
    });
    await db.insert(executionBackends).values({
      id: backendId,
      displayName: "cancel-race-backend",
      adapterKind: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
      topology: "same-host",
      sharingMode: "dedicated",
      authType: "none",
      authConfigJson: {},
      tlsConfigJson: {},
      networkPolicyJson: {},
      resourcePoolId: poolId,
      capabilitiesJson: {},
      environmentFingerprint: "env:test",
      enabled: 1,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await db.insert(workflowPackageRevisions).values({
      digest: workflowDigest,
      workflowId: `cancel-race-${workflowIdentity}`,
      version: "1.0.0",
      capability: "image",
      workflowApiJson: {},
      manifestJson: {},
      compiledBindingsJson: {},
      packageLockJson: {},
      packagePath: "test-only",
      workflowSha256: "b".repeat(64),
      environmentLockDigest: "lock:test",
      compilerVersion: "1.0.0",
      compiledAtMs: now,
      createdAtMs: now,
    });
    await db.insert(workflowBackendValidations).values({
      id: crypto.randomUUID(),
      workflowPackageDigest: workflowDigest,
      executionBackendId: backendId,
      environmentFingerprint: "env:test",
      environmentLockDigest: "lock:test",
      reviewerId: "reviewer",
      reportJson: { approved: true },
      validatedAtMs: now,
      updatedAtMs: now,
    });
    await db.insert(generationJobs).values({
      id: jobId,
      capability: "image",
      status: "RUNNING",
      executionSnapshotJson: { executionBackendId: backendId, workflowPackageDigest: workflowDigest },
      inputDigest: "cancel-completion",
      claimOwner: workerId,
      claimUntilMs: now + 10_000_000,
      claimFencingToken: fencingToken,
      createdAtMs: now,
      updatedAtMs: now,
    });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));

    let nonterminalAtCancellationDispatch = false;
    let cancellationDispatchAtMs: number | null = null;
    class CancellationRaceTransport extends FakeComfyUITransport {
      private cancellationPersisted = false;
      private cancellationDispatched = false;
      private correlationId: string | undefined;
      private correlationProbeCount = 0;
      private historyProbeCount = 0;

      override async get(path: string): Promise<Response> {
        if (scenario === "known-completed" && path === "/queue" && !this.cancellationPersisted) {
          this.cancellationPersisted = true;
          await db.update(generationJobs).set({
            status: "CANCEL_REQUESTED",
            cancelRequestedAtMs: Date.now(),
          }).where(eq(generationJobs.id, jobId));
        }
        if (path === "/queue" && scenario === "timeout-discovers-running"
          && this.correlationId && !this.cancellationDispatched) {
          this.correlationProbeCount++;
          if (this.correlationProbeCount >= 2) {
            this.scenario.queueRunning = [{ prompt_id: promptId, correlation_id: this.correlationId }];
          }
        }
        if (path === `/history/${promptId}` && scenario === "completion-wins-after-queue-absence") {
          this.historyProbeCount++;
          if (this.historyProbeCount === 1) return jsonResponse({});
        }
        return super.get(path);
      }

      override async post(path: string, body: unknown): Promise<Response> {
        if (path === "/prompt" && scenario === "completion-wins-after-queue-absence") {
          const response = await super.post(path, body);
          await db.update(generationJobs).set({
            status: "CANCEL_REQUESTED",
            cancelRequestedAtMs: Date.now(),
          }).where(eq(generationJobs.id, jobId));
          return response;
        }
        if (path === "/prompt" && scenario !== "known-completed") {
          const record = body as { extra_data?: { correlation_id?: string } };
          const correlationId = record.extra_data?.correlation_id;
          this.correlationId = correlationId;
          await db.update(generationJobs).set({
            status: "CANCEL_REQUESTED",
            cancelRequestedAtMs: Date.now(),
          }).where(eq(generationJobs.id, jobId));
        }
        if (path === "/queue" && Array.isArray((body as { delete?: unknown }).delete)) {
          this.cancellationDispatched = true;
          cancellationDispatchAtMs = Date.now();
          const [currentJob] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
          const [currentAttempt] = await db.select().from(generationAttempts)
            .where(eq(generationAttempts.jobId, jobId));
          nonterminalAtCancellationDispatch = currentJob.status === "CANCEL_REQUESTED"
            && currentAttempt.phase !== "CANCELLED";
        }
        return super.post(path, body);
      }
    }

    const transport = new CancellationRaceTransport({
      promptId,
      submitError: scenario === "timeout-discovers-running" || scenario === "timeout-stays-unknown"
        ? new Error("submission timeout")
        : undefined,
      queueRunning: scenario === "known-completed" ? [{ prompt_id: promptId }] : [],
      history: scenario === "known-completed" || scenario === "completion-wins-after-queue-absence" ? {
        [promptId]: {
          promptId,
          outputs: { "node-1": { images: [{ filename: "completed.png", subfolder: "", type: "output" }] } },
          status: { statusStr: "success", completed: true },
        },
      } : {},
      fileBytes: new Uint8Array([1, 2, 3]).buffer,
    });
    const compiled = {
      schemaVersion: 1 as const,
      compilerVersion: "1.0.0",
      workflowId: "cancel-race-workflow",
      version: "1.0.0",
      workflowSha256: "b".repeat(64),
      authorContractSha256: "c".repeat(64),
      bindings: [],
      outputs: [{
        key: "primary", nodeId: "node-1", classType: "SaveImage", field: "images", mediaKind: "image" as const, maxItems: 1,
      }],
    };
    mocks.createComfyUITransport.mockResolvedValue(transport);
    mocks.probeBackendFeatures.mockResolvedValue(defaultBackendFeatures());
    mocks.acquireResourceSlot.mockImplementation(async (resourcePoolId: string, attemptId: string) => {
      await db.insert(resourcePoolSlots).values({
        resourcePoolId,
        slotNo: 1,
        ownerAttemptId: attemptId,
        leaseToken: "slot-lease",
        fencingToken: 4,
        expiresAtMs: Date.now() + 120_000,
        updatedAtMs: Date.now(),
      });
      return { slotNo: 1, leaseToken: "slot-lease", fencingToken: 4 };
    });
    mocks.renewResourceSlot.mockResolvedValue(true);
    mocks.releaseResourceSlot.mockResolvedValue(true);
    mocks.materializeWorkflowInputs.mockResolvedValue({ parameters: {}, cleanup: async () => undefined });
    mocks.bindWorkflow.mockReturnValue({ "1": { class_type: "KSampler", inputs: {} } });
    mocks.loadActiveWorkflowPackage.mockResolvedValue({
      revision: { environmentLockDigest: "lock:test" },
      workflow: { "1": { class_type: "KSampler", inputs: {} } },
      manifest: {
        capability: "image",
        requirements: { models: [] },
        limits: { maxBatch: 1, maxOutputs: 1, maxJobMs: 5_000, maxOutputBytes: 1_024 },
      },
      compiled,
    });
    mocks.streamCommitArtifact.mockImplementation(async (input: { attemptId: string }) => {
      const artifactId = crypto.randomUUID();
      await db.insert(generationArtifacts).values({
        id: artifactId,
        attemptId: input.attemptId,
        logicalName: "completed.png",
        kind: "image",
        status: "COMMITTED",
        storageKey: `${input.attemptId}/${artifactId}.png`,
        visibility: "project",
        mimeType: "image/png",
        sizeBytes: 3,
        sha256: "d".repeat(64),
        metadataJson: {},
        committedAtMs: Date.now(),
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      return { id: artifactId };
    });

    const execute = async () => {
      if (scenario === "known-completed") return executeGenerationJob(job, workerId, fencingToken);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      try {
        const execution = executeGenerationJob(job, workerId, fencingToken);
        let settled = false;
        void execution.then(() => { settled = true; }, () => { settled = true; });
        for (let step = 0; step < 800 && !settled; step++) {
          await vi.advanceTimersByTimeAsync(10_000);
        }
        if (!settled) throw new Error("execution did not settle under fake timer budget");
        return await execution;
      } finally {
        vi.useRealTimers();
      }
    };

    return {
      execute,
      jobId,
      get nonterminalAtCancellationDispatch() { return nonterminalAtCancellationDispatch; },
      get cancellationDispatchDelayMs() {
        return cancellationDispatchAtMs === null ? null : cancellationDispatchAtMs - now;
      },
    };
  }

  it("collects and commits completed output after durable cancellation intent", async () => {
    const arranged = await arrangeExecution("known-completed");
    const result = await arranged.execute();

    expect(result).toMatchObject({
      success: true,
      finalPhase: "SUCCEEDED",
      claimDisposition: "release-terminal",
    });
    const phases = getSqlite().prepare<[], { phase: string }>(
      "SELECT phase FROM attempt_phase_audit ORDER BY sequence",
    ).all().map((row) => row.phase);
    expect(phases).toEqual([
      "SUBMITTING",
      "EXTERNAL_QUEUED",
      "EXTERNAL_RUNNING",
      "COLLECTING",
      "COMMITTING",
      "SUCCEEDED",
    ]);
    const events = await db.select().from(generationEvents).where(eq(generationEvents.jobId, arranged.jobId));
    expect(events.filter((event) => event.eventType === "external_cancellation_requested")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "job_succeeded")).toHaveLength(1);
    expect((await db.select().from(generationJobs).where(eq(generationJobs.id, arranged.jobId)))[0]).toMatchObject({
      status: "SUCCEEDED",
    });
  });

  it("retains a discovered prompt when cancellation termination remains unknown", async () => {
    const arranged = await arrangeExecution("timeout-discovers-running");
    const result = await arranged.execute();

    expect(arranged.nonterminalAtCancellationDispatch).toBe(true);
    expect(arranged.cancellationDispatchDelayMs).toBeGreaterThan(60_000);
    expect(result).toMatchObject({
      success: false,
      finalPhase: "NEEDS_ATTENTION",
      needsAttention: true,
      claimDisposition: "release-terminal",
    });
    expect(mocks.releaseResourceSlot).not.toHaveBeenCalled();
    const events = await db.select().from(generationEvents)
      .where(eq(generationEvents.jobId, arranged.jobId));
    expect(events.filter((event) => event.eventType === "external_cancellation_confirmed")).toHaveLength(0);
    expect(events.filter((event) => event.eventType === "job_cancelled")).toHaveLength(0);
    expect((await db.select().from(generationJobs).where(eq(generationJobs.id, arranged.jobId)))[0].status)
      .toBe("NEEDS_ATTENTION");
  });

  it("lets a completion observed after queue absence win the cancellation race", async () => {
    const arranged = await arrangeExecution("completion-wins-after-queue-absence");
    const result = await arranged.execute();

    expect(result).toMatchObject({
      success: true,
      finalPhase: "SUCCEEDED",
      claimDisposition: "release-terminal",
    });
    const events = await db.select().from(generationEvents)
      .where(eq(generationEvents.jobId, arranged.jobId));
    expect(events.some((event) => event.eventType === "external_cancellation_confirmed")).toBe(false);
    expect(events.some((event) => event.eventType === "job_cancelled")).toBe(false);
    expect(events.some((event) => event.eventType === "job_succeeded")).toBe(true);
    expect((await db.select().from(generationJobs).where(eq(generationJobs.id, arranged.jobId)))[0].status)
      .toBe("SUCCEEDED");
  });

  it("escalates an uncorrelated timed-out submission without releasing its resource", async () => {
    const arranged = await arrangeExecution("timeout-stays-unknown");
    const result = await arranged.execute();

    expect(result).toMatchObject({
      success: false,
      finalPhase: "NEEDS_ATTENTION",
      needsAttention: true,
      claimDisposition: "release-terminal",
    });
    expect(mocks.releaseResourceSlot).not.toHaveBeenCalled();
    const events = await db.select().from(generationEvents)
      .where(eq(generationEvents.jobId, arranged.jobId));
    expect(events.some((event) => event.eventType === "external_cancellation_confirmed")).toBe(false);
    expect(events.some((event) => event.eventType === "job_cancelled")).toBe(false);
    expect((await db.select().from(generationJobs).where(eq(generationJobs.id, arranged.jobId)))[0].status)
      .toBe("NEEDS_ATTENTION");
  });
});
