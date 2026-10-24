#!/usr/bin/env python3
"""Prove a temporary Gradle feed is exactly the verified 82-package base plus one .deb."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from typing import Any


def need(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError(message)


def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def safe_rel(name: str) -> PurePosixPath:
    need(name and "\\" not in name, "UNSAFE_PATH_EMPTY_OR_BACKSLASH")
    path = PurePosixPath(name)
    need(not path.is_absolute() and all(part not in ("", ".", "..") for part in path.parts),
         "UNSAFE_RELATIVE_PATH:" + name)
    need(path.as_posix() == name, "NONCANONICAL_RELATIVE_PATH:" + name)
    return path


def parse_fields(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    current: str | None = None
    for line in text.splitlines():
        if line[:1] in (" ", "\t"):
            need(current is not None, "APT_INDEX_ORPHAN_CONTINUATION")
            result[current] += "\n" + line
            continue
        key, sep, value = line.partition(":")
        need(bool(sep) and key not in result, "APT_INDEX_MALFORMED_OR_DUPLICATE_FIELD")
        result[key] = value.strip()
        current = key
    return result


def identity(deb: Path) -> tuple[str, str, str]:
    values = subprocess.run(["dpkg-deb", "-f", str(deb), "Package", "Version", "Architecture"],
                            check=True, capture_output=True, text=True).stdout.splitlines()
    parsed = {}
    for line in values:
        key, sep, value = line.partition(": ")
        need(bool(sep) and key not in parsed, "DEB_IDENTITY_FIELDS_INVALID:" + deb.name)
        parsed[key] = value
    need(set(parsed) == {"Package", "Version", "Architecture"}, "DEB_IDENTITY_FIELDS_MISSING:" + deb.name)
    return parsed["Package"], parsed["Version"], parsed["Architecture"]


def deb_files(root: Path) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for path in sorted(root.rglob("*.deb")):
        need(path.is_file() and not path.is_symlink(), "FEED_DEB_NOT_REGULAR:" + str(path))
        rel = path.relative_to(root).as_posix()
        safe_rel(rel)
        need(rel.startswith("pool/"), "DEB_OUTSIDE_POOL:" + rel)
        result[rel] = path
    return result


def index_records(index: Path, feed_root: Path) -> dict[tuple[str, str, str], dict[str, str]]:
    text = index.read_text(encoding="utf-8", errors="strict").strip()
    need(bool(text), "APT_INDEX_EMPTY")
    records: dict[tuple[str, str, str], dict[str, str]] = {}
    for paragraph in text.split("\n\n"):
        fields = parse_fields(paragraph)
        required = ("Package", "Version", "Architecture", "Filename", "Size", "SHA256")
        need(all(fields.get(name) for name in required), "APT_INDEX_REQUIRED_FIELD_MISSING")
        key = (fields["Package"], fields["Version"], fields["Architecture"])
        need(key not in records, "APT_INDEX_DUPLICATE_IDENTITY:" + repr(key))
        rel = safe_rel(fields["Filename"])
        need(rel.parts and rel.parts[0] == "pool", "APT_INDEX_FILENAME_NOT_IN_POOL:" + fields["Filename"])
        path = feed_root.joinpath(*rel.parts)
        need(path.is_file() and not path.is_symlink(), "APT_INDEX_PACKAGE_NOT_REGULAR:" + fields["Filename"])
        need(fields["Size"].isdigit() and int(fields["Size"]) == path.stat().st_size,
             "APT_INDEX_PACKAGE_SIZE_MISMATCH:" + fields["Package"])
        need(re.fullmatch(r"[a-f0-9]{64}", fields["SHA256"]) is not None
             and sha_file(path) == fields["SHA256"], "APT_INDEX_PACKAGE_HASH_MISMATCH:" + fields["Package"])
        need(identity(path) == key, "APT_INDEX_DEB_IDENTITY_MISMATCH:" + fields["Package"])
        fields["_relativePath"] = rel.as_posix()
        records[key] = fields
    return records


def verify(lock: dict[str, Any], base_report: dict[str, Any], build: dict[str, Any], audit: dict[str, Any],
           assembly: dict[str, Any], base_feed: Path, feed: Path, signing_root: Path,
           production_key_manifest: Path) -> dict[str, Any]:
    need(base_report.get("valid") is True and base_report.get("packageCount") == 82
         and base_report.get("originalSignedReleaseVerified") is True
         and base_report.get("originalManifestSignatureVerified") is True
         and base_report.get("qualified") is False and base_report.get("productionAllowed") is False,
         "BASE82_VERIFICATION_REPORT_INVALID")
    need(base_report.get("aggregateRunId") == lock["base82Cohort"]["aggregateRunId"]
         and base_report.get("archiveSha256") == lock["base82Cohort"]["archiveSha256"],
         "BASE82_VERIFICATION_REPORT_LOCK_MISMATCH")
    need(build.get("status") == "package-built-and-static-audits-passed-test-only"
         and build.get("installed") is False and build.get("aptSimulation") == "NOT_RUN"
         and build.get("productionAllowed") is False,
         "GRADLE_BUILD_RESULT_NOT_TEST_ONLY_PASS")
    need(audit.get("result") == "GRADLE_AARCH64_DEB_STATIC_AUDIT_PASS_TEST_ONLY"
         and audit.get("installed") is False and audit.get("productionAllowed") is False,
         "GRADLE_PACKAGE_STATIC_AUDIT_NOT_PASS")
    need(assembly.get("result") == "ANDROID_GRADLE_DISTRIBUTION_ASSEMBLY_PASS_TEST_CANDIDATE_ONLY"
         and assembly.get("gates", {}).get("productionAllowed") is False,
         "ANDROID_DISTRIBUTION_ASSEMBLY_REPORT_INVALID")
    need(build.get("packageSha256") == audit.get("packageSha256")
         and build.get("androidDistributionSha256") == assembly.get("distribution", {}).get("sha256"),
         "GRADLE_BUILD_AUDIT_ASSEMBLY_HASH_CHAIN_MISMATCH")
    need(base_feed.resolve() != feed.resolve(), "BASE_AND_CANDIDATE_FEEDS_MUST_BE_DISTINCT")
    need(base_feed.is_dir() and feed.is_dir(), "BASE_OR_CANDIDATE_FEED_DIRECTORY_MISSING")

    base_manifest = json.loads((base_feed / "aggregate-manifest.json").read_text(encoding="utf-8"))
    rows = base_manifest.get("packages")
    need(isinstance(rows, list) and len(rows) == 82, "BASE82_EMBEDDED_MANIFEST_COUNT_MISMATCH")
    need(base_manifest.get("qualified") is False and base_manifest.get("productionAllowed") is False,
         "BASE82_EMBEDDED_MANIFEST_GATES_OPEN")
    base_identity: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in rows:
        key = (str(row["name"]), str(row["version"]), str(row["architecture"]))
        need(key not in base_identity and key[2] in ("aarch64", "all"), "BASE82_DUPLICATE_OR_BAD_IDENTITY")
        need(re.fullmatch(r"[a-f0-9]{64}", str(row.get("sha256", ""))) is not None,
             "BASE82_MANIFEST_PACKAGE_HASH_INVALID")
        base_identity[key] = row
    base_pool = deb_files(base_feed)
    need(len(base_pool) == 82, "BASE82_POOL_COUNT_MISMATCH")
    base_by_identity: dict[tuple[str, str, str], tuple[str, str]] = {}
    for rel, path in base_pool.items():
        key = identity(path)
        need(key not in base_by_identity, "BASE82_POOL_DUPLICATE_IDENTITY:" + repr(key))
        digest = sha_file(path)
        base_by_identity[key] = (rel, digest)
        row = base_identity.get(key)
        need(row is not None and row["filename"] == path.name and row["sha256"] == digest,
             "BASE82_POOL_DIFFERS_FROM_SIGNED_MANIFEST:" + key[0])
    need(set(base_by_identity) == set(base_identity), "BASE82_POOL_IDENTITY_SET_MISMATCH")

    feed_pool = deb_files(feed)
    need(len(feed_pool) == 83, "GRADLE_CANDIDATE_FEED_POOL_COUNT_NOT_83")
    expected_candidate = (lock["package"]["name"], lock["package"]["version"], lock["package"]["architecture"])
    need(expected_candidate == ("gradle", "1:9.8.2", "aarch64"), "GRADLE_CANDIDATE_IDENTITY_LOCK_MISMATCH")
    candidate_deb_matches = [(rel, path) for rel, path in feed_pool.items() if identity(path) == expected_candidate]
    need(len(candidate_deb_matches) == 1, "GRADLE_CANDIDATE_DEB_NOT_EXACTLY_ONCE")
    candidate_rel, candidate_deb = candidate_deb_matches[0]
    need(sha_file(candidate_deb) == build.get("packageSha256") == audit.get("packageSha256"),
         "GRADLE_CANDIDATE_DEB_HASH_MISMATCH")
    need(candidate_deb.name == build.get("packageFile"), "GRADLE_CANDIDATE_DEB_FILENAME_MISMATCH")
    need(candidate_rel.startswith("pool/main/gradle/"), "GRADLE_CANDIDATE_DEB_PATH_INVALID")
    combined_pool_expected = {rel: digest for rel, digest in base_by_identity.values()}
    combined_pool_expected[candidate_rel] = sha_file(candidate_deb)
    feed_hashes = {rel: sha_file(path) for rel, path in feed_pool.items()}
    need(feed_hashes == combined_pool_expected, "CANDIDATE_FEED_POOL_NOT_EXACT_BASE82_PLUS_GRADLE")

    index = feed / "dists/stable/main/binary-aarch64/Packages"
    index_gz = feed / "dists/stable/main/binary-aarch64/Packages.gz"
    for path in (index, index_gz, feed / "dists/stable/Release", feed / "dists/stable/InRelease",
                 feed / "dists/stable/Release.gpg", feed / "Release"):
        need(path.is_file() and not path.is_symlink(), "CANDIDATE_SIGNED_FEED_FILE_MISSING:" + path.name)
    with gzip.open(index_gz, "rb") as stream:
        need(stream.read() == index.read_bytes(), "CANDIDATE_PACKAGES_GZ_CONTENT_MISMATCH")
    indexed = index_records(index, feed)
    need(len(indexed) == 83, "CANDIDATE_INDEX_RECORD_COUNT_NOT_83")
    need(set(indexed) == set(base_identity) | {expected_candidate}, "CANDIDATE_INDEX_IDENTITY_SET_MISMATCH")
    for key, (rel, digest) in base_by_identity.items():
        record = indexed[key]
        need(record["_relativePath"] == rel and record["SHA256"] == digest,
             "BASE82_PACKAGE_CHANGED_IN_CANDIDATE_INDEX:" + key[0])
    candidate_record = indexed[expected_candidate]
    need(candidate_record["_relativePath"] == candidate_rel and candidate_record["SHA256"] == sha_file(candidate_deb),
         "GRADLE_INDEX_RECORD_MISMATCH")
    need(candidate_record.get("Depends") == "openjdk-17", "GRADLE_APT_DEPENDS_MISMATCH")

    key_manifest = json.loads((signing_root / "keys/feed-signing.json").read_text(encoding="utf-8"))
    need(production_key_manifest.is_file() and not production_key_manifest.is_symlink(),
         "RESERVED_PRODUCTION_KEY_MANIFEST_MISSING_OR_UNSAFE")
    reserved_production_key = json.loads(production_key_manifest.read_text(encoding="utf-8"))
    production_fingerprint = str(reserved_production_key.get("fingerprint", ""))
    need(re.fullmatch(r"[A-F0-9]{40}", production_fingerprint) is not None
         and reserved_production_key.get("status", "").startswith("reserved-production-key;"),
         "RESERVED_PRODUCTION_KEY_MANIFEST_INVALID")
    key_rel = safe_rel(str(key_manifest.get("publicKeyring", "")))
    public_key = signing_root.joinpath(*key_rel.parts)
    need(public_key.is_file() and not public_key.is_symlink(), "EPHEMERAL_PUBLIC_KEYRING_MISSING")
    need(sha_file(public_key) == key_manifest.get("publicKeyringSha256"), "EPHEMERAL_PUBLIC_KEYRING_HASH_MISMATCH")
    need(key_manifest.get("status") == "ephemeral-only; no production feed publication",
         "CANDIDATE_FEED_SIGNER_NOT_EPHEMERAL")
    fingerprint = str(key_manifest.get("fingerprint", ""))
    need(re.fullmatch(r"[A-F0-9]{40}", fingerprint) is not None
         and fingerprint != lock["base82Cohort"]["signingFingerprint"]
         and fingerprint != production_fingerprint,
         "CANDIDATE_FEED_SIGNER_NOT_DISTINCT_FROM_BASE_OR_PRODUCTION_OR_INVALID")
    key_fprs = subprocess.run(["gpg", "--batch", "--show-keys", "--with-colons", str(public_key)],
                              check=True, capture_output=True, text=True).stdout
    actual_fprs = [line.split(":")[9] for line in key_fprs.splitlines() if line.startswith("fpr:") and len(line.split(":")) > 9]
    need(fingerprint in actual_fprs, "EPHEMERAL_PUBLIC_KEYRING_FINGERPRINT_MISMATCH")

    return {
        "schemaVersion": 1,
        "result": "GRADLE_SEPARATE_TEST_FEED_PASS_82_BASE_PACKAGES_UNCHANGED_PLUS_ONE",
        "base82ArchiveRunId": lock["base82Cohort"]["aggregateRunId"],
        "base82ArchiveSha256": lock["base82Cohort"]["archiveSha256"],
        "base82PackageCount": len(base_identity),
        "base82PackagesUnchanged": True,
        "gradlePackage": {"name": expected_candidate[0], "version": expected_candidate[1],
                          "architecture": expected_candidate[2], "sha256": sha_file(candidate_deb),
                          "filename": candidate_deb.name, "feedPath": candidate_rel,
                          "depends": candidate_record["Depends"]},
        "feedPackageCount": len(indexed),
        "feedPoolExactlyBase82PlusGradle": True,
        "feedIndexHashVerifiedAgainstPool": True,
        "indexGzipMatchesIndex": True,
        "ephemeralSigningFingerprint": fingerprint,
        "ephemeralSigningPublicKeyringSha256": sha_file(public_key),
        "reservedProductionSigningFingerprintNotUsed": True,
        "privateKeyRetained": False,
        "aptSimulation": "PENDING",
        "installPerformed": False,
        "androidDeviceRuntime": "NOT_RUN",
        "candidateEligible": False,
        "qualified": False,
        "productionAllowed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input-lock", "base-verification", "build-result", "audit-report", "assembly-report",
                 "base-feed-root", "feed-root", "signing-config-root", "report"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    try:
        lock = json.loads(args.input_lock.read_text(encoding="utf-8"))
        values = [json.loads(path.read_text(encoding="utf-8")) for path in
                  (args.base_verification, args.build_result, args.audit_report, args.assembly_report)]
        report = verify(lock, *values, args.base_feed_root, args.feed_root, args.signing_config_root,
                        args.input_lock.parent / "keys/feed-signing.json")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("GRADLE_SEPARATE_TEST_FEED_PASS packages=83 base=82+gradle=1 ephemeral=1 production=false")
        return 0
    except Exception as exc:
        failure = {"schemaVersion": 1, "result": "BLOCKED_CANDIDATE_FEED_VALIDATION_FAIL_CLOSED",
                   "error": f"{type(exc).__name__}:{exc}", "installPerformed": False,
                   "androidDeviceRuntime": "NOT_RUN", "candidateEligible": False, "productionAllowed": False}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(failure, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("ERROR:" + failure["error"], file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
