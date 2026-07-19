CREATE TABLE `job_input_artifacts` (
  `job_id` text NOT NULL REFERENCES `generation_jobs`(`id`) ON DELETE CASCADE,
  `artifact_kind` text NOT NULL,
  `artifact_id` text NOT NULL,
  `role` text NOT NULL,
  `storage_key` text NOT NULL,
  `sha256` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `mime_type` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  PRIMARY KEY (`job_id`, `artifact_kind`, `artifact_id`, `role`),
  CONSTRAINT `job_input_artifacts_kind_check`
    CHECK (`artifact_kind` IN ('source-media', 'generation-artifact')),
  CONSTRAINT `job_input_artifacts_descriptor_check`
    CHECK (length(`storage_key`) > 0 AND length(`sha256`) = 64 AND `size_bytes` > 0 AND length(`mime_type`) > 0)
);
--> statement-breakpoint
CREATE INDEX `job_input_artifacts_lookup_idx`
  ON `job_input_artifacts` (`artifact_kind`, `artifact_id`, `job_id`);
--> statement-breakpoint
CREATE TRIGGER `job_input_artifacts_guard_insert`
BEFORE INSERT ON `job_input_artifacts`
FOR EACH ROW
WHEN (
  NEW.artifact_kind = 'source-media'
  AND NOT EXISTS (
    SELECT 1 FROM `source_media_assets` AS s
    JOIN `generation_jobs` AS j ON j.id = NEW.job_id
    WHERE s.id = NEW.artifact_id
      AND s.project_id = j.project_id
      AND s.status = 'COMMITTED'
      AND s.storage_key = NEW.storage_key
      AND s.sha256 = NEW.sha256
      AND s.size_bytes = NEW.size_bytes
      AND s.mime_type = NEW.mime_type
  )
) OR (
  NEW.artifact_kind = 'generation-artifact'
  AND NOT EXISTS (
    SELECT 1 FROM `generation_artifacts` AS a
    JOIN `generation_attempts` AS ga ON ga.id = a.attempt_id
    JOIN `generation_jobs` AS source_job ON source_job.id = ga.job_id
    JOIN `generation_jobs` AS target_job ON target_job.id = NEW.job_id
    WHERE a.id = NEW.artifact_id
      AND a.status = 'COMMITTED'
      AND source_job.project_id = target_job.project_id
      AND a.storage_key = NEW.storage_key
      AND a.sha256 = NEW.sha256
      AND a.size_bytes = NEW.size_bytes
      AND a.mime_type = NEW.mime_type
  )
)
BEGIN
  SELECT RAISE(ABORT, 'job input artifact descriptor is unavailable');
END;
--> statement-breakpoint
CREATE TRIGGER `job_input_source_delete_guard`
BEFORE UPDATE OF `status` ON `source_media_assets`
FOR EACH ROW
WHEN NEW.status <> OLD.status
  AND EXISTS (
    SELECT 1 FROM `job_input_artifacts`
    WHERE artifact_kind = 'source-media' AND artifact_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'source media asset has a durable job snapshot');
END;
--> statement-breakpoint
CREATE TRIGGER `job_input_generation_artifact_mutation_guard`
BEFORE UPDATE ON `generation_artifacts`
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM `job_input_artifacts`
  WHERE artifact_kind = 'generation-artifact' AND artifact_id = OLD.id
)
AND (
  NEW.status <> OLD.status
  OR NEW.storage_key <> OLD.storage_key
  OR NEW.sha256 <> OLD.sha256
  OR NEW.size_bytes <> OLD.size_bytes
  OR NEW.mime_type <> OLD.mime_type
)
BEGIN
  SELECT RAISE(ABORT, 'generation artifact has a durable job snapshot');
END;
