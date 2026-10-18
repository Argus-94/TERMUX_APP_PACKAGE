#!/usr/bin/env python3
"""Fail-closed static audit of pinned CMake/Ninja candidate closure."""
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
DEPENDENCY_ALTERNATIVE_COUNT = 34
PACKAGE_SET_SHA256 = "1b4d3c401609ef7ff291d8c926cba625e89f77522056acdc49252a64af953fe5"
SOURCE_CLOSURE_SHA256 = "9423ddd7b885395cea329ec4a8580de17589eb9a0106e58fd54f0ea5a28d22ff"
PREFIXES = {"/data/user/0/com.karat.aibuilder/files/usr", "/data/data/com.karat.aibuilder/files/usr"}
PLATFORM_LIBS = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so", "libz.so"}
PACKAGE_FILE_ELF_PROVIDERS = {"libandroid-glob.so": ("libandroid-glob", "lib/libandroid-glob.so"), "libandroid-spawn.so": ("libandroid-spawn", "lib/libandroid-spawn.so")}
PACKAGE_FILE_ELF_SYMLINK_PROVIDERS = {}
EXPECTED_DUPLICATE_ELF_ALIASES = {}
EXPECTED_BUILD_MODIFICATIONS = {'recipePatchApplied': True, 'propertiesPatchOnly': False, 'patchPath': 'termux-private-package-kit/cmake-ninja/libcurl-disable-optional-zstd.patch', 'patchSha256': '69ddb473018aa7bc6500350d8dbbda309393c62a3956d2ddad3d8f4f4d07c788', 'patchedRecipePaths': ['packages/libcurl/build.sh'], 'sourceRecipeSha256': '0051cc33b3d3f0b69e74a00c67ba668f295b6eb3574e548154653d7e69f12025', 'effectiveRecipeSha256': 'ba13efc16ac98cec77ebd9c0718c65ea69cef87c96e3cb0c27864593f8ede348', 'dependencyContractUnchanged': True, 'purpose': 'Disable curl auto-detected optional zstd compression; first hosted ELF audit proved an undeclared libzstd.so.1 dependency.'}
ANDROID_PATH_RE = re.compile(rb"/data/(?:data|user/0)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._+-]+)*")
LICENSE_NAME_RE = re.compile(r"(?i)^(copyright|copying|license|licence)(?:[._-].*)?$")
CONTROL_ALLOWLIST = {"control", "md5sums", "conffiles", "triggers", "shlibs", "symbols", "copyright", "postinst", "postrm", "preinst", "prerm", "config"}
MAX_DEB_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
EXPECTED_PACKAGES = {'ca-certificates': ('1:2026.09.25', 'all', 'MPL-2.0'), 'cmake': ('4.4.4', 'aarch64', 'BSD 3-Clause'), 'jsoncpp': ('1.9.8', 'aarch64', 'MIT'), 'libandroid-glob': ('0.6-3', 'aarch64', 'BSD 3-Clause'), 'libandroid-spawn': ('0.3', 'aarch64', 'BSD 2-Clause'), 'libarchive': ('3.8.9', 'aarch64', 'BSD 2-Clause'), 'libbz2': ('1.0.8-8', 'aarch64', 'BSD'), 'libc++': ('30', 'aarch64', 'NCSA'), 'libcurl': ('8.23.0', 'aarch64', 'MIT'), 'libexpat': ('2.9.0', 'aarch64', 'MIT'), 'libiconv': ('1.19', 'aarch64', 'LGPL-2.1, GPL-3.0'), 'liblzma': ('5.8.4', 'aarch64', 'LGPL-2.1, GPL-2.0, GPL-3.0'), 'libnghttp2': ('1.70.0', 'aarch64', 'MIT'), 'libnghttp3': ('1.18.0', 'aarch64', 'MIT'), 'libngtcp2': ('1.25.0', 'aarch64', 'MIT'), 'libssh2': ('1.11.1-2', 'aarch64', 'BSD 3-Clause'), 'libuv': ('1.53.0', 'aarch64', 'MIT, BSD 2-Clause, ISC, BSD 3-Clause'), 'libxml2': ('2.15.4-1', 'aarch64', 'MIT'), 'ninja': ('1.13.2', 'aarch64', 'Apache-2.0'), 'openssl': ('1:3.6.5', 'aarch64', 'Apache-2.0'), 'rhash': ('1.4.6-1', 'aarch64', 'MIT'), 'zlib': ('1.3.2', 'aarch64', 'ZLIB')}


