-- 架构契约示例，不是可直接投入生产的最终迁移。
-- 正式实现应使用 Drizzle（对象关系映射工具）迁移、升级测试和备份恢复演练。
-- 时间字段统一为 UTC 毫秒；租约比较使用数据库时间。
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE resource_pools (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1 CHECK(capacity > 0),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE execution_backends (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  adapter_kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  topology TEXT NOT NULL CHECK(topology IN ('same-host','container-to-host','same-host-container','lan-remote')),
  sharing_mode TEXT NOT NULL CHECK(sharing_mode IN ('dedicated','shared')),
  auth_type TEXT NOT NULL CHECK(auth_type IN ('none','bearer','header-token','basic','mtls')),
  auth_config_json TEXT NOT NULL CHECK(json_valid(auth_config_json)),
  tls_config_json TEXT NOT NULL CHECK(json_valid(tls_config_json)),
  network_policy_json TEXT NOT NULL CHECK(json_valid(network_policy_json)),
  resource_pool_id TEXT NOT NULL REFERENCES resource_pools(id),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  environment_fingerprint TEXT,
  feature_snapshot_json TEXT CHECK(feature_snapshot_json IS NULL OR json_valid(feature_snapshot_json)),
  validated_at_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE workflow_package_revisions (
  digest TEXT PRIMARY KEY CHECK(digest GLOB 'sha256:*'),
  workflow_id TEXT NOT NULL,
  version TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability IN ('image','video','speech','utility')),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  compiled_bindings_json TEXT NOT NULL CHECK(json_valid(compiled_bindings_json)),
  package_lock_json TEXT NOT NULL CHECK(json_valid(package_lock_json)),
  package_path TEXT NOT NULL,
  workflow_sha256 TEXT NOT NULL,
  environment_lock_digest TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(workflow_id, version)
);

CREATE TABLE workflow_package_states (
  workflow_package_digest TEXT PRIMARY KEY REFERENCES workflow_package_revisions(digest),
  state TEXT NOT NULL CHECK(state IN ('installed','validating','reviewed','active','deprecated','revoked','invalid')),
  validation_report_json TEXT CHECK(validation_report_json IS NULL OR json_valid(validation_report_json)),
  reviewed_by TEXT,
  reviewed_at_ms INTEGER,
  revoked_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE generation_profile_revisions (
  id TEXT PRIMARY KEY,
  profile_key TEXT NOT NULL,
  revision_no INTEGER NOT NULL CHECK(revision_no > 0),
  revision_digest TEXT NOT NULL UNIQUE CHECK(revision_digest GLOB 'sha256:*'),
  display_name TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability IN ('text','image','video','speech','utility')),
  adapter_kind TEXT NOT NULL,
  execution_backend_id TEXT REFERENCES execution_backends(id),
  workflow_package_digest TEXT REFERENCES workflow_package_revisions(digest),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  created_by TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(profile_key, revision_no),
  CHECK(adapter_kind <> 'comfyui-http' OR (execution_backend_id IS NOT NULL AND workflow_package_digest IS NOT NULL))
);

CREATE TABLE generation_profile_states (
  generation_profile_revision_id TEXT PRIMARY KEY REFERENCES generation_profile_revisions(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  visibility TEXT NOT NULL DEFAULT 'admin' CHECK(visibility IN ('admin','workspace','project')),
  deprecated_at_ms INTEGER,
  revoked_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE default_generation_profile_pointers (
  scope_type TEXT NOT NULL CHECK(scope_type IN ('global','workspace','project','user')),
  scope_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability IN ('text','image','video','speech')),
  generation_profile_revision_id TEXT NOT NULL REFERENCES generation_profile_revisions(id),
  updated_by TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(scope_type, scope_id, capability)
);

CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  business_task_id TEXT,
  project_id TEXT,
  capability TEXT NOT NULL CHECK(capability IN ('text','image','video','speech','utility')),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','CANCEL_REQUESTED','SUCCEEDED','FAILED','CANCELLED','NEEDS_ATTENTION')),
  execution_snapshot_json TEXT NOT NULL CHECK(json_valid(execution_snapshot_json)),
  input_digest TEXT NOT NULL,
  dedupe_scope TEXT,
  current_attempt_id TEXT REFERENCES generation_attempts(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  current_artifact_id TEXT REFERENCES generation_artifacts(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  claim_owner TEXT,
  claim_until_ms INTEGER,
  claim_fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(claim_fencing_token >= 0),
  cancel_requested_at_ms INTEGER,
  needs_attention_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  CHECK((claim_owner IS NULL AND claim_until_ms IS NULL) OR (claim_owner IS NOT NULL AND claim_until_ms IS NOT NULL))
);

CREATE UNIQUE INDEX generation_jobs_active_dedupe ON generation_jobs(capability, dedupe_scope)
  WHERE dedupe_scope IS NOT NULL AND status IN ('QUEUED','RUNNING','CANCEL_REQUESTED');
CREATE INDEX generation_jobs_queue_index ON generation_jobs(status, created_at_ms);

CREATE TABLE generation_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
  phase TEXT NOT NULL CHECK(phase IN ('CREATED','LEASED','PREPARING','SUBMITTING','SUBMISSION_UNKNOWN','EXTERNAL_QUEUED','EXTERNAL_RUNNING','COLLECTING','COMMITTING','RETRY_WAIT','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELLED','ORPHANED')),
  backend_id TEXT NOT NULL REFERENCES execution_backends(id),
  backend_feature_snapshot_json TEXT NOT NULL CHECK(json_valid(backend_feature_snapshot_json)),
  environment_fingerprint TEXT NOT NULL,
  submission_correlation_id TEXT NOT NULL UNIQUE,
  external_id_strategy TEXT NOT NULL CHECK(external_id_strategy IN ('client-assigned','server-assigned','not-applicable')),
  external_job_id TEXT,
  external_queue_number INTEGER,
  system_output_prefix TEXT NOT NULL,
  progress_snapshot_json TEXT CHECK(progress_snapshot_json IS NULL OR json_valid(progress_snapshot_json)),
  error_class TEXT,
  error_code TEXT,
  error_message_safe TEXT,
  resource_pool_id TEXT NOT NULL REFERENCES resource_pools(id),
  resource_slot_no INTEGER NOT NULL CHECK(resource_slot_no >= 0),
  resource_lease_token TEXT NOT NULL UNIQUE,
  resource_fencing_token INTEGER NOT NULL CHECK(resource_fencing_token > 0),
  submitted_at_ms INTEGER,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(job_id, attempt_no),
  UNIQUE(backend_id, system_output_prefix),
  CHECK(external_id_strategy <> 'client-assigned' OR external_job_id IS NOT NULL),
  CHECK(external_id_strategy <> 'not-applicable' OR external_job_id IS NULL)
);
CREATE UNIQUE INDEX generation_attempts_external_job_unique ON generation_attempts(backend_id, external_job_id) WHERE external_job_id IS NOT NULL;
CREATE INDEX generation_attempts_active_index ON generation_attempts(phase, updated_at_ms);
CREATE INDEX generation_jobs_claim_index ON generation_jobs(status, claim_until_ms);

CREATE TABLE resource_pool_slots (
  resource_pool_id TEXT NOT NULL REFERENCES resource_pools(id),
  slot_no INTEGER NOT NULL CHECK(slot_no >= 0),
  owner_attempt_id TEXT REFERENCES generation_attempts(id) ON DELETE RESTRICT,
  lease_token TEXT UNIQUE,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(fencing_token >= 0),
  expires_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(resource_pool_id, slot_no),
  CHECK((owner_attempt_id IS NULL AND lease_token IS NULL AND expires_at_ms IS NULL) OR (owner_attempt_id IS NOT NULL AND lease_token IS NOT NULL AND expires_at_ms IS NOT NULL))
);
CREATE INDEX resource_pool_slots_expiry_index ON resource_pool_slots(expires_at_ms) WHERE owner_attempt_id IS NOT NULL;

CREATE TABLE generation_artifacts (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES generation_attempts(id),
  logical_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image','video','audio','text','archive')),
  status TEXT NOT NULL CHECK(status IN ('STAGING','COMMITTED','QUARANTINED','DELETED')),
  storage_key TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL CHECK(visibility IN ('private-original','project','export')),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  width INTEGER CHECK(width IS NULL OR width > 0),
  height INTEGER CHECK(height IS NULL OR height > 0),
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  parent_artifact_id TEXT REFERENCES generation_artifacts(id),
  committed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(attempt_id, logical_name, sha256)
);
CREATE INDEX generation_artifacts_attempt_index ON generation_artifacts(attempt_id, status);

CREATE TABLE generation_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES generation_attempts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('debug','info','warning','error','security')),
  safe_payload_json TEXT NOT NULL CHECK(json_valid(safe_payload_json)),
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX generation_events_job_time_index ON generation_events(job_id, created_at_ms);

CREATE TABLE business_task_generation_jobs (
  business_task_id TEXT NOT NULL,
  generation_job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  relation_kind TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(business_task_id, generation_job_id)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_safe_json TEXT NOT NULL CHECK(json_valid(details_safe_json)),
  created_at_ms INTEGER NOT NULL
);

-- 交叉表当前指针必须属于同一个逻辑任务。
CREATE TRIGGER generation_jobs_current_attempt_guard_insert
BEFORE INSERT ON generation_jobs
WHEN NEW.current_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM generation_attempts a WHERE a.id = NEW.current_attempt_id AND a.job_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'current attempt must belong to job'); END;

