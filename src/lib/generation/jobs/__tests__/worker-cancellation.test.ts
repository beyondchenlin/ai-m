import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import {
  executionBackends,
  generationAttempts,
  generationEvents,
  generationJobs,
  resourcePools,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import { finalizeOwnedExecution, finalizeOwnedJob } from "../state-transitions";

describe("worker terminal transitions", () => {
  let ctx: ReturnType<typeof setupTestDb>;
  let secondConnection: Database.Database;

  beforeAll(() => {
    ctx = setupTestDb();
    secondConnection = new Database(ctx.dbPath);
    secondConnection.pragma("busy_timeout = 5000");
    secondConnection.pragma("journal_mode = WAL");
    secondConnection.pragma("foreign_keys = ON");
  });

  afterAll(() => {
    secondConnection.close();
    ctx.cleanup();
  });

  beforeEach(async () => {
    secondConnection.exec("DROP TRIGGER IF EXISTS reject_terminal_event");
    await db.delete(generationEvents);
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
  });

  async function seedOwnedExecution() {
    const now = 1_750_000_000_000;
    const poolId = crypto.randomUUID();
    const backendId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await db.insert(resourcePools).values({
      id: poolId, displayName: "terminal-pool", capacity: 1, policyJson: {}, createdAtMs: now, updatedAtMs: now,
    });
    await db.insert(executionBackends).values({
      id: backendId,
      displayName: "terminal-backend",
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
      createdAtMs: now,
      updatedAtMs: now,
    });
    await db.insert(generationJobs).values({
      id: jobId,
      capability: "image",
      status: "CANCEL_REQUESTED",
      executionSnapshotJson: {},
      inputDigest: "terminal-race",
      currentAttemptId: attemptId,
      claimOwner: "worker-a",
      claimUntilMs: now + 1_000,
      claimFencingToken: 11,
      cancelRequestedAtMs: now - 1,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await db.insert(generationAttempts).values({
      id: attemptId,
      jobId,
      attemptNo: 1,
      jobClaimFencingToken: 11,
      phase: "CANCEL_REQUESTED",
      backendId,
      backendFeatureSnapshotJson: {},
      environmentFingerprint: "env:terminal",
      submissionCorrelationId: `corr-${attemptId}`,
      externalIdStrategy: "server-assigned",
      externalJobId: "external-terminal",
      systemOutputPrefix: `prefix-${attemptId}`,
      resourcePoolId: poolId,
      resourceSlotNo: 1,
      resourceLeaseToken: `lease-${attemptId}`,
      resourceFencingToken: 1,
      createdAtMs: now,
      updatedAtMs: now,
    });
    return { now, jobId, attemptId };
  }

  it("atomically finalizes cancellation and emits job_cancelled", async () => {
    const { now, jobId, attemptId } = await seedOwnedExecution();
    const result = finalizeOwnedExecution({
      jobId, attemptId, workerId: "worker-a", jobFencingToken: 11,
    }, {
      now,
      expectedJobStatuses: ["CANCEL_REQUESTED"],
      expectedAttemptPhases: ["CANCEL_REQUESTED"],
      attemptValues: { phase: "CANCELLED", finishedAtMs: now },
      jobValues: { status: "CANCELLED", completedAtMs: now },
      event: { eventType: "job_cancelled", severity: "info", safePayloadJson: {} },
    });

    expect(result).toEqual({ status: "applied" });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    const events = await db.select().from(generationEvents).where(eq(generationEvents.jobId, jobId));
    expect(job.status).toBe("CANCELLED");
    expect(attempt.phase).toBe("CANCELLED");
    expect(events.map((event) => event.eventType)).toEqual(["job_cancelled"]);
  });

  it("atomically cancels an owned job before an attempt exists", async () => {
    const { now, jobId, attemptId } = await seedOwnedExecution();
    await db.delete(generationAttempts).where(eq(generationAttempts.id, attemptId));
    await db.update(generationJobs).set({ currentAttemptId: null, status: "RUNNING" })
      .where(eq(generationJobs.id, jobId));

    const result = finalizeOwnedJob({
      jobId,
      workerId: "worker-a",
      jobFencingToken: 11,
    }, {
      now,
      expectedJobStatuses: ["RUNNING"],
      jobValues: { status: "CANCELLED", completedAtMs: now },
      event: { eventType: "job_cancelled_before_submission", severity: "info", safePayloadJson: {} },
    });

    expect(result).toEqual({ status: "applied" });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const events = await db.select().from(generationEvents).where(eq(generationEvents.jobId, jobId));
    expect(job.status).toBe("CANCELLED");
    expect(events.map((event) => event.eventType)).toEqual(["job_cancelled_before_submission"]);
  });

  it("writes no terminal state or event after ownership is lost", async () => {
    const { now, jobId, attemptId } = await seedOwnedExecution();
    await db.update(generationJobs).set({ claimFencingToken: 12, claimOwner: "worker-b" })
      .where(eq(generationJobs.id, jobId));

    const result = finalizeOwnedExecution({
      jobId, attemptId, workerId: "worker-a", jobFencingToken: 11,
    }, {
      now,
      expectedJobStatuses: ["CANCEL_REQUESTED"],
      expectedAttemptPhases: ["CANCEL_REQUESTED"],
      attemptValues: { phase: "CANCELLED", finishedAtMs: now },
      jobValues: { status: "CANCELLED", completedAtMs: now },
      event: { eventType: "job_cancelled", severity: "info", safePayloadJson: {} },
    });

    expect(result).toEqual({ status: "ownership-lost" });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(job.status).toBe("CANCEL_REQUESTED");
    expect(attempt.phase).toBe("CANCEL_REQUESTED");
    expect(await db.select().from(generationEvents).where(eq(generationEvents.jobId, jobId))).toHaveLength(0);
  });

  it("rolls back job and attempt when the terminal event cannot be inserted", async () => {
    const { now, jobId, attemptId } = await seedOwnedExecution();
    secondConnection.exec(`
      CREATE TRIGGER reject_terminal_event BEFORE INSERT ON generation_events
      WHEN NEW.event_type = 'job_cancelled'
      BEGIN SELECT RAISE(ABORT, 'event rejected'); END
    `);

    expect(() => finalizeOwnedExecution({
      jobId, attemptId, workerId: "worker-a", jobFencingToken: 11,
    }, {
      now,
      expectedJobStatuses: ["CANCEL_REQUESTED"],
      expectedAttemptPhases: ["CANCEL_REQUESTED"],
      attemptValues: { phase: "CANCELLED", finishedAtMs: now },
      jobValues: { status: "CANCELLED", completedAtMs: now },
      event: { eventType: "job_cancelled", severity: "info", safePayloadJson: {} },
    })).toThrow(/event rejected/);

    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(job.status).toBe("CANCEL_REQUESTED");
    expect(attempt.phase).toBe("CANCEL_REQUESTED");
    expect(await db.select().from(generationEvents).where(eq(generationEvents.jobId, jobId))).toHaveLength(0);
  });

  it("allows only one completion-versus-cancellation terminal winner", async () => {
    const { now, jobId, attemptId } = await seedOwnedExecution();
    const secondDb = drizzle(secondConnection, { schema });
    const identity = { jobId, attemptId, workerId: "worker-a", jobFencingToken: 11 };

    const completion = finalizeOwnedExecution(identity, {
      now,
      expectedJobStatuses: ["CANCEL_REQUESTED"],
      expectedAttemptPhases: ["CANCEL_REQUESTED"],
      attemptValues: { phase: "SUCCEEDED", finishedAtMs: now },
      jobValues: { status: "SUCCEEDED", completedAtMs: now },
      event: { eventType: "job_succeeded", severity: "info", safePayloadJson: {} },
    });
    const cancellation = finalizeOwnedExecution(identity, {
      now,
      expectedJobStatuses: ["CANCEL_REQUESTED"],
      expectedAttemptPhases: ["CANCEL_REQUESTED"],
      attemptValues: { phase: "CANCELLED", finishedAtMs: now },
      jobValues: { status: "CANCELLED", completedAtMs: now },
      event: { eventType: "job_cancelled", severity: "info", safePayloadJson: {} },
    }, secondDb);

    expect([completion.status, cancellation.status].sort()).toEqual(["applied", "ownership-lost"]);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    const events = await db.select().from(generationEvents).where(eq(generationEvents.jobId, jobId));
    expect(["SUCCEEDED", "CANCELLED"]).toContain(job.status);
    expect(attempt.phase).toBe(job.status);
    expect(events).toHaveLength(1);
  });
});
