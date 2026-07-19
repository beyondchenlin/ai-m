import { randomUUID } from "node:crypto";
import { getSqlite } from "@/lib/db";

export const OPERATIONAL_ALERT_REASON_CODES = [
  "investigating",
  "mitigation_in_progress",
  "accepted_temporary_risk",
  "escalated",
] as const;

export type OperationalAlertReasonCode = typeof OPERATIONAL_ALERT_REASON_CODES[number];
export type OperationalAlertCategory =
  | "submission-unknown"
  | "lease-loss"
  | "environment-drift"
  | "disk-high-watermark";

export interface OperationalMetrics {
  collectedAtMs: number;
  jobsByStatus: Record<string, number>;
  attemptsByPhase: Record<string, number>;
  attemptElapsedMsByPhase: Record<string, { count: number; average: number; maximum: number }>;
  submissionUnknownCount: number;
  retainedSlotCount: number;
  expiredSlotCount: number;
  leaseLossCount24h: number;
  environmentDriftCount24h: number;
  failuresByClass24h: Record<string, number>;
  retainedReconciliationCount: number;
  reconciledCount24h: number;
  restartSuccessCount24h: number;
  restartFailureCount24h: number;
  expiredWorkflowEvidenceCount: number;
  diskUsageRatio: number | null;
}

export interface OperationalAlert {
  alertKey: string;
  category: OperationalAlertCategory;
  severity: "warning" | "critical";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  summarySafe: string;
  detailsSafeJson: Record<string, number | boolean | null>;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  acknowledgedAtMs: number | null;
  acknowledgedBy: string | null;
  acknowledgementReason: string | null;
  evidenceRefsJson: string[] | null;
  resolvedAtMs: number | null;
}

type Signal = {
  alertKey: string;
  category: OperationalAlertCategory;
  severity: "warning" | "critical";
  summarySafe: string;
  details: Record<string, number | boolean | null>;
};

function countRows(sqlite: ReturnType<typeof getSqlite>, sql: string, args: unknown[] = []): Record<string, number> {
  return Object.fromEntries(sqlite.prepare(sql).all(...args)
    .map((row) => {
      const value = row as { name: string; count: number };
      return [value.name, value.count];
    }));
}

function collectOperationalMetricsSnapshot(input: {
  diskUsageRatio?: number | null;
  nowMs?: number;
}, sqlite: ReturnType<typeof getSqlite>): OperationalMetrics {
  const now = input.nowMs ?? Date.now();
  const cutoff = now - 86_400_000;
  const jobsByStatus = countRows(sqlite,
    "SELECT status AS name, COUNT(*) AS count FROM generation_jobs GROUP BY status",
  );
  const attemptsByPhase = countRows(sqlite,
    "SELECT phase AS name, COUNT(*) AS count FROM generation_attempts GROUP BY phase",
  );
  const failuresByClass24h = countRows(sqlite, `
    SELECT COALESCE(NULLIF(error_class, ''), 'unclassified') AS name, COUNT(*) AS count
    FROM generation_attempts
    WHERE updated_at_ms >= ? AND phase IN ('FAILED', 'SUBMISSION_UNKNOWN', 'NEEDS_ATTENTION')
    GROUP BY COALESCE(NULLIF(error_class, ''), 'unclassified')
  `, [cutoff]);
  const phaseRows = sqlite.prepare<[number, number], {
    phase: string; count: number; average: number; maximum: number;
  }>(`
    SELECT phase, COUNT(*) AS count,
      CAST(AVG(MAX(0, COALESCE(finished_at_ms, ?) - created_at_ms)) AS INTEGER) AS average,
      MAX(MAX(0, COALESCE(finished_at_ms, ?) - created_at_ms)) AS maximum
    FROM generation_attempts GROUP BY phase
  `).all(now, now);
  const scalar = (sql: string, ...args: unknown[]) =>
    (sqlite.prepare(sql).get(...args) as { count: number }).count;
  return {
    collectedAtMs: now,
    jobsByStatus,
    attemptsByPhase,
    attemptElapsedMsByPhase: Object.fromEntries(phaseRows.map((row) => [row.phase, {
      count: row.count,
      average: row.average,
      maximum: row.maximum,
    }])),
    submissionUnknownCount: attemptsByPhase.SUBMISSION_UNKNOWN ?? 0,
    retainedSlotCount: scalar(
      "SELECT COUNT(*) AS count FROM resource_pool_slots WHERE owner_attempt_id IS NOT NULL",
    ),
    expiredSlotCount: scalar(
      "SELECT COUNT(*) AS count FROM resource_pool_slots WHERE owner_attempt_id IS NOT NULL AND expires_at_ms <= ?",
      now,
    ),
    leaseLossCount24h: scalar(`
      SELECT COUNT(*) AS count FROM generation_attempts
      WHERE updated_at_ms >= ? AND (
        lower(COALESCE(error_code, '')) LIKE '%lease%'
        OR lower(COALESCE(error_code, '')) LIKE '%claim_lost%'
      )
    `, cutoff),
    environmentDriftCount24h: scalar(`
      SELECT COUNT(*) AS count FROM generation_attempts
      WHERE updated_at_ms >= ? AND (
        lower(COALESCE(error_code, '')) LIKE '%environment%drift%'
        OR error_code = 'workflow_backend_validation_missing'
      )
    `, cutoff),
    failuresByClass24h,
    retainedReconciliationCount: scalar(
      "SELECT COUNT(*) AS count FROM resource_reconciliation_proofs WHERE disposition='retained'",
    ),
    reconciledCount24h: scalar(
      "SELECT COUNT(*) AS count FROM resource_reconciliation_proofs WHERE disposition='reconciled' AND reconciled_at_ms >= ?",
      cutoff,
    ),
    restartSuccessCount24h: scalar(
      "SELECT COUNT(*) AS count FROM generation_events WHERE event_type='managed_runtime_restart_succeeded' AND created_at_ms >= ?",
      cutoff,
    ),
    restartFailureCount24h: scalar(
      "SELECT COUNT(*) AS count FROM generation_events WHERE event_type='managed_runtime_restart_failed' AND created_at_ms >= ?",
      cutoff,
    ),
    expiredWorkflowEvidenceCount: scalar(`
      SELECT COUNT(*) AS count
      FROM workflow_package_states
      WHERE CAST(json_extract(validation_report_json,
        '$.generationProvenance.verifiedEvidenceExpiresAtMs') AS INTEGER) BETWEEN 1 AND ?
    `, now),
    diskUsageRatio: input.diskUsageRatio ?? null,
  };
}

