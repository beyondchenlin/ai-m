#!/usr/bin/env python3
"""PR-12 SQLite migration smoke tests without application dependencies.

Runs every SQL migration against an empty database and verifies the platform
hardening columns/tables/triggers.  It also upgrades a database stopped at 0053
through the current platform migrations, including an upgrade from 0058 with legacy idempotency rows.
"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = sorted((ROOT / "drizzle").glob("[0-9][0-9][0-9][0-9]_*.sql"))


def statements(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8")
    return [part.strip() for part in raw.split("--> statement-breakpoint") if part.strip()]


def apply(conn: sqlite3.Connection, paths: list[Path]) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    for path in paths:
        try:
            with conn:
                for statement in statements(path):
                    conn.executescript(statement)
        except Exception as exc:  # noqa: BLE001 - print migration identity
            raise RuntimeError(f"migration failed: {path.name}: {exc}") from exc


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(row[1] == column for row in conn.execute(f'PRAGMA table_info("{table}")'))


def assert_hardened(conn: sqlite3.Connection) -> None:
    required_tables = {
        "generation_jobs",
        "generation_attempts",
        "generation_artifacts",
        "workflow_package_revisions",
        "workflow_package_states",
        "workflow_backend_validations",
        "voice_profiles",
        "source_media_assets",
        "generation_job_source_assets",
        "visual_subjects",
        "resource_reconciliation_proofs",
        "trusted_proxy_nonces",
        "job_input_artifacts",
        "source_asset_quota_reservations",
        "workflow_package_approvals",
        "operational_alerts",
    }
    missing = sorted(name for name in required_tables if not table_exists(conn, name))
    if missing:
        raise AssertionError(f"missing tables: {missing}")

    required_columns = {
        ("workflow_package_revisions", "workflow_api_json"),
        ("workflow_package_revisions", "compiler_version"),
        ("generation_jobs", "idempotency_key"),
        ("generation_jobs", "idempotency_request_digest"),
        ("generation_jobs", "requested_by"),
        ("generation_attempts", "job_claim_fencing_token"),
        ("generation_artifacts", "updated_at_ms"),
        ("generation_artifacts", "writer_lease_owner"),
        ("generation_artifacts", "writer_lease_token"),
        ("generation_artifacts", "writer_lease_expires_at_ms"),
        ("generation_artifacts", "recovery_lease_owner"),
        ("generation_artifacts", "recovery_lease_token"),
        ("generation_artifacts", "recovery_lease_expires_at_ms"),
        ("voice_profiles", "consent_statement_version"),
        ("voice_profiles", "idempotency_key"),
        ("voice_profiles", "idempotency_request_digest"),
        ("workflow_backend_validations", "validation_kind"),
        ("generation_jobs", "input_retention_until_ms"),
        ("generation_jobs", "inputs_released_at_ms"),
    }
    missing_columns = sorted(
        f"{table}.{column}"
        for table, column in required_columns
        if not column_exists(conn, table, column)
    )
    if missing_columns:
        raise AssertionError(f"missing columns: {missing_columns}")

    triggers = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'")
    }
    required_triggers = {
        "workflow_package_revisions_no_update",
        "workflow_package_revisions_no_delete",
        "generation_job_terminal_status_guard",
        "source_media_assets_validate_insert",
        "source_media_assets_validate_update",
        "source_media_assets_status_transition_guard",
        "voice_profiles_validate_insert",
        "voice_profiles_validate_update",
        "voice_profiles_immutable_identity_guard",
        "voice_profiles_source_reference_guard_insert",
        "voice_profiles_source_reference_guard_update",
        "generation_job_source_assets_guard_insert",
        "source_media_assets_delete_reference_guard",
        "source_media_assets_immutable_content_guard",
        "generation_jobs_idempotency_digest_guard_insert",
        "generation_jobs_idempotency_digest_guard_update",
        "generation_jobs_idempotency_identity_guard",
        "generation_artifacts_lease_validate_insert",
        "generation_artifacts_lease_validate_update",
        "job_input_artifacts_guard_insert",
        "job_input_source_delete_guard",
        "job_input_generation_artifact_mutation_guard",
        "voice_profiles_idempotency_guard_insert",
        "voice_profiles_idempotency_identity_guard",
        "workflow_package_approvals_guard_insert",
        "workflow_package_approvals_no_update",
        "workflow_package_approvals_no_delete",
        "operational_alerts_guard_insert",
        "operational_alerts_guard_update",
        "workflow_backend_validations_kind_guard_insert",
        "workflow_backend_validations_kind_guard_update",
        "generation_jobs_input_retention_guard_insert",
        "generation_jobs_input_retention_guard_update",
    }
    missing_triggers = sorted(required_triggers - triggers)
    if missing_triggers:
        raise AssertionError(f"missing triggers: {missing_triggers}")

    indexes = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")
    }
    required_indexes = {
        "generation_jobs_idempotency_unique",
        "generation_jobs_active_dedupe_unique",
        "business_task_generation_jobs_job_unique",
        "voice_profiles_project_user_index",
        "source_media_assets_storage_key_unique",
        "source_media_assets_owner_project_idx",
        "generation_job_source_assets_asset_idx",
        "workflow_backend_validations_kind_unique",
        "generation_jobs_input_retention_idx",
        "source_media_assets_status_updated_idx",
        "resource_reconciliation_proofs_lease_unique",
        "resource_reconciliation_proofs_external_unique",
        "resource_reconciliation_proofs_disposition_observed_idx",
        "resource_pool_slots_owner_attempt_unique",
        "generation_artifacts_recovery_scan_index",
        "trusted_proxy_nonces_expiry_idx",
        "job_input_artifacts_lookup_idx",
        "source_asset_quota_reservations_project_status_idx",
        "voice_profiles_idempotency_unique",
        "workflow_package_approvals_reviewer_unique",
        "workflow_package_approvals_release_lookup_idx",
        "operational_alerts_status_severity_idx",
    }
    missing_indexes = sorted(required_indexes - indexes)
    if missing_indexes:
        raise AssertionError(f"missing indexes: {missing_indexes}")

    pk_columns = {
        row[1] for row in conn.execute("PRAGMA table_info('generation_job_source_assets')") if row[5] > 0
    }
    if pk_columns != {"job_id", "source_asset_id", "role"}:
        raise AssertionError(f"generation_job_source_assets composite primary key is invalid: {pk_columns}")

    nonce_pk_columns = {
        row[1] for row in conn.execute("PRAGMA table_info('trusted_proxy_nonces')") if row[5] > 0
    }
    if nonce_pk_columns != {"issuer", "key_id", "nonce"}:
        raise AssertionError(f"trusted_proxy_nonces composite primary key is invalid: {nonce_pk_columns}")
    input_snapshot_pk_columns = {
        row[1] for row in conn.execute("PRAGMA table_info('job_input_artifacts')") if row[5] > 0
    }
    if input_snapshot_pk_columns != {"job_id", "artifact_kind", "artifact_id", "role"}:
        raise AssertionError(
            f"job_input_artifacts composite primary key is invalid: {input_snapshot_pk_columns}"
        )
    conn.execute(
        "INSERT INTO trusted_proxy_nonces (issuer, key_id, nonce, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?)",
        ("migration-issuer", "migration-key", "migration-nonce-0001", 2, 1),
    )
    try:
        conn.execute(
            "INSERT INTO trusted_proxy_nonces (issuer, key_id, nonce, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?)",
            ("migration-issuer", "migration-key", "migration-nonce-0001", 3, 2),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("trusted proxy nonce uniqueness is missing")

    proof_columns = {
        row[1]: row for row in conn.execute("PRAGMA table_info('resource_reconciliation_proofs')")
    }
    if proof_columns.get("external_job_id", (None, None, None, 0))[3] != 1:
        raise AssertionError("resource reconciliation external identity must be NOT NULL")

    try:
        conn.execute(
            "INSERT INTO voice_profiles (id, project_id, user_id, name, provider, reference_artifact_id, reference_source_asset_id, language, default_speed_milli, default_pitch_milli, consent_confirmed_at_ms, created_at_ms, updated_at_ms) VALUES ('invalid-profile', 'missing-project', 'u', 'n', 'indextts2', NULL, NULL, 'zh-CN', 1000, 1000, 1, 1, 1)"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("voice profile exactly-one-reference constraint is missing")

    # Source asset rows are content-addressed evidence: malformed digests and
    # backwards lifecycle transitions must be rejected by the database too.
    project_id = "migration-project"
    conn.execute(
        "INSERT OR IGNORE INTO projects (id, user_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        (project_id, "migration-user", "Migration", "draft"),
    )
    try:
        conn.execute(
            "INSERT INTO source_media_assets (id, project_id, user_id, kind, status, storage_key, mime_type, size_bytes, sha256, duration_ms, metadata_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 'audio', 'COMMITTED', ?, 'audio/wav', 100, ?, 5000, '{}', 1, 1)",
            ("invalid-digest", project_id, "migration-user", "migration/invalid.wav", "z" * 64),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("source asset digest validation is missing")

    source_id = "migration-source"
    conn.execute(
        "INSERT INTO source_media_assets (id, project_id, user_id, kind, status, storage_key, mime_type, size_bytes, sha256, duration_ms, metadata_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 'audio', 'STAGING', ?, 'audio/wav', 100, ?, 5000, '{}', 1, 1)",
        (source_id, project_id, "migration-user", "migration/source.wav", "a" * 64),
    )
    conn.execute("UPDATE source_media_assets SET status='COMMITTED' WHERE id=?", (source_id,))
    try:
        conn.execute("UPDATE source_media_assets SET status='STAGING' WHERE id=?", (source_id,))
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("source asset backwards status transition was accepted")

    profile_id = "migration-valid-profile"
    conn.execute(
        "INSERT INTO voice_profiles (id, project_id, user_id, name, provider, reference_artifact_id, reference_source_asset_id, reference_text, language, default_speed_milli, default_pitch_milli, consent_confirmed_at_ms, consent_statement_version, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 'Voice', 'indextts2', NULL, ?, NULL, 'zh-CN', 1000, 1000, 1, 'voice-clone-consent-v1', 1, 1)",
        (profile_id, project_id, "migration-user", source_id),
    )
    try:
        conn.execute("UPDATE voice_profiles SET provider='omnivoice' WHERE id=?", (profile_id,))
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("voice profile identity mutation was accepted")

    try:
        conn.execute(
            "INSERT INTO voice_profiles (id, project_id, user_id, name, provider, reference_artifact_id, reference_source_asset_id, reference_text, language, default_speed_milli, default_pitch_milli, consent_confirmed_at_ms, consent_statement_version, idempotency_key, idempotency_request_digest, created_at_ms, updated_at_ms) VALUES ('invalid-idempotent-profile', ?, 'migration-user', 'Voice', 'indextts2', NULL, ?, NULL, 'zh-CN', 1000, 1000, 1, 'voice-clone-consent-v1', 'profile-create', ?, 1, 1)",
            (project_id, source_id, "sha256:" + "A" * 64),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("voice profile accepted a non-lowercase idempotency digest")

    idempotent_profile_id = "migration-idempotent-profile"
    conn.execute(
        "INSERT INTO voice_profiles (id, project_id, user_id, name, provider, reference_artifact_id, reference_source_asset_id, reference_text, language, default_speed_milli, default_pitch_milli, consent_confirmed_at_ms, consent_statement_version, idempotency_key, idempotency_request_digest, created_at_ms, updated_at_ms) VALUES (?, ?, 'migration-user', 'Voice', 'indextts2', NULL, ?, NULL, 'zh-CN', 1000, 1000, 1, 'voice-clone-consent-v1', 'profile-create', ?, 1, 1)",
        (idempotent_profile_id, project_id, source_id, "sha256:" + "f" * 64),
    )
    try:
        conn.execute(
            "UPDATE voice_profiles SET idempotency_request_digest=? WHERE id=?",
            ("sha256:" + "e" * 64, idempotent_profile_id),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("voice profile idempotency identity mutation was accepted")

    try:
        conn.execute("UPDATE source_media_assets SET status='DELETED' WHERE id=?", (source_id,))
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("referenced source asset deletion was accepted")


    try:
        conn.execute(
            "INSERT INTO generation_jobs (id, project_id, capability, status, execution_snapshot_json, input_digest, idempotency_key, idempotency_request_digest, input_retention_until_ms, created_at_ms, updated_at_ms, metadata_json) VALUES (?, ?, 'speech', 'QUEUED', '{}', ?, 'same-operation', NULL, 2, 1, 1, '{}')",
            ("invalid-idempotency", project_id, "sha256:" + "b" * 64),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("idempotent generation job accepted without a request digest")

    idempotent_job = "valid-idempotency"
    digest = "sha256:" + "c" * 64
    conn.execute(
        "INSERT INTO generation_jobs (id, project_id, capability, status, execution_snapshot_json, input_digest, idempotency_key, idempotency_request_digest, input_retention_until_ms, created_at_ms, updated_at_ms, metadata_json) VALUES (?, ?, 'speech', 'QUEUED', '{}', ?, 'stable-operation', ?, 2, 1, 1, '{}')",
        (idempotent_job, project_id, "sha256:" + "d" * 64, digest),
    )
    try:
        conn.execute(
            "UPDATE generation_jobs SET idempotency_request_digest=? WHERE id=?",
            ("sha256:" + "e" * 64, idempotent_job),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("idempotency request identity mutation was accepted")

    # Terminal success must not be mutable; failed/cancelled jobs remain retryable.
    conn.execute(
        "INSERT INTO generation_jobs (id, project_id, capability, status, execution_snapshot_json, input_digest, input_retention_until_ms, created_at_ms, updated_at_ms, metadata_json) VALUES (?, ?, ?, ?, '{}', ?, 2, 1, 1, '{}')",
        ("migration-job", project_id, "image", "SUCCEEDED", "sha256:test"),
    )
    try:
        conn.execute("UPDATE generation_jobs SET status='FAILED' WHERE id='migration-job'")
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("terminal success trigger did not reject status mutation")


def run_case(name: str, paths: list[Path]) -> None:
    with tempfile.TemporaryDirectory(prefix="ai-m-migrations-") as tmp:
        db_path = Path(tmp) / "test.sqlite"
        conn = sqlite3.connect(db_path)
        try:
            apply(conn, paths)
            assert_hardened(conn)
            result = conn.execute("PRAGMA foreign_key_check").fetchall()
            if result:
                raise AssertionError(f"foreign key violations: {result[:5]}")
        finally:
            conn.close()
    print(f"PASS {name}: {len(paths)} migrations")


def main() -> int:
    if not MIGRATIONS:
        print("No migrations found", file=sys.stderr)
        return 2
    run_case("empty-database", MIGRATIONS)

    # Legacy applications may be baselined through 0053.  The platform migrations
    # must still apply in sequence and must not be marked as already executed.
    legacy = [p for p in MIGRATIONS if int(p.name[:4]) <= 53]
    platform = [p for p in MIGRATIONS if int(p.name[:4]) >= 54]
    with tempfile.TemporaryDirectory(prefix="ai-m-legacy-") as tmp:
        conn = sqlite3.connect(Path(tmp) / "legacy.sqlite")
        try:
            apply(conn, legacy)
            apply(conn, platform)
            assert_hardened(conn)
            violations = conn.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise AssertionError(f"legacy upgrade foreign key violations: {violations[:5]}")
        finally:
            conn.close()
    print(f"PASS legacy-0053-upgrade: {len(platform)} platform migrations")

    pre_review2 = [p for p in MIGRATIONS if int(p.name[:4]) <= 58]
    review2 = [p for p in MIGRATIONS if int(p.name[:4]) >= 59]
    with tempfile.TemporaryDirectory(prefix="ai-m-0058-upgrade-") as tmp:
        conn = sqlite3.connect(Path(tmp) / "pre-review2.sqlite")
        try:
            apply(conn, pre_review2)
            conn.execute(
                "INSERT OR IGNORE INTO projects (id, user_id, title, status, created_at, updated_at) VALUES ('p58', 'u58', 'P58', 'draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            )
            conn.execute(
                "INSERT INTO generation_jobs (id, project_id, capability, status, execution_snapshot_json, input_digest, idempotency_key, created_at_ms, updated_at_ms, metadata_json) VALUES ('legacy-idem', 'p58', 'speech', 'QUEUED', '{}', ?, 'legacy-key', 1, 1, '{}')",
                ("sha256:" + "a" * 64,),
            )
            apply(conn, review2)
            conn.execute("UPDATE generation_jobs SET status='RUNNING' WHERE id='legacy-idem'")
            if conn.execute("SELECT idempotency_request_digest FROM generation_jobs WHERE id='legacy-idem'").fetchone()[0] is not None:
                raise AssertionError("0059 unexpectedly invented a legacy idempotency digest")
            assert_hardened(conn)
        finally:
            conn.close()
    print(f"PASS legacy-0058-upgrade: {len(review2)} review2 migrations")

    for boundary in (60, 61):
        prefix = [p for p in MIGRATIONS if int(p.name[:4]) <= boundary]
        suffix = [p for p in MIGRATIONS if int(p.name[:4]) > boundary]
        with tempfile.TemporaryDirectory(prefix=f"ai-m-{boundary:04d}-upgrade-") as tmp:
            conn = sqlite3.connect(Path(tmp) / "published.sqlite")
            try:
                apply(conn, prefix)
                apply(conn, suffix)
                assert_hardened(conn)
            finally:
                conn.close()
        print(f"PASS published-{boundary:04d}-upgrade: {len(suffix)} additive migrations")

    # A legacy local validation with a damaged or incomplete report must never
    # inherit the release default merely because its JSON cannot prove origin.
    prefix_0068 = [p for p in MIGRATIONS if int(p.name[:4]) <= 68]
    migration_0069 = [p for p in MIGRATIONS if int(p.name[:4]) == 69]
    with tempfile.TemporaryDirectory(prefix="ai-m-0069-provenance-") as tmp:
        conn = sqlite3.connect(Path(tmp) / "provenance.sqlite")
        try:
            apply(conn, prefix_0068)
            conn.executescript("""
                INSERT INTO resource_pools
                  (id, display_name, capacity, policy_json, created_at_ms, updated_at_ms)
                VALUES ('pool', 'Pool', 1, '{}', 1, 1);
                INSERT INTO execution_backends
                  (id, display_name, adapter_kind, base_url, topology, sharing_mode,
                   auth_type, auth_config_json, tls_config_json, network_policy_json,
                   resource_pool_id, capabilities_json, created_at_ms, updated_at_ms)
                VALUES ('backend', 'Backend', 'comfyui', 'http://127.0.0.1:8000',
                  'same-host', 'dedicated', 'none', '{}', '{}', '{}', 'pool', '{}', 1, 1);
                INSERT INTO workflow_package_revisions
                  (digest, workflow_id, version, capability, workflow_api_json, manifest_json,
                   compiled_bindings_json, package_lock_json, package_path, workflow_sha256,
                   environment_lock_digest, compiler_version, compiled_at_ms, created_at_ms)
                VALUES ('digest', 'workflow', '1', 'image', '{}', '{}', '{}', '{}',
                  'package', 'workflow-sha', 'lock', '1.0.0', 1, 1);
                INSERT INTO workflow_backend_validations
                  (id, workflow_package_digest, execution_backend_id, environment_fingerprint,
                   environment_lock_digest, reviewer_id, report_json, validated_at_ms, updated_at_ms)
                VALUES ('legacy-local', 'digest', 'backend', 'fingerprint', 'lock',
                  'local-self-use', '{}', 1, 1);
            """)
            apply(conn, migration_0069)
            row = conn.execute(
                "SELECT id, validation_kind FROM workflow_backend_validations WHERE reviewer_id='local-self-use'"
            ).fetchone()
            if row != ("local-self-use:legacy-local", "local-self-use"):
                raise AssertionError(f"0069 misclassified legacy local provenance: {row}")
            try:
                conn.execute(
                    "UPDATE workflow_backend_validations SET validation_kind='release' WHERE reviewer_id='local-self-use'"
                )
            except sqlite3.IntegrityError:
                pass
            else:
                raise AssertionError("0069 allowed local reviewer provenance to become release validation")
        finally:
            conn.close()
    print("PASS 0069-local-provenance-backfill")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
