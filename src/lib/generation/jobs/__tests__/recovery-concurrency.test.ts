import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import {
  executionBackends,
  generationAttempts,
  generationEvents,
  generationJobs,
  resourcePools,
  resourcePoolSlots,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import { recoverExpiredJob, updateOwnedAttempt, type ExpiredJobSnapshot } from "../state-transitions";
import { applyExpiredJobCandidates, readExpiredJobCandidates } from "../recovery-candidates";
import {
  acquireResourceSlot,
  applyExpiredSlotCandidates,
  readExpiredSlotCandidates,
  renewJobClaim,
  renewResourceSlot,
  scanExpiredClaims,
} from "@/lib/generation/resources/leases";

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
    await db.delete(resourcePoolSlots);
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
    return { poolId, backendId, jobId, attemptId };
  }

  it.each(["bound", "placeholder"] as const)(
    "defers expired job recovery while the current pre-submission attempt owns a live %s slot",
    async (identityKind) => {
      const now = 1_750_000_000_000;
      const seeded = await seedExpiredPreparingJob("RUNNING");
      const leaseToken = `lease-${seeded.attemptId}`;
      if (identityKind === "placeholder") {
        await db.update(generationAttempts).set({
          resourceSlotNo: 0,
          resourceLeaseToken: `pending-${seeded.attemptId}`,
          resourceFencingToken: 0,
        }).where(eq(generationAttempts.id, seeded.attemptId));
        await db.update(generationJobs).set({ claimOwner: null, claimUntilMs: null })
          .where(eq(generationJobs.id, seeded.jobId));
      }
      await db.insert(resourcePoolSlots).values({
        resourcePoolId: seeded.poolId,
        slotNo: 1,
        ownerAttemptId: seeded.attemptId,
        leaseToken,
        fencingToken: 1,
        expiresAtMs: now + 60_000,
        updatedAtMs: now,
      });

      const candidates = await readExpiredJobCandidates(now + 100);
      const result = await applyExpiredJobCandidates(candidates, undefined, () => now + 100);

      expect(result.outcomes).toEqual([{
        jobId: seeded.jobId,
        status: "deferred-resource-slot",
      }]);
      const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, seeded.jobId));
      const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, seeded.attemptId));
      const [slot] = await db.select().from(resourcePoolSlots).where(eq(resourcePoolSlots.resourcePoolId, seeded.poolId));
      expect(job).toMatchObject({ status: "RUNNING", currentAttemptId: seeded.attemptId });
      expect(attempt).toMatchObject({ phase: "PREPARING", externalJobId: null });
      expect(slot.ownerAttemptId).toBe(seeded.attemptId);

      await db.update(resourcePoolSlots).set({ expiresAtMs: now + 50 })
        .where(eq(resourcePoolSlots.resourcePoolId, seeded.poolId));
      const slotCandidates = await readExpiredSlotCandidates(now + 100);
      const slotOutcomes = await applyExpiredSlotCandidates(slotCandidates, undefined, () => now + 100);
      expect(slotOutcomes).toMatchObject([{
        disposition: "reconciled",
        jobId: seeded.jobId,
        jobDisposition: "requeued",
      }]);
      const [recoveredJob] = await db.select().from(generationJobs).where(eq(generationJobs.id, seeded.jobId));
      const [recoveredAttempt] = await db.select().from(generationAttempts)
        .where(eq(generationAttempts.id, seeded.attemptId));
      const [releasedSlot] = await db.select().from(resourcePoolSlots)
        .where(eq(resourcePoolSlots.resourcePoolId, seeded.poolId));
      expect(recoveredJob.status).toBe("QUEUED");
      expect(recoveredAttempt.phase).toBe("ORPHANED");
      expect(releasedSlot.ownerAttemptId).toBeNull();
    },
  );

  it.each([
    { status: "RUNNING", owner: null, until: null, slotState: "missing", claimKind: "malformed-ownerless", disposition: "requeued", finalStatus: "QUEUED" },
    { status: "RUNNING", owner: "worker-a", until: null, slotState: "free", claimKind: "malformed-missing-expiry", disposition: "needs-attention", finalStatus: "NEEDS_ATTENTION" },
    { status: "CANCEL_REQUESTED", owner: null, until: null, slotState: "missing", claimKind: "malformed-ownerless", disposition: "cancelled", finalStatus: "CANCELLED" },
  ] as const)(
    "recovers a $status/$claimKind legacy residue when its slot is $slotState",
    async ({ status, owner, until, slotState, claimKind, disposition, finalStatus }) => {
      const now = 1_750_000_000_000;
      const seeded = await seedExpiredPreparingJob(status);
      await db.update(generationJobs).set({ claimOwner: owner, claimUntilMs: until })
        .where(eq(generationJobs.id, seeded.jobId));
      if (slotState === "free") {
        await db.insert(resourcePoolSlots).values({
          resourcePoolId: seeded.poolId,
          slotNo: 1,
          ownerAttemptId: null,
          leaseToken: null,
          fencingToken: 1,
          expiresAtMs: null,
          updatedAtMs: now,
        });
      }

      const candidates = await readExpiredJobCandidates(now + 100);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ jobId: seeded.jobId, claimKind });
      const result = await applyExpiredJobCandidates(candidates, undefined, () => now + 100);

      expect(result.outcomes).toEqual([{
        jobId: seeded.jobId,
        status: "applied",
        disposition,
      }]);
      const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, seeded.jobId));
      expect(job.status).toBe(finalStatus);
      if (finalStatus === "CANCELLED") {
        expect(await db.select().from(generationEvents).where(and(
          eq(generationEvents.jobId, seeded.jobId),
          eq(generationEvents.eventType, "job_cancelled"),
        ))).toHaveLength(1);
      }
    },
  );

  it("does not classify legal queued or terminal jobs as malformed claim candidates", async () => {
    const now = 1_750_000_000_000;
    const queued = await seedExpiredPreparingJob("RUNNING");
    const terminal = await seedExpiredPreparingJob("RUNNING");
    await db.update(generationJobs).set({ status: "QUEUED", claimOwner: null, claimUntilMs: null })
      .where(eq(generationJobs.id, queued.jobId));
    await db.update(generationJobs).set({ status: "FAILED", claimOwner: null, claimUntilMs: null })
      .where(eq(generationJobs.id, terminal.jobId));

    expect(await readExpiredJobCandidates(now + 100)).toEqual([]);
  });

  it("recovers a malformed cancellation residue exactly once across dual scanners", async () => {
    const now = 1_750_000_000_000;
    const seeded = await seedExpiredPreparingJob("CANCEL_REQUESTED");
    await db.update(generationJobs).set({ claimOwner: null, claimUntilMs: null })
      .where(eq(generationJobs.id, seeded.jobId));
    const workerDb = drizzle(workerConnection, { schema }) as typeof db;
    const [leftCandidates, rightCandidates] = await Promise.all([
      readExpiredJobCandidates(now + 100, db),
      readExpiredJobCandidates(now + 100, workerDb),
    ]);

    const [left, right] = await Promise.all([
      applyExpiredJobCandidates(leftCandidates, db, () => now + 100),
      applyExpiredJobCandidates(rightCandidates, workerDb, () => now + 100),
    ]);

    expect([...left.outcomes, ...right.outcomes]
      .filter((outcome) => outcome.status === "applied" && outcome.disposition === "cancelled"))
      .toHaveLength(1);
    expect(await db.select().from(generationEvents).where(and(
      eq(generationEvents.jobId, seeded.jobId),
      eq(generationEvents.eventType, "job_cancelled"),
    ))).toHaveLength(1);
  });

  it("defers job recovery after a read slot candidate is renewed, then converges after the renewed slot expires", async () => {
    const now = 1_750_000_000_000;
    const seeded = await seedExpiredPreparingJob("RUNNING");
    const leaseToken = `lease-${seeded.attemptId}`;
    await db.update(generationJobs).set({ claimUntilMs: now + 100 })
      .where(eq(generationJobs.id, seeded.jobId));
    await db.insert(resourcePoolSlots).values({
      resourcePoolId: seeded.poolId,
      slotNo: 1,
      ownerAttemptId: seeded.attemptId,
      leaseToken,
      fencingToken: 1,
      expiresAtMs: now - 1,
      updatedAtMs: now - 1,
    });
    const staleSlotCandidates = await readExpiredSlotCandidates(now);
    expect(await renewResourceSlot(
      seeded.poolId, 1, leaseToken, 1, "worker-a", db, () => now,
    )).toBe(true);
    await db.update(generationJobs).set({ claimUntilMs: now + 1 })
      .where(eq(generationJobs.id, seeded.jobId));

    const jobCandidates = await readExpiredJobCandidates(now + 2);
    const deferredRecovery = await applyExpiredJobCandidates(jobCandidates, db, () => now + 2);
    expect(deferredRecovery.outcomes).toEqual([{
      jobId: seeded.jobId,
      status: "deferred-resource-slot",
    }]);
    expect(await applyExpiredSlotCandidates(staleSlotCandidates, db, () => now + 2))
      .toMatchObject([{ disposition: "retained", reason: "slot-changed" }]);

    const renewedExpiry = now + 120_000;
    const freshSlotCandidates = await readExpiredSlotCandidates(renewedExpiry + 1);
    expect(await applyExpiredSlotCandidates(freshSlotCandidates, db, () => renewedExpiry + 1))
      .toMatchObject([{ disposition: "reconciled", jobDisposition: "requeued" }]);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, seeded.jobId));
    const [slot] = await db.select().from(resourcePoolSlots).where(eq(resourcePoolSlots.resourcePoolId, seeded.poolId));
    expect(job.status).toBe("QUEUED");
    expect(slot.ownerAttemptId).toBeNull();
  });

  it("serializes claim and slot renewal without reversing ownership", async () => {
    const now = Date.now();
    const seeded = await seedExpiredPreparingJob("RUNNING");
    const leaseToken = `lease-${seeded.attemptId}`;
    await db.update(generationJobs).set({ claimUntilMs: now + 60_000 })
      .where(eq(generationJobs.id, seeded.jobId));
    await db.insert(resourcePoolSlots).values({
      resourcePoolId: seeded.poolId,
      slotNo: 1,
      ownerAttemptId: seeded.attemptId,
      leaseToken,
      fencingToken: 1,
      expiresAtMs: now + 60_000,
      updatedAtMs: now,
    });
    const workerDb = drizzle(workerConnection, { schema }) as typeof db;

    const [claimRenewed, slotRenewed] = await Promise.all([
      renewJobClaim(seeded.jobId, "worker-a", 7),
      renewResourceSlot(seeded.poolId, 1, leaseToken, 1, "worker-a", workerDb, () => now),
    ]);

    expect({ claimRenewed, slotRenewed }).toEqual({ claimRenewed: true, slotRenewed: true });
  });

  it("reports deferred ownership in the production scanner and converges when the slot expires", async () => {
    const now = Date.now();
    const seeded = await seedExpiredPreparingJob("RUNNING");
    const leaseToken = `lease-${seeded.attemptId}`;
    await db.update(generationJobs).set({ claimUntilMs: now - 1 })
      .where(eq(generationJobs.id, seeded.jobId));
    await db.insert(resourcePoolSlots).values({
      resourcePoolId: seeded.poolId,
      slotNo: 1,
      ownerAttemptId: seeded.attemptId,
      leaseToken,
      fencingToken: 1,
      expiresAtMs: now + 60_000,
      updatedAtMs: now,
    });

    const first = await scanExpiredClaims();
    expect(first.outcomes).toContainEqual({
      jobId: seeded.jobId,
      status: "deferred-resource-slot",
    });
    expect(first.requeuedJobs).not.toContain(seeded.jobId);
    await db.update(resourcePoolSlots).set({ expiresAtMs: Date.now() - 1 })
      .where(eq(resourcePoolSlots.resourcePoolId, seeded.poolId));

    const second = await scanExpiredClaims();
    expect(second.requeuedJobs).toContain(seeded.jobId);
    expect(second.releasedSlots).toContainEqual({ poolId: seeded.poolId, slotNo: 1 });
  });

  it("checks claim freshness after waiting for the writer lock before acquiring a slot", async () => {
    const now = Date.now();
    const seeded = await seedExpiredPreparingJob("RUNNING");
    await db.update(generationJobs).set({ claimUntilMs: now + 100 })
      .where(eq(generationJobs.id, seeded.jobId));
    await db.update(generationAttempts).set({
      resourceSlotNo: 0,
      resourceLeaseToken: `pending-${seeded.attemptId}`,
      resourceFencingToken: 0,
    }).where(eq(generationAttempts.id, seeded.attemptId));
    await db.insert(resourcePoolSlots).values({
      resourcePoolId: seeded.poolId,
      slotNo: 1,
      ownerAttemptId: null,
      leaseToken: null,
      fencingToken: 0,
      expiresAtMs: null,
      updatedAtMs: now,
    });
    const locker = spawn(process.execPath, ["-e", `
      const Database = require('better-sqlite3');
      const database = new Database(process.argv[1]);
      database.pragma('busy_timeout = 5000');
      database.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      database.exec('COMMIT');
      database.close();
    `, ctx.dbPath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const lockerExited = once(locker, "exit");
    await once(locker.stdout!, "data");
    const workerDb = drizzle(workerConnection, { schema }) as typeof db;

    const acquired = await acquireResourceSlot(seeded.poolId, seeded.attemptId, "worker-a", workerDb);
    await lockerExited;

    expect(acquired).toBeNull();
  });

  it("checks claim freshness after waiting for the writer lock before renewing a slot", async () => {
    const now = Date.now();
    const seeded = await seedExpiredPreparingJob("RUNNING");
    const leaseToken = `lease-${seeded.attemptId}`;
    await db.update(generationJobs).set({ claimUntilMs: now + 100 })
      .where(eq(generationJobs.id, seeded.jobId));
    await db.insert(resourcePoolSlots).values({
      resourcePoolId: seeded.poolId,
      slotNo: 1,
      ownerAttemptId: seeded.attemptId,
      leaseToken,
      fencingToken: 1,
      expiresAtMs: now + 60_000,
      updatedAtMs: now,
    });
    const locker = spawn(process.execPath, ["-e", `
      const Database = require('better-sqlite3');
      const database = new Database(process.argv[1]);
      database.pragma('busy_timeout = 5000');
      database.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      database.exec('COMMIT');
      database.close();
    `, ctx.dbPath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const lockerExited = once(locker, "exit");
    await once(locker.stdout!, "data");
    const workerDb = drizzle(workerConnection, { schema }) as typeof db;

    const renewed = await renewResourceSlot(
      seeded.poolId, 1, leaseToken, 1, "worker-a", workerDb,
    );
    await lockerExited;

    expect(renewed).toBe(false);
  });

  it.each(["RUNNING", "CANCEL_REQUESTED"] as const)(
    "does not recover a %s snapshot after the worker crosses the external submission boundary",
    async (status) => {
      const { jobId, attemptId } = await seedExpiredPreparingJob(status);
      const candidateRead = deferred<ExpiredJobSnapshot>();
      const resumeApply = deferred();
      const recovery = (async () => {
        const candidates = await readExpiredJobCandidates(1_750_000_000_100);
        candidateRead.resolve(candidates[0]);
        await resumeApply.promise;
        return applyExpiredJobCandidates(candidates, undefined, () => 1_750_000_000_100);
      })();
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
      resumeApply.resolve();
      const result = await recovery;
      const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
      const [attempt] = await db.select().from(generationAttempts).where(and(
        eq(generationAttempts.id, attemptId),
        eq(generationAttempts.jobId, jobId),
      ));

      expect(result.outcomes).toEqual([{ jobId, status: "lost-race" }]);
      expect(result.requeuedJobs).not.toContain(jobId);
      expect(result.cancelledJobs).not.toContain(jobId);
      expect(result.attentionJobs).not.toContain(jobId);
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
      claimKind: "expired",
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
      clock: () => workerNow,
      expectedPhases: ["PREPARING"],
      nextPhase: "SUBMITTING",
      values: { externalJobId: "external-race-2" },
    }, workerDb);
    const recoveryResult = recoverExpiredJob(scannerSnapshot, undefined, () => workerNow + 200);

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
      clock: () => now,
      expectedPhases: ["PREPARING"],
      nextPhase: "SUBMITTING",
      values: { externalJobId: "must-not-persist" },
    }, workerDb);

    expect(result).toEqual({ status: "ownership-lost" });
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(attempt).toMatchObject({ phase: "PREPARING", externalJobId: null });
  });

  it("reads lease time after waiting for the BEGIN IMMEDIATE writer lock", async () => {
    const { jobId, attemptId } = await seedExpiredPreparingJob("RUNNING");
    const observedAtMs = Date.now();
    await db.update(generationJobs).set({ claimUntilMs: observedAtMs + 100 })
      .where(eq(generationJobs.id, jobId));

    const locker = spawn(process.execPath, ["-e", `
      const Database = require('better-sqlite3');
      const database = new Database(process.argv[1]);
      database.pragma('busy_timeout = 5000');
      database.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      database.exec('COMMIT');
      database.close();
    `, ctx.dbPath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const lockerExited = once(locker, "exit");
    await once(locker.stdout!, "data");

    const workerDb = drizzle(workerConnection, { schema });
    const result = updateOwnedAttempt({
      jobId,
      attemptId,
      workerId: "worker-a",
      jobFencingToken: 7,
    }, {
      expectedPhases: ["PREPARING"],
      nextPhase: "SUBMITTING",
      values: { externalJobId: "must-not-persist" },
    }, workerDb);
    await lockerExited;

    expect(result).toEqual({ status: "ownership-lost" });
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(attempt).toMatchObject({ phase: "PREPARING", externalJobId: null });
  });

  it("rolls back recovery when the attempt update affects zero rows", async () => {
    const { jobId, attemptId } = await seedExpiredPreparingJob("RUNNING");
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    const snapshot: ExpiredJobSnapshot = {
      claimKind: "expired",
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

    const result = recoverExpiredJob(snapshot, undefined, () => 1_750_000_000_100);

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
      claimKind: "expired",
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

    const result = recoverExpiredJob(snapshot, undefined, () => 1_750_000_000_100);

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
      claimKind: "expired",
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

    const result = recoverExpiredJob(snapshot, undefined, () => 1_750_000_000_100);

    expect(result).toEqual({ status: "applied", disposition: "requeued" });
    const [attempt] = await db.select().from(generationAttempts).where(eq(generationAttempts.id, attemptId));
    expect(attempt.phase).toBe("ORPHANED");
  });
});
