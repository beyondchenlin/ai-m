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
  resourcePoolSlots,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import * as stateTransitions from "@/lib/generation/jobs/state-transitions";
import {
  acquireResourceSlot,
  applyExpiredSlotCandidates,
  claimJob,
  recordResourceTerminationProof,
  readExpiredSlotCandidates,
  scanExpiredClaims,
} from "../leases";

const NOW = 1_780_000_000_000;

type BeginSubmission = (
  identity: { jobId: string; attemptId: string; workerId: string; jobFencingToken: number },
  resource: {
    resourcePoolId: string;
    slotNo: number;
    leaseToken: string;
    fencingToken: number;
    clock?: () => number;
  },
  database: typeof db,
) => stateTransitions.TransitionResult | { status: "cancelled-before-submission" };

type CancelBeforeSlot = (
  identity: { jobId: string; attemptId: string; workerId: string; jobFencingToken: number },
  database: typeof db,
  clock?: () => number,
) => stateTransitions.TransitionResult;

type CancelBeforeAttempt = (
  identity: { jobId: string; workerId: string; jobFencingToken: number },
  database: typeof db,
  clock?: () => number,
) => stateTransitions.TransitionResult;

function beginSubmission(...args: Parameters<BeginSubmission>): ReturnType<BeginSubmission> {
  const transition = Reflect.get(stateTransitions, "beginOwnedAttemptSubmission") as BeginSubmission | undefined;
  expect(transition, "dedicated atomic begin-submission transition").toBeTypeOf("function");
  return transition!(...args);
}

function cancelBeforeSlot(...args: Parameters<CancelBeforeSlot>): stateTransitions.TransitionResult {
  const transition = Reflect.get(stateTransitions, "cancelOwnedAttemptBeforeSubmission") as CancelBeforeSlot | undefined;
  expect(transition, "atomic pre-slot cancellation transition").toBeTypeOf("function");
  return transition!(...args);
}

function cancelBeforeAttempt(...args: Parameters<CancelBeforeAttempt>): stateTransitions.TransitionResult {
  const transition = Reflect.get(stateTransitions, "cancelOwnedJobBeforeAttempt") as CancelBeforeAttempt | undefined;
  expect(transition, "atomic pre-attempt cancellation transition").toBeTypeOf("function");
  return transition!(...args);
}

