-- ============================================================
-- v2.0: 本地工作流平台 — 执行后端、工作流供应链、任务与资源
-- 按迁移计划阶段 A：只加表和兼容代码，不切换旧流程
-- ============================================================

CREATE TABLE `resource_pools` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `capacity` integer NOT NULL DEFAULT 1,
  `policy_json` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL
);
--> statement-breakpoint

CREATE TABLE `execution_backends` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `adapter_kind` text NOT NULL,
  `base_url` text NOT NULL,
  `topology` text NOT NULL,
  `sharing_mode` text NOT NULL,
  `auth_type` text NOT NULL,
  `auth_config_json` text NOT NULL,
  `tls_config_json` text NOT NULL,
  `network_policy_json` text NOT NULL,
  `resource_pool_id` text NOT NULL REFERENCES `resource_pools`(`id`),
  `capabilities_json` text NOT NULL,
  `environment_fingerprint` text,
  `feature_snapshot_json` text,
  `validated_at_ms` integer,
  `enabled` integer NOT NULL DEFAULT 0,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL
);
--> statement-breakpoint

CREATE TABLE `workflow_package_revisions` (
  `digest` text PRIMARY KEY NOT NULL,
  `workflow_id` text NOT NULL,
  `version` text NOT NULL,
  `capability` text NOT NULL,
  `manifest_json` text NOT NULL,
  `compiled_bindings_json` text NOT NULL,
  `package_lock_json` text NOT NULL,
  `package_path` text NOT NULL,
  `workflow_sha256` text NOT NULL,
  `environment_lock_digest` text,
  `created_at_ms` integer NOT NULL,
  UNIQUE(`workflow_id`, `version`)
);
--> statement-breakpoint

CREATE TABLE `workflow_package_states` (
  `workflow_package_digest` text PRIMARY KEY NOT NULL REFERENCES `workflow_package_revisions`(`digest`),
  `state` text NOT NULL,
  `validation_report_json` text,
  `reviewed_by` text,
  `reviewed_at_ms` integer,
  `revoked_at_ms` integer,
  `updated_at_ms` integer NOT NULL
);
--> statement-breakpoint

CREATE TABLE `generation_profile_revisions` (
  `id` text PRIMARY KEY NOT NULL,
  `profile_key` text NOT NULL,
  `revision_no` integer NOT NULL,
  `revision_digest` text NOT NULL UNIQUE,
  `display_name` text NOT NULL,
  `capability` text NOT NULL,
  `adapter_kind` text NOT NULL,
  `execution_backend_id` text REFERENCES `execution_backends`(`id`),
  `workflow_package_digest` text REFERENCES `workflow_package_revisions`(`digest`),
  `config_json` text NOT NULL,
  `created_by` text,
  `created_at_ms` integer NOT NULL,
  UNIQUE(`profile_key`, `revision_no`)
);
--> statement-breakpoint

CREATE TABLE `generation_profile_states` (
  `generation_profile_revision_id` text PRIMARY KEY NOT NULL REFERENCES `generation_profile_revisions`(`id`),
  `enabled` integer NOT NULL DEFAULT 0,
  `visibility` text NOT NULL DEFAULT 'admin',
  `deprecated_at_ms` integer,
  `revoked_at_ms` integer,
  `updated_at_ms` integer NOT NULL
);
--> statement-breakpoint

CREATE TABLE `default_generation_profile_pointers` (
  `scope_type` text NOT NULL,
  `scope_id` text NOT NULL,
  `capability` text NOT NULL,
  `generation_profile_revision_id` text NOT NULL REFERENCES `generation_profile_revisions`(`id`),
  `updated_by` text,
  `updated_at_ms` integer NOT NULL,
  PRIMARY KEY(`scope_type`, `scope_id`, `capability`)
);
--> statement-breakpoint

CREATE TABLE `generation_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `business_task_id` text,
  `project_id` text,
  `capability` text NOT NULL,
  `status` text NOT NULL DEFAULT 'QUEUED',
  `execution_snapshot_json` text NOT NULL,
  `input_digest` text NOT NULL,
  `dedupe_scope` text,
  `current_attempt_id` text,
  `current_artifact_id` text,
  `claim_owner` text,
  `claim_until_ms` integer,
  `claim_fencing_token` integer NOT NULL DEFAULT 0,
  `cancel_requested_at_ms` integer,
  `needs_attention_reason` text,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `completed_at_ms` integer
);
--> statement-breakpoint

CREATE UNIQUE INDEX `generation_jobs_active_dedupe` ON `generation_jobs`(`capability`, `dedupe_scope`)
  WHERE `dedupe_scope` IS NOT NULL AND `status` IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED');
--> statement-breakpoint

CREATE INDEX `generation_jobs_queue_index` ON `generation_jobs`(`status`, `created_at_ms`);
--> statement-breakpoint

CREATE INDEX `generation_jobs_claim_index` ON `generation_jobs`(`status`, `claim_until_ms`);
--> statement-breakpoint

CREATE TABLE `generation_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL REFERENCES `generation_jobs`(`id`) ON DELETE CASCADE,
  `attempt_no` integer NOT NULL,
  `phase` text NOT NULL,
  `backend_id` text NOT NULL REFERENCES `execution_backends`(`id`),
  `backend_feature_snapshot_json` text NOT NULL,
  `environment_fingerprint` text NOT NULL,
  `submission_correlation_id` text NOT NULL UNIQUE,
  `external_id_strategy` text NOT NULL,
  `external_job_id` text,
  `external_queue_number` integer,
  `system_output_prefix` text NOT NULL,
  `progress_snapshot_json` text,
  `error_class` text,
  `error_code` text,
  `error_message_safe` text,
  `resource_pool_id` text NOT NULL REFERENCES `resource_pools`(`id`),
  `resource_slot_no` integer NOT NULL,
  `resource_lease_token` text NOT NULL UNIQUE,
  `resource_fencing_token` integer NOT NULL,
  `submitted_at_ms` integer,
  `started_at_ms` integer,
  `finished_at_ms` integer,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  UNIQUE(`job_id`, `attempt_no`),
  UNIQUE(`backend_id`, `system_output_prefix`)
);
--> statement-breakpoint

