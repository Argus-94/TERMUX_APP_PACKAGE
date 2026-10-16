#!/usr/bin/env python3
"""Static, fail-closed audit of the pinned wget runtime package closure."""
from __future__ import annotations

import argparse
import email.parser
import hashlib
import io
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
PINNED_PACKAGE_COUNT = 11
EXPECTED_BUILD_PATCH_SHA256 = "95a294e32a59f5717410a482cd3fc3ad5c35129f004c181ee4a5afb16ee61ba0"
PLATFORM_LIBS = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so", "libz.so", "libgcc.so", "libpthread.so", "libatomic.so"}
PACKAGE_FILE_ELF_PROVIDERS = {"libandroid-support.so": ("libandroid-support", "lib/libandroid-support.so")}
ANDROID_PATH_RE = re.compile(rb"/data/(?:data|user/0)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._+-]+)*")
CONTROL_ALLOWLIST = {"control", "md5sums", "conffiles", "triggers", "shlibs", "symbols", "copyright", "postinst", "postrm", "preinst", "prerm", "config"}
MAX_DEB_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
EXPECTED_LICENSES = {
    "ca-certificates": "MPL-2.0",
    "libandroid-posix-semaphore": "MIT",
    "libandroid-support": "Apache-2.0, MIT",
    "libiconv": "LGPL-2.1, GPL-3.0",
    "libidn2": "LGPL-3.0, GPL-2.0, GPL-3.0",
    "libunistring": "LGPL-3.0, GPL-2.0",
    "libuuid": "GPL-3.0-or-later, GPL-2.0-or-later, LGPL-2.1-or-later, BSD 3-Clause, BSD, ISC",
    "openssl": "Apache-2.0",
    "pcre2": "BSD 3-Clause",
    "wget": "GPL-3.0",
    "zlib": "ZLIB",
}
PINNED_LICENSE_EVIDENCE = {
    "wget": {
        "sourceUrl": "https://mirrors.kernel.org/gnu/wget/wget-1.25.0.tar.lz",
        "sourceSha256": "19225cc756b0a088fc81148dc6a40a0c8f329af7fd8483f1c7b2fe50f4e08a1f",
        "files": {"share/doc/wget/COPYING": "f7dc7522e7e1be9227f3dc8de8b39a4d1d2471968c893af15f00c1a2076a0eec"},
    },
    "libuuid": {
        "sourceUrl": "https://www.kernel.org/pub/linux/utils/util-linux/v2.42/util-linux-2.42.4.tar.xz",
        "sourceSha256": "fbd62a100ab7bb8746ba0661255c3c48185b1e9021507c624da01fbc696330ec",
        "files": {
            "share/doc/util-linux/COPYING.GPL-3.0-or-later": "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
            "share/doc/util-linux/COPYING.GPL-2.0-or-later": "8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643",
            "share/doc/util-linux/COPYING.LGPL-2.1-or-later": "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551",
            "share/doc/util-linux/COPYING.BSD-3-Clause": "9b718a9460fed5952466421235bc79eb49d4e9eacc920d7a9dd6285ab8fd6c6d",
            "share/doc/util-linux/COPYING.BSD-4-Clause-UC": "ba7640f00d93e72e92b94b9d71f25ec53bac2f1682f5c4adcccb0018359f60f8",
            "share/doc/util-linux/COPYING.ISC": "e53348ce276358e9997014071c5294b36a18c4b34f32f00ee57b9acce0aafd63",
        },
    }
}
EXPECTED_PACKAGE_LOCKS = {
    "ca-certificates": {"architecture":"all", "licenseExpression":"MPL-2.0", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/ca-certificates/build.sh", "recipeSha256":"49346cd737c0c8f423f26cb0cb04467f93fb9d69c9c1fb1aff5840a9ea215861", "sourceRevisionExpression":None, "sourceVersionExpression":"1:2026.09.25", "subpackagePath":None, "subpackageSha256":None, "version":"1:2026.09.25"},
    "libandroid-posix-semaphore": {"architecture":"aarch64", "licenseExpression":"MIT", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/libandroid-posix-semaphore/build.sh", "recipeSha256":"ef7431b10b8f6c9e60e0c785e435138f6de39fa2a301a6fe73fabf2948dd6fec", "sourceRevisionExpression":"4", "sourceVersionExpression":"0.1", "subpackagePath":None, "subpackageSha256":None, "version":"0.1-4"},
    "libandroid-support": {"architecture":"aarch64", "licenseExpression":"Apache-2.0, MIT", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/libandroid-support/build.sh", "recipeSha256":"23f10711528bcc66a3a8728d218f43efea8467bfbb7db222796e5f5b89ac0d79", "sourceRevisionExpression":"1", "sourceVersionExpression":"(29", "subpackagePath":None, "subpackageSha256":None, "version":"29-1"},
    "libiconv": {"architecture":"aarch64", "licenseExpression":"LGPL-2.1, GPL-3.0", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/libiconv/build.sh", "recipeSha256":"5542ba656ce53cf6c13659afe25c6fe69e254d2b9e05b0d8105f4f4b3dc9cb15", "sourceRevisionExpression":None, "sourceVersionExpression":"1.19", "subpackagePath":None, "subpackageSha256":None, "version":"1.19"},
    "libidn2": {"architecture":"aarch64", "licenseExpression":"LGPL-3.0, GPL-2.0, GPL-3.0", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/libidn2/build.sh", "recipeSha256":"13dcbe4d713bc6beb01c9e666527594db097f271d368dfd97d46bca196412a9f", "sourceRevisionExpression":"1", "sourceVersionExpression":"2.3.8", "subpackagePath":None, "subpackageSha256":None, "version":"2.3.8-1"},
    "libunistring": {"architecture":"aarch64", "licenseExpression":"LGPL-3.0, GPL-2.0", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/libunistring/build.sh", "recipeSha256":"ad3070ea9961bbe5cc0a8fbab9f9207e7620c9596f208b5f5b0f3d44266ef392", "sourceRevisionExpression":None, "sourceVersionExpression":"1.4.2", "subpackagePath":None, "subpackageSha256":None, "version":"1.4.2"},
    "libuuid": {"architecture":"aarch64", "licenseExpression":"GPL-3.0-or-later, GPL-2.0-or-later, LGPL-2.1-or-later, BSD 3-Clause, BSD, ISC", "packageType":"subpackage", "parentDependencyRule":"none", "parentPackage":"util-linux", "recipePath":"packages/util-linux/build.sh", "recipeSha256":"8886bcd721858e31c479f9c8e11592d5a7c43b1db19cbca2fa5f51a36493ef81", "sourceRevisionExpression":None, "sourceVersionExpression":"2.42.4", "subpackagePath":"packages/util-linux/libuuid.subpackage.sh", "subpackageSha256":"823ea8ce6656cbf97ec5245b46648dd70671be52e10be2de8b7ab4ea8a254c96", "version":"2.42.4"},
    "openssl": {"architecture":"aarch64", "licenseExpression":"Apache-2.0", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/openssl/build.sh", "recipeSha256":"4520f242c196cf19cc68b1502484fbf27606da07c04752f98e91ceba667db224", "sourceRevisionExpression":None, "sourceVersionExpression":"1:3.6.5", "subpackagePath":None, "subpackageSha256":None, "version":"1:3.6.5"},
    "pcre2": {"architecture":"aarch64", "licenseExpression":"BSD 3-Clause", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/pcre2/build.sh", "recipeSha256":"3d4f6e3cd27218fb539e4d812255c2a8787b43319bb45a6ad76bb3abf70fe293", "sourceRevisionExpression":None, "sourceVersionExpression":"10.49", "subpackagePath":None, "subpackageSha256":None, "version":"10.49"},
    "wget": {"architecture":"aarch64", "licenseExpression":"GPL-3.0", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/wget/build.sh", "recipeSha256":"5794b1cfd67da93a67aa6a5d74548238cef5c0aaf2d26bd97d9aa312cd45fd6a", "sourceRevisionExpression":"1", "sourceVersionExpression":"1.25.0", "sourceUrl":"https://mirrors.kernel.org/gnu/wget/wget-1.25.0.tar.lz", "sourceSha256":"19225cc756b0a088fc81148dc6a40a0c8f329af7fd8483f1c7b2fe50f4e08a1f", "licenseEvidenceSha256":{"share/doc/wget/COPYING":"f7dc7522e7e1be9227f3dc8de8b39a4d1d2471968c893af15f00c1a2076a0eec"}, "subpackagePath":None, "subpackageSha256":None, "version":"1.25.0-1"},
    "zlib": {"architecture":"aarch64", "licenseExpression":"ZLIB", "packageType":"recipe", "parentDependencyRule":None, "parentPackage":None, "recipePath":"packages/zlib/build.sh", "recipeSha256":"9edf6e044f5ca08c91bde6e6b0d99c2569ba0f6bbbc57700bb9a0c5b3b4c27ec", "sourceRevisionExpression":None, "sourceVersionExpression":"1.3.2", "subpackagePath":None, "subpackageSha256":None, "version":"1.3.2"},
}
BASE_LICENSE_PROVIDER_EVIDENCE = {
    "artifact": "AIBuilder-Expo-v476/assets/termux-bootstrap/termux-bootstrap-aarch64.zip",
    "archiveSha256": "08a447f60c06783f33561583553149cf992ac7d9779071c71b8aaeeb452451b4",
    "packageName": "termux-licenses", "version": "2.1", "architecture": "all",
    "packageStatus": "install ok installed",
    "licenseFilesSha256": {
        "share/LICENSES/GPL-2.0.txt": "8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643",
        "share/LICENSES/GPL-3.0.txt": "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
        "share/LICENSES/LGPL-2.1.txt": "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551",
        "share/LICENSES/LGPL-3.0.txt": "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118",
        "share/LICENSES/Apache-2.0.txt": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
        "share/LICENSES/MPL-2.0.txt": "9bc20a15c61407693f16f5bb482035e60c9ac3e9c6611c6c3b6623a1a4453578",
        "share/LICENSES/ISC.txt": "45fefea443e839d010df68c932e5c3b1e31cc9b82f8b4f4ea801c6de0cbd58ca",
    },
    "verification": "The 7 listed ZIP payloads were byte-for-byte compared with the same-named files under packages/termux-licenses/LICENSES at the pinned Termux source commit.",
    "deviceObserved": False,
}

class AuditError(Exception):
    pass


def require(ok: bool, code: str, detail: str = "") -> None:
    if not ok:
        raise AuditError(code + (":" + detail if detail else ""))


def expected_source_license_files(spec: dict[str, Any]) -> dict[str, str]:
    name = str(spec.get("name", ""))
    pinned = PINNED_LICENSE_EVIDENCE.get(name)
    declared = spec.get("licenseEvidenceSha256", {})
    require(isinstance(declared, dict), "LICENSE_EVIDENCE_MANIFEST_INVALID", name)
    if pinned is None:
        require(not declared, "UNEXPECTED_LICENSE_EVIDENCE_MANIFEST", name)
        return {}
    require(spec.get("sourceUrl") == pinned["sourceUrl"] and spec.get("sourceSha256") == pinned["sourceSha256"],
            "LICENSE_SOURCE_ARCHIVE_NOT_ALLOWLISTED", name)
    require(declared == pinned["files"], "LICENSE_EVIDENCE_MANIFEST_NOT_ALLOWLISTED", name)
    return pinned["files"]


def validate_base_license_provider_evidence(value: Any) -> dict[str, Any]:
    require(value == BASE_LICENSE_PROVIDER_EVIDENCE, "BASE_LICENSE_PROVIDER_EVIDENCE_NOT_ALLOWLISTED")
    return BASE_LICENSE_PROVIDER_EVIDENCE


def verify_pinned_license_payload(name: str, relative_path: str, content: bytes,
                                  pinned_files: dict[str, str]) -> str | None:
    expected = pinned_files.get(relative_path)
    if expected is None:
        return None
    actual = hashlib.sha256(content).hexdigest()
    require(actual == expected, "LICENSE_EVIDENCE_SHA256_MISMATCH", name + ":" + relative_path)
    return actual


def normalize_prefix(value: str) -> str:
    prefix = value.rstrip("/")
    require(prefix in {"/data/user/0/com.karat.aibuilder/files/usr", "/data/data/com.karat.aibuilder/files/usr"}, "PREFIX_NOT_CANONICAL")
    return prefix


def is_wget_executable(name: str, path: str, regular: bool, mode: int, prefix: str) -> bool:
    return name == "wget" and path == prefix + "/bin/wget" and regular and bool(mode & 0o111)


def is_wget_elf(name: str, path: str, content: bytes, prefix: str) -> bool:
    return name == "wget" and path == prefix + "/bin/wget" and content.startswith(b"\x7fELF")


def is_package_license_path(path: str, prefix: str, package: str) -> bool:
    roots = [prefix + "/share/doc/" + package + "/"]
    if package == "libuuid":
        roots.append(prefix + "/share/doc/util-linux/")
    root = next((candidate for candidate in roots if path.startswith(candidate)), None)
    if root is None:
        return False
    leaf = path[len(root):]
    return "/" not in leaf and re.match(r"(?i)^(copyright|copying|license|licence)(?:[._-].*)?$", leaf) is not None


def validate_package_specs(specs: Any) -> None:
    names_expected = sorted(EXPECTED_PACKAGE_LOCKS)
    require(isinstance(specs, list) and len(specs) == PINNED_PACKAGE_COUNT, "PACKAGE_SET_COUNT_NOT_ALLOWLISTED")
    names = [item.get("name") if isinstance(item, dict) else None for item in specs]
    require(names == names_expected and len(set(names)) == PINNED_PACKAGE_COUNT, "PACKAGE_NAMES_NOT_EXACT")
    for spec in specs:
        lock = EXPECTED_PACKAGE_LOCKS[spec["name"]]
        for field, expected in lock.items():
            require(spec.get(field) == expected, "PACKAGE_SPEC_NOT_ALLOWLISTED_" + spec["name"] + "_" + field)


def normalize_member(raw: str) -> str:
    value = raw
    while value.startswith("./"):
        value = value[2:]
    require(value not in {"", "."} and not value.startswith("/") and "\\" not in value and "\x00" not in value, "PAYLOAD_PATH_INVALID", raw)
    parts = value.split("/")
    require(all(x not in {"", ".", ".."} for x in parts), "PAYLOAD_PATH_TRAVERSAL", raw)
    return "/" + "/".join(parts)


def ensure_payload_path(path: str, prefix: str, is_dir: bool) -> None:
    if is_dir:
        ancestor = prefix.startswith(path.rstrip("/") + "/")
        descendant = path == prefix or path.startswith(prefix + "/")
        require(ancestor or descendant, "DIRECTORY_OUTSIDE_PRIVATE_PREFIX", path)
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


def run(command: list[str], code: str, timeout: int = 90) -> subprocess.CompletedProcess[bytes]:
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
    total = 0
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
                total += len(data)
                scan_paths(data, prefix, "control/" + raw)
        proc.stdout.close()
        stderr = proc.stderr.read(8192) if proc.stderr else b""
        require(proc.wait(timeout=90) == 0, "CONTROL_ARCHIVE_INVALID", stderr.decode("utf-8", "replace")[:400])
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
    for name in ("preinst", "postinst", "prerm", "postrm", "config"):
        if name in files:
            proc = subprocess.run(["bash", "-n"], input=files[name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            require(proc.returncode == 0, "MAINTAINER_SCRIPT_SYNTAX_INVALID", name)
            forbidden = re.search(rb"(?im)^\s*(?:sudo|su|mount|umount)\b|\brm\s+-rf\s+/(?:\s|$)", files[name])
            require(forbidden is None, "MAINTAINER_SCRIPT_DANGEROUS_COMMAND", name)
    return files, {key: str(fields.get(key, "")) for key in ("Package", "Version", "Architecture", "Depends", "Pre-Depends", "Recommends", "Suggests", "Provides", "Conflicts", "Breaks", "Replaces")}


def inspect_elf(path: pathlib.Path, rel: str, prefix: str) -> dict[str, Any]:
    header = run(["readelf", "-hW", str(path)], "READELF_HEADER_FAILED")
    text = header.stdout.decode("utf-8", "replace")
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
    providers: set[str] = set(PLATFORM_LIBS)
    for item in all_elf:
        if item.get("soname"):
            providers.add(item["soname"])
    package_file_providers = []
    for library, (package, path) in PACKAGE_FILE_ELF_PROVIDERS.items():
        matches = [item for item in all_elf if item.get("package") == package and item.get("path") == path]
        require(len(matches) == 1, "ELF_PACKAGE_FILE_PROVIDER_NOT_EXACTLY_ONCE", library)
        item = matches[0]
        require(item.get("soname") in {None, library}, "ELF_PACKAGE_FILE_PROVIDER_SONAME_MISMATCH", library + ":" + str(item.get("soname")))
        providers.add(library)
        package_file_providers.append({"library": library, "package": package, "path": path,
                                       "soname": item.get("soname"), "basis": "exact packaged AArch64 ELF path; package and recipe are pinned in the candidate closure"})
    for item in all_elf:
        for library in item.get("needed", []):
            require(library in providers, "ELF_NEEDED_LIBRARY_UNPROVEN", item["package"] + ":" + item["path"] + ":" + library)
    return {"providers": sorted(providers), "packageFileProviders": package_file_providers}


def audit_one(deb: pathlib.Path, spec: dict[str, Any], prefix: str, temp: pathlib.Path) -> dict[str, Any]:
    require(deb.is_file() and not deb.is_symlink() and 0 < deb.stat().st_size <= MAX_DEB_BYTES, "DEB_INVALID", str(deb.name))
    sha = hashlib.sha256(deb.read_bytes()).hexdigest()
    controls, fields = parse_control_archive(deb, prefix)
    name = spec["name"]
    require(fields["Package"] == name and fields["Version"] == spec["version"] and fields["Architecture"] == spec["architecture"], "DEB_IDENTITY_NOT_ALLOWLISTED", name)
    require(spec["licenseExpression"] == EXPECTED_LICENSES[name], "LICENSE_EXPRESSION_NOT_ALLOWLISTED", name)
    pinned_license_files = expected_source_license_files(spec)
    proc = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(deb)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    paths: set[str] = set()
    license_paths: set[str] = set()
    license_hashes: dict[str, str] = {}
    wget_executable_present = False
    wget_elf_present = False
    elf_records: list[dict[str, Any]] = []
    total = 0
    count = 0
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
                require(member.size <= MAX_MEMBER_BYTES and total <= MAX_TOTAL_BYTES, "PAYLOAD_SIZE_LIMIT", name)
                if member.issym() or member.islnk():
                    resolve_link(path, member.linkname, member.islnk(), prefix)
                    relative_path = path[len(prefix) + 1:]
                    require(relative_path not in pinned_license_files, "LICENSE_EVIDENCE_NOT_REGULAR", name + ":" + relative_path)
                    if is_package_license_path(path, prefix, name):
                        license_paths.add(path)
                    continue
                require(member.isdir() or member.isreg(), "PAYLOAD_MEMBER_TYPE_REJECTED", name + ":" + path)
                if name == "wget" and is_wget_executable(name, path, member.isreg(), member.mode, prefix):
                    wget_executable_present = True
                if member.isdir():
                    continue
                stream = archive.extractfile(member)
                require(stream is not None, "PAYLOAD_MEMBER_UNREADABLE", name + ":" + path)
                content = stream.read(member.size + 1)
                require(len(content) == member.size, "PAYLOAD_MEMBER_SIZE_MISMATCH", name + ":" + path)
                scan_paths(content, prefix, name + ":" + path)
                relative_path = path[len(prefix) + 1:]
                if is_wget_elf(name, path, content, prefix):
                    wget_elf_present = True
                if is_package_license_path(path, prefix, name):
                    license_paths.add(path)
                    license_hashes[path] = hashlib.sha256(content).hexdigest()
                pinned_digest = verify_pinned_license_payload(name, relative_path, content, pinned_license_files)
                if pinned_digest is not None:
                    license_paths.add(path)
                    license_hashes[path] = pinned_digest
                if content.startswith(b"\x7fELF"):
                    rel = path[len(prefix) + 1:]
                    target = temp / (name + "-" + str(len(elf_records)))
                    target.write_bytes(content)
                    elf_records.append(inspect_elf(target, rel, prefix))
        proc.stdout.close()
        stderr = proc.stderr.read(8192) if proc.stderr else b""
        require(proc.wait(timeout=120) == 0, "PAYLOAD_ARCHIVE_INVALID", stderr.decode("utf-8", "replace")[:400])
    except Exception:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        raise
    require(count > 0, "EMPTY_PACKAGE_PAYLOAD", name)
    if pinned_license_files:
        expected_paths = {prefix + "/" + rel for rel in pinned_license_files}
        require(expected_paths <= license_paths, "LICENSE_EVIDENCE_MISSING", name)
    else:
        require(bool(license_paths), "LICENSE_EVIDENCE_MISSING", name)
    if name == "wget":
        require(wget_executable_present, "WGET_EXECUTABLE_MISSING_OR_NOT_EXECUTABLE")
        require(wget_elf_present, "WGET_EXECUTABLE_NOT_ELF")
    return {"name": name, "version": spec["version"], "architecture": spec["architecture"], "sha256": sha,
            "filename": deb.name, "licenseExpression": spec["licenseExpression"], "licenseEvidencePaths": sorted(license_paths),
            "licenseEvidenceSha256": {path: license_hashes[path] for path in sorted(license_hashes)},
            "licenseEvidenceKind": "pinned Termux source installer output; copyright file, hash-pinned TERMUX_PKG_LICENSE_FILE copy, or prefix-contained shared-license symlink",
            "payloadEntries": count, "payloadBytes": total, "elf": elf_records,
            "depends": fields.get("Depends", ""), "preDepends": fields.get("Pre-Depends", ""),
            "recommends": fields.get("Recommends", ""), "maintainerScripts": sorted(set(controls) & {"preinst", "postinst", "prerm", "postrm", "config"})}


def validate_subpackage_metadata(specs: list[dict[str, Any]]) -> None:
    subpackages = [item for item in specs if item.get("packageType") == "subpackage"]
    require(len(subpackages) == 1, "SUBPACKAGE_SET_NOT_ALLOWLISTED")
    item = subpackages[0]
    require(item.get("name") == "libuuid" and item.get("parentPackage") == "util-linux" and
            item.get("parentDependencyRule") == "none" and
            item.get("subpackagePath") == "packages/util-linux/libuuid.subpackage.sh",
            "SUBPACKAGE_METADATA_NOT_ALLOWLISTED")
    require(item.get("parentPackage") not in {x.get("name") for x in specs}, "UNEXPECTED_SUBPACKAGE_PARENT_IN_CANDIDATE")


def audit(args: argparse.Namespace) -> dict[str, Any]:
    manifest = json.loads(args.package_set.read_text(encoding="utf-8"))
    require(manifest.get("schemaVersion") == 1 and manifest.get("channel") == "candidate-only", "PACKAGE_SET_NOT_CANDIDATE_ONLY")
    base_license_evidence = validate_base_license_provider_evidence(manifest.get("baseLicenseProviderEvidence"))
    source = manifest.get("source", {})
    require(source.get("commit") == SOURCE_COMMIT and source.get("builderImage") == BUILDER_IMAGE, "SOURCE_OR_BUILDER_NOT_ALLOWLISTED")
    require(source.get("restrictedAppArmorProfileSha256") == "ec7680c466c03c9354b890e6860f9fb3e1b5512d380c9d05e426cb47548abbe8", "APPARMOR_PROFILE_NOT_PINNED")
    target = manifest.get("target", {})
    require(target.get("applicationId") == APP_ID and target.get("architecture") == "aarch64", "TARGET_NOT_ALLOWLISTED")
    prefix = normalize_prefix(args.prefix)
    require(target.get("modeledPrefix") == prefix and target.get("modeledDataDir") == prefix.removesuffix("/files/usr"), "MODELED_PREFIX_MISMATCH")
    gate = manifest.get("releaseGate", {})
    require(gate.get("publicationAllowed") is False and gate.get("deviceInstall") == "NOT RUN" and gate.get("rollback") == "NOT RUN" and gate.get("deviceEvidenceSha256") is None, "RELEASE_GATE_NOT_BLOCKED")
    closure = manifest.get("sourceClosure", {})
    specs = manifest.get("packages")
    require(closure.get("profile") == "wget-candidate" and closure.get("rootPackages") == ["wget"] and closure.get("buildTargetPackage") == "wget" and closure.get("expectedPackageCount") == PINNED_PACKAGE_COUNT and closure.get("expectedDependencyAlternativeCount") == 15, "SOURCE_CLOSURE_NOT_ALLOWLISTED")
    require(isinstance(specs, list) and len(specs) == PINNED_PACKAGE_COUNT, "PACKAGE_SET_COUNT_NOT_ALLOWLISTED")
    require(all(isinstance(x, dict) for x in specs), "PACKAGE_SPEC_INVALID")
    names = [x.get("name") for x in specs]
    validate_package_specs(specs)
    require(len(set(names)) == PINNED_PACKAGE_COUNT and set(names) == set(EXPECTED_LICENSES) and set(names) == set(EXPECTED_PACKAGE_LOCKS), "PACKAGE_NAMES_NOT_EXACT")
    require([x["name"] for x in specs] == sorted(names), "PACKAGE_SET_NOT_SORTED")
    validate_subpackage_metadata(specs)
    runtime = manifest.get("runtimeDependencies", {})
    expected_runtime = {
        "wgetRequires": ["libandroid-support", "libiconv", "libidn2", "libuuid", "openssl", "pcre2", "zlib"],
        "libidn2Requires": ["libandroid-support", "libiconv", "libunistring"],
        "libunistringRequires": ["libandroid-support", "libiconv"],
        "libuuidRequires": ["libandroid-posix-semaphore"],
        "opensslRequires": ["ca-certificates", "zlib"],
        "recommendationsExcludedFromInstallSimulation": [],
    }
    require(runtime == expected_runtime, "RUNTIME_DEPENDENCY_METADATA_NOT_ALLOWLISTED")
    expected_groups = {
        "ca-certificates": [], "libandroid-posix-semaphore": [], "libandroid-support": [], "libiconv": [],
        "libidn2": [["libandroid-support"], ["libiconv"], ["libunistring"]],
        "libunistring": [["libandroid-support"], ["libiconv"]],
        "libuuid": [["libandroid-posix-semaphore"]],
        "openssl": [["ca-certificates"], ["zlib"]], "pcre2": [],
        "wget": [["libandroid-support"], ["libiconv"], ["libidn2"], ["libuuid"], ["openssl"], ["pcre2"], ["zlib"]],
        "zlib": [],
    }
    for item in specs:
        groups = item.get("dependencyGroups")
        require(isinstance(groups, list), "DEPENDENCY_GROUPS_INVALID_" + item["name"])
        names_by_group = []
        for group in groups:
            require(isinstance(group, list) and group, "DEPENDENCY_GROUP_INVALID_" + item["name"])
            names_by_group.append([relation.get("name") for relation in group if isinstance(relation, dict)])
        require(names_by_group == expected_groups[item["name"]], "DEPENDENCY_GROUPS_NOT_ALLOWLISTED_" + item["name"])
        require(item.get("recommendationGroupsNotIncludedInRequiredClosure") == [], "RECOMMENDATIONS_NOT_ALLOWLISTED_" + item["name"])
    require(sum(len(group) for item in specs for group in item["dependencyGroups"]) == 15, "DEPENDENCY_ALTERNATIVE_COUNT_NOT_ALLOWLISTED")
    modifications = manifest.get("buildModifications", {})
    require(modifications.get("patchPath") == "termux-private-package-kit/wget-v1.25.0/wget-license-file.patch" and modifications.get("patchSha256") == EXPECTED_BUILD_PATCH_SHA256, "BUILD_PATCH_NOT_ALLOWLISTED")
    require(modifications.get("sourceArchiveSha256") == "19225cc756b0a088fc81148dc6a40a0c8f329af7fd8483f1c7b2fe50f4e08a1f" and modifications.get("licensePayloadPath") == "share/doc/wget/COPYING" and modifications.get("licensePayloadSha256") == "f7dc7522e7e1be9227f3dc8de8b39a4d1d2471968c893af15f00c1a2076a0eec" and modifications.get("libuuidLicenseDocsPath") == "share/doc/util-linux", "WGET_LICENSE_EVIDENCE_NOT_ALLOWLISTED")
    require(all(isinstance(x.get("recipeSha256"), str) and re.fullmatch(r"[0-9a-f]{64}", x["recipeSha256"]) for x in specs), "RECIPE_HASH_MISSING")
    files = sorted(args.packages_dir.glob("*.deb"))
    require(len(files) == PINNED_PACKAGE_COUNT, "DEB_COUNT_NOT_EXACT")
    file_by_name: dict[str, pathlib.Path] = {}
    for file in files:
        control = run(["dpkg-deb", "-f", str(file), "Package"], "DPKG_PACKAGE_FIELD_READ_FAILED").stdout.decode().strip()
        require(control in names and control not in file_by_name, "DEB_NAME_NOT_ALLOWLISTED_OR_DUPLICATE", control)
        file_by_name[control] = file
    require(set(file_by_name) == set(names), "DEB_NAME_SET_MISMATCH")
    all_results: list[dict[str, Any]] = []
    all_elf: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="aib-wget-audit-") as td:
        temp = pathlib.Path(td)
        for spec in specs:
            result = audit_one(file_by_name[spec["name"]], spec, prefix, temp)
            all_results.append(result)
            for elf in result["elf"]:
                all_elf.append({**elf, "package": spec["name"]})
    provider_evidence = validate_elf_needed_providers(all_elf)
    return {"schemaVersion": 1, "ok": True, "status": "static-audit-passed; installation-and-device-runtime-unverified",
            "applicationId": APP_ID, "prefix": prefix, "prefixProvenance": "ci-model-only; device-observation-not-run",
            "baseLicenseProviderEvidence": base_license_evidence,
            "baseLicenseProviderStatus": "v476 embedded bootstrap archive and license payload hashes verified; actual device state not observed",
            "sourceCommit": SOURCE_COMMIT, "builderImage": BUILDER_IMAGE, "sourceClosureProfile": "wget-candidate", "sourceBuildTargetPackage": "wget",
            "restrictedAppArmorProfileSha256": source["restrictedAppArmorProfileSha256"],
            "sourceClosurePackageCount": PINNED_PACKAGE_COUNT, "sourceClosureDependencyAlternativeCount": 15,
            "candidatePackageCount": len(all_results), "packages": all_results,
            "elfProviders": provider_evidence["providers"], "elfPackageFileProviders": provider_evidence["packageFileProviders"],
            "elfCount": len(all_elf), "deviceInstall": "NOT RUN", "rollback": "NOT RUN"}

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-set", type=pathlib.Path, required=True)
    parser.add_argument("--packages-dir", type=pathlib.Path, required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        report = audit(args)
        args.report.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        print("WGET_CANDIDATE_STATIC_AUDIT_OK packages={} elf={} app_private_prefix=1 device_install=NOT_RUN".format(report["candidatePackageCount"], report["elfCount"]))
        return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print("WGET_CANDIDATE_STATIC_AUDIT_REJECTED:" + (str(exc) if isinstance(exc, AuditError) else "INPUT_INVALID"), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
