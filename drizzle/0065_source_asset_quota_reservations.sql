CREATE TABLE `source_asset_quota_reservations` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL,
  `upload_token` text NOT NULL UNIQUE,
  `reserved_bytes` integer NOT NULL,
  `actual_bytes` integer,
  `status` text NOT NULL,
  `expires_at_ms` integer NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  CONSTRAINT `source_asset_quota_reservations_status_check`
    CHECK (`status` IN ('RESERVED', 'COMMITTED', 'RELEASED')),
  CONSTRAINT `source_asset_quota_reservations_size_check`
    CHECK (`reserved_bytes` > 0 AND (`actual_bytes` IS NULL OR `actual_bytes` > 0))
);
--> statement-breakpoint
CREATE INDEX `source_asset_quota_reservations_project_status_idx`
  ON `source_asset_quota_reservations` (`project_id`, `status`, `expires_at_ms`);