EXPECTED_BASE_LICENSE_EVIDENCE = {'artifact': 'AIBuilder-Expo-v476/assets/termux-bootstrap/termux-bootstrap-aarch64.zip', 'archiveSha256': '08a447f60c06783f33561583553149cf992ac7d9779071c71b8aaeeb452451b4', 'packageName': 'termux-licenses', 'version': '2.1', 'architecture': 'all', 'packageStatus': 'install ok installed', 'licenseFilesSha256': {'share/LICENSES/Apache-2.0.txt': 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', 'share/LICENSES/GPL-2.0.txt': '8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643', 'share/LICENSES/GPL-3.0.txt': '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986', 'share/LICENSES/LGPL-2.1.txt': 'dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551', 'share/LICENSES/MPL-2.0.txt': '9bc20a15c61407693f16f5bb482035e60c9ac3e9c6611c6c3b6623a1a4453578', 'share/LICENSES/Public Domain.txt': 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499', 'share/LICENSES/NCSA.txt': 'aecb9504bcc76b4ff5e8ff1266344bb607b6bed2bfc3dd8b35233d941401d01e', 'share/LICENSES/LGPL-2.0.txt': 'b7993225104d90ddd8024fd838faf300bea5e83d91203eab98e29512acebd69c'}, 'verification': 'Eight relevant ZIP license payloads were byte-for-byte compared with pinned termux-licenses source; package status comes from the embedded v476 archive. This is archive evidence, not device observation.', 'deviceObserved': False}
EXPECTED_SOURCE_LICENSE_EVIDENCE = {'cmake': {'sourceArchiveSha256': 'bd24c30d80a7744ae84b845ff080cc8453b06c622ef01066564108e9cefc44cf', 'licenseFiles': {'LICENSE.rst': '4382e7c1879ac90e3f101a395d23846fa4dbcaa1eed7265b43681e348754825d'}, 'packagePaths': {'LICENSE.rst': 'share/doc/cmake/copyright'}}, 'ninja': {'sourceArchiveSha256': '974d6b2f4eeefa25625d34da3cb36bdcebe7fbce40f4c16ac0835fd1c0cbae17', 'licenseFiles': {'COPYING': 'eb7e9ab9690124c5c9f42bdc81383d886a3dede26345b6ed15bbad7caf81f7ea'}, 'sharedLicenseTargets': ['share/LICENSES/Apache-2.0.txt']}}
EXPECTED_SHARED_LICENSES = {"libc++": {"NCSA"}, "ca-certificates": {"MPL-2.0"}, "openssl": {"Apache-2.0"}, "libiconv": {"LGPL-2.1", "GPL-3.0"}, "ninja": {"Apache-2.0"}}
EXPECTED_LOCAL_LICENSE_PATHS = {"cmake": {"share/doc/cmake/copyright"}}


class AuditError(Exception):
    pass


def req(ok: bool, code: str) -> None:
    if not ok: raise AuditError(code)

def require(ok: bool, code: str, detail: str = "") :
    if not ok:
        raise AuditError(code + (":" + detail if detail else ""))


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


