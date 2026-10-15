#!/usr/bin/env python3
"""Fail-closed validation for the pinned, non-published gh candidate feed."""
from __future__ import annotations

import gzip
import hashlib
import json
import pathlib
import re
import subprocess
import sys
from typing import Any

APP_ID = "com.karat.aibuilder"
SOURCE_REPO = "https://github.com/termux/termux-packages.git"
SOURCE_COMMIT = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
RECIPE_SHA256 = "a26022905b66f39851553abea3b5e68c38671988b4e2a9a649366845dadfb266"
SOURCE_URL = "https://github.com/cli/cli/archive/refs/tags/v2.102.0.tar.gz"
SOURCE_SHA256 = "08bf0ef8b4409893889175e0f5279d30d6edd96465816042c0d7c72eac598158"
LICENSE_SHA256 = "6da4adc42392c8485e40b4251c7e332fc3352df1947c9ffade71dd60b14a7a4f"
BUILDER_IMAGE = "ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9"
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


class GateError(Exception):
    pass


def require(ok: bool, code: str) -> None:
    if not ok:
        raise GateError(code)


def load_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), "JSON_ROOT_MUST_BE_OBJECT")
    return value


def parse_index(path: pathlib.Path) -> list[dict[str, str]]:
    text = path.read_text(encoding="utf-8", errors="strict")
    records: list[dict[str, str]] = []
    for raw in text.strip().split("\n\n") if text.strip() else []:
        fields: dict[str, str] = {}
        previous: str | None = None
        for line in raw.splitlines():
            if line[:1] in (" ", "\t"):
                require(previous is not None, "INDEX_ORPHAN_CONTINUATION")
                fields[previous] += "\n" + line
                continue
            key, sep, value = line.partition(":")
            require(bool(sep) and key not in fields, "INDEX_MALFORMED_OR_DUPLICATE_FIELD")
            fields[key] = value.strip()
            previous = key
        records.append(fields)
    return records


