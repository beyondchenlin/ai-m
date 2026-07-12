CREATE TABLE `key_references` (
  `id` text PRIMARY KEY NOT NULL,
  `label` text NOT NULL,
  `key_type` text NOT NULL,
  `secret_value` text NOT NULL,
  `created_by` text,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL
);