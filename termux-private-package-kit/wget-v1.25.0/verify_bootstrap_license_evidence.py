#!/usr/bin/env python3
"""Re-verify the embedded AI Builder bootstrap license provider against pinned Termux sources."""
from __future__ import annotations
import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import zipfile

PIN = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
STATUS_PATH = "var/lib/dpkg/status"
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_LICENSE_BYTES = 8 * 1024 * 1024


def require(ok: bool, code: str) -> None:
    if not ok:
        raise ValueError(code)


def parse_status(text: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    previous: str | None = None
    for line in text.splitlines() + [""]:
        if not line:
            if current:
                records.append(current)
                current = {}
                previous = None
            continue
        if line[:1] in (" ", "\t"):
            require(previous is not None, "DPKG_STATUS_ORPHAN_CONTINUATION")
            current[previous] += " " + line.strip()
            continue
        key, sep, value = line.partition(":")
        require(bool(sep) and key not in current, "DPKG_STATUS_FIELD_INVALID")
        current[key] = value.strip()
        previous = key
    return records


def verify(archive: pathlib.Path, source_root: pathlib.Path, manifest_path: pathlib.Path) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    evidence = manifest.get("baseLicenseProviderEvidence")
    require(isinstance(evidence, dict), "BOOTSTRAP_EVIDENCE_MISSING")
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size <= MAX_ARCHIVE_BYTES, "BOOTSTRAP_ARCHIVE_INVALID")
    actual_archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    require(actual_archive_sha == evidence.get("archiveSha256"), "BOOTSTRAP_ARCHIVE_SHA256_MISMATCH")
    revision = subprocess.run(["git", "-C", str(source_root), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    require(revision == PIN and manifest.get("source", {}).get("commit") == PIN, "PINNED_SOURCE_COMMIT_MISMATCH")
    status = ""
    with zipfile.ZipFile(archive) as zf:
        names = set(zf.namelist())
        require(STATUS_PATH in names, "BOOTSTRAP_DPKG_STATUS_MISSING")
        status = zf.read(STATUS_PATH).decode("utf-8", "strict")
        entries = [item for item in parse_status(status) if item.get("Package") == evidence.get("packageName")]
        require(len(entries) == 1, "LICENSE_PROVIDER_PACKAGE_RECORD_COUNT")
        entry = entries[0]
        require(entry.get("Version") == evidence.get("version") and entry.get("Architecture") == evidence.get("architecture") and entry.get("Status") == evidence.get("packageStatus"), "LICENSE_PROVIDER_PACKAGE_RECORD_MISMATCH")
        declared = evidence.get("licenseFilesSha256")
        require(isinstance(declared, dict) and declared, "LICENSE_PROVIDER_FILE_LOCKS_MISSING")
        for relative, expected in declared.items():
            require(relative.startswith("share/LICENSES/") and len(expected) == 64, "LICENSE_PROVIDER_PATH_OR_HASH_INVALID")
            require(relative in names, "BOOTSTRAP_LICENSE_FILE_MISSING:" + relative)
            info = zf.getinfo(relative)
            require(not info.is_dir() and info.file_size <= MAX_LICENSE_BYTES, "BOOTSTRAP_LICENSE_FILE_INVALID:" + relative)
            payload = zf.read(relative)
            actual = hashlib.sha256(payload).hexdigest()
            require(actual == expected, "BOOTSTRAP_LICENSE_FILE_SHA256_MISMATCH:" + relative)
            source_file = source_root / "packages/termux-licenses/LICENSES" / pathlib.Path(relative).name
            require(source_file.is_file() and not source_file.is_symlink(), "PINNED_SOURCE_LICENSE_MISSING:" + relative)
            source_sha = hashlib.sha256(source_file.read_bytes()).hexdigest()
            require(source_sha == expected, "BOOTSTRAP_VS_PINNED_SOURCE_LICENSE_MISMATCH:" + relative)
    print("BOOTSTRAP_LICENSE_PROVIDER_EVIDENCE_OK package=termux-licenses@{} arch={} files={} archive_sha256={} device_observed=NOT_RUN".format(evidence["version"], evidence["architecture"], len(evidence["licenseFilesSha256"]), actual_archive_sha))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=pathlib.Path, required=True)
    parser.add_argument("--source-root", type=pathlib.Path, required=True)
    parser.add_argument("--package-set", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        verify(args.archive.expanduser().absolute(), args.source_root.resolve(), args.package_set.resolve())
        return 0
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError, zipfile.BadZipFile) as exc:
        print("BOOTSTRAP_LICENSE_EVIDENCE_REJECTED:" + (str(exc) if isinstance(exc, ValueError) else "INPUT_INVALID"), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
