import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  generationJobs,
  generationJobSourceAssets,
  jobInputArtifacts,
  projects,
  sourceMediaAssets,
} from "@/lib/db/schema";
import { setupTestDb, type TestDbContext } from "@/lib/test-helpers/db";
import { releaseExpiredJobInputSnapshots } from "../source-assets";

let context: TestDbContext;

beforeAll(async () => {
  context = setupTestDb();
  await db.insert(projects).values({
    id: "retention-project", userId: "retention-user", title: "Retention",
  });
});

afterAll(() => context.cleanup());

describe("job input retention lifecycle", () => {
  it("releases terminal snapshots after the retry window and unblocks source deletion", async () => {
    await db.insert(sourceMediaAssets).values({
      id: "retained-source",
      projectId: "retention-project",
      userId: "retention-user",
      kind: "audio",
      status: "COMMITTED",
      storageKey: "retention/source.wav",
      mimeType: "audio/wav",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      durationMs: 1_000,
      metadataJson: {},
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await db.insert(generationJobs).values({
      id: "retained-job",
      projectId: "retention-project",
      capability: "speech",
      status: "FAILED",
      executionSnapshotJson: {},
      inputDigest: `sha256:${"b".repeat(64)}`,
      metadataJson: {},
      inputRetentionUntilMs: 100,
      createdAtMs: 1,
      updatedAtMs: 2,
      completedAtMs: 2,
    });
    await db.insert(generationJobSourceAssets).values({
      jobId: "retained-job",
      sourceAssetId: "retained-source",
      role: "voice-reference",
      createdAtMs: 1,
    });
    await db.insert(jobInputArtifacts).values({
      jobId: "retained-job",
      artifactKind: "source-media",
      artifactId: "retained-source",
      role: "voice-reference",
      storageKey: "retention/source.wav",
      sha256: "a".repeat(64),
      sizeBytes: 10,
      mimeType: "audio/wav",
      createdAtMs: 1,
    });

    await expect(releaseExpiredJobInputSnapshots(99)).resolves.toBe(0);
    await expect(releaseExpiredJobInputSnapshots(100)).resolves.toBe(1);
    await expect(releaseExpiredJobInputSnapshots(101)).resolves.toBe(0);

    expect(await db.select().from(jobInputArtifacts)).toEqual([]);
    expect(await db.select().from(generationJobSourceAssets)).toEqual([]);
    expect((await db.select().from(generationJobs))[0]?.inputsReleasedAtMs).toBe(100);
    await expect(db.update(sourceMediaAssets).set({
      status: "DELETED",
      updatedAtMs: 101,
    })).resolves.toBeDefined();
  });
});
