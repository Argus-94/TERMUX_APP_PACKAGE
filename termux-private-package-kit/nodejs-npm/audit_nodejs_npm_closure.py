#!/usr/bin/env python3
"""Fail-closed static audit of pinned Node.js + npm exact package closure."""
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
PACKAGE_COUNT = 11
DEPENDENCY_ALTERNATIVE_COUNT = 14
PACKAGE_SET_SHA256 = "12fad5653ded438040f11509472dcd4eb732321f70437158d488846e49660d06"
SOURCE_CLOSURE_SHA256 = "4bfb59809c1dc31731816a11a9671853a93ca3994bfd9266f9a67eb3abec4c61"
PATCH_SHA256 = "ab60e8d3e47beffb3b5d1d011405593ef215486b157a97a5d58803bb8edbe097"
PREFIXES = {
    "/data/user/0/com.karat.aibuilder/files/usr",
    "/data/data/com.karat.aibuilder/files/usr",
}
PLATFORM_LIBS = {
    "libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so",
    "libz.so", "libgcc.so", "libpthread.so", "libatomic.so",
}
PACKAGE_FILE_ELF_PROVIDERS = {}
PACKAGE_FILE_ELF_SYMLINK_PROVIDERS = {
    "libsqlite3.so": ("libsqlite", "lib/libsqlite3.so", "lib/libsqlite3.so.3.54.0"),
}
ANDROID_PATH_RE = re.compile(rb"/data/(?:data|user/0)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._+-]+)*")
LICENSE_NAME_RE = re.compile(r"(?i)^(copyright|copying|license|licence)(?:[._-].*)?$")
CONTROL_ALLOWLIST = {"control", "md5sums", "conffiles", "triggers", "shlibs", "symbols", "copyright", "postinst", "postrm", "preinst", "prerm", "config"}
MAX_DEB_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

