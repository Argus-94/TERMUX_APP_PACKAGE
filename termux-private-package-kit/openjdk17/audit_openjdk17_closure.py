#!/usr/bin/env python3
"""Fail-closed static audit of the pinned OpenJDK runtime closure."""
from __future__ import annotations

import argparse
import email.parser
import hashlib
import json
import pathlib
import posixpath
import re
import subprocess
import sys
import tarfile
import tempfile
from typing import Any

APP_ID = "com.karat.aibuilder"
SOURCE_COMMIT = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
BUILDER_IMAGE = "ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9"
PACKAGE_COUNT = 36
DEPENDENCY_ALTERNATIVE_COUNT = 46
PACKAGE_SET_SHA256 = "ab01cbe7377249de44c22d0dc1dc83d92f8bedb7c61f8617a6809cc5974d7272"
SOURCE_CLOSURE_SHA256 = "378bf846bf86255a89c94510b4cb52a945b22e1df06c3624919badd85f6c402a"
PATCH_SHA256 = "f1155733943b8e98bd53e5ad825e0005106ec4c7c89f9bc3bb334dc4b9b8b7bc"
PREFIXES = {
    "/data/user/0/com.karat.aibuilder/files/usr",
    "/data/data/com.karat.aibuilder/files/usr",
}
PLATFORM_LIBS = {
    "libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so",
    "libz.so", "libgcc.so", "libpthread.so", "libatomic.so", "libaaudio.so",
}
PACKAGE_FILE_ELF_PROVIDERS = {'libandroid-glob.so': ('libandroid-glob', 'lib/libandroid-glob.so'), 'libandroid-spawn.so': ('libandroid-spawn', 'lib/libandroid-spawn.so'), 'libandroid-support.so': ('libandroid-support', 'lib/libandroid-support.so'), 'libandroid-sysv-semaphore.so': ('libandroid-sysv-semaphore', 'lib/libandroid-sysv-semaphore.so'), 'libtermux-platform-ns.so': ('libandroid-stub', 'lib/libtermux-platform-ns.so'), 'libjli.so': ('openjdk-17', 'lib/jvm/java-17-openjdk/lib/libjli.so'), 'libjava.so': ('openjdk-17', 'lib/jvm/java-17-openjdk/lib/libjava.so'), 'libjvm.so': ('openjdk-17', 'lib/jvm/java-17-openjdk/lib/server/libjvm.so'), 'libandroid-shmem.so': ('libandroid-shmem', 'lib/libandroid-shmem.so'), 'libandroid.so': ('libandroid-stub', 'lib/libandroid.so'), 'libmediandk.so': ('libandroid-stub', 'lib/libmediandk.so'), 'libOpenSLES.so': ('libandroid-stub', 'lib/libOpenSLES.so'), 'libbinder_ndk.so': ('libandroid-stub', 'lib/libbinder_ndk.so')}
PACKAGE_FILE_ELF_SYMLINK_PROVIDERS = {}
ANDROID_PATH_RE = re.compile(rb"/data/(?:data|user/0)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._+-]+)*")
LICENSE_NAME_RE = re.compile(r"(?i)^(copyright|copying|license|licence)(?:[._-].*)?$")
CONTROL_ALLOWLIST = {"control", "md5sums", "conffiles", "triggers", "shlibs", "symbols", "copyright", "postinst", "postrm", "preinst", "prerm", "config"}
MAX_DEB_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

