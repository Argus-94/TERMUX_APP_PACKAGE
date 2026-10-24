#!/usr/bin/env python3
"""Verify and safely extract the pinned, signed 82-package base cohort for a separate test feed."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
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


def load_json(path: Path) -> dict[str, Any]:
    need(path.is_file() and not path.is_symlink(), "JSON_INPUT_NOT_REGULAR:" + path.name)
    value = json.loads(path.read_text(encoding="utf-8"))
    need(isinstance(value, dict), "JSON_ROOT_NOT_OBJECT:" + path.name)
    return value


def safe_relative(name: str) -> PurePosixPath:
    need(name and "\\" not in name, "ARCHIVE_PATH_EMPTY_OR_BACKSLASH")
    path = PurePosixPath(name)
    need(not path.is_absolute() and all(part not in ("", ".", "..") for part in path.parts),
         "ARCHIVE_PATH_UNSAFE:" + name)
    need(path.as_posix() == name, "ARCHIVE_PATH_NONCANONICAL:" + name)
    return path


def run_gpgv(argv: list[str], fingerprint: str, code: str) -> str:
    result = subprocess.run(argv, check=False, capture_output=True, text=True, timeout=60)
    need(result.returncode == 0, code + ":" + result.stderr[-1200:])
    need("VALIDSIG " + fingerprint + " " in result.stdout, code + "_FINGERPRINT_MISMATCH")
    return result.stdout


def parse_deb_control(path: Path) -> dict[str, str]:
    fields: dict[str, str] = {}
    current: str | None = None
    for line in path.read_text(encoding="utf-8", errors="strict").splitlines():
        if line[:1] in (" ", "\t"):
            need(current is not None, "DEB_INDEX_ORPHAN_CONTINUATION")
            fields[current] += "\n" + line
            continue
        key, sep, value = line.partition(":")
        need(bool(sep) and key not in fields, "DEB_INDEX_MALFORMED_OR_DUPLICATE_FIELD")
        fields[key] = value.strip()
        current = key
    return fields


def verify_feed(feed: Path, expected: dict[str, Any], cohort_lock: dict[str, Any], outdir: Path) -> dict[str, Any]:
    manifest_path = feed / "aggregate-manifest.json"
    key_manifest_path = feed / "keys/feed-signing.json"
    manifest = load_json(manifest_path)
    signing = load_json(key_manifest_path)
    key_path_rel = PurePosixPath(str(signing.get("publicKeyring", "")))
    need(not key_path_rel.is_absolute() and ".." not in key_path_rel.parts,
         "BASE_KEYRING_PATH_UNSAFE")
    keyring = feed.joinpath(*key_path_rel.parts)
    need(keyring.is_file() and not keyring.is_symlink(), "BASE_KEYRING_NOT_REGULAR")
    need(sha_file(keyring) == expected["publicKeyringSha256"], "BASE_KEYRING_HASH_MISMATCH")
    fingerprint = str(signing.get("fingerprint", ""))
    need(fingerprint == expected["signingFingerprint"] and re.fullmatch(r"[A-F0-9]{40}", fingerprint),
         "BASE_SIGNER_FINGERPRINT_MISMATCH")
    need(signing.get("publicKeyringSha256") == expected["publicKeyringSha256"],
         "BASE_KEYRING_MANIFEST_HASH_MISMATCH")

    signature = feed / "aggregate-manifest.json.asc"
    need(signature.is_file() and not signature.is_symlink(), "BASE_MANIFEST_SIGNATURE_MISSING")
    run_gpgv(["gpgv", "--status-fd=1", "--keyring", str(keyring), str(signature), str(manifest_path)],
             fingerprint, "BASE_MANIFEST_SIGNATURE_INVALID")
    need(sha_file(manifest_path) == expected["embeddedManifestSha256"], "BASE_MANIFEST_HASH_MISMATCH")
    records = manifest.get("packages")
    need(isinstance(records, list) and len(records) == 82, "BASE_MANIFEST_PACKAGE_COUNT_NOT_82")
    need(manifest.get("qualified") is False and manifest.get("productionAllowed") is False,
         "BASE_MANIFEST_GATES_NOT_CLOSED")
    source_commit = manifest.get("sourceCommit") or manifest.get("buildResult", {}).get("sourceCommit")
    need(source_commit == cohort_lock["sourceCommit"], "BASE_MANIFEST_TERMUX_SOURCE_COMMIT_MISMATCH")

    replay = load_json(feed.parent / "replay-summary.json")
    need(replay.get("aggregateRunId") == str(expected["aggregateRunId"]), "BASE_AGGREGATE_RUN_ID_MISMATCH")
    need(replay.get("aggregateProducerCommit") == expected["aggregateProducerCommit"],
         "BASE_AGGREGATE_COMMIT_MISMATCH")
    need(replay.get("manifestSha256") == expected["embeddedManifestSha256"], "BASE_REPLAY_MANIFEST_MISMATCH")
    need(replay.get("packageCount") == 82 and replay.get("retainedOriginalPackages") == 80
         and replay.get("newSourceBuiltCompanions") == 2, "BASE_REPLAY_COUNTS_MISMATCH")
    need(replay.get("sourceBuildRunId") == expected["sourceBuildRunId"], "BASE_SOURCE_BUILD_RUN_MISMATCH")
    need(replay.get("sourceBuildProducerCommit") == expected["sourceBuildProducerCommit"],
         "BASE_SOURCE_BUILD_COMMIT_MISMATCH")
    need(replay.get("bootstrapSha256") == expected["bootstrapSha256"], "BASE_BOOTSTRAP_HASH_MISMATCH")
    need(replay.get("requestedRoots") == cohort_lock["requestedRoots"], "BASE_ROOTS_MISMATCH")
    need(replay.get("requestedRootCount") == 13 and replay.get("fingerprint") == fingerprint,
         "BASE_ROOT_COUNT_OR_SIGNER_MISMATCH")
    need(replay.get("valid") is True and replay.get("android") == "NOT_RUN"
         and replay.get("qualified") is False and replay.get("productionAllowed") is False,
         "BASE_REPLAY_SCOPE_OR_STATUS_MISMATCH")

    manifest_by_identity: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in records:
        need(isinstance(row, dict), "BASE_MANIFEST_RECORD_NOT_OBJECT")
        identity = (str(row.get("name", "")), str(row.get("version", "")), str(row.get("architecture", "")))
        need(all(identity) and identity[2] in ("aarch64", "all"), "BASE_MANIFEST_IDENTITY_INVALID")
        need(identity not in manifest_by_identity, "BASE_MANIFEST_DUPLICATE_IDENTITY")
        need(re.fullmatch(r"[a-f0-9]{64}", str(row.get("sha256", ""))) is not None,
             "BASE_MANIFEST_PACKAGE_SHA_INVALID")
        filename = str(row.get("filename", ""))
        need(safe_relative(filename).name == filename, "BASE_MANIFEST_FILENAME_NOT_BASENAME")
        manifest_by_identity[identity] = row
    need(len(manifest_by_identity) == 82, "BASE_MANIFEST_IDENTITIES_NOT_UNIQUE")

    release_dir = feed / "dists/stable"
    release = release_dir / "Release"
    inrelease = release_dir / "InRelease"
    detached = release_dir / "Release.gpg"
    index = feed / "dists/stable/main/binary-aarch64/Packages"
    index_gz = feed / "dists/stable/main/binary-aarch64/Packages.gz"
    for p in (release, inrelease, detached, index, index_gz):
        need(p.is_file() and not p.is_symlink(), "BASE_SIGNED_FEED_FILE_MISSING:" + p.name)
    run_gpgv(["gpgv", "--status-fd=1", "--keyring", str(keyring), str(detached), str(release)],
             fingerprint, "BASE_RELEASE_SIGNATURE_INVALID")
    verified_inrelease = outdir / "base-inrelease-verified.tmp"
    run_gpgv(["gpgv", "--status-fd=1", "--keyring", str(keyring), "--output",
              str(verified_inrelease), str(inrelease)], fingerprint, "BASE_INRELEASE_SIGNATURE_INVALID")
    need(verified_inrelease.read_bytes() == release.read_bytes(), "BASE_INRELEASE_PAYLOAD_MISMATCH")
    verified_inrelease.unlink()

    index_hash, index_size = sha_file(index), index.stat().st_size
    gz_hash, gz_size = sha_file(index_gz), index_gz.stat().st_size
    need(gz_hash and gz_size > 0, "BASE_PACKAGES_GZ_EMPTY")
    import gzip
    with gzip.open(index_gz, "rb") as stream:
        need(stream.read() == index.read_bytes(), "BASE_PACKAGES_GZ_CONTENT_MISMATCH")
    release_text = release.read_text(encoding="utf-8", errors="strict")
    need(re.search(r"(?m)^\s+" + re.escape(index_hash) + r"\s+" + str(index_size)
                   + r"\s+main/binary-aarch64/Packages$", release_text) is not None,
         "BASE_RELEASE_PACKAGES_INDEX_HASH_MISMATCH")
    need(re.search(r"(?m)^\s+" + re.escape(gz_hash) + r"\s+" + str(gz_size)
                   + r"\s+main/binary-aarch64/Packages\.gz$", release_text) is not None,
         "BASE_RELEASE_PACKAGES_GZ_HASH_MISMATCH")

    index_records: dict[tuple[str, str, str], dict[str, str]] = {}
    for paragraph in index.read_text(encoding="utf-8", errors="strict").strip().split("\n\n"):
        fields = parse_deb_control_text(paragraph)
        required = ("Package", "Version", "Architecture", "Filename", "Size", "SHA256")
        need(all(fields.get(key) for key in required), "BASE_PACKAGES_INDEX_REQUIRED_FIELD_MISSING")
        ident = (fields["Package"], fields["Version"], fields["Architecture"])
        need(ident not in index_records, "BASE_PACKAGES_INDEX_DUPLICATE_IDENTITY")
        index_records[ident] = fields
    need(set(index_records) == set(manifest_by_identity), "BASE_PACKAGES_INDEX_MANIFEST_IDENTITY_MISMATCH")

    pool = feed / "pool"
    deb_paths = [p for p in pool.rglob("*.deb") if p.is_file() and not p.is_symlink()]
    need(len(deb_paths) == 82, "BASE_POOL_DEB_COUNT_NOT_82")
    seen_filenames: set[str] = set()
    for ident, row in manifest_by_identity.items():
        rec = index_records[ident]
        filename = str(row["filename"])
        need(PurePosixPath(rec["Filename"]).name == filename,
             "BASE_INDEX_FILENAME_MISMATCH:" + ident[0])
        rel = safe_relative(rec["Filename"])
        need(rel.parts and rel.parts[0] == "pool", "BASE_INDEX_PATH_NOT_IN_POOL:" + ident[0])
        package_path = feed.joinpath(*rel.parts)
        need(package_path.is_file() and not package_path.is_symlink(), "BASE_DEB_NOT_REGULAR:" + ident[0])
        need(filename not in seen_filenames, "BASE_DUPLICATE_DEB_FILENAME")
        seen_filenames.add(filename)
        digest = sha_file(package_path)
        size = package_path.stat().st_size
        need(digest == row["sha256"] == rec["SHA256"], "BASE_DEB_SHA256_MISMATCH:" + ident[0])
        need(str(size) == rec["Size"], "BASE_DEB_SIZE_MISMATCH:" + ident[0])
        need((rec["Package"], rec["Version"], rec["Architecture"]) == ident,
             "BASE_INDEX_IDENTITY_MISMATCH:" + ident[0])
    indexed_files = {str((feed / safe_relative(row["Filename"])).resolve())
                     for row in index_records.values()}
    actual_files = {str(p.resolve()) for p in deb_paths}
    need(indexed_files == actual_files, "BASE_POOL_INDEX_FILE_SET_MISMATCH")

    roots = {str(item["name"]): str(item["version"]) for item in cohort_lock["newCompanions"]}
    actual_new = {name: version for (name, version, _arch) in manifest_by_identity
                  if name in roots}
    need(actual_new == roots, "BASE_NEW_COMPANION_IDENTITIES_MISMATCH")
    for root_spec in cohort_lock["requestedRoots"]:
        name, version = root_spec.split("=", 1)
        matches = [identity for identity in manifest_by_identity
                   if identity[0] == name and identity[1] == version]
        need(len(matches) == 1, "BASE_REQUESTED_ROOT_NOT_EXACTLY_ONCE:" + name)

    return {
        "valid": True,
        "aggregateRunId": expected["aggregateRunId"],
        "aggregateProducerCommit": expected["aggregateProducerCommit"],
        "archiveSha256": expected["archiveSha256"],
        "archiveInventorySha256": expected["inventorySha256"],
        "manifestSha256": sha_file(manifest_path),
        "packageCount": len(manifest_by_identity),
        "retainedBaseCount": 80,
        "newSourceBuiltCompanionCount": 2,
        "requestedRoots": cohort_lock["requestedRoots"],
        "signingFingerprint": fingerprint,
        "publicKeyringSha256": sha_file(keyring),
        "originalSignedReleaseVerified": True,
        "originalManifestSignatureVerified": True,
        "qualified": False,
        "productionAllowed": False,
        "android": "NOT_RUN",
    }


def parse_deb_control_text(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    current: str | None = None
    for line in text.splitlines():
        if line[:1] in (" ", "\t"):
            need(current is not None, "DEB_INDEX_ORPHAN_CONTINUATION")
            fields[current] += "\n" + line
            continue
        key, sep, value = line.partition(":")
        need(bool(sep) and key not in fields, "DEB_INDEX_MALFORMED_OR_DUPLICATE_FIELD")
        fields[key] = value.strip()
        current = key
    return fields


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--input-lock", type=Path, required=True)
    parser.add_argument("--cohort-lock", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report: dict[str, Any] = {"valid": False, "qualified": False, "productionAllowed": False, "android": "NOT_RUN"}
    try:
        lock = load_json(args.input_lock)
        cohort = load_json(args.cohort_lock)
        expected = lock["base82Cohort"]
        need(args.archive.is_file() and not args.archive.is_symlink(), "BASE_ARCHIVE_NOT_REGULAR")
        need(args.inventory.is_file() and not args.inventory.is_symlink(), "BASE_INVENTORY_NOT_REGULAR")
        need(args.archive.stat().st_size == expected["archiveSizeBytes"], "BASE_ARCHIVE_SIZE_MISMATCH")
        need(sha_file(args.archive) == expected["archiveSha256"], "BASE_ARCHIVE_SHA256_MISMATCH")
        need(args.inventory.stat().st_size == expected["inventorySizeBytes"], "BASE_INVENTORY_SIZE_MISMATCH")
        need(sha_file(args.inventory) == expected["inventorySha256"], "BASE_INVENTORY_SHA256_MISMATCH")
        inv = load_json(args.inventory)
        need(inv.get("archiveFile") == expected["archiveFilename"]
             and inv.get("archiveSha256") == expected["archiveSha256"], "BASE_INVENTORY_ARCHIVE_BINDING_MISMATCH")
        need(inv.get("aggregateRunId") == str(expected["aggregateRunId"]), "BASE_INVENTORY_RUN_ID_MISMATCH")
        need(inv.get("regularFileCount") == 426 and len(inv.get("files", {})) == 426,
             "BASE_INVENTORY_FILE_COUNT_MISMATCH")
        need(inv.get("qualified") is False and inv.get("productionAllowed") is False
             and inv.get("android") == "NOT_RUN", "BASE_INVENTORY_GATES_NOT_CLOSED")
        file_map = inv["files"]
        expanded_size = 0
        for name, item in file_map.items():
            safe_relative(name)
            need(isinstance(item, dict) and re.fullmatch(r"[a-f0-9]{64}", str(item.get("sha256", "")))
                 and isinstance(item.get("size"), int) and item["size"] >= 0,
                 "BASE_INVENTORY_ENTRY_INVALID:" + name)
            expanded_size += item["size"]
        need(expanded_size <= 2_000_000_000, "BASE_ARCHIVE_EXPANDED_SIZE_LIMIT")
        need(not args.destination.exists(), "BASE_DESTINATION_MUST_BE_NEW")
        args.destination.mkdir(parents=True)
        seen: set[str] = set()
        with tarfile.open(args.archive, mode="r|gz") as archive:
            for member in archive:
                name = member.name
                safe_relative(name)
                need(name not in seen, "BASE_ARCHIVE_DUPLICATE_MEMBER:" + name)
                seen.add(name)
                need(name in file_map, "BASE_ARCHIVE_UNLISTED_MEMBER:" + name)
                expected_entry = file_map[name]
                need(member.isfile() and not member.issym() and not member.islnk(),
                     "BASE_ARCHIVE_NONREGULAR_MEMBER:" + name)
                need(member.size == expected_entry["size"], "BASE_ARCHIVE_MEMBER_SIZE_MISMATCH:" + name)
                need(member.mtime == 0 and (member.mode & 0o7777) == 0o644,
                     "BASE_ARCHIVE_MEMBER_MODE_OR_TIME_MISMATCH:" + name)
                target = args.destination.joinpath(*PurePosixPath(name).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                parent = target.parent
                while parent != args.destination.parent:
                    need(not parent.is_symlink(), "BASE_EXTRACTION_PARENT_SYMLINK")
                    if parent == args.destination:
                        break
                    parent = parent.parent
                source = archive.extractfile(member)
                need(source is not None, "BASE_ARCHIVE_MEMBER_STREAM_MISSING:" + name)
                h = hashlib.sha256()
                count = 0
                with source, target.open("xb") as output:
                    while True:
                        block = source.read(1024 * 1024)
                        if not block:
                            break
                        count += len(block)
                        need(count <= member.size, "BASE_ARCHIVE_MEMBER_OVERRUN:" + name)
                        h.update(block)
                        output.write(block)
                need(count == member.size and h.hexdigest() == expected_entry["sha256"],
                     "BASE_ARCHIVE_MEMBER_HASH_MISMATCH:" + name)
                target.chmod(0o644)
        need(seen == set(file_map), "BASE_ARCHIVE_INVENTORY_MEMBER_SET_MISMATCH")
        feed = args.destination / "aggregate/candidate-feed"
        report.update(verify_feed(feed, expected, cohort, args.destination))
        report["extractedRegularFileCount"] = len(seen)
        report["extractedExpandedBytes"] = expanded_size
        report["candidateFeedPath"] = str(feed)
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}:{exc}"
        print("ERROR:" + report["error"], file=sys.stderr)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if not report.get("valid"):
        return 2
    print("BASE82_COHORT_ARCHIVE_VERIFIED packages=82 unchanged=1 qualified=false production=false android=NOT_RUN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
