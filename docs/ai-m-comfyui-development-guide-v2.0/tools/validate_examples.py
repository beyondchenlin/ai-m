#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import ipaddress
import json
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urlparse

import jsonschema
from jsonschema import FormatChecker
import yaml

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "examples" / "schemas"
FIXTURES = ROOT / "examples" / "fixtures"
CONFIG = ROOT / "examples" / "config"
PROFILES = ROOT / "examples" / "profiles"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_json(instance_path: Path, schema_path: Path) -> None:
    schema = load_json(schema_path)
    instance = load_json(instance_path)
    validator = jsonschema.Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
    if errors:
        rendered = "\n".join(f"  - {instance_path}: {'/'.join(map(str, e.absolute_path))}: {e.message}" for e in errors)
        raise AssertionError(f"JSON Schema validation failed:\n{rendered}")


def resolve_selector(workflow: dict, selector: dict) -> list[str]:
    matches: list[str] = []
    for node_id, node in workflow.items():
        if node.get("class_type") != selector["classType"]:
            continue
        if node.get("_meta", {}).get("title") != selector["metaTitle"]:
            continue
        matches.append(str(node_id))
    return matches


def compile_manifest(workflow: dict, manifest: dict) -> dict:
    bindings = []
    for binding in manifest["bindings"]:
        matches = resolve_selector(workflow, binding["selector"])
        if len(matches) != 1:
            raise ValueError(
                f"binding {binding['key']} selector must match exactly once; got {matches}"
            )
        node_id = matches[0]
        node = workflow[node_id]
        if binding["inputName"] not in node.get("inputs", {}):
            raise ValueError(
                f"binding {binding['key']} input {binding['inputName']} missing on node {node_id}"
            )
        compiled = {
            "key": binding["key"],
            "nodeId": node_id,
            "classType": binding["selector"]["classType"],
            "inputName": binding["inputName"],
            "valueType": binding["valueType"],
            "required": binding["required"],
            "userOverride": binding["userOverride"],
        }
        for key in ("default", "minimum", "maximum", "enum"):
            if key in binding:
                compiled[key] = binding[key]
        bindings.append(compiled)

    outputs = []
    for output in manifest["outputs"]:
        matches = resolve_selector(workflow, output["selector"])
        if len(matches) != 1:
            raise ValueError(
                f"output {output['key']} selector must match exactly once; got {matches}"
            )
        outputs.append(
            {
                "key": output["key"],
                "nodeId": matches[0],
                "classType": output["selector"]["classType"],
                "field": output["field"],
                "mediaKind": output["mediaKind"],
                "maxItems": output["maxItems"],
            }
        )

    return {
        "schemaVersion": 1,
        "workflowId": manifest["workflowId"],
        "version": manifest["version"],
        "workflowSha256": hashlib.sha256(
            (FIXTURES / manifest["workflowId"] / "workflow.api.json").read_bytes()
        ).hexdigest(),
        "authorContractSha256": hashlib.sha256(canonical_bytes(manifest)).hexdigest(),
        "bindings": bindings,
        "outputs": outputs,
    }


def validate_fixture(name: str, expect_compile_success: bool) -> None:
    folder = FIXTURES / name
    validate_json(folder / "manifest.json", SCHEMAS / "workflow-manifest.schema.json")
    validate_json(folder / "compiled-bindings.json", SCHEMAS / "compiled-bindings.schema.json")
    validate_json(folder / "package.lock.json", SCHEMAS / "workflow-package-lock.schema.json")

    lock = load_json(folder / "package.lock.json")
    for rel_path, expected in lock["files"].items():
        actual = sha256_file(folder / rel_path)
        if actual != expected:
            raise AssertionError(f"{name}: lock mismatch for {rel_path}: {actual} != {expected}")

    workflow = load_json(folder / "workflow.api.json")
    manifest = load_json(folder / "manifest.json")
    try:
        compiled = compile_manifest(workflow, manifest)
    except ValueError:
        if expect_compile_success:
            raise
        return
    if not expect_compile_success:
        raise AssertionError(f"{name}: invalid fixture unexpectedly compiled")
    stored = load_json(folder / "compiled-bindings.json")
    if compiled != stored:
        raise AssertionError(f"{name}: compiled bindings are stale")


def validate_policy() -> None:
    validate_json(CONFIG / "workflow-security-policy.example.json", SCHEMAS / "workflow-security-policy.schema.json")
    policy = load_json(CONFIG / "workflow-security-policy.example.json")
    manifest = load_json(FIXTURES / "generic-image-smoke" / "manifest.json")
    workflow = load_json(FIXTURES / "generic-image-smoke" / "workflow.api.json")
    allowed = set(policy["allowedNodeClasses"])
    denied = set(policy["deniedNodeClasses"])
    for node_id, node in workflow.items():
        cls = node.get("class_type")
        if cls not in allowed or cls in denied:
            raise AssertionError(f"node {node_id} class {cls} violates platform policy")
        for input_name in node.get("inputs", {}):
            lowered = input_name.casefold()
            for token in policy["deniedInputNameTokens"]:
                if token.casefold() in lowered:
                    raise AssertionError(f"node {node_id} input {input_name} contains denied token {token}")
    limits = policy["limits"]
    if len(workflow) > limits["maxNodes"]:
        raise AssertionError("workflow exceeds maxNodes")
    if len(manifest["bindings"]) > limits["maxBindings"]:
        raise AssertionError("manifest exceeds maxBindings")
    if len(manifest["outputs"]) > limits["maxOutputs"]:
        raise AssertionError("manifest exceeds maxOutputs")
    if manifest["limits"]["maxPixels"] > limits["maxPixels"]:
        raise AssertionError("workflow asks for more pixels than platform policy")
    # Author-controlled executable policy fields are forbidden.
    forbidden = {"denyRegex", "allowRegex", "policyScript", "securityPolicy"}
    if forbidden.intersection(manifest):
        raise AssertionError("manifest contains author-controlled security policy")


