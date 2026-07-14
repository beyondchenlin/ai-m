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
  workflowBackendValidations,
  workflowPackageRevisions,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import {
  FakeComfyUITransport,
  defaultBackendFeatures,
  installFakeWebSocket,
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
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(workflowBackendValidations);
    await db.delete(workflowPackageRevisions);
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

  it("collects and commits completed output after durable cancellation intent", async () => {
    const now = Date.now();
    const poolId = crypto.randomUUID();
    const backendId = crypto.randomUUID();
    const workflowDigest = `sha256:${"a".repeat(64)}`;
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
      workflowId: "cancel-race-workflow",
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
      claimUntilMs: now + 60_000,
      claimFencingToken: fencingToken,
      createdAtMs: now,
      updatedAtMs: now,
    });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));

    class CancelAfterRunningEvidenceTransport extends FakeComfyUITransport {
      private cancellationPersisted = false;

      override async get(path: string): Promise<Response> {
        if (path === "/queue" && !this.cancellationPersisted) {
          this.cancellationPersisted = true;
          await db.update(generationJobs).set({
            status: "CANCEL_REQUESTED",
            cancelRequestedAtMs: Date.now(),
          }).where(eq(generationJobs.id, jobId));
        }
        return super.get(path);
      }
    }

    const transport = new CancelAfterRunningEvidenceTransport({
      promptId,
      queueRunning: [{ prompt_id: promptId }],
      history: {
        [promptId]: {
          promptId,
          outputs: { "node-1": { images: [{ filename: "completed.png", subfolder: "", type: "output" }] } },
          status: { statusStr: "success", completed: true },
        },
      },
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
    mocks.acquireResourceSlot.mockResolvedValue({ slotNo: 1, leaseToken: "slot-lease", fencingToken: 4 });
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

    const result = await executeGenerationJob(job, workerId, fencingToken);

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
    const events = await db.select().from(generationEvents).where(eq(generationEvents.jobId, jobId));
    expect(events.filter((event) => event.eventType === "external_cancellation_requested")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "job_succeeded")).toHaveLength(1);
    expect((await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)))[0]).toMatchObject({
      status: "SUCCEEDED",
    });
  });
});
