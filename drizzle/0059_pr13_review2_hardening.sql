ALTER TABLE `generation_jobs` ADD COLUMN `idempotency_request_digest` text;
--> statement-breakpoint
ALTER TABLE `voice_profiles` ADD COLUMN `consent_statement_version` text DEFAULT 'voice-clone-consent-v1' NOT NULL;
--> statement-breakpoint
CREATE INDEX `source_media_assets_status_updated_idx` ON `source_media_assets` (`status`,`updated_at_ms`);
--> statement-breakpoint
CREATE INDEX `voice_profiles_reference_source_asset_idx` ON `voice_profiles` (`reference_source_asset_id`);
--> statement-breakpoint
CREATE INDEX `generation_jobs_claim_queue_idx` ON `generation_jobs` (`status`,`capability`,`created_at_ms`);
--> statement-breakpoint
CREATE TRIGGER `source_media_assets_validate_insert`
BEFORE INSERT ON `source_media_assets`
FOR EACH ROW
WHEN NEW.kind NOT IN ('image','video','audio')
  OR NEW.status NOT IN ('STAGING','COMMITTED','QUARANTINED','DELETED')
  OR NEW.size_bytes <= 0
  OR length(NEW.sha256) <> 64
  OR NEW.sha256 GLOB '*[^0-9a-f]*'
  OR (NEW.kind = 'audio' AND (NEW.duration_ms IS NULL OR NEW.duration_ms <= 0))
BEGIN
  SELECT RAISE(ABORT, 'invalid source media asset');
END;
--> statement-breakpoint
CREATE TRIGGER `source_media_assets_validate_update`
BEFORE UPDATE ON `source_media_assets`
FOR EACH ROW
WHEN NEW.kind NOT IN ('image','video','audio')
  OR NEW.status NOT IN ('STAGING','COMMITTED','QUARANTINED','DELETED')
  OR NEW.size_bytes <= 0
  OR length(NEW.sha256) <> 64
  OR NEW.sha256 GLOB '*[^0-9a-f]*'
  OR (NEW.kind = 'audio' AND (NEW.duration_ms IS NULL OR NEW.duration_ms <= 0))
BEGIN
  SELECT RAISE(ABORT, 'invalid source media asset');
END;
--> statement-breakpoint
CREATE TRIGGER `source_media_assets_status_transition_guard`
BEFORE UPDATE OF `status` ON `source_media_assets`
FOR EACH ROW
WHEN NEW.status <> OLD.status
  AND NOT (
    (OLD.status = 'STAGING' AND NEW.status IN ('COMMITTED','QUARANTINED'))
    OR (OLD.status = 'COMMITTED' AND NEW.status IN ('QUARANTINED','DELETED'))
    OR (OLD.status = 'QUARANTINED' AND NEW.status = 'DELETED')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid source media asset status transition');
END;
--> statement-breakpoint
CREATE TRIGGER `voice_profiles_validate_insert`
BEFORE INSERT ON `voice_profiles`
FOR EACH ROW
WHEN NEW.provider NOT IN ('indextts2','omnivoice')
  OR NEW.default_speed_milli < 500 OR NEW.default_speed_milli > 2000
  OR NEW.default_pitch_milli < 500 OR NEW.default_pitch_milli > 2000
  OR NEW.consent_confirmed_at_ms <= 0
  OR NEW.consent_statement_version <> 'voice-clone-consent-v1'
BEGIN
  SELECT RAISE(ABORT, 'invalid voice profile');
END;
--> statement-breakpoint
CREATE TRIGGER `voice_profiles_validate_update`
BEFORE UPDATE ON `voice_profiles`
FOR EACH ROW
WHEN NEW.provider NOT IN ('indextts2','omnivoice')
  OR NEW.default_speed_milli < 500 OR NEW.default_speed_milli > 2000
  OR NEW.default_pitch_milli < 500 OR NEW.default_pitch_milli > 2000
  OR NEW.consent_confirmed_at_ms <= 0
  OR NEW.consent_statement_version <> 'voice-clone-consent-v1'
BEGIN
  SELECT RAISE(ABORT, 'invalid voice profile');
END;
--> statement-breakpoint
CREATE TRIGGER `voice_profiles_immutable_identity_guard`
BEFORE UPDATE ON `voice_profiles`
FOR EACH ROW
WHEN NEW.project_id <> OLD.project_id
  OR NEW.user_id <> OLD.user_id
  OR NEW.provider <> OLD.provider
  OR NEW.reference_artifact_id IS NOT OLD.reference_artifact_id
  OR NEW.reference_source_asset_id IS NOT OLD.reference_source_asset_id
  OR NEW.consent_confirmed_at_ms <> OLD.consent_confirmed_at_ms
  OR NEW.consent_statement_version <> OLD.consent_statement_version
BEGIN
  SELECT RAISE(ABORT, 'voice profile identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `voice_profiles_source_reference_guard_insert`
BEFORE INSERT ON `voice_profiles`
FOR EACH ROW
WHEN NEW.reference_source_asset_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `source_media_assets` AS s
    WHERE s.id = NEW.reference_source_asset_id
      AND s.project_id = NEW.project_id
      AND s.user_id = NEW.user_id
      AND s.kind = 'audio'
      AND s.status = 'COMMITTED'
  )
BEGIN
  SELECT RAISE(ABORT, 'voice profile source reference is unavailable');
END;
--> statement-breakpoint
CREATE TRIGGER `voice_profiles_source_reference_guard_update`
BEFORE UPDATE ON `voice_profiles`
FOR EACH ROW
WHEN NEW.reference_source_asset_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `source_media_assets` AS s
    WHERE s.id = NEW.reference_source_asset_id
      AND s.project_id = NEW.project_id
      AND s.user_id = NEW.user_id
      AND s.kind = 'audio'
      AND s.status = 'COMMITTED'
  )