def validate(args: Any) -> None:
    package_set = load_json(args.package_set)
    build = load_json(args.build_result)
    audit = load_json(args.audit_report)
    require(package_set.get("schemaVersion") == 1 and package_set.get("channel") == "candidate-only",
            "PACKAGE_SET_NOT_CANDIDATE_ONLY")
    target = package_set.get("target", {})
    prefix = target.get("modeledPrefix", "")
    require(target.get("applicationId") == APP_ID and target.get("architecture") == "aarch64",
            "TARGET_IDENTITY_MISMATCH")
    require(target.get("modeledDataDir") == "/data/user/0/com.karat.aibuilder", "MODELED_DATA_DIR_NOT_ALLOWLISTED")
    require(prefix == "/data/user/0/com.karat.aibuilder/files/usr", "MODELED_PREFIX_NOT_ALLOWLISTED")
    gate = package_set.get("releaseGate", {})
    require(gate.get("publicationAllowed") is False, "PRODUCTION_PUBLICATION_MUST_REMAIN_DISABLED")
    require(gate.get("deviceInstall") == "NOT_RUN" and gate.get("rollback") == "NOT_RUN",
            "DEVICE_STATUS_MUST_REMAIN_UNPROVEN")
    require(gate.get("deviceEvidenceSha256") is None, "DEVICE_EVIDENCE_MUST_NOT_BE_FABRICATED")
    packages = package_set.get("packages")
    require(isinstance(packages, list) and len(packages) == 1, "PACKAGE_ALLOWLIST_MUST_BE_EXACTLY_ONE")
    spec = packages[0]
    expected = {
        "name": "gh", "version": "2.102.0", "architecture": "aarch64",
        "sourceRepository": SOURCE_REPO, "sourceCommit": SOURCE_COMMIT,
        "recipePath": "packages/gh/build.sh", "recipeSha256": RECIPE_SHA256,
        "sourceUrl": SOURCE_URL, "sourceSha256": SOURCE_SHA256,
        "sourceLicenseFile": "LICENSE", "sourceLicenseRelativePath": "share/doc/gh/copyright",
        "sourceLicenseSha256": LICENSE_SHA256, "builderImage": BUILDER_IMAGE,
        "runtimeDependenciesExpected": [], "recommendationsExpected": ["openssh"],
        "staticAuditRequired": True, "deviceInstallAndRollbackRequired": True,
    }
    for key, value in expected.items():
        require(spec.get(key) == value, "PACKAGE_FIELD_NOT_ALLOWLISTED_" + key.upper())

    require(build.get("schemaVersion") == 1 and build.get("status") == "audit-passed; device-runtime-test-not-run",
            "BUILD_STATUS_NOT_STATIC_AUDIT_PASS")
    for key, value in {
        "sourceRepository": SOURCE_REPO, "sourceCommit": SOURCE_COMMIT, "recipePath": "packages/gh/build.sh",
        "recipeSha256": RECIPE_SHA256, "sourceUrl": SOURCE_URL, "sourceSha256": SOURCE_SHA256,
        "sourceLicenseFile": "LICENSE", "sourceLicenseRelativePath": "share/doc/gh/copyright",
        "sourceLicenseSha256": LICENSE_SHA256, "builderImageRef": BUILDER_IMAGE,
        "applicationId": APP_ID, "architecture": "aarch64", "prefix": prefix,
        "prefixProvenance": "ci-model-only; device-observation-not-run", "packageName": "gh",
        "packageVersion": "2.102.0", "packageArchitecture": "aarch64",
        "installed": False, "deviceSmokeTest": "NOT RUN",
    }.items():
        require(build.get(key) == value, "BUILD_RESULT_MISMATCH_" + key.upper())
    require(bool(HEX64_RE.fullmatch(build.get("builderPropertiesPatchSha256", ""))),
            "BUILDER_PROPERTIES_PATCH_HASH_MISSING")
    require(bool(HEX64_RE.fullmatch(build.get("packageSha256", ""))), "BUILD_PACKAGE_HASH_MISSING")
    require(build.get("sourceClosure") == {
        "profile": "builder-cli", "rootPackages": ["gh"], "packageCount": 1,
        "requiredDependencyAlternativeCount": 0, "recommendationsExcluded": ["openssh"],
    }, "SOURCE_CLOSURE_NOT_ALLOWLISTED")

    require(audit.get("ok") is True, "STATIC_AUDIT_REPORT_NOT_PASS")
    require(audit.get("status") == "static-audit-passed; installation-and-device-runtime-unverified",
            "STATIC_AUDIT_STATUS_UNEXPECTED")
    require(audit.get("sha256") == build.get("packageSha256"), "AUDIT_BUILD_HASH_MISMATCH")
    pkg = audit.get("package", {})
    for key, value in {
        "name": "gh", "version": "2.102.0", "architecture": "aarch64", "depends": [],
        "preDepends": [], "recommends": ["openssh"], "licenseEvidencePath": "share/doc/gh/copyright",
        "licenseEvidenceSha256": LICENSE_SHA256,
    }.items():
        require(pkg.get(key) == value, "AUDIT_PACKAGE_FIELD_MISMATCH_" + key.upper())
    require(audit.get("source", {}).get("commit") == SOURCE_COMMIT
            and audit.get("source", {}).get("recipeSha256") == RECIPE_SHA256
            and audit.get("source", {}).get("archiveSha256") == SOURCE_SHA256,
            "AUDIT_SOURCE_PROVENANCE_MISMATCH")
    require(audit.get("target", {}).get("applicationId") == APP_ID
            and audit.get("target", {}).get("prefix") == prefix
            and audit.get("installed") is False
            and audit.get("deviceSmokeTest") == "NOT RUN", "AUDIT_TARGET_STATUS_MISMATCH")

    root = args.feed_root.resolve(strict=True)
    pool = root / "pool"
    require(pool.is_dir() and not pool.is_symlink(), "POOL_ROOT_INVALID")
    debs = sorted(pool.rglob("*.deb"))
    require(len(debs) == 1, "PACKAGE_FILE_SET_MISMATCH")
    deb = debs[0]
    require(not deb.is_symlink() and deb.is_file() and root in deb.resolve(strict=True).parents,
            "PACKAGE_FILE_NOT_REGULAR_OR_ESCAPES_ROOT")
    require(deb.relative_to(root).as_posix().startswith("pool/main/gh/"), "PACKAGE_FILE_OUTSIDE_ALLOWLISTED_PATH")
    require(deb.name == build.get("packageFile"), "BUILD_PACKAGE_FILENAME_MISMATCH")
    digest = hashlib.sha256(deb.read_bytes()).hexdigest()
    require(digest == build["packageSha256"] == audit["sha256"], "PACKAGE_HASH_MISMATCH")
    control = subprocess.run(["dpkg-deb", "-f", str(deb)], capture_output=True, text=True, check=False, timeout=30)
    require(control.returncode == 0, "DPKG_CONTROL_READ_FAILED")
    fields: dict[str, str] = {}
    for line in control.stdout.splitlines():
        if line[:1] in (" ", "\t"):
            continue
        key, sep, value = line.partition(":")
        require(bool(sep) and key not in fields, "DEB_CONTROL_MALFORMED")
        fields[key] = value.strip()
    require(fields.get("Package") == "gh" and fields.get("Version") == "2.102.0"
            and fields.get("Architecture") == "aarch64", "DEB_CONTROL_IDENTITY_MISMATCH")
    require(not fields.get("Depends", "") and not fields.get("Pre-Depends", ""), "DEB_CONTROL_HAS_UNEXPECTED_DEPENDS")
    require(fields.get("Recommends") == "openssh", "DEB_CONTROL_RECOMMENDS_MISMATCH")

    index = root / "dists/stable/main/binary-aarch64/Packages"
    compressed = root / "dists/stable/main/binary-aarch64/Packages.gz"
    require(index.is_file() and not index.is_symlink(), "PACKAGES_INDEX_MISSING")
    require(compressed.is_file() and not compressed.is_symlink(), "PACKAGES_GZ_MISSING")
    require(gzip.decompress(compressed.read_bytes()) == index.read_bytes(), "PACKAGES_GZIP_CONTENT_MISMATCH")
    records = parse_index(index)
    require(len(records) == 1, "INDEX_PACKAGE_SET_MISMATCH")
    record = records[0]
    require(record.get("Package") == "gh" and record.get("Version") == "2.102.0"
            and record.get("Architecture") == "aarch64", "INDEX_PACKAGE_IDENTITY_MISMATCH")
    require(not record.get("Depends", "") and not record.get("Pre-Depends", ""), "INDEX_HAS_UNEXPECTED_DEPENDS")
    require(record.get("Recommends") == "openssh", "INDEX_RECOMMENDS_MISMATCH")
    rel = pathlib.PurePosixPath(record.get("Filename", ""))
    require(not rel.is_absolute() and ".." not in rel.parts and rel.as_posix() == deb.relative_to(root).as_posix(),
            "INDEX_FILENAME_MISMATCH")
    require(record.get("Size") == str(deb.stat().st_size), "INDEX_PACKAGE_SIZE_MISMATCH")
    require(record.get("SHA256") == digest, "INDEX_PACKAGE_SHA256_MISMATCH")
    print("GH_CANDIDATE_FEED_POLICY_OK package=gh version=2.102.0 source=locked static_audit=pass required_depends=0 recommends=openssh signed_candidate=separately_verified production_release=blocked device_install=NOT_RUN")


def main() -> int:
    try:
        import argparse
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--package-set", type=pathlib.Path, required=True)
        parser.add_argument("--feed-root", type=pathlib.Path, required=True)
        parser.add_argument("--build-result", type=pathlib.Path, required=True)
        parser.add_argument("--audit-report", type=pathlib.Path, required=True)
        validate(parser.parse_args())
        return 0
    except (GateError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, gzip.BadGzipFile) as exc:
        print("GH_CANDIDATE_FEED_REJECTED:" + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
