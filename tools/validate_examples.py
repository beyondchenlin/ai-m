#!/usr/bin/env python3
"""Dependency-free validation for bundled workflow/configuration examples.

This script intentionally uses only the Python standard library so the default
quality gate works on a clean developer machine without hidden Python packages.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GUIDE = ROOT / "docs" / "ai-m-comfyui-development-guide-v2.0"
EXAMPLES = GUIDE / "examples"
FIXTURES = EXAMPLES / "fixtures"
SPEECH = ROOT / "docs" / "speech-workflows"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resolve_selector(workflow: dict, selector: dict) -> list[str]:
    return [
        str(node_id)
        for node_id, node in workflow.items()
        if isinstance(node, dict)
        and node.get("class_type") == selector.get("classType")
        and node.get("_meta", {}).get("title") == selector.get("metaTitle")
    ]


def validate_fixture(name: str, should_compile: bool) -> None:
    folder = FIXTURES / name
    workflow = load_json(folder / "workflow.api.json")
    manifest = load_json(folder / "manifest.json")
    lock = load_json(folder / "package.lock.json")
    if not isinstance(workflow, dict) or not workflow:
        raise AssertionError(f"{name}: workflow must be a non-empty object")
    for rel_path, expected in lock.get("files", {}).items():
        actual = sha256_file(folder / rel_path)
        if actual != expected:
            raise AssertionError(f"{name}: lock mismatch for {rel_path}")

    failed = False
    for binding in manifest.get("bindings", []):
        matches = resolve_selector(workflow, binding.get("selector", {}))
        if len(matches) != 1:
            failed = True
            break
        node = workflow[matches[0]]
        if binding.get("inputName") not in node.get("inputs", {}):
            failed = True
            break
    for output in manifest.get("outputs", []):
        if len(resolve_selector(workflow, output.get("selector", {}))) != 1:
            failed = True
            break
    if should_compile and failed:
        raise AssertionError(f"{name}: valid fixture failed semantic compilation")
    if not should_compile and not failed:
        raise AssertionError(f"{name}: invalid fixture unexpectedly compiled")


def validate_sql_example() -> None:
    sql_path = EXAMPLES / "config" / "database-schema.example.sql"
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript(sql_path.read_text(encoding="utf-8"))
        tables = {row[0] for row in conn.execute("select name from sqlite_master where type='table'")}
        required = {
            "execution_backends", "workflow_package_revisions", "generation_profile_revisions",
            "generation_jobs", "generation_attempts", "generation_artifacts",
        }
        missing = required - tables
        if missing:
            raise AssertionError(f"example database schema is missing {sorted(missing)}")
    finally:
        conn.close()


def validate_speech_templates() -> None:
    for engine in ("indextts2", "omnivoice"):
        manifest_path = SPEECH / engine / "manifest.template.json"
        profile_path = SPEECH / "profiles" / f"{engine}.profile.json"
        manifest_text = manifest_path.read_text(encoding="utf-8")
        manifest = json.loads(manifest_text)
        profile = load_json(profile_path)
        if "REPLACE_" not in manifest_text:
            raise AssertionError(f"{engine}: template must remain explicitly non-promotable")
        if manifest.get("capability") != "speech":
            raise AssertionError(f"{engine}: manifest capability must be speech")
        if profile.get("speechEngine") != engine:
            raise AssertionError(f"{engine}: profile speechEngine mismatch")
        defaults = profile.get("defaultParameters")
        if not isinstance(defaults, dict):
            raise AssertionError(f"{engine}: profile must define defaultParameters")


def validate_json_files() -> None:
    for path in sorted((EXAMPLES / "schemas").glob("*.json")):
        load_json(path)
    for path in sorted((EXAMPLES / "config").glob("*.json")):
        load_json(path)
    for path in sorted((EXAMPLES / "profiles").glob("*.json")):
        load_json(path)


def validate_markdown() -> None:
    for root in (GUIDE, SPEECH):
        for path in root.rglob("*.md"):
            text = path.read_text(encoding="utf-8")
            if text.count("```") % 2:
                raise AssertionError(f"{path.relative_to(ROOT)}: unbalanced code fences")
            for match in re.finditer(r"!\[[^\]]*\]\(([^)]+)\)", text):
                ref = match.group(1).split()[0]
                if ref.startswith(("http://", "https://")):
                    continue
                if not (path.parent / ref).resolve().exists():
                    raise AssertionError(f"{path.relative_to(ROOT)}: missing image {ref}")


def main() -> int:
    validate_json_files()
    validate_fixture("generic-image-smoke", True)
    validate_fixture("invalid-binding", False)
    validate_sql_example()
    validate_speech_templates()
    validate_markdown()
    print("PASS dependency-free workflow and documentation example validation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
