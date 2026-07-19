import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, getSqlite } from "@/lib/db";
import {
  defaultGenerationProfilePointers,
  executionBackends,
  generationProfileRevisions,
  generationProfileStates,
  resourcePools,
  workflowPackageRevisions,
  workflowPackageStates,
} from "@/lib/db/schema";
import { setupTestDb, type TestDbContext } from "@/lib/test-helpers/db";
import { recordWorkflowApproval, revokeWorkflowPackage } from "../approval-service";
import {
  authenticatedOperatorActorId,
  type AuthenticatedLocalOperator,
  windowsTokenContextDigest,
  windowsTokenOperator,
} from "@/lib/security/authenticated-local-operator";

const workflowDigest = `sha256:${"a".repeat(64)}`;
const environmentLockDigest = `sha256:${"b".repeat(64)}`;
const environmentFingerprint = `sha256:${"c".repeat(64)}`;
const backendId = "approval-backend";
const importer = "windows-sid:S-1-5-21-100";

let context: TestDbContext;

beforeEach(async () => {
  context = setupTestDb();
  const now = 1;
  await db.insert(resourcePools).values({
    id: "approval-pool",
    displayName: "Approval pool",
    capacity: 1,
    policyJson: {},
    createdAtMs: now,
    updatedAtMs: now,
  });
  await db.insert(executionBackends).values({
    id: backendId,
    displayName: "Approval backend",
    adapterKind: "comfyui",
    baseUrl: "http://127.0.0.1:8000",
    topology: "same-host",
    sharingMode: "dedicated",
    authType: "none",
    authConfigJson: {},
    tlsConfigJson: {},
    networkPolicyJson: {},
    resourcePoolId: "approval-pool",
    capabilitiesJson: ["image"],
    enabled: 0,
    createdAtMs: now,
    updatedAtMs: now,
  });
  await db.insert(workflowPackageRevisions).values({
    digest: workflowDigest,
    workflowId: "approval.workflow",
    version: "1.0.0",
    capability: "image",
    workflowApiJson: {},
    manifestJson: {},
    compiledBindingsJson: {},
    packageLockJson: {},
    packagePath: "immutable/package",
    workflowSha256: `sha256:${"d".repeat(64)}`,
    environmentLockDigest,
    compilerVersion: "test",
    compiledAtMs: now,
    createdAtMs: now,
  });
  await db.insert(workflowPackageStates).values({
    workflowPackageDigest: workflowDigest,
    state: "installed",
    validationReportJson: { importedBy: importer, importedAtMs: now },
    updatedAtMs: now,
  });
});

afterEach(() => context.cleanup());

function approve(reviewerId: string, approvedAtMs: number) {
  return recordWorkflowApproval({
    workflowPackageDigest: workflowDigest,
    executionBackendId: backendId,
    reviewer: windowsTokenOperator(reviewerId),
    environmentFingerprint,
    environmentLockDigest,
    validationReport: { liveProbe: true },
    approvedAtMs,
  });
}

