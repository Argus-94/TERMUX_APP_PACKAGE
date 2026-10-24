#!/usr/bin/env python3
"""Build an isolated, prototype-only Android/Bionic core JNI library from pinned source."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

UPSTREAM_REPO = "https://github.com/gradle/native-platform.git"
UPSTREAM_TAG = "0.22-milestone-29"
UPSTREAM_COMMIT = "e999afaf8692fb66e9016e0a3b0519a05981753e"
UPSTREAM_TREE = "5995e83b24d7dab4e712be7a1586e131e57bc301"
NDK_URL = "https://dl.google.com/android/repository/android-ndk-r30-linux.zip"
NDK_VERSION = "30.0.16248370"
NDK_SHA256 = "753611f410d002cfcd3f3dc2ef49aad532089d3180b436c060a90bf0fcb64df2"
NDK_SHA1 = "5107f898313790e449e87eee2183d9a20602dee9"
NDK_SIZE = 738_633_529
GRADLE_URL = "https://services.gradle.org/distributions/gradle-8.14.3-bin.zip"
GRADLE_SHA256 = "bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531"
TARGET_TRIPLE = "aarch64-linux-android24"
API_LEVEL = 24
EXPECTED_CORE_SOURCES = [
    "native-platform/src/main/cpp/apple.cpp",
    "native-platform/src/main/cpp/freebsd.cpp",
    "native-platform/src/main/cpp/linux.cpp",
    "native-platform/src/main/cpp/posix.cpp",
    "native-platform/src/main/cpp/win.cpp",
    "native-platform/src/shared/cpp/generic.cpp",
    "native-platform/src/shared/cpp/generic_posix.cpp",
    "native-platform/src/shared/cpp/osx.cpp",
    "native-platform/src/shared/cpp/unix_strings.cpp",
    "native-platform/src/shared/cpp/win.cpp",
]
EXPECTED_HEADERS = [
    "native-platform/src/shared/headers/generic.h",
    "native-platform/src/shared/headers/win.h",
]
JNI_HEADER_NAMES = [
    "net_rubygrapefruit_platform_internal_jni_NativeLibraryFunctions.h",
    "net_rubygrapefruit_platform_internal_jni_PosixFileFunctions.h",
    "net_rubygrapefruit_platform_internal_jni_PosixFileSystemFunctions.h",
    "net_rubygrapefruit_platform_internal_jni_PosixProcessFunctions.h",
    "net_rubygrapefruit_platform_internal_jni_PosixTerminalFunctions.h",
    "net_rubygrapefruit_platform_internal_jni_PosixTypeFunctions.h",
]
JNI_JAVA_NAMES = [name.removesuffix(".h") for name in JNI_HEADER_NAMES]
ALLOWED_NEEDED = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libc++_shared.so"}


def digest(path: Path, algorithm: str = "sha256") -> str:
    h = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp.replace(path)


class PrototypeBuild:
    def __init__(self, output: Path):
        self.output = output.resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.logs = self.output / "logs"
        self.logs.mkdir(exist_ok=True)
        runner_temp = Path(os.environ.get("RUNNER_TEMP", "/tmp"))
        self.work = runner_temp / "native-platform-android-prototype-work"
        self.source = self.work / "native-platform"
        self.gradle_home = self.work / "gradle-user-home"
        self.gradle_home.mkdir(parents=True, exist_ok=True)
        self.ndk_archive = self.work / "android-ndk-r30-linux.zip"
        self.gradle_archive = self.work / "gradle-8.14.3-bin.zip"
        (self.output / "README-PROTOTYPE.txt").write_text(
            "PROTOTYPE_ONLY — NOT A PACKAGE OR FEED INPUT\n\n"
            "This artifact is an isolated cross-build experiment. It is not qualified for use in the embedded Termux runtime. API 24 is an experiment parameter, not an upstream minimum-API guarantee. Android/Bionic runtime load and Gradle task tests are NOT RUN. The separate curses JNI component is not built, so terminal integration is unsupported. Any NDK present is a Linux x86_64 build-only tool and is not app payload. Do not create a package or feed from any shared object in this artifact.\n",
            encoding="utf-8",
        )
        self.data: dict[str, Any] = {
            "schemaVersion": 1,
            "experiment": "native-platform-core-android-cross-build",
            "classification": "PROTOTYPE_ONLY",
            "outcome": "NOT_RUN",
            "source": {
                "repository": UPSTREAM_REPO,
                "tag": UPSTREAM_TAG,
                "expectedCommit": UPSTREAM_COMMIT,
                "expectedTree": UPSTREAM_TREE,
                "actualCommit": None,
                "actualTree": None,
                "cleanCheckout": False,
                "license": "Apache-2.0",
            },
            "buildTools": {
                "java": {"distribution": "Eclipse Temurin", "expectedMajor": 17, "hostUseOnly": True, "includedInAppPayload": False, "verified": False},
                "gradle": {"url": GRADLE_URL, "expectedSha256": GRADLE_SHA256, "verified": False},
                "androidNdk": {
                    "version": NDK_VERSION,
                    "url": NDK_URL,
                    "expectedArchiveBytes": NDK_SIZE,
                    "expectedSha256": NDK_SHA256,
                    "expectedOfficialSha1": NDK_SHA1,
                    "hostUseOnly": True,
                    "includedInAppPayload": False,
                    "verified": False,
                },
            },
            "target": {
                "triple": TARGET_TRIPLE,
                "architecture": "AArch64",
                "apiLevel": API_LEVEL,
                "apiFloorStatus": "EXPERIMENT_PARAMETER_ONLY_UPSTREAM_DOES_NOT_DECLARE_ANDROID_OR_MIN_API",
                "targetRuntime": "Android/Bionic link target; no device execution performed",
            },
            "sourceSelection": {},
            "compiler": {},
            "elfAudit": {"status": "NOT_RUN"},
            "tests": {
                "sourceSyntaxChecks": "NOT_RUN",
                "clangStaticAnalyzer": "NOT_RUN",
                "deviceRuntime": "NOT_RUN",
                "cursesIntegration": "NOT_SUPPORTED_BY_THIS_PROTOTYPE",
            },
            "gates": {
                "packageCreated": False,
                "feedInput": False,
                "candidateEligible": False,
                "productionAllowed": False,
                "androidDeviceRuntimeVerified": False,
            },
            "scopeDisclosure": [
                "Core native-platform JNI library only; native-platform-curses is excluded.",
                "The API 24 target is an experiment parameter, not an upstream-supported minimum API claim.",
                "No .deb, APT simulation, feed, install, Android/Bionic device load, or Gradle task runtime test is produced by this workflow.",
                "This shared object is not a package or feed input and must not be treated as a qualified embedded Termux toolchain.",
            ],
            "phases": {},
            "blocker": None,
        }
        self.data["artifactFiles"] = {
            "readme": {"path": "README-PROTOTYPE.txt", "sha256": digest(self.output / "README-PROTOTYPE.txt")}
        }
        self.write_evidence()

    def write_evidence(self) -> None:
        atomic_json(self.output / "evidence.json", self.data)

    def phase(self, name: str, status: str, **details: Any) -> None:
        self.data["phases"][name] = {"status": status, **details}
        self.write_evidence()
        print(f"[{status}] {name}", flush=True)

    def run(self, name: str, argv: list[str], cwd: Path | None = None,
            env: dict[str, str] | None = None, timeout: int = 1800) -> Path:
        log_path = self.logs / f"{name}.log"
        print(f"Running {name}: {argv[0]} (full command recorded in evidence)", flush=True)
        record: dict[str, Any] = {
            "id": name,
            "argv": argv,
            "cwd": "upstream-source" if cwd == self.source else (str(cwd) if cwd else None),
            "log": f"logs/{log_path.name}",
        }
        try:
            with log_path.open("wb") as log_stream:
                result = subprocess.run(
                    argv,
                    cwd=str(cwd) if cwd else None,
                    env=env,
                    stdout=log_stream,
                    stderr=subprocess.STDOUT,
                    timeout=timeout,
                    check=False,
                )
            record["exitCode"] = result.returncode
        except Exception as exc:
            record["exception"] = f"{type(exc).__name__}: {exc}"
            record["exitCode"] = None
            self.data.setdefault("commands", []).append(record)
            self.write_evidence()
            raise
        self.data.setdefault("commands", []).append(record)
        self.write_evidence()
        if result.returncode:
            tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-50:])
            raise RuntimeError(f"{name} failed with exit code {result.returncode}; see logs/{log_path.name}\n{tail}")
        return log_path

    @staticmethod
    def output_of(argv: list[str], cwd: Path | None = None) -> str:
        result = subprocess.run(argv, cwd=str(cwd) if cwd else None, check=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return result.stdout.strip()

    def verify_source(self) -> None:
        if self.work.exists():
            shutil.rmtree(self.work)
        self.work.mkdir(parents=True, exist_ok=True)
        self.run("clone_upstream", ["git", "clone", "--depth", "1", "--branch", UPSTREAM_TAG, UPSTREAM_REPO, str(self.source)], timeout=300)
        actual_commit = self.output_of(["git", "rev-parse", "HEAD"], cwd=self.source)
        actual_tree = self.output_of(["git", "rev-parse", "HEAD^{tree}"], cwd=self.source)
        status = self.output_of(["git", "status", "--porcelain=v1"], cwd=self.source)
        if actual_commit != UPSTREAM_COMMIT or actual_tree != UPSTREAM_TREE:
            raise RuntimeError(f"UPSTREAM_REVISION_MISMATCH: expected {UPSTREAM_COMMIT}/{UPSTREAM_TREE}; got {actual_commit}/{actual_tree}")
        if status:
            raise RuntimeError("UPSTREAM_CHECKOUT_DIRTY")
        self.data["source"].update({"actualCommit": actual_commit, "actualTree": actual_tree, "cleanCheckout": True})

        project = self.source / "native-platform"
        build_file = (project / "build.gradle").read_text(encoding="utf-8")
        plugin_file = self.source / "buildSrc/src/main/java/gradlebuild/JniPlugin.java"
        plugin = plugin_file.read_text(encoding="utf-8")
        if "source.srcDirs = ['src/shared/cpp', 'src/main/cpp']" not in build_file:
            raise RuntimeError("CORE_SOURCE_ROOTS_NO_LONGER_MATCH_PINNED_MAPPING")
        if "exportedHeaders.srcDirs = ['src/shared/headers']" not in build_file:
            raise RuntimeError("CORE_HEADER_ROOT_NO_LONGER_MATCH_PINNED_MAPPING")
        if "cppCompiler.args(\"-D_FILE_OFFSET_BITS=64\")" not in plugin:
            raise RuntimeError("UPSTREAM_LINUX_DEFINE_NOT_FOUND")
        source_dirs = [project / "src/shared/cpp", project / "src/main/cpp"]
        actual_sources = sorted(str(p.relative_to(self.source)) for root in source_dirs for p in root.glob("*.cpp"))
        if set(actual_sources) != set(EXPECTED_CORE_SOURCES):
            raise RuntimeError(f"CORE_SOURCE_INVENTORY_MISMATCH: {actual_sources!r}")
        header_root = project / "src/shared/headers"
        actual_headers = sorted(str(p.relative_to(self.source)) for p in header_root.glob("*.h"))
        if actual_headers != EXPECTED_HEADERS:
            raise RuntimeError(f"CORE_HEADER_INVENTORY_MISMATCH: {actual_headers!r}")
        if "cppCompiler.args(\"-D_FILE_OFFSET_BITS=64\")" not in plugin:
            raise RuntimeError("UPSTREAM_FILE_OFFSET_DEFINE_NOT_FOUND")
        if "targetPlatform" not in build_file or "nativePlatformCurses" not in build_file:
            raise RuntimeError("UPSTREAM_CORE_OR_SEPARATE_CURSES_COMPONENT_NOT_FOUND")
        license_path = self.source / "LICENSE"
        if not license_path.is_file():
            raise RuntimeError("UPSTREAM_APACHE_LICENSE_FILE_MISSING")
        shutil.copyfile(license_path, self.output / "UPSTREAM-LICENSE-Apache-2.0.txt")
        self.data["artifactFiles"]["upstreamLicense"] = {
            "path": "UPSTREAM-LICENSE-Apache-2.0.txt",
            "sha256": digest(self.output / "UPSTREAM-LICENSE-Apache-2.0.txt"),
        }
        self.data["sourceSelection"] = {
            "component": "nativePlatform",
            "upstreamBuildFile": "native-platform/build.gradle",
            "upstreamBuildFileSha256": digest(project / "build.gradle"),
            "upstreamJniPlugin": "buildSrc/src/main/java/gradlebuild/JniPlugin.java",
            "upstreamJniPluginSha256": digest(plugin_file),
            "coreSourceRoots": ["native-platform/src/shared/cpp", "native-platform/src/main/cpp"],
            "sourceFiles": [{"path": p, "sha256": digest(self.source / p)} for p in actual_sources],
            "exportedHeaderRoot": "native-platform/src/shared/headers",
            "headerFiles": [{"path": p, "sha256": digest(self.source / p)} for p in actual_headers],
            "linuxDefine": {"value": "-D_FILE_OFFSET_BITS=64", "origin": "pinned JniPlugin.java Linux target configuration"},
            "jniHeaderNames": JNI_HEADER_NAMES,
            "jniJavaSources": [
                {
                    "path": f"native-platform/src/main/java/net/rubygrapefruit/platform/internal/jni/{name}.java",
                    "sha256": digest(project / f"src/main/java/net/rubygrapefruit/platform/internal/jni/{name}.java"),
                }
                for name in JNI_JAVA_NAMES
            ],
            "nativeVersionGenerator": {
                "path": "buildSrc/src/main/java/gradlebuild/WriteNativeVersionSources.java",
                "sha256": digest(self.source / "buildSrc/src/main/java/gradlebuild/WriteNativeVersionSources.java"),
            },
            "license": {"path": "LICENSE", "spdx": "Apache-2.0", "sha256": digest(license_path)},
            "verificationMetadata": {
                "path": "gradle/verification-metadata.xml",
                "sha256": digest(self.source / "gradle/verification-metadata.xml"),
                "policyNote": "Upstream metadata enables signature verification, disables metadata verification, and includes trusted-artifact/group rules; this is recorded, not represented as a complete artifact-hash closure.",
            },
            "curses": {"upstreamComponent": "nativePlatformCurses", "built": False, "linkIntegration": "NOT_SUPPORTED_BY_THIS_PROTOTYPE"},
            "upstreamAndroidTarget": "NOT_DECLARED",
        }
        self.phase("source_pin", "PASS", commit=actual_commit, tree=actual_tree,
                   sourceFileCount=len(actual_sources), sharedHeaderCount=len(actual_headers))

    def fetch_and_verify_toolchains(self) -> tuple[Path, Path]:
        wrapper = self.source / "gradle/wrapper/gradle-wrapper.properties"
        props = wrapper.read_text(encoding="utf-8")
        match = re.search(r"^distributionUrl=(.+)$", props, re.MULTILINE)
        if not match:
            raise RuntimeError("GRADLE_WRAPPER_DISTRIBUTION_URL_MISSING")
        wrapper_url = match.group(1).replace(r"\:", ":").replace(r"\=", "=")
        if wrapper_url != GRADLE_URL:
            raise RuntimeError(f"GRADLE_WRAPPER_URL_MISMATCH: {wrapper_url}")
        self.data["buildTools"]["gradle"]["wrapperPropertiesSha256"] = digest(wrapper)
        self.run("download_gradle_distribution", ["curl", "--fail", "--location", "--silent", "--show-error",
                 "--retry", "2", "--retry-all-errors", "--connect-timeout", "20", "--max-time", "900",
                 "--output", str(self.gradle_archive), GRADLE_URL], timeout=1000)
        if digest(self.gradle_archive) != GRADLE_SHA256:
            raise RuntimeError("GRADLE_DISTRIBUTION_SHA256_MISMATCH")
        if not zipfile.is_zipfile(self.gradle_archive):
            raise RuntimeError("GRADLE_DISTRIBUTION_NOT_A_VALID_ZIP")
        gradle_root = self.work / "gradle-dist"
        gradle_root.mkdir(exist_ok=True)
        self.run("extract_gradle_distribution", ["unzip", "-q", str(self.gradle_archive), "-d", str(gradle_root)], timeout=300)
        gradle = gradle_root / "gradle-8.14.3/bin/gradle"
        if not gradle.is_file():
            raise RuntimeError("PINNED_GRADLE_EXECUTABLE_NOT_FOUND")
        self.data["buildTools"]["gradle"].update({
            "actualSha256": digest(self.gradle_archive),
            "sizeBytes": self.gradle_archive.stat().st_size,
            "verified": True,
            "wrapperDeclaredUrlMatches": True,
            "version": "8.14.3",
        })

        self.run("download_ndk_distribution", ["curl", "--fail", "--location", "--silent", "--show-error",
                 "--retry", "2", "--retry-all-errors", "--connect-timeout", "20", "--max-time", "2400",
                 "--output", str(self.ndk_archive), NDK_URL], timeout=2500)
        size = self.ndk_archive.stat().st_size
        sha256 = digest(self.ndk_archive)
        sha1 = digest(self.ndk_archive, "sha1")
        if size != NDK_SIZE:
            raise RuntimeError(f"NDK_ARCHIVE_SIZE_MISMATCH: expected {NDK_SIZE}; got {size}")
        if sha256 != NDK_SHA256 or sha1 != NDK_SHA1:
            raise RuntimeError(f"NDK_ARCHIVE_HASH_MISMATCH: sha256={sha256} sha1={sha1}")
        if not zipfile.is_zipfile(self.ndk_archive):
            raise RuntimeError("NDK_ARCHIVE_NOT_A_VALID_ZIP")
        ndk_root = self.work / "ndk-extract"
        ndk_root.mkdir(exist_ok=True)
        self.run("extract_ndk", ["unzip", "-q", str(self.ndk_archive), "-d", str(ndk_root)], timeout=900)
        ndk = ndk_root / "android-ndk-r30"
        if not (ndk / "toolchains/llvm/prebuilt/linux-x86_64/bin/clang++").is_file():
            raise RuntimeError("PINNED_NDK_CLANGXX_NOT_FOUND")
        self.data["buildTools"]["androidNdk"].update({
            "actualArchiveBytes": size,
            "actualSha256": sha256,
            "actualOfficialSha1": sha1,
            "verified": True,
            "compilerHost": "Linux x86_64",
            "targetSysroot": "toolchains/llvm/prebuilt/linux-x86_64/sysroot",
        })
        self.phase("build_tool_hashes", "PASS", gradleSha256=GRADLE_SHA256, ndkSha256=sha256,
                   ndkBytes=size, ndkHost="Linux x86_64 (build-only)")
        return gradle, ndk

    def generate_upstream_headers(self, gradle: Path) -> tuple[Path, Path]:
        env = os.environ.copy()
        env["GRADLE_USER_HOME"] = str(self.gradle_home)
        env["JAVA_TOOL_OPTIONS"] = "-Dfile.encoding=UTF-8"
        java_bin = Path(os.environ["JAVA_HOME"]) / "bin/java"
        java_log = self.run("host_jdk_version", [str(java_bin), "-version"], env=env, timeout=30)
        java_version_text = java_log.read_text(encoding="utf-8", errors="replace")
        if not re.search(r'openjdk version "17(?:\.|\")', java_version_text, re.IGNORECASE):
            raise RuntimeError(f"EXPECTED_TEMURIN_JDK_17_NOT_FOUND: {java_version_text.strip()}")
        self.data["buildTools"]["java"].update({"versionOutput": java_version_text.strip(), "verified": True})
        self.write_evidence()
        command = [str(gradle), "--no-daemon", "--no-parallel", "--max-workers=2",
                   "--stacktrace", ":native-platform:writeNativeVersionSources", ":native-platform:compileJava"]
        self.run("upstream_compile_java_and_generate_version", command, cwd=self.source, env=env, timeout=2700)
        project_build = self.source / "native-platform/build"
        version_header = project_build / "generated/version/header/native_platform_version.h"
        if not version_header.is_file():
            raise RuntimeError("UPSTREAM_NATIVE_VERSION_HEADER_NOT_GENERATED")
        generated_java_version = project_build / "generated/version/java/net/rubygrapefruit/platform/internal/jni/NativeVersion.java"
        if not generated_java_version.is_file():
            raise RuntimeError("UPSTREAM_NATIVE_VERSION_JAVA_SOURCE_NOT_GENERATED")
        version_text = version_header.read_text(encoding="utf-8")
        if "#define NATIVE_VERSION \"" not in version_text or "__INCLUDE_NATIVE_PLATFORM_VERSION_H__" not in version_text:
            raise RuntimeError("UPSTREAM_NATIVE_VERSION_HEADER_CONTENT_INVALID")
        jni_dirs = sorted({p.parent for p in project_build.rglob(JNI_HEADER_NAMES[0])
                           if all((p.parent / name).is_file() for name in JNI_HEADER_NAMES)})
        jni_dir = jni_dirs[0] if jni_dirs else None
        if jni_dir is None:
            jni_dir = project_build / "generated/prototype-jni-headers"
            jni_dir.mkdir(parents=True, exist_ok=True)
            class_dir = project_build / "classes/java/main"
            java_sources = [str(self.source / "native-platform/src/main/java/net/rubygrapefruit/platform/internal/jni" / f"{name}.java") for name in JNI_JAVA_NAMES]
            self.run("generate_jni_headers_from_upstream_java", [
                str(Path(os.environ["JAVA_HOME"]) / "bin/javac"), "-proc:none", "-implicit:none", "-h", str(jni_dir),
                "-classpath", str(class_dir), "-d", str(project_build / "prototype-jni-classes"), *java_sources,
            ], cwd=self.source, env=env, timeout=300)
        missing = [name for name in JNI_HEADER_NAMES if not (jni_dir / name).is_file()]
        if missing:
            raise RuntimeError(f"JNI_HEADERS_NOT_GENERATED: {missing}")
        self.data["sourceSelection"]["generatedHeaders"] = {
            "jniHeaderDirectory": str(jni_dir.relative_to(self.source)),
            "jniGenerationMethod": "upstream JavaCompile JNI headerOutputDirectory" if "prototype-jni-headers" not in str(jni_dir) else "javac -h from the exact six pinned upstream JNI owner sources against the upstream compile output",
            "jniHeaderSha256": {name: digest(jni_dir / name) for name in JNI_HEADER_NAMES},
            "nativeVersionHeader": str(version_header.relative_to(self.source)),
            "nativeVersionHeaderSha256": digest(version_header),
            "nativeVersionJavaSourcePresent": generated_java_version.is_file(),
        }
        self.phase("upstream_java_headers", "PASS", jniHeaders=len(JNI_HEADER_NAMES),
                   nativeVersionHeaderSha256=digest(version_header))
        return jni_dir, version_header.parent

    def compile_and_audit(self, ndk: Path, jni_dir: Path, version_dir: Path) -> None:
        host_prebuilt = ndk / "toolchains/llvm/prebuilt/linux-x86_64"
        bin_dir = host_prebuilt / "bin"
        clang = bin_dir / "clang++"
        readelf = bin_dir / "llvm-readelf"
        if not readelf.is_file():
            raise RuntimeError("NDK_LLVM_READELF_NOT_FOUND")
        self.run("clang_version", [str(clang), "--version"], timeout=30)
        compiler_version = (self.logs / "clang_version.log").read_text(encoding="utf-8", errors="replace").splitlines()[0]
        project = self.source / "native-platform"
        source_files = [self.source / p for p in EXPECTED_CORE_SOURCES]
        jni_includes = [Path(os.environ["JAVA_HOME"]) / "include", Path(os.environ["JAVA_HOME"]) / "include/linux"]
        includes = [project / "src/shared/headers", jni_dir, version_dir, *jni_includes]
        upstream_flags = ["-D_FILE_OFFSET_BITS=64"]
        target_flags = [f"--target={TARGET_TRIPLE}", "-fPIC"]
        safety_link_flags = ["-nostdlib++", "-Wl,--no-undefined"]
        link_flags = ["-shared", "-Wl,-soname,libnative-platform.so"]
        common = [str(clang), *target_flags, *upstream_flags]
        for inc in includes:
            common.extend(["-I", str(inc)])

        self.data["compiler"] = {
            "path": "android-ndk-r30/toolchains/llvm/prebuilt/linux-x86_64/bin/clang++",
            "versionFirstLine": compiler_version,
            "host": "Linux x86_64",
            "target": TARGET_TRIPLE,
            "targetTripleOrigin": "experiment parameter supplied by wrapper; Android target is not registered upstream",
            "includePaths": [
                {"path": "native-platform/src/shared/headers", "origin": "native-platform/build.gradle exportedHeaders"},
                {"path": str(jni_dir.relative_to(self.source)), "origin": "upstream Java compile-generated JNI headers" if "prototype-jni-headers" not in str(jni_dir) else "javac -h on pinned upstream JNI declaration sources"},
                {"path": str(version_dir.relative_to(self.source)), "origin": "upstream WriteNativeVersionSources task"},
                {"path": str(jni_includes[0]), "origin": "pinned JniPlugin.java current JVM include path"},
                {"path": str(jni_includes[1]), "origin": "pinned JniPlugin.java linux JNI include path"},
            ],
            "flags": {
                "upstreamLinuxDefine": upstream_flags,
                "androidTargetAndSharedObject": {"values": target_flags + link_flags, "origin": "wrapper-required Android prototype target/shared-library settings; not present in upstream Android build configuration"},
                "prototypeLinkSafety": {"values": safety_link_flags, "purpose": "avoid a C++ runtime dependency unless source proves it necessary and require API-24 target stubs to resolve all external references"},
                "upstreamDefines": ["-D_FILE_OFFSET_BITS=64"],
                "languageStandard": "No explicit C++ standard in pinned upstream settings; NDK clang++ default is retained. The exact compiler version and commands are recorded.",
            },
            "coreSourceFiles": EXPECTED_CORE_SOURCES,
            "excludedComponent": "nativePlatformCurses",
            "ndkCompilerIsAppPayload": False,
        }
        trace_path = self.output / "clang-api24-link-driver.txt"
        trace_command = [str(clang), f"--target={TARGET_TRIPLE}", "-fPIC", "-shared", "-nostdlib++",
                         "-Wl,--no-undefined", "-Wl,-soname,libnative-platform.so", "-###",
                         "-x", "c++", "/dev/null", "-o", str(self.output / "discarded-api24-probe.so")]
        trace_log = self.run("inspect_api24_link_driver", trace_command, timeout=60)
        shutil.copyfile(trace_log, trace_path)
        trace_text = trace_path.read_text(encoding="utf-8", errors="replace")
        api24_sysroot_pattern = r"/sysroot/usr/lib/aarch64-linux-android/24(?:/|\s|\")"
        if not re.search(api24_sysroot_pattern, trace_text):
            raise RuntimeError("NDK_CLANG_DID_NOT_SELECT_API24_AARCH64_LINK_STUBS")
        self.data["compiler"]["api24LinkDriverTrace"] = {
            "path": trace_path.name,
            "sha256": digest(trace_path),
            "selectedApi24Aarch64Sysroot": True,
            "meaning": "Compiler-driver trace confirms the API-24 AArch64 link search path; this is a link-time experiment, not Android runtime evidence.",
        }
        source_syntax_args = [*common, "-fsyntax-only"]
        analyzer_summary = []
        for index, source in enumerate(source_files):
            name = f"syntax_{index:02d}_{source.stem}"
            self.run(name, [*source_syntax_args, str(source)], cwd=self.source, timeout=180)
        self.data["tests"]["sourceSyntaxChecks"] = "PASS_ALL_10_PINNED_CPP_FILES"
        self.phase("source_syntax", "PASS", sourceCount=len(source_files), target=TARGET_TRIPLE)

        for index, source in enumerate(source_files):
            name = f"analyzer_{index:02d}_{source.stem}"
            log = self.run(name, [*common, "--analyze", "-Xanalyzer", "-analyzer-output=text", str(source)], cwd=self.source, timeout=180)
            text = log.read_text(encoding="utf-8", errors="replace").strip()
            if text:
                analyzer_summary.append({"source": str(source.relative_to(self.source)), "diagnostics": text[-4000:]})
        self.data["tests"]["clangStaticAnalyzer"] = "PASS_EXECUTED_WITH_DIAGNOSTICS_RECORDED" if analyzer_summary else "PASS_NO_DIAGNOSTICS"
        self.data["tests"]["clangAnalyzerDiagnostics"] = analyzer_summary
        self.phase("static_analyzer", "PASS", analyzedSourceCount=len(source_files), diagnosticCount=len(analyzer_summary))

        elf = self.output / "libnative-platform.so"
        compile_command = [*common, *safety_link_flags, *link_flags, "-o", str(elf), *[str(p) for p in source_files]]
        self.data["compiler"]["sharedLinkCommand"] = compile_command
        self.run("cross_compile_core_shared_library", compile_command, cwd=self.source, timeout=600)
        if not elf.is_file() or elf.stat().st_size == 0:
            raise RuntimeError("CROSS_COMPILE_OUTPUT_MISSING_OR_EMPTY")
        self.phase("shared_library", "PASS", filename=elf.name, sizeBytes=elf.stat().st_size, sha256=digest(elf))

        outputs: dict[str, str] = {}
        for name, args in {
            "elf-header.txt": [str(readelf), "-h", str(elf)],
            "elf-dynamic.txt": [str(readelf), "-d", str(elf)],
            "elf-dynamic-symbols.txt": [str(readelf), "--dyn-syms", "--wide", str(elf)],
            "elf-version-info.txt": [str(readelf), "-V", str(elf)],
            "elf-notes.txt": [str(readelf), "-n", str(elf)],
        }.items():
            log = self.run("readelf_" + name.removeprefix("elf-").removesuffix(".txt"), args, timeout=60)
            target = self.output / name
            shutil.copyfile(log, target)
            outputs[name] = target.read_text(encoding="utf-8", errors="replace")
        elf_header = outputs["elf-header.txt"]
        dynamic = outputs["elf-dynamic.txt"]
        symbols = outputs["elf-dynamic-symbols.txt"]
        version_info = outputs["elf-version-info.txt"]
        if not re.search(r"Class:\s+ELF64", elf_header) or not re.search(r"Machine:\s+AArch64", elf_header):
            raise RuntimeError("ELF_ARCHITECTURE_MISMATCH")
        if not re.search(r"Type:\s+DYN", elf_header):
            raise RuntimeError("ELF_NOT_SHARED_OBJECT")
        needed = re.findall(r"Shared library: \[([^]]+)\]", dynamic)
        unexpected = sorted(set(needed) - ALLOWED_NEEDED)
        if unexpected:
            raise RuntimeError(f"UNEXPECTED_ELF_DEPENDENCIES: {unexpected}; all DT_NEEDED={needed}")
        if "RPATH" in dynamic or "RUNPATH" in dynamic or "/system/" in dynamic or "/usr/" in dynamic:
            raise RuntimeError("HOST_OR_SYSTEM_RPATH_RUNPATH_FOUND")
        if "GLIBC_" in symbols or "GLIBC_" in version_info or "GLIBC_" in elf.read_bytes().decode("latin1", errors="ignore"):
            raise RuntimeError("GLIBC_VERSIONED_SYMBOLS_FOUND")
        if "libc.so" not in needed:
            raise RuntimeError(f"BIONIC_LIBC_NEEDED_NOT_PRESENT: {needed}")
        if "libstdc++.so" in needed or "libgcc_s.so" in needed or "ld-linux" in " ".join(needed):
            raise RuntimeError(f"HOST_LINUX_RUNTIME_DEPENDENCY_FOUND: {needed}")
        soname = re.search(r"Library soname:\s+\[([^]]+)\]", dynamic)
        if not soname or soname.group(1) != "libnative-platform.so":
            raise RuntimeError(f"EXPECTED_ANDROID_SONAME_MISSING_OR_WRONG: {soname.group(1) if soname else 'none'}")
        exported = sorted(set(re.findall(r"\bJava_net_rubygrapefruit_platform_internal_jni_[A-Za-z0-9_]+", symbols)))
        if not exported:
            raise RuntimeError("NO_NATIVE_PLATFORM_JNI_EXPORTS_FOUND")
        self.data["elfAudit"] = {
            "status": "PASS",
            "file": elf.name,
            "sha256": digest(elf),
            "sizeBytes": elf.stat().st_size,
            "class": "ELF64",
            "machine": "AArch64",
            "type": "DYN",
            "targetEvidence": {"compilerTarget": TARGET_TRIPLE, "api24SysrootLink": "clang++ driver trace selected the API-24 AArch64 sysroot; --no-undefined link passed"},
            "osAbiFieldInterpretation": "ELF OS/ABI label is not used alone to claim Android; target compiler, NDK sysroot, Android sonames, and no-undefined link provide the cross-build evidence.",
            "soname": soname.group(1),
            "needed": needed,
            "allowedNeeded": sorted(ALLOWED_NEEDED),
            "unexpectedNeeded": unexpected,
            "glibcVersionedSymbols": False,
            "hostRpathOrRunpath": False,
            "exportedNativeMethods": exported,
            "dynamicSymbolReport": "elf-dynamic-symbols.txt",
            "dynamicSectionReport": "elf-dynamic.txt",
            "versionInfoReport": "elf-version-info.txt",
            "apiFloorEvidence": "The requested API-24 experiment target was used, the driver trace confirms the API-24 AArch64 link path, and --no-undefined linking succeeded. This only checks link-time availability against that sysroot; it does not establish Android runtime compatibility or upstream support/minimum API 24.",
        }
        self.data["outcome"] = "PASS_PROTOTYPE_ONLY"
        self.phase("elf_audit", "PASS", architecture="AArch64", needed=needed, api=API_LEVEL,
                   glibcVersionedSymbols=False, hostRpath=False)
        shutil.copyfile(self.source / "LICENSE", self.output / "UPSTREAM-LICENSE-Apache-2.0.txt")
        self.data["artifactFiles"] = {
            "sharedLibrary": {"path": elf.name, "sha256": digest(elf)},
            "upstreamLicense": {"path": "UPSTREAM-LICENSE-Apache-2.0.txt", "sha256": digest(self.output / "UPSTREAM-LICENSE-Apache-2.0.txt")},
            "readme": {"path": "README-PROTOTYPE.txt", "sha256": digest(self.output / "README-PROTOTYPE.txt")},
        }
        self.write_evidence()

    def execute(self) -> int:
        try:
            self.verify_source()
            gradle, ndk = self.fetch_and_verify_toolchains()
            jni_dir, version_dir = self.generate_upstream_headers(gradle)
            self.compile_and_audit(ndk, jni_dir, version_dir)
            self.write_evidence()
            return 0
        except Exception as exc:  # evidence and logs are a deliverable even for fail-closed stops
            self.data["outcome"] = "BLOCKED_FAIL_CLOSED"
            self.data["blocker"] = {"message": str(exc), "type": type(exc).__name__}
            self.write_evidence()
            print(f"BLOCKED_FAIL_CLOSED: {exc}", file=sys.stderr, flush=True)
            return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="CI artifact directory")
    args = parser.parse_args()
    return PrototypeBuild(args.output).execute()


if __name__ == "__main__":
    raise SystemExit(main())
