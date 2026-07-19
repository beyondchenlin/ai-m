import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { db } from "@/lib/db";
import {
  executionBackends,
  generationAttempts,
  generationJobs,
  generationProfileRevisions,
  generationProfileStates,
  jobInputArtifacts,
  projects,
  resourcePools,
  resourcePoolSlots,
  sourceMediaAssets,
  workflowBackendValidations,
  workflowPackageRevisions,
  workflowPackageStates,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import type { CreateGenerationJobInput } from "@/lib/generation/contracts";
import { buildIdempotencyRequestDigest } from "../idempotency";

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  isEnabledForProject: () => true,
  FF: { V2_DURABLE_EXECUTION: "V2_DURABLE_EXECUTION" },
}));

import { createGenerationJob } from "../service";

describe("generation service compiled request boundary", () => {
  let context: ReturnType<typeof setupTestDb>;
  const now = Date.now();
  const projectId = "request-validation-project";
  const userId = "request-validation-user";
  const poolId = "request-validation-pool";
  const backendId = "request-validation-backend";
  const workflowDigest = `sha256:${"a".repeat(64)}`;
  const profileId = "request-validation-profile";

  beforeAll(() => {
    context = setupTestDb();
  });

  afterAll(() => {
    context.cleanup();
  });

  beforeAll(async () => {
    await db.insert(projects).values({ id: projectId, userId, title: "Request validation" });
    await db.insert(sourceMediaAssets).values({
      id: "request-validation-source",
      projectId,
      userId,
      kind: "audio",
      status: "COMMITTED",
      storageKey: "source/request-validation.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
      sha256: "e".repeat(64),
      durationMs: 1_000,
      metadataJson: {},
      createdAtMs: now,
      updatedAtMs: now,
    });
    await db.insert(resourcePools).values({
      id: poolId, displayName: "request-validation", capacity: 1,
      policyJson: {}, createdAtMs: now, updatedAtMs: now,
    });
    await db.insert(executionBackends).values({
      id: backendId,
      displayName: "request-validation",
      adapterKind: "comfyui",
      baseUrl: "http://127.0.0.1:8000",
      topology: "same-host",
      sharingMode: "dedicated",
      authType: "none",
      authConfigJson: {},
      tlsConfigJson: {},
      networkPolicyJson: {},
      resourcePoolId: poolId,
      capabilitiesJson: {},
      environmentFingerprint: "env:request-validation",
      featureSnapshotJson: {},
      enabled: 1,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await db.insert(workflowPackageRevisions).values({
      digest: workflowDigest,
      workflowId: "request-validation",
      version: "1.0.0",
      capability: "image",
      workflowApiJson: {},
      manifestJson: {},
      compiledBindingsJson: {
        schemaVersion: 1,
        compilerVersion: "test",
        workflowId: "request-validation",
        version: "1.0.0",
        workflowSha256: `sha256:${"b".repeat(64)}`,
        authorContractSha256: `sha256:${"c".repeat(64)}`,
        bindings: [
          {
            key: "prompt", inputName: "text", valueType: "string", source: "request",
            required: true, userOverride: true, nodeId: "1", classType: "Text",
          },
          {
            key: "steps", inputName: "steps", valueType: "integer", source: "request",
            required: false, userOverride: true, default: 20, minimum: 10, maximum: 40,
            nodeId: "2", classType: "Sampler",
          },
          {
            key: "locked", inputName: "locked", valueType: "boolean", source: "request",
            required: true, userOverride: false, nodeId: "2", classType: "Sampler",
          },
        ],
        outputs: [
          { key: "image", field: "images", mediaKind: "image", maxItems: 1, nodeId: "3", classType: "Save" },
        ],
      },
      packageLockJson: {},
      packagePath: "test-only",
      workflowSha256: "b".repeat(64),
      environmentLockDigest: "lock:request-validation",
      compilerVersion: "test",
      compiledAtMs: now,
      createdAtMs: now,
    });
    await db.insert(workflowPackageStates).values({
      workflowPackageDigest: workflowDigest,
      state: "active",
      updatedAtMs: now,
    });
    await db.insert(workflowBackendValidations).values({
      id: "request-validation-validation",
      workflowPackageDigest: workflowDigest,
      executionBackendId: backendId,
      environmentFingerprint: "env:request-validation",
      environmentLockDigest: "lock:request-validation",
      reviewerId: "reviewer",
      reportJson: { approved: true },
      validatedAtMs: now,
      updatedAtMs: now,
    });
    await db.insert(generationProfileRevisions).values({
      id: profileId,
      profileKey: "request-validation",
      revisionNo: 1,
      revisionDigest: `sha256:${"d".repeat(64)}`,
      displayName: "Request validation",
      capability: "image",
      adapterKind: "comfyui",
      executionBackendId: backendId,
      workflowPackageDigest: workflowDigest,
      configJson: { defaultParameters: { locked: true, steps: 22 } },
      createdAtMs: now,
    });
    await db.insert(generationProfileStates).values({
      generationProfileRevisionId: profileId,
      enabled: 1,
      visibility: "workspace",
      updatedAtMs: now,
    });
  });

  beforeEach(async () => {
    await db.delete(resourcePoolSlots);
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
  });

  function input(request: Record<string, unknown>): CreateGenerationJobInput {
    return {
      capability: "image",
      profileRevisionId: profileId,
      projectId,
      request: request as unknown as CreateGenerationJobInput["request"],
    };
  }

  it.each([
    [{ prompt: "ok", unknown: true }, "workflow_input_unknown"],
    [{ prompt: "ok", locked: false }, "workflow_input_override_forbidden"],
    [{ steps: 20 }, "workflow_input_required"],
    [{ prompt: "ok", steps: Number.NaN }, "workflow_input_number_invalid"],
    [{ prompt: "ok", steps: 41 }, "workflow_input_out_of_range"],
  ])("rejects invalid input before any generation state exists", async (request, code) => {
    await expect(createGenerationJob(input(request), { userId, roles: ["user"] }))
      .rejects.toMatchObject({ status: 400, code });
    expect(await db.select().from(generationJobs)).toHaveLength(0);
    expect(await db.select().from(generationAttempts)).toHaveLength(0);
    expect(await db.select().from(resourcePoolSlots)).toHaveLength(0);
  });

  it("persists the same normalized values used by digests and execution", async () => {
    const job = await createGenerationJob(input({ prompt: "hello" }), { userId, roles: ["user"] });
    const [row] = await db.select().from(generationJobs);
    expect(job.id).toBe(row.id);
    expect(row.executionSnapshotJson).toMatchObject({
      request: { prompt: "hello", steps: 22, locked: true },
    });

    const duplicate = await createGenerationJob(
      input({ prompt: "hello", steps: 22 }),
      { userId, roles: ["user"] },
    );
    expect(duplicate.id).toBe(job.id);
    expect(await db.select().from(generationJobs)).toHaveLength(1);
  });

  it("dual-reads a pre-normalization idempotency digest", async () => {
    const legacyInput = {
      ...input({ prompt: "legacy" }),
      idempotencyKey: "legacy-request-v1",
    };
    await db.insert(generationJobs).values({
      id: "legacy-request-job",
      projectId,
      requestedBy: userId,
      idempotencyKey: legacyInput.idempotencyKey,
      idempotencyRequestDigest: buildIdempotencyRequestDigest(legacyInput, []),
      capability: "image",
      status: "QUEUED",
      executionSnapshotJson: {
        requestDigestVersion: 1,
        profileRevisionId: profileId,
        request: { prompt: "legacy" },
      },
      inputDigest: "legacy-input-digest",
      createdAtMs: now,
      updatedAtMs: now,
    });

    const result = await createGenerationJob(legacyInput, { userId, roles: ["user"] });
    expect(result.id).toBe("legacy-request-job");
    expect(await db.select().from(generationJobs)).toHaveLength(1);
  });

  it("captures an immutable source descriptor in the job transaction", async () => {
    const sourceInput = {
      ...input({ prompt: "source snapshot" }),
      sourceAssets: [{ id: "request-validation-source", role: "voice-reference" }],
    };
    const job = await createGenerationJob(sourceInput, { userId, roles: ["user"] });
    expect(await db.select().from(jobInputArtifacts)).toEqual([
      expect.objectContaining({
        jobId: job.id,
        artifactKind: "source-media",
        artifactId: "request-validation-source",
        role: "voice-reference",
        storageKey: "source/request-validation.wav",
        sha256: "e".repeat(64),
        sizeBytes: 128,
        mimeType: "audio/wav",
      }),
    ]);
    const competingConnection = new Database(context.dbPath);
    try {
      expect(() => competingConnection.prepare(
        "UPDATE source_media_assets SET status='DELETED', updated_at_ms=? WHERE id=?",
      ).run(now + 1, "request-validation-source"))
        .toThrow(/durable job snapshot|still referenced/i);
    } finally {
      competingConnection.close();
    }
  });
});
