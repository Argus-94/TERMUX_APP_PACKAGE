#!/usr/bin/env python3
"""Merge verified profile artifacts into a closed-gate synthetic aggregate input."""
from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import PurePosixPath

SAFE_PROFILE_ARCHIVE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz\Z")
PROFILE_EVIDENCE_FILES = {
    "candidate-package-set.json",
    "source-closure.json",
    "build-result.json",
    "audit-report.json",
    "profile-index.json",
}
MAX_PROFILE_ARCHIVE_MEMBERS = 1024
MAX_PROFILE_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024


def fail(message: str) -> None:
    raise SystemExit(f"AGGREGATE_INPUT_REJECTED:{message}")


def read_json(path: pathlib.Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"INVALID_JSON:{path}:{exc}")


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def safe_extract_profile_archive(archive_path: pathlib.Path, destination: pathlib.Path) -> pathlib.Path:
    archive_path = pathlib.Path(archive_path)
    if archive_path.is_symlink() or not archive_path.is_file():
        fail("PROFILE_ARCHIVE_NOT_REGULAR_FILE")
    if not SAFE_PROFILE_ARCHIVE_NAME.fullmatch(archive_path.name):
        fail("PROFILE_ARCHIVE_FILENAME_UNSAFE")
    destination = pathlib.Path(destination)
    if destination.is_symlink() or destination.exists():
        fail("PROFILE_ARCHIVE_DESTINATION_NOT_NEW")
    destination.mkdir(parents=True)
    seen: set[str] = set()
    total_size = 0
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            if not members or len(members) > MAX_PROFILE_ARCHIVE_MEMBERS:
                fail("PROFILE_ARCHIVE_MEMBER_COUNT_INVALID")
            for member in members:
                raw_name = member.name
                if not raw_name or raw_name.startswith("/") or "\\" in raw_name or "//" in raw_name:
                    fail("PROFILE_ARCHIVE_MEMBER_PATH_INVALID")
                normalized_name = raw_name[:-1] if raw_name.endswith("/") else raw_name
                parts = PurePosixPath(normalized_name).parts
                if not parts or normalized_name in ("", ".") or any(part in ("", ".", "..") for part in parts):
                    fail("PROFILE_ARCHIVE_MEMBER_PATH_INVALID")
                member_name = "/".join(parts)
                if member_name != normalized_name:
                    fail("PROFILE_ARCHIVE_MEMBER_PATH_INVALID")
                if member_name in seen:
                    fail("PROFILE_ARCHIVE_DUPLICATE_MEMBER")
                seen.add(member_name)
                if member.issym() or member.islnk() or member.isdev() or not (member.isdir() or member.isfile()):
                    fail("PROFILE_ARCHIVE_MEMBER_TYPE_INVALID")
                if member.isdir():
                    if parts != ("packages",) or member.size != 0:
                        fail("PROFILE_ARCHIVE_DIRECTORY_INVALID")
                    (destination / "packages").mkdir(exist_ok=True)
                    continue
                if len(parts) == 1 and member_name in PROFILE_EVIDENCE_FILES:
                    pass
                elif len(parts) == 2 and parts[0] == "packages" and parts[1].endswith(".deb"):
                    pass
                else:
                    fail("PROFILE_ARCHIVE_UNEXPECTED_MEMBER")
                if member.size < 0:
                    fail("PROFILE_ARCHIVE_MEMBER_SIZE_INVALID")
                total_size += member.size
                if total_size > MAX_PROFILE_ARCHIVE_BYTES:
                    fail("PROFILE_ARCHIVE_EXPANDED_SIZE_LIMIT")
                target = destination.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.is_symlink() or target.exists():
                    fail("PROFILE_ARCHIVE_DUPLICATE_MEMBER")
                source = archive.extractfile(member)
                if source is None:
                    fail("PROFILE_ARCHIVE_MEMBER_UNREADABLE")
                with source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o600)
    except (OSError, EOFError, tarfile.TarError) as exc:
        shutil.rmtree(destination, ignore_errors=True)
        fail(f"PROFILE_ARCHIVE_INVALID:{archive_path.name}:{exc}")
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise

    top_level_files = {path.name for path in destination.iterdir() if path.is_file() and not path.is_symlink()}
    if top_level_files != PROFILE_EVIDENCE_FILES:
        fail("PROFILE_ARCHIVE_EVIDENCE_FILE_SET_INVALID")
    packages = destination / "packages"
    if packages.is_symlink() or not packages.is_dir():
        fail("PROFILE_ARCHIVE_PACKAGE_DIRECTORY_MISSING")
    deb_files = sorted(packages.iterdir())
    if not deb_files or any(path.is_symlink() or not path.is_file() or path.suffix != ".deb" for path in deb_files):
        fail("PROFILE_ARCHIVE_PACKAGE_FILE_SET_INVALID")
    return destination


