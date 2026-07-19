CREATE TABLE `operational_alerts` (
  `alert_key` text PRIMARY KEY NOT NULL,
  `category` text NOT NULL,
  `severity` text NOT NULL,
  `status` text NOT NULL,
  `summary_safe` text NOT NULL,
  `details_safe_json` text NOT NULL,
  `first_seen_at_ms` integer NOT NULL,
  `last_seen_at_ms` integer NOT NULL,
  `acknowledged_at_ms` integer,
  `acknowledged_by` text,
  `acknowledgement_reason` text,
  `evidence_refs_json` text,
  `resolved_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `operational_alerts_status_severity_idx`
  ON `operational_alerts` (`status`, `severity`, `last_seen_at_ms`);
--> statement-breakpoint
CREATE TRIGGER `operational_alerts_guard_insert`
BEFORE INSERT ON `operational_alerts`
FOR EACH ROW
WHEN length(NEW.alert_key) < 1
  OR length(NEW.alert_key) > 120
  OR NEW.category NOT IN ('submission-unknown', 'lease-loss', 'environment-drift', 'disk-high-watermark')
  OR NEW.severity NOT IN ('warning', 'critical')
  OR NEW.status NOT IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')
  OR length(NEW.summary_safe) < 1
  OR length(NEW.summary_safe) > 300
  OR json_valid(NEW.details_safe_json) <> 1
  OR NEW.first_seen_at_ms <= 0
  OR NEW.last_seen_at_ms < NEW.first_seen_at_ms
BEGIN
  SELECT RAISE(ABORT, 'invalid operational alert');
END;
--> statement-breakpoint
CREATE TRIGGER `operational_alerts_guard_update`
BEFORE UPDATE ON `operational_alerts`
FOR EACH ROW
WHEN NEW.alert_key <> OLD.alert_key
  OR NEW.category <> OLD.category
  OR NEW.first_seen_at_ms <> OLD.first_seen_at_ms
  OR NEW.severity NOT IN ('warning', 'critical')
  OR NEW.status NOT IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')
  OR length(NEW.summary_safe) < 1
  OR length(NEW.summary_safe) > 300
  OR json_valid(NEW.details_safe_json) <> 1
  OR NEW.last_seen_at_ms < OLD.last_seen_at_ms
  OR (OLD.status = 'ACKNOWLEDGED' AND NEW.status = 'OPEN')
  OR (OLD.status = 'RESOLVED' AND NEW.status = 'ACKNOWLEDGED')
  OR (NEW.status = 'ACKNOWLEDGED' AND (
    NEW.acknowledged_at_ms IS NULL
    OR NEW.acknowledged_by IS NULL
    OR NEW.acknowledgement_reason IS NULL
    OR NEW.evidence_refs_json IS NULL
    OR json_valid(NEW.evidence_refs_json) <> 1
  ))
  OR (NEW.status = 'RESOLVED' AND NEW.resolved_at_ms IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid operational alert transition');
END;