EXPECTED_PACKAGES = {'abseil-cpp': ('20260526.0', 'aarch64', 'Apache-2.0'), 'alsa-lib': ('1.2.16.1', 'aarch64', 'LGPL-2.1'), 'alsa-plugins': ('1.2.12-1', 'aarch64', 'LGPL-2.1'), 'dbus': ('1.16.2-3', 'aarch64', 'GPL-2.0'), 'libandroid-execinfo': ('0.1-3', 'aarch64', 'BSD 2-Clause'), 'libandroid-glob': ('0.6-3', 'aarch64', 'BSD 3-Clause'), 'libandroid-shmem': ('0.7', 'aarch64', 'BSD 3-Clause'), 'libandroid-spawn': ('0.3', 'aarch64', 'BSD 2-Clause'), 'libandroid-stub': ('30-2', 'aarch64', 'NCSA'), 'libandroid-support': ('29-1', 'aarch64', 'Apache-2.0, MIT'), 'libandroid-sysv-semaphore': ('0.1-1', 'aarch64', 'BSD 2-Clause'), 'libc++': ('30', 'aarch64', 'NCSA'), 'libexpat': ('2.9.0', 'aarch64', 'MIT'), 'libflac': ('1.5.0-1', 'aarch64', 'GPL-2.0, LGPL-2.1, BSD 3-Clause'), 'libiconv': ('1.19', 'aarch64', 'LGPL-2.1, GPL-3.0'), 'libjpeg-turbo': ('3.2.0', 'aarch64', 'IJG, BSD 3-Clause, ZLIB'), 'libltdl': ('2.6.2', 'aarch64', 'GPL-2.0'), 'libmp3lame': ('4.0-1', 'aarch64', 'LGPL-2.0'), 'libmpg123': ('1.33.7', 'aarch64', 'LGPL-2.1'), 'libogg': ('1.3.6-1', 'aarch64', 'BSD 3-Clause'), 'libopus': ('1.6.1', 'aarch64', 'BSD 3-Clause'), 'libsndfile': ('1.2.2-3', 'aarch64', 'LGPL-2.1'), 'libsoxr': ('0.1.3-8', 'aarch64', 'LGPL-2.1'), 'libvorbis': ('1.3.7-4', 'aarch64', 'BSD 3-Clause'), 'libwebrtc-audio-processing': ('1.3-5', 'aarch64', 'BSD 3-Clause'), 'libx11': ('1.8.13-1', 'aarch64', 'MIT, X11'), 'libxau': ('1.0.12-2', 'aarch64', 'MIT'), 'libxcb': ('1.17.0-1', 'aarch64', 'MIT'), 'libxdmcp': ('1.1.5-2', 'aarch64', 'MIT'), 'littlecms': ('2.19.1', 'aarch64', 'MIT'), 'openjdk-17': ('17.0.20', 'aarch64', 'GPL-2.0'), 'pulseaudio': ('17.0-4', 'aarch64', 'GPL-2.0'), 'speexdsp': ('1.2.1-1', 'aarch64', 'BSD 3-Clause'), 'xorg-util-macros': ('1.20.2', 'all', 'HPND, MIT'), 'xorgproto': ('2026.1', 'all', 'MIT'), 'zlib': ('1.3.2', 'aarch64', 'ZLIB')}

EXPECTED_BASE_LICENSE_EVIDENCE = {'artifact': 'AIBuilder-Expo-v476/assets/termux-bootstrap/termux-bootstrap-aarch64.zip', 'archiveSha256': '08a447f60c06783f33561583553149cf992ac7d9779071c71b8aaeeb452451b4', 'packageName': 'termux-licenses', 'version': '2.1', 'architecture': 'all', 'packageStatus': 'install ok installed', 'licenseFilesSha256': {'share/LICENSES/Apache-2.0.txt': 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', 'share/LICENSES/GPL-2.0.txt': '8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643', 'share/LICENSES/GPL-3.0.txt': '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986', 'share/LICENSES/LGPL-2.1.txt': 'dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551', 'share/LICENSES/MPL-2.0.txt': '9bc20a15c61407693f16f5bb482035e60c9ac3e9c6611c6c3b6623a1a4453578', 'share/LICENSES/Public Domain.txt': 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499', 'share/LICENSES/NCSA.txt': 'aecb9504bcc76b4ff5e8ff1266344bb607b6bed2bfc3dd8b35233d941401d01e', 'share/LICENSES/LGPL-2.0.txt': 'b7993225104d90ddd8024fd838faf300bea5e83d91203eab98e29512acebd69c'}, 'verification': 'Eight relevant ZIP license payloads were byte-for-byte compared with pinned termux-licenses source; package status comes from the embedded v476 archive. This is archive evidence, not device observation.', 'deviceObserved': False}
EXPECTED_SOURCE_LICENSE_EVIDENCE = {'openjdk-17': {'sourceArchives': [{'url': 'https://github.com/openjdk/jdk17u/archive/refs/tags/jdk-17.0.20-ga.tar.gz', 'sha256': 'ba3ac4b9d7f2c050f46ddcec39b4258660a3f09836f5a71617fd3f7311d06c0b'}], 'licenseFiles': {'LICENSE': '4b9abebc4338048a7c2dc184e9f800deb349366bdf28eb23c2677a77b4c87726', 'ADDITIONAL_LICENSE_INFO': 'a69bce275ba7a3570af6579cb0f55682cd75fedfcd49e0e8e9022270c447c916', 'ASSEMBLY_EXCEPTION': 'a44eb7b5caf5534c6ef536b21edb40b4d6babf91bf97d9d45596868618b2c6fb'}, 'packagePaths': {'LICENSE': 'share/doc/openjdk-17/LICENSE', 'ADDITIONAL_LICENSE_INFO': 'share/doc/openjdk-17/ADDITIONAL_LICENSE_INFO', 'ASSEMBLY_EXCEPTION': 'share/doc/openjdk-17/ASSEMBLY_EXCEPTION'}}}
EXPECTED_SHARED_LICENSES = {"libc++":{"NCSA"},"libandroid-stub":{"NCSA"},"libmp3lame":{"LGPL-2.0"},"libltdl":{"GPL-2.0"}}
EXPECTED_LOCAL_LICENSE_PATHS = {"openjdk-17": set(EXPECTED_SOURCE_LICENSE_EVIDENCE["openjdk-17"]["packagePaths"].values()),"libjpeg-turbo":{"share/doc/libjpeg-turbo/README.ijg","share/doc/libjpeg-turbo/LICENSE.md"}}