EXPECTED_PACKAGES = {"c-ares":("1.34.8","aarch64","MIT"),"ca-certificates":("1:2026.09.25","all","MPL-2.0"),"libc++":("30","aarch64","NCSA"),"libffi":("3.8.0","aarch64","MIT"),"libicu":("78.3","aarch64","custom"),"libsqlite":("3.54.0","aarch64","Public Domain"),"nodejs":("26.4.0-1","aarch64","MIT"),"npm":("11.20.0","all","Artistic-License-2.0"),"openssl":("1:3.6.5","aarch64","Apache-2.0"),"resolv-conf":("1.3","aarch64","Public Domain"),"zlib":("1.3.2","aarch64","ZLIB")}

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
        "share/LICENSES/NCSA.txt": "aecb9504bcc76b4ff5e8ff1266344bb607b6bed2bfc3dd8b35233d941401d01e",
    },
    "verification": "Seven relevant ZIP license payloads were byte-for-byte compared with pinned termux-licenses source; package status comes from the embedded v476 archive. This is archive evidence, not device observation.",
    "deviceObserved": False,
}
# These package-local files are mandatory license evidence, rather than any file
# whose basename merely resembles a license. libicu and nodejs are source-built;
# npm's payload hash is additionally checked against manifest source evidence.
EXPECTED_LOCAL_LICENSE_PATHS = {
    "libicu": {"share/doc/libicu/LICENSE"},
    "nodejs": {"share/doc/nodejs/LICENSE"},
    "npm": {"share/doc/npm/LICENSE"},
}
EXPECTED_SHARED_LICENSES = {
    "libc++": {"NCSA"},
    "resolv-conf": {"Public Domain"},
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
    return {"path": rel, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "soname": soname, "needed": needed, "interpreter": interpreter, "rpaths": rpaths}


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
    for root in license_roots(name, prefix):
        if path.startswith(root):
            leaf = path[len(root):]
            return "/" not in leaf and LICENSE_NAME_RE.fullmatch(leaf) is not None
    return False


def expected_base_license_evidence(value: Any) -> dict[str, Any]:
    require(value == EXPECTED_BASE_LICENSE_EVIDENCE, "BASE_LICENSE_PROVIDER_EVIDENCE_NOT_ALLOWLISTED")
    return EXPECTED_BASE_LICENSE_EVIDENCE


def validate_manifest(args: argparse.Namespace) -> tuple[dict[str, Any], str, list[dict[str, Any]]]:
    closure_bytes=args.source_closure.read_bytes()
    require(hashlib.sha256(closure_bytes).hexdigest()==SOURCE_CLOSURE_SHA256,"SOURCE_CLOSURE_SHA256_NOT_ALLOWLISTED")
    closure=json.loads(closure_bytes.decode("utf-8","strict"))
    require(closure.get("schemaVersion")==1 and closure.get("profile")=="nodejs-npm-candidate" and closure.get("rootPackages")==["nodejs","npm"] and len(closure.get("packages",[]))==11 and closure.get("dependencyAlternativeCount")==14,"SOURCE_CLOSURE_NOT_EXACT")
    npm=next((x for x in closure["packages"] if x.get("name")=="npm"),None)
    require(npm is not None and npm["dependencyGroups"]==[[{"name":"nodejs","operator":None,"qualifier":None,"sourceRelation":"nodejs","version":None},{"name":"nodejs-lts","operator":None,"qualifier":None,"sourceRelation":"nodejs-lts","version":None}]],"NPM_SOURCE_ALTERNATIVE_DRIFT")
    require(closure.get("selectedDependencyAlternatives")==[{"alternatives":["nodejs","nodejs-lts"],"dependencyGroupIndex":0,"package":"npm","selected":"nodejs"}],"NPM_PROVIDER_NOT_NODEJS")
    raw=args.package_set.read_bytes(); require(bool(PACKAGE_SET_SHA256) and hashlib.sha256(raw).hexdigest()==PACKAGE_SET_SHA256,"PACKAGE_SET_SHA256_NOT_ALLOWLISTED")
    manifest=json.loads(raw.decode("utf-8","strict")); prefix=normalize_prefix(args.prefix)
    require(manifest.get("schemaVersion")==1 and manifest.get("channel")=="candidate-only","PACKAGE_SET_NOT_CANDIDATE_ONLY")
    source=manifest.get("source",{}); require(source.get("commit")==SOURCE_COMMIT,"SOURCE_PIN_MISMATCH")
    sc=manifest.get("sourceClosure",{}); require(sc.get("profile")=="nodejs-npm-candidate" and sc.get("rootPackages")==["nodejs","npm"] and sc.get("buildTargetPackages")==["nodejs","npm"] and sc.get("expectedPackageCount")==11 and sc.get("expectedDependencyAlternativeCount")==14,"MANIFEST_CLOSURE_MISMATCH")
    require(manifest.get("releaseGate")=={"publicationAllowed":False,"deviceInstall":"NOT RUN","rollback":"NOT RUN","deviceEvidenceSha256":None},"RELEASE_GATE_NOT_BLOCKED")
    require(manifest.get("runtimeDependencies",{}).get("selectedDependencyAlternatives")==closure["selectedDependencyAlternatives"],"MANIFEST_PROVIDER_DRIFT")
    expected_base_license_evidence(manifest.get("baseLicenseProviderEvidence"))
    license_evidence = manifest.get("sourceLicenseEvidence", {})
    require(set(license_evidence)==set(EXPECTED_LOCAL_LICENSE_PATHS), "SOURCE_LICENSE_EVIDENCE_SET_MISMATCH")
    require(manifest.get("buildModifications", {}).get("patchSha256")==PATCH_SHA256, "BUILD_PATCH_HASH_MISMATCH")
    require(isinstance(license_evidence, dict), "SOURCE_LICENSE_EVIDENCE_INVALID")
    for pkg in ("nodejs", "npm", "libicu"):
        item = license_evidence.get(pkg, {})
        require("licensePayloadSha256" in item, "SOURCE_LICENSE_HASH_MISSING", pkg)
        if "licensePayloadSha256" in item:
            require(re.fullmatch(r"[0-9a-f]{64}", str(item["licensePayloadSha256"])) is not None,
                    "SOURCE_LICENSE_PAYLOAD_SHA256_INVALID", pkg)
    specs=manifest.get("packages"); require(isinstance(specs,list) and len(specs)==11 and [x.get("name") for x in specs]==sorted(EXPECTED_PACKAGES),"PACKAGE_NAMES_NOT_EXACT_OR_SORTED")
    for x in specs:
        name=x["name"]
        x["sourceLicenseEvidence"] = license_evidence.get(name, {})
        require(x.get("version")==EXPECTED_PACKAGES[name][0] and x.get("architecture")==EXPECTED_PACKAGES[name][1],"PACKAGE_IDENTITY_NOT_ALLOWLISTED",name)
        require(re.fullmatch("[0-9a-f]{64}",str(x.get("recipeSha256",""))) is not None,"RECIPE_HASH_INVALID",name)
        inv=next((p for p in closure["packages"] if p["name"]==name),None); require(inv is not None and inv["recipeSha256"]==x["recipeSha256"],"RECIPE_HASH_DRIFT",name)
        for key in ("recipePath","packageType","sourceVersionExpression","sourceRevisionExpression","dependencyGroups","parentPackage","parentDependencyRule","subpackagePath","subpackageSha256"):
            require(x.get(key)==inv.get(key),"SOURCE_INVENTORY_FIELD_DRIFT",name+":"+key)
        require(x.get("licenseExpression")==EXPECTED_PACKAGES[name][2],"LICENSE_EXPRESSION_NOT_ALLOWLISTED",name)
    return manifest,prefix,specs

def validate_control_license(actual: str, expected: str, package: str = "") -> None:
    # Termux's pinned Debian generator omits License from control; when present,
    # it must still agree with the recipe's pinned expression.
    require(not actual or actual == expected, "CONTROL_LICENSE_NOT_ALLOWLISTED", package)


def verify_license_payload_hash(payload: bytes, expected: Any, package: str) -> str:
    require(isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected) is not None,
            "SOURCE_LICENSE_PAYLOAD_SHA256_MISSING_OR_INVALID", package)
    actual = hashlib.sha256(payload).hexdigest()
    require(actual == expected, "SOURCE_LICENSE_PAYLOAD_SHA256_MISMATCH", package)
    return actual