describe("workflow two-person approval", () => {
  it("rejects a structurally valid operator object that was not issued from a token resolver", () => {
    const subjectId = "S-1-5-21-999";
    const forged = {
      subjectId,
      issuer: "windows-local-token",
      authenticationContextDigest: windowsTokenContextDigest(subjectId),
    } as AuthenticatedLocalOperator;
    expect(() => authenticatedOperatorActorId(forged)).toThrow(/context is invalid/i);
    expect(() => recordWorkflowApproval({
      workflowPackageDigest: workflowDigest,
      executionBackendId: backendId,
      reviewer: forged,
      environmentFingerprint,
      environmentLockDigest,
      validationReport: {},
      approvedAtMs: 9,
    })).toThrow(/context is invalid/i);
  });

  it("keeps the package reviewed after one reviewer and activates after a distinct second reviewer", () => {
    expect(approve("S-1-5-21-101", 10)).toMatchObject({
      state: "reviewed",
      approvalCount: 1,
      inserted: true,
    });
    expect(approve("S-1-5-21-101", 11)).toMatchObject({
      state: "reviewed",
      approvalCount: 1,
      inserted: false,
    });
    expect(approve("S-1-5-21-102", 12)).toMatchObject({
      state: "active",
      approvalCount: 2,
      reviewers: ["windows-sid:S-1-5-21-101", "windows-sid:S-1-5-21-102"],
    });
    expect(getSqlite().prepare(
      "SELECT state FROM workflow_package_states WHERE workflow_package_digest=?",
    ).get(workflowDigest)).toEqual({ state: "active" });
    expect(() => getSqlite().prepare(
      "UPDATE workflow_package_approvals SET reviewer_id='tampered' WHERE workflow_package_digest=?",
    ).run(workflowDigest)).toThrow(/immutable/i);
    expect(() => getSqlite().prepare(
      "DELETE FROM workflow_package_approvals WHERE workflow_package_digest=?",
    ).run(workflowDigest)).toThrow(/immutable/i);
  });

  it("rejects importer self-review and requires fresh approvals after environment drift", () => {
    expect(() => approve("S-1-5-21-100", 10)).toThrow(/differ.*importer/i);
    approve("S-1-5-21-101", 10);
    expect(recordWorkflowApproval({
      workflowPackageDigest: workflowDigest,
      executionBackendId: backendId,
      reviewer: windowsTokenOperator("S-1-5-21-101"),
      environmentFingerprint: "changed",
      environmentLockDigest,
      validationReport: {},
      approvedAtMs: 11,
    })).toMatchObject({ state: "reviewed", approvalCount: 1, inserted: true });
  });

  it("does not count legacy or forged text identities toward the two-person threshold", () => {
    getSqlite().prepare(`
      INSERT INTO workflow_package_approvals
        (id, workflow_package_digest, execution_backend_id, reviewer_id,
         environment_fingerprint, environment_lock_digest,
         validation_report_json, approved_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-approval",
      workflowDigest,
      backendId,
      "reviewer-from-environment",
      environmentFingerprint,
      environmentLockDigest,
      JSON.stringify({ liveProbe: true }),
      9,
    );
    expect(approve("S-1-5-21-101", 10)).toMatchObject({
      state: "reviewed",
      approvalCount: 1,
      reviewers: ["windows-sid:S-1-5-21-101"],
    });
  });

  it("rejects approval when importer provenance predates authenticated token identities", () => {
    getSqlite().prepare(`
      UPDATE workflow_package_states
      SET validation_report_json=?
      WHERE workflow_package_digest=?
    `).run(JSON.stringify({ importedBy: "local-admin", importedAtMs: 1 }), workflowDigest);
    expect(() => approve("S-1-5-21-101", 10)).toThrow(/importer lacks authenticated/i);
  });

  it("revokes new use, disables profiles and defaults, and retains immutable approvals", async () => {
    approve("S-1-5-21-101", 10);
    approve("S-1-5-21-102", 11);
    await db.insert(generationProfileRevisions).values({
      id: "profile-revision",
      profileKey: "approval-profile",
      revisionNo: 1,
      revisionDigest: `sha256:${"e".repeat(64)}`,
      displayName: "Approval profile",
      capability: "image",
      adapterKind: "comfyui",
      executionBackendId: backendId,
      workflowPackageDigest: workflowDigest,
      configJson: {},
      createdBy: "reviewer-b",
      createdAtMs: 11,
    });
    await db.insert(generationProfileStates).values({
      generationProfileRevisionId: "profile-revision",
      enabled: 1,
      visibility: "workspace",
      updatedAtMs: 11,
    });
    await db.insert(defaultGenerationProfilePointers).values({
      scopeType: "global",
      scopeId: "default",
      capability: "image",
      generationProfileRevisionId: "profile-revision",
      updatedBy: "reviewer-b",
      updatedAtMs: 11,
    });

    expect(revokeWorkflowPackage({
      workflowPackageDigest: workflowDigest,
      actorId: "security-reviewer",
      reason: "Controlled revocation test",
      revokedAtMs: 20,
    })).toEqual({ revoked: true, disabledProfileCount: 1 });
    expect(getSqlite().prepare(
      "SELECT state FROM workflow_package_states WHERE workflow_package_digest=?",
    ).get(workflowDigest)).toEqual({ state: "revoked" });
    expect(getSqlite().prepare(
      "SELECT enabled, revoked_at_ms AS revokedAtMs FROM generation_profile_states WHERE generation_profile_revision_id='profile-revision'",
    ).get()).toEqual({ enabled: 0, revokedAtMs: 20 });
    expect(getSqlite().prepare("SELECT COUNT(*) AS count FROM default_generation_profile_pointers").get())
      .toEqual({ count: 0 });
    expect(getSqlite().prepare("SELECT COUNT(*) AS count FROM workflow_package_approvals").get())
      .toEqual({ count: 2 });
    expect(() => approve("S-1-5-21-103", 21)).toThrow(/cannot be approved/i);
  });
});
