ALTER TABLE `generation_artifacts` ADD COLUMN `writer_lease_owner` text;
--> statement-breakpoint
ALTER TABLE `generation_artifacts` ADD COLUMN `writer_lease_token` text;
--> statement-breakpoint
ALTER TABLE `generation_artifacts` ADD COLUMN `writer_lease_expires_at_ms` integer;
--> statement-breakpoint
ALTER TABLE `generation_artifacts` ADD COLUMN `recovery_lease_owner` text;
--> statement-breakpoint
ALTER TABLE `generation_artifacts` ADD COLUMN `recovery_lease_token` text;
--> statement-breakpoint
ALTER TABLE `generation_artifacts` ADD COLUMN `recovery_lease_expires_at_ms` integer;
--> statement-breakpoint
CREATE INDEX `generation_artifacts_recovery_scan_index`
  ON `generation_artifacts` (`status`, `writer_lease_expires_at_ms`, `recovery_lease_expires_at_ms`, `updated_at_ms`);
--> statement-breakpoint
CREATE TRIGGER `generation_artifacts_lease_validate_insert`
BEFORE INSERT ON `generation_artifacts`
FOR EACH ROW
WHEN NOT (
  ((NEW.`writer_lease_owner` IS NULL AND NEW.`writer_lease_token` IS NULL AND NEW.`writer_lease_expires_at_ms` IS NULL)
    OR (NEW.`writer_lease_owner` IS NOT NULL AND NEW.`writer_lease_token` IS NOT NULL AND NEW.`writer_lease_expires_at_ms` IS NOT NULL AND NEW.`writer_lease_expires_at_ms` > 0))
  AND
  ((NEW.`recovery_lease_owner` IS NULL AND NEW.`recovery_lease_token` IS NULL AND NEW.`recovery_lease_expires_at_ms` IS NULL)
    OR (NEW.`status` = 'RECOVERING' AND NEW.`recovery_lease_owner` IS NOT NULL AND NEW.`recovery_lease_token` IS NOT NULL AND NEW.`recovery_lease_expires_at_ms` IS NOT NULL AND NEW.`recovery_lease_expires_at_ms` > 0))
  AND (NEW.`status` IN ('STAGING', 'RECOVERING', 'COMMITTED', 'QUARANTINED', 'DELETED'))
  AND (NEW.`status` = 'STAGING' OR NEW.`writer_lease_owner` IS NULL)
  AND (NEW.`status` = 'RECOVERING' OR NEW.`recovery_lease_owner` IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid generation artifact lease state');
END;
--> statement-breakpoint
CREATE TRIGGER `generation_artifacts_lease_validate_update`
BEFORE UPDATE ON `generation_artifacts`
FOR EACH ROW
WHEN NOT (
  ((NEW.`writer_lease_owner` IS NULL AND NEW.`writer_lease_token` IS NULL AND NEW.`writer_lease_expires_at_ms` IS NULL)
    OR (NEW.`writer_lease_owner` IS NOT NULL AND NEW.`writer_lease_token` IS NOT NULL AND NEW.`writer_lease_expires_at_ms` IS NOT NULL AND NEW.`writer_lease_expires_at_ms` > 0))
  AND
  ((NEW.`recovery_lease_owner` IS NULL AND NEW.`recovery_lease_token` IS NULL AND NEW.`recovery_lease_expires_at_ms` IS NULL)
    OR (NEW.`status` = 'RECOVERING' AND NEW.`recovery_lease_owner` IS NOT NULL AND NEW.`recovery_lease_token` IS NOT NULL AND NEW.`recovery_lease_expires_at_ms` IS NOT NULL AND NEW.`recovery_lease_expires_at_ms` > 0))
  AND (NEW.`status` IN ('STAGING', 'RECOVERING', 'COMMITTED', 'QUARANTINED', 'DELETED'))
  AND (NEW.`status` = 'STAGING' OR NEW.`writer_lease_owner` IS NULL)
  AND (NEW.`status` = 'RECOVERING' OR NEW.`recovery_lease_owner` IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid generation artifact lease state');
END;
