import { randomUUID } from "node:crypto";
import { getSqlite } from "@/lib/db";
import {
  authenticatedOperatorActorId,
  type AuthenticatedLocalOperator,
  windowsTokenContextDigest,
} from "@/lib/security/authenticated-local-operator";

type ApprovalState = "reviewed" | "active";

export interface RecordWorkflowApprovalInput {
  workflowPackageDigest: string;
  executionBackendId: string;
  reviewer: AuthenticatedLocalOperator;
  environmentFingerprint: string;
  environmentLockDigest: string;
  validationReport: Record<string, unknown>;
  approvedAtMs?: number;
}

export interface WorkflowApprovalResult {
  state: ApprovalState;
  approvalCount: number;
  reviewers: string[];
  inserted: boolean;
}

function namedActor(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "system" || normalized.length > 160) {
    throw new Error(`${field} must identify a named actor`);
  }
  return normalized;
}

function requiredIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function importedBy(reportJson: string): string | null {
  try {
    const report = JSON.parse(reportJson) as unknown;
    if (!report || typeof report !== "object" || Array.isArray(report)) return null;
    const value = Reflect.get(report, "importedBy");
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    throw new Error("Workflow import provenance is invalid");
  }
}

function authenticatedReviewer(
  reviewerId: string,
  reportJson: string,
): string | null {
  try {
    const report = JSON.parse(reportJson) as unknown;
    if (!report || typeof report !== "object" || Array.isArray(report)) return null;
    const authentication = Reflect.get(report, "authenticatedReviewer");
    if (!authentication || typeof authentication !== "object" || Array.isArray(authentication)) {
      return null;
    }
    const issuer = Reflect.get(authentication, "issuer");
    const subjectId = Reflect.get(authentication, "subjectId");
    const contextDigest = Reflect.get(authentication, "authenticationContextDigest");
    if (
      issuer !== "windows-local-token"
      || typeof subjectId !== "string"
      || reviewerId !== `windows-sid:${subjectId}`
      || typeof contextDigest !== "string"
      || contextDigest !== windowsTokenContextDigest(subjectId)
    ) {
      return null;
    }
    return reviewerId;
  } catch {
    return null;
  }
}