CREATE TRIGGER generation_jobs_current_attempt_guard_update
BEFORE UPDATE OF current_attempt_id ON generation_jobs
WHEN NEW.current_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM generation_attempts a WHERE a.id = NEW.current_attempt_id AND a.job_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'current attempt must belong to job'); END;

CREATE TRIGGER generation_jobs_current_artifact_guard_update
BEFORE UPDATE OF current_artifact_id ON generation_jobs
WHEN NEW.current_artifact_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM generation_artifacts ar JOIN generation_attempts a ON a.id = ar.attempt_id
  WHERE ar.id = NEW.current_artifact_id AND a.job_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'current artifact must belong to job'); END;

CREATE TRIGGER resource_pool_slots_owner_guard_insert
BEFORE INSERT ON resource_pool_slots
WHEN NEW.owner_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM generation_attempts a
  WHERE a.id = NEW.owner_attempt_id AND a.resource_pool_id = NEW.resource_pool_id AND a.resource_slot_no = NEW.slot_no
)
BEGIN SELECT RAISE(ABORT, 'resource slot owner does not match attempt allocation'); END;

CREATE TRIGGER resource_pool_slots_owner_guard_update
BEFORE UPDATE OF owner_attempt_id, resource_pool_id, slot_no ON resource_pool_slots
WHEN NEW.owner_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM generation_attempts a
  WHERE a.id = NEW.owner_attempt_id AND a.resource_pool_id = NEW.resource_pool_id AND a.resource_slot_no = NEW.slot_no
)
BEGIN SELECT RAISE(ABORT, 'resource slot owner does not match attempt allocation'); END;

CREATE TRIGGER workflow_package_revisions_no_update
BEFORE UPDATE ON workflow_package_revisions
BEGIN SELECT RAISE(ABORT, 'workflow package revisions are immutable'); END;
CREATE TRIGGER workflow_package_revisions_no_delete BEFORE DELETE ON workflow_package_revisions BEGIN SELECT RAISE(ABORT, 'workflow package revisions cannot be deleted'); END;
CREATE TRIGGER generation_profile_revisions_no_update BEFORE UPDATE ON generation_profile_revisions BEGIN SELECT RAISE(ABORT, 'generation profile revisions are immutable'); END;
CREATE TRIGGER generation_profile_revisions_no_delete BEFORE DELETE ON generation_profile_revisions BEGIN SELECT RAISE(ABORT, 'generation profile revisions cannot be deleted'); END;