class AuditError(Exception):
    pass


def require(ok: bool, code: str, detail: str = "") -> None:
    if not ok:
        raise AuditError(code + (":" + detail if detail else ""))


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_prefix(value: str) -> str:
    prefix = value.rstrip("/")
    require(prefix in PREFIXES, "PREFIX_NOT_CANONICAL")
    return prefix


def normalize_member(raw: str) -> str:
    value = raw
    while value.startswith("./"):
        value = value[2:]
    require(value not in {"", "."} and not value.startswith("/") and "\\" not in value and "\x00" not in value,
            "PAYLOAD_PATH_INVALID", raw)
    parts = value.split("/")
    require(all(part not in {"", ".", ".."} for part in parts), "PAYLOAD_PATH_TRAVERSAL", raw)
    return "/" + "/".join(parts)


def ensure_payload_path(path: str, prefix: str, is_dir: bool) -> None:
    if is_dir:
        require(prefix.startswith(path.rstrip("/") + "/") or path == prefix or path.startswith(prefix + "/"),
                "DIRECTORY_OUTSIDE_PRIVATE_PREFIX", path)
    else:
        require(path == prefix or path.startswith(prefix + "/"), "PAYLOAD_OUTSIDE_PRIVATE_PREFIX", path)


def resolve_link(member_path: str, target: str, hardlink: bool, prefix: str) -> str:
    require(target and "\\" not in target and "\x00" not in target, "LINK_TARGET_INVALID", member_path)
    if target.startswith("/"):
        resolved = posixpath.normpath(target)
    elif hardlink:
        resolved = normalize_member(target)
    else:
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member_path), target))
    require(resolved == prefix or resolved.startswith(prefix + "/"), "LINK_ESCAPES_PRIVATE_PREFIX", member_path + "->" + target)
    return resolved


def scan_paths(data: bytes, prefix: str, package_path: str) -> None:
    home = prefix.removesuffix("/usr") + "/home"
    for match in ANDROID_PATH_RE.finditer(data):
        found = match.group(0).decode("ascii", "strict")
        require(posixpath.normpath(found) == found, "ANDROID_PATH_NOT_CANONICAL", package_path + ":" + found)
        require(found in {prefix, home} or found.startswith(prefix + "/") or found.startswith(home + "/"),
                "FOREIGN_ANDROID_APP_PATH", package_path + ":" + found)
    require(b"/storage/emulated/0/AIBuilderTermux" not in data, "PERSISTENT_PROJECT_ROOT_EMBEDDED", package_path)


def run(command: list[str], code: str, timeout: int = 120) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise AuditError(code) from exc
    require(result.returncode == 0, code, result.stderr.decode("utf-8", "replace")[:400])
    return result