def unpack_profile_artifacts(
    artifacts_root: pathlib.Path, profile_ids: set[str], destination: pathlib.Path
) -> pathlib.Path:
    artifacts_root = pathlib.Path(artifacts_root)
    if artifacts_root.is_symlink() or not artifacts_root.is_dir():
        fail("PROFILE_ARTIFACT_ROOT_INVALID")
    destination = pathlib.Path(destination)
    if destination.is_symlink() or (destination.exists() and (not destination.is_dir() or any(destination.iterdir()))):
        fail("PROFILE_ARCHIVE_DESTINATION_NOT_EMPTY")
    destination.mkdir(parents=True, exist_ok=True)
    artifact_dirs = sorted(artifacts_root.iterdir())
    if len(artifact_dirs) != len(profile_ids):
        fail("PROFILE_ARCHIVE_COUNT_MISMATCH")
    seen: set[str] = set()
    for artifact_dir in artifact_dirs:
        if artifact_dir.is_symlink() or not artifact_dir.is_dir():
            fail("PROFILE_ARTIFACT_DIRECTORY_INVALID")
        entries = sorted(artifact_dir.iterdir())
        if len(entries) != 1:
            fail("PROFILE_ARTIFACT_CONTENT_COUNT_INVALID")
        archive_path = entries[0]
        if archive_path.is_symlink() or not archive_path.is_file() or not archive_path.name.endswith(".tar.gz"):
            fail("PROFILE_ARTIFACT_ARCHIVE_MISSING")
        profile_id = archive_path.name[:-7]
        if profile_id not in profile_ids or profile_id in seen or archive_path.name != f"{profile_id}.tar.gz":
            fail("PROFILE_ARCHIVE_PROFILE_ID_INVALID")
        prefix = f"aib-v525-profile-{profile_id}-"
        if not artifact_dir.name.startswith(prefix) or not artifact_dir.name[len(prefix):].isdecimal():
            fail("PROFILE_ARTIFACT_NAME_INVALID")
        safe_extract_profile_archive(archive_path, destination / profile_id)
        seen.add(profile_id)
    if seen != profile_ids:
        fail("PROFILE_ARCHIVE_PROFILE_SET_MISMATCH")
    return destination


def deb_identity(path: pathlib.Path) -> tuple[str, str, str]:
    try:
        raw = subprocess.check_output(
            ["dpkg-deb", "-f", str(path), "Package", "Version", "Architecture"],
            text=True,
            stderr=subprocess.STDOUT,
        )
    except subprocess.CalledProcessError as exc:
        fail(f"INVALID_DEB:{path.name}:{exc.output[-800:]}")
    labels = ("Package", "Version", "Architecture")
    lines = raw.splitlines()
    if len(lines) != len(labels):
        fail(f"INVALID_DEB_IDENTITY:{path.name}")
    values = []
    for expected_label, line in zip(labels, lines):
        label, separator, value = line.partition(":")
        if label != expected_label or not separator or not value.strip():
            fail(f"INVALID_DEB_IDENTITY:{path.name}")
        values.append(value.strip())
    return tuple(values)  # type: ignore[return-value]


