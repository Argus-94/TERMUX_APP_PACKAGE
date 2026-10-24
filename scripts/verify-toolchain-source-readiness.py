#!/usr/bin/env python3
"""Verify a metadata-only toolchain readiness inventory against pinned recipes.

This checks source inventory facts only. It never downloads sources, builds
packages, signs a feed, installs anything, or qualifies an Android runtime.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
from typing import Any

PIN = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
REPOSITORY = "https://github.com/termux/termux-packages.git"
APP_ID = "com.karat.aibuilder"
PROFILES = {
    "clang-source-reference": ("clang", 15, 19),
    "gradle-recipe-reference": ("gradle", 39, 63),
    "ndk-sysroot-recipe-reference": ("ndk-sysroot", 1, 0),
}


class GateError(Exception):
    pass


def require(condition: bool, code: str) -> None:
    if not condition:
        raise GateError(code)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: pathlib.Path, code: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError(code) from exc
    require(isinstance(value, dict), code)
    return value


def verify_source_checkout(source_root: pathlib.Path) -> None:
    try:
        commit = subprocess.run(
            ["git", "-C", str(source_root), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "-C", str(source_root), "status", "--porcelain=v1"],
            check=True, capture_output=True, text=True, timeout=20,
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateError("SOURCE_GIT_STATE_UNAVAILABLE") from exc
    require(commit == PIN, "SOURCE_COMMIT_MISMATCH")
    require(not status.strip(), "SOURCE_WORKTREE_NOT_CLEAN")


def verify_manifest_gates(manifest: dict[str, Any]) -> None:
    require(manifest.get("schemaVersion") == 1, "INVENTORY_SCHEMA_UNSUPPORTED")
    require(manifest.get("status") == "inventory-only; not a build, package, install, signing, or publication authorization",
            "INVENTORY_STATUS_NOT_METADATA_ONLY")
    require(manifest.get("sourceRepository") == REPOSITORY and manifest.get("sourceCommit") == PIN,
            "INVENTORY_SOURCE_PIN_MISMATCH")
    target = manifest.get("target", {})
    require(target.get("applicationId") == APP_ID and target.get("hostArchitecture") == "aarch64",
            "INVENTORY_TARGET_MISMATCH")
    gates = manifest.get("gates", {})
    expected_gates = {
        "packageBuild": "NOT_RUN",
        "candidateDebs": "NOT_CREATED",
        "signedCandidateFeed": "NOT_CREATED",
        "aptSimulation": "NOT_RUN",
        "androidInstall": "NOT_RUN",
        "androidToolRuntime": "NOT_RUN",
        "projectApkBuild": "NOT_RUN",
        "upgradeRollback": "NOT_RUN",
        "qualified": False,
        "productionAllowed": False,
        "publicationAllowed": False,
    }
    require(gates == expected_gates, "INVENTORY_GATES_MUST_REMAIN_CLOSED")
    profiles = manifest.get("profiles", {})
    require(set(profiles) == {"clang", "gradle", "android-sdk", "android-ndk"},
            "INVENTORY_PROFILE_SET_MISMATCH")
    require(all(p.get("candidateEligible") is False for p in profiles.values()),
            "PROFILE_CANDIDATE_MUST_REMAIN_CLOSED")
    require(profiles["clang"].get("blockingDependency", {}).get("package") == "ndk-sysroot",
            "CLANG_SYSROOT_BLOCKER_MISSING")
    require(profiles["android-sdk"].get("sourceRecipe") is None,
            "SDK_SOURCE_RECIPE_MUST_NOT_BE_INVENTED")


def verify_recipe_inputs(repo_root: pathlib.Path, manifest: dict[str, Any],
                         source_root: pathlib.Path) -> None:
    profiles = manifest["profiles"]
    inputs: list[tuple[str, str]] = []
    inputs.append((profiles["clang"]["upstreamRecipe"]["path"],
                   profiles["clang"]["upstreamRecipe"]["sha256"]))
    inputs.append((profiles["clang"]["clangSubpackage"]["path"],
                   profiles["clang"]["clangSubpackage"]["sha256"]))
    inputs.append((profiles["gradle"]["upstreamRecipe"]["path"],
                   profiles["gradle"]["upstreamRecipe"]["sha256"]))
    inputs.append((profiles["android-ndk"]["upstreamRecipe"]["path"],
                   profiles["android-ndk"]["upstreamRecipe"]["sha256"]))
    for relative, expected in inputs:
        require(re.fullmatch(r"[a-f0-9]{64}", expected) is not None,
                "RECIPE_HASH_FORMAT_INVALID")
        path = source_root / relative
        require(path.is_file() and not path.is_symlink(), "PINNED_RECIPE_FILE_MISSING")
        require(sha256(path) == expected, "PINNED_RECIPE_HASH_MISMATCH:" + relative)

    libllvm = (source_root / profiles["clang"]["upstreamRecipe"]["path"]).read_text(encoding="utf-8")
    gradle = (source_root / profiles["gradle"]["upstreamRecipe"]["path"]).read_text(encoding="utf-8")
    ndk = (source_root / profiles["android-ndk"]["upstreamRecipe"]["path"]).read_text(encoding="utf-8")
    checks = [
        ("TERMUX_PKG_VERSION=\"21.1.8\"" in libllvm, "LLVM_VERSION_MISMATCH"),
        ("TERMUX_PKG_REVISION=3" in libllvm, "LLVM_REVISION_MISMATCH"),
        ("4633a23617fa31a3ea51242586ea7fb1da7140e426bd62fc164261fe036aa142" in libllvm,
         "LLVM_SOURCE_SHA_MISMATCH"),
        ("TERMUX_PKG_VERSION=\"1:9.8.1\"" in gradle, "GRADLE_REFERENCE_VERSION_MISMATCH"),
        ("gradle-${TERMUX_PKG_VERSION:2}-bin.zip" in gradle,
         "GRADLE_REFERENCE_MUST_REMAIN_BINARY_CLASSIFIED"),
        ("dce76f55f8e251a3a1f130eb120f30b3d271de2b76c9b0729d316b5a1b6dc01f" in gradle,
         "GRADLE_BINARY_REFERENCE_SHA_MISMATCH"),
        ("TERMUX_PKG_VERSION=30" in ndk, "NDK_REFERENCE_VERSION_MISMATCH"),
        ("android-ndk-r${TERMUX_PKG_VERSION}-linux.zip" in ndk,
         "NDK_REFERENCE_MUST_REMAIN_LINUX_ARCHIVE"),
        ("753611f410d002cfcd3f3dc2ef49aad532089d3180b436c060a90bf0fcb64df2" in ndk,
         "NDK_REFERENCE_SHA_MISMATCH"),
    ]
    for condition, code in checks:
        require(condition, code)

    gradle_source = profiles["gradle"]["sourceArchiveResearchPin"]
    require(gradle_source.get("version") == "9.8.2"
            and gradle_source.get("url") == "https://services.gradle.org/distributions/gradle-9.8.2-src.zip"
            and gradle_source.get("sha256") == "96c9aba0564daa2998f578b589eba9ae1f6656e368fde85f7132e05321bab553",
            "GRADLE_SOURCE_RESEARCH_PIN_MISMATCH")
    require(gradle_source.get("kind") == "official source archive; checksum verified and wrapper inspected; not built or qualified as package input",
            "GRADLE_SOURCE_INPUT_MUST_REMAIN_UNQUALIFIED")
    inspection = profiles["gradle"].get("sourceArchiveInspection")
    evidence = read_json(repo_root / "docs/evidence/gradle-source-bootstrap-inspection.json",
                         "GRADLE_SOURCE_INSPECTION_EVIDENCE_UNREADABLE")
    require(inspection == evidence, "GRADLE_SOURCE_INSPECTION_EVIDENCE_MISMATCH")
    require(evidence.get("result") == "SOURCE_ARCHIVE_INTEGRITY_AND_WRAPPER_INSPECTION_OK"
            and evidence.get("archive", {}).get("sha256") == gradle_source.get("sha256")
            and evidence.get("wrapper", {}).get("distributionUrl")
            == "https://services.gradle.org/distributions/gradle-9.8.1-bin.zip"
            and evidence.get("wrapper", {}).get("distributionSha256Sum") is None
            and evidence.get("bootstrap", {}).get("decision") == "BLOCKED_PREBUILT_GRADLE_BINARY"
            and evidence.get("bootstrap", {}).get("wrapperExecuted") is False
            and evidence.get("bootstrap", {}).get("binaryDistributionDownloaded") is False
            and evidence.get("gates", {}).get("candidateEligible") is False
            and evidence.get("gates", {}).get("productionAllowed") is False,
            "GRADLE_SOURCE_BOOTSTRAP_MUST_REMAIN_BLOCKED")

    assessment = read_json(repo_root / "docs/evidence/gradle-source-bootstrap-assessment.json",
                           "GRADLE_SOURCE_BOOTSTRAP_ASSESSMENT_UNREADABLE")
    require(profiles["gradle"].get("sourceBuildAssessment") == assessment,
            "GRADLE_SOURCE_BOOTSTRAP_ASSESSMENT_EVIDENCE_MISMATCH")
    bootstrap = assessment.get("bootstrapEnvironment", {})
    guide = assessment.get("source", {})
    wrapper = assessment.get("wrapper", {})
    inputs = assessment.get("sourceBuildInputs", {})
    runtime = assessment.get("targetRuntime", {})
    decision = assessment.get("decision", {})
    require(guide.get("gradleVersion") == "9.8.2"
            and guide.get("sourceArchiveSha256") == gradle_source.get("sha256")
            and guide.get("officialBuildGuideUrl")
            == "https://raw.githubusercontent.com/gradle/gradle/v9.8.2/CONTRIBUTING.md"
            and guide.get("officialBuildGuideSha256")
            == "ecd3a59475130cf9376b0050408e47aacb7a78ab83182fd17c2ef0f362254751"
            and guide.get("officialDistributionBuildCommand")
            == "./gradlew :distributions-full:binDistributionZip"
            and guide.get("officialBuildUsesCommittedWrapper") is True,
            "GRADLE_OFFICIAL_SOURCE_BUILD_INSTRUCTIONS_MISMATCH")
    require(wrapper.get("distributionUrl")
            == "https://services.gradle.org/distributions/gradle-9.8.1-bin.zip"
            and wrapper.get("distributionSha256Sum") is None
            and wrapper.get("executed") is False
            and wrapper.get("binaryDistributionDownloaded") is False
            and bootstrap.get("gradleExecutableOnPath") is False
            and bootstrap.get("cachedGradleVersions") == ["8.14.3", "9.3.1"]
            and bootstrap.get("cachedGradleProvenancePinned") is False
            and bootstrap.get("cachedGradleVersionsUsed") is False
            and bootstrap.get("configuredWrapperVersionCached") is False
            and bootstrap.get("trustedPinnedBootstrapAvailable") is False
            and bootstrap.get("sourceOnlyBootstrapPathFound") is False
            and bootstrap.get("sourceBuildStarted") is False
            and bootstrap.get("decision") == "BLOCKED_NO_TRUSTED_PINNED_BOOTSTRAP",
            "GRADLE_BOOTSTRAP_ASSESSMENT_MUST_REMAIN_BLOCKED")
    require(inputs.get("verificationMetadataPath")
            == "gradle-9.8.2/gradle/verification-metadata.xml"
            and inputs.get("verificationMetadataSha256")
            == "d9f3cb20522e9a7186160464f818b6635111c71b68d78084527a36e5180fa67e"
            and inputs.get("verifiedComponentCount") == 88
            and inputs.get("verifiedArtifactCount") == 98
            and inputs.get("sha256MetadataCount") == 94
            and inputs.get("pgpMetadataCount") == 4
            and inputs.get("repositoriesObservedInBuildSettings")
            == ["mavenCentral()", "gradlePluginPortal()"]
            and inputs.get("dependencyResolutionIsSelfContainedInSourceArchive") is False,
            "GRADLE_SOURCE_BUILD_INPUTS_MISMATCH")
    require(runtime.get("gradleJvmRange") == "17-27"
            and runtime.get("bundledOpenJdk17VersionCheck") == "PASS_VERSION_RANGE_ONLY"
            and runtime.get("activeGradlePlatformMatrixIncludesAndroidBionic") is False
            and runtime.get("androidBionicArm64Runtime") == "NOT_VERIFIED"
            and runtime.get("nativeLoaderAndNeededLibraries")
            == "UNKNOWN_NO_BUILT_DISTRIBUTION_OR_ELF_TO_AUDIT"
            and runtime.get("deviceProof") == "NOT_RUN"
            and decision.get("result")
            == "NO_REPRODUCIBLE_SOURCE_ONLY_BOOTSTRAP_IN_CURRENT_ENVIRONMENT"
            and decision.get("sourceBuildComplete") is False
            and decision.get("packageBuilt") is False
            and decision.get("candidateEligible") is False
            and decision.get("androidRuntimeQualified") is False
            and decision.get("productionAllowed") is False,
            "GRADLE_ANDROID_BIONIC_AND_PACKAGE_GATES_MUST_REMAIN_CLOSED")


def verify_closure_inventories(repo_root: pathlib.Path, source_root: pathlib.Path,
                               manifest: dict[str, Any]) -> None:
    base = read_json(repo_root / "termux-package-source-scope.json", "SOURCE_SCOPE_UNREADABLE")
    require(base.get("sourceRepository") == REPOSITORY and base.get("sourceCommit") == PIN
            and base.get("inventoryOnly") is True and base.get("candidateInstallable") is False,
            "BASE_SOURCE_SCOPE_POLICY_MISMATCH")
    resolver = repo_root / "scripts/resolve-pinned-termux-recipe-closure.py"
    require(resolver.is_file(), "SOURCE_CLOSURE_RESOLVER_MISSING")
    profile_specs = manifest["profiles"]
    with tempfile.TemporaryDirectory(prefix="toolchain-readiness-") as temp_name:
        temp = pathlib.Path(temp_name)
        for profile_name, (root_name, package_count, alternatives) in PROFILES.items():
            scope = {key: value for key, value in base.items()
                     if key not in ("profiles", "dependencyChoices")}
            scope["profiles"] = {profile_name: [root_name]}
            scope["dependencyChoices"] = {}
            scope_path = temp / (profile_name + ".scope.json")
            scope_path.write_text(json.dumps(scope), encoding="utf-8")
            try:
                result = subprocess.run(
                    [sys.executable, str(resolver), "--source-root", str(source_root),
                     "--scope", str(scope_path), "--profile", profile_name],
                    check=True, capture_output=True, timeout=60,
                )
            except (OSError, subprocess.SubprocessError) as exc:
                raise GateError("SOURCE_CLOSURE_RESOLUTION_FAILED:" + profile_name) from exc
            closure = json.loads(result.stdout)
            expected = profile_specs[
                "clang" if root_name == "clang" else
                "gradle" if root_name == "gradle" else "android-ndk"
            ]["sourceClosureInventory"]
            actual_sha = hashlib.sha256(result.stdout).hexdigest()
            require(closure.get("sourceCommit") == PIN and closure.get("profile") == profile_name
                    and closure.get("rootPackages") == [root_name],
                    "SOURCE_CLOSURE_IDENTITY_MISMATCH:" + profile_name)
            require(closure.get("packageCount") == package_count
                    and closure.get("dependencyAlternativeCount") == alternatives,
                    "SOURCE_CLOSURE_COUNTS_MISMATCH:" + profile_name)
            require(expected.get("profile") == profile_name and expected.get("roots") == [root_name]
                    and expected.get("packageCount") == package_count
                    and expected.get("dependencyAlternativeCount") == alternatives
                    and expected.get("sha256") == actual_sha,
                    "SOURCE_CLOSURE_FINGERPRINT_MISMATCH:" + profile_name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument("--source-root", required=True, type=pathlib.Path)
    args = parser.parse_args()
    repo_root = args.repo_root.resolve()
    source_root = args.source_root.resolve()
    manifest = read_json(repo_root / "toolchain-source-readiness-inventory.json",
                         "TOOLCHAIN_READINESS_INVENTORY_UNREADABLE")
    verify_source_checkout(source_root)
    verify_manifest_gates(manifest)
    verify_recipe_inputs(repo_root, manifest, source_root)
    verify_closure_inventories(repo_root, source_root, manifest)
    print("TOOLCHAIN_SOURCE_READINESS_INVENTORY_OK profiles=4 reference_closures=3 "
          "package_build=NOT_RUN signed_feed=NOT_CREATED android=NOT_RUN "
          "qualified=false production=false")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GateError as exc:
        print("ERROR:" + str(exc), file=sys.stderr)
        raise SystemExit(2)
