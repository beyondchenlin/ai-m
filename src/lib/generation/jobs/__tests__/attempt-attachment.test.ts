import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { db } from "@/lib/db";
import { executionBackends, generationAttempts, generationJobs, resourcePools } from "@/lib/db/schema";
import { terminateChildProcess, waitForChildExit, waitForIpcMessage } from "@/lib/test-helpers/child-process";
import { setupTestDb } from "@/lib/test-helpers/db";
import { attachOwnedAttempt } from "../state-transitions";

describe("owned attempt attachment", () => {
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
    secondConnection.exec("DROP TRIGGER IF EXISTS ignore_attempt_attachment");
    await db.delete(generationAttempts);
    await db.delete(generationJobs);
    await db.delete(executionBackends);
    await db.delete(resourcePools);
  });

  async function seedOwnedJob() {
    const now = 1_750_000_000_000;
    const poolId = crypto.randomUUID();
    const backendId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    await db.insert(resourcePools).values({
      id: poolId, displayName: "attach-pool", capacity: 1, policyJson: {}, createdAtMs: now, updatedAtMs: now,
    });
    await db.insert(executionBackends).values({
      id: backendId,
      displayName: "attach-backend",
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
      status: "RUNNING",
      executionSnapshotJson: {},
      inputDigest: "attach-race",
      currentAttemptId: null,
      claimOwner: "worker-a",
      claimUntilMs: now + 1_000,
      claimFencingToken: 13,
      createdAtMs: now,
      updatedAtMs: now,
    });
    return { now, poolId, backendId, jobId };
  }

  function attemptValues(input: {
    now: number;
    poolId: string;
    backendId: string;
    jobId: string;
    attemptId: string;
  }): typeof generationAttempts.$inferInsert {
    return {
      id: input.attemptId,
      jobId: input.jobId,
      attemptNo: 1,
      jobClaimFencingToken: 13,
      phase: "PREPARING",
      backendId: input.backendId,
      backendFeatureSnapshotJson: {},
      environmentFingerprint: "env:attach",
      submissionCorrelationId: `corr-${input.attemptId}`,
      externalIdStrategy: "server-assigned",
      systemOutputPrefix: `prefix-${input.attemptId}`,
      resourcePoolId: input.poolId,
      resourceSlotNo: 0,
      resourceLeaseToken: `pending-${input.attemptId}`,
      resourceFencingToken: 0,
      createdAtMs: input.now,
      updatedAtMs: input.now,
    };
  }

  it("allows one of two WAL writers to attach and leaves no loser attempt", async () => {
    const seeded = await seedOwnedJob();
    const firstAttemptId = crypto.randomUUID();
    const secondAttemptId = crypto.randomUUID();
    const fixture = path.join(__dirname, "fixtures", "attach-attempt-writer.ts");
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const launch = (attemptId: string) => spawn(process.execPath, [
      tsxCli,
      fixture,
      seeded.jobId,
      attemptId,
      seeded.poolId,
      seeded.backendId,
      String(seeded.now),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${ctx.dbPath}` },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const firstWriter = launch(firstAttemptId);
    const secondWriter = launch(secondAttemptId);
    const writers: ChildProcess[] = [firstWriter, secondWriter];
    try {
      await Promise.all(writers.map((child) => waitForIpcMessage<{ ready: true }>(child)));
      const firstResult = waitForIpcMessage<Record<string, unknown>>(firstWriter, 10_000);
      const secondResult = waitForIpcMessage<Record<string, unknown>>(secondWriter, 10_000);
      firstWriter.send({ go: true });
      secondWriter.send({ go: true });
      const [firstMessage, secondMessage] = await Promise.all([firstResult, secondResult]);
      if (typeof firstMessage.error === "string") throw new Error(`first WAL writer failed: ${firstMessage.error}`);
      if (typeof secondMessage.error === "string") throw new Error(`second WAL writer failed: ${secondMessage.error}`);
      const first = firstMessage.result as { status: string } | undefined;
      const second = secondMessage.result as { status: string } | undefined;
      if (!first || !second) throw new Error("WAL writer returned an invalid result");

      await Promise.all(writers.map((child) => waitForChildExit(child)));
      expect([first.status, second.status].sort()).toEqual(["applied", "ownership-lost"]);
      const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, seeded.jobId));
      const attempts = await db.select().from(generationAttempts).where(eq(generationAttempts.jobId, seeded.jobId));
      const winnerId = attempts[0]?.id;
      expect(job.currentAttemptId).toBe(winnerId);
      expect(attempts).toHaveLength(1);
      expect([firstAttemptId, secondAttemptId]).toContain(winnerId);
    } finally {
      await Promise.allSettled(writers.map((child) => terminateChildProcess(child)));
    }
  }, 20_000);

  it("rolls back the inserted attempt when binding the job affects zero rows", async () => {
    const seeded = await seedOwnedJob();
    const attemptId = crypto.randomUUID();
    secondConnection.exec(`
      CREATE TRIGGER ignore_attempt_attachment BEFORE UPDATE ON generation_jobs
      WHEN OLD.id = '${seeded.jobId}'
      BEGIN SELECT RAISE(IGNORE); END
    `);

    const result = attachOwnedAttempt({
      jobId: seeded.jobId,
      workerId: "worker-a",
      jobFencingToken: 13,
    }, {
      clock: () => seeded.now,
      attempt: attemptValues({ ...seeded, attemptId }),
    });

    expect(result).toEqual({ status: "lost-race" });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, seeded.jobId));
    const attempts = await db.select().from(generationAttempts).where(eq(generationAttempts.jobId, seeded.jobId));
    expect(job.currentAttemptId).toBeNull();
    expect(attempts).toHaveLength(0);
  });

  it("rejects attempt attachment at the exact job-claim expiry boundary", async () => {
    const seeded = await seedOwnedJob();
    await db.update(generationJobs).set({ claimUntilMs: seeded.now })
      .where(eq(generationJobs.id, seeded.jobId));

    const result = attachOwnedAttempt({
      jobId: seeded.jobId,
      workerId: "worker-a",
      jobFencingToken: 13,
    }, {
      clock: () => seeded.now,
      attempt: attemptValues({ ...seeded, attemptId: crypto.randomUUID() }),
    });

    expect(result).toEqual({ status: "ownership-lost" });
    expect(await db.select().from(generationAttempts)
      .where(eq(generationAttempts.jobId, seeded.jobId))).toHaveLength(0);
  });
});
