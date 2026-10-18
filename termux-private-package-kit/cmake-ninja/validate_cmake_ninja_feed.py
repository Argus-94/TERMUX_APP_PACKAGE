#!/usr/bin/env python3
"""Validate the exact temporary CMake/Ninja candidate feed against build and audit records."""
from __future__ import annotations

import argparse
import email.parser
import hashlib
import gzip
import json
import pathlib
import subprocess
import sys

PIN = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
EXPECTED_COUNT = 22
DEPENDENCY_ALTERNATIVE_COUNT = 34
ROOT_DEPENDS = {"cmake": "libarchive, libc++, libcurl, libexpat, jsoncpp, libuv, rhash, zlib", "ninja": "libandroid-spawn, libc++"}


def require(ok: bool, code: str) -> None:
    if not ok:
        raise ValueError(code)


def package_records(path: pathlib.Path) -> list[dict[str, str]]:
    text = path.read_text(encoding="utf-8", errors="strict")
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
            require(previous is not None, "INDEX_ORPHAN_CONTINUATION")
            current[previous] += " " + line.strip()
            continue
        key, sep, value = line.partition(":")
        require(bool(sep) and key not in current, "INDEX_FIELD_INVALID")
        current[key] = value.strip()
        previous = key
    return records


def validate_indexes(root: pathlib.Path, feed_by_name: dict[str, pathlib.Path],
                     specs: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    base = root / "dists/stable/main/binary-aarch64"
    index, zipped = base / "Packages", base / "Packages.gz"
    require(index.is_file() and not index.is_symlink() and zipped.is_file() and
            not zipped.is_symlink(), "PACKAGES_INDEX_MISSING")
    try:
        decompressed = gzip.decompress(zipped.read_bytes())
    except (OSError, EOFError) as exc:
        raise ValueError("PACKAGES_GZIP_INVALID") from exc
    require(decompressed == index.read_bytes(), "PACKAGES_GZIP_MISMATCH")
    records = package_records(index)
    require(len(records) == EXPECTED_COUNT, "INDEX_RECORD_COUNT_MISMATCH")
    indexed: dict[str, dict[str, str]] = {}
    for record in records:
        name = record.get("Package", "")
        require(name in specs and name not in indexed, "INDEX_PACKAGE_SET_MISMATCH")
        require((record.get("Version"), record.get("Architecture")) ==
                (specs[name]["version"], specs[name]["architecture"]), "INDEX_PACKAGE_IDENTITY_MISMATCH")
        filename = record.get("Filename", "")
        rel = pathlib.PurePosixPath(filename)
        require(bool(filename) and not rel.is_absolute() and ".." not in rel.parts and
                "." not in rel.parts and "\\" not in filename, "INDEX_FILENAME_TRAVERSAL")
        deb = feed_by_name[name]
        require(filename == deb.relative_to(root).as_posix(), "INDEX_FILENAME_MISMATCH")
        require(deb.is_file() and not deb.is_symlink() and
                record.get("Size") == str(deb.stat().st_size), "INDEX_PACKAGE_FILE_MISMATCH")
        require(record.get("SHA256") == hashlib.sha256(deb.read_bytes()).hexdigest(),
                "INDEX_PACKAGE_SHA256_MISMATCH")
        indexed[name] = record
    return indexed

def validate(package_set: pathlib.Path, source_closure: pathlib.Path, feed_root: pathlib.Path,
             build_path: pathlib.Path, audit_path: pathlib.Path, prefix: str) -> None:
    from audit_cmake_ninja_closure import validate_manifest

    args = argparse.Namespace(package_set=package_set, source_closure=source_closure, prefix=prefix)
    manifest, _, _ = validate_manifest(args)
    build = json.loads(build_path.read_text(encoding="utf-8"))
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    require(manifest.get("channel") == "candidate-only", "CHANNEL_NOT_CANDIDATE_ONLY")
    require(manifest["source"]["commit"] == PIN, "SOURCE_PIN_MISMATCH")
    require(build.get("baseLicenseProviderEvidence") == manifest.get("baseLicenseProviderEvidence"),
            "BUILD_BOOTSTRAP_LICENSE_EVIDENCE_MISMATCH")
    require(audit.get("baseLicenseProviderEvidence") == manifest.get("baseLicenseProviderEvidence"),
            "AUDIT_BOOTSTRAP_LICENSE_EVIDENCE_MISMATCH")
    require(audit.get("baseLicenseProviderStatus") ==
            "v476 embedded bootstrap archive and eight relevant license payload hashes verified; actual device state not observed",
            "AUDIT_BOOTSTRAP_LICENSE_STATUS_MISMATCH")
    require(manifest["sourceClosure"]["profile"] == "cmake-ninja-candidate" and
            manifest["sourceClosure"]["rootPackages"] == ["cmake", "ninja"], "ROOT_PACKAGE_MISMATCH")
    require(len(manifest["packages"]) == EXPECTED_COUNT, "PACKAGE_SET_COUNT_MISMATCH")
    require(build.get("status") == "audit-passed; device-runtime-test-not-run", "BUILD_NOT_AUDIT_PASSED")
    require(build.get("sourceCommit") == PIN and build.get("installed") is False and
            build.get("deviceSmokeTest") == "NOT RUN" and build.get("rollback") == "NOT RUN",
            "BUILD_GATE_STATE_MISMATCH")
    from audit_cmake_ninja_closure import BUILDER_IMAGE, normalize_prefix
    canonical_prefix = normalize_prefix(prefix)
    require(build.get("builderImage") == BUILDER_IMAGE and build.get("prefix") == canonical_prefix and
            build.get("prefixProvenance") == "ci-model-only; device-observation-not-run", "BUILD_PREFIX_OR_BUILDER_MISMATCH")
    require(audit.get("builderImage") == BUILDER_IMAGE and audit.get("prefix") == canonical_prefix and
            audit.get("prefixProvenance") == "ci-model-only; device-observation-not-run", "AUDIT_PREFIX_OR_BUILDER_MISMATCH")
    require(build.get("buildModifications") == manifest["buildModifications"] and
            audit.get("buildModifications") == manifest["buildModifications"], "BUILD_OR_AUDIT_RECIPE_OVERLAY_MISMATCH")
    build_closure = build.get("sourceClosure", {})
    require(build_closure.get("profile") == "cmake-ninja-candidate" and
            build_closure.get("rootPackages") == ["cmake", "ninja"] and
            build_closure.get("buildTargetPackages") == ["cmake", "ninja"] and
            build_closure.get("packageCount") == EXPECTED_COUNT and
            build_closure.get("dependencyAlternativeCount") == DEPENDENCY_ALTERNATIVE_COUNT,
            "BUILD_CLOSURE_MISMATCH")
    require(audit.get("ok") is True and audit.get("sourceCommit") == PIN and
            audit.get("sourceClosureProfile") == "cmake-ninja-candidate" and
            audit.get("sourceBuildTargetPackages") == ["cmake", "ninja"] and
            audit.get("deviceInstall") == "NOT RUN" and audit.get("rollback") == "NOT RUN",
            "AUDIT_GATE_STATE_MISMATCH")
    require(audit.get("candidatePackageCount") == EXPECTED_COUNT and
            audit.get("sourceClosurePackageCount") == EXPECTED_COUNT and
            audit.get("sourceClosureDependencyAlternativeCount") == DEPENDENCY_ALTERNATIVE_COUNT,
            "AUDIT_CLOSURE_MISMATCH")

    specs = {item["name"]: item for item in manifest["packages"]}
    closure = json.loads(source_closure.read_text(encoding="utf-8"))
    for root_name, depends in ROOT_DEPENDS.items():
        root = next(item for item in closure["packages"] if item["name"] == root_name)
        require(depends == ", ".join(group[0]["sourceRelation"] for group in root["dependencyGroups"]), "PINNED_ROOT_DEPENDENCY_DRIFT")
    require(len(audit.get("packages", [])) == EXPECTED_COUNT and len(build.get("packages", [])) == EXPECTED_COUNT,
            "PACKAGE_REPORT_COUNT_MISMATCH")
    reports = {item["name"]: item for item in audit["packages"]}
    built = {item["name"]: item for item in build["packages"]}
    require(set(specs) == set(reports) == set(built), "PACKAGE_REPORT_SET_MISMATCH")
    debs = sorted(feed_root.glob("pool/main/*/*.deb"))
    require(len(debs) == EXPECTED_COUNT, "FEED_DEB_COUNT_MISMATCH")
    feed_by_name: dict[str, pathlib.Path] = {}
    for deb in debs:
        control = subprocess.run(["dpkg-deb", "-f", str(deb)], check=True, capture_output=True,
                                 text=True, timeout=30).stdout
        fields = email.parser.Parser().parsestr(control)
        name = fields.get("Package", "")
        require(name not in feed_by_name, "FEED_DUPLICATE_PACKAGE")
        require(name in specs, "FEED_EXTRA_PACKAGE")
        require((fields.get("Version"), fields.get("Architecture")) ==
                (specs[name]["version"], specs[name]["architecture"]), "FEED_PACKAGE_IDENTITY_MISMATCH")
        digest = hashlib.sha256(deb.read_bytes()).hexdigest()
        require(digest == reports[name].get("sha256") == built[name].get("sha256"), "FEED_PACKAGE_HASH_MISMATCH")
        feed_by_name[name] = deb
    require(set(feed_by_name) == set(specs), "FEED_PACKAGE_SET_MISMATCH")

    index_by_name = validate_indexes(feed_root, feed_by_name, specs)
    for name, record in index_by_name.items():
        require((record.get("Version"), record.get("Architecture")) ==
                (specs[name]["version"], specs[name]["architecture"]), "INDEX_PACKAGE_IDENTITY_MISMATCH")
    for root_name, depends in ROOT_DEPENDS.items():
        require(index_by_name[root_name].get("Depends") == depends, "ROOT_DEPENDS_NOT_EXACT")
    require(index_by_name["cmake"].get("Recommends", "") == "clang, make", "CMAKE_RECOMMENDATIONS_CHANGED")
    require(index_by_name["ninja"].get("Recommends", "") == "", "NINJA_RECOMMENDATIONS_CHANGED")
    require(not {"clang", "make", "cmake-curses-gui", "ncurses-ui-libs"} & set(specs), "BUILD_ONLY_OR_RECOMMENDED_PACKAGE_INCLUDED")
    print("PINNED_CMAKE_NINJA_TEMP_FEED_VALIDATED packages=22 dependency_alternatives=34 roots=cmake,ninja "
          "install=NOT_PERFORMED device_install=NOT_RUN")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-set", type=pathlib.Path, required=True)
    parser.add_argument("--source-closure", type=pathlib.Path, required=True)
    parser.add_argument("--feed-root", type=pathlib.Path, required=True)
    parser.add_argument("--build-result", type=pathlib.Path, required=True)
    parser.add_argument("--audit-report", type=pathlib.Path, required=True)
    parser.add_argument("--prefix", required=True)
    args = parser.parse_args()
    try:
        validate(args.package_set, args.source_closure, args.feed_root, args.build_result, args.audit_report, args.prefix)
        return 0
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print("CMAKE_NINJA_CANDIDATE_FEED_REJECTED:" + (str(exc) if isinstance(exc, ValueError) else "INPUT_INVALID"),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
