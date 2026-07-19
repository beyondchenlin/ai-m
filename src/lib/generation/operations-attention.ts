import { randomUUID } from "node:crypto";
import { getSqlite } from "@/lib/db";

export const ATTENTION_REASON_CODES = [
  "investigating_external_state",
  "awaiting_backend_evidence",
  "awaiting_storage_evidence",
  "escalated_to_platform_owner",
] as const;

export type AttentionReasonCode = typeof ATTENTION_REASON_CODES[number];

export interface AttentionCase {
  jobId: string;
  projectId: string | null;
  capability: string;
  jobStatus: string;
  needsAttentionReason: string | null;
  attemptId: string | null;
  attemptPhase: string | null;
  externalJobId: string | null;
  backendId: string | null;
  errorClass: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  committedArtifactCount: number;
  reconciliationProofCount: number;
  activeSlotCount: number;
  updatedAtMs: number;
  lastAcknowledgedAtMs: number | null;
  lastAcknowledgedBy: string | null;
}

export function listAttentionCases(limit = 100): AttentionCase[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Attention case limit must be between 1 and 200");
  }
  return getSqlite().prepare<[number], AttentionCase>(`
    SELECT
      j.id AS jobId,
      j.project_id AS projectId,
      j.capability AS capability,
      j.status AS jobStatus,
      j.needs_attention_reason AS needsAttentionReason,
      a.id AS attemptId,
      a.phase AS attemptPhase,
      a.external_job_id AS externalJobId,
      a.backend_id AS backendId,
      a.error_class AS errorClass,
      a.error_code AS errorCode,
      a.error_message_safe AS errorMessageSafe,
      (
        SELECT COUNT(*) FROM generation_artifacts AS artifact
        WHERE artifact.attempt_id = a.id AND artifact.status = 'COMMITTED'
      ) AS committedArtifactCount,
      (
        SELECT COUNT(*) FROM resource_reconciliation_proofs AS proof
        WHERE proof.attempt_id = a.id
      ) AS reconciliationProofCount,
      (
        SELECT COUNT(*) FROM resource_pool_slots AS slot
        WHERE slot.owner_attempt_id = a.id
      ) AS activeSlotCount,
      j.updated_at_ms AS updatedAtMs,
      (
        SELECT MAX(event.created_at_ms) FROM audit_events AS event
        WHERE event.action = 'job.needs_attention_acknowledged'
          AND event.target_type = 'generation_job'
          AND event.target_id = j.id
      ) AS lastAcknowledgedAtMs,
      (
        SELECT event.actor_id FROM audit_events AS event
        WHERE event.action = 'job.needs_attention_acknowledged'
          AND event.target_type = 'generation_job'
          AND event.target_id = j.id
        ORDER BY event.created_at_ms DESC
        LIMIT 1
      ) AS lastAcknowledgedBy
    FROM generation_jobs AS j
    LEFT JOIN generation_attempts AS a ON a.id = j.current_attempt_id
    WHERE j.status = 'NEEDS_ATTENTION' OR a.phase = 'SUBMISSION_UNKNOWN'
    ORDER BY j.updated_at_ms ASC, j.id ASC
    LIMIT ?
  `).all(limit);
}

export function acknowledgeAttentionCase(input: {
  jobId: string;
  actorId: string;
  reasonCode: AttentionReasonCode;
  evidenceRefs: string[];
  acknowledgedAtMs?: number;
}): { acknowledged: true; jobId: string; stateUnchanged: true } {
  const jobId = input.jobId.trim();
  const actorId = input.actorId.trim();
  if (!jobId || jobId.length > 160) throw new Error("jobId is invalid");
  if (!actorId || actorId === "system" || actorId.length > 160) {
    throw new Error("A named operator is required");
  }
  if (!ATTENTION_REASON_CODES.includes(input.reasonCode)) throw new Error("reasonCode is invalid");
  const evidenceRefs = [...new Set(input.evidenceRefs.map((item) => item.trim()))];
  if (evidenceRefs.length < 1 || evidenceRefs.length > 10
    || evidenceRefs.some((item) => !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/.test(item))) {
    throw new Error("One to ten bounded evidence references are required");
  }
  const acknowledgedAtMs = input.acknowledgedAtMs ?? Date.now();
  if (!Number.isSafeInteger(acknowledgedAtMs) || acknowledgedAtMs <= 0) {
    throw new Error("acknowledgedAtMs is invalid");
  }
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const row = sqlite.prepare<[string], { jobStatus: string; attemptPhase: string | null }>(`
      SELECT j.status AS jobStatus, a.phase AS attemptPhase
      FROM generation_jobs AS j
      LEFT JOIN generation_attempts AS a ON a.id = j.current_attempt_id
      WHERE j.id = ?
    `).get(jobId);
    if (!row) throw new Error("Attention case not found");
    if (row.jobStatus !== "NEEDS_ATTENTION" && row.attemptPhase !== "SUBMISSION_UNKNOWN") {
      throw new Error("Job no longer requires operational attention");
    }
    sqlite.prepare(`
      INSERT INTO audit_events
        (id, actor_id, action, target_type, target_id, details_safe_json, created_at_ms)
      VALUES (?, ?, 'job.needs_attention_acknowledged', 'generation_job', ?, ?, ?)
    `).run(randomUUID(), actorId, jobId, JSON.stringify({
      reasonCode: input.reasonCode,
      evidenceRefs,
      stateUnchanged: true,
    }), acknowledgedAtMs);
    return { acknowledged: true as const, jobId, stateUnchanged: true as const };
  }).immediate();
}
