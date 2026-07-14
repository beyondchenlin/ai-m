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
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
NODE_PIN_ERROR = (
    ".node-version must contain an exact stable major.minor.patch version; "
    "one final newline is allowed"
)


def read_required_file(
    root: pathlib.Path, path: str, errors: list[str]
) -> str | None:
    """Read a required UTF-8 file, recording a stable diagnostic on failure."""
    try:
        return (root / path).read_text(encoding="utf-8")
    except FileNotFoundError:
        errors.append(f"missing required file: {path}")
    except (OSError, UnicodeError):
        errors.append(f"unable to read required file: {path}")
    return None


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def derive_node_engine(pin_contents: str) -> str:
    """Derive the package engine range from an exact stable Node version pin."""
    if pin_contents.endswith("\r\n"):
        pinned_version = pin_contents[:-2]
    elif pin_contents.endswith("\n"):
        pinned_version = pin_contents[:-1]
    else:
        pinned_version = pin_contents

    match = re.fullmatch(
        r"(?P<major>0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)",
        pinned_version,
    )
    if not match:
        raise ValueError(NODE_PIN_ERROR)

    next_major = int(match.group("major")) + 1
    return f">={pinned_version} <{next_major}"


def check_node_engine(
    package: dict[str, Any], pin_contents: str, errors: list[str]
) -> None:
    try:
        expected_engine = derive_node_engine(pin_contents)
    except ValueError as error:
        errors.append(str(error))
        return

    engines = package.get("engines")
    actual_engine = engines.get("node") if isinstance(engines, dict) else None
    require(
        actual_engine == expected_engine,
        f"Node engine range must match .node-version: {expected_engine}",
        errors,
    )


def run_checks(root: pathlib.Path = ROOT) -> list[str]:
    errors: list[str] = []

    def read(path: str) -> str:
        return read_required_file(root, path, errors) or ""

    package = json.loads(read("package.json") or "{}")
    scripts = package.get("scripts", {})
    require(
        package.get("packageManager") == "pnpm@10.12.1",
        "packageManager must be pinned to pnpm 10.12.1",
        errors,
    )
    node_pin = read_required_file(root, ".node-version", errors)
    if node_pin is not None:
        check_node_engine(package, node_pin, errors)
    for script in [
        "typecheck",
        "test",
        "test:migrations",
        "test:pr12-static",
        "worker:build",
        "quality",
        "workflow:import",
        "workflow:promote",
    ]:
        require(script in scripts, f"missing package script: {script}", errors)

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
        require(
            not (root / removed).exists(),
            f"obsolete unsafe implementation must stay removed: {removed}",
            errors,
        )

    for route_root in [root / "src/app/api/admin", root / "src/app/api/generation"]:
        for route in route_root.rglob("route.ts"):
            relative_route = route.relative_to(root).as_posix()
            text = read(relative_route)
            require(
                ".json()" not in text,
                f"unbounded request.json() is forbidden in {relative_route}",
                errors,
            )

    example = read(".env.example")
    require(
        "FEATURE_V2_" not in example,
        "feature flag example must use FF_V2_* names",
        errors,
    )
    for flag in [
        "FF_V2_BACKEND_CONFIG",
        "FF_V2_GENERATION_PROFILES",
        "FF_V2_DURABLE_EXECUTION",
        "FF_V2_WORKFLOW_SUPPLY_CHAIN",
        "FF_V2_COMFYUI_TRANSPORT",
        "FF_V2_MEDIA_ARCHIVING",
        "FF_V2_LOCAL_IMAGE",
        "FF_V2_LOCAL_SPEECH",
    ]:
        require(flag in example, f"missing feature flag example: {flag}", errors)

    migration = read("drizzle/0057_pr12_platform_hardening.sql")
    for token in [
        "workflow_backend_validations",
        "generation_jobs_idempotency_unique",
        "generation_jobs_active_dedupe_unique",
        "job_claim_fencing_token",
        "voice_profiles",
    ]:
        require(token in migration, f"hardening migration missing: {token}", errors)

    schema = read("src/lib/db/schema.ts")
    for token in [
        "workflowBackendValidations",
        "jobClaimFencingToken",
        "idempotencyKey",
        "voiceProfiles",
    ]:
        require(token in schema, f"schema missing: {token}", errors)

    feature_flags = read("src/lib/feature-flags.ts")
    require(
        "V2_LOCAL_SPEECH" in feature_flags,
        "local speech feature flag must exist",
        errors,
    )
    for file in (root / "src").rglob("*.ts"):
        relative_file = file.relative_to(root).as_posix()
        text = read(relative_file)
        require(
            "V2_LOCAL_AUDIO" not in text,
            f"obsolete V2_LOCAL_AUDIO flag in {relative_file}",
            errors,
        )

    factory = read("src/lib/ai/provider-factory.ts") + read(
        "src/lib/capability/service.ts"
    )
    require(
        "resolveLegacyProviderSecrets" in factory,
        "legacy cloud facade must use encrypted key resolver",
        errors,
    )
    require(
        "keyReferences" not in factory,
        "provider facade must not read key rows directly",
        errors,
    )
    require(
        '"comfyui-http": "dashscope"' not in factory,
        "ComfyUI must never fall through to DashScope",
        errors,
    )

    interrupt_calls: list[str] = []
    for file in (root / "src").rglob("*.ts"):
        relative_file = file.relative_to(root).as_posix()
        text = read(relative_file)
        if ".interrupt(" in text and "comfyui-cancellation.ts" not in file.as_posix():
            interrupt_calls.append(relative_file)
    require(
        not interrupt_calls,
        f"global interrupt call outside cancellation policy: {interrupt_calls}",
        errors,
    )

    quality_workflow = read(".github/workflows/quality.yml")
    require(
        "pnpm quality" in quality_workflow,
        "CI must execute the canonical quality gate",
        errors,
    )

    materializer = read("src/lib/generation/input-materializer.ts")
    require(
        "copyVerifiedArtifact" in materializer and "createReadStream" in materializer,
        "large audio/video inputs must be copied as bounded streams",
        errors,
    )
    require(
        "fs.readFile(destination)" not in materializer,
        "shared input verification must not buffer an entire large file",
        errors,
    )

    orchestrator = read(
        "src/lib/generation/transports/comfyui-execution-orchestrator.ts"
    )
    require(
        "onOutputReady" not in orchestrator,
        "unbounded in-memory output callback must stay removed",
        errors,
    )
    transport = read("src/lib/generation/transports/comfyui.ts")
    require(
        "response.arrayBuffer()" not in transport,
        "transport must not buffer unbounded output bodies",
        errors,
    )

    artifact_commit = read("src/lib/generation/archiving/commit.ts")
    require(
        "fs.lstat" in artifact_commit and "isSymbolicLink" in artifact_commit,
        "artifact recovery must reject symlinks",
        errors,
    )
    artifact_cleanup = read("src/lib/generation/archiving/disk-cleanup.ts")
    require(
        "lstat" in artifact_cleanup and "isSymbolicLink" in artifact_cleanup,
        "artifact cleanup must reject symlinks",
        errors,
    )

    artifact_route = read("src/app/api/generation/artifacts/[id]/route.ts")
    require(
        "lstat(" in artifact_route and "isSymbolicLink" in artifact_route,
        "artifact download must reject symlinks",
        errors,
    )
    require(
        '"X-Content-Type-Options": "nosniff"' in artifact_route,
        "artifact download must set nosniff",
        errors,
    )

    return errors


def main() -> int:
    errors = run_checks()
    if errors:
        print("PR-12 static architecture checks FAILED", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("PR-12 static architecture checks PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
