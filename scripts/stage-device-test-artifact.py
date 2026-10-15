#!/usr/bin/env python3
"""Stage the exact, non-production device-test artifact from a verified candidate feed."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
from typing import Any

APP_ID = "com.karat.aibuilder"
MODELED_PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"
PACKAGE_ID = ("make", "4.4.1-1", "aarch64")
PUBLIC_KEYRING_REL = "keys/aibuilder-termux-feed-keyring.gpg"


class StageError(Exception):
    pass


def require(ok: bool, code: str) -> None:
    if not ok:
        raise StageError(code)


def load_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StageError("JSON_INPUT_INVALID") from exc
    require(isinstance(value, dict), "JSON_ROOT_MUST_BE_OBJECT")
    return value


def regular_file(path: pathlib.Path, root: pathlib.Path | None = None) -> pathlib.Path:
    require(not path.is_symlink(), "SYMLINK_INPUT_REJECTED")
    require(path.is_file(), "REGULAR_FILE_REQUIRED")
    resolved = path.resolve(strict=True)
    if root is not None:
        base = root.resolve(strict=True)
        require(base in resolved.parents, "INPUT_ESCAPES_ROOT")
        rel = path.relative_to(root)
        parent = root
        for part in rel.parts[:-1]:
            parent = parent / part
            require(not parent.is_symlink() and parent.is_dir(), "SYMLINK_DIRECTORY_REJECTED")
    return resolved


def parse_index(data: bytes) -> list[dict[str, str]]:
    try:
        text = data.decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise StageError("PACKAGES_INDEX_NOT_UTF8") from exc
    records: list[dict[str, str]] = []
    for paragraph in text.strip().split("\n\n") if text.strip() else []:
        fields: dict[str, str] = {}
        previous: str | None = None
        for line in paragraph.splitlines():
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


def verify_signatures(keyring: pathlib.Path, dist: pathlib.Path) -> None:
    for args in (("gpgv", "--keyring", str(keyring), str(dist / "Release.gpg"), str(dist / "Release")),
                 ("gpgv", "--keyring", str(keyring), str(dist / "InRelease"))):
        result = subprocess.run(args, capture_output=True, text=True, timeout=30, check=False)
        require(result.returncode == 0, "SIGNED_RELEASE_VERIFICATION_FAILED")


def primary_fingerprints(keyring: pathlib.Path) -> list[str]:
    result = subprocess.run(
        ["gpg", "--batch", "--show-keys", "--with-colons", str(keyring)],
        capture_output=True, text=True, timeout=30, check=False,
    )
    require(result.returncode == 0, "PUBLIC_KEYRING_UNREADABLE")
    fingerprints: list[str] = []
    awaiting_primary_fingerprint = False
    for line in result.stdout.splitlines():
        kind = line.partition(":")[0]
        if kind == "pub":
            awaiting_primary_fingerprint = True
        elif kind == "fpr" and awaiting_primary_fingerprint:
            fields = line.split(":")
            fingerprints.append(fields[9] if len(fields) > 9 else "")
            awaiting_primary_fingerprint = False
    return fingerprints


def stage(args: argparse.Namespace) -> tuple[str, str, list[str]]:
    feed = args.feed_root.resolve(strict=True)
    key_root = args.key_root.resolve(strict=True)
    package_set_path = regular_file(args.package_set)
    build_path = regular_file(args.build_result)
    audit_path = regular_file(args.audit_report)

    package_set = load_json(package_set_path)
    build = load_json(build_path)
    audit = load_json(audit_path)
    require(package_set.get("schemaVersion") == 1 and package_set.get("channel") == "candidate-only",
            "PACKAGE_SET_NOT_CANDIDATE_ONLY")
    target = package_set.get("target", {})
    require(target.get("applicationId") == APP_ID and target.get("modeledPrefix") == MODELED_PREFIX,
            "PACKAGE_SET_TARGET_MISMATCH")
    gate = package_set.get("releaseGate", {})
    require(gate.get("publicationAllowed") is False and gate.get("deviceInstall") == "NOT_RUN"
            and gate.get("rollback") == "NOT_RUN" and gate.get("deviceEvidenceSha256") is None,
            "PRODUCTION_OR_DEVICE_GATE_UNEXPECTED")
    specs = package_set.get("packages")
    require(isinstance(specs, list) and len(specs) == 1, "PACKAGE_ALLOWLIST_NOT_EXACT")
    spec = specs[0]
    require((spec.get("name"), spec.get("version"), spec.get("architecture")) == PACKAGE_ID,
            "PACKAGE_ID_NOT_ALLOWLISTED")

    require(build.get("status") == "audit-passed; device-runtime-test-not-run"
            and build.get("applicationId") == APP_ID
            and build.get("prefix") == MODELED_PREFIX
            and build.get("prefixProvenance") == "ci-model-only; device-observation-not-run"
            and build.get("installed") is False
            and build.get("deviceSmokeTest") == "NOT RUN",
            "BUILD_RESULT_NOT_CANDIDATE_ONLY")
    require(audit.get("ok") is True
            and audit.get("status") == "static-audit-passed; installation-and-device-runtime-unverified",
            "STATIC_AUDIT_REPORT_NOT_PASS")
    require((audit.get("package", {}).get("name"), audit.get("package", {}).get("version"),
             audit.get("package", {}).get("architecture")) == PACKAGE_ID,
            "AUDIT_PACKAGE_ID_MISMATCH")
    require(audit.get("target", {}).get("applicationId") == APP_ID
            and audit.get("target", {}).get("prefix") == MODELED_PREFIX,
            "AUDIT_TARGET_MISMATCH")

    debs = list(feed.rglob("*.deb"))
    require(len(debs) == 1, "FEED_MUST_CONTAIN_EXACTLY_ONE_DEB")
    deb = regular_file(debs[0], feed)
    require(deb.name == "make_4.4.1-1_aarch64.deb" and build.get("packageFile") == deb.name,
            "PACKAGE_FILENAME_MISMATCH")
    package_sha = hashlib.sha256(deb.read_bytes()).hexdigest()
    require(re.fullmatch(r"[a-f0-9]{64}", package_sha) is not None
            and build.get("packageSha256") == package_sha
            and audit.get("sha256") == package_sha,
            "PACKAGE_SHA256_MISMATCH")

    key_manifest_path = key_root / "keys" / "feed-signing.json"
    keyring_path = key_root / pathlib.PurePosixPath(PUBLIC_KEYRING_REL)
    regular_file(key_manifest_path, key_root)
    regular_file(keyring_path, key_root)
    key_manifest = load_json(key_manifest_path)
    expected_fpr = key_manifest.get("fingerprint", "")
    expected_key_hash = key_manifest.get("publicKeyringSha256", "")
    require(key_manifest.get("publicKeyring") == PUBLIC_KEYRING_REL
            and re.fullmatch(r"[A-F0-9]{40}", expected_fpr) is not None
            and re.fullmatch(r"[a-f0-9]{64}", expected_key_hash) is not None,
            "PUBLIC_KEY_MANIFEST_INVALID")
    key_sha = hashlib.sha256(keyring_path.read_bytes()).hexdigest()
    require(key_sha == expected_key_hash and primary_fingerprints(keyring_path) == [expected_fpr],
            "PUBLIC_KEYRING_PIN_MISMATCH")

    dist = feed / "dists" / "stable"
    metadata = {
        "feed/Release": feed / "Release",
        "feed/dists/stable/Release": dist / "Release",
        "feed/dists/stable/InRelease": dist / "InRelease",
        "feed/dists/stable/Release.gpg": dist / "Release.gpg",
        "feed/dists/stable/main/binary-aarch64/Packages": dist / "main" / "binary-aarch64" / "Packages",
        "feed/dists/stable/main/binary-aarch64/Packages.gz": dist / "main" / "binary-aarch64" / "Packages.gz",
    }
    for source in metadata.values():
        regular_file(source, feed)
    packages_path = metadata["feed/dists/stable/main/binary-aarch64/Packages"]
    packages_gz_path = metadata["feed/dists/stable/main/binary-aarch64/Packages.gz"]
    require(gzip.decompress(packages_gz_path.read_bytes()) == packages_path.read_bytes(),
            "PACKAGES_GZIP_MISMATCH")
    records = parse_index(packages_path.read_bytes())
    require(len(records) == 1, "PACKAGES_INDEX_NOT_EXACT")
    record = records[0]
    relative_deb = deb.relative_to(feed).as_posix()
    require(record.get("Package") == PACKAGE_ID[0]
            and record.get("Version") == PACKAGE_ID[1]
            and record.get("Architecture") == PACKAGE_ID[2]
            and record.get("Filename") == relative_deb
            and record.get("Size") == str(deb.stat().st_size)
            and record.get("SHA256") == package_sha,
            "PACKAGES_INDEX_PACKAGE_MISMATCH")
    verify_signatures(keyring_path, dist)

    files: dict[str, pathlib.Path] = {
        **metadata,
        f"feed/{relative_deb}": deb,
        "keys/aibuilder-termux-feed-keyring.gpg": keyring_path,
        "keys/feed-signing.json": key_manifest_path,
        "provenance/candidate-package-set.json": package_set_path,
        "provenance/build-result.json": build_path,
        "provenance/audit-report.json": audit_path,
    }
    destination = pathlib.Path(args.destination)
    require(not destination.is_symlink(), "ARTIFACT_DESTINATION_SYMLINK")
    if destination.exists():
        require(destination.is_dir() and not any(destination.iterdir()), "ARTIFACT_DESTINATION_NOT_EMPTY")
    else:
        destination.mkdir(parents=True)

    for rel, source in files.items():
        target_path = destination / rel
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target_path)
        os.chmod(target_path, 0o644)
    actual = sorted(p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file())
    expected = sorted(files)
    require(actual == expected, "ARTIFACT_FILE_ALLOWLIST_MISMATCH")
    require(not any("private" in pathlib.PurePosixPath(name).name.lower()
                    or "secret" in pathlib.PurePosixPath(name).name.lower() for name in actual),
            "PRIVATE_MATERIAL_FILENAME_REJECTED")
    return package_sha, expected_fpr, actual


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-set", type=pathlib.Path, required=True)
    parser.add_argument("--feed-root", type=pathlib.Path, required=True)
    parser.add_argument("--build-result", type=pathlib.Path, required=True)
    parser.add_argument("--audit-report", type=pathlib.Path, required=True)
    parser.add_argument("--key-root", type=pathlib.Path, required=True)
    parser.add_argument("--destination", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        package_sha, fingerprint, files = stage(args)
    except (StageError, OSError, KeyError, ValueError, subprocess.SubprocessError, gzip.BadGzipFile) as exc:
        code = str(exc) if isinstance(exc, StageError) else "ARTIFACT_INPUT_INVALID"
        print(f"DEVICE_TEST_ARTIFACT_REJECTED:{code}", file=sys.stderr)
        return 2
    print(f"DEVICE_TEST_ARTIFACT_STAGED files={len(files)} package_sha256={package_sha} key_fingerprint={fingerprint} private_key_included=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
