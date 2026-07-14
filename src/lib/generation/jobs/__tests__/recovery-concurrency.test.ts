import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
import { scanExpiredClaimsWithTransitionForTest } from "../../resources/leases";
import { recoverExpiredJob, updateOwnedAttempt, type ExpiredJobSnapshot } from "../state-transitions";

type RecoverableJobStatus = "RUNNING" | "CANCEL_REQUESTED";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("expired claim recovery concurrency", () => {
  let ctx: ReturnType<typeof setupTestDb>;
  let workerConnection: Database.Database;

  beforeAll(() => {
    ctx = setupTestDb();
    workerConnection = new Database(ctx.dbPath);
    workerConnection.pragma("busy_timeout = 5000");
    workerConnection.pragma("journal_mode = WAL");
    workerConnection.pragma("foreign_keys = ON");
  });

  afterAll(() => {
    workerConnection.close();
    ctx.cleanup();
  });

  beforeEach(async () => {
    workerConnection.exec("DROP TRIGGER IF EXISTS ignore_recovery_attempt_update");
    workerConnection.exec("DROP TRIGGER IF EXISTS ignore_recovery_job_update");
    await db.delete(generationEvents);
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
  });

  async function seedExpiredPreparingJob(status: RecoverableJobStatus) {
    const now = 1_750_000_000_000;
    const poolId = crypto.randomUUID();
    const backendId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();

    await db.insert(resourcePools).values({
      id: poolId,
      displayName: "recovery-race-pool",
      capacity: 1,
      policyJson: {},
      createdAtMs: now,
      updatedAtMs: now,
    });
    await db.insert(executionBackends).values({
      id: backendId,
      displayName: "recovery-race-backend",
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
      status,
      executionSnapshotJson: {},
      inputDigest: "recovery-race",
      currentAttemptId: attemptId,
      claimOwner: "worker-a",
      claimUntilMs: now - 1,
      claimFencingToken: 7,
      cancelRequestedAtMs: status === "CANCEL_REQUESTED" ? now - 100 : null,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await db.insert(generationAttempts).values({
      id: attemptId,
      jobId,
      attemptNo: 1,
      jobClaimFencingToken: 7,
      phase: "PREPARING",
      backendId,
      backendFeatureSnapshotJson: {},
      environmentFingerprint: "env:race",
      submissionCorrelationId: `corr-${attemptId}`,
      externalIdStrategy: "server-assigned",
      systemOutputPrefix: `prefix-${attemptId}`,
      resourcePoolId: poolId,
      resourceSlotNo: 1,
      resourceLeaseToken: `lease-${attemptId}`,
      resourceFencingToken: 1,
      createdAtMs: now,
      updatedAtMs: now,
    });
    return { jobId, attemptId };
  }

  it.each(["RUNNING", "CANCEL_REQUESTED"] as const)(
    "does not recover a %s snapshot after the worker crosses the external submission boundary",
    async (status) => {
      const { jobId, attemptId } = await seedExpiredPreparingJob(status);

      const candidateRead = deferred<ExpiredJobSnapshot>();
      const releaseRecovery = deferred();
      const recovery = scanExpiredClaimsWithTransitionForTest(async (snapshot, now) => {
        candidateRead.resolve(snapshot);
        await releaseRecovery.promise;
        return recoverExpiredJob(snapshot, now);
      });
      const snapshot = await candidateRead.promise;
      expect(snapshot.attempt).toMatchObject({
        id: attemptId,
        phase: "PREPARING",
        externalJobId: null,
      });

      workerConnection.transaction(() => {
        const attempt = workerConnection.prepare(`
          UPDATE generation_attempts
          SET phase = 'SUBMITTING', external_job_id = 'external-race-1', updated_at_ms = ?
          WHERE id = ? AND job_claim_fencing_token = 7
        `).run(1_750_000_000_001, attemptId);
        expect(attempt.changes).toBe(1);
      }).immediate();
      releaseRecovery.resolve();

      const result = await recovery;
      const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
      const [attempt] = await db.select().from(generationAttempts).where(and(
        eq(generationAttempts.id, attemptId),
        eq(generationAttempts.jobId, jobId),
      ));

      expect(result.requeuedJobs).not.toContain(jobId);
      expect(result.cancelledJobs).not.toContain(jobId);
      expect(result.attentionJobs).not.toContain(jobId);
      expect(result.outcomes).toEqual([{ jobId, status: "lost-race" }]);
      expect(job.status).toBe(status);
      expect(job.currentAttemptId).toBe(attemptId);
      expect(attempt.phase).toBe("SUBMITTING");
      expect(attempt.externalJobId).toBe("external-race-1");
    },
  );

  it("returns lost-race when a valid worker commits the submission boundary after the scanner snapshot", async () => {
    const workerNow = 1_750_000_000_000;
    const { jobId, attemptId } = await seedExpiredPreparingJob("RUNNING");
    await db.update(generationJobs).set({ claimUntilMs: workerNow + 100 })
      .where(eq(generationJobs.id, jobId));

    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    const scannerSnapshot: ExpiredJobSnapshot = {
      jobId,
      jobStatus: "RUNNING",
      claimOwner: "worker-a",
      claimUntilMs: workerNow + 100,
      claimFencingToken: 7,
      currentAttemptId: attemptId,
      attempt: {
        id: attemptId,
        phase: "PREPARING",
        jobClaimFencingToken: 7,
        externalJobId: null,
      },
    };
    expect(job.currentAttemptId).toBe(scannerSnapshot.currentAttemptId);
    expect(attempt.phase).toBe(scannerSnapshot.attempt?.phase);

    const workerDb = drizzle(workerConnection, { schema });
    const workerResult = updateOwnedAttempt({
      jobId,
      attemptId,
      workerId: "worker-a",
      jobFencingToken: 7,
    }, {
      now: workerNow,
      expectedPhases: ["PREPARING"],
      values: { phase: "SUBMITTING", externalJobId: "external-race-2" },
    }, workerDb);
    const recoveryResult = recoverExpiredJob(scannerSnapshot, workerNow + 200);

    expect(workerResult).toEqual({ status: "applied" });
    expect(recoveryResult).toEqual({ status: "lost-race" });
    const [currentJob] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [currentAttempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(currentJob.status).toBe("RUNNING");
    expect(currentAttempt).toMatchObject({ phase: "SUBMITTING", externalJobId: "external-race-2" });
  });

  it("rejects a stale worker phase write after the job lease expires", async () => {
    const now = 1_750_000_000_000;
    const { jobId, attemptId } = await seedExpiredPreparingJob("RUNNING");
    const workerDb = drizzle(workerConnection, { schema });

    const result = updateOwnedAttempt({
      jobId,
      attemptId,
      workerId: "worker-a",
      jobFencingToken: 7,
    }, {
      now,
      expectedPhases: ["PREPARING"],
      values: { phase: "SUBMITTING", externalJobId: "must-not-persist" },
    }, workerDb);

    expect(result).toEqual({ status: "ownership-lost" });
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(attempt).toMatchObject({ phase: "PREPARING", externalJobId: null });
  });

  it("rolls back recovery when the attempt update affects zero rows", async () => {
    const { jobId, attemptId } = await seedExpiredPreparingJob("RUNNING");
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    const snapshot: ExpiredJobSnapshot = {
      jobId,
      jobStatus: "RUNNING",
      claimOwner: job.claimOwner!,
      claimUntilMs: job.claimUntilMs!,
      claimFencingToken: job.claimFencingToken,
      currentAttemptId: attemptId,
      attempt: {
        id: attemptId,
        phase: "PREPARING",
        jobClaimFencingToken: attempt.jobClaimFencingToken,
        externalJobId: null,
      },
    };
    workerConnection.exec(`
      CREATE TRIGGER ignore_recovery_attempt_update BEFORE UPDATE ON generation_attempts
      WHEN OLD.id = '${attemptId}'
      BEGIN SELECT RAISE(IGNORE); END
    `);

    const result = recoverExpiredJob(snapshot, 1_750_000_000_100);

    expect(result).toEqual({ status: "lost-race" });
    const [currentJob] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [currentAttempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(currentJob.status).toBe("RUNNING");
    expect(currentAttempt.phase).toBe("PREPARING");
    expect(await db.select().from(generationEvents).where(eq(generationEvents.jobId, jobId))).toHaveLength(0);
  });

  it("rolls back the attempt update when the recovery job update affects zero rows", async () => {
    const { jobId, attemptId } = await seedExpiredPreparingJob("CANCEL_REQUESTED");
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    const snapshot: ExpiredJobSnapshot = {
      jobId,
      jobStatus: "CANCEL_REQUESTED",
      claimOwner: job.claimOwner!,
      claimUntilMs: job.claimUntilMs!,
      claimFencingToken: job.claimFencingToken,
      currentAttemptId: attemptId,
      attempt: {
        id: attemptId,
        phase: "PREPARING",
        jobClaimFencingToken: attempt.jobClaimFencingToken,
        externalJobId: null,
      },
    };
    workerConnection.exec(`
      CREATE TRIGGER ignore_recovery_job_update BEFORE UPDATE ON generation_jobs
      WHEN OLD.id = '${jobId}'
      BEGIN SELECT RAISE(IGNORE); END
    `);

    const result = recoverExpiredJob(snapshot, 1_750_000_000_100);

    expect(result).toEqual({ status: "lost-race" });
    const [currentJob] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [currentAttempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(currentJob.status).toBe("CANCEL_REQUESTED");
    expect(currentAttempt.phase).toBe("PREPARING");
    expect(await db.select().from(generationEvents).where(eq(generationEvents.jobId, jobId))).toHaveLength(0);
  });

  it("uses the attempt snapshot fence for the recovery attempt write", async () => {
    const { jobId, attemptId } = await seedExpiredPreparingJob("RUNNING");
    await db.update(generationAttempts).set({ jobClaimFencingToken: 6 })
      .where(eq(generationAttempts.id, attemptId));
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const snapshot: ExpiredJobSnapshot = {
      jobId,
      jobStatus: "RUNNING",
      claimOwner: job.claimOwner!,
      claimUntilMs: job.claimUntilMs!,
      claimFencingToken: 7,
      currentAttemptId: attemptId,
      attempt: {
        id: attemptId,
        phase: "PREPARING",
        jobClaimFencingToken: 6,
        externalJobId: null,
      },
    };

    const result = recoverExpiredJob(snapshot, 1_750_000_000_100);

    expect(result).toEqual({ status: "applied", disposition: "requeued" });
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(attempt.phase).toBe("ORPHANED");
  });
});
