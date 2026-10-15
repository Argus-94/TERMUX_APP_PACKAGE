#!/usr/bin/env python3
"""Validate the complete pinned Git closure feed before signed APT simulation."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import pathlib
import re
import subprocess
import sys
from typing import Any

PIN = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
BUILDER = "ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af0394e5bdf94814ac9"
APP_ID = "com.karat.aibuilder"
COUNT = 14


class GateError(Exception):
    pass


def require(ok: bool, code: str) -> None:
    if not ok:
        raise GateError(code)


def load(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_index(path: pathlib.Path) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    previous: str | None = None
    for line in path.read_text(encoding="utf-8", errors="strict").splitlines() + [""]:
        if not line:
            if current:
                records.append(current)
                current = {}
                previous = None
            continue
        if line[:1] in (" ", "\t"):
            require(previous is not None, "INDEX_ORPHAN_CONTINUATION")
            current[previous] += "\n" + line
            continue
        key, sep, value = line.partition(":")
        require(bool(sep) and key not in current, "INDEX_MALFORMED_OR_DUPLICATE_FIELD")
        current[key] = value.strip()
        previous = key
    return records


def validate(args: argparse.Namespace) -> None:
    manifest = load(args.package_set)
    build = load(args.build_result)
    audit = load(args.audit_report)
    require(manifest.get("schemaVersion") == 1 and manifest.get("channel") == "candidate-only", "PACKAGE_SET_NOT_CANDIDATE_ONLY")
    require(manifest.get("source", {}).get("commit") == PIN and manifest.get("source", {}).get("builderImage") == BUILDER, "SOURCE_OR_BUILDER_NOT_ALLOWLISTED")
    apparmor_sha = manifest.get("source", {}).get("restrictedAppArmorProfileSha256")
    require(apparmor_sha == "ec7680c466c03c9354b890e6860f9fb3e1b5512d380c9d05e426cb47548abbe8", "APPARMOR_PROFILE_NOT_PINNED")
    target = manifest.get("target", {})
    require(target.get("applicationId") == APP_ID and target.get("architecture") == "aarch64", "TARGET_NOT_ALLOWLISTED")
    prefix = target.get("modeledPrefix", "")
    data_dir = target.get("modeledDataDir", "")
    require(prefix in {"/data/user/0/com.karat.aibuilder/files/usr", "/data/data/com.karat.aibuilder/files/usr"}, "MODELED_PREFIX_NOT_CANONICAL")
    require(prefix == data_dir + "/files/usr", "MODELED_PREFIX_MISMATCH")
    release = manifest.get("releaseGate", {})
    require(release.get("publicationAllowed") is False and release.get("deviceInstall") == "NOT RUN" and release.get("rollback") == "NOT RUN" and release.get("deviceEvidenceSha256") is None, "RELEASE_GATE_NOT_BLOCKED")
    closure = manifest.get("sourceClosure", {})
    specs = manifest.get("packages")
    require(closure.get("profile") == "git-candidate" and closure.get("rootPackages") == ["git"] and closure.get("expectedPackageCount") == COUNT, "SOURCE_CLOSURE_NOT_EXACT")
    require(isinstance(specs, list) and len(specs) == COUNT, "PACKAGE_ALLOWLIST_COUNT_NOT_EXACT")
    expected = {x.get("name"): x for x in specs}
    require(None not in expected and len(expected) == COUNT, "PACKAGE_ALLOWLIST_NAME_INVALID")
    names = sorted(expected)
    require(names == [x["name"] for x in specs], "PACKAGE_ALLOWLIST_NOT_SORTED")
    require(build.get("status") == "audit-passed; device-runtime-test-not-run", "BUILD_STATUS_NOT_AUDIT_PASS")
    require(build.get("sourceCommit") == PIN and build.get("builderImageRef") == BUILDER, "BUILD_PROVENANCE_MISMATCH")
    require(build.get("restrictedAppArmorProfileSha256") == apparmor_sha and audit.get("restrictedAppArmorProfileSha256") == apparmor_sha, "APPARMOR_PROFILE_PROVENANCE_MISMATCH")
    require(build.get("applicationId") == APP_ID and build.get("architecture") == "aarch64" and build.get("prefix") == prefix, "BUILD_TARGET_MISMATCH")
    require(build.get("prefixProvenance") == "ci-model-only; device-observation-not-run", "PREFIX_MUST_REMAIN_MODEL_ONLY")
    require(build.get("installed") is False and build.get("deviceSmokeTest") == "NOT RUN" and build.get("rollback") == "NOT RUN", "DEVICE_STATUS_MUST_REMAIN_UNPROVEN")
    require(audit.get("ok") is True and audit.get("status") == "static-audit-passed; installation-and-device-runtime-unverified", "STATIC_AUDIT_NOT_PASS")
    require(audit.get("sourceCommit") == PIN and audit.get("builderImage") == BUILDER and audit.get("applicationId") == APP_ID and audit.get("prefix") == prefix, "AUDIT_PROVENANCE_MISMATCH")
    require(audit.get("prefixProvenance") == "ci-model-only; device-observation-not-run" and audit.get("deviceInstall") == "NOT RUN" and audit.get("rollback") == "NOT RUN", "AUDIT_DEVICE_STATUS_INVALID")
    audit_packages = audit.get("packages")
    build_packages = build.get("packages")
    require(isinstance(audit_packages, list) and isinstance(build_packages, list) and len(audit_packages) == len(build_packages) == COUNT, "BUILD_AUDIT_PACKAGE_COUNT_MISMATCH")
    by_audit = {x.get("name"): x for x in audit_packages}
    by_build = {x.get("name"): x for x in build_packages}
    require(set(by_audit) == set(by_build) == set(expected), "BUILD_AUDIT_PACKAGE_SET_MISMATCH")

    root = args.feed_root.resolve(strict=True)
    pool = root / "pool"
    require(pool.is_dir() and not pool.is_symlink(), "POOL_ROOT_INVALID")
    debs = sorted(pool.rglob("*.deb"))
    require(len(debs) == COUNT, "FEED_DEB_COUNT_NOT_EXACT")
    seen: set[str] = set()
    for deb in debs:
        require(deb.is_file() and not deb.is_symlink() and root in deb.resolve(strict=True).parents, "FEED_DEB_PATH_INVALID")
        fields = subprocess.run(["dpkg-deb", "-f", str(deb), "Package", "Version", "Architecture"], capture_output=True, text=True, check=False, timeout=30)
        require(fields.returncode == 0, "FEED_DEB_CONTROL_UNREADABLE")
        values = fields.stdout.splitlines()
        require(len(values) == 3, "FEED_DEB_CONTROL_INVALID")
        name, version, architecture = values
        require(name in expected and name not in seen, "FEED_PACKAGE_NOT_ALLOWLISTED_OR_DUPLICATE")
        spec = expected[name]
        require((version, architecture) == (spec["version"], spec["architecture"]), "FEED_PACKAGE_IDENTITY_MISMATCH")
        require(deb.relative_to(root).as_posix().startswith("pool/main/" + name + "/"), "FEED_PACKAGE_DIRECTORY_MISMATCH")
        a, b = by_audit[name], by_build[name]
        digest = hashlib.sha256(deb.read_bytes()).hexdigest()
        require(deb.name == a.get("filename") == b.get("filename"), "FEED_DEB_FILENAME_MISMATCH")
        require(digest == a.get("sha256") == b.get("sha256"), "FEED_DEB_SHA256_MISMATCH")
        require(a.get("version") == b.get("version") == version and a.get("architecture") == b.get("architecture") == architecture, "BUILD_AUDIT_DEB_IDENTITY_MISMATCH")
        seen.add(name)
    require(seen == set(expected), "FEED_PACKAGE_SET_MISMATCH")

    index = root / "dists/stable/main/binary-aarch64/Packages"
    zipped = root / "dists/stable/main/binary-aarch64/Packages.gz"
    require(index.is_file() and not index.is_symlink() and zipped.is_file() and not zipped.is_symlink(), "PACKAGES_INDEX_MISSING")
    require(gzip.decompress(zipped.read_bytes()) == index.read_bytes(), "PACKAGES_GZIP_MISMATCH")
    records = parse_index(index)
    require(len(records) == COUNT, "INDEX_PACKAGE_COUNT_MISMATCH")
    indexed: set[str] = set()
    for record in records:
        name = record.get("Package", "")
        require(name in expected and name not in indexed, "INDEX_PACKAGE_NOT_ALLOWLISTED_OR_DUPLICATE")
        spec = expected[name]
        require(record.get("Version") == spec["version"] and record.get("Architecture") == spec["architecture"], "INDEX_PACKAGE_IDENTITY_MISMATCH")
        rel = pathlib.PurePosixPath(record.get("Filename", ""))
        require(not rel.is_absolute() and ".." not in rel.parts, "INDEX_FILENAME_TRAVERSAL")
        deb = root / rel.as_posix()
        require(deb.is_file() and not deb.is_symlink() and record.get("Size") == str(deb.stat().st_size), "INDEX_PACKAGE_FILE_MISMATCH")
        require(record.get("SHA256") == hashlib.sha256(deb.read_bytes()).hexdigest(), "INDEX_PACKAGE_SHA256_MISMATCH")
        indexed.add(name)
    require(indexed == set(expected), "INDEX_PACKAGE_SET_MISMATCH")
    print("GIT_CANDIDATE_FEED_POLICY_OK packages=14 source=locked static_audit=pass exact_closure=1 signed_by=separately_verified device_install=NOT_RUN production_release=blocked")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-set", type=pathlib.Path, required=True)
    parser.add_argument("--feed-root", type=pathlib.Path, required=True)
    parser.add_argument("--build-result", type=pathlib.Path, required=True)
    parser.add_argument("--audit-report", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        validate(args)
        return 0
    except (GateError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError, gzip.BadGzipFile) as exc:
        code = str(exc) if isinstance(exc, GateError) else "VALIDATION_INPUT_INVALID"
        print("GIT_CANDIDATE_FEED_REJECTED:" + code, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