CREATE UNIQUE INDEX `generation_attempts_external_job_unique` ON `generation_attempts`(`backend_id`, `external_job_id`)
  WHERE `external_job_id` IS NOT NULL;
--> statement-breakpoint

CREATE INDEX `generation_attempts_active_index` ON `generation_attempts`(`phase`, `updated_at_ms`);
--> statement-breakpoint

CREATE TABLE `resource_pool_slots` (
  `resource_pool_id` text NOT NULL REFERENCES `resource_pools`(`id`),
  `slot_no` integer NOT NULL,
  `owner_attempt_id` text REFERENCES `generation_attempts`(`id`),
  `lease_token` text UNIQUE,
  `fencing_token` integer NOT NULL DEFAULT 0,
  `expires_at_ms` integer,
  `updated_at_ms` integer NOT NULL,
  PRIMARY KEY(`resource_pool_id`, `slot_no`)
);
--> statement-breakpoint

CREATE INDEX `resource_pool_slots_expiry_index` ON `resource_pool_slots`(`expires_at_ms`)
  WHERE `owner_attempt_id` IS NOT NULL;
--> statement-breakpoint

CREATE TABLE `generation_artifacts` (
  `id` text PRIMARY KEY NOT NULL,
  `attempt_id` text NOT NULL REFERENCES `generation_attempts`(`id`),
  `logical_name` text NOT NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `storage_key` text NOT NULL UNIQUE,
  `visibility` text NOT NULL,
  `mime_type` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `sha256` text NOT NULL,
  `width` integer,
  `height` integer,
  `duration_ms` integer,
  `metadata_json` text NOT NULL,
  `parent_artifact_id` text,
  `committed_at_ms` integer,
  `created_at_ms` integer NOT NULL,
  UNIQUE(`attempt_id`, `logical_name`, `sha256`)
);
--> statement-breakpoint

CREATE INDEX `generation_artifacts_attempt_index` ON `generation_artifacts`(`attempt_id`, `status`);
--> statement-breakpoint

CREATE TABLE `generation_events` (
  `id` text PRIMARY KEY NOT NULL,
  `job_id` text NOT NULL REFERENCES `generation_jobs`(`id`) ON DELETE CASCADE,
  `attempt_id` text REFERENCES `generation_attempts`(`id`) ON DELETE CASCADE,
  `event_type` text NOT NULL,
  `severity` text NOT NULL,
  `safe_payload_json` text NOT NULL,
  `created_at_ms` integer NOT NULL
);
--> statement-breakpoint

CREATE INDEX `generation_events_job_time_index` ON `generation_events`(`job_id`, `created_at_ms`);
--> statement-breakpoint

CREATE TABLE `business_task_generation_jobs` (
  `business_task_id` text NOT NULL,
  `generation_job_id` text NOT NULL REFERENCES `generation_jobs`(`id`) ON DELETE CASCADE,
  `relation_kind` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  PRIMARY KEY(`business_task_id`, `generation_job_id`)
);
--> statement-breakpoint

CREATE TABLE `audit_events` (
  `id` text PRIMARY KEY NOT NULL,
  `actor_id` text,
  `action` text NOT NULL,
  `target_type` text NOT NULL,
  `target_id` text NOT NULL,
  `details_safe_json` text NOT NULL,
  `created_at_ms` integer NOT NULL
);
--> statement-breakpoint

CREATE TRIGGER `workflow_package_revisions_no_update`
BEFORE UPDATE ON `workflow_package_revisions`
BEGIN
  SELECT RAISE(ABORT, 'workflow package revisions are immutable');
END;
--> statement-breakpoint

CREATE TRIGGER `workflow_package_revisions_no_delete`
BEFORE DELETE ON `workflow_package_revisions`
BEGIN
  SELECT RAISE(ABORT, 'workflow package revisions cannot be deleted');
END;
--> statement-breakpoint

CREATE TRIGGER `generation_profile_revisions_no_update`
BEFORE UPDATE ON `generation_profile_revisions`
BEGIN
  SELECT RAISE(ABORT, 'generation profile revisions are immutable');
END;
--> statement-breakpoint

CREATE TRIGGER `generation_profile_revisions_no_delete`
BEFORE DELETE ON `generation_profile_revisions`
BEGIN
  SELECT RAISE(ABORT, 'generation profile revisions cannot be deleted');
END;