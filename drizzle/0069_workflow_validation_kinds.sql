ALTER TABLE `workflow_backend_validations`
  ADD COLUMN `validation_kind` text NOT NULL DEFAULT 'release'
  CHECK (`validation_kind` IN ('release', 'local-self-use'));
--> statement-breakpoint
UPDATE `workflow_backend_validations`
SET `validation_kind` = 'local-self-use'
WHERE `reviewer_id` = 'local-self-use';
--> statement-breakpoint
UPDATE `workflow_backend_validations`
SET `id` = `validation_kind` || ':' || `id`;
--> statement-breakpoint
DROP INDEX `workflow_backend_validations_pair_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_backend_validations_kind_unique`
  ON `workflow_backend_validations`
  (`workflow_package_digest`, `execution_backend_id`, `validation_kind`);
--> statement-breakpoint
CREATE TRIGGER `workflow_backend_validations_kind_guard_insert`
BEFORE INSERT ON `workflow_backend_validations`
FOR EACH ROW
WHEN (NEW.validation_kind = 'local-self-use') <> (NEW.reviewer_id = 'local-self-use')
BEGIN
  SELECT RAISE(ABORT, 'workflow validation kind and reviewer provenance conflict');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_backend_validations_kind_guard_update`
BEFORE UPDATE OF `validation_kind`, `reviewer_id` ON `workflow_backend_validations`
FOR EACH ROW
WHEN (NEW.validation_kind = 'local-self-use') <> (NEW.reviewer_id = 'local-self-use')
BEGIN
  SELECT RAISE(ABORT, 'workflow validation kind and reviewer provenance conflict');
END;
