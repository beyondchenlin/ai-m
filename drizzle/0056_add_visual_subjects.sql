CREATE TABLE `visual_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`character_id` text,
	`identity_anchors_json` text NOT NULL,
	`variable_slots_json` text NOT NULL,
	`forbidden_features_json` text NOT NULL,
	`multi_angle_references_json` text NOT NULL,
	`current_version` integer NOT NULL DEFAULT 1,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `visual_subject_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`visual_subject_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`visual_subject_id`) REFERENCES `visual_subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