MANDATORY = {"cmake": ["bin/cmake", "bin/ctest", "bin/cpack"], "ninja": ["bin/ninja"]}
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
    alias_evidence = []
    for library, providers in sonames.items():
        if len(providers) == 1:
            continue
        policy = EXPECTED_DUPLICATE_ELF_ALIASES.get(library)
        require(policy is not None, "ELF_SONAME_PROVIDER_AMBIGUOUS", library)
        require(len(providers) == len(policy["paths"]) and
                {x.get("path") for x in providers} == set(policy["paths"]) and
                all(x.get("package") == policy["package"] for x in providers),
                "ELF_ALIAS_PACKAGE_OR_PATH_SET_MISMATCH", library)
        digests = {x.get("sha256") for x in providers}
        require(len(digests) == 1 and all(isinstance(x, str) and re.fullmatch(r"[0-9a-f]{64}", x) for x in digests),
                "ELF_ALIAS_CONTENT_HASH_MISMATCH_OR_MISSING", library)
        for field in ("soname", "needed", "interpreter", "rpaths"):
            require(all(x.get(field) == providers[0].get(field) for x in providers),
                    "ELF_ALIAS_METADATA_MISMATCH", library + ":" + field)
        alias_evidence.append({"library": library, "package": policy["package"], "paths": policy["paths"],
                               "sha256": next(iter(digests)), "sourceEvidence": policy["sourceEvidence"]})
        sonames[library] = [next(x for x in providers if x["path"] == policy["paths"][0])]
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
            "packageFileProviders": evidence, "packageFileSymlinkProviders": symlink_evidence, "duplicateAliases": alias_evidence}


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
    manifest = json.loads(manifest_bytes.decode("utf-8", "strict")); closure=json.loads(closure_bytes.decode("utf-8","strict"))
    require(manifest.get("schemaVersion")==1 and manifest.get("channel")=="candidate-only", "PACKAGE_SET_NOT_CANDIDATE_ONLY")
    source=manifest.get("source",{}); require(source.get("commit")==SOURCE_COMMIT and source.get("builderImage")==BUILDER_IMAGE, "SOURCE_OR_BUILDER_NOT_ALLOWLISTED")
    require(source.get("restrictedAppArmorProfileSha256")=="ec7680c466c03c9354b890e6860f9fb3e1b5512d380c9d05e426cb47548abbe8", "APPARMOR_PROFILE_NOT_PINNED")
    prefix=normalize_prefix(args.prefix); target=manifest.get("target",{})
    require(target=={"applicationId":APP_ID,"architecture":"aarch64","modeledPrefix":prefix,"modeledDataDir":prefix.removesuffix("/files/usr")}, "MODELED_PREFIX_MISMATCH")
    require(manifest.get("releaseGate")=={"publicationAllowed":False,"deviceInstall":"NOT RUN","rollback":"NOT RUN","deviceEvidenceSha256":None}, "RELEASE_GATE_NOT_BLOCKED")
    wanted={"profile":"cmake-ninja-candidate","rootPackages":["cmake","ninja"],"buildTargetPackages":["cmake","ninja"],"expectedPackageCount":22,"expectedDependencyAlternativeCount":34}
    require(manifest.get("sourceClosure")==wanted, "SOURCE_CLOSURE_NOT_ALLOWLISTED")
    require(closure.get("profile")==wanted['profile'] and closure.get("sourceCommit")==SOURCE_COMMIT and closure.get("rootPackages")==wanted['rootPackages'] and closure.get("packageCount")==22 and closure.get("dependencyAlternativeCount")==34, "SOURCE_CLOSURE_NOT_ALLOWLISTED")
    require(manifest.get("baseLicenseProviderEvidence")==EXPECTED_BASE_LICENSE_EVIDENCE, "BASE_LICENSE_PROVIDER_EVIDENCE_NOT_ALLOWLISTED")
    require(manifest.get("sourceLicenseEvidence")==EXPECTED_SOURCE_LICENSE_EVIDENCE, "SOURCE_LICENSE_EVIDENCE_NOT_ALLOWLISTED")
    require(manifest.get("buildModifications")==EXPECTED_BUILD_MODIFICATIONS, "BUILD_MODIFICATION_POLICY_INVALID")
    specs=manifest.get("packages"); require(isinstance(specs,list) and len(specs)==22 and [x.get('name') for x in specs]==sorted(EXPECTED_PACKAGES), "PACKAGE_SET_COUNT_OR_NAMES_INVALID")
    by={x['name']:x for x in closure['packages']}; require(set(by)==set(EXPECTED_PACKAGES), "SOURCE_CLOSURE_PACKAGES_INVALID")
    for spec in specs:
        name=spec['name']; require((spec.get('version'),spec.get('architecture'),spec.get('licenseExpression'))==EXPECTED_PACKAGES[name],"PACKAGE_IDENTITY_NOT_ALLOWLISTED",name)
        pinned=by[name]; require(all(spec.get(k)==pinned.get(k) for k in ('recipePath', 'recipeSha256', 'packageType', 'parentPackage', 'parentDependencyRule', 'subpackagePath', 'subpackageSha256', 'sourceVersionExpression', 'sourceRevisionExpression', 'versionExpressionIsLiteral', 'revisionExpressionIsLiteral', 'dependencyGroups', 'recommendationGroupsNotIncludedInRequiredClosure')),"PACKAGE_SOURCE_METADATA_DRIFT",name)
        expected=spec.get('recipeDirectoryFiles',{}); require(spec['recipePath'] in expected and expected[spec['recipePath']]==spec['recipeSha256'],"RECIPE_DIRECTORY_LOCK_INCOMPLETE",name)
    return manifest,prefix,specs


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
    required_elf = {"cmake": {"bin/cmake", "bin/ctest", "bin/cpack"}, "ninja": {"bin/ninja"}}.get(name, set())
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
                    if relative in required_elf:
                        require(bool(member.mode & 0o111), "MANDATORY_ELF_NOT_EXECUTABLE", name + ":" + relative)
                        found_required_elf.add(relative)
                    temp_file = temp / (name + "-" + str(len(elf_records)))
                    temp_file.write_bytes(content)
                    elf_records.append({**inspect_elf(temp_file, relative, prefix), "sha256": hashlib.sha256(content).hexdigest()})
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
    if name in {"cmake", "ninja"}:
        evidence = EXPECTED_SOURCE_LICENSE_EVIDENCE[name]
        for leaf, digest_expected in evidence["licenseFiles"].items():
            if name == "cmake":
                path = prefix + "/share/doc/cmake/copyright"
                require(license_hashes.get(path) == digest_expected, "SOURCE_NOTICE_HASH_MISMATCH", name + ":" + leaf)
            # Ninja COPYING is pinned source provenance; default installer uses the verified shared Apache license symlink.
    if required_elf:
        require(found_required_elf == required_elf, "MANDATORY_ELF_SET_INCOMPLETE", name)
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
    with tempfile.TemporaryDirectory(prefix="aib-cmake-ninja-audit-") as td:
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
            "sourceClosureProfile": "cmake-ninja-candidate", "sourceBuildTargetPackages": ["cmake", "ninja"],
            "restrictedAppArmorProfileSha256": manifest["source"]["restrictedAppArmorProfileSha256"],
            "sourceClosurePackageCount": PACKAGE_COUNT, "candidatePackageCount": len(all_results), "sourceClosureDependencyAlternativeCount": DEPENDENCY_ALTERNATIVE_COUNT,
            "buildModifications": manifest["buildModifications"], "packages": all_results,
            "elfProviders": providers["providers"], "elfPackageFileProviders": providers["packageFileProviders"],
            "elfPackageFileSymlinkProviders": providers["packageFileSymlinkProviders"],
            "elfDuplicateAliases": providers["duplicateAliases"],
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
        print("CMAKE_NINJA_CANDIDATE_STATIC_AUDIT_OK packages={} elf={} app_private_prefix=1 device_install=NOT_RUN".format(
            report["candidatePackageCount"], report["elfCount"]))
        return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print("CMAKE_NINJA_CANDIDATE_STATIC_AUDIT_REJECTED:" + (str(exc) if isinstance(exc, AuditError) else "INPUT_INVALID"), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