export function collectOperationalMetrics(input: {
  diskUsageRatio?: number | null;
  nowMs?: number;
} = {}): OperationalMetrics {
  const sqlite = getSqlite();
  return sqlite.transaction(() => collectOperationalMetricsSnapshot(input, sqlite))();
}

function signalsFor(metrics: OperationalMetrics): Signal[] {
  const signals: Signal[] = [];
  if (metrics.submissionUnknownCount > 0) signals.push({
    alertKey: "submission-unknown",
    category: "submission-unknown",
    severity: "critical",
    summarySafe: "One or more submissions have unknown external state",
    details: { count: metrics.submissionUnknownCount },
  });
  if (metrics.leaseLossCount24h > 0 || metrics.expiredSlotCount > 0) signals.push({
    alertKey: "lease-loss",
    category: "lease-loss",
    severity: "critical",
    summarySafe: "Lease ownership evidence requires investigation",
    details: {
      recentErrorCount: metrics.leaseLossCount24h,
      expiredSlotCount: metrics.expiredSlotCount,
      retainedSlotCount: metrics.retainedSlotCount,
    },
  });
  if (metrics.environmentDriftCount24h > 0) signals.push({
    alertKey: "environment-drift",
    category: "environment-drift",
    severity: "warning",
    summarySafe: "Backend environment drift was detected",
    details: { recentCount: metrics.environmentDriftCount24h },
  });
  if (metrics.diskUsageRatio !== null && metrics.diskUsageRatio >= 0.85) signals.push({
    alertKey: "disk-high-watermark",
    category: "disk-high-watermark",
    severity: metrics.diskUsageRatio >= 0.95 ? "critical" : "warning",
    summarySafe: "Artifact storage crossed the disk high-watermark",
    details: {
      usagePermille: Math.round(metrics.diskUsageRatio * 1_000),
      warningPermille: 850,
      criticalPermille: 950,
    },
  });
  return signals;
}

export function listOperationalAlerts(limit = 100): OperationalAlert[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Operational alert limit must be between 1 and 200");
  }
  const rows = getSqlite().prepare<[number], Omit<OperationalAlert, "detailsSafeJson" | "evidenceRefsJson"> & {
    detailsSafeJson: string; evidenceRefsJson: string | null;
  }>(`
    SELECT alert_key AS alertKey, category, severity, status, summary_safe AS summarySafe,
      details_safe_json AS detailsSafeJson, first_seen_at_ms AS firstSeenAtMs,
      last_seen_at_ms AS lastSeenAtMs, acknowledged_at_ms AS acknowledgedAtMs,
      acknowledged_by AS acknowledgedBy, acknowledgement_reason AS acknowledgementReason,
      evidence_refs_json AS evidenceRefsJson, resolved_at_ms AS resolvedAtMs
    FROM operational_alerts
    ORDER BY status = 'RESOLVED', severity = 'warning', last_seen_at_ms DESC
    LIMIT ?
  `).all(limit);
  return rows.map((row) => ({
    ...row,
    detailsSafeJson: JSON.parse(row.detailsSafeJson) as Record<string, number | boolean | null>,
    evidenceRefsJson: row.evidenceRefsJson ? JSON.parse(row.evidenceRefsJson) as string[] : null,
  }));
}

