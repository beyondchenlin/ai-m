CREATE TABLE `workflow_package_approvals` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_package_digest` text NOT NULL,
  `execution_backend_id` text NOT NULL,
  `reviewer_id` text NOT NULL,
  `environment_fingerprint` text NOT NULL,
  `environment_lock_digest` text NOT NULL,
  `validation_report_json` text NOT NULL,
  `approved_at_ms` integer NOT NULL,
  FOREIGN KEY (`workflow_package_digest`) REFERENCES `workflow_package_revisions`(`digest`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`execution_backend_id`) REFERENCES `execution_backends`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_package_approvals_reviewer_unique`
  ON `workflow_package_approvals`
  (`workflow_package_digest`, `execution_backend_id`, `environment_fingerprint`, `environment_lock_digest`, `reviewer_id`);
--> statement-breakpoint
CREATE INDEX `workflow_package_approvals_release_lookup_idx`
  ON `workflow_package_approvals`
  (`workflow_package_digest`, `execution_backend_id`, `environment_fingerprint`, `environment_lock_digest`);
--> statement-breakpoint
CREATE TRIGGER `workflow_package_approvals_guard_insert`
BEFORE INSERT ON `workflow_package_approvals`
FOR EACH ROW
WHEN length(NEW.reviewer_id) < 1
  OR length(NEW.reviewer_id) > 160
  OR NEW.reviewer_id = 'system'
  OR length(NEW.environment_fingerprint) < 1
  OR length(NEW.environment_lock_digest) < 1
  OR NEW.approved_at_ms <= 0
  OR json_valid(NEW.validation_report_json) <> 1
BEGIN
  SELECT RAISE(ABORT, 'invalid workflow approval');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_package_approvals_no_update`
BEFORE UPDATE ON `workflow_package_approvals`
BEGIN
  SELECT RAISE(ABORT, 'workflow approvals are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workflow_package_approvals_no_delete`
BEFORE DELETE ON `workflow_package_approvals`
BEGIN
  SELECT RAISE(ABORT, 'workflow approvals are immutable');
END;
