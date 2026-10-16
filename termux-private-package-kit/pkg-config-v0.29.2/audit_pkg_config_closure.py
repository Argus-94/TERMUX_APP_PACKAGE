#!/usr/bin/env python3
"""Fail-closed static audit of the pinned pkg-config runtime closure."""
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
PACKAGE_COUNT = 22
DEPENDENCY_ALTERNATIVE_COUNT = 33
PACKAGE_SET_SHA256 = "7a72402868ddbcd04dd1de1b799235bb7bcc3c7685b63fdf6e6fd9d48eda9a93"
SOURCE_CLOSURE_SHA256 = "84fbfa0980dbe28aa348d84003b715571c53891cdeaa6c03f1d5b0291cd635f6"
PATCH_SHA256 = "f29765e65520dacedb70c79e6156ffa247e47849c982d0e233ed4a88817876c9"
PREFIXES = {
    "/data/user/0/com.karat.aibuilder/files/usr",
    "/data/data/com.karat.aibuilder/files/usr",
}
PLATFORM_LIBS = {
    "libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so",
    "libz.so", "libgcc.so", "libpthread.so", "libatomic.so",
}
PACKAGE_FILE_ELF_PROVIDERS = {
    "libandroid-posix-semaphore.so": ("libandroid-posix-semaphore", "lib/libandroid-posix-semaphore.so"),
    "libandroid-support.so": ("libandroid-support", "lib/libandroid-support.so"),
}
ANDROID_PATH_RE = re.compile(rb"/data/(?:data|user/0)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._+-]+)*")
LICENSE_NAME_RE = re.compile(r"(?i)^(copyright|copying|license|licence)(?:[._-].*)?$")
CONTROL_ALLOWLIST = {"control", "md5sums", "conffiles", "triggers", "shlibs", "symbols", "copyright", "postinst", "postrm", "preinst", "prerm", "config"}
MAX_DEB_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