export function refreshOperationalHealth(input: {
  diskUsageRatio?: number | null;
  nowMs?: number;
} = {}): { metrics: OperationalMetrics; alerts: OperationalAlert[] } {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const metrics = collectOperationalMetricsSnapshot(input, sqlite);
    const signals = signalsFor(metrics);
    for (const signal of signals) {
      sqlite.prepare(`
        INSERT INTO operational_alerts
          (alert_key, category, severity, status, summary_safe, details_safe_json,
           first_seen_at_ms, last_seen_at_ms)
        VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?)
        ON CONFLICT(alert_key) DO UPDATE SET
          severity=excluded.severity,
          status=CASE WHEN operational_alerts.status='RESOLVED' THEN 'OPEN' ELSE operational_alerts.status END,
          summary_safe=excluded.summary_safe,
          details_safe_json=excluded.details_safe_json,
          last_seen_at_ms=excluded.last_seen_at_ms,
          acknowledged_at_ms=CASE WHEN operational_alerts.status='RESOLVED' THEN NULL ELSE operational_alerts.acknowledged_at_ms END,
          acknowledged_by=CASE WHEN operational_alerts.status='RESOLVED' THEN NULL ELSE operational_alerts.acknowledged_by END,
          acknowledgement_reason=CASE WHEN operational_alerts.status='RESOLVED' THEN NULL ELSE operational_alerts.acknowledgement_reason END,
          evidence_refs_json=CASE WHEN operational_alerts.status='RESOLVED' THEN NULL ELSE operational_alerts.evidence_refs_json END,
          resolved_at_ms=NULL
      `).run(
        signal.alertKey, signal.category, signal.severity, signal.summarySafe,
        JSON.stringify(signal.details), metrics.collectedAtMs, metrics.collectedAtMs,
      );
    }
    const activeKeys = signals.map((signal) => signal.alertKey);
    const preserveDiskAlert = metrics.diskUsageRatio === null ? 1 : 0;
    if (activeKeys.length === 0) {
      sqlite.prepare(`
        UPDATE operational_alerts SET status='RESOLVED', resolved_at_ms=?
        WHERE status IN ('OPEN', 'ACKNOWLEDGED')
          AND NOT (category='disk-high-watermark' AND ?=1)
      `).run(metrics.collectedAtMs, preserveDiskAlert);
    } else {
      const placeholders = activeKeys.map(() => "?").join(",");
      sqlite.prepare(`
        UPDATE operational_alerts SET status='RESOLVED', resolved_at_ms=?
        WHERE status IN ('OPEN', 'ACKNOWLEDGED') AND alert_key NOT IN (${placeholders})
          AND NOT (category='disk-high-watermark' AND ?=1)
      `).run(metrics.collectedAtMs, ...activeKeys, preserveDiskAlert);
    }
    return { metrics, alerts: listOperationalAlerts() };
  }).immediate();
}

export function acknowledgeOperationalAlert(input: {
  alertKey: string;
  actorId: string;
  reasonCode: OperationalAlertReasonCode;
  evidenceRefs: string[];
  acknowledgedAtMs?: number;
}): { acknowledged: true; alertKey: string; signalStateUnchanged: true } {
  const alertKey = input.alertKey.trim();
  const actorId = input.actorId.trim();
  if (!alertKey || alertKey.length > 120) throw new Error("alertKey is invalid");
  if (!actorId || actorId === "system" || actorId.length > 160) throw new Error("A named operator is required");
  if (!OPERATIONAL_ALERT_REASON_CODES.includes(input.reasonCode)) throw new Error("reasonCode is invalid");
  const evidenceRefs = [...new Set(input.evidenceRefs.map((item) => item.trim()))];
  if (evidenceRefs.length < 1 || evidenceRefs.length > 10
    || evidenceRefs.some((item) => !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/.test(item))) {
    throw new Error("One to ten bounded evidence references are required");
  }
  const now = input.acknowledgedAtMs ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("acknowledgedAtMs is invalid");
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const alert = sqlite.prepare<[string], {
      status: string; category: string; severity: string;
    }>("SELECT status, category, severity FROM operational_alerts WHERE alert_key=?").get(alertKey);
    if (!alert) throw new Error("Operational alert not found");
    if (alert.status === "RESOLVED") throw new Error("Operational alert is already resolved");
    sqlite.prepare(`
      UPDATE operational_alerts SET status='ACKNOWLEDGED', acknowledged_at_ms=?,
        acknowledged_by=?, acknowledgement_reason=?, evidence_refs_json=?
      WHERE alert_key=?
    `).run(now, actorId, input.reasonCode, JSON.stringify(evidenceRefs), alertKey);
    sqlite.prepare(`
      INSERT INTO audit_events
        (id, actor_id, action, target_type, target_id, details_safe_json, created_at_ms)
      VALUES (?, ?, 'operational_alert.acknowledged', 'operational_alert', ?, ?, ?)
    `).run(randomUUID(), actorId, alertKey, JSON.stringify({
      alertKey,
      category: alert.category,
      severity: alert.severity,
      reasonCode: input.reasonCode,
      evidenceRefs,
      stateUnchanged: true,
    }), now);
    return { acknowledged: true as const, alertKey, signalStateUnchanged: true as const };
  }).immediate();
}
