CREATE TABLE `source_media_assets` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `user_id` text NOT NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `storage_key` text NOT NULL,
  `mime_type` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `sha256` text NOT NULL,
  `duration_ms` integer,
  `metadata_json` text NOT NULL DEFAULT '{}',
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_media_assets_storage_key_unique` ON `source_media_assets` (`storage_key`);
--> statement-breakpoint
CREATE INDEX `source_media_assets_owner_project_idx` ON `source_media_assets` (`user_id`,`project_id`,`status`);

--> statement-breakpoint
CREATE TABLE `generation_job_source_assets` (
  `job_id` text NOT NULL,
  `source_asset_id` text NOT NULL,
  `role` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  PRIMARY KEY (`job_id`,`source_asset_id`,`role`),
  FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`source_asset_id`) REFERENCES `source_media_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `generation_job_source_assets_asset_idx` ON `generation_job_source_assets` (`source_asset_id`,`job_id`);

--> statement-breakpoint
ALTER TABLE `voice_profiles` RENAME TO `voice_profiles_pr13_legacy`;
--> statement-breakpoint
CREATE TABLE `voice_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `user_id` text NOT NULL,
  `name` text NOT NULL,
  `provider` text NOT NULL,
  `reference_artifact_id` text,
  `reference_source_asset_id` text,
  `reference_text` text,
  `language` text DEFAULT 'zh-CN' NOT NULL,
  `default_speed_milli` integer DEFAULT 1000 NOT NULL,
  `default_pitch_milli` integer DEFAULT 1000 NOT NULL,
  `consent_confirmed_at_ms` integer NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`reference_artifact_id`) REFERENCES `generation_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`reference_source_asset_id`) REFERENCES `source_media_assets`(`id`) ON UPDATE no action ON DELETE no action,
  CHECK ((`reference_artifact_id` IS NOT NULL AND `reference_source_asset_id` IS NULL) OR (`reference_artifact_id` IS NULL AND `reference_source_asset_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `voice_profiles` (
  `id`,`project_id`,`user_id`,`name`,`provider`,`reference_artifact_id`,`reference_source_asset_id`,
  `reference_text`,`language`,`default_speed_milli`,`default_pitch_milli`,`consent_confirmed_at_ms`,`created_at_ms`,`updated_at_ms`
)
SELECT
  `id`,`project_id`,`user_id`,`name`,`provider`,`reference_artifact_id`,NULL,
  `reference_text`,`language`,`default_speed_milli`,`default_pitch_milli`,`consent_confirmed_at_ms`,`created_at_ms`,`updated_at_ms`
FROM `voice_profiles_pr13_legacy`;
--> statement-breakpoint
DROP TABLE `voice_profiles_pr13_legacy`;
--> statement-breakpoint
CREATE INDEX `voice_profiles_project_user_index` ON `voice_profiles` (`project_id`,`user_id`);
