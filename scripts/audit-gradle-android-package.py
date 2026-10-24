#!/usr/bin/env python3
"""Statically audit the isolated AI Builder Gradle .deb against its locked inputs."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import zipfile
from typing import Any


def need(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError(message)


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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


def field(deb: Path, name: str) -> str:
    result = subprocess.run(["dpkg-deb", "-f", str(deb), name], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def distribution_inventory(path: Path, expected_sha: str) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    need(path.is_file() and not path.is_symlink(), "DISTRIBUTION_ZIP_NOT_REGULAR")
    need(sha_file(path) == expected_sha, "DISTRIBUTION_ZIP_SHA256_MISMATCH")
    files: dict[str, dict[str, Any]] = {}
    docs: dict[str, str] = {}
    seen: set[str] = set()
    with zipfile.ZipFile(path, "r") as archive:
        need(archive.testzip() is None, "DISTRIBUTION_ZIP_CRC_FAILURE")
        for info in archive.infolist():
            raw = info.filename[:-1] if info.is_dir() and info.filename.endswith("/") else info.filename
            rel = safe_rel(raw)
            need(rel.parts[0] == "gradle-9.8.2", "DISTRIBUTION_ROOT_MISMATCH:" + raw)
            need(raw not in seen, "DISTRIBUTION_DUPLICATE_PATH:" + raw)
            seen.add(raw)
            mode = (info.external_attr >> 16) & 0xFFFF
            ftype = stat.S_IFMT(mode)
            if info.is_dir():
                need(ftype in (0, stat.S_IFDIR), "DISTRIBUTION_NONDIR_DIRECTORY_ENTRY:" + raw)
                continue
            need(ftype in (0, stat.S_IFREG), "DISTRIBUTION_NONREGULAR_ENTRY:" + raw)
            if rel.parts[1:2] == ("bin",) and raw.lower().endswith(".bat"):
                continue
            data = archive.read(info)
            package_rel = PurePosixPath("opt/gradle", *rel.parts[1:]).as_posix()
            files[package_rel] = {"sha256": sha_bytes(data), "mode": stat.S_IMODE(mode) or 0o644,
                                  "sizeBytes": len(data), "sourcePath": raw}
            if raw in ("gradle-9.8.2/LICENSE", "gradle-9.8.2/NOTICE",
                       "gradle-9.8.2/LICENSE.native-platform.txt",
                       "gradle-9.8.2/ANDROID-CANDIDATE-STATUS.txt"):
                docs["share/doc/gradle/" + PurePosixPath(raw).name] = sha_bytes(data)
    need(files.get("opt/gradle/bin/gradle", {}).get("mode", 0) & 0o111,
         "GRADLE_LAUNCHER_NOT_EXECUTABLE_IN_SOURCE_ZIP")
    need(set(docs) == {"share/doc/gradle/LICENSE", "share/doc/gradle/NOTICE",
                       "share/doc/gradle/LICENSE.native-platform.txt",
                       "share/doc/gradle/ANDROID-CANDIDATE-STATUS.txt"}, "DISTRIBUTION_DOCUMENTS_INCOMPLETE")
    return files, docs


def data_inventory(deb: Path, prefix: str) -> tuple[dict[str, dict[str, Any]], int]:
    result = subprocess.run(["dpkg-deb", "--fsys-tarfile", str(deb)], check=True, capture_output=True)
    inventory: dict[str, dict[str, Any]] = {}
    directories = 0
    prefix_rel = prefix.lstrip("/")
    try:
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:*") as archive:
            for member in archive.getmembers():
                raw = member.name
                while raw.startswith("./"):
                    raw = raw[2:]
                if raw in ("", "."):
                    directories += 1
                    continue
                rel = safe_rel(raw)
                need(not raw.startswith("/"), "PACKAGE_DATA_ABSOLUTE_PATH:" + raw)
                if member.isdir():
                    directory_parts = PurePosixPath(raw).parts
                    prefix_parts = PurePosixPath(prefix_rel).parts
                    is_prefix_ancestor = prefix_parts[:len(directory_parts)] == directory_parts
                    is_inside_prefix = directory_parts[:len(prefix_parts)] == prefix_parts
                    need(is_prefix_ancestor or is_inside_prefix,
                         "PACKAGE_DIRECTORY_OUTSIDE_MODELED_PREFIX:" + raw)
                    directories += 1
                    continue
                need(raw.startswith(prefix_rel + "/"), "PACKAGE_PATH_OUTSIDE_MODELED_PREFIX:" + raw)
                kind: str
                digest: str | None
                linkname: str | None = None
                if member.isfile():
                    stream = archive.extractfile(member)
                    need(stream is not None, "PACKAGE_FILE_UNREADABLE:" + raw)
                    h = hashlib.sha256()
                    size = 0
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        h.update(block)
                        size += len(block)
                    kind, digest, linkname = "file", h.hexdigest(), None
                    need(size == member.size, "PACKAGE_FILE_SIZE_MISMATCH:" + raw)
                elif member.issym():
                    kind, digest, linkname = "symlink", None, member.linkname
                    need(linkname and not PurePosixPath(linkname).is_absolute(), "PACKAGE_ABSOLUTE_OR_EMPTY_SYMLINK:" + raw)
                    target = PurePosixPath(raw).parent.joinpath(linkname)
                    stack: list[str] = []
                    for part in target.parts:
                        if part in ("", "."):
                            continue
                        if part == "..":
                            need(bool(stack), "PACKAGE_SYMLINK_ESCAPES_ROOT:" + raw)
                            stack.pop()
                        else:
                            stack.append(part)
                    need(PurePosixPath(*stack).as_posix().startswith(prefix_rel + "/"),
                         "PACKAGE_SYMLINK_TARGET_OUTSIDE_MODELED_PREFIX:" + raw)
                else:
                    raise ValueError("PACKAGE_SPECIAL_OR_HARDLINK_ENTRY:" + raw)
                need(raw not in inventory, "PACKAGE_DUPLICATE_PATH:" + raw)
                inventory[raw] = {"kind": kind, "sha256": digest, "mode": stat.S_IMODE(member.mode),
                                  "sizeBytes": member.size if kind == "file" else None,
                                  "linkname": linkname}
    except (tarfile.TarError, OSError) as exc:
        raise ValueError("PACKAGE_DATA_TAR_INVALID:" + str(exc)) from exc
    return inventory, directories


def audit(lock: dict[str, Any], distribution_zip: Path, deb: Path, prefix: str) -> dict[str, Any]:
    need(deb.is_file() and not deb.is_symlink(), "DEB_NOT_REGULAR")
    need(lock.get("applicationId") == "com.karat.aibuilder", "APPLICATION_ID_LOCK_MISMATCH")
    need(lock.get("target", {}).get("deviceObserved") is False, "DEVICE_OBSERVATION_MUST_REMAIN_FALSE")
    package = lock["package"]
    need(package == {"name": "gradle", "version": "1:9.8.2", "architecture": "aarch64",
                    "depends": "openjdk-17", "expectedJdk17Version": "17.0.20", "candidateOnly": True},
         "PACKAGE_IDENTITY_LOCK_MISMATCH")
    need(prefix == lock["target"]["modeledPrefix"], "MODELED_PREFIX_MISMATCH")
    fields = {name: field(deb, name) for name in ("Package", "Version", "Architecture", "Depends", "Installed-Size")}
    need(fields["Package"] == package["name"], "PACKAGE_NAME_MISMATCH:" + fields["Package"])
    need(fields["Version"] == package["version"], "PACKAGE_VERSION_MISMATCH:" + fields["Version"])
    need(fields["Architecture"] == package["architecture"], "PACKAGE_ARCHITECTURE_MISMATCH:" + fields["Architecture"])
    need(fields["Depends"] == package["depends"], "PACKAGE_DEPENDENCY_MISMATCH:" + fields["Depends"])
    need(fields["Installed-Size"].isdigit() and int(fields["Installed-Size"]) > 0,
         "PACKAGE_INSTALLED_SIZE_INVALID")
    dist_report = lock.get("_assemblyReport")
    need(isinstance(dist_report, dict)
         and dist_report.get("result") == "ANDROID_GRADLE_DISTRIBUTION_ASSEMBLY_PASS_TEST_CANDIDATE_ONLY",
         "ASSEMBLY_REPORT_MISSING_OR_NOT_PASS")
    need(dist_report.get("gates", {}).get("productionAllowed") is False
         and dist_report.get("gates", {}).get("candidateEligible") is False
         and dist_report.get("gates", {}).get("androidDeviceRuntime") == "NOT_RUN",
         "ASSEMBLY_REPORT_SCOPE_MISMATCH")
    expected_zip_sha = dist_report.get("distribution", {}).get("sha256")
    need(re.fullmatch(r"[a-f0-9]{64}", expected_zip_sha or "") is not None,
         "ASSEMBLED_DISTRIBUTION_SHA_MISSING_IN_LOCK_OR_REPORT")
    dist_files, docs = distribution_inventory(distribution_zip, expected_zip_sha)
    data, dir_count = data_inventory(deb, prefix)
    prefix_rel = prefix.lstrip("/")
    expected: dict[str, dict[str, Any]] = {}
    for rel, record in dist_files.items():
        expected[prefix_rel + "/" + rel] = {"kind": "file", "sha256": record["sha256"],
                                             "mode": record["mode"], "sizeBytes": record["sizeBytes"],
                                             "linkname": None}
    for rel, digest in docs.items():
        expected[prefix_rel + "/" + rel] = {"kind": "file", "sha256": digest, "mode": 0o644,
                                             "sizeBytes": None, "linkname": None}
    for rel, record in dist_files.items():
        if not rel.startswith("opt/gradle/bin/") or "/" in rel[len("opt/gradle/bin/"):]:
            continue
        filename = PurePosixPath(rel).name
        expected[prefix_rel + "/bin/" + filename] = {
            "kind": "symlink", "sha256": None, "mode": 0o777, "sizeBytes": None,
            "linkname": "../opt/gradle/bin/" + filename,
        }
    license_copyright_path = prefix_rel + "/share/doc/gradle/copyright"
    expected[license_copyright_path] = {
        "kind": "symlink", "sha256": None, "mode": 0o777, "sizeBytes": None,
        "linkname": "../../LICENSES/Apache-2.0.txt",
    }
    need(set(data) == set(expected),
         "PACKAGE_DATA_PATH_SET_MISMATCH:missing=" + repr(sorted(set(expected) - set(data))[:20])
         + ";extra=" + repr(sorted(set(data) - set(expected))[:20]))
    for path, wanted in expected.items():
        actual = data[path]
        need(actual["kind"] == wanted["kind"], "PACKAGE_ENTRY_TYPE_MISMATCH:" + path)
        need(actual["mode"] == wanted["mode"], "PACKAGE_ENTRY_MODE_MISMATCH:" + path)
        if wanted["kind"] == "file":
            need(actual["sha256"] == wanted["sha256"], "PACKAGE_FILE_CONTENT_MISMATCH:" + path)
            if wanted["sizeBytes"] is not None:
                need(actual["sizeBytes"] == wanted["sizeBytes"], "PACKAGE_FILE_SIZE_MISMATCH:" + path)
        else:
            need(actual["linkname"] == wanted["linkname"], "PACKAGE_SYMLINK_TARGET_MISMATCH:" + path)
    return {
        "schemaVersion": 1,
        "result": "GRADLE_AARCH64_DEB_STATIC_AUDIT_PASS_TEST_ONLY",
        "package": fields,
        "packageFile": deb.name,
        "packageSha256": sha_file(deb),
        "packageSizeBytes": deb.stat().st_size,
        "applicationId": lock["applicationId"],
        "modeledPrefix": prefix,
        "deviceObserved": False,
        "distributionZipSha256": expected_zip_sha,
        "payloadFileCount": sum(1 for item in data.values() if item["kind"] == "file"),
        "payloadSymlinkCount": sum(1 for item in data.values() if item["kind"] == "symlink"),
        "payloadDirectoryEntryCount": dir_count,
        "payloadPathSetMatchesSourceDistributionAndExpectedDocs": True,
        "termuxGeneratedLicenseCopyrightSymlinkAudited": {
            "packagePath": license_copyright_path,
            "linkTarget": "../../LICENSES/Apache-2.0.txt",
        },
        "payloadFileHashesAndModesMatchSourceDistribution": True,
        "aptSimulation": "NOT_RUN",
        "installed": False,
        "androidDeviceRuntime": "NOT_RUN",
        "candidateEligible": False,
        "qualified": False,
        "productionAllowed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-lock", type=Path, required=True)
    parser.add_argument("--distribution-zip", type=Path, required=True)
    parser.add_argument("--assembly-report", type=Path, required=True)
    parser.add_argument("--deb", type=Path, required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    try:
        lock = json.loads(args.input_lock.read_text(encoding="utf-8"))
        lock["_assemblyReport"] = json.loads(args.assembly_report.read_text(encoding="utf-8"))
        report = audit(lock, args.distribution_zip, args.deb, args.prefix)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("GRADLE_AARCH64_DEB_STATIC_AUDIT_PASS sha256=" + report["packageSha256"]
              + " install=false runtime=NOT_RUN production=false")
        return 0
    except Exception as exc:
        failure = {"schemaVersion": 1, "result": "BLOCKED_PACKAGE_AUDIT_FAIL_CLOSED",
                   "error": f"{type(exc).__name__}:{exc}", "installed": False,
                   "androidDeviceRuntime": "NOT_RUN", "candidateEligible": False, "productionAllowed": False}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(failure, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("ERROR:" + failure["error"], file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
