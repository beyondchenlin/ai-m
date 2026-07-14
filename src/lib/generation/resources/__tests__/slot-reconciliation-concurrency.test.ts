import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import {
  executionBackends,
  generationAttempts,
  generationJobs,
  resourcePools,
  resourcePoolSlots,
} from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import {
  applyExpiredSlotCandidates,
  recordResourceTerminationProof,
  readExpiredSlotCandidates,
  scanExpiredClaims,
} from "../leases";

const NOW = 1_780_000_000_000;

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
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    await db.insert(generationAttempts).values({
      id: attemptId,
      jobId,
      attemptNo: 1,
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
