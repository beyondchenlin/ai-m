/**
 * v2.0 审计日志
 *
 * 手册 §22.3：记录所有控制平面写操作。
 * 日志中不得出现真实密钥、完整认证头、完整提示词、原始声音和私有绝对路径。
 */

import { db } from "@/lib/db";
import { auditEvents } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";

/** 审计动作类型 */
export const AuditAction = {
  BACKEND_CREATED: "backend.created",
  BACKEND_UPDATED: "backend.updated",
  BACKEND_DELETED: "backend.deleted",
  BACKEND_PROBED: "backend.probed",
  KEY_CREATED: "key.created",
  KEY_DELETED: "key.deleted",
  KEY_ACCESSED: "key.accessed",
  WORKFLOW_UPLOADED: "workflow.uploaded",
  WORKFLOW_VALIDATED: "workflow.validated",
  WORKFLOW_REVIEWED: "workflow.reviewed",
  WORKFLOW_PUBLISHED: "workflow.published",
  WORKFLOW_REVOKED: "workflow.revoked",
  PROFILE_CREATED: "profile.created",
  PROFILE_PUBLISHED: "profile.published",
  PROFILE_REVOKED: "profile.revoked",
  DEFAULT_POINTER_CHANGED: "default_pointer.changed",
  JOB_NEEDS_ATTENTION_RESOLVED: "job.needs_attention_resolved",
  JOB_NEEDS_ATTENTION_ACKNOWLEDGED: "job.needs_attention_acknowledged",
  OPERATIONAL_ALERT_ACKNOWLEDGED: "operational_alert.acknowledged",
  ARTIFACT_ACCESS_DENIED: "artifact.access_denied",
  SECURITY_POLICY_CHANGED: "security_policy.changed",
  RESOURCE_POOL_CHANGED: "resource_pool.changed",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** 审计目标类型 */
export const AuditTargetType = {
  BACKEND: "execution_backend",
  KEY: "key_reference",
  WORKFLOW: "workflow_package",
  PROFILE: "generation_profile",
  DEFAULT_POINTER: "default_generation_profile_pointer",
  JOB: "generation_job",
  ARTIFACT: "generation_artifact",
  SECURITY_POLICY: "security_policy",
  RESOURCE_POOL: "resource_pool",
  OPERATIONAL_ALERT: "operational_alert",
} as const;

export type AuditTargetType = (typeof AuditTargetType)[keyof typeof AuditTargetType];

export interface AuditEventInput {
  actorId?: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  /** 安全载荷：不得包含密钥、完整提示词、原始声音、私有绝对路径 */
  detailsSafe?: Record<string, unknown>;
}

const AUDIT_DETAIL_ALLOWLIST = new Set([
  "adapterKind", "approvalsRetained", "backendId", "capability", "changedFields",
  "disabledProfileCount", "displayName", "environmentFingerprint",
  "environmentLockDigest", "invalidatedValidation", "keyType", "kind", "label",
  "mimeType", "profileKey", "reason", "reviewers", "revisionNo", "sha256",
  "sharingMode", "sizeBytes", "topology", "reasonCode", "evidenceRefs",
  "stateUnchanged",
  "alertKey", "category", "severity",
]);

function sanitizeAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!AUDIT_DETAIL_ALLOWLIST.has(key)) continue;
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
      || (Array.isArray(value) && value.every((item) => typeof item === "string"))
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

/** 写入审计事件 */
export async function writeAuditEvent(input: AuditEventInput): Promise<void> {
  const now = Date.now();
  await db.insert(auditEvents).values({
    id: genId(),
    actorId: input.actorId ?? "system",
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    detailsSafeJson: sanitizeAuditDetails(input.detailsSafe ?? {}),
    createdAtMs: now,
  });
}

/** 脱敏日志：移除密钥、认证头等敏感信息 */
export function sanitizeForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (typeof obj.keyRefId === "string") safe.keyRefId = obj.keyRefId;
  if (typeof obj.headerName === "string") safe.headerName = obj.headerName;
  return safe;
}

/** 脱敏密钥值用于日志 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "***" + key.slice(-4);
}
