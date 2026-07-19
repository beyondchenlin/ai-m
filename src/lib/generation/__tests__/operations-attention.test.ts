import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, getSqlite } from "@/lib/db";
import { generationJobs } from "@/lib/db/schema";
import { setupTestDb, type TestDbContext } from "@/lib/test-helpers/db";
import {
  acknowledgeAttentionCase,
  listAttentionCases,
} from "../operations-attention";

let context: TestDbContext;

beforeAll(async () => {
  context = setupTestDb();
  await db.insert(generationJobs).values([
    {
      id: "attention-job",
      projectId: "project-a",
      capability: "image",
      status: "NEEDS_ATTENTION",
      executionSnapshotJson: {},
      inputDigest: `sha256:${"a".repeat(64)}`,
      metadataJson: {},
      needsAttentionReason: "submission evidence is incomplete",
      claimFencingToken: 3,
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    {
      id: "normal-job",
      projectId: "project-a",
      capability: "image",
      status: "FAILED",
      executionSnapshotJson: {},
      inputDigest: `sha256:${"b".repeat(64)}`,
      metadataJson: {},
      claimFencingToken: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
    },
  ]);
});

afterAll(() => context.cleanup());

describe("operations attention cases", () => {
  it("lists only operationally uncertain jobs with safe evidence counts", () => {
    expect(listAttentionCases()).toEqual([expect.objectContaining({
      jobId: "attention-job",
      projectId: "project-a",
      jobStatus: "NEEDS_ATTENTION",
      committedArtifactCount: 0,
      reconciliationProofCount: 0,
      activeSlotCount: 0,
      lastAcknowledgedAtMs: null,
    })]);
  });

  it("records evidence-bound acknowledgement without changing job state", () => {
    expect(acknowledgeAttentionCase({
      jobId: "attention-job",
      actorId: "operator-a",
      reasonCode: "awaiting_backend_evidence",
      evidenceRefs: ["ticket:OPS-42", "history:prompt-7"],
      acknowledgedAtMs: 10,
    })).toEqual({
      acknowledged: true,
      jobId: "attention-job",
      stateUnchanged: true,
    });
    expect(getSqlite().prepare(
      "SELECT status, needs_attention_reason AS reason FROM generation_jobs WHERE id='attention-job'",
    ).get()).toEqual({
      status: "NEEDS_ATTENTION",
      reason: "submission evidence is incomplete",
    });
    const audit = getSqlite().prepare<[], { details: string }>(
      "SELECT details_safe_json AS details FROM audit_events WHERE target_id='attention-job'",
    ).get();
    expect(JSON.parse(audit!.details)).toEqual({
      reasonCode: "awaiting_backend_evidence",
      evidenceRefs: ["ticket:OPS-42", "history:prompt-7"],
      stateUnchanged: true,
    });
    expect(listAttentionCases()[0]).toMatchObject({
      lastAcknowledgedAtMs: 10,
      lastAcknowledgedBy: "operator-a",
    });
  });

  it("rejects free-form or missing evidence and non-attention jobs", () => {
    expect(() => acknowledgeAttentionCase({
      jobId: "attention-job",
      actorId: "operator-a",
      reasonCode: "awaiting_backend_evidence",
      evidenceRefs: ["contains spaces and possible secrets"],
    })).toThrow(/evidence references/i);
    expect(() => acknowledgeAttentionCase({
      jobId: "normal-job",
      actorId: "operator-a",
      reasonCode: "awaiting_backend_evidence",
      evidenceRefs: ["ticket:OPS-43"],
    })).toThrow(/no longer requires/i);
  });
});
