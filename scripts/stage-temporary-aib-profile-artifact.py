#!/usr/bin/env python3
"""Validate and stage one temporary ARM64 package-closure CI profile."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys


def fail(message: str) -> None:
    raise SystemExit(f"PROFILE_STAGE_REJECTED:{message}")


def read_json(path: pathlib.Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"INVALID_JSON:{path.name}:{exc}")


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def identity_from_deb(path: pathlib.Path) -> tuple[str, str, str]:
    try:
        raw = subprocess.check_output(
            ["dpkg-deb", "-f", str(path), "Package", "Version", "Architecture"],
            text=True,
            stderr=subprocess.STDOUT,
        )
    except subprocess.CalledProcessError as exc:
        fail(f"INVALID_DEB:{path.name}:{exc.output[-800:]}")
    fields = raw.splitlines()
    if len(fields) != 3 or any(not value for value in fields):
        fail(f"INVALID_DEB_IDENTITY:{path.name}:{raw!r}")
    return tuple(fields)  # type: ignore[return-value]


def safe_repo_file(repo: pathlib.Path, relative: str) -> pathlib.Path:
    path = (repo / relative).resolve(strict=True)
    if not path.is_relative_to(repo.resolve()):
        fail(f"PATH_ESCAPES_REPO:{relative}")
    if not path.is_file():
        fail(f"EXPECTED_FILE:{relative}")
    return path


def expected_manifest_rows(manifest: dict) -> list[dict]:
    rows = manifest.get("packages")
    if isinstance(rows, list):
        return rows
    row = manifest.get("package")
    if isinstance(row, dict):
        return [row]
    fail("PACKAGE_MANIFEST_HAS_NO_PACKAGES")


def result_records(build: dict, actual: dict[tuple[str, str, str], dict]) -> dict[tuple[str, str, str], str]:
    records: dict[tuple[str, str, str], str] = {}
    rows = build.get("packages")
    if isinstance(rows, list):
        for row in rows:
            key = (row.get("name"), row.get("version"), row.get("architecture"))
            digest = row.get("sha256")
            if key in records or not all(isinstance(v, str) and v for v in key) or not isinstance(digest, str):
                fail("BUILD_RESULT_PACKAGE_RECORD_INVALID")
            records[key] = digest
    elif isinstance(build.get("packageFile"), str) and isinstance(build.get("packageSha256"), str):
        if len(actual) != 1:
            fail("SINGLE_PACKAGE_BUILD_RESULT_FOR_MULTI_PACKAGE_PROFILE")
        key = next(iter(actual))
        if pathlib.Path(build["packageFile"]).name != actual[key]["file"]:
            fail("BUILD_RESULT_PACKAGE_FILENAME_MISMATCH")
        records[key] = build["packageSha256"]
    else:
        fail("BUILD_RESULT_HAS_NO_PACKAGE_HASHES")
    return records


def audit_records(audit: dict, actual: dict[tuple[str, str, str], dict]) -> dict[tuple[str, str, str], str]:
    records: dict[tuple[str, str, str], str] = {}
    rows = audit.get("packages")
    if isinstance(rows, list):
        for row in rows:
            key = (row.get("name"), row.get("version"), row.get("architecture"))
            digest = row.get("sha256")
            if key in records or not all(isinstance(v, str) and v for v in key) or not isinstance(digest, str):
                fail("AUDIT_REPORT_PACKAGE_RECORD_INVALID")
            records[key] = digest
    elif isinstance(audit.get("package"), dict) and isinstance(audit.get("sha256"), str):
        row = audit["package"]
        key = (row.get("name"), row.get("version"), row.get("architecture"))
        if not all(isinstance(v, str) and v for v in key):
            fail("AUDIT_REPORT_SINGLE_PACKAGE_IDENTITY_INVALID")
        records[key] = audit["sha256"]
    else:
        fail("AUDIT_REPORT_HAS_NO_PACKAGE_HASHES")
    return records


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", type=pathlib.Path, required=True)
    ap.add_argument("--plan", type=pathlib.Path, required=True)
    ap.add_argument("--profile-id", required=True)
    ap.add_argument("--source-dir", type=pathlib.Path, required=True)
    ap.add_argument("--build-output", type=pathlib.Path, required=True)
    ap.add_argument("--destination", type=pathlib.Path, required=True)
    args = ap.parse_args()

    repo = args.repo_root.resolve(strict=True)
    plan_path = args.plan.resolve(strict=True)
    plan = read_json(plan_path)
    profiles = [p for p in plan.get("profiles", []) if p.get("id") == args.profile_id]
    if len(profiles) != 1:
        fail("PROFILE_ID_NOT_UNIQUE_IN_PLAN")
    profile = profiles[0]
    source = args.source_dir.resolve(strict=True)
    build = args.build_output.resolve(strict=True)
    dest = args.destination.resolve()
    if not source.is_dir() or not build.is_dir():
        fail("SOURCE_OR_BUILD_OUTPUT_NOT_DIRECTORY")
    if dest.exists() and any(dest.iterdir()):
        fail("DESTINATION_NOT_EMPTY")
    dest.mkdir(parents=True, exist_ok=True)

    source_head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if source_head != plan["sourceCommit"]:
        fail("PINNED_SOURCE_COMMIT_MISMATCH")
    source_changes = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True)
    # Build wrappers apply only their reviewed package/prefix patches in a private worktree.
    # The original source checkout itself must remain clean.
    if source_changes:
        fail("PINNED_SOURCE_CHECKOUT_NOT_CLEAN")

    manifest_path = safe_repo_file(repo, profile["manifestPath"])
    manifest = read_json(manifest_path)
    wrapper_path = safe_repo_file(repo, profile["wrapperPath"])
    if wrapper_path.is_symlink() or not wrapper_path.is_file():
        fail("BUILD_WRAPPER_NOT_REGULAR_FILE")
    manifest_arch = manifest.get("target", {}).get("architecture")
    if manifest_arch not in (None, plan["architecture"]):
        fail("MANIFEST_ARCHITECTURE_MISMATCH")
    source_meta = manifest.get("source", {})
    source_commit = source_meta.get("commit") or manifest.get("upstreamSource", {}).get("revision")
    if source_commit != plan["sourceCommit"]:
        fail("MANIFEST_SOURCE_COMMIT_MISMATCH")
    builder_meta = manifest.get("builder", {})
    manifest_image = builder_meta.get("imageReference") or builder_meta.get("imageRef") or builder_meta.get("imageDigest")
    if manifest_image and manifest_image != plan["builderImage"] and manifest_image != plan["builderImage"].split("@", 1)[1]:
        fail("MANIFEST_BUILDER_IMAGE_MISMATCH")
    gate = manifest.get("releaseGate", {})
    if gate.get("publicationAllowed") is not False:
        fail("MANIFEST_PUBLICATION_GATE_OPEN")
    if gate.get("deviceInstall") not in ("NOT RUN", "NOT_RUN") or gate.get("rollback") not in ("NOT RUN", "NOT_RUN"):
        fail("MANIFEST_DEVICE_GATE_NOT_CLOSED")

    closure_path = build / "source-closure.json"
    result_path = build / "build-result.json"
    audit_path = build / "audit-report.json"
    packages_path = build / "packages"
    for p in (closure_path, result_path, audit_path):
        if not p.is_file():
            fail(f"MISSING_BUILD_EVIDENCE:{p.name}")
    if not packages_path.is_dir():
        fail("MISSING_PACKAGE_DIRECTORY")
    closure, build_result, audit = map(read_json, (closure_path, result_path, audit_path))

    if closure.get("sourceCommit") != plan["sourceCommit"]:
        fail("SOURCE_CLOSURE_COMMIT_MISMATCH")
    if closure.get("profile") != profile["sourceClosureProfile"]:
        fail("SOURCE_CLOSURE_PROFILE_MISMATCH")
    if closure.get("rootPackages") != profile["rootPackages"]:
        fail("SOURCE_CLOSURE_ROOTS_MISMATCH")
    if closure.get("packageCount") != profile["expectedPackageCount"]:
        fail("SOURCE_CLOSURE_PACKAGE_COUNT_MISMATCH")
    if closure.get("dependencyAlternativeCount") != profile["expectedDependencyAlternativeCount"]:
        fail("SOURCE_CLOSURE_ALTERNATIVE_COUNT_MISMATCH")
    closure_hash = sha256(closure_path)
    if closure_hash != profile["sourceClosureSha256"]:
        fail("SOURCE_CLOSURE_HASH_MISMATCH")
    closure_rows = closure.get("packages")
    if not isinstance(closure_rows, list):
        fail("SOURCE_CLOSURE_HAS_NO_PACKAGE_ROWS")
    closure_by_name = {row.get("name"): row for row in closure_rows}
    if len(closure_by_name) != len(closure_rows):
        fail("DUPLICATE_SOURCE_CLOSURE_PACKAGE_NAMES")

    specs = expected_manifest_rows(manifest)
    spec_by_name: dict[str, dict] = {}
    for spec in specs:
        name = spec.get("name")
        if not isinstance(name, str) or name in spec_by_name:
            fail("DUPLICATE_OR_INVALID_PACKAGE_MANIFEST_NAME")
        if spec.get("architecture") not in ("aarch64", "all"):
            fail(f"UNEXPECTED_PACKAGE_ARCHITECTURE:{name}")
        spec_by_name[name] = spec
    if set(spec_by_name) != set(closure_by_name):
        fail("PACKAGE_MANIFEST_VS_SOURCE_CLOSURE_NAMES_MISMATCH")
    if len(spec_by_name) != profile["expectedPackageCount"]:
        fail("PACKAGE_MANIFEST_COUNT_MISMATCH")

    for name, spec in spec_by_name.items():
        c = closure_by_name[name]
        if c.get("recipeSha256") != spec.get("recipeSha256"):
            # The standalone Make manifest stores its pinned recipe hash in upstreamSource.
            if name != "make" or c.get("recipeSha256") != manifest.get("upstreamSource", {}).get("packageRecipeSha256"):
                fail(f"PACKAGE_RECIPE_HASH_MISMATCH:{name}")
        if name == "npm":
            # Preserve the upstream alternative relation; never rewrite it to LTS-only.
            raw_relations = [
                group for package in manifest.get("packages", []) if package.get("name") == "npm"
                for group in package.get("dependencyGroups", [])
            ]
            if not raw_relations or not any({alt.get("name") for alt in group} == {"nodejs", "nodejs-lts"} for group in raw_relations):
                fail("NPM_UPSTREAM_ALTERNATIVE_DEPENDENCY_NOT_PRESERVED")

    if args.profile_id == "nodejs-lts-npm":
        if "nodejs" in spec_by_name:
            fail("CURRENT_NODEJS_MUST_NOT_REPLACE_NODEJS_LTS")
        if not {"nodejs-lts", "npm"}.issubset(spec_by_name):
            fail("LTS_PROFILE_ROOTS_MISSING")

    deb_files = sorted(packages_path.glob("*.deb"))
    if len(deb_files) != profile["expectedPackageCount"] or len(deb_files) != len(spec_by_name):
        fail("DEB_COUNT_MISMATCH")
    if any(not p.is_file() or p.is_symlink() for p in deb_files):
        fail("PACKAGE_OUTPUT_HAS_NONREGULAR_FILE")

    actual: dict[tuple[str, str, str], dict] = {}
    seen_names: set[str] = set()
    for deb in deb_files:
        key = identity_from_deb(deb)
        if key in actual or key[0] in seen_names:
            fail(f"DUPLICATE_DEB_IDENTITY:{key[0]}")
        seen_names.add(key[0])
        spec = spec_by_name.get(key[0])
        if spec is None or key[1] != spec.get("version") or key[2] != spec.get("architecture"):
            fail(f"UNEXPECTED_DEB_IDENTITY:{key}")
        actual[key] = {"file": deb.name, "sha256": sha256(deb), "path": deb}
    if set(seen_names) != set(spec_by_name):
        fail("EXPECTED_DEB_PACKAGE_NAMES_MISSING")

    build_records = result_records(build_result, actual)
    audit_hashes = audit_records(audit, actual)
    if set(build_records) != set(actual) or set(audit_hashes) != set(actual):
        fail("RECORDED_DEB_IDENTITY_SET_MISMATCH")
    for key, record in actual.items():
        if build_records[key] != record["sha256"] or audit_hashes[key] != record["sha256"]:
            fail(f"DEB_SHA256_MISMATCH:{key[0]}")

    if build_result.get("status") != "audit-passed; device-runtime-test-not-run":
        fail("BUILD_RESULT_STATUS_NOT_AUDIT_PASSED")
    if build_result.get("sourceCommit") != plan["sourceCommit"]:
        fail("BUILD_RESULT_SOURCE_COMMIT_MISMATCH")
    image = build_result.get("builderImage") or build_result.get("builderImageRef")
    if image != plan["builderImage"]:
        fail("BUILD_RESULT_BUILDER_IMAGE_MISMATCH")
    if build_result.get("installed") is not False:
        fail("BUILD_RESULT_DEVICE_INSTALL_NOT_CLOSED")
    if build_result.get("deviceSmokeTest") not in ("NOT RUN", "NOT_RUN"):
        fail("BUILD_RESULT_DEVICE_SMOKE_TEST_NOT_CLOSED")
    if build_result.get("prefixProvenance") not in (None, "ci-model-only; device-observation-not-run"):
        fail("BUILD_RESULT_PREFIX_PROVENANCE_MISMATCH")
    if audit.get("ok") is not True:
        fail("STATIC_AUDIT_NOT_PASSED")
    if audit.get("installed") not in (None, False):
        fail("AUDIT_REPORT_DEVICE_INSTALL_NOT_CLOSED")

    # Stage only the package bytes and structured evidence; never carry build logs or key material.
    staged_packages = dest / "packages"
    staged_packages.mkdir(parents=True)
    staged_records = []
    for key in sorted(actual):
        record = actual[key]
        shutil.copy2(record["path"], staged_packages / record["file"])
        staged_records.append({
            "name": key[0],
            "version": key[1],
            "architecture": key[2],
            "file": record["file"],
            "sha256": record["sha256"],
        })
    shutil.copy2(manifest_path, dest / "candidate-package-set.json")
    shutil.copy2(closure_path, dest / "source-closure.json")
    shutil.copy2(result_path, dest / "build-result.json")
    shutil.copy2(audit_path, dest / "audit-report.json")
    index = {
        "schemaVersion": 1,
        "temporaryOnly": True,
        "profileId": profile["id"],
        "sourceClosureProfile": profile["sourceClosureProfile"],
        "sourceCommit": plan["sourceCommit"],
        "builderImage": plan["builderImage"],
        "architecture": plan["architecture"],
        "rootPackages": profile["rootPackages"],
        "sourceClosureSha256": closure_hash,
        "packageSetSha256": sha256(manifest_path),
        "sourceClosurePackageCount": closure["packageCount"],
        "sourceClosureDependencyAlternativeCount": closure["dependencyAlternativeCount"],
        "debCount": len(staged_records),
        "packages": staged_records,
        "qualification": {
            "qualified": False,
            "productionAllowed": False,
            "deviceInstall": "NOT RUN",
            "deviceRuntimeTest": "NOT RUN",
        },
    }
    (dest / "profile-index.json").write_text(json.dumps(index, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(
        f"PROFILE_STAGE_OK id={profile['id']} packages={len(staged_records)} "
        f"closure_sha256={closure_hash} source_commit={plan['sourceCommit']}"
    )


if __name__ == "__main__":
    main()
