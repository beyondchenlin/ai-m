-- PR-12: platform hardening and durable workflow execution corrections.

ALTER TABLE `workflow_package_revisions` ADD COLUMN `workflow_api_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `workflow_package_revisions` ADD COLUMN `compiler_version` text NOT NULL DEFAULT '1.0.0';
--> statement-breakpoint
ALTER TABLE `workflow_package_revisions` ADD COLUMN `compiled_at_ms` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Revisions created before PR-12 do not contain an executable API workflow.  They
-- must not remain active after the new immutable workflow contract is introduced.
UPDATE `workflow_package_states`
SET `state` = 'invalid',
    `validation_report_json` = json_array('PR-12 requires re-importing a real workflow.api.json package'),
    `updated_at_ms` = CAST(strftime('%s','now') AS integer) * 1000
WHERE `workflow_package_digest` IN (
  SELECT `digest` FROM `workflow_package_revisions` WHERE `workflow_api_json` = '{}'
);

--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD COLUMN `requested_by` text;
--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD COLUMN `idempotency_key` text;
--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD COLUMN `metadata_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE UNIQUE INDEX `generation_jobs_idempotency_unique`
  ON `generation_jobs`(`project_id`, `capability`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `generation_jobs_active_dedupe_unique`
  ON `generation_jobs`(`project_id`, `dedupe_scope`)
  WHERE `dedupe_scope` IS NOT NULL
    AND `status` IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED');
--> statement-breakpoint
DELETE FROM `business_task_generation_jobs`
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM `business_task_generation_jobs` GROUP BY `generation_job_id`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_task_generation_jobs_job_unique`
  ON `business_task_generation_jobs`(`generation_job_id`);
--> statement-breakpoint

ALTER TABLE `generation_attempts` ADD COLUMN `job_claim_fencing_token` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `generation_artifacts` ADD COLUMN `updated_at_ms` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `generation_artifacts`
  SET `updated_at_ms` = COALESCE(`committed_at_ms`, `created_at_ms`)
  WHERE `updated_at_ms` = 0;
--> statement-breakpoint

CREATE TABLE `voice_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL,
  `name` text NOT NULL,
  `provider` text NOT NULL,
  `reference_artifact_id` text NOT NULL REFERENCES `generation_artifacts`(`id`),
  `reference_text` text,
  `language` text NOT NULL DEFAULT 'zh-CN',
  `default_speed_milli` integer NOT NULL DEFAULT 1000,
  `default_pitch_milli` integer NOT NULL DEFAULT 1000,
  `consent_confirmed_at_ms` integer NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `voice_profiles_project_user_index` ON `voice_profiles`(`project_id`, `user_id`);
--> statement-breakpoint

CREATE TRIGGER `generation_job_terminal_status_guard`
BEFORE UPDATE OF `status` ON `generation_jobs`
WHEN OLD.status = 'SUCCEEDED' AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'terminal generation jobs are immutable');
END;

--> statement-breakpoint
-- Legacy fabricated adapters cannot participate in the immutable workflow runtime.
UPDATE `generation_profile_states`
SET `enabled` = 0,
    `visibility` = 'admin',
    `updated_at_ms` = CAST(strftime('%s','now') AS integer) * 1000
WHERE `generation_profile_revision_id` IN (
  SELECT `id` FROM `generation_profile_revisions`
  WHERE `adapter_kind` IN ('zimage', 'local-speech')
);
--> statement-breakpoint
DELETE FROM `default_generation_profile_pointers`
WHERE `generation_profile_revision_id` IN (
  SELECT `id` FROM `generation_profile_revisions`
  WHERE `adapter_kind` IN ('zimage', 'local-speech')
);

--> statement-breakpoint
CREATE TABLE `workflow_backend_validations` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_package_digest` text NOT NULL REFERENCES `workflow_package_revisions`(`digest`) ON DELETE CASCADE,
  `execution_backend_id` text NOT NULL REFERENCES `execution_backends`(`id`) ON DELETE CASCADE,
  `environment_fingerprint` text NOT NULL,
  `environment_lock_digest` text,
  `reviewer_id` text NOT NULL,
  `report_json` text NOT NULL,
  `validated_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_backend_validations_pair_unique`
  ON `workflow_backend_validations`(`workflow_package_digest`, `execution_backend_id`);