EXPECTED_PACKAGES = {
    "ca-certificates": ("1:2026.09.25", "all", "MPL-2.0"),
    "gdbm": ("1.26-1", "aarch64", "GPL-3.0"),
    "glib": ("2.90.1", "aarch64", "LGPL-2.1"),
    "libandroid-posix-semaphore": ("0.1-4", "aarch64", "MIT"),
    "libandroid-support": ("29-1", "aarch64", "Apache-2.0, MIT"),
    "libbz2": ("1.0.8-8", "aarch64", "BSD"),
    "libcrypt": ("0.2-6", "aarch64", "BSD 2-Clause"),
    "libexpat": ("2.9.0", "aarch64", "MIT"),
    "libffi": ("3.8.0", "aarch64", "MIT"),
    "libiconv": ("1.19", "aarch64", "LGPL-2.1, GPL-3.0"),
    "liblzma": ("5.8.4", "aarch64", "LGPL-2.1, GPL-2.0, GPL-3.0"),
    "libsqlite": ("3.54.0", "aarch64", "Public Domain"),
    "ncurses": ("6.6.20260307+really6.5.20250830", "aarch64", "MIT"),
    "ncurses-ui-libs": ("6.6.20260307+really6.5.20250830", "aarch64", "MIT"),
    "openssl": ("1:3.6.5", "aarch64", "Apache-2.0"),
    "pcre2": ("10.49", "aarch64", "BSD 3-Clause"),
    "pkg-config": ("0.29.2-3", "aarch64", "GPL-2.0"),
    "python": ("3.14.6-1", "aarch64", "custom"),
    "readline": ("8.3.6", "aarch64", "GPL-3.0"),
    "resolv-conf": ("1.3", "aarch64", "Public Domain"),
    "zlib": ("1.3.2", "aarch64", "ZLIB"),
    "zstd": ("1.5.7-1", "aarch64", "GPL-2.0"),
}
EXPECTED_BASE_LICENSE_EVIDENCE = {
    "artifact": "AIBuilder-Expo-v476/assets/termux-bootstrap/termux-bootstrap-aarch64.zip",
    "archiveSha256": "08a447f60c06783f33561583553149cf992ac7d9779071c71b8aaeeb452451b4",
    "packageName": "termux-licenses", "version": "2.1", "architecture": "all",
    "packageStatus": "install ok installed",
    "licenseFilesSha256": {
        "share/LICENSES/Apache-2.0.txt": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
        "share/LICENSES/GPL-2.0.txt": "8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643",
        "share/LICENSES/GPL-3.0.txt": "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
        "share/LICENSES/LGPL-2.1.txt": "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551",
        "share/LICENSES/MPL-2.0.txt": "9bc20a15c61407693f16f5bb482035e60c9ac3e9c6611c6c3b6623a1a4453578",
        "share/LICENSES/Public Domain.txt": "a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499",
    },
    "verification": "Six relevant ZIP license payloads were byte-for-byte compared with pinned termux-licenses source; package status comes from the embedded v476 archive. This is archive evidence, not device observation.",
    "deviceObserved": False,
}
EXPECTED_SOURCE_LICENSE_EVIDENCE = {
    "pkg-config": {
        "sourceUrl": "https://pkgconfig.freedesktop.org/releases/pkg-config-0.29.2.tar.gz",
        "sourceSha256": "6fc69c01688c9458a57eb9a1664c9aba372ccda420a02bf4429fe610e7e7d591",
    },
    "ncurses": {
        "sourceUrl": "https://github.com/ThomasDickey/ncurses-snapshots/archive/5f58399b2de47ed14bdfe3a0cb149293b27893d5.tar.gz",
        "sourceSha256": "28cd102efe6a2610e830cc79cf270da6ff0427b2022900a9a36d2761522f9576",
        "licenseSourcePath": "COPYING",
        "licensePayloadSha256": "708999f95527e1ffa670c6fce288c6c600cb477dd04afcc1171422b3dd4ee226",
        "packageLicensePaths": {
            "ncurses": "share/doc/ncurses/copyright",
            "ncurses-ui-libs": "share/doc/ncurses-ui-libs/COPYING",
        },
    },
    "python": {
        "sourceUrl": "https://www.python.org/ftp/python/3.14.6/Python-3.14.6.tar.xz",
        "sourceSha256": "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63",
        "licensePayloadPath": "share/doc/python/LICENSE",
        "licensePayloadSha256": "b0e25a78cffb43f4d92de8b61ccfa1f1f98ecbc22330b54b5251e7b6ba010231",
        "sourceArchives": [
            {"url": "https://www.python.org/ftp/python/3.14.6/Python-3.14.6.tar.xz", "sha256": "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63"},
            {"url": "https://salsa.debian.org/cpython-team/python3-defaults/-/archive/f358ab52bf2932ad55b1a72a29c9762169e6ac47/python3-defaults-f358ab52bf2932ad55b1a72a29c9762169e6ac47.tar.gz", "sha256": "3b7a76c144d39f5c4a2c7789fd4beb3266980c2e667ad36167e1e7a357c684b0"},
        ],
    },
}
EXPECTED_SHARED_LICENSES = {
    "ca-certificates": {"MPL-2.0"},
    "gdbm": {"GPL-3.0"},
    "glib": {"LGPL-2.1"},
    "libiconv": {"LGPL-2.1", "GPL-3.0"},
    "libsqlite": {"Public Domain"},
    "openssl": {"Apache-2.0"},
    "pkg-config": {"GPL-2.0"},
    "readline": {"GPL-3.0"},
    "resolv-conf": {"Public Domain"},
    "zstd": {"GPL-2.0"},
}
EXPECTED_LOCAL_LICENSE_PATHS = {
    "libandroid-support": {
        "share/doc/libandroid-support/LICENSE.txt",
        "share/doc/libandroid-support/LICENSE.txt.1",
    },
    "liblzma": {
        "share/doc/liblzma/COPYING",
        "share/doc/liblzma/COPYING.GPLv2",
        "share/doc/liblzma/COPYING.GPLv3",
        "share/doc/liblzma/COPYING.LGPLv2.1",
    },
    "ncurses": {"share/doc/ncurses/copyright"},
    "ncurses-ui-libs": {"share/doc/ncurses-ui-libs/COPYING"},
    "python": {"share/doc/python/LICENSE"},
}


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


