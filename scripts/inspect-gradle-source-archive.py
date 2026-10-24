#!/usr/bin/env python3
"""Inspect the pinned Gradle source archive without running its wrapper.

The archive SHA-256 is fixed in this script. The inspector never extracts files,
executes gradlew, invokes the wrapper JAR, downloads a Gradle distribution,
builds packages, signs feeds, or qualifies an Android runtime.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import stat
import sys
import zipfile
from typing import Any

SOURCE_URL = "https://services.gradle.org/distributions/gradle-9.8.2-src.zip"
SOURCE_SHA256 = "96c9aba0564daa2998f578b589eba9ae1f6656e368fde85f7132e05321bab553"
SOURCE_VERSION = "9.8.2"
SOURCE_ROOT = "gradle-9.8.2/"
WRAPPER_PROPERTIES = "gradle-9.8.2/gradle/wrapper/gradle-wrapper.properties"
WRAPPER_JAR = "gradle-9.8.2/gradle/wrapper/gradle-wrapper.jar"
WRAPPER_LAUNCHER = "gradle-9.8.2/gradlew"
EXPECTED_DISTRIBUTION_URL = "https://services.gradle.org/distributions/gradle-9.8.1-bin.zip"


class InspectionError(Exception):
    """A pinned archive failed a required integrity or policy check."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise InspectionError(code)


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def unescape_java_property(value: str) -> str:
    """Decode the Java Properties escapes used in Gradle wrapper properties."""
    result: list[str] = []
    index = 0
    escapes = {"t": "\t", "n": "\n", "r": "\r", "f": "\f"}
    while index < len(value):
        char = value[index]
        if char != "\\":
            result.append(char)
            index += 1
            continue
        index += 1
        require(index < len(value), "WRAPPER_PROPERTIES_TRAILING_ESCAPE")
        escaped = value[index]
        if escaped == "u":
            code = value[index + 1:index + 5]
            require(re.fullmatch(r"[0-9a-fA-F]{4}", code) is not None,
                    "WRAPPER_PROPERTIES_INVALID_UNICODE_ESCAPE")
            result.append(chr(int(code, 16)))
            index += 5
        else:
            result.append(escapes.get(escaped, escaped))
            index += 1
    return "".join(result)


def parse_properties(text: str) -> dict[str, list[str]]:
    """Read the simple key=value entries required by this pinned archive audit."""
    parsed: dict[str, list[str]] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("#", "!")):
            continue
        match = re.match(r"([^:=\s]+)\s*[=:]\s*(.*)$", line)
        if match is None:
            continue
        key, value = match.groups()
        parsed.setdefault(key, []).append(unescape_java_property(value))
    return parsed