def parse_control_archive(deb: pathlib.Path, prefix: str) -> tuple[dict[str, bytes], dict[str, str]]:
    proc = subprocess.Popen(["dpkg-deb", "--ctrl-tarfile", str(deb)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    files: dict[str, bytes] = {}
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|*") as archive:
            for member in archive:
                raw = member.name.removeprefix("./")
                if raw in {"", "."} and member.isdir():
                    continue
                require("/" not in raw and raw in CONTROL_ALLOWLIST, "CONTROL_MEMBER_NOT_ALLOWLISTED", raw)
                require(raw not in files and member.isreg(), "CONTROL_MEMBER_DUPLICATE_OR_NONREGULAR", raw)
                require(member.size <= 2 * 1024 * 1024, "CONTROL_MEMBER_TOO_LARGE", raw)
                stream = archive.extractfile(member)
                require(stream is not None, "CONTROL_MEMBER_UNREADABLE", raw)
                data = stream.read(member.size + 1)
                require(len(data) == member.size, "CONTROL_MEMBER_SIZE_MISMATCH", raw)
                files[raw] = data
                scan_paths(data, prefix, "control/" + raw)
        proc.stdout.close()
        stderr = proc.stderr.read(8192) if proc.stderr else b""
        require(proc.wait(timeout=120) == 0, "CONTROL_ARCHIVE_INVALID", stderr.decode("utf-8", "replace")[:400])
    except Exception:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        raise
    require("control" in files, "CONTROL_FILE_MISSING")
    try:
        fields = email.parser.Parser().parsestr(files["control"].decode("utf-8", "strict"))
    except (UnicodeError, ValueError) as exc:
        raise AuditError("CONTROL_NOT_UTF8") from exc
    for key in ("Package", "Version", "Architecture", "Maintainer", "Description"):
        require(len(fields.get_all(key, [])) == 1, "CONTROL_FIELD_MISSING_OR_DUPLICATE", key)
    for script_name in ("preinst", "postinst", "prerm", "postrm", "config"):
        if script_name in files:
            result = subprocess.run(["bash", "-n"], input=files[script_name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            require(result.returncode == 0, "MAINTAINER_SCRIPT_SYNTAX_INVALID", script_name)
            forbidden = re.search(rb"(?im)^\s*(?:sudo|su|mount|umount)\b|\brm\s+-rf\s+/(?:\s|$)", files[script_name])
            require(forbidden is None, "MAINTAINER_SCRIPT_DANGEROUS_COMMAND", script_name)
    return files, {key: str(fields.get(key, "")) for key in ("Package", "Version", "Architecture", "Depends", "Pre-Depends", "Recommends", "Suggests", "Provides", "Conflicts", "Breaks", "Replaces", "License")}


def inspect_elf(path: pathlib.Path, rel: str, prefix: str) -> dict[str, Any]:
    text = run(["readelf", "-hW", str(path)], "READELF_HEADER_FAILED").stdout.decode("utf-8", "replace")
    require(re.search(r"Class:\s+ELF64", text) is not None and
            re.search(r"Data:\s+2's complement, little endian", text) is not None and
            re.search(r"Machine:\s+AArch64", text) is not None, "ELF_NOT_AARCH64", rel)
    prog = run(["readelf", "-lW", str(path)], "READELF_PROGRAM_HEADERS_FAILED").stdout.decode("utf-8", "replace")
    interpreter_match = re.search(r"Requesting program interpreter: ([^\]]+)", prog)
    interpreter = interpreter_match.group(1).strip() if interpreter_match else None
    require(interpreter is None or interpreter == "/system/bin/linker64", "ELF_INTERPRETER_NOT_ANDROID_LINKER64", rel + ":" + str(interpreter))
    dynamic = run(["readelf", "-dW", str(path)], "READELF_DYNAMIC_FAILED").stdout.decode("utf-8", "replace")
    needed = sorted(set(re.findall(r"\(NEEDED\).*?Shared library: \[([^]]+)\]", dynamic)))
    soname_match = re.search(r"\(SONAME\).*?Library soname: \[([^]]+)\]", dynamic)
    soname = soname_match.group(1) if soname_match else None
    rpaths: list[str] = []
    for value in re.findall(r"\((?:RPATH|RUNPATH)\).*?Library (?:rpath|runpath): \[([^]]*)\]", dynamic):
        for item in filter(None, value.split(":")):
            if item.startswith("/"):
                resolved = posixpath.normpath(item)
            elif item in {"$ORIGIN", "${ORIGIN}"}:
                resolved = posixpath.dirname(prefix + "/" + rel)
            elif item.startswith(("$ORIGIN/", "${ORIGIN}/")):
                tail = item.split("/", 1)[1]
                if tail.startswith("{"):
                    tail = tail.split("}/", 1)[1] if "}/" in tail else ""
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(prefix + "/" + rel), tail))
            else:
                raise AuditError("ELF_RPATH_NOT_PRIVATE_OR_ORIGIN:" + rel)
            require(resolved == prefix or resolved.startswith(prefix + "/"), "ELF_RPATH_ESCAPES_PRIVATE_PREFIX", rel + ":" + item)
            rpaths.append(item)
    return {"path": rel, "soname": soname, "needed": needed, "interpreter": interpreter, "rpaths": rpaths}


def validate_elf_needed_providers(all_elf: list[dict[str, Any]], library_symlinks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    sonames: dict[str, list[dict[str, Any]]] = {}
    for item in all_elf:
        if item.get("soname"):
            sonames.setdefault(item["soname"], []).append(item)
    for library, providers in sonames.items():
        require(len(providers) == 1, "ELF_SONAME_PROVIDER_AMBIGUOUS", library)
    provider_paths: dict[str, dict[str, Any]] = {}
    evidence = []
    for library, (package, path) in PACKAGE_FILE_ELF_PROVIDERS.items():
        matches = [item for item in all_elf if item.get("package") == package and item.get("path") == path]
        require(len(matches) == 1, "ELF_PACKAGE_FILE_PROVIDER_NOT_EXACTLY_ONCE", library)
        item = matches[0]
        require(item.get("soname") in {None, library}, "ELF_PACKAGE_FILE_PROVIDER_SONAME_MISMATCH", library)
        provider_paths[library] = item
        evidence.append({"library": library, "package": package, "path": path, "soname": item.get("soname"),
                         "basis": "exact packaged AArch64 ELF path; package and recipe are pinned in the candidate closure"})
    symlink_evidence = []
    if library_symlinks is not None:
        for library, (package, path, target) in PACKAGE_FILE_ELF_SYMLINK_PROVIDERS.items():
            links = [link for link in library_symlinks if link.get("package") == package and
                     link.get("path") == path and link.get("target") == target]
            require(len(links) == 1, "ELF_PACKAGE_FILE_SYMLINK_PROVIDER_NOT_EXACTLY_ONCE", library)
            targets = [item for item in all_elf if item.get("package") == package and item.get("path") == target]
            require(len(targets) == 1, "ELF_PACKAGE_FILE_SYMLINK_TARGET_NOT_EXACTLY_ONCE", library)
            provider_paths[library] = targets[0]
            symlink_evidence.append({"library": library, "package": package, "path": path, "target": target,
                                     "targetSoname": targets[0].get("soname"),
                                     "basis": "exact package-local symlink path resolves to one pinned AArch64 ELF in the same package"})
    for item in all_elf:
        for library in item.get("needed", []):
            if library in PLATFORM_LIBS:
                continue
            matches = sonames.get(library, [])
            if not matches:
                require(library in provider_paths, "ELF_NEEDED_LIBRARY_UNPROVEN", item["package"] + ":" + item["path"] + ":" + library)
            else:
                require(len(matches) == 1, "ELF_NEEDED_LIBRARY_PROVIDER_AMBIGUOUS", item["package"] + ":" + item["path"] + ":" + library)
    return {"providers": sorted(PLATFORM_LIBS | set(sonames) | set(provider_paths)),
            "packageFileProviders": evidence, "packageFileSymlinkProviders": symlink_evidence}


def license_roots(name: str, prefix: str) -> list[str]:
    return [prefix + "/share/doc/" + name + "/"]


def is_license_doc(path: str, name: str, prefix: str) -> bool:
    if path in {prefix + "/" + x for x in EXPECTED_LOCAL_LICENSE_PATHS.get(name, set())}: return True
    for root in license_roots(name, prefix):
        if path.startswith(root):
            leaf = path[len(root):]
            return "/" not in leaf and LICENSE_NAME_RE.fullmatch(leaf) is not None
    return False


def expected_base_license_evidence(value: Any) -> dict[str, Any]:
    require(value == EXPECTED_BASE_LICENSE_EVIDENCE, "BASE_LICENSE_PROVIDER_EVIDENCE_NOT_ALLOWLISTED")
    return EXPECTED_BASE_LICENSE_EVIDENCE


def validate_manifest(args: argparse.Namespace) -> tuple[dict[str, Any], str, list[dict[str, Any]]]:
    manifest_bytes = args.package_set.read_bytes()
    require(hashlib.sha256(manifest_bytes).hexdigest() == PACKAGE_SET_SHA256, "PACKAGE_SET_SHA256_NOT_ALLOWLISTED")
    closure_bytes = args.source_closure.read_bytes()
    require(hashlib.sha256(closure_bytes).hexdigest() == SOURCE_CLOSURE_SHA256, "SOURCE_CLOSURE_SHA256_NOT_ALLOWLISTED")
    manifest = json.loads(manifest_bytes.decode("utf-8", "strict"))
    require(manifest.get("schemaVersion") == 1 and manifest.get("channel") == "candidate-only", "PACKAGE_SET_NOT_CANDIDATE_ONLY")
    source = manifest.get("source", {})
    require(source.get("commit") == SOURCE_COMMIT and source.get("builderImage") == BUILDER_IMAGE, "SOURCE_OR_BUILDER_NOT_ALLOWLISTED")
    require(source.get("restrictedAppArmorProfileSha256") == "ec7680c466c03c9354b890e6860f9fb3e1b5512d380c9d05e426cb47548abbe8", "APPARMOR_PROFILE_NOT_PINNED")
    target = manifest.get("target", {})
    require(target.get("applicationId") == APP_ID and target.get("architecture") == "aarch64", "TARGET_NOT_ALLOWLISTED")
    prefix = normalize_prefix(args.prefix)
    require(target.get("modeledPrefix") == prefix and target.get("modeledDataDir") == prefix.removesuffix("/files/usr"), "MODELED_PREFIX_MISMATCH")
    gate = manifest.get("releaseGate", {})
    require(gate == {"publicationAllowed": False, "deviceInstall": "NOT RUN", "rollback": "NOT RUN", "deviceEvidenceSha256": None}, "RELEASE_GATE_NOT_BLOCKED")
    expected_closure = {"profile": "openjdk17-candidate", "rootPackages": ["openjdk-17"], "buildTargetPackage": "openjdk-17",
                        "expectedPackageCount": PACKAGE_COUNT, "expectedDependencyAlternativeCount": DEPENDENCY_ALTERNATIVE_COUNT}
    closure = manifest.get("sourceClosure", {})
    for key, value in expected_closure.items():
        require(closure.get(key) == value, "SOURCE_CLOSURE_NOT_ALLOWLISTED_" + key)
    evidence = expected_base_license_evidence(manifest.get("baseLicenseProviderEvidence"))
    require(manifest.get("sourceLicenseEvidence") == EXPECTED_SOURCE_LICENSE_EVIDENCE, "SOURCE_LICENSE_EVIDENCE_NOT_ALLOWLISTED")
    modifications = manifest.get("buildModifications", {})
    require(modifications.get("patchPath") == "termux-private-package-kit/openjdk17/openjdk17-license-notices.patch" and
            modifications.get("patchSha256") == PATCH_SHA256, "BUILD_PATCH_NOT_ALLOWLISTED")
    root = pathlib.Path(__file__).resolve().parents[2]
    patch = root / modifications["patchPath"]
    require(patch.is_file() and not patch.is_symlink() and sha256_file(patch) == PATCH_SHA256, "BUILD_PATCH_FILE_HASH_MISMATCH")
    runtime = manifest.get("runtimeDependencies", {})
    require(runtime == {"openjdkRecommendationsExcludedFromInstallSimulation": ["ca-certificates-java", "openjdk-17-x", "resolv-conf"],
                        "buildOnlyDependencies": ["cups", "fontconfig", "libxrandr", "libxt", "xorgproto", "alsa-lib"]},
            "RUNTIME_DEPENDENCY_METADATA_NOT_ALLOWLISTED")
    specs = manifest.get("packages")
    require(isinstance(specs, list) and len(specs) == PACKAGE_COUNT, "PACKAGE_SET_COUNT_NOT_ALLOWLISTED")
    require([x.get("name") for x in specs if isinstance(x, dict)] == sorted(EXPECTED_PACKAGES), "PACKAGE_NAMES_NOT_EXACT_OR_SORTED")
    for spec in specs:
        name = spec["name"]
        version, architecture, license_expression = EXPECTED_PACKAGES[name]
        require((spec.get("version"), spec.get("architecture"), spec.get("licenseExpression")) ==
                (version, architecture, license_expression), "PACKAGE_IDENTITY_NOT_ALLOWLISTED", name)
        require(isinstance(spec.get("recipeSha256"), str) and re.fullmatch(r"[0-9a-f]{64}", spec["recipeSha256"]) is not None,
                "RECIPE_HASH_INVALID", name)
        snapshot = json.loads(closure_bytes.decode("utf-8"))
        pinned = next(x for x in snapshot["packages"] if x["name"] == name)
        for field, value in pinned.items():
            require(spec.get(field) == value, "PACKAGE_SOURCE_METADATA_DRIFT", name + ":" + field)
    return manifest, prefix, specs


def audit_one(deb: pathlib.Path, spec: dict[str, Any], prefix: str, temp: pathlib.Path) -> dict[str, Any]:
    require(deb.is_file() and not deb.is_symlink() and 0 < deb.stat().st_size <= MAX_DEB_BYTES, "DEB_INVALID", deb.name)
    digest = sha256_file(deb)
    controls, fields = parse_control_archive(deb, prefix)
    name = spec["name"]
    require((fields["Package"], fields["Version"], fields["Architecture"]) ==
            (name, spec["version"], spec["architecture"]), "DEB_IDENTITY_NOT_ALLOWLISTED", name)
    if fields.get("License"):
        require(fields["License"] == spec["licenseExpression"], "CONTROL_LICENSE_NOT_ALLOWLISTED", name)
    proc = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(deb)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    paths: set[str] = set()
    license_paths: set[str] = set()
    license_hashes: dict[str, str] = {}
    shared_license_targets: set[str] = set()
    elf_records: list[dict[str, Any]] = []
    library_symlinks: list[dict[str, str]] = []
    total = count = 0
    required_elf = {"lib/jvm/java-17-openjdk/bin/java", "lib/jvm/java-17-openjdk/bin/javac", "lib/jvm/java-17-openjdk/lib/server/libjvm.so"}
    found_required_elf = set()
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|*") as archive:
            for member in archive:
                if member.name in {"", ".", "./"} and member.isdir():
                    continue
                path = normalize_member(member.name)
                ensure_payload_path(path, prefix, member.isdir())
                require(path not in paths, "PAYLOAD_PATH_DUPLICATE", name + ":" + path)
                paths.add(path)
                count += 1
                total += max(member.size, 0)
                require(count <= 200000 and member.size <= MAX_MEMBER_BYTES and total <= MAX_TOTAL_BYTES, "PAYLOAD_SIZE_LIMIT", name)
                if member.issym() or member.islnk():
                    resolved = resolve_link(path, member.linkname, member.islnk(), prefix)
                    if member.issym() and path.startswith(prefix + "/lib/") and ".so" in pathlib.PurePosixPath(path).name:
                        target_rel = resolved[len(prefix) + 1:] if resolved.startswith(prefix + "/") else ""
                        library_symlinks.append({"path": path[len(prefix) + 1:], "target": target_rel})
                    if is_license_doc(path, name, prefix):
                        license_paths.add(path)
                        if resolved.startswith(prefix + "/share/LICENSES/"):
                            target_rel = resolved[len(prefix) + 1:]
                            require(target_rel in EXPECTED_BASE_LICENSE_EVIDENCE["licenseFilesSha256"],
                                    "SHARED_LICENSE_PROVIDER_NOT_ALLOWLISTED", name + ":" + target_rel)
                            shared_license_targets.add(target_rel)
                    continue
                require(member.isdir() or member.isreg(), "PAYLOAD_MEMBER_TYPE_REJECTED", name + ":" + path)
                if member.isdir():
                    continue
                stream = archive.extractfile(member)
                require(stream is not None, "PAYLOAD_MEMBER_UNREADABLE", name + ":" + path)
                content = stream.read(member.size + 1)
                require(len(content) == member.size, "PAYLOAD_MEMBER_SIZE_MISMATCH", name + ":" + path)
                scan_paths(content, prefix, name + ":" + path)
                if is_license_doc(path, name, prefix):
                    require(bool(content), "LICENSE_DOCUMENT_EMPTY", name + ":" + path)
                    license_paths.add(path)
                    license_hashes[path] = hashlib.sha256(content).hexdigest()
                if content.startswith(b"\x7fELF"):
                    relative = path[len(prefix) + 1:]
                    if name == "openjdk-17" and relative in required_elf:
                        require("/bin/" not in relative or bool(member.mode & 0o111), "OPENJDK_LAUNCHER_NOT_EXECUTABLE", relative)
                        found_required_elf.add(relative)
                    temp_file = temp / (name + "-" + str(len(elf_records)))
                    temp_file.write_bytes(content)
                    elf_records.append(inspect_elf(temp_file, relative, prefix))
        proc.stdout.close()
        stderr = proc.stderr.read(8192) if proc.stderr else b""
        require(proc.wait(timeout=180) == 0, "PAYLOAD_ARCHIVE_INVALID", stderr.decode("utf-8", "replace")[:400])
    except Exception:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        raise
    require(count > 0, "EMPTY_PACKAGE_PAYLOAD", name)
    require(bool(license_paths), "LICENSE_EVIDENCE_MISSING", name)
    if name in EXPECTED_SHARED_LICENSES:
        require(shared_license_targets == {"share/LICENSES/" + x + ".txt" for x in EXPECTED_SHARED_LICENSES[name]},
                "SHARED_LICENSE_TARGET_SET_MISMATCH", name)
    if name in EXPECTED_LOCAL_LICENSE_PATHS:
        expected_paths = {prefix + "/" + x for x in EXPECTED_LOCAL_LICENSE_PATHS[name]}
        require(expected_paths <= license_paths, "LOCAL_LICENSE_FILE_SET_INCOMPLETE", name)
        for path in expected_paths:
            require(path in license_hashes, "LOCAL_LICENSE_NOT_REGULAR", name + ":" + path)
    if name == "openjdk-17":
        notice_hashes = {"LICENSE":"4b9abebc4338048a7c2dc184e9f800deb349366bdf28eb23c2677a77b4c87726", "ADDITIONAL_LICENSE_INFO":"a69bce275ba7a3570af6579cb0f55682cd75fedfcd49e0e8e9022270c447c916", "ASSEMBLY_EXCEPTION":"a44eb7b5caf5534c6ef536b21edb40b4d6babf91bf97d9d45596868618b2c6fb"}
        for leaf, digest_expected in notice_hashes.items():
            path = prefix + "/share/doc/openjdk-17/" + leaf
            require(license_hashes.get(path) == digest_expected, "OPENJDK_NOTICE_HASH_MISMATCH", leaf)
    if name == "openjdk-17":
        require(found_required_elf == required_elf, "OPENJDK_MANDATORY_ELF_MISSING")
    return {"name": name, "version": spec["version"], "architecture": spec["architecture"], "sha256": digest,
            "filename": deb.name, "licenseExpression": spec["licenseExpression"], "licenseEvidencePaths": sorted(license_paths),
            "licenseEvidenceSha256": {path: license_hashes[path] for path in sorted(license_hashes)},
            "sharedLicenseProviderTargets": sorted(shared_license_targets),
            "licenseEvidenceKind": "pinned Termux source recipe output; package-local regular license payload or exact v476 shared-license provider target",
            "payloadEntries": count, "payloadBytes": total, "elf": elf_records, "librarySymlinks": library_symlinks,
            "depends": fields.get("Depends", ""), "preDepends": fields.get("Pre-Depends", ""),
            "recommends": fields.get("Recommends", ""),
            "maintainerScripts": sorted(set(controls) & {"preinst", "postinst", "prerm", "postrm", "config"})}


def audit(args: argparse.Namespace) -> dict[str, Any]:
    manifest, prefix, specs = validate_manifest(args)
    files = sorted(args.packages_dir.glob("*.deb"))
    require(len(files) == PACKAGE_COUNT, "DEB_COUNT_NOT_EXACT")
    file_by_name: dict[str, pathlib.Path] = {}
    for file in files:
        package = run(["dpkg-deb", "-f", str(file), "Package"], "DPKG_PACKAGE_FIELD_READ_FAILED").stdout.decode().strip()
        require(package in EXPECTED_PACKAGES and package not in file_by_name, "DEB_NAME_NOT_ALLOWLISTED_OR_DUPLICATE", package)
        file_by_name[package] = file
    require(set(file_by_name) == set(EXPECTED_PACKAGES), "DEB_NAME_SET_MISMATCH")
    all_results: list[dict[str, Any]] = []
    all_elf: list[dict[str, Any]] = []
    all_library_symlinks: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="aib-openjdk17-audit-") as td:
        temp = pathlib.Path(td)
        for spec in specs:
            result = audit_one(file_by_name[spec["name"]], spec, prefix, temp)
            all_results.append(result)
            all_elf.extend({**elf, "package": spec["name"]} for elf in result["elf"])
            all_library_symlinks.extend({**link, "package": spec["name"]} for link in result["librarySymlinks"])
    providers = validate_elf_needed_providers(all_elf, all_library_symlinks)
    return {"schemaVersion": 1, "ok": True,
            "status": "static-audit-passed; installation-and-device-runtime-unverified",
            "applicationId": APP_ID, "prefix": prefix, "prefixProvenance": "ci-model-only; device-observation-not-run",
            "baseLicenseProviderEvidence": manifest["baseLicenseProviderEvidence"],
            "baseLicenseProviderStatus": "v476 embedded bootstrap archive and eight relevant license payload hashes verified; actual device state not observed",
            "sourceCommit": SOURCE_COMMIT, "builderImage": BUILDER_IMAGE,
            "sourceClosureProfile": "openjdk17-candidate", "sourceBuildTargetPackage": "openjdk-17",
            "restrictedAppArmorProfileSha256": manifest["source"]["restrictedAppArmorProfileSha256"],
            "sourceClosurePackageCount": PACKAGE_COUNT, "sourceClosureDependencyAlternativeCount": DEPENDENCY_ALTERNATIVE_COUNT,
            "platformElfRequirements": manifest["platformElfRequirements"],
            "candidatePackageCount": len(all_results), "packages": all_results,
            "elfProviders": providers["providers"], "elfPackageFileProviders": providers["packageFileProviders"],
            "elfPackageFileSymlinkProviders": providers["packageFileSymlinkProviders"],
            "elfCount": len(all_elf), "deviceInstall": "NOT RUN", "rollback": "NOT RUN"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-set", type=pathlib.Path, required=True)
    parser.add_argument("--source-closure", type=pathlib.Path, required=True)
    parser.add_argument("--packages-dir", type=pathlib.Path, required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        report = audit(args)
        args.report.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        print("OPENJDK17_CANDIDATE_STATIC_AUDIT_OK packages={} elf={} app_private_prefix=1 device_install=NOT_RUN".format(
            report["candidatePackageCount"], report["elfCount"]))
        return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print("OPENJDK17_CANDIDATE_STATIC_AUDIT_REJECTED:" + (str(exc) if isinstance(exc, AuditError) else "INPUT_INVALID"), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
