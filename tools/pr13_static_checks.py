#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require(path: str) -> str:
    file = ROOT / path
    if not file.is_file():
        raise AssertionError(f"missing required file: {path}")
    return file.read_text(encoding="utf-8")


def _require_at(root: Path, path: str) -> str:
    file = root / path
    if not file.is_file():
        raise AssertionError(f"missing migration recovery architecture file: {path}")
    return file.read_text(encoding="utf-8")


def _function_body(source: str, signature: str) -> str:
    start = source.find(signature)
    if start < 0:
        raise AssertionError(f"migration recovery export is missing: {signature}")
    opening = source.find("{", start)
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[opening:index + 1]
    raise AssertionError(f"migration recovery export is incomplete: {signature}")


def check_migration_recovery_invariants(root: Path = ROOT) -> None:
    """Check durable architecture contracts; behavioral edge cases live in Vitest."""
    index = _require_at(root, "src/lib/db/index.ts")
    for signal in [
        "export type ValidatedMigrationBundle", "validatedMigrationBundles",
        "export function loadValidatedMigrationBundle", "validateMigrationExecutionStatements",
        "validatedMigrationBundles.has(bundle)", "applyPendingMigrations(sqlite, bundle)",
    ]:
        if signal not in index:
            raise AssertionError(f"validated/branded migration bundle invariant is missing: {signal}")
    apply_body = _function_body(index, "export function applyPendingMigrations")
    for signal in ["sqlite.transaction", "validateRecordedMigrationJournal", "insert.run", ").immediate()"]:
        if signal not in apply_body:
            raise AssertionError(f"atomic migration application invariant is missing: {signal}")

    journal = _require_at(root, "src/lib/db/migration-journal.ts")
    for signal in ["validateMigrationJournal", "contiguous repository prefix", "hash mismatch", "Duplicate recorded migration timestamp"]:
        if signal not in journal:
            raise AssertionError(f"exact contiguous migration journal evidence is missing: {signal}")

    evidence = _require_at(root, "src/lib/db/migration-data-evidence.ts")
    for signal in [
        "migrationsRequiringDataEvidence", "validateDataPostconditionRegistry",
        "0051 dropped legacy shot columns", "0058 dropped its copy source",
        "unregistered data/destructive migration",
    ]:
        if signal not in evidence:
            raise AssertionError(f"destructive migration operator evidence is missing: {signal}")

    approval = _require_at(root, "src/lib/db/migration-baseline-approval.ts")
    for signal in [
        "securityPolicy.verifyParent", "inspectArtifact(absoluteBackupPath)",
        "sameIdentity(publishedIdentity", "finalArtifact.manifest",
        "Backup evidence does not match the locked live database state",
    ]:
        if signal not in approval:
            raise AssertionError(f"final backup evidence invariant is missing: {signal}")