def audit_one(deb: pathlib.Path, spec: dict[str, Any], prefix: str, temp: pathlib.Path) -> dict[str, Any]:
    require(deb.is_file() and not deb.is_symlink() and 0 < deb.stat().st_size <= MAX_DEB_BYTES, "DEB_INVALID", deb.name)
    digest = sha256_file(deb)
    controls, fields = parse_control_archive(deb, prefix)
    name = spec["name"]
    require((fields["Package"], fields["Version"], fields["Architecture"]) ==
            (name, spec["version"], spec["architecture"]), "DEB_IDENTITY_NOT_ALLOWLISTED", name)
    validate_control_license(fields.get("License", ""), spec["licenseExpression"], name)
    if name == "npm":
        require(fields.get("Depends", "") == "nodejs | nodejs-lts", "NPM_DEPENDS_NOT_EXACT")
    proc = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(deb)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    paths: set[str] = set()
    license_paths: set[str] = set()
    license_hashes: dict[str, str] = {}
    license_payloads: dict[str, bytes] = {}
    shared_license_targets: set[str] = set()
    elf_records: list[dict[str, Any]] = []
    library_symlinks: list[dict[str, str]] = []
    total = count = 0
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
                    license_payloads[path] = content
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
    if name in EXPECTED_LOCAL_LICENSE_PATHS:
        expected = {prefix + "/" + item for item in EXPECTED_LOCAL_LICENSE_PATHS[name]}
        require(license_paths == expected and expected.issubset(license_hashes),
                "LOCAL_LICENSE_PATH_SET_MISMATCH", name)
    if name in {"nodejs", "npm", "libicu"}:
        evidence = (spec.get("sourceLicenseEvidence") or {})
        expected_hash = evidence.get("licensePayloadSha256")
        expected_path = prefix + "/" + next(iter(EXPECTED_LOCAL_LICENSE_PATHS[name]))
        require(expected_path in license_hashes, "LOCAL_LICENSE_PATH_SET_MISMATCH", name)
        if expected_hash is not None:
            verify_license_payload_hash(license_payloads[expected_path], expected_hash, name)
    if name in EXPECTED_SHARED_LICENSES:
        require(shared_license_targets == {"share/LICENSES/" + x + ".txt" for x in EXPECTED_SHARED_LICENSES[name]},
                "SHARED_LICENSE_TARGET_SET_MISMATCH", name)

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
    with tempfile.TemporaryDirectory(prefix="nodejs-npm-audit-") as td:
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
            "sourceCommit": SOURCE_COMMIT, "builderImage": BUILDER_IMAGE,
            "sourceClosureProfile": "nodejs-npm-candidate", "sourceBuildTargetPackage": "npm",
            "restrictedAppArmorProfileSha256": manifest["source"]["restrictedAppArmorProfileSha256"],
            "sourceClosurePackageCount": PACKAGE_COUNT, "sourceClosureDependencyAlternativeCount": DEPENDENCY_ALTERNATIVE_COUNT,
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
        print("NODEJS_NPM_CANDIDATE_STATIC_AUDIT_OK packages={} elf={} app_private_prefix=1 device_install=NOT_RUN".format(
            report["candidatePackageCount"], report["elfCount"]))
        return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print("NODEJS_NPM_CANDIDATE_STATIC_AUDIT_REJECTED:" + (str(exc) if isinstance(exc, AuditError) else "INPUT_INVALID"), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
