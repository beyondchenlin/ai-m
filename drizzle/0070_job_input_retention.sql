ALTER TABLE `generation_jobs`
  ADD COLUMN `input_retention_until_ms` integer;
--> statement-breakpoint
ALTER TABLE `generation_jobs`
  ADD COLUMN `inputs_released_at_ms` integer;
--> statement-breakpoint
UPDATE `generation_jobs`
SET `input_retention_until_ms` = `created_at_ms` + 2592000000
WHERE `input_retention_until_ms` IS NULL;
--> statement-breakpoint
CREATE INDEX `generation_jobs_input_retention_idx`
  ON `generation_jobs` (`status`, `input_retention_until_ms`)
  WHERE `inputs_released_at_ms` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `generation_jobs_input_retention_guard_insert`
BEFORE INSERT ON `generation_jobs`
FOR EACH ROW
WHEN NEW.input_retention_until_ms IS NULL
  OR NEW.input_retention_until_ms <= NEW.created_at_ms
  OR (NEW.inputs_released_at_ms IS NOT NULL
    AND NEW.inputs_released_at_ms < NEW.created_at_ms)
BEGIN
  SELECT RAISE(ABORT, 'invalid generation job input retention');
END;
--> statement-breakpoint
CREATE TRIGGER `generation_jobs_input_retention_guard_update`
BEFORE UPDATE OF `input_retention_until_ms`, `inputs_released_at_ms` ON `generation_jobs`
FOR EACH ROW
WHEN NEW.input_retention_until_ms IS NULL
  OR NEW.input_retention_until_ms <= NEW.created_at_ms
  OR (NEW.inputs_released_at_ms IS NOT NULL
    AND (NEW.inputs_released_at_ms < NEW.created_at_ms
      OR OLD.inputs_released_at_ms IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'invalid generation job input retention update');
END;