def host_is_allowed(host: str, config: dict) -> bool:
    policy = config["networkPolicy"]
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        # Exact hostname match only. Suffix tricks are not accepted.
        return host.rstrip(".").casefold() in {h.rstrip(".").casefold() for h in policy["allowedHostnames"]}
    return any(addr in ipaddress.ip_network(cidr, strict=False) for cidr in policy["allowedCidrs"])


def validate_backend_semantics(config: dict, should_pass: bool) -> None:
    schema = load_json(SCHEMAS / "execution-backend.schema.json")
    validator = jsonschema.Draft202012Validator(schema, format_checker=FormatChecker())
    schema_errors = list(validator.iter_errors(config))
    semantic_errors: list[str] = []
    parsed = urlparse(config.get("baseUrl", ""))
    host = parsed.hostname or ""
    if not config.get("networkPolicy", {}).get("allowRedirects") is False:
        semantic_errors.append("redirects must be disabled")
    if not host_is_allowed(host, config):
        semantic_errors.append("target host is not allowlisted")
    if config.get("topology") == "lan-remote":
        if parsed.scheme != "https":
            semantic_errors.append("remote backend must use https")
        if config.get("auth", {}).get("type") == "none":
            semantic_errors.append("remote backend must authenticate")
    if config.get("enabled") and not config.get("allowedWorkflowDigests"):
        semantic_errors.append("enabled backend must pin workflow digests")
    all_errors = schema_errors + semantic_errors
    if should_pass and all_errors:
        raise AssertionError(f"backend should pass but failed: {all_errors}")
    if not should_pass and not all_errors:
        raise AssertionError("unsafe backend unexpectedly passed")


def validate_backends() -> None:
    validate_json(CONFIG / "execution-backend.example.json", SCHEMAS / "execution-backend.schema.json")
    base = load_json(CONFIG / "execution-backend.example.json")
    validate_backend_semantics(base, True)

    negatives = []
    x = copy.deepcopy(base); x["baseUrl"] = "http://169.254.169.254/latest/meta-data"; negatives.append(x)
    x = copy.deepcopy(base); x["baseUrl"] = "http://127.0.0.1.attacker.example:8188"; x["networkPolicy"]["allowedHostnames"] = ["127.0.0.1"]; negatives.append(x)
    x = copy.deepcopy(base); x["topology"] = "lan-remote"; x["baseUrl"] = "http://10.0.0.20:8188"; x["networkPolicy"]["allowedCidrs"]=["10.0.0.0/24"]; negatives.append(x)
    x = copy.deepcopy(base); x["enabled"] = True; x["allowedWorkflowDigests"] = []; negatives.append(x)
    x = copy.deepcopy(base); x["networkPolicy"]["allowRedirects"] = True; negatives.append(x)
    for unsafe in negatives:
        validate_backend_semantics(unsafe, False)


def validate_profiles() -> None:
    for path in sorted(PROFILES.glob("*.json")):
        validate_json(path, SCHEMAS / "generation-profile.schema.json")
        profile = load_json(path)
        if profile["adapterKind"] == "comfyui-http":
            if not profile["executionBackendId"] or not profile["workflowPackageDigest"]:
                raise AssertionError(f"{path}: comfy profile lacks backend/workflow")
        if profile["retryPolicy"]["externalExecutionRetries"] > 0:
            raise AssertionError(f"{path}: example must not blindly retry model execution")