def inspect_archive(archive: pathlib.Path) -> dict[str, Any]:
    require(archive.is_file() and not archive.is_symlink(), "SOURCE_ARCHIVE_MISSING_OR_NOT_REGULAR")
    actual_sha = sha256_file(archive)
    require(actual_sha == SOURCE_SHA256, "GRADLE_SOURCE_ARCHIVE_SHA256_MISMATCH")

    try:
        with zipfile.ZipFile(archive, "r") as zf:
            entries = zf.infolist()
            names = [entry.filename for entry in entries]
            require(len(names) == len(set(names)), "GRADLE_SOURCE_ARCHIVE_DUPLICATE_ENTRIES")
            require(bool(names), "GRADLE_SOURCE_ARCHIVE_EMPTY")
            for name in names:
                pure = pathlib.PurePosixPath(name)
                require(not pure.is_absolute() and ".." not in pure.parts
                        and "\\" not in name,
                        "GRADLE_SOURCE_ARCHIVE_UNSAFE_MEMBER_PATH")
                require(name.startswith(SOURCE_ROOT), "GRADLE_SOURCE_ARCHIVE_UNEXPECTED_ROOT")
            required = {
                WRAPPER_PROPERTIES,
                WRAPPER_JAR,
                WRAPPER_LAUNCHER,
                "gradle-9.8.2/build.gradle.kts",
                "gradle-9.8.2/gradle/verification-metadata.xml",
            }
            require(required.issubset(set(names)), "GRADLE_SOURCE_ARCHIVE_REQUIRED_FILE_MISSING")
            bad_member = zf.testzip()
            require(bad_member is None, "GRADLE_SOURCE_ARCHIVE_CRC_FAILURE")
            props_bytes = zf.read(WRAPPER_PROPERTIES)
            jar_bytes = zf.read(WRAPPER_JAR)
            launcher_bytes = zf.read(WRAPPER_LAUNCHER)
            properties_text = props_bytes.decode("utf-8")
            properties = parse_properties(properties_text)
            urls = properties.get("distributionUrl", [])
            require(len(urls) == 1, "GRADLE_WRAPPER_DISTRIBUTION_URL_COUNT_MISMATCH")
            distribution_url = urls[0]
            require(distribution_url == EXPECTED_DISTRIBUTION_URL,
                    "GRADLE_WRAPPER_DISTRIBUTION_REFERENCE_CHANGED")
            distribution_sha = properties.get("distributionSha256Sum", [])
            require(len(distribution_sha) <= 1,
                    "GRADLE_WRAPPER_DISTRIBUTION_SHA256_COUNT_MISMATCH")
            require(not distribution_sha,
                    "GRADLE_WRAPPER_BINARY_DISTRIBUTION_CHECKSUM_PRESENT_UNEXPECTEDLY")
            file_entries = [entry for entry in entries if not entry.is_dir()]
            symlink_entries = [
                entry.filename for entry in entries
                if stat.S_ISLNK((entry.external_attr >> 16) & 0xFFFF)
            ]
    except (OSError, UnicodeError, zipfile.BadZipFile, RuntimeError) as exc:
        raise InspectionError("GRADLE_SOURCE_ARCHIVE_UNREADABLE") from exc

    return {
        "schemaVersion": 1,
        "result": "SOURCE_ARCHIVE_INTEGRITY_AND_WRAPPER_INSPECTION_OK",
        "archive": {
            "url": SOURCE_URL,
            "version": SOURCE_VERSION,
            "sha256": actual_sha,
            "sizeBytes": archive.stat().st_size,
            "root": SOURCE_ROOT,
            "entryCount": len(entries),
            "fileEntryCount": len(file_entries),
            "duplicateEntryCount": 0,
            "crcCheck": "PASS",
            "symlinkEntryCount": len(symlink_entries),
        },
        "wrapper": {
            "propertiesPath": WRAPPER_PROPERTIES,
            "propertiesSha256": sha256_bytes(props_bytes),
            "jarPath": WRAPPER_JAR,
            "jarSha256": sha256_bytes(jar_bytes),
            "launcherPath": WRAPPER_LAUNCHER,
            "launcherSha256": sha256_bytes(launcher_bytes),
            "distributionUrl": distribution_url,
            "distributionType": "prebuilt Gradle binary distribution",
            "distributionSha256Sum": None,
        },
        "bootstrap": {
            "decision": "BLOCKED_PREBUILT_GRADLE_BINARY",
            "wrapperExecuted": False,
            "binaryDistributionDownloaded": False,
            "sourceBuildStarted": False,
            "reason": "The source archive wrapper points to gradle-9.8.1-bin.zip and supplies no distributionSha256Sum.",
        },
        "gates": {
            "candidateEligible": False,
            "packageBuilt": False,
            "feedSigned": False,
            "androidRuntime": "NOT_RUN",
            "qualified": False,
            "productionAllowed": False,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    report = inspect_archive(args.archive)
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized, encoding="utf-8")
    else:
        sys.stdout.write(serialized)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except InspectionError as exc:
        print("ERROR:" + str(exc), file=sys.stderr)
        raise SystemExit(2)
