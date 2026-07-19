import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  executionBackends,
  generationArtifacts,
  generationAttempts,
  generationJobs,
  projects,
  resourcePools,
  sourceMediaAssets,
} from "@/lib/db/schema";
import { setupTestDb, type TestDbContext } from "@/lib/test-helpers/db";
import {
  loadAccessibleGenerationArtifactInputs,
  loadAccessibleSourceMediaInputs,
} from "../input-access";

let context: TestDbContext;

beforeAll(async () => {
  context = setupTestDb();
  await db.insert(projects).values([
    { id: "input-project-a", userId: "user-a", title: "A" },
    { id: "input-project-b", userId: "user-b", title: "B" },
  ]);
  await db.insert(resourcePools).values({
    id: "input-pool", displayName: "Input", capacity: 1, policyJson: {},
    createdAtMs: 1, updatedAtMs: 1,
  });
  await db.insert(executionBackends).values({
    id: "input-backend", displayName: "Input", adapterKind: "comfyui",
    baseUrl: "http://127.0.0.1:8000", topology: "same-host", sharingMode: "dedicated",
    authType: "none", authConfigJson: {}, tlsConfigJson: {}, networkPolicyJson: {},
    resourcePoolId: "input-pool", capabilitiesJson: ["image"], enabled: 1,
    createdAtMs: 1, updatedAtMs: 1,
  });
  await db.insert(sourceMediaAssets).values([
    {
      id: "source-a", projectId: "input-project-a", userId: "user-a",
      kind: "audio", status: "COMMITTED", storageKey: "source/a.wav",
      mimeType: "audio/wav", sizeBytes: 100, sha256: "a".repeat(64),
      durationMs: 5_000, metadataJson: {}, createdAtMs: 1, updatedAtMs: 1,
    },
    {
      id: "source-b", projectId: "input-project-b", userId: "user-b",
      kind: "audio", status: "COMMITTED", storageKey: "source/b.wav",
      mimeType: "audio/wav", sizeBytes: 100, sha256: "b".repeat(64),
      durationMs: 5_000, metadataJson: {}, createdAtMs: 1, updatedAtMs: 1,
    },
  ]);
  await db.insert(generationJobs).values({
    id: "input-job-b", projectId: "input-project-b", capability: "image", status: "SUCCEEDED",
    executionSnapshotJson: {}, inputDigest: `sha256:${"c".repeat(64)}`, metadataJson: {},
    claimFencingToken: 1, createdAtMs: 1, updatedAtMs: 1, completedAtMs: 2,
  });
  await db.insert(generationAttempts).values({
    id: "input-attempt-b", jobId: "input-job-b", attemptNo: 1, jobClaimFencingToken: 1,
    phase: "SUCCEEDED", backendId: "input-backend", backendFeatureSnapshotJson: {},
    environmentFingerprint: "env", submissionCorrelationId: "corr-input-b",
    externalIdStrategy: "server-assigned", systemOutputPrefix: "ai-m/input-job-b/1",
    resourcePoolId: "input-pool", resourceSlotNo: 0, resourceLeaseToken: "lease-input-b",
    resourceFencingToken: 1, createdAtMs: 1, updatedAtMs: 2, finishedAtMs: 2,
  });
  await db.insert(generationArtifacts).values({
    id: "artifact-b", attemptId: "input-attempt-b", logicalName: "b.png",
    kind: "image", status: "COMMITTED", storageKey: "artifact/b.png",
    visibility: "project", mimeType: "image/png", sizeBytes: 100,
    sha256: "d".repeat(64), metadataJson: {}, committedAtMs: 2,
    createdAtMs: 1, updatedAtMs: 2,
  });
});

afterAll(() => context.cleanup());

describe("central generation input access", () => {
  it("returns committed inputs only inside the requested owner/project boundary", async () => {
    await expect(loadAccessibleSourceMediaInputs({
      ids: ["source-a"],
      projectId: "input-project-a",
      actor: { userId: "user-a", isAdmin: false },
    })).resolves.toEqual([expect.objectContaining({ id: "source-a", projectId: "input-project-a" })]);
  });

  it("fails closed for cross-project source and generated artifact references", async () => {
    await expect(loadAccessibleSourceMediaInputs({
      ids: ["source-b"],
      projectId: "input-project-a",
      actor: { userId: "user-a", isAdmin: false },
    })).rejects.toThrow(/unavailable/i);
    await expect(loadAccessibleGenerationArtifactInputs({
      ids: ["artifact-b"],
      projectId: "input-project-a",
      actor: { userId: "user-a", isAdmin: false },
    })).rejects.toThrow(/unavailable/i);
  });

  it("does not let a mismatched user reuse a project-scoped identifier", async () => {
    await expect(loadAccessibleSourceMediaInputs({
      ids: ["source-a"],
      projectId: "input-project-a",
      actor: { userId: "user-b", isAdmin: false },
    })).rejects.toThrow(/unavailable/i);
  });
});