def main() -> int:
    store = require("src/stores/model-store.ts")
    for token in ['"speech"', 'defaultSpeechModel', 'setDefaultSpeechModel', 'version: 4']:
        if token not in store:
            raise AssertionError(f"model store is missing {token}")

    for token in ["partialize:", 'apiKey: ""', "secretKey: undefined", "sessionStorage", "mergeSessionCredentials"]:
        if token not in store:
            raise AssertionError(f"model store does not securely scope browser credentials: {token}")

    settings = require("src/app/[locale]/settings/page.tsx")
    settings += require("src/app/[locale]/settings/settings-page-client.tsx")
    if 'capability="speech"' not in settings:
        raise AssertionError("settings page does not expose speech capability")

    if (ROOT / "src/lib/generation/adapters/local-speech.ts").exists():
        raise AssertionError("placeholder local-speech adapter must be removed")

    migration = require("drizzle/0058_pr13_speech_first_class.sql")
    for token in [
        "source_media_assets", "generation_job_source_assets", "reference_source_asset_id",
        "voice_profiles_project_user_index", "generation_job_source_assets_asset_idx",
    ]:
        if token not in migration:
            raise AssertionError(f"speech migration is missing {token}")
    if "IS NOT NULL AND `reference_source_asset_id` IS NULL" not in migration:
        raise AssertionError("voice profile migration must enforce exactly one reference source")

    hardening_migration = require("drizzle/0059_pr13_review2_hardening.sql")
    for token in [
        "consent_statement_version", "source_media_assets_validate_insert",
        "source_media_assets_status_transition_guard", "source_media_assets_immutable_content_guard",
        "voice_profiles_validate_insert", "voice_profiles_source_reference_guard_insert",
        "generation_job_source_assets_guard_insert", "source_media_assets_delete_reference_guard",
        "source_media_assets_status_updated_idx",
    ]:
        if token not in hardening_migration:
            raise AssertionError(f"speech hardening migration is missing {token}")


    schema = require("src/lib/db/schema.ts")
    for token in [
        "generationJobSourceAssets", "primaryKey({ columns: [table.jobId, table.sourceAssetId, table.role] })",
        "voice_profiles_exactly_one_reference_check",
    ]:
        if token not in schema:
            raise AssertionError(f"database schema is missing {token}")

    jobs = require("src/lib/generation/jobs/service.ts")
    for token in [
        "generationJobSourceAssets", "sourceAssets: structuredClone(sourceAssets)",
        "db.transaction((tx)", "validateSourceAssetRows(rows, ids, input.projectId, actor)",
    ]:
        if token not in jobs:
            raise AssertionError(f"job service is missing durable source binding: {token}")

    origin_guard = require("src/lib/security/request-origin.ts")
    if "sec-fetch-site" not in origin_guard or "AI_M_ALLOWED_ORIGINS" not in origin_guard:
        raise AssertionError("request origin guard is incomplete")

    idempotency = require("src/lib/generation/jobs/idempotency.ts")
    jobs_service = require("src/lib/generation/jobs/service.ts")
    for token in ["profileRevisionId", "businessContext", "sourceAssets"]:
        if token not in idempotency:
            raise AssertionError(f"idempotency request digest omits {token}")
    for token in ["idempotencyRequestDigest", "idempotency_key_conflict"]:
        if token not in jobs_service:
            raise AssertionError(f"generation job service is missing {token}")


    artifact_selection = require("src/lib/generation/artifact-selection.ts")
    worker_executor = require("src/lib/generation/worker-executor.ts")
    for token in ["selectPrimaryArtifact", "approvedOutputs", "sequence"]:
        if token not in artifact_selection:
            raise AssertionError(f"deterministic artifact selection is missing {token}")
    if "selectPrimaryArtifact(committedArtifacts" not in worker_executor:
        raise AssertionError("worker must select the business artifact from compiled output order")

    db_index = require("src/lib/db/index.ts")
    for token in ["busy_timeout = 5000"]:
        if token not in db_index:
            raise AssertionError(f"database compatibility baseline is missing {token}")
    check_migration_recovery_invariants()
    if "transaction(async" in "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in (ROOT / "src").rglob("*.ts")):
        raise AssertionError("better-sqlite3 transactions must not use async callbacks")

    for token in ["cancelRequestedAtMs: null", "currentArtifactId: null", "job_retry_race"]:
        if token not in jobs_service:
            raise AssertionError(f"job retry lifecycle is missing {token}")


    profile_service = require("src/lib/generation/profiles/service.ts")
    for token in ["workflowPackageStates", 'workflow?.state === "active"']:
        if token not in profile_service:
            raise AssertionError(f"selectable profiles must require an active workflow package: {token}")
    if 'runtime.workflowState !== "active"' not in jobs_service:
        raise AssertionError("job creation must reject inactive workflow packages")

    materializer = require("src/lib/generation/input-materializer.ts")
    for token in ["cleanupTerminalSharedInputs", "AI_M_COMFYUI_SHARED_INPUT_ROOT", "generationJobSourceAssets"]:
        if token not in materializer:
            raise AssertionError(f"input materializer is missing {token}")
    worker = require("src/worker/index.ts")
    for token in ["cleanupTerminalSharedInputs", "source_media_assets", "generation_job_source_assets"]:
        if token not in worker:
            raise AssertionError(f"worker readiness/recovery is missing {token}")

    source_route = require("src/app/api/source-assets/[id]/route.ts")
    for token in ["verifyOwnedSourceAssetFile", "Accept-Ranges", "export async function DELETE"]:
        if token not in source_route:
            raise AssertionError(f"source asset delivery is missing {token}")
    upload_route = require("src/app/api/projects/[id]/source-assets/audio/route.ts")
    if "request.formData" in upload_route or "importVoiceReferenceStream" not in upload_route:
        raise AssertionError("voice reference uploads must use a bounded raw stream")
    voice_route = require("src/app/api/projects/[id]/voice-profiles/route.ts")
    if "request.formData" in voice_route or "referenceSourceAssetId" not in voice_route:
        raise AssertionError("voice profile creation must reference an uploaded immutable source asset")

    dialogue_panel = require("src/components/editor/dialogue-speech-panel.tsx")
    if "mounted.current = true" not in dialogue_panel or "showLocalProfiles" not in dialogue_panel or 'providerId !== "local"' not in dialogue_panel:
        raise AssertionError("speech panel must be StrictMode-safe and select only runnable local profiles")
    if 'if (dialogues.length === 0) return null' not in dialogue_panel or 'available === true && (' not in dialogue_panel:
        raise AssertionError("speech feature gating must not hide the existing dialogue transcript")

    for path in [
        "src/app/api/projects/[id]/voice-profiles/route.ts",
        "src/app/api/projects/[id]/voice-profiles/[profileId]/route.ts",
        "src/app/api/projects/[id]/speech/route.ts",
        "src/app/api/source-assets/[id]/route.ts",
        "src/components/editor/voice-profile-panel.tsx",
        "src/components/editor/dialogue-speech-panel.tsx",
        "src/lib/generation/source-assets.ts",
        "src/lib/generation/media-probe.ts",
    ]:
        require(path)

    for route_path in [
        "src/app/api/projects/[id]/voice-profiles/route.ts",
        "src/app/api/projects/[id]/voice-profiles/[profileId]/route.ts",
        "src/app/api/projects/[id]/speech/route.ts",
    ]:
        if "V2_LOCAL_SPEECH" not in require(route_path):
            raise AssertionError(f"speech route is not feature-gated: {route_path}")

    fake_markers = ["SpeechLoader", "SpeechVocalLoader", "durationMs: 0"]
    adapter_root = ROOT / "src/lib/generation/adapters"
    source_text = "\n".join(
        p.read_text(encoding="utf-8", errors="ignore")
        for p in adapter_root.rglob("*.ts")
    ) if adapter_root.exists() else ""
    for marker in fake_markers:
        if marker in source_text:
            raise AssertionError(f"placeholder speech implementation remains: {marker}")


    models_route = require("src/app/api/models/list/route.ts")
    for token in ["resolveModelDiscoveryTarget", "requestPinnedJson", "getSelectableProfiles"]:
        if token not in models_route:
            raise AssertionError(f"model discovery route is missing {token}")
    require("src/lib/security/pinned-json-request.ts")
    discovery_policy = require("src/lib/security/model-discovery-policy.ts")
    for token in ["AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST", "resolveApprovedAddresses", "ModelDiscoveryPolicyError"]:
        if token not in discovery_policy:
            raise AssertionError(f"model discovery policy is missing {token}")

    voice_service = require("src/lib/generation/voice-profiles.ts")
    for token in ["VOICE_CONSENT_VERSION", "consentStatementVersion", "userId: string"]:
        if token not in voice_service:
            raise AssertionError(f"voice profile service is missing {token}")
    if "userId?: string" in voice_service or "validateVoiceConfig" in voice_service:
        raise AssertionError("voice profile service retains an unsafe optional owner or dead validation stub")

    source_assets = require("src/lib/generation/source-assets.ts")
    for token in [
        'status: "STAGING"', "recoverSourceMediaAssets", "cleanupSourceAssetStorage",
        "CONTENT_LENGTH_MISMATCH", 'pendingPurpose: "voice-profile-reference"', "expiresAtMs",
        "SOURCE_PROJECT_QUOTA_EXCEEDED", "SOURCE_STORAGE_EXHAUSTED",
        "UPLOAD_STALLED", "UPLOAD_TIMEOUT",
    ]:
        if token not in source_assets:
            raise AssertionError(f"source asset lifecycle hardening is missing {token}")
    if 'lt(sourceMediaAssets.createdAtMs' not in source_assets or 'metadata.pendingPurpose' not in source_assets:
        raise AssertionError("abandoned source cleanup must require explicit temporary-purpose metadata")

    origin_guard = require("src/lib/security/request-origin.ts")
    if "sec-fetch-site" not in origin_guard or "AI_M_ALLOWED_ORIGINS" not in origin_guard:
        raise AssertionError("request origin guard is incomplete")

    idempotency = require("src/lib/generation/jobs/idempotency.ts")
    jobs_service = require("src/lib/generation/jobs/service.ts")
    for token in ["profileRevisionId", "businessContext", "sourceAssets"]:
        if token not in idempotency:
            raise AssertionError(f"idempotency request digest omits {token}")
    for token in ["idempotencyRequestDigest", "idempotency_key_conflict"]:
        if token not in jobs_service:
            raise AssertionError(f"generation job service is missing {token}")

    materializer = require("src/lib/generation/input-materializer.ts")
    if "asset.userId !== job.requestedBy" in materializer:
        raise AssertionError("runtime materialisation incorrectly rejects administrator-enqueued project jobs")

    dialogue_panel = require("src/components/editor/dialogue-speech-panel.tsx")
    if "window.location.reload()" in dialogue_panel or "loadVoiceProfiles" not in dialogue_panel:
        raise AssertionError("speech panel retry must not discard the current editor state")

    for lang in ["zh", "en", "ja", "ko"]:
        data = json.loads(require(f"messages/{lang}.json"))
        for section in ["settings", "voiceProfiles", "speechGeneration"]:
            if section not in data:
                raise AssertionError(f"messages/{lang}.json is missing {section}")
        for key in ["defaultSpeechModel", "speechModels", "notConfiguredSpeech"]:
            if key not in data["settings"]:
                raise AssertionError(f"messages/{lang}.json settings is missing {key}")

    for engine in ["indextts2", "omnivoice"]:
        template = require(f"docs/speech-workflows/{engine}/manifest.template.json")
        if "REPLACE_" not in template:
            raise AssertionError(f"{engine} template must remain explicitly non-promotable")
        profile = json.loads(require(f"docs/speech-workflows/profiles/{engine}.profile.json"))
        if profile.get("speechEngine") != engine:
            raise AssertionError(f"{engine} profile has the wrong speechEngine")

    print("PASS PR-13 speech first-class static checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
