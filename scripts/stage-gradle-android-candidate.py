#!/usr/bin/env python3
"""Stage a short-retention Gradle candidate bundle without signing secrets or worktrees."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
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


def copy_regular(source: Path, destination: Path) -> None:
    need(source.is_file() and not source.is_symlink(), "STAGED_INPUT_NOT_REGULAR:" + str(source))
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def copy_tree(source: Path, destination: Path, label: str) -> int:
    need(source.is_dir() and not source.is_symlink(), "ARTIFACT_DIRECTORY_MISSING:" + str(source))
    count = 0
    for base, dirs, files in os.walk(source, topdown=True, followlinks=False):
        base_path = Path(base)
        for name in list(dirs):
            path = base_path / name
            need(not path.is_symlink(), "ARTIFACT_SYMLINK_DIRECTORY:" + str(path))
            need(path.is_dir(), "ARTIFACT_SPECIAL_DIRECTORY_ENTRY:" + str(path))
        for name in files:
            path = base_path / name
            need(path.is_file() and not path.is_symlink(), "ARTIFACT_NONREGULAR_FILE:" + str(path))
            rel = path.relative_to(source).as_posix()
            safe_rel(rel)
            low = rel.lower()
            need("gnupg" not in low and "private-key" not in low and "secret-key" not in low
                 and "secring" not in low and not low.endswith((".pem", ".p12", ".pfx")),
                 "POTENTIAL_PRIVATE_MATERIAL_IN_SOURCE_ARTIFACT:" + rel)
            copy_regular(path, destination / label / rel)
            count += 1
    need(count > 0, "ARTIFACT_DIRECTORY_EMPTY:" + str(source))
    return count


def files_under(root: Path) -> list[Path]:
    result: list[Path] = []
    for base, dirs, files in os.walk(root, topdown=True, followlinks=False):
        base_path = Path(base)
        for name in list(dirs):
            path = base_path / name
            need(not path.is_symlink() and path.is_dir(), "BUNDLE_SYMLINK_OR_SPECIAL_DIRECTORY:" + str(path))
        for name in files:
            path = base_path / name
            need(path.is_file() and not path.is_symlink(), "BUNDLE_SYMLINK_OR_SPECIAL_FILE:" + str(path))
            result.append(path)
    return sorted(result)


def stage(args: argparse.Namespace) -> dict[str, Any]:
    need(not args.destination.exists(), "BUNDLE_DESTINATION_MUST_BE_NEW")
    args.destination.mkdir(parents=True)
    lock = json.loads(args.input_lock.read_text(encoding="utf-8"))
    build = json.loads(args.build_result.read_text(encoding="utf-8"))
    audit = json.loads(args.audit_report.read_text(encoding="utf-8"))
    assembly = json.loads(args.assembly_report.read_text(encoding="utf-8"))
    base = json.loads(args.base_verification.read_text(encoding="utf-8"))
    feed_validation = json.loads(args.feed_validation.read_text(encoding="utf-8"))
    apt = json.loads(args.apt_proof.read_text(encoding="utf-8"))
    need(build.get("status") == "package-built-and-static-audits-passed-test-only"
         and build.get("installed") is False and build.get("productionAllowed") is False,
         "BUILD_RESULT_INVALID_FOR_BUNDLE")
    need(audit.get("result") == "GRADLE_AARCH64_DEB_STATIC_AUDIT_PASS_TEST_ONLY"
         and audit.get("productionAllowed") is False, "AUDIT_REPORT_INVALID_FOR_BUNDLE")
    need(assembly.get("result") == "ANDROID_GRADLE_DISTRIBUTION_ASSEMBLY_PASS_TEST_CANDIDATE_ONLY"
         and assembly.get("gates", {}).get("productionAllowed") is False
         and assembly.get("gates", {}).get("candidateEligible") is False,
         "ASSEMBLY_REPORT_INVALID_FOR_BUNDLE")
    need(base.get("valid") is True and base.get("packageCount") == 82 and base.get("productionAllowed") is False,
         "BASE82_REPORT_INVALID_FOR_BUNDLE")
    need(feed_validation.get("result") == "GRADLE_SEPARATE_TEST_FEED_PASS_82_BASE_PACKAGES_UNCHANGED_PLUS_ONE"
         and feed_validation.get("feedPackageCount") == 83 and feed_validation.get("productionAllowed") is False
         and feed_validation.get("reservedProductionSigningFingerprintNotUsed") is True
         and feed_validation.get("privateKeyRetained") is False
         and feed_validation.get("aptSimulation") == "PASS; simulated only; no install"
         and feed_validation.get("aptProofSha256") == sha_file(args.apt_proof)
         and feed_validation.get("aptSimulationPlanSha256") == sha_file(args.apt_plan)
         and feed_validation.get("aptSimulationPlanPackageCount") == apt.get("simulatedInstallPlanPackageCount"),
         "FEED_VALIDATION_REPORT_INVALID_FOR_BUNDLE")
    need(apt.get("result") == "APT_SIGNATURE_DOWNLOAD_SIMULATION_PASS_TEST_ONLY"
         and apt.get("installPerformed") is False and apt.get("productionAllowed") is False
         and apt.get("aptSimulationPlanSha256") == sha_file(args.apt_plan)
         and apt.get("reservedProductionSigningKeyUsed") is False,
         "APT_PROOF_INVALID_FOR_BUNDLE")
    need(sha_file(args.package_deb) == build.get("packageSha256") == audit.get("packageSha256"),
         "PACKAGE_HASH_CHAIN_MISMATCH")
    need(sha_file(args.assembled_zip) == assembly.get("distribution", {}).get("sha256"),
         "ASSEMBLED_DISTRIBUTION_HASH_CHAIN_MISMATCH")
    need(sha_file(args.host_distribution_zip) == lock["gradleSourceBuild"]["hostDistributionSha256"],
         "HOST_DISTRIBUTION_HASH_MISMATCH")
    need(sha_file(args.base_inventory) == lock["base82Cohort"]["inventorySha256"]
         and sha_file(args.upstream_base82_manifest) == lock["base82Cohort"]["embeddedManifestSha256"],
         "BASE82_PROVENANCE_FILE_HASH_MISMATCH")

    # Copy only the signed test feed's data/index/signatures; never copy the GPG home.
    feed = args.feed_root
    need(feed.is_dir() and not feed.is_symlink(), "CANDIDATE_FEED_ROOT_MISSING")
    allowed_top = {"pool", "dists", "Release"}
    need({p.name for p in feed.iterdir()} == allowed_top, "UNEXPECTED_CANDIDATE_FEED_TOP_LEVEL_CONTENT")
    all_feed_files = files_under(feed)
    pool_files = files_under(feed / "pool")
    expected_metadata = {"Release", "dists/stable/Release", "dists/stable/InRelease",
                         "dists/stable/Release.gpg", "dists/stable/main/binary-aarch64/Packages",
                         "dists/stable/main/binary-aarch64/Packages.gz"}
    expected_feed_files = expected_metadata | {p.relative_to(feed).as_posix() for p in pool_files}
    need({p.relative_to(feed).as_posix() for p in all_feed_files} == expected_feed_files
         and len(pool_files) == 83 and all(p.suffix == ".deb" for p in pool_files),
         "SIGNED_FEED_FILE_SET_NOT_EXACTLY_83_DEBS_AND_METADATA")
    for rel in ("Release", "dists/stable/Release", "dists/stable/InRelease", "dists/stable/Release.gpg",
                "dists/stable/main/binary-aarch64/Packages", "dists/stable/main/binary-aarch64/Packages.gz"):
        copy_regular(feed / rel, args.destination / "signed-feed" / rel)
    for path in pool_files:
        rel = path.relative_to(feed).as_posix()
        safe_rel(rel)
        need(path.suffix == ".deb", "SIGNED_FEED_POOL_NON_DEB:" + rel)
        copy_regular(path, args.destination / "signed-feed" / rel)

    key_manifest = args.signing_config_root / "keys/feed-signing.json"
    need(args.signing_config_root.is_dir() and not args.signing_config_root.is_symlink(),
         "EPHEMERAL_SIGNING_ROOT_NOT_REGULAR_DIRECTORY")
    manifest_obj = json.loads(key_manifest.read_text(encoding="utf-8"))
    key_rel = safe_rel(str(manifest_obj.get("publicKeyring", "")))
    public_key = args.signing_config_root.joinpath(*key_rel.parts)
    need(public_key.is_file() and not public_key.is_symlink(), "EPHEMERAL_PUBLIC_KEYRING_MISSING")
    need(sha_file(public_key) == manifest_obj.get("publicKeyringSha256"), "EPHEMERAL_PUBLIC_KEYRING_HASH_MISMATCH")
    need(manifest_obj.get("status") == "ephemeral-only; no production feed publication",
         "FEED_SIGNING_KEY_NOT_EPHEMERAL")
    allowed_keyroot = {"keys", "gnupg", "gpg-generate.log"}
    need({p.name for p in args.signing_config_root.iterdir()} == allowed_keyroot,
         "EPHEMERAL_SIGNING_ROOT_HAS_UNEXPECTED_TOP_LEVEL_FILES")
    need({p.name for p in (args.signing_config_root / "keys").iterdir()}
         == {"feed-signing.json", "aibuilder-termux-feed-keyring.gpg"},
         "EPHEMERAL_SIGNING_KEYS_DIRECTORY_HAS_UNEXPECTED_FILES")
    copy_regular(key_manifest, args.destination / "public-key/feed-signing.json")
    copy_regular(public_key, args.destination / "public-key/aibuilder-termux-feed-keyring.gpg")

    for src, rel in ((args.input_lock, "metadata/gradle-android-package-candidate-inputs.json"),
                     (args.base_verification, "reports/base82-verification.json"),
                     (args.assembly_report, "reports/android-distribution-assembly.json"),
                     (args.build_result, "reports/build-result.json"),
                     (args.audit_report, "reports/package-audit.json"),
                     (args.feed_validation, "reports/feed-validation.json"),
                     (args.apt_proof, "reports/apt-simulation-proof.json"),
                     (args.package_hashes, "reports/package-SHA256SUMS"),
                     (args.recipe_patch, "reports/app-private-gradle-recipe.patch"),
                     (args.package_log, "reports/package-build.log"),
                     (args.apt_log, "reports/apt-simulation.log"),
                     (args.apt_plan, "reports/apt-simulation-plan.log"),
                     (args.base_inventory, "metadata/aggregate-archive-inventory.json")):
        copy_regular(src, args.destination / rel)
    copy_regular(args.assembled_zip, args.destination / "distribution/gradle-9.8.2-android-aarch64.zip")
    copy_regular(args.host_distribution_zip, args.destination / "distribution/gradle-9.8.2-bin-source-built-host.zip")
    copy_regular(args.package_deb, args.destination / "candidate-package" / args.package_deb.name)

    for source, label in ((args.gradle_artifact_dir, "source-artifacts/gradle-host-build"),
                          (args.native_java_artifact_dir, "source-artifacts/native-platform-java"),
                          (args.android_core_artifact_dir, "source-artifacts/native-platform-android-prototype")):
        copy_tree(source, args.destination, label)
    copy_regular(args.upstream_base82_manifest, args.destination / "metadata/base82-aggregate-manifest.json")
    copy_regular(args.base_replay_summary, args.destination / "metadata/base82-replay-summary.json")
    base_feed = args.base_feed_root
    need(base_feed.is_dir() and not base_feed.is_symlink(), "BASE82_FEED_ROOT_MISSING")
    base_signing = json.loads((base_feed / "keys/feed-signing.json").read_text(encoding="utf-8"))
    base_key_rel = safe_rel(str(base_signing.get("publicKeyring", "")))
    base_key = base_feed.joinpath(*base_key_rel.parts)
    need(base_key.is_file() and not base_key.is_symlink(), "BASE82_PUBLIC_KEYRING_NOT_REGULAR")
    need(base_signing.get("fingerprint") == lock["base82Cohort"]["signingFingerprint"]
         and base_signing.get("publicKeyringSha256") == lock["base82Cohort"]["publicKeyringSha256"]
         and sha_file(base_key) == lock["base82Cohort"]["publicKeyringSha256"],
         "BASE82_SIGNING_KEY_PROVENANCE_MISMATCH")
    base_metadata = (
        "aggregate-manifest.json.asc", "keys/feed-signing.json", "keys/aibuilder-termux-feed-keyring.gpg",
        "dists/stable/Release", "dists/stable/InRelease", "dists/stable/Release.gpg",
        "dists/stable/main/binary-aarch64/Packages", "dists/stable/main/binary-aarch64/Packages.gz",
    )
    for rel in base_metadata:
        copy_regular(base_feed / rel, args.destination / "metadata/base82-signed-feed" / rel)

    staged = files_under(args.destination)
    # The private signing home is never traversed or copied; assert no suspicious key paths remain.
    for path in staged:
        rel = path.relative_to(args.destination).as_posix().lower()
        need("gnupg" not in rel and "secring" not in rel and "private-key" not in rel
             and not rel.endswith((".pem", ".p12", ".pfx")), "PRIVATE_SIGNING_MATERIAL_PATH_IN_BUNDLE:" + rel)
    entries = [{"path": path.relative_to(args.destination).as_posix(), "sizeBytes": path.stat().st_size,
                "sha256": sha_file(path)} for path in staged]
    manifest = {
        "schemaVersion": 1,
        "classification": "SHORT_RETENTION_TEST_ONLY_CANDIDATE_EVIDENCE",
        "repository": lock["repository"],
        "branch": lock["branch"],
        "applicationId": lock["applicationId"],
        "package": lock["package"],
        "feedPackageCount": 83,
        "base82Unchanged": True,
        "feedSignatureKey": "ephemeral; public key included; private key never retained",
        "androidDeviceRuntime": "NOT_RUN",
        "aptSimulation": "PASS; simulated only; no install",
        "aptSimulationPlanPackageCount": apt.get("simulatedInstallPlanPackageCount"),
        "candidateEligible": False,
        "qualified": False,
        "productionAllowed": False,
        "privateSigningMaterialIncluded": False,
        "fileCount": len(entries),
        "files": entries,
    }
    manifest_path = args.destination / "bundle-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    specs = {
        "destination": (Path, True), "input-lock": (Path, True), "feed-root": (Path, True),
        "signing-config-root": (Path, True), "package-deb": (Path, True), "package-hashes": (Path, True),
        "package-log": (Path, True), "recipe-patch": (Path, True), "build-result": (Path, True),
        "audit-report": (Path, True), "assembly-report": (Path, True), "assembled-zip": (Path, True),
        "host-distribution-zip": (Path, True), "base-verification": (Path, True), "base-inventory": (Path, True),
        "upstream-base82-manifest": (Path, True), "base-replay-summary": (Path, True),
        "base-feed-root": (Path, True), "feed-validation": (Path, True), "apt-proof": (Path, True),
        "apt-log": (Path, True), "apt-plan": (Path, True), "gradle-artifact-dir": (Path, True),
        "native-java-artifact-dir": (Path, True), "android-core-artifact-dir": (Path, True),
    }
    for name, (kind, required) in specs.items():
        parser.add_argument("--" + name, type=kind, required=required)
    args = parser.parse_args()
    try:
        manifest = stage(args)
        print("GRADLE_CANDIDATE_RETENTION_BUNDLE_STAGED files=" + str(manifest["fileCount"])
              + " feed=83 private_key=excluded production=false")
        return 0
    except Exception as exc:
        print("ERROR:" + f"{type(exc).__name__}:{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
