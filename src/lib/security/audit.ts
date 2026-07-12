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

/** 写入审计事件 */
export async function writeAuditEvent(input: AuditEventInput): Promise<void> {
  const now = Date.now();
  await db.insert(auditEvents).values({
    id: genId(),
    actorId: input.actorId ?? "system",
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    detailsSafeJson: input.detailsSafe ?? {},
    createdAtMs: now,
  });
}

/** 脱敏日志：移除密钥、认证头等敏感信息 */
export function sanitizeForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = [
    "apiKey", "secretKey", "secretValue", "secret_value",
    "authorization", "token", "password", "credential",
    "authConfigJson", "auth_config_json",
  ];
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk.toLowerCase()))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeForLog(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/** 脱敏密钥值用于日志 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "***" + key.slice(-4);
}