BEGIN
  SELECT RAISE(ABORT, 'voice profile source reference is unavailable');
END;
--> statement-breakpoint
CREATE TRIGGER `generation_job_source_assets_guard_insert`
BEFORE INSERT ON `generation_job_source_assets`
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM `source_media_assets` AS s
  JOIN `generation_jobs` AS j ON j.id = NEW.job_id
  WHERE s.id = NEW.source_asset_id
    AND s.project_id = j.project_id
    AND s.status = 'COMMITTED'
)
BEGIN
  SELECT RAISE(ABORT, 'generation source asset is unavailable');
END;
--> statement-breakpoint
CREATE TRIGGER `source_media_assets_delete_reference_guard`
BEFORE UPDATE OF `status` ON `source_media_assets`
FOR EACH ROW
WHEN NEW.status = 'DELETED'
  AND OLD.status <> 'DELETED'
  AND (
    EXISTS (SELECT 1 FROM `voice_profiles` WHERE reference_source_asset_id = OLD.id)
    OR EXISTS (SELECT 1 FROM `generation_job_source_assets` WHERE source_asset_id = OLD.id)
  )
BEGIN
  SELECT RAISE(ABORT, 'source media asset is still referenced');
END;
--> statement-breakpoint
CREATE TRIGGER `source_media_assets_immutable_content_guard`
BEFORE UPDATE ON `source_media_assets`
FOR EACH ROW
WHEN NEW.id <> OLD.id
  OR NEW.project_id <> OLD.project_id
  OR NEW.user_id <> OLD.user_id
  OR NEW.kind <> OLD.kind
  OR NEW.storage_key <> OLD.storage_key
  OR NEW.mime_type <> OLD.mime_type
  OR NEW.size_bytes <> OLD.size_bytes
  OR NEW.sha256 <> OLD.sha256
  OR NEW.duration_ms IS NOT OLD.duration_ms
  OR NEW.metadata_json <> OLD.metadata_json
  OR NEW.created_at_ms <> OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'source media asset content is immutable');
END;

--> statement-breakpoint
CREATE TRIGGER `generation_jobs_idempotency_digest_guard_insert`
BEFORE INSERT ON `generation_jobs`
FOR EACH ROW
WHEN NEW.idempotency_key IS NOT NULL
  AND (NEW.idempotency_request_digest IS NULL
    OR length(NEW.idempotency_request_digest) <> 71
    OR substr(NEW.idempotency_request_digest, 1, 7) <> 'sha256:'
    OR substr(NEW.idempotency_request_digest, 8) GLOB '*[^0-9a-f]*')
BEGIN
  SELECT RAISE(ABORT, 'invalid idempotency request digest');
END;
--> statement-breakpoint
CREATE TRIGGER `generation_jobs_idempotency_digest_guard_update`
BEFORE UPDATE ON `generation_jobs`
FOR EACH ROW
WHEN NEW.idempotency_key IS NOT NULL
  AND NEW.idempotency_request_digest IS NOT NULL
  AND (length(NEW.idempotency_request_digest) <> 71
    OR substr(NEW.idempotency_request_digest, 1, 7) <> 'sha256:'
    OR substr(NEW.idempotency_request_digest, 8) GLOB '*[^0-9a-f]*')
BEGIN
  SELECT RAISE(ABORT, 'invalid idempotency request digest');
END;
--> statement-breakpoint
CREATE TRIGGER `generation_jobs_idempotency_identity_guard`
BEFORE UPDATE ON `generation_jobs`
FOR EACH ROW
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
  OR (OLD.idempotency_request_digest IS NOT NULL
    AND NEW.idempotency_request_digest IS NOT OLD.idempotency_request_digest)
BEGIN
  SELECT RAISE(ABORT, 'generation job idempotency identity is immutable');
END;
