ALTER TABLE `voice_profiles` ADD `idempotency_key` text;
--> statement-breakpoint
ALTER TABLE `voice_profiles` ADD `idempotency_request_digest` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_profiles_idempotency_unique`
  ON `voice_profiles` (`project_id`, `user_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `voice_profiles_idempotency_guard_insert`
BEFORE INSERT ON `voice_profiles`
FOR EACH ROW
WHEN (NEW.idempotency_key IS NULL) <> (NEW.idempotency_request_digest IS NULL)
  OR (NEW.idempotency_key IS NOT NULL AND (
    length(NEW.idempotency_key) < 1
    OR length(NEW.idempotency_key) > 160
    OR length(NEW.idempotency_request_digest) <> 71
    OR substr(NEW.idempotency_request_digest, 1, 7) <> 'sha256:'
    OR substr(NEW.idempotency_request_digest, 8) GLOB '*[^0-9a-f]*'
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid voice profile idempotency identity');
END;
--> statement-breakpoint
CREATE TRIGGER `voice_profiles_idempotency_identity_guard`
BEFORE UPDATE ON `voice_profiles`
FOR EACH ROW
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.idempotency_request_digest IS NOT OLD.idempotency_request_digest
BEGIN
  SELECT RAISE(ABORT, 'voice profile idempotency identity is immutable');
END;
