#!/usr/bin/env python3
"""Fail-closed validation for a temporary, non-published AI Builder APT candidate."""
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

APP_ID = "com.karat.aibuilder"
SOURCE_REPO = "https://github.com/termux/termux-packages.git"
APP_DATA_RE = re.compile(r"^/data/(?:data|user/0)/com\.karat\.aibuilder$")
HEX40_RE = re.compile(r"^[0-9a-f]{40}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
BUILDER_RE = re.compile(r"^ghcr\.io/termux/package-builder@sha256:[0-9a-f]{64}$")


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
    paragraphs: list[dict[str, str]] = []
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
        paragraphs.append(fields)
    return paragraphs


def validate(args: argparse.Namespace) -> None:
    package_set = load_json(args.package_set)
    build = load_json(args.build_result)
    audit = load_json(args.audit_report)
    require(package_set.get("schemaVersion") == 1, "PACKAGE_SET_SCHEMA_UNSUPPORTED")
    require(package_set.get("channel") == "candidate-only", "CHANNEL_NOT_CANDIDATE_ONLY")

    target = package_set.get("target", {})
    require(target.get("applicationId") == APP_ID, "TARGET_APP_ID_MISMATCH")
    require(target.get("architecture") == "aarch64", "TARGET_ARCHITECTURE_MISMATCH")
    data_dir = target.get("modeledDataDir", "")
    prefix = target.get("modeledPrefix", "")
    require(bool(APP_DATA_RE.fullmatch(data_dir)), "MODELED_DATA_DIR_NOT_CANONICAL")
    require(prefix == data_dir + "/files/usr", "MODELED_PREFIX_MISMATCH")

    gate = package_set.get("releaseGate", {})
    require(gate.get("publicationAllowed") is False, "PRODUCTION_PUBLICATION_MUST_REMAIN_DISABLED")
    require(gate.get("deviceInstall") == "NOT_RUN", "DEVICE_INSTALL_STATUS_MUST_REMAIN_UNPROVEN")
    require(gate.get("rollback") == "NOT_RUN", "DEVICE_ROLLBACK_STATUS_MUST_REMAIN_UNPROVEN")
    require(gate.get("deviceEvidenceSha256") is None, "DEVICE_EVIDENCE_MUST_NOT_BE_FABRICATED")

    packages = package_set.get("packages")
    require(isinstance(packages, list) and len(packages) == 1, "PACKAGE_ALLOWLIST_MUST_BE_EXACTLY_ONE")
    spec = packages[0]
    name, version, arch = spec.get("name"), spec.get("version"), spec.get("architecture")
    require((name, version, arch) == ("make", "4.4.1-1", "aarch64"), "PACKAGE_SELECTION_NOT_ALLOWLISTED")
    require(spec.get("sourceRepository") == SOURCE_REPO, "SOURCE_REPOSITORY_MISMATCH")
    require(bool(HEX40_RE.fullmatch(spec.get("sourceCommit", ""))), "SOURCE_COMMIT_NOT_PINNED")
    require(spec.get("sourceCommit") == "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7", "SOURCE_COMMIT_NOT_ALLOWLISTED")
    require(spec.get("recipePath") == "packages/make/build.sh", "RECIPE_PATH_NOT_ALLOWLISTED")
    require(spec.get("recipePatchPath") == "packages/make/src-job.c.patch", "RECIPE_PATCH_PATH_NOT_ALLOWLISTED")
    require(spec.get("localRecipePatchPath") == "termux-private-package-kit/make-v476/patches/make-embed-gpl-license.patch",
            "LOCAL_RECIPE_PATCH_PATH_NOT_ALLOWLISTED")
    require(spec.get("sourceLicenseFile") == "COPYING", "SOURCE_LICENSE_FILE_NOT_ALLOWLISTED")
    require(spec.get("sourceLicenseRelativePath") == "share/doc/make/COPYING", "SOURCE_LICENSE_PATH_NOT_ALLOWLISTED")
    exact_hashes = {
        "recipeSha256": "8a55794717f4ea018324b1bbb8f2dfd549dd054152798c913a40d49f4baf432c",
        "recipePatchSha256": "87ef62d072c2def6e0778e71283fb32d7bc4f00dadadd52eca822bf444a4dc10",
        "localRecipePatchSha256": "cdcc66d147f1ca60e3e271a067ca42d91d17aec273c239a308d1e176f66b8b03",
        "sourceSha256": "dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3",
        "sourceLicenseSha256": "e79e9c8a0c85d735ff98185918ec94ed7d175efc377012787aebcf3b80f0d90b",
    }
    for key, expected in exact_hashes.items():
        require(bool(HEX64_RE.fullmatch(spec.get(key, ""))), "SOURCE_HASH_NOT_PINNED_" + key.upper())
        require(spec.get(key) == expected, "SOURCE_HASH_NOT_ALLOWLISTED_" + key.upper())
    require(spec.get("sourceUrl") == "https://mirrors.kernel.org/gnu/make/make-4.4.1.tar.gz", "SOURCE_URL_NOT_ALLOWLISTED")
    require(spec.get("builderImage") == "ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9", "BUILDER_IMAGE_NOT_ALLOWLISTED")
    require(bool(BUILDER_RE.fullmatch(spec.get("builderImage", ""))), "BUILDER_IMAGE_NOT_DIGEST_PINNED")
    require(spec.get("staticAuditRequired") is True, "STATIC_AUDIT_MUST_BE_REQUIRED")
    require(spec.get("deviceInstallAndRollbackRequired") is True, "DEVICE_INSTALL_AND_ROLLBACK_MUST_BE_REQUIRED")

    require(build.get("status") == "audit-passed; device-runtime-test-not-run", "BUILD_STATUS_NOT_STATIC_AUDIT_PASS")
    require(build.get("applicationId") == APP_ID, "BUILD_APP_ID_MISMATCH")
    require(build.get("prefix") == prefix, "BUILD_PREFIX_MISMATCH")
    require(build.get("prefixProvenance") == "ci-model-only; device-observation-not-run",
            "BUILD_PREFIX_PROVENANCE_NOT_MODEL_ONLY")
    require(build.get("sourceCommit") == spec["sourceCommit"], "BUILD_SOURCE_COMMIT_MISMATCH")
    require(build.get("builderImageRef") == spec["builderImage"], "BUILD_IMAGE_MISMATCH")
    require(build.get("candidateRecipePatchSha256") == spec["localRecipePatchSha256"], "BUILD_LOCAL_RECIPE_PATCH_SHA_MISMATCH")
    require(build.get("sourceLicenseSha256") == spec["sourceLicenseSha256"], "BUILD_SOURCE_LICENSE_SHA_MISMATCH")
    require(build.get("installed") is False, "BUILD_MUST_NOT_INSTALL_PACKAGE")
    require(build.get("deviceSmokeTest") == "NOT RUN", "DEVICE_SMOKE_MUST_REMAIN_UNRUN")
    require(bool(HEX64_RE.fullmatch(build.get("packageSha256", ""))), "BUILD_PACKAGE_HASH_MISSING")
    require(audit.get("ok") is True, "STATIC_AUDIT_REPORT_NOT_PASS")
    require(audit.get("status") == "static-audit-passed; installation-and-device-runtime-unverified", "STATIC_AUDIT_STATUS_UNEXPECTED")
    require(audit.get("package", {}).get("name") == name, "AUDIT_PACKAGE_NAME_MISMATCH")
    require(audit.get("package", {}).get("version") == version, "AUDIT_PACKAGE_VERSION_MISMATCH")
    require(audit.get("package", {}).get("architecture") == arch, "AUDIT_PACKAGE_ARCHITECTURE_MISMATCH")
    require(audit.get("package", {}).get("licenseEvidencePath") == spec["sourceLicenseRelativePath"], "AUDIT_LICENSE_PATH_MISMATCH")
    require(audit.get("package", {}).get("licenseEvidenceSha256") == spec["sourceLicenseSha256"], "AUDIT_LICENSE_SHA_MISMATCH")
    require(audit.get("target", {}).get("applicationId") == APP_ID, "AUDIT_APP_ID_MISMATCH")
    require(audit.get("target", {}).get("prefix") == prefix, "AUDIT_PREFIX_MISMATCH")

    root = args.feed_root.resolve(strict=True)
    pool = root / "pool"
    require(pool.is_dir() and not pool.is_symlink(), "POOL_ROOT_INVALID")
    debs = sorted(pool.rglob("*.deb"))
    require(len(debs) == 1, "POOL_PACKAGE_SET_MISMATCH")
    deb = debs[0]
    require(not deb.is_symlink() and deb.is_file(), "PACKAGE_FILE_NOT_REGULAR")
    require(root in deb.resolve(strict=True).parents, "PACKAGE_FILE_ESCAPES_FEED_ROOT")
    require(deb.relative_to(root).as_posix().startswith("pool/main/make/"), "PACKAGE_FILE_OUTSIDE_ALLOWLISTED_PATH")
    require(deb.name == build.get("packageFile"), "BUILD_PACKAGE_FILENAME_MISMATCH")
    digest = hashlib.sha256(deb.read_bytes()).hexdigest()
    require(digest == build["packageSha256"], "BUILD_PACKAGE_SHA256_MISMATCH")
    require(digest == audit.get("sha256"), "AUDIT_PACKAGE_SHA256_MISMATCH")

    control = subprocess.run(
        ["dpkg-deb", "-f", str(deb), "Package", "Version", "Architecture"],
        check=False, capture_output=True, text=True, timeout=30,
    )
    require(control.returncode == 0, "DPKG_CONTROL_READ_FAILED")
    control_fields = {}
    for line in control.stdout.splitlines():
        key, sep, value = line.partition(":")
        require(bool(sep) and key not in control_fields, "DEB_CONTROL_MALFORMED")
        control_fields[key] = value.strip()
    require(control_fields == {"Package": name, "Version": version, "Architecture": arch}, "DEB_CONTROL_NOT_ALLOWLISTED")

    index = root / "dists/stable/main/binary-aarch64/Packages"
    compressed = root / "dists/stable/main/binary-aarch64/Packages.gz"
    require(index.is_file() and not index.is_symlink(), "PACKAGES_INDEX_MISSING")
    require(compressed.is_file() and not compressed.is_symlink(), "PACKAGES_GZ_MISSING")
    require(gzip.decompress(compressed.read_bytes()) == index.read_bytes(), "PACKAGES_GZIP_CONTENT_MISMATCH")
    records = parse_index(index)
    require(len(records) == 1, "INDEX_PACKAGE_SET_MISMATCH")
    record = records[0]
    require(record.get("Package") == name and record.get("Version") == version, "INDEX_PACKAGE_ID_MISMATCH")
    require(record.get("Architecture") == arch, "INDEX_ARCHITECTURE_MISMATCH")
    rel = pathlib.PurePosixPath(record.get("Filename", ""))
    require(not rel.is_absolute() and ".." not in rel.parts and rel.as_posix() == deb.relative_to(root).as_posix(), "INDEX_FILENAME_MISMATCH")
    require(record.get("Size") == str(deb.stat().st_size), "INDEX_PACKAGE_SIZE_MISMATCH")
    require(record.get("SHA256") == digest, "INDEX_PACKAGE_SHA256_MISMATCH")
    print("CANDIDATE_FEED_POLICY_OK packages=1 source=locked static_audit=pass signed_feed=separately_verified production_release=blocked device_install=NOT_RUN rollback=NOT_RUN")


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
    except (GateError, OSError, ValueError, KeyError, subprocess.SubprocessError, gzip.BadGzipFile) as exc:
        code = str(exc) if isinstance(exc, GateError) else "VALIDATION_INPUT_INVALID"
        print(f"CANDIDATE_FEED_REJECTED:{code}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
