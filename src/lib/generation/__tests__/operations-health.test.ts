import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, getSqlite } from "@/lib/db";
import {
  executionBackends,
  generationAttempts,
  generationJobs,
  resourcePools,
  resourcePoolSlots,
} from "@/lib/db/schema";
import { setupTestDb, type TestDbContext } from "@/lib/test-helpers/db";
import {
  acknowledgeOperationalAlert,
  listOperationalAlerts,
  refreshOperationalHealth,
} from "../operations-health";

let context: TestDbContext;

beforeAll(async () => {
  context = setupTestDb();
  await db.insert(resourcePools).values({
    id: "health-pool",
    displayName: "Health pool",
    capacity: 1,
    policyJson: {},
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  await db.insert(executionBackends).values({
    id: "health-backend",
    displayName: "Health backend",
    adapterKind: "comfyui",
    baseUrl: "http://127.0.0.1:8000",
    topology: "same-host",
    sharingMode: "dedicated",
    authType: "none",
    authConfigJson: {},
    tlsConfigJson: {},
    networkPolicyJson: {},
    resourcePoolId: "health-pool",
    capabilitiesJson: ["image"],
    enabled: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  await db.insert(generationJobs).values({
    id: "health-job",
    projectId: "health-project",
    capability: "image",
    status: "NEEDS_ATTENTION",
    executionSnapshotJson: {},
    inputDigest: `sha256:${"a".repeat(64)}`,
    metadataJson: { traceId: "trace-health-job" },
    currentAttemptId: "health-attempt",
    claimFencingToken: 1,
    createdAtMs: 100,
    updatedAtMs: 200,
  });
  await db.insert(generationAttempts).values({
    id: "health-attempt",
    jobId: "health-job",
    attemptNo: 1,
    jobClaimFencingToken: 1,
    phase: "SUBMISSION_UNKNOWN",
    backendId: "health-backend",
    backendFeatureSnapshotJson: {},
    environmentFingerprint: "env-health",
    submissionCorrelationId: "trace-health-job.attempt-health-attempt",
    externalIdStrategy: "server-assigned",
    systemOutputPrefix: "ai-m/health-job/1",
    errorCode: "resource_lease_lost",
    resourcePoolId: "health-pool",
    resourceSlotNo: 0,
    resourceLeaseToken: "health-lease",
    resourceFencingToken: 1,
    createdAtMs: 100,
    updatedAtMs: 200,
  });
  await db.insert(resourcePoolSlots).values({
    resourcePoolId: "health-pool",
    slotNo: 0,
    ownerAttemptId: "health-attempt",
    leaseToken: "health-lease",
    fencingToken: 1,
    expiresAtMs: 500,
    updatedAtMs: 200,
  });
});

afterAll(() => context.cleanup());

describe("operational health", () => {
  it("collects bounded metrics and opens deterministic alerts", () => {
    const result = refreshOperationalHealth({ diskUsageRatio: 0.96, nowMs: 1_000 });
    expect(result.metrics).toMatchObject({
      submissionUnknownCount: 1,
      retainedSlotCount: 1,
      expiredSlotCount: 1,
      leaseLossCount24h: 1,
      diskUsageRatio: 0.96,
    });
    expect(result.metrics.attemptElapsedMsByPhase.SUBMISSION_UNKNOWN).toEqual({
      count: 1,
      average: 900,
      maximum: 900,
    });
    expect(result.alerts.filter((alert) => alert.status === "OPEN").map((alert) => alert.alertKey))
      .toEqual(expect.arrayContaining(["submission-unknown", "lease-loss", "disk-high-watermark"]));
    expect(result.alerts.find((alert) => alert.alertKey === "disk-high-watermark"))
      .toMatchObject({ severity: "critical", detailsSafeJson: { usagePermille: 960 } });
    const unavailable = refreshOperationalHealth({ diskUsageRatio: null, nowMs: 1_050 });
    expect(unavailable.alerts.find((alert) => alert.alertKey === "disk-high-watermark"))
      .toMatchObject({ status: "OPEN", lastSeenAtMs: 1_000 });
  });

  it("acknowledges with evidence without mutating the underlying signal", () => {
    expect(acknowledgeOperationalAlert({
      alertKey: "submission-unknown",
      actorId: "operator-health",
      reasonCode: "investigating",
      evidenceRefs: ["ticket:OPS-68"],
      acknowledgedAtMs: 1_100,
    })).toEqual({
      acknowledged: true,
      alertKey: "submission-unknown",
      signalStateUnchanged: true,
    });
    expect(listOperationalAlerts().find((alert) => alert.alertKey === "submission-unknown"))
      .toMatchObject({
        status: "ACKNOWLEDGED",
        acknowledgedBy: "operator-health",
        evidenceRefsJson: ["ticket:OPS-68"],
      });
    expect(getSqlite().prepare(
      "SELECT phase FROM generation_attempts WHERE id='health-attempt'",
    ).get()).toEqual({ phase: "SUBMISSION_UNKNOWN" });
    expect(getSqlite().prepare(
      "SELECT action, target_type AS targetType FROM audit_events WHERE target_id='submission-unknown'",
    ).get()).toEqual({
      action: "operational_alert.acknowledged",
      targetType: "operational_alert",
    });
  });

  it("automatically resolves cleared signals and reopens only on a new occurrence", async () => {
    await db.delete(resourcePoolSlots);
    getSqlite().prepare(`
      UPDATE generation_attempts
      SET phase='FAILED', error_code=NULL, finished_at_ms=1200, updated_at_ms=1200
      WHERE id='health-attempt'
    `).run();
    const cleared = refreshOperationalHealth({ diskUsageRatio: 0.2, nowMs: 2_000 });
    expect(cleared.alerts.every((alert) => alert.status === "RESOLVED")).toBe(true);
    expect(() => acknowledgeOperationalAlert({
      alertKey: "submission-unknown",
      actorId: "operator-health",
      reasonCode: "investigating",
      evidenceRefs: ["ticket:OPS-69"],
      acknowledgedAtMs: 2_100,
    })).toThrow(/resolved/i);

    getSqlite().prepare(`
      UPDATE generation_attempts
      SET phase='SUBMISSION_UNKNOWN', updated_at_ms=2200
      WHERE id='health-attempt'
    `).run();
    const reopened = refreshOperationalHealth({ diskUsageRatio: 0.2, nowMs: 2_300 });
    expect(reopened.alerts.find((alert) => alert.alertKey === "submission-unknown"))
      .toMatchObject({
        status: "OPEN",
        acknowledgedAtMs: null,
        acknowledgedBy: null,
        resolvedAtMs: null,
      });
  });
});