/** Atomically activates only after two distinct non-importer human approvals. */
export function recordWorkflowApproval(
  input: RecordWorkflowApprovalInput,
): WorkflowApprovalResult {
  const sqlite = getSqlite();
  const digest = requiredIdentity(input.workflowPackageDigest, "workflowPackageDigest");
  const backendId = requiredIdentity(input.executionBackendId, "executionBackendId");
  const reviewerId = authenticatedOperatorActorId(input.reviewer);
  const environmentFingerprint = requiredIdentity(input.environmentFingerprint, "environmentFingerprint");
  const environmentLockDigest = requiredIdentity(input.environmentLockDigest, "environmentLockDigest");
  const approvedAtMs = input.approvedAtMs ?? Date.now();
  if (!Number.isSafeInteger(approvedAtMs) || approvedAtMs <= 0) {
    throw new Error("approvedAtMs must be a positive safe integer");
  }
  const validationReportJson = JSON.stringify({
    ...input.validationReport,
    authenticatedReviewer: {
      issuer: input.reviewer.issuer,
      subjectId: input.reviewer.subjectId,
      authenticationContextDigest: input.reviewer.authenticationContextDigest,
    },
  });
  if (!validationReportJson) throw new Error("validationReport must be JSON serializable");

  return sqlite.transaction(() => {
    const workflow = sqlite.prepare<[string], {
      state: string;
      validationReportJson: string;
      environmentLockDigest: string | null;
    }>(`
      SELECT s.state, s.validation_report_json AS validationReportJson,
             r.environment_lock_digest AS environmentLockDigest
      FROM workflow_package_states AS s
      JOIN workflow_package_revisions AS r ON r.digest = s.workflow_package_digest
      WHERE s.workflow_package_digest = ?
    `).get(digest);
    if (!workflow) throw new Error("Workflow revision not found");
    if (workflow.state === "revoked" || workflow.state === "invalid") {
      throw new Error(`Workflow state ${workflow.state} cannot be approved`);
    }
    if (workflow.environmentLockDigest !== environmentLockDigest) {
      throw new Error("Approval environment lock does not match the immutable package lock");
    }
    const importerId = importedBy(workflow.validationReportJson);
    if (!importerId || !/^windows-sid:S-1-(?:\d+-)+\d+$/.test(importerId)) {
      throw new Error("Workflow importer lacks authenticated Windows token provenance");
    }
    if (importerId && importerId === reviewerId) {
      throw new Error("Workflow reviewer must differ from workflow importer");
    }

    const existing = sqlite.prepare<[string, string, string, string, string], { id: string }>(`
      SELECT id
      FROM workflow_package_approvals
      WHERE workflow_package_digest = ?
        AND execution_backend_id = ?
        AND environment_fingerprint = ?
        AND environment_lock_digest = ?
        AND reviewer_id = ?
    `).get(digest, backendId, environmentFingerprint, environmentLockDigest, reviewerId);
    let inserted = false;
    if (!existing) {
      sqlite.prepare(`
        INSERT INTO workflow_package_approvals
          (id, workflow_package_digest, execution_backend_id, reviewer_id,
           environment_fingerprint, environment_lock_digest,
           validation_report_json, approved_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), digest, backendId, reviewerId, environmentFingerprint,
        environmentLockDigest, validationReportJson, approvedAtMs,
      );
      inserted = true;
      sqlite.prepare(`
        INSERT INTO audit_events
          (id, actor_id, action, target_type, target_id, details_safe_json, created_at_ms)
        VALUES (?, ?, 'workflow.reviewed', 'workflow_package', ?, ?, ?)
      `).run(randomUUID(), reviewerId, digest, JSON.stringify({
        backendId,
        environmentFingerprint,
        environmentLockDigest,
      }), approvedAtMs);
    }

    const reviewers = sqlite.prepare<[string, string, string, string], {
      reviewerId: string;
      validationReportJson: string;
    }>(`
      SELECT reviewer_id AS reviewerId, validation_report_json AS validationReportJson
      FROM workflow_package_approvals
      WHERE workflow_package_digest = ?
        AND execution_backend_id = ?
        AND environment_fingerprint = ?
        AND environment_lock_digest = ?
      ORDER BY approved_at_ms, reviewer_id
    `).all(digest, backendId, environmentFingerprint, environmentLockDigest)
      .map((row) => authenticatedReviewer(row.reviewerId, row.validationReportJson))
      .filter((reviewer): reviewer is string => reviewer !== null);
    const state: ApprovalState = reviewers.length >= 2 ? "active" : "reviewed";
    const transitionedToActive = state === "active" && workflow.state !== "active";
    sqlite.prepare(`
      UPDATE workflow_package_states
      SET state = ?, reviewed_by = ?, reviewed_at_ms = ?, updated_at_ms = ?
      WHERE workflow_package_digest = ?
        AND state NOT IN ('revoked', 'invalid')
    `).run(state, reviewerId, approvedAtMs, approvedAtMs, digest);
    if (transitionedToActive) {
      sqlite.prepare(`
        INSERT INTO audit_events
          (id, actor_id, action, target_type, target_id, details_safe_json, created_at_ms)
        VALUES (?, ?, 'workflow.published', 'workflow_package', ?, ?, ?)
      `).run(randomUUID(), reviewerId, digest, JSON.stringify({
        backendId,
        environmentFingerprint,
        environmentLockDigest,
        reviewers,
      }), approvedAtMs);
    }
    return { state, approvalCount: reviewers.length, reviewers, inserted };
  }).immediate();
}

export function revokeWorkflowPackage(input: {
  workflowPackageDigest: string;
  actorId: string;
  reason: string;
  revokedAtMs?: number;
}): { revoked: boolean; disabledProfileCount: number } {
  const sqlite = getSqlite();
  const digest = requiredIdentity(input.workflowPackageDigest, "workflowPackageDigest");
  const actorId = namedActor(input.actorId, "actorId");
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new Error("A bounded revocation reason is required");
  const revokedAtMs = input.revokedAtMs ?? Date.now();
  if (!Number.isSafeInteger(revokedAtMs) || revokedAtMs <= 0) {
    throw new Error("revokedAtMs must be a positive safe integer");
  }

  return sqlite.transaction(() => {
    const row = sqlite.prepare<[string], { state: string }>(
      "SELECT state FROM workflow_package_states WHERE workflow_package_digest = ?",
    ).get(digest);
    if (!row) throw new Error("Workflow revision not found");
    if (row.state === "invalid") throw new Error("Invalid workflows cannot be revoked");
    if (row.state === "revoked") return { revoked: false, disabledProfileCount: 0 };

    sqlite.prepare(`
      UPDATE workflow_package_states
      SET state = 'revoked', revoked_at_ms = ?, updated_at_ms = ?
      WHERE workflow_package_digest = ?
    `).run(revokedAtMs, revokedAtMs, digest);
    const profileIds = sqlite.prepare<[string], { id: string }>(`
      SELECT id FROM generation_profile_revisions WHERE workflow_package_digest = ?
    `).all(digest).map((profile) => profile.id);
    let disabledProfileCount = 0;
    if (profileIds.length) {
      const placeholders = profileIds.map(() => "?").join(",");
      sqlite.prepare(`
        DELETE FROM default_generation_profile_pointers
        WHERE generation_profile_revision_id IN (${placeholders})
      `).run(...profileIds);
      disabledProfileCount = sqlite.prepare(`
        UPDATE generation_profile_states
        SET enabled = 0, revoked_at_ms = ?, updated_at_ms = ?
        WHERE generation_profile_revision_id IN (${placeholders})
      `).run(revokedAtMs, revokedAtMs, ...profileIds).changes;
    }
    sqlite.prepare(`
      INSERT INTO audit_events
        (id, actor_id, action, target_type, target_id, details_safe_json, created_at_ms)
      VALUES (?, ?, 'workflow.revoked', 'workflow_package', ?, ?, ?)
    `).run(randomUUID(), actorId, digest, JSON.stringify({
      reason,
      disabledProfileCount,
      approvalsRetained: true,
    }), revokedAtMs);
    return { revoked: true, disabledProfileCount };
  }).immediate();
}