describe("resource slot reconciliation concurrency", () => {
  let ctx: ReturnType<typeof setupTestDb>;
  let workerConnection: Database.Database;
  let scannerConnection: Database.Database;
  let workerDb: typeof db;
  let scannerDb: typeof db;

  beforeAll(() => {
    ctx = setupTestDb();
    workerConnection = new Database(ctx.dbPath);
    scannerConnection = new Database(ctx.dbPath);
    for (const connection of [workerConnection, scannerConnection]) {
      connection.pragma("busy_timeout = 5000");
      connection.pragma("journal_mode = WAL");
      connection.pragma("foreign_keys = ON");
    }
    workerDb = drizzle(workerConnection, { schema }) as typeof db;
    scannerDb = drizzle(scannerConnection, { schema }) as typeof db;
    scannerConnection.exec(`
      CREATE TABLE IF NOT EXISTS resource_reconciliation_proofs (
        id text PRIMARY KEY NOT NULL,
        attempt_id text NOT NULL,
        backend_id text NOT NULL,
        external_job_id text NOT NULL,
        proof_kind text NOT NULL,
        observed_at_ms integer NOT NULL,
        resource_pool_id text NOT NULL,
        resource_slot_no integer NOT NULL,
        resource_lease_token text NOT NULL,
        resource_fencing_token integer NOT NULL,
        disposition text NOT NULL DEFAULT 'retained',
        reconciled_at_ms integer,
        created_at_ms integer NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS resource_reconciliation_proofs_lease_unique
        ON resource_reconciliation_proofs (
          attempt_id, resource_pool_id, resource_slot_no,
          resource_lease_token, resource_fencing_token
        );
      CREATE UNIQUE INDEX IF NOT EXISTS resource_reconciliation_proofs_external_unique
        ON resource_reconciliation_proofs (backend_id, external_job_id);
    `);
  });

  afterAll(() => {
    workerConnection.close();
    scannerConnection.close();
    ctx.cleanup();
  });

  beforeEach(async () => {
    scannerConnection.exec("DROP TRIGGER IF EXISTS ignore_pre_submission_cancel_slot_update");
    scannerConnection.exec("DROP TRIGGER IF EXISTS ignore_pre_submission_cancel_job_update");
    scannerConnection.exec("DELETE FROM resource_reconciliation_proofs");
    await db.delete(resourcePoolSlots);
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
  });

  async function seedExpiredSlot(input: {
    phase: typeof generationAttempts.$inferInsert.phase;
    jobStatus: typeof generationJobs.$inferInsert.status;
    externalJobId?: string | null;
    claimOwner?: string | null;
    claimUntilMs?: number | null;
    claimFencingToken?: number;
  }) {
    const poolId = crypto.randomUUID();
    const backendId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const leaseToken = `lease-${attemptId}`;
    const fencingToken = 7;
    const expiresAtMs = NOW - 1;
    await db.insert(resourcePools).values({
      id: poolId,
      displayName: "reconciliation-pool",
      capacity: 1,
      policyJson: {},
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    await db.insert(executionBackends).values({
      id: backendId,
      displayName: "reconciliation-backend",
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
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    await db.insert(generationJobs).values({
      id: jobId,
      capability: "image",
      status: input.jobStatus,
      executionSnapshotJson: {},
      inputDigest: "slot-reconciliation",
      currentAttemptId: attemptId,
      claimOwner: input.claimOwner ?? null,
      claimUntilMs: input.claimUntilMs ?? null,
      claimFencingToken: input.claimFencingToken ?? 0,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    await db.insert(generationAttempts).values({
      id: attemptId,
      jobId,
      attemptNo: 1,
      jobClaimFencingToken: input.claimFencingToken ?? 0,
      phase: input.phase,
      backendId,
      backendFeatureSnapshotJson: {},
      environmentFingerprint: "env:reconciliation",
      submissionCorrelationId: `corr-${attemptId}`,
      externalIdStrategy: "server-assigned",
      externalJobId: input.externalJobId ?? null,
      systemOutputPrefix: `prefix-${attemptId}`,
      resourcePoolId: poolId,
      resourceSlotNo: 1,
      resourceLeaseToken: leaseToken,
      resourceFencingToken: fencingToken,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    await db.insert(resourcePoolSlots).values({
      resourcePoolId: poolId,
      slotNo: 1,
      ownerAttemptId: attemptId,
      leaseToken,
      fencingToken,
      expiresAtMs,
      updatedAtMs: NOW,
    });
    return { poolId, backendId, jobId, attemptId, leaseToken, fencingToken, expiresAtMs };
  }

  async function seedProductionPlaceholder(input: {
    claimOwner: string | null;
    claimUntilMs: number | null;
    jobStatus?: typeof generationJobs.$inferInsert.status;
  }) {
    const poolId = crypto.randomUUID();
    const backendId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const workerId = "worker-placeholder";
    const jobFencingToken = 13;
    await db.insert(resourcePools).values({
      id: poolId,
      displayName: "placeholder-pool",
      capacity: 1,
      policyJson: {},
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    await db.insert(executionBackends).values({
      id: backendId,
      displayName: "placeholder-backend",
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
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    await db.insert(resourcePoolSlots).values({
      resourcePoolId: poolId,
      slotNo: 1,
      ownerAttemptId: null,
      leaseToken: null,
      fencingToken: 0,
      expiresAtMs: null,
      updatedAtMs: NOW,
    });
    await db.insert(generationJobs).values({
      id: jobId,
      capability: "image",
      status: "RUNNING",
      executionSnapshotJson: {},
      inputDigest: "placeholder-window",
      claimOwner: workerId,
      claimUntilMs: NOW + 60_000,
      claimFencingToken: jobFencingToken,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    expect(stateTransitions.attachOwnedAttempt({
      jobId,
      workerId,
      jobFencingToken,
    }, {
      clock: () => NOW,
      attempt: {
        id: attemptId,
        jobId,
        attemptNo: 1,
        jobClaimFencingToken: jobFencingToken,
        phase: "PREPARING",
        backendId,
        backendFeatureSnapshotJson: {},
        environmentFingerprint: "env:placeholder",
        submissionCorrelationId: `corr-${attemptId}`,
        externalIdStrategy: "server-assigned",
        systemOutputPrefix: `prefix-${attemptId}`,
        resourcePoolId: poolId,
        resourceSlotNo: 0,
        resourceLeaseToken: `pending-${attemptId}`,
        resourceFencingToken: 0,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    }, workerDb)).toEqual({ status: "applied" });
    const lease = await acquireResourceSlot(poolId, attemptId, workerId, workerDb, () => NOW);
    expect(lease).not.toBeNull();
    await db.update(resourcePoolSlots).set({
      expiresAtMs: NOW - 1,
      updatedAtMs: NOW,
    }).where(and(
      eq(resourcePoolSlots.resourcePoolId, poolId),
      eq(resourcePoolSlots.slotNo, 1),
    ));
    await db.update(generationJobs).set({
      status: input.jobStatus ?? "RUNNING",
      claimOwner: input.claimOwner,
      claimUntilMs: input.claimUntilMs,
      updatedAtMs: NOW,
    }).where(eq(generationJobs.id, jobId));
    return {
      poolId,
      backendId,
      jobId,
      attemptId,
      workerId,
      jobFencingToken,
      lease: lease!,
    };
  }

  async function attachAndAcquireNextAttempt(input: {
    poolId: string;
    backendId: string;
  }) {
    const jobId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const workerId = "worker-next";
    const jobFencingToken = 14;
    await db.insert(generationJobs).values({
      id: jobId,
      capability: "image",
      status: "RUNNING",
      executionSnapshotJson: {},
      inputDigest: "placeholder-next-owner",
      claimOwner: workerId,
      claimUntilMs: NOW + 60_000,
      claimFencingToken: jobFencingToken,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    expect(stateTransitions.attachOwnedAttempt({ jobId, workerId, jobFencingToken }, {
      clock: () => NOW,
      attempt: {
        id: attemptId,
        jobId,
        attemptNo: 1,
        jobClaimFencingToken: jobFencingToken,
        phase: "PREPARING",
        backendId: input.backendId,
        backendFeatureSnapshotJson: {},
        environmentFingerprint: "env:placeholder-next",
        submissionCorrelationId: `corr-${attemptId}`,
        externalIdStrategy: "server-assigned",
        systemOutputPrefix: `prefix-${attemptId}`,
        resourcePoolId: input.poolId,
        resourceSlotNo: 0,
        resourceLeaseToken: `pending-${attemptId}`,
        resourceFencingToken: 0,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    }, workerDb)).toEqual({ status: "applied" });
    const lease = await acquireResourceSlot(input.poolId, attemptId, workerId, workerDb, () => NOW);
    expect(lease).not.toBeNull();
    return { jobId, attemptId, workerId, jobFencingToken, lease: lease! };
  }

  async function claimAttachAndAcquireRecoveredAttempt(input: {
    jobId: string;
    poolId: string;
    backendId: string;
  }) {
    const workerId = "worker-recovered";
    const claimed = await claimJob(workerId, "image");
    expect(claimed?.id).toBe(input.jobId);
    const attemptId = crypto.randomUUID();
    const jobFencingToken = claimed!.claimFencingToken;
    const previousAttempts = await db.select().from(generationAttempts)
      .where(eq(generationAttempts.jobId, input.jobId));
    expect(stateTransitions.attachOwnedAttempt({ jobId: input.jobId, workerId, jobFencingToken }, {
      clock: () => NOW,
      attempt: {
        id: attemptId,
        jobId: input.jobId,
        attemptNo: 2,
        jobClaimFencingToken: jobFencingToken,
        phase: "PREPARING",
        backendId: input.backendId,
        backendFeatureSnapshotJson: {},
        environmentFingerprint: "env:placeholder-recovered",
        submissionCorrelationId: `corr-${attemptId}`,
        externalIdStrategy: "server-assigned",
        systemOutputPrefix: `prefix-${attemptId}`,
        resourcePoolId: input.poolId,
        resourceSlotNo: 0,
        resourceLeaseToken: `pending-${attemptId}`,
        resourceFencingToken: 0,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    }, workerDb)).toEqual({ status: "applied" });
    const lease = await acquireResourceSlot(input.poolId, attemptId, workerId, workerDb, () => NOW);
    expect(lease).not.toBeNull();
    expect(await db.select().from(generationAttempts).where(eq(generationAttempts.jobId, input.jobId)))
      .toHaveLength(previousAttempts.length + 1);
    return { attemptId, lease: lease! };
  }

  function insertMatchingProof(
    seeded: Awaited<ReturnType<typeof seedExpiredSlot>>,
    proofKind: "history-completed" | "history-cancelled" | "history-failed" = "history-cancelled",
    externalJobId = "external-cancelled",
  ) {
    scannerConnection.prepare(`
      INSERT INTO resource_reconciliation_proofs (
        id, attempt_id, backend_id, external_job_id, proof_kind, observed_at_ms,
        resource_pool_id, resource_slot_no, resource_lease_token, resource_fencing_token,
        disposition, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'retained', ?)
    `).run(
      crypto.randomUUID(), seeded.attemptId, seeded.backendId, externalJobId, proofKind,
      NOW - 100, seeded.poolId, seeded.leaseToken, seeded.fencingToken, NOW - 100,
    );
  }

  it("retains an ORPHANED NEEDS_ATTENTION slot without durable external termination proof", async () => {
    const seeded = await seedExpiredSlot({
      phase: "ORPHANED",
      jobStatus: "NEEDS_ATTENTION",
      externalJobId: "external-running-unknown",
    });

    const result = await scanExpiredClaims();

    expect(result.releasedSlots).toEqual([]);
    const [slot] = await db.select().from(resourcePoolSlots).where(and(
      eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
      eq(resourcePoolSlots.slotNo, 1),
    ));
    expect(slot.ownerAttemptId).toBe(seeded.attemptId);
    expect(slot.leaseToken).toBe(seeded.leaseToken);
  });

  it("does not release a candidate renewed after the scanner read barrier", async () => {
    const seeded = await seedExpiredSlot({
      phase: "SUCCEEDED",
      jobStatus: "SUCCEEDED",
      externalJobId: "external-completed",
    });
    const scanNow = NOW;

    const candidates = await readExpiredSlotCandidates(scanNow, scannerDb);
    expect(candidates).toHaveLength(1);

    const renewedUntil = scanNow + 120_000;
    const renewed = await workerDb.update(resourcePoolSlots).set({
      expiresAtMs: renewedUntil,
      updatedAtMs: scanNow,
    }).where(and(
      eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
      eq(resourcePoolSlots.slotNo, 1),
      eq(resourcePoolSlots.ownerAttemptId, seeded.attemptId),
      eq(resourcePoolSlots.leaseToken, seeded.leaseToken),
      eq(resourcePoolSlots.fencingToken, seeded.fencingToken),
    )).returning();
    expect(renewed).toHaveLength(1);

    const outcomes = await applyExpiredSlotCandidates(candidates, scannerDb, () => scanNow);

    expect(outcomes).toMatchObject([{ disposition: "retained" }]);
    const slot = scannerConnection.prepare<[string], {
      ownerAttemptId: string | null;
      expiresAtMs: number | null;
    }>(`SELECT owner_attempt_id AS ownerAttemptId, expires_at_ms AS expiresAtMs
        FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1`)
      .get(seeded.poolId);
    expect(slot).toEqual({ ownerAttemptId: seeded.attemptId, expiresAtMs: renewedUntil });
    const occupied = scannerConnection.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM resource_pool_slots WHERE owner_attempt_id IS NOT NULL",
    ).get();
    expect(occupied?.count).toBe(1);
    expect(scannerConnection.prepare("SELECT COUNT(*) AS count FROM resource_pool_slots WHERE fencing_token < 0")
      .get()).toEqual({ count: 0 });
  });

  it("retains an expired pre-submission slot while its current job claim is still live", async () => {
    const seeded = await seedExpiredSlot({
      phase: "PREPARING",
      jobStatus: "RUNNING",
      claimOwner: "worker-live",
      claimUntilMs: NOW + 60_000,
      claimFencingToken: 9,
    });

    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);
    const outcomes = await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW);

    expect(outcomes).toMatchObject([{ disposition: "retained", reason: "live-job-claim" }]);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot?.ownerAttemptId).toBe(seeded.attemptId);
    expect(beginSubmission({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: "worker-live",
      jobFencingToken: 9,
    }, {
      resourcePoolId: seeded.poolId,
      slotNo: 1,
      leaseToken: seeded.leaseToken,
      fencingToken: seeded.fencingToken,
      clock: () => NOW,
    }, workerDb)).toEqual({ status: "ownership-lost" });
  });

  it("releases the physical lease from an unbound production placeholder after claim expiry", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: NOW - 1,
    });

    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);
    const outcomes = await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW);

    expect(outcomes).toMatchObject([{ disposition: "reconciled", reason: "pre-submission-placeholder" }]);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot?.ownerAttemptId).toBeNull();
    expect(scannerConnection.prepare("SELECT COUNT(*) AS count FROM resource_reconciliation_proofs").get())
      .toEqual({ count: 0 });

    const next = await claimAttachAndAcquireRecoveredAttempt(seeded);
    expect(beginSubmission({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: seeded.workerId,
      jobFencingToken: seeded.jobFencingToken,
    }, {
      resourcePoolId: seeded.poolId,
      slotNo: seeded.lease.slotNo,
      leaseToken: seeded.lease.leaseToken,
      fencingToken: seeded.lease.fencingToken,
      clock: () => NOW,
    }, scannerDb)).toEqual({ status: "ownership-lost" });
    const currentSlot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(currentSlot?.ownerAttemptId).toBe(next.attemptId);
  });

  it("cancels an attached attempt before slot acquisition and leaves capacity immediately reusable", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: NOW + 60_000,
      jobStatus: "CANCEL_REQUESTED",
    });
    await db.update(resourcePoolSlots).set({
      ownerAttemptId: null,
      leaseToken: null,
      expiresAtMs: null,
    }).where(and(
      eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
      eq(resourcePoolSlots.slotNo, 1),
    ));

    expect(await acquireResourceSlot(
      seeded.poolId, seeded.attemptId, seeded.workerId, scannerDb, () => NOW,
    )).toBeNull();
    expect(cancelBeforeSlot({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: seeded.workerId,
      jobFencingToken: seeded.jobFencingToken,
    }, scannerDb, () => NOW)).toEqual({ status: "applied" });

    const state = scannerConnection.prepare<[string], { jobStatus: string; attemptPhase: string }>(`
      SELECT j.status AS jobStatus, a.phase AS attemptPhase
      FROM generation_jobs j JOIN generation_attempts a ON a.id = j.current_attempt_id
      WHERE j.id = ?
    `).get(seeded.jobId);
    expect(state).toEqual({ jobStatus: "CANCELLED", attemptPhase: "CANCELLED" });
    expect(scannerConnection.prepare<[string], { count: number }>(`
      SELECT COUNT(*) AS count FROM generation_events
      WHERE job_id = ? AND event_type = 'job_cancelled_before_submission'
    `).get(seeded.jobId)).toEqual({ count: 1 });
    const next = await attachAndAcquireNextAttempt(seeded);
    expect(next.lease.slotNo).toBe(1);
  });

  it("cancels after slot acquisition inside begin-submission and releases exact capacity", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: NOW + 60_000,
      jobStatus: "CANCEL_REQUESTED",
    });
    await db.update(resourcePoolSlots).set({ expiresAtMs: NOW + 60_000 }).where(and(
      eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
      eq(resourcePoolSlots.slotNo, seeded.lease.slotNo),
    ));

    expect(beginSubmission({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: seeded.workerId,
      jobFencingToken: seeded.jobFencingToken,
    }, {
      resourcePoolId: seeded.poolId,
      slotNo: seeded.lease.slotNo,
      leaseToken: seeded.lease.leaseToken,
      fencingToken: seeded.lease.fencingToken,
      clock: () => NOW,
    }, scannerDb)).toEqual({ status: "cancelled-before-submission" });
    expect(beginSubmission({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: seeded.workerId,
      jobFencingToken: seeded.jobFencingToken,
    }, {
      resourcePoolId: seeded.poolId,
      slotNo: seeded.lease.slotNo,
      leaseToken: seeded.lease.leaseToken,
      fencingToken: seeded.lease.fencingToken,
      clock: () => NOW,
    }, workerDb)).toEqual({ status: "ownership-lost" });

    const state = scannerConnection.prepare<[string], { jobStatus: string; attemptPhase: string; ownerAttemptId: string | null; fencingToken: number }>(`
      SELECT j.status AS jobStatus, a.phase AS attemptPhase,
        s.owner_attempt_id AS ownerAttemptId, s.fencing_token AS fencingToken
      FROM generation_jobs j
      JOIN generation_attempts a ON a.id = j.current_attempt_id
      JOIN resource_pool_slots s ON s.resource_pool_id = a.resource_pool_id AND s.slot_no = 1
      WHERE j.id = ?
    `).get(seeded.jobId);
    expect(state).toEqual({
      jobStatus: "CANCELLED",
      attemptPhase: "CANCELLED",
      ownerAttemptId: null,
      fencingToken: seeded.lease.fencingToken + 1,
    });
    expect(scannerConnection.prepare<[string], { count: number }>(`
      SELECT COUNT(*) AS count FROM generation_events
      WHERE job_id = ? AND event_type = 'job_cancelled_before_submission'
    `).get(seeded.jobId)).toEqual({ count: 1 });
    const next = await attachAndAcquireNextAttempt(seeded);
    expect(next.lease.slotNo).toBe(1);
  });

  it("cancels an owned request before attempt attachment exactly once", async () => {
    const jobId = crypto.randomUUID();
    await db.insert(generationJobs).values({
      id: jobId,
      capability: "image",
      status: "CANCEL_REQUESTED",
      executionSnapshotJson: {},
      inputDigest: "cancel-before-attach",
      currentAttemptId: null,
      claimOwner: "worker-before-attach",
      claimUntilMs: NOW + 60_000,
      claimFencingToken: 21,
      cancelRequestedAtMs: NOW,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });

    expect(cancelBeforeAttempt({
      jobId,
      workerId: "worker-before-attach",
      jobFencingToken: 21,
    }, scannerDb, () => NOW)).toEqual({ status: "applied" });
    expect(cancelBeforeAttempt({
      jobId,
      workerId: "worker-before-attach",
      jobFencingToken: 21,
    }, workerDb, () => NOW)).not.toEqual({ status: "applied" });
    expect(scannerConnection.prepare<[string], { status: string }>(
      "SELECT status FROM generation_jobs WHERE id = ?",
    ).get(jobId)).toEqual({ status: "CANCELLED" });
    expect(scannerConnection.prepare<[string], { count: number }>(`
      SELECT COUNT(*) AS count FROM generation_events
      WHERE job_id = ? AND event_type = 'job_cancelled_before_submission'
    `).get(jobId)).toEqual({ count: 1 });
  });

  it("rolls back attempt and job cancellation when exact slot release loses its CAS", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: NOW + 60_000,
      jobStatus: "CANCEL_REQUESTED",
    });
    await db.update(resourcePoolSlots).set({ expiresAtMs: NOW + 60_000 }).where(and(
      eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
      eq(resourcePoolSlots.slotNo, seeded.lease.slotNo),
    ));
    scannerConnection.exec(`
      CREATE TRIGGER ignore_pre_submission_cancel_slot_update BEFORE UPDATE ON resource_pool_slots
      WHEN OLD.resource_pool_id = '${seeded.poolId}' AND OLD.slot_no = 1
      BEGIN SELECT RAISE(IGNORE); END
    `);

    expect(beginSubmission({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: seeded.workerId,
      jobFencingToken: seeded.jobFencingToken,
    }, {
      resourcePoolId: seeded.poolId,
      slotNo: seeded.lease.slotNo,
      leaseToken: seeded.lease.leaseToken,
      fencingToken: seeded.lease.fencingToken,
      clock: () => NOW,
    }, scannerDb)).toEqual({ status: "lost-race" });

    const state = scannerConnection.prepare<[string], { jobStatus: string; attemptPhase: string; ownerAttemptId: string | null }>(`
      SELECT j.status AS jobStatus, a.phase AS attemptPhase, s.owner_attempt_id AS ownerAttemptId
      FROM generation_jobs j
      JOIN generation_attempts a ON a.id = j.current_attempt_id
      JOIN resource_pool_slots s ON s.resource_pool_id = a.resource_pool_id AND s.slot_no = 1
      WHERE j.id = ?
    `).get(seeded.jobId);
    expect(state).toEqual({
      jobStatus: "CANCEL_REQUESTED",
      attemptPhase: "PREPARING",
      ownerAttemptId: seeded.attemptId,
    });
    expect(scannerConnection.prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM generation_events WHERE job_id = ?",
    ).get(seeded.jobId)).toEqual({ count: 0 });
  });

  it("rolls back attached-attempt cancellation when the job CAS affects zero rows", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: NOW + 60_000,
      jobStatus: "CANCEL_REQUESTED",
    });
    await db.update(resourcePoolSlots).set({
      ownerAttemptId: null,
      leaseToken: null,
      expiresAtMs: null,
    }).where(and(
      eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
      eq(resourcePoolSlots.slotNo, 1),
    ));
    scannerConnection.exec(`
      CREATE TRIGGER ignore_pre_submission_cancel_job_update BEFORE UPDATE ON generation_jobs
      WHEN OLD.id = '${seeded.jobId}'
      BEGIN SELECT RAISE(IGNORE); END
    `);

    expect(cancelBeforeSlot({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: seeded.workerId,
      jobFencingToken: seeded.jobFencingToken,
    }, scannerDb, () => NOW)).toEqual({ status: "lost-race" });
    const state = scannerConnection.prepare<[string], { jobStatus: string; attemptPhase: string }>(`
      SELECT j.status AS jobStatus, a.phase AS attemptPhase
      FROM generation_jobs j JOIN generation_attempts a ON a.id = j.current_attempt_id
      WHERE j.id = ?
    `).get(seeded.jobId);
    expect(state).toEqual({ jobStatus: "CANCEL_REQUESTED", attemptPhase: "PREPARING" });
    expect(scannerConnection.prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM generation_events WHERE job_id = ?",
    ).get(seeded.jobId)).toEqual({ count: 0 });
  });

  it("does not release another identity when cancellation begin loses ownership", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: NOW + 60_000,
      jobStatus: "CANCEL_REQUESTED",
    });
    await db.update(resourcePoolSlots).set({ expiresAtMs: NOW + 60_000 }).where(and(
      eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
      eq(resourcePoolSlots.slotNo, seeded.lease.slotNo),
    ));

    expect(beginSubmission({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: seeded.workerId,
      jobFencingToken: seeded.jobFencingToken,
    }, {
      resourcePoolId: seeded.poolId,
      slotNo: seeded.lease.slotNo,
      leaseToken: "someone-elses-token",
      fencingToken: seeded.lease.fencingToken,
      clock: () => NOW,
    }, scannerDb)).toEqual({ status: "ownership-lost" });
    const [slot] = await db.select().from(resourcePoolSlots).where(eq(resourcePoolSlots.resourcePoolId, seeded.poolId));
    expect(slot.ownerAttemptId).toBe(seeded.attemptId);
  });

  it("retains an unbound production placeholder while its claim is live", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: NOW + 60_000,
    });

    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);
    const outcomes = await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW);

    expect(outcomes).toMatchObject([{ disposition: "retained", reason: "live-job-claim" }]);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot?.ownerAttemptId).toBe(seeded.attemptId);
  });

  it("quarantines an unbound production placeholder when claim expiry is unknown", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: null,
    });

    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);
    const outcomes = await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW);

    expect(outcomes).toMatchObject([{
      disposition: "reconciled",
      reason: "invalid-claim-placeholder",
      jobDisposition: "needs-attention",
    }]);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot?.ownerAttemptId).toBeNull();
  });

  it("releases an unbound production placeholder after its claim owner is cleared", async () => {
    const seeded = await seedProductionPlaceholder({ claimOwner: null, claimUntilMs: null });

    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);
    const outcomes = await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW);

    expect(outcomes).toMatchObject([{ disposition: "reconciled", reason: "pre-submission-placeholder" }]);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot?.ownerAttemptId).toBeNull();
  });

  it("atomically requeues an ownerless production placeholder through the full scanner", async () => {
    const seeded = await seedProductionPlaceholder({ claimOwner: null, claimUntilMs: null });

    const result = await scanExpiredClaims();

    expect(result.requeuedJobs).toContain(seeded.jobId);
    expect(result.releasedSlots).toContainEqual({ poolId: seeded.poolId, slotNo: 1 });
    const job = await db.query.generationJobs.findFirst({ where: eq(generationJobs.id, seeded.jobId) });
    const attempt = await db.query.generationAttempts.findFirst({ where: eq(generationAttempts.id, seeded.attemptId) });
    const slot = await db.query.resourcePoolSlots.findFirst({ where: and(
      eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
      eq(resourcePoolSlots.slotNo, 1),
    ) });
    expect(job).toMatchObject({
      status: "QUEUED",
      claimOwner: null,
      claimUntilMs: null,
      claimFencingToken: seeded.jobFencingToken + 1,
    });
    expect(attempt).toMatchObject({ phase: "ORPHANED", errorCode: "expired_pre_submission_claim" });
    expect(slot).toMatchObject({ ownerAttemptId: null, fencingToken: seeded.lease.fencingToken + 1 });
  });

  it("atomically quarantines and releases a placeholder with an invalid null claim expiry", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: null,
    });

    const result = await scanExpiredClaims();

    expect(result.attentionJobs).toContain(seeded.jobId);
    expect(result.releasedSlots).toContainEqual({ poolId: seeded.poolId, slotNo: 1 });
    const job = await db.query.generationJobs.findFirst({ where: eq(generationJobs.id, seeded.jobId) });
    const attempt = await db.query.generationAttempts.findFirst({ where: eq(generationAttempts.id, seeded.attemptId) });
    const slot = await db.query.resourcePoolSlots.findFirst({ where: and(
      eq(resourcePoolSlots.resourcePoolId, seeded.poolId),
      eq(resourcePoolSlots.slotNo, 1),
    ) });
    expect(job).toMatchObject({
      status: "NEEDS_ATTENTION",
      claimOwner: null,
      claimUntilMs: null,
      claimFencingToken: seeded.jobFencingToken + 1,
      needsAttentionReason: "invalid_claim_lease",
    });
    expect(attempt).toMatchObject({ phase: "ORPHANED", errorCode: "invalid_claim_lease" });
    expect(slot).toMatchObject({ ownerAttemptId: null, fencingToken: seeded.lease.fencingToken + 1 });
    expect(scannerConnection.prepare<[string], { count: number }>(`
      SELECT COUNT(*) AS count FROM generation_jobs
      WHERE id = ? AND status IN ('RUNNING', 'CANCEL_REQUESTED')
        AND (claim_owner IS NULL OR claim_until_ms IS NULL)
    `).get(seeded.jobId)).toEqual({ count: 0 });
  });

  it("atomically cancels an ownerless cancellation placeholder and emits one terminal event", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: null,
      claimUntilMs: null,
      jobStatus: "CANCEL_REQUESTED",
    });

    const result = await scanExpiredClaims();

    expect(result.cancelledJobs).toContain(seeded.jobId);
    expect(result.releasedSlots).toContainEqual({ poolId: seeded.poolId, slotNo: 1 });
    const job = await db.query.generationJobs.findFirst({ where: eq(generationJobs.id, seeded.jobId) });
    const attempt = await db.query.generationAttempts.findFirst({ where: eq(generationAttempts.id, seeded.attemptId) });
    const events = await db.select().from(generationEvents).where(and(
      eq(generationEvents.jobId, seeded.jobId),
      eq(generationEvents.eventType, "job_cancelled"),
    ));
    expect(job).toMatchObject({ status: "CANCELLED", claimFencingToken: seeded.jobFencingToken + 1 });
    expect(attempt).toMatchObject({ phase: "CANCELLED" });
    expect(events).toHaveLength(1);
  });

  it("retains malformed placeholder-like identity instead of treating it as unbound", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: NOW - 1,
    });
    await db.update(generationAttempts).set({
      resourceLeaseToken: `pending-not-${seeded.attemptId}`,
    }).where(eq(generationAttempts.id, seeded.attemptId));

    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);
    const outcomes = await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW);

    expect(outcomes).toMatchObject([{ disposition: "retained", reason: "slot-changed" }]);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot?.ownerAttemptId).toBe(seeded.attemptId);
  });

  it("allows only one scanner to release an expired production placeholder", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: "worker-placeholder",
      claimUntilMs: NOW - 1,
    });
    const [leftCandidates, rightCandidates] = await Promise.all([
      readExpiredSlotCandidates(NOW, scannerDb),
      readExpiredSlotCandidates(NOW, workerDb),
    ]);

    const [left, right] = await Promise.all([
      applyExpiredSlotCandidates(leftCandidates, scannerDb, () => NOW),
      applyExpiredSlotCandidates(rightCandidates, workerDb, () => NOW),
    ]);

    expect([...left, ...right].filter((outcome) => outcome.disposition === "reconciled")).toHaveLength(1);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null; fencingToken: number }>(
      "SELECT owner_attempt_id AS ownerAttemptId, fencing_token AS fencingToken FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot).toEqual({ ownerAttemptId: null, fencingToken: seeded.lease.fencingToken + 1 });
    expect([...left, ...right].filter((outcome) => outcome.jobDisposition === "requeued")).toHaveLength(1);
    const state = scannerConnection.prepare<[string, string], {
      status: string;
      claimFencingToken: number;
      currentAttemptId: string | null;
      phase: string;
    }>(`
      SELECT j.status, j.claim_fencing_token AS claimFencingToken,
        j.current_attempt_id AS currentAttemptId,
        (SELECT phase FROM generation_attempts WHERE id = ?) AS phase
      FROM generation_jobs j WHERE j.id = ?
    `).get(seeded.attemptId, seeded.jobId);
    expect(state).toEqual({
      status: "QUEUED",
      claimFencingToken: seeded.jobFencingToken + 1,
      currentAttemptId: null,
      phase: "ORPHANED",
    });
  });

  it("allows dual scanners to cancel a placeholder and emit its terminal event exactly once", async () => {
    const seeded = await seedProductionPlaceholder({
      claimOwner: null,
      claimUntilMs: null,
      jobStatus: "CANCEL_REQUESTED",
    });
    const [leftCandidates, rightCandidates] = await Promise.all([
      readExpiredSlotCandidates(NOW, scannerDb),
      readExpiredSlotCandidates(NOW, workerDb),
    ]);

    const [left, right] = await Promise.all([
      applyExpiredSlotCandidates(leftCandidates, scannerDb, () => NOW),
      applyExpiredSlotCandidates(rightCandidates, workerDb, () => NOW),
    ]);

    expect([...left, ...right].filter((outcome) => outcome.jobDisposition === "cancelled")).toHaveLength(1);
    expect(scannerConnection.prepare<[string], { count: number }>(`
      SELECT COUNT(*) AS count FROM generation_events
      WHERE job_id = ? AND event_type = 'job_cancelled'
    `).get(seeded.jobId)).toEqual({ count: 1 });
    const state = scannerConnection.prepare<[string], { status: string; phase: string; ownerAttemptId: string | null }>(`
      SELECT j.status, a.phase, s.owner_attempt_id AS ownerAttemptId
      FROM generation_jobs j
      JOIN generation_attempts a ON a.id = j.current_attempt_id
      JOIN resource_pool_slots s ON s.resource_pool_id = a.resource_pool_id AND s.slot_no = 1
      WHERE j.id = ?
    `).get(seeded.jobId);
    expect(state).toEqual({ status: "CANCELLED", phase: "CANCELLED", ownerAttemptId: null });
  });

  it("quarantines a current pre-submission attempt when a claim owner has no expiry evidence", async () => {
    const seeded = await seedExpiredSlot({
      phase: "PREPARING",
      jobStatus: "RUNNING",
      claimOwner: "worker-owner-without-expiry",
      claimUntilMs: null,
      claimFencingToken: 9,
    });

    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);
    const outcomes = await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW);

    expect(outcomes).toMatchObject([{
      disposition: "reconciled",
      reason: "invalid-claim-placeholder",
      jobDisposition: "needs-attention",
    }]);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot?.ownerAttemptId).toBeNull();
  });

  it("prevents submission when the scanner releases the expired lease first", async () => {
    const seeded = await seedExpiredSlot({
      phase: "PREPARING",
      jobStatus: "RUNNING",
      claimOwner: "worker-old",
      claimUntilMs: NOW - 1,
      claimFencingToken: 9,
    });
    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);

    const scanner = await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW);
    const worker = beginSubmission({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: "worker-old",
      jobFencingToken: 9,
    }, {
      resourcePoolId: seeded.poolId,
      slotNo: 1,
      leaseToken: seeded.leaseToken,
      fencingToken: seeded.fencingToken,
      clock: () => NOW,
    }, workerDb);

    expect(scanner).toMatchObject([{ disposition: "reconciled" }]);
    expect(worker).toEqual({ status: "ownership-lost" });
    const attempt = workerConnection.prepare<[string], { phase: string }>(
      "SELECT phase FROM generation_attempts WHERE id = ?",
    ).get(seeded.attemptId);
    expect(attempt?.phase).toBe("ORPHANED");
    const job = workerConnection.prepare<[string], { status: string; claimOwner: string | null; claimUntilMs: number | null }>(
      "SELECT status, claim_owner AS claimOwner, claim_until_ms AS claimUntilMs FROM generation_jobs WHERE id = ?",
    ).get(seeded.jobId);
    expect(job).toEqual({ status: "QUEUED", claimOwner: null, claimUntilMs: null });
  });

  it("prevents the scanner from releasing after the worker renews and crosses submission atomically", async () => {
    const seeded = await seedExpiredSlot({
      phase: "PREPARING",
      jobStatus: "RUNNING",
      claimOwner: "worker-live",
      claimUntilMs: NOW + 60_000,
      claimFencingToken: 9,
    });
    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);
    workerConnection.prepare(`
      UPDATE resource_pool_slots SET expires_at_ms = ?, updated_at_ms = ?
      WHERE resource_pool_id = ? AND slot_no = 1 AND owner_attempt_id = ?
        AND lease_token = ? AND fencing_token = ?
    `).run(
      NOW + 120_000, NOW, seeded.poolId, seeded.attemptId,
      seeded.leaseToken, seeded.fencingToken,
    );

    const worker = beginSubmission({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: "worker-live",
      jobFencingToken: 9,
    }, {
      resourcePoolId: seeded.poolId,
      slotNo: 1,
      leaseToken: seeded.leaseToken,
      fencingToken: seeded.fencingToken,
      clock: () => NOW,
    }, workerDb);
    const scanner = await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW);

    expect(worker).toEqual({ status: "applied" });
    expect(scanner).toMatchObject([{ disposition: "retained" }]);
    const state = scannerConnection.prepare<[string], { phase: string; ownerAttemptId: string | null }>(`
      SELECT a.phase, s.owner_attempt_id AS ownerAttemptId
      FROM generation_attempts a
      JOIN resource_pool_slots s ON s.owner_attempt_id = a.id
      WHERE a.id = ?
    `).get(seeded.attemptId);
    expect(state).toEqual({ phase: "SUBMITTING", ownerAttemptId: seeded.attemptId });
  });

  it("prevents an old worker from submitting after a new attempt acquires the released slot", async () => {
    const seeded = await seedExpiredSlot({
      phase: "PREPARING",
      jobStatus: "RUNNING",
      claimOwner: "worker-old",
      claimUntilMs: NOW - 1,
      claimFencingToken: 9,
    });
    const candidates = await readExpiredSlotCandidates(NOW, scannerDb);
    expect(await applyExpiredSlotCandidates(candidates, scannerDb, () => NOW))
      .toMatchObject([{ disposition: "reconciled" }]);

    const newJobId = crypto.randomUUID();
    const newAttemptId = crypto.randomUUID();
    const currentNow = Date.now();
    await db.insert(generationJobs).values({
      id: newJobId,
      capability: "image",
      status: "RUNNING",
      executionSnapshotJson: {},
      inputDigest: "new-owner",
      currentAttemptId: newAttemptId,
      claimOwner: "worker-new",
      claimUntilMs: currentNow + 60_000,
      claimFencingToken: 10,
      createdAtMs: currentNow,
      updatedAtMs: currentNow,
    });
    await db.insert(generationAttempts).values({
      id: newAttemptId,
      jobId: newJobId,
      attemptNo: 1,
      jobClaimFencingToken: 10,
      phase: "PREPARING",
      backendId: seeded.backendId,
      backendFeatureSnapshotJson: {},
      environmentFingerprint: "env:new-owner",
      submissionCorrelationId: `corr-${newAttemptId}`,
      externalIdStrategy: "server-assigned",
      systemOutputPrefix: `prefix-${newAttemptId}`,
      resourcePoolId: seeded.poolId,
      resourceSlotNo: 0,
      resourceLeaseToken: `pending-${newAttemptId}`,
      resourceFencingToken: 0,
      createdAtMs: currentNow,
      updatedAtMs: currentNow,
    });
    const newLease = await acquireResourceSlot(seeded.poolId, newAttemptId, "worker-new");
    expect(newLease).not.toBeNull();

    const oldWorker = beginSubmission({
      jobId: seeded.jobId,
      attemptId: seeded.attemptId,
      workerId: "worker-old",
      jobFencingToken: 9,
    }, {
      resourcePoolId: seeded.poolId,
      slotNo: 1,
      leaseToken: seeded.leaseToken,
      fencingToken: seeded.fencingToken,
      clock: () => currentNow,
    }, workerDb);

    expect(oldWorker).toEqual({ status: "ownership-lost" });
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot?.ownerAttemptId).toBe(newAttemptId);
  });

  it("releases an uncertain slot exactly once only with matching durable termination proof", async () => {
    const seeded = await seedExpiredSlot({
      phase: "ORPHANED",
      jobStatus: "NEEDS_ATTENTION",
      externalJobId: "external-cancelled",
    });
    insertMatchingProof(seeded);

    const first = await scanExpiredClaims();
    const second = await scanExpiredClaims();

    expect(first.releasedSlots).toEqual([{ poolId: seeded.poolId, slotNo: 1 }]);
    expect(second.releasedSlots).toEqual([]);
    const proof = scannerConnection.prepare<[], { disposition: string; reconciledAtMs: number | null }>(
      "SELECT disposition, reconciled_at_ms AS reconciledAtMs FROM resource_reconciliation_proofs",
    ).get();
    expect(proof?.disposition).toBe("reconciled");
    expect(proof?.reconciledAtMs).toBeGreaterThan(0);
  });

  it("allows only one of two scanners to reconcile a proven slot", async () => {
    const seeded = await seedExpiredSlot({
      phase: "ORPHANED",
      jobStatus: "NEEDS_ATTENTION",
      externalJobId: "external-cancelled",
    });
    insertMatchingProof(seeded);
    const [leftCandidates, rightCandidates] = await Promise.all([
      readExpiredSlotCandidates(NOW, scannerDb),
      readExpiredSlotCandidates(NOW, workerDb),
    ]);

    const [left, right] = await Promise.all([
      applyExpiredSlotCandidates(leftCandidates, scannerDb, () => NOW),
      applyExpiredSlotCandidates(rightCandidates, workerDb, () => NOW),
    ]);

    expect([...left, ...right].filter((outcome) => outcome.disposition === "reconciled")).toHaveLength(1);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null; fencingToken: number }>(
      `SELECT owner_attempt_id AS ownerAttemptId, fencing_token AS fencingToken
       FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1`,
    ).get(seeded.poolId);
    expect(slot).toEqual({ ownerAttemptId: null, fencingToken: seeded.fencingToken + 1 });
    const proof = scannerConnection.prepare<[], { disposition: string }>(
      "SELECT disposition FROM resource_reconciliation_proofs",
    ).get();
    expect(proof?.disposition).toBe("reconciled");
    expect(scannerConnection.prepare("SELECT COUNT(*) AS count FROM resource_pool_slots WHERE owner_attempt_id IS NOT NULL")
      .get()).toEqual({ count: 0 });
  });

  it("releases a FAILED attempt only when the backend history explicitly proves termination", async () => {
    const seeded = await seedExpiredSlot({
      phase: "FAILED",
      jobStatus: "FAILED",
      externalJobId: "external-history-failed",
    });
    insertMatchingProof(seeded, "history-failed", "external-history-failed");

    const result = await scanExpiredClaims();

    expect(result.releasedSlots).toEqual([{ poolId: seeded.poolId, slotNo: 1 }]);
  });

  it("retains a locally FAILED or unknown execution without backend terminal history", async () => {
    const seeded = await seedExpiredSlot({
      phase: "FAILED",
      jobStatus: "FAILED",
      externalJobId: "external-local-or-unknown-failure",
    });

    const result = await scanExpiredClaims();

    expect(result.releasedSlots).toEqual([]);
    const slot = scannerConnection.prepare<[string], { ownerAttemptId: string | null }>(
      "SELECT owner_attempt_id AS ownerAttemptId FROM resource_pool_slots WHERE resource_pool_id = ? AND slot_no = 1",
    ).get(seeded.poolId);
    expect(slot?.ownerAttemptId).toBe(seeded.attemptId);
  });

  it("records only current attempt evidence and treats a repeated observation as idempotent", async () => {
    const seeded = await seedExpiredSlot({
      phase: "FAILED",
      jobStatus: "FAILED",
      externalJobId: "external-idempotent-proof",
    });
    const proof = {
      attemptId: seeded.attemptId,
      backendId: seeded.backendId,
      externalJobId: "external-idempotent-proof",
      proofKind: "history-failed" as const,
      observedAtMs: NOW - 100,
      resourcePoolId: seeded.poolId,
      resourceSlotNo: 1,
      resourceLeaseToken: seeded.leaseToken,
      resourceFencingToken: seeded.fencingToken,
    };

    expect(recordResourceTerminationProof(proof, scannerDb, () => NOW)).toBe(true);
    expect(recordResourceTerminationProof({ ...proof, observedAtMs: NOW - 50 }, workerDb, () => NOW)).toBe(true);
    expect(recordResourceTerminationProof({ ...proof, externalJobId: "wrong-external-id" }, scannerDb, () => NOW))
      .toBe(false);
    expect(scannerConnection.prepare("SELECT COUNT(*) AS count FROM resource_reconciliation_proofs").get())
      .toEqual({ count: 1 });
  });
});