def validate_sql() -> None:
    sql = (CONFIG / "database-schema.example.sql").read_text(encoding="utf-8")
    db = sqlite3.connect(":memory:")
    db.executescript(sql)
    tables = {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
    required = {"execution_backends", "resource_pools", "workflow_package_revisions", "generation_profile_revisions", "generation_jobs", "generation_attempts", "resource_pool_slots", "generation_artifacts"}
    missing = required - tables
    if missing:
        raise AssertionError(f"SQL missing tables: {sorted(missing)}")
    fks = list(db.execute("pragma foreign_key_list(execution_backends)"))
    if not any(row[2] == "resource_pools" for row in fks):
        raise AssertionError("execution_backends.resource_pool_id lacks foreign key")
    attempts_sql = db.execute("select sql from sqlite_master where name='generation_attempts'").fetchone()[0]
    jobs_sql = db.execute("select sql from sqlite_master where name='generation_jobs'").fetchone()[0]
    if "external_id_strategy" not in attempts_sql or "submission_correlation_id" not in attempts_sql:
        raise AssertionError("attempt schema lacks adapter-neutral submission correlation")
    if any(token in attempts_sql for token in ("lease_owner", "lease_until_ms INTEGER", "fencing_token INTEGER NOT NULL DEFAULT")):
        raise AssertionError("attempt schema ambiguously mixes worker claim and resource leases")
    if "claim_fencing_token" not in jobs_sql or "resource_fencing_token" not in attempts_sql:
        raise AssertionError("worker claim and resource fencing tokens are not separated")
    trigger_names = {row[0] for row in db.execute("select name from sqlite_master where type='trigger'")}
    required_triggers = {
        "workflow_package_revisions_no_update",
        "generation_profile_revisions_no_update",
        "generation_jobs_current_attempt_guard_update",
        "generation_jobs_current_artifact_guard_update",
        "resource_pool_slots_owner_guard_update",
    }
    if required_triggers - trigger_names:
        raise AssertionError(f"integrity triggers missing: {sorted(required_triggers - trigger_names)}")
    db.close()


def validate_yaml() -> None:
    for path in [ROOT / "examples" / "docker-compose.hardened.example.yml", CONFIG / "docker-compose.topology.example.yml"]:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if "services" not in data or "worker" not in data["services"] or "comfy-image" not in data["services"]:
            raise AssertionError(f"{path}: missing required services")
        comfy = data["services"]["comfy-image"]
        if "ports" in comfy:
            raise AssertionError(f"{path}: inference port must not be published")
        mounts = "\n".join(comfy.get("volumes", []))
        if "task_staging" in mounts or "project_media" in mounts:
            raise AssertionError(f"{path}: inference service must not mount generic staging or project media")
        if "comfy_image_intake" not in mounts:
            raise AssertionError(f"{path}: inference service lacks dedicated intake volume")
        if not data.get("networks", {}).get("inference", {}).get("internal"):
            raise AssertionError(f"{path}: inference network must be internal")


def validate_docs() -> None:
    markdown_paths = sorted(ROOT.rglob("*.md"))
    for path in markdown_paths:
        text = path.read_text(encoding="utf-8")
        if text.count("```") % 2:
            raise AssertionError(f"{path}: unbalanced code fences")
        for match in re.finditer(r"!\[[^\]]*\]\(([^)]+)\)", text):
            ref = match.group(1).split()[0]
            if ref.startswith(("http://", "https://")):
                continue
            target = (path.parent / ref).resolve()
            if not target.exists():
                raise AssertionError(f"{path}: missing image {ref}")
    main = (ROOT / "AI-M_ComfyUI_本地工作流平台开发执行手册_v2.0.md").read_text(encoding="utf-8")
    required_phrases = ["SUBMISSION_UNKNOWN", "防旧写令牌", "流式", "不可变", "服务端请求伪造", "原漫剧兼容"]
    for phrase in required_phrases:
        if phrase not in main:
            raise AssertionError(f"main manual missing core invariant: {phrase}")
    prohibited = ["/history/{prompt_id}`（任务历史接口）是任务完成与输出的最终事实来源", "复用 `modelId`", "进程内互斥锁并扩展"]
    for phrase in prohibited:
        if phrase in main:
            raise AssertionError(f"main manual contains superseded guidance: {phrase}")


def validate_review_order() -> None:
    text = (ROOT / "AI-M_ComfyUI_对抗式双轮审查报告_v2.0.md").read_text(encoding="utf-8")
    first = [m.group(1) for m in re.finditer(r"^## `((?:P|R2-P)[0-3]-\d+)`", text, re.M)]
    # Require first-round severity to be nondecreasing, then second-round separately.
    rank = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "R2-P0": 0, "R2-P1": 1, "R2-P2": 2, "R2-P3": 3}
    rounds = [[], []]
    for item in first:
        target = 1 if item.startswith("R2-") else 0
        prefix = item.rsplit("-", 1)[0]
        rounds[target].append(rank[prefix])
    for idx, values in enumerate(rounds, 1):
        if values != sorted(values):
            raise AssertionError(f"review round {idx} is not sorted by severity: {values}")
    if not rounds[0] or not rounds[1]:
        raise AssertionError("both adversarial review rounds must be present")


def main() -> int:
    validate_fixture("generic-image-smoke", True)
    validate_fixture("invalid-binding", False)
    validate_policy()
    validate_backends()
    validate_profiles()
    validate_sql()
    validate_yaml()
    validate_docs()
    validate_review_order()
    print("[OK] JSON Schema validation")
    print("[OK] content-addressed workflow package integrity")
    print("[OK] semantic selector compilation and stale-binding detection")
    print("[OK] invalid binding rejection")
    print("[OK] platform-owned workflow security policy")
    print("[OK] execution backend network/auth semantics and negative tests")
    print("[OK] generation profile semantics")
    print("[OK] SQLite schema, foreign keys and immutable revision triggers")
    print("[OK] hardened container topology")
    print("[OK] documentation references, invariants and two-round severity order")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        raise
