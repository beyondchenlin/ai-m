#!/usr/bin/env python3
"""Fast architectural invariants for PR-12.

This is intentionally dependency-free so CI can fail before installing or
starting the application. It complements, rather than replaces, TypeScript and
integration tests.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ERRORS: list[str] = []


def read(path: str) -> str:
    file = ROOT / path
    if not file.exists():
        ERRORS.append(f"missing required file: {path}")
        return ""
    return file.read_text(encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        ERRORS.append(message)


def expected_node_engine() -> str | None:
    pinned_version = read(".node-version").strip()
    match = re.fullmatch(
        r"(?P<major>0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)",
        pinned_version,
    )
    if not match:
        ERRORS.append(
            ".node-version must contain an exact semantic version with numeric major, minor, and patch components"
        )
        return None

    next_major = int(match.group("major")) + 1
    return f">={pinned_version} <{next_major}"


package = json.loads(read("package.json") or "{}")
scripts = package.get("scripts", {})
require(package.get("packageManager") == "pnpm@10.12.1", "packageManager must be pinned to pnpm 10.12.1")
node_engine = expected_node_engine()
if node_engine is not None:
    require(
        package.get("engines", {}).get("node") == node_engine,
        f"Node engine range must match .node-version: {node_engine}",
    )
for script in ["typecheck", "test", "test:migrations", "test:pr12-static", "worker:build", "quality", "workflow:import", "workflow:promote"]:
    require(script in scripts, f"missing package script: {script}")

for path in [
    "src/worker/index.ts",
    "src/lib/generation/workflows/importer.ts",
    "src/lib/generation/workflows/compiler.ts",
    "src/lib/generation/archiving/commit.ts",
    "src/lib/security/admin-auth.ts",
    "src/lib/security/secrets.ts",
    "drizzle/0057_pr12_platform_hardening.sql",
    ".github/workflows/quality.yml",
]:
    read(path)

for removed in [
    "src/lib/generation/adapters/zimage.ts",
    "src/lib/generation/adapters/local-speech.ts",
    "src/lib/generation/archiving/atomic-commit.ts",
]:
    require(not (ROOT / removed).exists(), f"obsolete unsafe implementation must stay removed: {removed}")

for route_root in [ROOT / "src/app/api/admin", ROOT / "src/app/api/generation"]:
    for route in route_root.rglob("route.ts"):
        text = route.read_text(encoding="utf-8")
        require(".json()" not in text, f"unbounded request.json() is forbidden in {route.relative_to(ROOT)}")

example = read(".env.example")
require("FEATURE_V2_" not in example, "feature flag example must use FF_V2_* names")
for flag in ["FF_V2_BACKEND_CONFIG", "FF_V2_GENERATION_PROFILES", "FF_V2_DURABLE_EXECUTION", "FF_V2_WORKFLOW_SUPPLY_CHAIN", "FF_V2_COMFYUI_TRANSPORT", "FF_V2_MEDIA_ARCHIVING", "FF_V2_LOCAL_IMAGE", "FF_V2_LOCAL_SPEECH"]:
    require(flag in example, f"missing feature flag example: {flag}")

migration = read("drizzle/0057_pr12_platform_hardening.sql")
for token in [
    "workflow_backend_validations",
    "generation_jobs_idempotency_unique",
    "generation_jobs_active_dedupe_unique",
    "job_claim_fencing_token",
    "voice_profiles",
]:
    require(token in migration, f"hardening migration missing: {token}")

schema = read("src/lib/db/schema.ts")
for token in ["workflowBackendValidations", "jobClaimFencingToken", "idempotencyKey", "voiceProfiles"]:
    require(token in schema, f"schema missing: {token}")

feature_flags = read("src/lib/feature-flags.ts")
require("V2_LOCAL_SPEECH" in feature_flags, "local speech feature flag must exist")
for file in (ROOT / "src").rglob("*.ts"):
    text = file.read_text(encoding="utf-8")
    require("V2_LOCAL_AUDIO" not in text, f"obsolete V2_LOCAL_AUDIO flag in {file.relative_to(ROOT)}")

factory = read("src/lib/ai/provider-factory.ts") + read("src/lib/capability/service.ts")
require("resolveLegacyProviderSecrets" in factory, "legacy cloud facade must use encrypted key resolver")
require("keyReferences" not in factory, "provider facade must not read key rows directly")
require('"comfyui-http": "dashscope"' not in factory, "ComfyUI must never fall through to DashScope")

interrupt_calls: list[str] = []
for file in (ROOT / "src").rglob("*.ts"):
    text = file.read_text(encoding="utf-8")
    if ".interrupt(" in text and "comfyui-cancellation.ts" not in file.as_posix():
        interrupt_calls.append(file.relative_to(ROOT).as_posix())
require(not interrupt_calls, f"global interrupt call outside cancellation policy: {interrupt_calls}")


quality_workflow = read(".github/workflows/quality.yml")
require("pnpm quality" in quality_workflow, "CI must execute the canonical quality gate")

materializer = read("src/lib/generation/input-materializer.ts")
require("copyVerifiedArtifact" in materializer and "createReadStream" in materializer, "large audio/video inputs must be copied as bounded streams")
require("fs.readFile(destination)" not in materializer, "shared input verification must not buffer an entire large file")

orchestrator = read("src/lib/generation/transports/comfyui-execution-orchestrator.ts")
require("onOutputReady" not in orchestrator, "unbounded in-memory output callback must stay removed")
transport = read("src/lib/generation/transports/comfyui.ts")
require("response.arrayBuffer()" not in transport, "transport must not buffer unbounded output bodies")

artifact_commit = read("src/lib/generation/archiving/commit.ts")
require("fs.lstat" in artifact_commit and "isSymbolicLink" in artifact_commit, "artifact recovery must reject symlinks")
artifact_cleanup = read("src/lib/generation/archiving/disk-cleanup.ts")
require("lstat" in artifact_cleanup and "isSymbolicLink" in artifact_cleanup, "artifact cleanup must reject symlinks")

artifact_route = read("src/app/api/generation/artifacts/[id]/route.ts")
require("lstat(" in artifact_route and "isSymbolicLink" in artifact_route, "artifact download must reject symlinks")
require('"X-Content-Type-Options": "nosniff"' in artifact_route, "artifact download must set nosniff")

if ERRORS:
    print("PR-12 static architecture checks FAILED", file=sys.stderr)
    for error in ERRORS:
        print(f"- {error}", file=sys.stderr)
    raise SystemExit(1)
print("PR-12 static architecture checks PASS")
