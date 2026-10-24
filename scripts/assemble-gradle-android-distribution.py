#!/usr/bin/env python3
"""Verify pinned CI artifacts and assemble a deterministic Android/Bionic-only Gradle tree."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import zipfile
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


def load_json(path: Path) -> dict[str, Any]:
    need(path.is_file() and not path.is_symlink(), "EVIDENCE_NOT_REGULAR:" + str(path))
    obj = json.loads(path.read_text(encoding="utf-8"))
    need(isinstance(obj, dict), "EVIDENCE_JSON_ROOT_NOT_OBJECT:" + str(path))
    return obj


def find_one(root: Path, predicate, code: str) -> tuple[Path, dict[str, Any]]:
    matches: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(root.rglob("*.json")):
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 20_000_000:
            continue
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(obj, dict) and predicate(obj):
            matches.append((path, obj))
    need(len(matches) == 1, code + f":FOUND_{len(matches)}")
    return matches[0]


def evidence_file(root: Path, record: dict[str, Any], expected_sha: str, code: str) -> Path:
    rel = safe_rel(str(record.get("path", "")))
    path = root.joinpath(*rel.parts)
    need(path.is_file() and not path.is_symlink(), code + "_NOT_REGULAR")
    need(record.get("sha256") == expected_sha and sha_file(path) == expected_sha,
         code + "_SHA256_MISMATCH")
    return path


def read_jar(path: Path, code: str) -> tuple[dict[str, str], list[str]]:
    try:
        with zipfile.ZipFile(path, "r") as jar:
            names = [item.filename for item in jar.infolist()]
            need(len(names) == len(set(names)), code + "_DUPLICATE_ENTRY")
            need(jar.testzip() is None, code + "_CRC_FAILURE")
            content: dict[str, str] = {}
            for info in jar.infolist():
                name = info.filename[:-1] if info.is_dir() and info.filename.endswith("/") else info.filename
                safe_rel(name)
                need(not (info.flag_bits & 0x1), code + "_ENCRYPTED_ENTRY")
                mode = (info.external_attr >> 16) & 0xFFFF
                ftype = stat.S_IFMT(mode)
                if info.is_dir():
                    need(ftype in (0, stat.S_IFDIR), code + "_NONDIR_DIRECTORY_ENTRY")
                    continue
                need(ftype in (0, stat.S_IFREG), code + "_NONREGULAR_ENTRY:" + name)
                content[info.filename] = hashlib.sha256(jar.read(info)).hexdigest()
            return content, names
    except (OSError, zipfile.BadZipFile) as exc:
        raise ValueError(code + "_INVALID_ZIP:" + str(exc)) from exc


def readelf_report(path: Path) -> dict[str, Any]:
    header = subprocess.run(["readelf", "-h", str(path)], check=True, capture_output=True, text=True).stdout
    dynamic = subprocess.run(["readelf", "-d", str(path)], check=True, capture_output=True, text=True).stdout
    symbols = subprocess.run(["nm", "-D", str(path)], check=True, capture_output=True, text=True).stdout
    version = subprocess.run(["readelf", "--version-info", str(path)], check=True,
                             capture_output=True, text=True).stdout
    need("Class:                             ELF64" in header and "Machine:                           AArch64" in header,
         "ANDROID_CORE_ELF_ARCHITECTURE_MISMATCH")
    need("Type:                              DYN" in header, "ANDROID_CORE_ELF_NOT_SHARED_OBJECT")
    sonames = re.findall(r"\(SONAME\).*\[([^]]+)\]", dynamic)
    needed = sorted(set(re.findall(r"\(NEEDED\).*\[([^]]+)\]", dynamic)))
    need(sonames == ["libnative-platform.so"], "ANDROID_CORE_SONAME_MISMATCH")
    need(needed == ["libc.so", "libdl.so", "libm.so"], "ANDROID_CORE_DT_NEEDED_MISMATCH:" + repr(needed))
    need(not re.search(r"\(RPATH\)|\(RUNPATH\)", dynamic), "ANDROID_CORE_RPATH_OR_RUNPATH_PRESENT")
    need("GLIBC_" not in symbols and "GLIBC_" not in version
         and b"GLIBC_" not in path.read_bytes(), "ANDROID_CORE_GLIBC_VERSIONED_SYMBOLS_FOUND")
    exports = sorted(set(re.findall(r"Java_net_rubygrapefruit_platform_internal_jni_[A-Za-z0-9_]+", symbols)))
    need(bool(exports), "ANDROID_CORE_JNI_EXPORTS_MISSING")
    return {"class": "ELF64", "machine": "AArch64", "type": "DYN", "soname": sonames[0],
            "needed": needed, "glibcVersionedSymbols": False, "rpathOrRunpath": False,
            "exportedJniSymbolCount": len(exports)}


def extract_distribution(source_zip: Path, dest: Path) -> dict[str, Any]:
    need(not dest.exists(), "GRADLE_EXTRACT_DESTINATION_MUST_BE_NEW")
    dest.mkdir(parents=True)
    total = 0
    file_count = 0
    seen: set[str] = set()
    try:
        with zipfile.ZipFile(source_zip, "r") as archive:
            infos = archive.infolist()
            need(len(infos) < 100_000, "GRADLE_DISTRIBUTION_MEMBER_LIMIT")
            need(archive.testzip() is None, "GRADLE_DISTRIBUTION_ZIP_CRC_FAILURE")
            for info in infos:
                raw_name = info.filename[:-1] if info.is_dir() and info.filename.endswith("/") else info.filename
                rel = safe_rel(raw_name)
                need(rel.parts[0] == "gradle-9.8.2", "GRADLE_DISTRIBUTION_ROOT_MISMATCH:" + raw_name)
                need(raw_name not in seen, "GRADLE_DISTRIBUTION_DUPLICATE_MEMBER:" + raw_name)
                seen.add(raw_name)
                if info.flag_bits & 0x1:
                    raise ValueError("GRADLE_DISTRIBUTION_ENCRYPTED_ENTRY:" + raw_name)
                mode = (info.external_attr >> 16) & 0xFFFF
                ftype = stat.S_IFMT(mode)
                if info.is_dir():
                    need(ftype in (0, stat.S_IFDIR), "GRADLE_DISTRIBUTION_NONDIR_DIRECTORY_ENTRY:" + raw_name)
                    target = dest.joinpath(*rel.parts)
                    target.mkdir(parents=True, exist_ok=True)
                    target.chmod(0o755)
                    continue
                need(ftype in (0, stat.S_IFREG), "GRADLE_DISTRIBUTION_NONREGULAR_ENTRY:" + raw_name)
                total += info.file_size
                file_count += 1
                need(total <= 1_500_000_000, "GRADLE_DISTRIBUTION_EXPANDED_SIZE_LIMIT")
                target = dest.joinpath(*rel.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info, "r") as src, target.open("xb") as out:
                    shutil.copyfileobj(src, out, 1024 * 1024)
                permissions = stat.S_IMODE(mode) or 0o644
                need(not permissions & (stat.S_ISUID | stat.S_ISGID), "GRADLE_DISTRIBUTION_SETID_FILE")
                target.chmod(permissions)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ValueError("GRADLE_DISTRIBUTION_ZIP_INVALID:" + str(exc)) from exc
    root = dest / "gradle-9.8.2"
    need(root.is_dir() and (root / "bin/gradle").is_file() and os.access(root / "bin/gradle", os.X_OK),
         "GRADLE_DISTRIBUTION_LAUNCHER_MISSING_OR_NOT_EXECUTABLE")
    need((root / "version.txt").read_text(encoding="utf-8").strip() == "9.8.2",
         "GRADLE_DISTRIBUTION_VERSION_FILE_MISMATCH")
    need((root / "LICENSE").is_file() and (root / "NOTICE").is_file(),
         "GRADLE_DISTRIBUTION_LICENSE_OR_NOTICE_MISSING")
    return {"root": str(root), "fileCount": file_count, "expandedBytes": total}


def write_deterministic_target_jar(path: Path, resource: str, library: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    info = zipfile.ZipInfo(resource, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.flag_bits = 0
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as jar:
        jar.writestr(info, library.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    content, names = read_jar(path, "ANDROID_TARGET_RESOURCE_JAR")
    need(names == [resource] and list(content) == [resource], "ANDROID_TARGET_RESOURCE_JAR_LAYOUT_MISMATCH")
    return sha_file(path)


def deterministic_zip(tree: Path, output: Path) -> tuple[str, int]:
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(output.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        paths = sorted(tree.rglob("*"), key=lambda p: p.relative_to(tree).as_posix())
        for path in paths:
            rel = path.relative_to(tree).as_posix()
            safe_rel(rel)
            need(not path.is_symlink(), "GRADLE_OUTPUT_TREE_SYMLINK:" + rel)
            if path.is_dir():
                info = zipfile.ZipInfo(rel + "/", date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFDIR | 0o755) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, b"")
            else:
                need(path.is_file(), "GRADLE_OUTPUT_TREE_NONREGULAR:" + rel)
                info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | stat.S_IMODE(path.stat().st_mode)) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                with path.open("rb") as stream, archive.open(info, "w") as target:
                    shutil.copyfileobj(stream, target, 1024 * 1024)
    with zipfile.ZipFile(tmp, "r") as archive:
        need(archive.testzip() is None, "ANDROID_GRADLE_ZIP_CRC_FAILURE")
        names = [info.filename for info in archive.infolist()]
        need(len(names) == len(set(names)), "ANDROID_GRADLE_ZIP_DUPLICATE_PATH")
        need(all(not (info.external_attr >> 16 & 0o170000) == stat.S_IFLNK for info in archive.infolist()),
             "ANDROID_GRADLE_ZIP_SYMLINK")
    tmp.replace(output)
    return sha_file(output), output.stat().st_size


def verify_inputs(lock: dict[str, Any], gradle_root: Path, java_root: Path, android_root: Path,
                  temp_dir: Path) -> dict[str, Any]:
    gpin = lock["gradleSourceBuild"]
    gradle_evidence_path, ge = find_one(
        gradle_root, lambda obj: obj.get("result") == "SOURCE_BUILD_SUCCESS_HOST_ONLY",
        "GRADLE_SOURCE_BUILD_EVIDENCE")
    need(ge.get("run", {}).get("commit") == gpin["hostBuildCommit"], "GRADLE_SOURCE_BUILD_COMMIT_MISMATCH")
    need(ge.get("run", {}).get("ref") == "refs/heads/" + lock["branch"], "GRADLE_SOURCE_BUILD_REF_MISMATCH")
    need(ge.get("source", {}).get("actualSha256") == gpin["sourceSha256"]
         and ge.get("source", {}).get("expectedSha256") == gpin["sourceSha256"],
         "GRADLE_SOURCE_ARCHIVE_SHA256_MISMATCH")
    need(ge.get("bootstrap", {}).get("actualSha256") == gpin["bootstrapGradleSha256"],
         "GRADLE_BOOTSTRAP_SHA256_MISMATCH")
    need(ge.get("build", {}).get("commandExitCode") == 0, "GRADLE_SOURCE_BUILD_NONZERO")
    need(ge.get("runner", {}).get("sourceBuildStep") == "success"
         and ge.get("runner", {}).get("distributionAuditStep") == "success", "GRADLE_SOURCE_BUILD_STEPS_NOT_SUCCESS")
    go = ge.get("outputDistribution", {})
    need(go.get("filename") == gpin["hostDistributionFilename"]
         and go.get("sha256") == gpin["hostDistributionSha256"]
         and go.get("sizeBytes") == gpin["hostDistributionSizeBytes"]
         and go.get("integrityCheckExitCode") == 0 and go.get("hostOnly") is True,
         "GRADLE_HOST_DISTRIBUTION_EVIDENCE_MISMATCH")
    gs = ge.get("scope", {})
    need(gs.get("androidBionicRuntime") == "NOT_VERIFIED" and gs.get("packageBuilt") is False
         and gs.get("productionAllowed") is False and gs.get("candidateOrProductionGateEnabled") is False,
         "GRADLE_SOURCE_ARTIFACT_SCOPE_MISMATCH")
    gradle_zip = gradle_root / "gradle-9.8.2-bin.zip"
    need(gradle_zip.is_file() and not gradle_zip.is_symlink(), "GRADLE_SOURCE_ARTIFACT_ZIP_MISSING")
    need(sha_file(gradle_zip) == gpin["hostDistributionSha256"]
         and gradle_zip.stat().st_size == gpin["hostDistributionSizeBytes"], "GRADLE_SOURCE_ARTIFACT_ZIP_HASH_MISMATCH")

    jpin = lock["nativePlatformJavaApi"]
    jp, je = find_one(java_root, lambda obj: isinstance(obj.get("artifactFiles"), dict)
                      and "sourceBuiltJar" in obj.get("artifactFiles", {}), "NATIVE_JAVA_API_EVIDENCE")
    need(str(je.get("workflow", {}).get("runId")) == str(jpin["sourceBuildRunId"]),
         "NATIVE_JAVA_API_RUN_ID_MISMATCH")
    need(je.get("assessment") == "SOURCE_BUILD_PASSED_CONTENT_IDENTICAL_CONTAINER_METADATA_DIFFERS",
         "NATIVE_JAVA_API_ASSESSMENT_MISMATCH")
    need(je.get("upstreamSource", {}).get("commit") == jpin["sourceCommit"]
         and je.get("upstreamSource", {}).get("tree") == jpin["sourceTree"]
         and je.get("upstreamSource", {}).get("cleanCheckoutBeforeBuild") is True
         and je.get("upstreamSource", {}).get("sourcePatchedByAudit") is False,
         "NATIVE_JAVA_API_SOURCE_PIN_MISMATCH")
    need(je.get("build", {}).get("result") == "SUCCESS" and je.get("build", {}).get("exitCode") == 0
         and je.get("build", {}).get("outputSha256") == jpin["sourceBuiltJarSha256"],
         "NATIVE_JAVA_API_BUILD_MISMATCH")
    comparison = je.get("comparisons", {}).get("sourceBuiltVsPreviouslyVerifiedDistributionEmbeddedJar", {})
    need(comparison.get("normalizedEntryContentIdentical") is True and comparison.get("contentDifferingEntries") == 0
         and comparison.get("leftAndRightEntryCount") == 143,
         "NATIVE_JAVA_API_CONTENT_COMPARISON_MISMATCH")
    license_audit = je.get("licenseAudit", {})
    need(license_audit.get("upstreamRootLicensePresent") is True
         and license_audit.get("separateLicenseFileRequiredForAnyFuturePackaging") is True
         and license_audit.get("licenseSha256") == jpin["separateApacheLicenseSha256"],
         "NATIVE_JAVA_API_LICENSE_AUDIT_MISMATCH")
    source_jar = evidence_file(java_root, je["artifactFiles"]["sourceBuiltJar"],
                               jpin["sourceBuiltJarSha256"], "NATIVE_JAVA_API_SOURCE_JAR")
    jar_content, jar_names = read_jar(source_jar, "NATIVE_JAVA_API_SOURCE_JAR")
    need(len(jar_names) == 143 and not any(name.lower().endswith(".so") for name in jar_names),
         "NATIVE_JAVA_API_SOURCE_JAR_LAYOUT_MISMATCH")
    license_file = evidence_file(java_root, je["artifactFiles"]["upstreamLicense"],
                                 jpin["separateApacheLicenseSha256"], "NATIVE_PLATFORM_APACHE_LICENSE")

    npin = lock["nativePlatformAndroidCore"]
    ap, ae = find_one(android_root, lambda obj: obj.get("experiment") == "native-platform-core-android-cross-build",
                      "ANDROID_CORE_PROTOTYPE_EVIDENCE")
    need(ae.get("outcome") == "PASS_PROTOTYPE_ONLY", "ANDROID_CORE_PROTOTYPE_NOT_PASS")
    need(ae.get("source", {}).get("actualCommit") == npin["sourceCommit"]
         and ae.get("source", {}).get("actualTree") == npin["sourceTree"]
         and ae.get("source", {}).get("cleanCheckout") is True,
         "ANDROID_CORE_SOURCE_PIN_MISMATCH")
    ndk = ae.get("buildTools", {}).get("androidNdk", {})
    need(ndk.get("version") == npin["ndkVersion"] and ndk.get("expectedSha256") == npin["ndkArchiveSha256"]
         and ndk.get("verified") is True and ndk.get("includedInAppPayload") is False,
         "ANDROID_CORE_NDK_PIN_MISMATCH")
    target = ae.get("target", {})
    need(target.get("triple") == npin["targetTriple"] and target.get("apiLevel") == npin["apiLevel"]
         and "EXPERIMENT_PARAMETER_ONLY" in target.get("apiFloorStatus", ""),
         "ANDROID_CORE_TARGET_SCOPE_MISMATCH")
    elf = ae.get("elfAudit", {})
    need(elf.get("status") == "PASS" and elf.get("soname") == npin["librarySoname"]
         and sorted(elf.get("needed", [])) == npin["expectedNeeded"]
         and elf.get("glibcVersionedSymbols") is False and elf.get("hostRpathOrRunpath") is False,
         "ANDROID_CORE_ELF_EVIDENCE_MISMATCH")
    gates = ae.get("gates", {})
    need(gates.get("packageCreated") is False and gates.get("feedInput") is False
         and gates.get("candidateEligible") is False and gates.get("productionAllowed") is False
         and gates.get("androidDeviceRuntimeVerified") is False,
         "ANDROID_CORE_PROTOTYPE_GATES_MISMATCH")
    native_lib = evidence_file(android_root, ae["artifactFiles"]["sharedLibrary"],
                               str(elf.get("sha256", "")), "ANDROID_CORE_SHARED_LIBRARY")
    elf_scan = readelf_report(native_lib)
    bionic_license = evidence_file(android_root, ae["artifactFiles"]["upstreamLicense"],
                                   npin["sourceCommit"] and jpin["separateApacheLicenseSha256"],
                                   "ANDROID_CORE_APACHE_LICENSE")
    # The source-built Java API JAR and core JNI library each require a separate copy of the same upstream license.
    prototype_readme = ap.parent / "README-PROTOTYPE.txt"
    need(prototype_readme.is_file() and not prototype_readme.is_symlink(), "ANDROID_CORE_PROTOTYPE_README_MISSING")
    readme_text = prototype_readme.read_text(encoding="utf-8")
    need("PROTOTYPE_ONLY" in readme_text and "Android/Bionic runtime load" in readme_text
         and "Do not create a package or feed" in readme_text,
         "ANDROID_CORE_PROTOTYPE_WARNING_MISSING")
    need(ae.get("tests", {}).get("deviceRuntime") == "NOT_RUN"
         and ae.get("tests", {}).get("cursesIntegration") == "NOT_SUPPORTED_BY_THIS_PROTOTYPE",
         "ANDROID_CORE_RUNTIME_OR_CURSES_SCOPE_MISMATCH")
    return {"gradleEvidencePath": str(gradle_evidence_path), "gradleZipPath": str(gradle_zip),
            "nativeJavaEvidencePath": str(jp), "sourceBuiltJavaJar": str(source_jar),
            "nativeAndroidEvidencePath": str(ap), "androidCoreLibrary": str(native_lib),
            "nativePlatformLicense": str(license_file), "bionicLicense": str(bionic_license),
            "prototypeReadmeSha256": sha_file(prototype_readme), "androidCoreElfAudit": elf_scan,
            "sourceBuiltJavaEntryCount": len(jar_content)}


def assemble(lock: dict[str, Any], inputs: dict[str, Any], work: Path, output: Path,
             report_path: Path) -> dict[str, Any]:
    need(not work.exists(), "ASSEMBLY_WORK_DIRECTORY_MUST_BE_NEW")
    work.mkdir(parents=True)
    source_zip = Path(inputs["gradleZipPath"])
    tree = work / "tree"
    dist = extract_distribution(source_zip, tree)
    root = Path(dist["root"])
    native = lock["nativeResource"]
    api_jar = root / native["genericApiJar"]
    target_jar = root / native["platformJar"]
    need(api_jar.is_file() and not api_jar.is_symlink(), "GRADLE_GENERIC_NATIVE_PLATFORM_JAR_MISSING")
    need(target_jar.is_file() and not target_jar.is_symlink(), "GRADLE_LINUX_AARCH64_NATIVE_PLATFORM_JAR_MISSING")
    expected_distribution_api_sha = lock["nativePlatformJavaApi"]["publishedSignedJarSha256"]
    need(sha_file(api_jar) == expected_distribution_api_sha, "GRADLE_DISTRIBUTION_NATIVE_PLATFORM_JAR_HASH_MISMATCH")
    src_api = Path(inputs["sourceBuiltJavaJar"])
    src_content, _ = read_jar(src_api, "SOURCE_BUILT_NATIVE_PLATFORM_JAR")
    dist_content, _ = read_jar(api_jar, "GRADLE_DISTRIBUTION_NATIVE_PLATFORM_JAR")
    need(src_content == dist_content, "SOURCE_BUILT_JAVA_API_CONTENT_DIFFERS_FROM_GRADLE_DISTRIBUTION")

    resource = native["resourcePath"]
    native_jars = sorted((root / "lib").glob("native-platform-*.jar"))
    need(api_jar in native_jars and target_jar in native_jars, "GRADLE_NATIVE_PLATFORM_JAR_SET_INCOMPLETE")
    expected_curses = {root / x for x in native["ncursesPlatformJars"]}
    need(expected_curses.issubset(set(native_jars)), "GRADLE_EXPECTED_NCURSES_JARS_MISSING")
    target_content, target_names = read_jar(target_jar, "ORIGINAL_GRADLE_AARCH64_NATIVE_JAR")
    original_target_entries = [name for name in target_names if name.endswith(".so")]
    need(original_target_entries == [resource], "ORIGINAL_GRADLE_AARCH64_RESOURCE_PATH_MISMATCH")
    need(resource in target_content, "ORIGINAL_GRADLE_AARCH64_NATIVE_RESOURCE_MISSING")

    all_jars = sorted(root.rglob("*.jar"))
    unreviewed_native_providers: list[str] = []
    native_extensions = (".so", ".dll", ".dylib", ".jnilib")
    for jar in all_jars:
        _, names = read_jar(jar, "GRADLE_DISTRIBUTION_JAR_" + jar.name)
        native_entries = [name for name in names if name.lower().endswith(native_extensions)]
        if native_entries and jar not in native_jars:
            unreviewed_native_providers.append(str(jar.relative_to(root)) + ":" + ",".join(native_entries))
    need(not unreviewed_native_providers,
         "UNREVIEWED_NATIVE_SO_PROVIDER_FOUND:" + ";".join(unreviewed_native_providers))

    removed: list[dict[str, Any]] = []
    for jar in native_jars:
        if jar == api_jar:
            continue
        content, names = read_jar(jar, "GRADLE_NATIVE_PLATFORM_VARIANT_" + jar.name)
        need(not any(name.endswith(".class") for name in names),
             "PLATFORM_VARIANT_JAR_CONTAINS_JAVA_CLASSES:" + jar.name)
        native_entries = [name for name in names if name.lower().endswith(native_extensions)]
        need(bool(native_entries), "PLATFORM_VARIANT_JAR_HAS_NO_NATIVE_PAYLOAD:" + jar.name)
        removed.append({"path": str(jar.relative_to(root)), "sha256": sha_file(jar),
                        "nativeEntries": native_entries,
                        "classification": "unneeded_non-Android_or_glibc_native-platform_variant_removed_from_Android_only_distribution"})
        jar.unlink()

    shutil.copyfile(src_api, api_jar)
    need(sha_file(api_jar) == lock["nativePlatformJavaApi"]["sourceBuiltJarSha256"],
         "SOURCE_BUILT_JAVA_API_COPY_HASH_MISMATCH")
    native_lib = Path(inputs["androidCoreLibrary"])
    target_jar_sha = write_deterministic_target_jar(target_jar, resource, native_lib)
    need(not list((root / "lib").glob("native-platform-*-ncurses*.jar")), "NCURSES_VARIANT_JAR_REMAINS")

    license_src = Path(inputs["nativePlatformLicense"])
    bionic_license = Path(inputs["bionicLicense"])
    native_license_dest = root / "LICENSE.native-platform.txt"
    shutil.copyfile(license_src, native_license_dest)
    need(sha_file(native_license_dest) == lock["nativePlatformJavaApi"]["separateApacheLicenseSha256"],
         "NATIVE_PLATFORM_LICENSE_COPY_MISMATCH")
    need(sha_file(bionic_license) == sha_file(license_src), "NATIVE_PLATFORM_LICENSES_DIFFER")
    status_text = (
        "AI Builder private Termux Gradle 9.8.2 — Android/Bionic test-only candidate\n"
        "\n"
        "This is a package-build input for the exact app ID com.karat.aibuilder and modeled prefix\n"
        "/data/user/0/com.karat.aibuilder/files/usr. The prefix is a CI model, not a device observation.\n"
        "\n"
        "Gradle 9.8.2 distribution: built from the pinned Gradle source archive by host-only CI run 40079300326;\n"
        "the distribution SHA-256 is recorded in the candidate input lock and assembly report. This is not\n"
        "the official reissued binary ZIP and is not substituted with it.\n"
        "\n"
        "The generic native-platform Java API JAR is source-built from upstream tag 0.22-milestone-29.\n"
        "The embedded core JNI library is an AArch64 Android/Bionic API-24 link prototype built from the\n"
        "pinned upstream source and NDK. The prototype artifact README classifies it as PROTOTYPE_ONLY and\n"
        "says Android/Bionic runtime loading was not tested; API 24 is not an upstream minimum-API claim.\n"
        "This separate candidate input uses that artifact only within the explicitly authorized test-only task.\n"
        "It does not establish device compatibility.\n"
        "\n"
        "The native resource is bundled at net/rubygrapefruit/platform/linux-aarch64/libnative-platform.so.\n"
        "The platform-specific core variant is Bionic-built. Other native-platform platform variants, including\n"
        "the incompatible ncurses JNI variants, are removed from this Android-only distribution.\n"
        "Terminal/terminfo JNI is UNSUPPORTED: upstream TerminfoTerminal calls TerminfoFunctions and the\n"
        "separate native-platform-curses component is not built. File watching is NOT DEVICE VERIFIED.\n"
        "\n"
        "No Android device load, Gradle task, file-watching, terminal, app-private daemon lifecycle, APT install,\n"
        "APK test, qualification, or production use is claimed. Candidate, qualification, and production gates\n"
        "remain closed. See LICENSE, NOTICE, LICENSE.native-platform.txt, the source lock, and machine evidence.\n"
    )
    (root / "ANDROID-CANDIDATE-STATUS.txt").write_text(status_text, encoding="utf-8")
    native_license_sha = sha_file(native_license_dest)
    status_sha = sha_file(root / "ANDROID-CANDIDATE-STATUS.txt")

    raw_so_files = [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() and p.suffix.lower() == ".so"]
    need(not raw_so_files, "RAW_SHARED_OBJECT_OUTSIDE_JAR:" + ";".join(raw_so_files))
    final_so_inventory: list[dict[str, str]] = []
    final_other_native_entries: list[dict[str, str]] = []
    for jar in sorted(root.rglob("*.jar")):
        _, names = read_jar(jar, "FINAL_GRADLE_JAR_" + jar.name)
        for name in names:
            if name.lower().endswith(".so"):
                final_so_inventory.append({"jar": str(jar.relative_to(root)), "resource": name})
            elif name.lower().endswith((".dll", ".dylib", ".jnilib")):
                final_other_native_entries.append({"jar": str(jar.relative_to(root)), "resource": name})
    need(not final_other_native_entries,
         "FINAL_GRADLE_FOREIGN_NATIVE_RESOURCE_REMAINS:" + json.dumps(final_other_native_entries, sort_keys=True))
    need(final_so_inventory == [{"jar": native["platformJar"], "resource": resource}],
         "FINAL_GRADLE_NATIVE_RESOURCE_INVENTORY_MISMATCH")

    assembled_zip = output
    out_sha, out_size = deterministic_zip(tree, assembled_zip)
    report = {
        "schemaVersion": 1,
        "result": "ANDROID_GRADLE_DISTRIBUTION_ASSEMBLY_PASS_TEST_CANDIDATE_ONLY",
        "applicationId": lock["applicationId"],
        "modeledPrefix": lock["target"]["modeledPrefix"],
        "inputArtifacts": {
            "gradleSourceBuildRunId": lock["gradleSourceBuild"]["hostDistributionRunId"],
            "gradleDistributionSourceSha256": lock["gradleSourceBuild"]["hostDistributionSha256"],
            "gradleDistributionZipSha256": sha_file(source_zip),
            "nativePlatformJavaSourceBuildRunId": lock["nativePlatformJavaApi"]["sourceBuildRunId"],
            "nativePlatformJavaApiJarSha256": lock["nativePlatformJavaApi"]["sourceBuiltJarSha256"],
            "androidCorePrototypeRunId": lock["nativePlatformAndroidCore"]["prototypeRunId"],
            "androidCorePrototypeArtifactId": lock["nativePlatformAndroidCore"]["prototypeArtifactId"],
            "androidCoreSharedLibrarySha256": sha_file(native_lib),
            "androidCorePrototypeReadmeSha256": inputs["prototypeReadmeSha256"],
            "androidCorePrototypeSelfClassification": "PROTOTYPE_ONLY_NOT_RUNTIME_QUALIFIED",
        },
        "distribution": {"filename": assembled_zip.name, "sha256": out_sha, "sizeBytes": out_size,
                         "sourceArchiveCrcVerified": True, "sourceArchiveVersion": "9.8.2",
                         "sourceArchiveRoot": "gradle-9.8.2/", "sourceFileCount": dist["fileCount"],
                         "sourceExpandedBytes": dist["expandedBytes"]},
        "nativePayload": {
            "genericJavaApiJar": {"path": native["genericApiJar"],
                                   "sha256": lock["nativePlatformJavaApi"]["sourceBuiltJarSha256"],
                                   "sourceBuilt": True, "entryContentsMatchSignedPublishedAndDistributionJar": True},
            "androidCoreJar": {"path": native["platformJar"], "sha256": target_jar_sha,
                               "resource": resource, "sharedLibrarySha256": sha_file(native_lib),
                               "sharedLibrarySizeBytes": native_lib.stat().st_size,
                               "elfAudit": inputs["androidCoreElfAudit"]},
            "removedNativePlatformVariants": removed,
            "unreviewedNativeSoProviders": [],
            "rawSoFilesOutsideJars": [],
            "remainingSharedObjectResources": final_so_inventory,
            "terminalJni": "UNSUPPORTED_NOT_BUILT",
            "fileWatching": "NOT_DEVICE_VERIFIED",
        },
        "licenses": {
            "gradleLicenseSha256": sha_file(Path(dist["root"]) / "LICENSE"),
            "gradleNoticeSha256": sha_file(Path(dist["root"]) / "NOTICE"),
            "nativePlatformApacheLicenseSha256": native_license_sha,
            "candidateStatusNoticeSha256": status_sha,
            "includedInDistribution": True,
        },
        "gates": {"distributionAssembled": True, "packageBuilt": False, "aptSimulation": "NOT_RUN",
                  "installPerformed": False, "androidDeviceRuntime": "NOT_RUN", "candidateEligible": False,
                  "qualified": False, "productionAllowed": False},
        "warning": "The source JNI artifact is explicitly prototype-only; its own README says Bionic runtime and package use are not validated. It is included only as a test-candidate input under the authorized task scope.",
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gradle-artifact-dir", type=Path, required=True)
    parser.add_argument("--native-java-artifact-dir", type=Path, required=True)
    parser.add_argument("--android-core-artifact-dir", type=Path, required=True)
    parser.add_argument("--input-lock", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output-zip", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    failure: dict[str, Any] = {"result": "BLOCKED_FAIL_CLOSED", "packageBuilt": False,
                               "aptSimulation": "NOT_RUN", "installPerformed": False,
                               "androidDeviceRuntime": "NOT_RUN", "candidateEligible": False,
                               "qualified": False, "productionAllowed": False}
    try:
        lock = load_json(args.input_lock)
        inputs = verify_inputs(lock, args.gradle_artifact_dir.resolve(), args.native_java_artifact_dir.resolve(),
                               args.android_core_artifact_dir.resolve(), args.work_dir)
        report = assemble(lock, inputs, args.work_dir, args.output_zip, args.report)
        print("GRADLE_ANDROID_DISTRIBUTION_ASSEMBLY_PASS sha256=" + report["distribution"]["sha256"]
              + " package=not-built runtime=NOT_RUN production=false")
        return 0
    except Exception as exc:
        failure["error"] = f"{type(exc).__name__}:{exc}"
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(failure, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("ERROR:" + failure["error"], file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