def rows_from_manifest(manifest: dict) -> list[dict]:
    rows = manifest.get("packages")
    if isinstance(rows, list):
        return rows
    row = manifest.get("package")
    if isinstance(row, dict):
        return [row]
    fail("PROFILE_PACKAGE_SET_HAS_NO_ROWS")


def audit_hashes(audit: dict, identity_set: set[tuple[str, str, str]]) -> dict[tuple[str, str, str], str]:
    result: dict[tuple[str, str, str], str] = {}
    rows = audit.get("packages")
    if isinstance(rows, list):
        for row in rows:
            key = (row.get("name"), row.get("version"), row.get("architecture"))
            digest = row.get("sha256")
            if key in result or not isinstance(digest, str):
                fail("AUDIT_HASH_RECORD_INVALID")
            result[key] = digest
    elif isinstance(audit.get("package"), dict) and isinstance(audit.get("sha256"), str):
        row = audit["package"]
        result[(row.get("name"), row.get("version"), row.get("architecture"))] = audit["sha256"]
    if set(result) != identity_set:
        fail("AUDIT_HASH_IDENTITY_SET_MISMATCH")
    return result


def build_hashes(build: dict, identity_set: set[tuple[str, str, str]], actual: dict) -> dict[tuple[str, str, str], str]:
    result: dict[tuple[str, str, str], str] = {}
    rows = build.get("packages")
    if isinstance(rows, list):
        for row in rows:
            key = (row.get("name"), row.get("version"), row.get("architecture"))
            digest = row.get("sha256")
            if key in result or not isinstance(digest, str):
                fail("BUILD_RESULT_HASH_RECORD_INVALID")
            result[key] = digest
    elif isinstance(build.get("packageFile"), str) and isinstance(build.get("packageSha256"), str):
        if len(actual) != 1:
            fail("SINGLE_BUILD_RESULT_FOR_MULTI_PACKAGE_PROFILE")
        key = next(iter(actual))
        if pathlib.Path(build["packageFile"]).name != actual[key]["path"].name:
            fail("BUILD_RESULT_PACKAGE_FILE_MISMATCH")
        result[key] = build["packageSha256"]
    if set(result) != identity_set:
        fail("BUILD_RESULT_HASH_IDENTITY_SET_MISMATCH")
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", type=pathlib.Path, required=True)
    ap.add_argument("--plan", type=pathlib.Path, required=True)
    ap.add_argument("--profile-artifacts-root", type=pathlib.Path, required=True)
    ap.add_argument("--packages-dir", type=pathlib.Path, required=True)
    ap.add_argument("--manifest-out", type=pathlib.Path, required=True)
    ap.add_argument("--evidence-dir", type=pathlib.Path, required=True)
    ap.add_argument("--merge-report-out", type=pathlib.Path, required=True)
    args = ap.parse_args()

    repo = args.repo_root.resolve(strict=True)
    plan = read_json(args.plan.resolve(strict=True))
    artifacts_root = pathlib.Path(args.profile_artifacts_root)
    profiles = plan.get("profiles", [])
    if len(profiles) != plan.get("expectedProfileCount") or len({p.get("id") for p in profiles}) != len(profiles):
        fail("PROFILE_PLAN_COUNT_OR_ID_INVALID")
    by_profile = {p["id"]: p for p in profiles}
    unpack_root = pathlib.Path(tempfile.mkdtemp(prefix="aib-v525-profile-archives-"))
    atexit.register(shutil.rmtree, unpack_root, ignore_errors=True)
    artifacts_root = unpack_profile_artifacts(artifacts_root, set(by_profile), unpack_root)
    index_paths = sorted(artifacts_root.rglob("profile-index.json"))
    if len(index_paths) != len(profiles):
        fail("PROFILE_ARTIFACT_COUNT_MISMATCH")

    for output in (args.packages_dir, args.evidence_dir):
        if output.exists():
            if not output.is_dir() or any(output.iterdir()):
                fail("OUTPUT_DIRECTORY_MUST_BE_NEW_OR_EMPTY")
        else:
            output.mkdir(parents=True)
    for output_file in (args.manifest_out, args.merge_report_out):
        if output_file.exists():
            fail("OUTPUT_FILE_MUST_BE_NEW")
        output_file.parent.mkdir(parents=True, exist_ok=True)

    seen_profiles: set[str] = set()
    unique_by_name: dict[str, dict] = {}
    identity_occurrences: dict[tuple[str, str, str], list[dict]] = {}
    closure_summaries = []
    profile_records = []

    for index_path in index_paths:
        profile_dir = index_path.parent.resolve(strict=True)
        if not profile_dir.is_relative_to(artifacts_root):
            fail("PROFILE_ARTIFACT_PATH_ESCAPES_ROOT")
        index = read_json(index_path)
        profile_id = index.get("profileId")
        if profile_id not in by_profile or profile_id in seen_profiles:
            fail("PROFILE_ID_UNEXPECTED_OR_DUPLICATED")
        seen_profiles.add(profile_id)
        profile = by_profile[profile_id]
        if index.get("temporaryOnly") is not True:
            fail("PROFILE_ARTIFACT_NOT_TEMPORARY")
        if index.get("sourceCommit") != plan["sourceCommit"] or index.get("builderImage") != plan["builderImage"]:
            fail("PROFILE_PIN_MISMATCH")
        if index.get("architecture") != plan["architecture"]:
            fail("PROFILE_ARCHITECTURE_MISMATCH")
        if index.get("sourceClosureProfile") != profile["sourceClosureProfile"]:
            fail("PROFILE_CLOSURE_PROFILE_MISMATCH")
        if index.get("rootPackages") != profile["rootPackages"]:
            fail("PROFILE_ROOTS_MISMATCH")
        if index.get("sourceClosurePackageCount") != profile["expectedPackageCount"]:
            fail("PROFILE_CLOSURE_COUNT_MISMATCH")
        if index.get("sourceClosureDependencyAlternativeCount") != profile["expectedDependencyAlternativeCount"]:
            fail("PROFILE_CLOSURE_ALTERNATIVE_COUNT_MISMATCH")
        if index.get("sourceClosureSha256") != profile["sourceClosureSha256"]:
            fail("PROFILE_CLOSURE_HASH_MISMATCH")
        if index.get("qualification") != {
            "qualified": False,
            "productionAllowed": False,
            "deviceInstall": "NOT RUN",
            "deviceRuntimeTest": "NOT RUN",
        }:
            fail("PROFILE_QUALIFICATION_GATE_OPEN")

        manifest_path = profile_dir / "candidate-package-set.json"
        closure_path = profile_dir / "source-closure.json"
        build_path = profile_dir / "build-result.json"
        audit_path = profile_dir / "audit-report.json"
        packages_path = profile_dir / "packages"
        if not all(p.is_file() for p in (manifest_path, closure_path, build_path, audit_path)) or not packages_path.is_dir():
            fail("PROFILE_EVIDENCE_MISSING")
        manifest, closure, build, audit = map(read_json, (manifest_path, closure_path, build_path, audit_path))
        if sha256(manifest_path) != index.get("packageSetSha256"):
            fail("PROFILE_PACKAGE_SET_HASH_MISMATCH")
        if sha256(closure_path) != profile["sourceClosureSha256"]:
            fail("PROFILE_SOURCE_CLOSURE_HASH_MISMATCH")
        if closure.get("sourceCommit") != plan["sourceCommit"] or closure.get("profile") != profile["sourceClosureProfile"]:
            fail("PROFILE_SOURCE_CLOSURE_PIN_MISMATCH")
        if closure.get("rootPackages") != profile["rootPackages"] or closure.get("packageCount") != profile["expectedPackageCount"]:
            fail("PROFILE_SOURCE_CLOSURE_CONTENT_MISMATCH")
        if closure.get("dependencyAlternativeCount") != profile["expectedDependencyAlternativeCount"]:
            fail("PROFILE_SOURCE_CLOSURE_ALTERNATIVES_MISMATCH")
        manifest_source = manifest.get("source", {})
        manifest_commit = manifest_source.get("commit") or manifest.get("upstreamSource", {}).get("revision")
        if manifest_commit != plan["sourceCommit"]:
            fail("PROFILE_MANIFEST_SOURCE_COMMIT_MISMATCH")
        if manifest.get("target", {}).get("architecture") not in (None, plan["architecture"]):
            fail("PROFILE_MANIFEST_ARCHITECTURE_MISMATCH")
        source_closure = manifest.get("sourceClosure")
        if isinstance(source_closure, dict):
            if source_closure.get("profile") != profile["sourceClosureProfile"]:
                fail("PROFILE_MANIFEST_CLOSURE_PROFILE_MISMATCH")
            if source_closure.get("rootPackages") != profile["rootPackages"]:
                fail("PROFILE_MANIFEST_CLOSURE_ROOTS_MISMATCH")
            if source_closure.get("expectedPackageCount") != profile["expectedPackageCount"]:
                fail("PROFILE_MANIFEST_CLOSURE_COUNT_MISMATCH")
            if source_closure.get("expectedDependencyAlternativeCount") != profile["expectedDependencyAlternativeCount"]:
                fail("PROFILE_MANIFEST_CLOSURE_ALTERNATIVES_MISMATCH")
        if audit.get("ok") is not True:
            fail("PROFILE_STATIC_AUDIT_NOT_PASSED")
        if build.get("status") != "audit-passed; device-runtime-test-not-run" or build.get("sourceCommit") != plan["sourceCommit"]:
            fail("PROFILE_BUILD_RESULT_NOT_AUDITED_OR_PINNED")
        image = build.get("builderImage") or build.get("builderImageRef")
        if image != plan["builderImage"] or build.get("installed") is not False:
            fail("PROFILE_BUILD_RESULT_PIN_OR_DEVICE_GATE_MISMATCH")
        if build.get("deviceSmokeTest") not in ("NOT RUN", "NOT_RUN"):
            fail("PROFILE_DEVICE_TEST_GATE_OPEN")

        specs = rows_from_manifest(manifest)
        spec_by_name = {r.get("name"): r for r in specs}
        if len(spec_by_name) != len(specs) or set(spec_by_name) != {r.get("name") for r in closure.get("packages", [])}:
            fail("PROFILE_MANIFEST_SOURCE_CLOSURE_NAME_MISMATCH")
        if len(specs) != profile["expectedPackageCount"]:
            fail("PROFILE_MANIFEST_PACKAGE_COUNT_MISMATCH")
        closure_by_name = {row.get("name"): row for row in closure.get("packages", [])}
        for name, spec in spec_by_name.items():
            expected_recipe = spec.get("recipeSha256")
            if name == "make":
                expected_recipe = manifest.get("upstreamSource", {}).get("packageRecipeSha256")
            if not isinstance(expected_recipe, str) or closure_by_name[name].get("recipeSha256") != expected_recipe:
                fail(f"PROFILE_RECIPE_HASH_MISMATCH:{name}")
        if manifest.get("releaseGate", {}).get("publicationAllowed") is not False:
            fail("PROFILE_MANIFEST_PUBLICATION_GATE_OPEN")
        if manifest.get("releaseGate", {}).get("deviceInstall") not in ("NOT RUN", "NOT_RUN"):
            fail("PROFILE_MANIFEST_DEVICE_GATE_OPEN")
        if manifest.get("releaseGate", {}).get("rollback") not in ("NOT RUN", "NOT_RUN"):
            fail("PROFILE_MANIFEST_ROLLBACK_GATE_OPEN")

        index_rows = index.get("packages")
        if not isinstance(index_rows, list) or len(index_rows) != len(specs):
            fail("PROFILE_INDEX_PACKAGE_ROWS_INVALID")
        if index.get("debCount") != len(specs):
            fail("PROFILE_INDEX_DEB_COUNT_MISMATCH")
        deb_files = sorted(packages_path.glob("*.deb"))
        if len(deb_files) != len(specs) or any(p.is_symlink() or not p.is_file() for p in deb_files):
            fail("PROFILE_DEB_FILE_SET_INVALID")
        index_by_key = {}
        actual: dict[tuple[str, str, str], dict] = {}
        for row in index_rows:
            key = (row.get("name"), row.get("version"), row.get("architecture"))
            if key in index_by_key or not isinstance(row.get("file"), str) or not isinstance(row.get("sha256"), str):
                fail("PROFILE_INDEX_IDENTITY_INVALID")
            index_by_key[key] = row
        for deb in deb_files:
            key = deb_identity(deb)
            if key in actual:
                fail("PROFILE_DEB_IDENTITY_DUPLICATED")
            if key[0] not in spec_by_name:
                fail(f"PROFILE_DEB_NOT_IN_MANIFEST:{key[0]}")
            spec = spec_by_name[key[0]]
            if key[1] != spec.get("version") or key[2] != spec.get("architecture"):
                fail(f"PROFILE_DEB_IDENTITY_VS_MANIFEST_MISMATCH:{key[0]}")
            digest = sha256(deb)
            item = index_by_key.get(key)
            if item is None or item.get("file") != deb.name or item.get("sha256") != digest:
                fail(f"PROFILE_DEB_INDEX_HASH_OR_IDENTITY_MISMATCH:{key[0]}")
            actual[key] = {"path": deb, "sha256": digest, "profileId": profile_id}
        if set(index_by_key) != set(actual):
            fail("PROFILE_INDEX_DEB_SET_MISMATCH")
        identities = set(actual)
        audit_map = audit_hashes(audit, identities)
        build_map = build_hashes(build, identities, actual)
        for key, record in actual.items():
            if audit_map[key] != record["sha256"] or build_map[key] != record["sha256"]:
                fail(f"PROFILE_BUILD_OR_AUDIT_HASH_MISMATCH:{key[0]}")
            name, version, architecture = key
            if name == "nodejs" and profile_id == "nodejs-lts-npm":
                fail("CURRENT_NODEJS_PROVIDER_IN_LTS_PROFILE")
            if name not in unique_by_name:
                unique_by_name[name] = {
                    "name": name,
                    "version": version,
                    "architecture": architecture,
                    "sha256": record["sha256"],
                    "file": record["path"].name,
                    "sourceProfiles": [profile_id],
                    "path": record["path"],
                }
                identity_occurrences[key] = [{"profileId": profile_id, "sha256": record["sha256"]}]
            else:
                prior = unique_by_name[name]
                if (prior["version"], prior["architecture"]) != (version, architecture):
                    fail(f"OVERLAPPING_PACKAGE_IDENTITY_MISMATCH:{name}")
                if prior["sha256"] != record["sha256"]:
                    fail(f"OVERLAPPING_PACKAGE_SHA256_MISMATCH:{name}")
                prior["sourceProfiles"].append(profile_id)
                identity_occurrences[key].append({"profileId": profile_id, "sha256": record["sha256"]})

        closure_summaries.append({
            "profile": profile["sourceClosureProfile"],
            "roots": profile["rootPackages"],
            "packageCount": closure["packageCount"],
            "dependencyAlternativeCount": closure["dependencyAlternativeCount"],
            "sourceClosureSha256": sha256(closure_path),
            "packageSetSha256": sha256(manifest_path),
        })
        profile_records.append({"id": profile_id, "directory": str(profile_dir), "packageCount": len(specs)})

    if seen_profiles != set(by_profile):
        fail("EXPECTED_PROFILE_NOT_PRESENT")
    if len(unique_by_name) != plan["expectedPackageUnionCount"]:
        fail("PACKAGE_UNION_COUNT_MISMATCH")
    root_packages = plan.get("rootPackages")
    if not isinstance(root_packages, list) or len(root_packages) != len(set(root_packages)) or not set(root_packages).issubset(unique_by_name):
        fail("AGGREGATE_ROOT_SET_INVALID")
    if "nodejs" in unique_by_name:
        fail("CURRENT_NODEJS_NOT_ALLOWED_IN_LTS_AGGREGATE")

    packages_dir = args.packages_dir.resolve()
    evidence_dir = args.evidence_dir.resolve()
    manifest_out = args.manifest_out.resolve()
    for name in sorted(unique_by_name):
        record = unique_by_name[name]
        shutil.copy2(record["path"], packages_dir / record["file"])
        record["sourceProfiles"].sort()
    package_rows = [
        {"name": row["name"], "version": row["version"], "architecture": row["architecture"], "sha256": row["sha256"]}
        for _, row in sorted(unique_by_name.items())
    ]
    for profile_record in profile_records:
        profile = profile_record["id"]
        source_dir = pathlib.Path(profile_record["directory"])
        target_dir = evidence_dir / "profiles" / profile
        shutil.copytree(source_dir, target_dir)

    aggregate_manifest = {
        "schemaVersion": 1,
        "channel": "candidate-only",
        "qualified": False,
        "productionAllowed": False,
        "testOnlySynthetic": True,
        "testOnlyRoots": root_packages,
        "target": {
            "applicationId": plan["applicationId"],
            "architecture": plan["architecture"],
            "modeledDataDir": plan["modeledDataDir"],
            "modeledPrefix": plan["modeledPrefix"],
        },
        "source": {
            "repository": "https://github.com/termux/termux-packages.git",
            "commit": plan["sourceCommit"],
            "builderImage": plan["builderImage"],
        },
        "sourceClosures": sorted(closure_summaries, key=lambda item: item["profile"]),
        "packageMerge": {
            "inputProfileCount": len(profile_records),
            "inputPackageEntries": sum(row["packageCount"] for row in profile_records),
            "uniquePackageCount": len(package_rows),
            "identicalDuplicateIdentityCount": sum(len(v) - 1 for v in identity_occurrences.values()),
            "conflictingDuplicateIdentityCount": 0,
            "sha256RequiredForDeduplication": True,
        },
        "releaseGate": {
            "publicationAllowed": False,
            "deviceInstall": "NOT RUN",
            "rollback": "NOT RUN",
            "deviceEvidenceSha256": None,
        },
        "packages": package_rows,
    }
    manifest_out.write_text(json.dumps(aggregate_manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    merge_report = {
        "schemaVersion": 1,
        "valid": True,
        "qualified": False,
        "productionAllowed": False,
        "testOnlySynthetic": True,
        "sourceCommit": plan["sourceCommit"],
        "builderImage": plan["builderImage"],
        "architecture": plan["architecture"],
        "profileCount": len(profile_records),
        "rootPackages": root_packages,
        "rootCount": len(root_packages),
        "inputProfilePackageEntries": sum(row["packageCount"] for row in profile_records),
        "uniquePackageCount": len(package_rows),
        "duplicateIdentityCount": sum(len(v) - 1 for v in identity_occurrences.values()),
        "binaryHashComparisons": sum(max(0, len(v) - 1) for v in identity_occurrences.values()),
        "allDuplicateIdentitiesAndHashesEqual": True,
        "deviceInstall": "NOT RUN",
        "deviceRuntimeTest": "NOT RUN",
        "sourceClosures": sorted(closure_summaries, key=lambda item: item["profile"]),
        "packages": [
            {
                "name": row["name"],
                "version": row["version"],
                "architecture": row["architecture"],
                "sha256": row["sha256"],
                "sourceProfiles": row["sourceProfiles"],
            }
            for _, row in sorted(unique_by_name.items())
        ],
    }
    args.merge_report_out.write_text(json.dumps(merge_report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(
        f"AGGREGATE_INPUT_OK profiles={len(profile_records)} entries={merge_report['inputProfilePackageEntries']} "
        f"unique={len(package_rows)} roots={len(root_packages)} duplicate_sha256_checks={merge_report['binaryHashComparisons']} "
        "synthetic=true production=false qualified=false device_install=NOT_RUN"
    )


if __name__ == "__main__":
    main()