def validate_elf_needed_providers(all_elf: list[dict[str, Any]]) -> dict[str, Any]:
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
    for item in all_elf:
        for library in item.get("needed", []):
            if library in PLATFORM_LIBS:
                continue
            matches = sonames.get(library, [])
            if not matches:
                require(library in provider_paths, "ELF_NEEDED_LIBRARY_UNPROVEN", item["package"] + ":" + item["path"] + ":" + library)
            else:
                require(len(matches) == 1, "ELF_NEEDED_LIBRARY_PROVIDER_AMBIGUOUS", item["package"] + ":" + item["path"] + ":" + library)
    return {"providers": sorted(PLATFORM_LIBS | set(sonames) | set(provider_paths)), "packageFileProviders": evidence}


def license_roots(name: str, prefix: str) -> list[str]:
    return [prefix + "/share/doc/" + name + "/"]


def is_license_doc(path: str, name: str, prefix: str) -> bool:
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
    expected_closure = {"profile": "pkg-config-candidate", "rootPackages": ["pkg-config"], "buildTargetPackage": "pkg-config",
                        "expectedPackageCount": PACKAGE_COUNT, "expectedDependencyAlternativeCount": DEPENDENCY_ALTERNATIVE_COUNT}
    closure = manifest.get("sourceClosure", {})
    for key, value in expected_closure.items():
        require(closure.get(key) == value, "SOURCE_CLOSURE_NOT_ALLOWLISTED_" + key)
    evidence = expected_base_license_evidence(manifest.get("baseLicenseProviderEvidence"))
    require(manifest.get("sourceLicenseEvidence") == EXPECTED_SOURCE_LICENSE_EVIDENCE, "SOURCE_LICENSE_EVIDENCE_NOT_ALLOWLISTED")
    modifications = manifest.get("buildModifications", {})
    require(modifications.get("patchPath") == "termux-private-package-kit/pkg-config-v0.29.2/ncurses-ui-libs-license.patch" and
            modifications.get("patchSha256") == PATCH_SHA256, "BUILD_PATCH_NOT_ALLOWLISTED")
    root = pathlib.Path(__file__).resolve().parents[2]
    patch = root / modifications["patchPath"]
    require(patch.is_file() and not patch.is_symlink() and sha256_file(patch) == PATCH_SHA256, "BUILD_PATCH_FILE_HASH_MISMATCH")
    runtime = manifest.get("runtimeDependencies", {})
    require(runtime == {"pkgConfigRequires": ["glib"], "pythonRecommendationsExcludedFromInstallSimulation": ["python-ensurepip-wheels", "python-pip"]},
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
        if name == "ncurses-ui-libs":
            require(spec.get("packageType") == "subpackage" and spec.get("parentPackage") == "ncurses" and
                    spec.get("parentDependencyRule") == "true" and spec.get("subpackagePath") == "packages/ncurses/ncurses-ui-libs.subpackage.sh" and
                    spec.get("subpackageSha256") == "a1ed7e1aa01e0f87e5a23f7df0ff8efa11fc7740201191862ac6e56dcc44581e",
                    "NCURSES_SUBPACKAGE_METADATA_NOT_ALLOWLISTED")
        else:
            require(spec.get("packageType") == "recipe" and spec.get("parentPackage") is None and
                    spec.get("parentDependencyRule") is None and spec.get("subpackagePath") is None and spec.get("subpackageSha256") is None,
                    "PACKAGE_RECIPE_METADATA_NOT_ALLOWLISTED", name)
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
    total = count = 0
    pkg_config_executable = False
    pkg_config_elf = False
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
                    if is_license_doc(path, name, prefix):
                        license_paths.add(path)
                        if resolved.startswith(prefix + "/share/LICENSES/"):
                            target_rel = resolved[len(prefix) + 1:]
                            require(target_rel in EXPECTED_BASE_LICENSE_EVIDENCE["licenseFilesSha256"],
                                    "SHARED_LICENSE_PROVIDER_NOT_ALLOWLISTED", name + ":" + target_rel)
                            shared_license_targets.add(target_rel)
                    continue
                require(member.isdir() or member.isreg(), "PAYLOAD_MEMBER_TYPE_REJECTED", name + ":" + path)
                if name == "pkg-config" and path == prefix + "/bin/pkg-config" and member.isreg() and member.mode & 0o111:
                    pkg_config_executable = True
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
                if name == "python" and path == prefix + "/share/doc/python/LICENSE":
                    pkg_spec = EXPECTED_SOURCE_LICENSE_EVIDENCE["python"]
                    require(hashlib.sha256(content).hexdigest() == pkg_spec["licensePayloadSha256"], "PYTHON_PSF_LICENSE_HASH_MISMATCH")
                if name == "pkg-config" and path == prefix + "/bin/pkg-config" and content.startswith(b"\x7fELF"):
                    pkg_config_elf = True
                if content.startswith(b"\x7fELF"):
                    relative = path[len(prefix) + 1:]
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
    if name in {"ncurses", "ncurses-ui-libs"}:
        evidence = EXPECTED_SOURCE_LICENSE_EVIDENCE["ncurses"]
        path = prefix + "/" + evidence["packageLicensePaths"][name]
        require(license_hashes.get(path) == evidence["licensePayloadSha256"],
                "NCURSES_COPYING_LICENSE_HASH_MISMATCH", name + ":" + path)
    if name == "python":
        require(license_hashes.get(prefix + "/share/doc/python/LICENSE") == EXPECTED_SOURCE_LICENSE_EVIDENCE["python"]["licensePayloadSha256"],
                "PYTHON_PSF_LICENSE_MISSING_OR_MISMATCHED")
    if name == "pkg-config":
        require(pkg_config_executable and pkg_config_elf, "PKG_CONFIG_EXECUTABLE_MISSING_OR_NOT_AARCH64_ELF")
    return {"name": name, "version": spec["version"], "architecture": spec["architecture"], "sha256": digest,
            "filename": deb.name, "licenseExpression": spec["licenseExpression"], "licenseEvidencePaths": sorted(license_paths),
            "licenseEvidenceSha256": {path: license_hashes[path] for path in sorted(license_hashes)},
            "sharedLicenseProviderTargets": sorted(shared_license_targets),
            "licenseEvidenceKind": "pinned Termux source recipe output; package-local regular license payload or exact v476 shared-license provider target",
            "payloadEntries": count, "payloadBytes": total, "elf": elf_records,
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
    with tempfile.TemporaryDirectory(prefix="aib-pkg-config-audit-") as td:
        temp = pathlib.Path(td)
        for spec in specs:
            result = audit_one(file_by_name[spec["name"]], spec, prefix, temp)
            all_results.append(result)
            all_elf.extend({**elf, "package": spec["name"]} for elf in result["elf"])
    providers = validate_elf_needed_providers(all_elf)
    return {"schemaVersion": 1, "ok": True,
            "status": "static-audit-passed; installation-and-device-runtime-unverified",
            "applicationId": APP_ID, "prefix": prefix, "prefixProvenance": "ci-model-only; device-observation-not-run",
            "baseLicenseProviderEvidence": manifest["baseLicenseProviderEvidence"],
            "baseLicenseProviderStatus": "v476 embedded bootstrap archive and six relevant license payload hashes verified; actual device state not observed",
            "sourceCommit": SOURCE_COMMIT, "builderImage": BUILDER_IMAGE,
            "sourceClosureProfile": "pkg-config-candidate", "sourceBuildTargetPackage": "pkg-config",
            "restrictedAppArmorProfileSha256": manifest["source"]["restrictedAppArmorProfileSha256"],
            "sourceClosurePackageCount": PACKAGE_COUNT, "sourceClosureDependencyAlternativeCount": DEPENDENCY_ALTERNATIVE_COUNT,
            "candidatePackageCount": len(all_results), "packages": all_results,
            "elfProviders": providers["providers"], "elfPackageFileProviders": providers["packageFileProviders"],
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
        print("PKG_CONFIG_CANDIDATE_STATIC_AUDIT_OK packages={} elf={} app_private_prefix=1 device_install=NOT_RUN".format(
            report["candidatePackageCount"], report["elfCount"]))
        return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print("PKG_CONFIG_CANDIDATE_STATIC_AUDIT_REJECTED:" + (str(exc) if isinstance(exc, AuditError) else "INPUT_INVALID"), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
