#!/usr/bin/env python3
"""Fail-closed static audit for the locked AI Builder private GNU Make package."""
from __future__ import annotations

import argparse
import email.parser
import hashlib
import json
import os
import pathlib
import posixpath
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
from typing import Any, Callable

MAX_DEB_BYTES = 128 * 1024 * 1024
MAX_CONTROL_TAR_BYTES = 16 * 1024 * 1024
MAX_UNPACKED_BYTES = 128 * 1024 * 1024
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_CONTROL_FILE_BYTES = 2 * 1024 * 1024
AR_MAGIC = b"!<arch>\n"
APP_ID = "com.karat.aibuilder"
APP_DATA_PATH_RE = re.compile(r"^/data/(?:data|user/0)/com\.karat\.aibuilder$")
FOREIGN_ANDROID_PATH_RE = re.compile(rb"/data/(?:data|user/0)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._+-]+)*")
MAINTAINER_HOOKS = {"preinst", "postinst", "prerm", "postrm", "config"}
CONTROL_ALLOWLIST = {"control", "md5sums", "conffiles", "triggers", "shlibs", "symbols", "copyright"}


class AuditError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code + (f": {detail}" if detail else ""))
        self.code = code
        self.detail = detail


def require(condition: bool, code: str, detail: str = "") -> None:
    if not condition:
        raise AuditError(code, detail)


def normalize_prefix(raw: str) -> str:
    prefix = raw.rstrip("/")
    require(bool(APP_DATA_PATH_RE.fullmatch(prefix.removesuffix("/files/usr"))) if prefix.endswith("/files/usr") else False,
            "PREFIX_NOT_CANONICAL_AI_BUILDER_PATH")
    return prefix


def ar_members(path: pathlib.Path) -> dict[str, int]:
    size = path.stat().st_size
    require(0 < size <= MAX_DEB_BYTES, "DEB_SIZE_OUT_OF_BOUNDS", str(size))
    out: dict[str, int] = {}
    with path.open("rb") as stream:
        require(stream.read(8) == AR_MAGIC, "AR_MAGIC_INVALID")
        while True:
            header = stream.read(60)
            if not header:
                break
            require(len(header) == 60 and header[58:60] == b"`\n", "AR_HEADER_INVALID")
            raw_name = header[:16].decode("ascii", "strict").strip()
            require(raw_name not in {"", "/", "//", "/SYM64/"} and not raw_name.startswith("#1/"),
                    "AR_UNSUPPORTED_MEMBER_NAME", raw_name)
            name = raw_name.rstrip("/")
            try:
                member_size = int(header[48:58].decode("ascii").strip())
            except ValueError:
                raise AuditError("AR_MEMBER_SIZE_INVALID", name)
            require(member_size >= 0 and name not in out, "AR_MEMBER_DUPLICATE_OR_SIZE_INVALID", name)
            out[name] = member_size
            if name == "debian-binary":
                require(stream.read(member_size) == b"2.0\n", "DEBIAN_BINARY_VERSION_INVALID")
            else:
                stream.seek(member_size, os.SEEK_CUR)
            if member_size & 1:
                stream.seek(1, os.SEEK_CUR)
            require(stream.tell() <= size, "AR_MEMBER_TRUNCATED", name)
    required = {"debian-binary"}
    require(required.issubset(out), "DEB_REQUIRED_AR_MEMBER_MISSING")
    require(out["debian-binary"] == 4, "DEBIAN_BINARY_MEMBER_SIZE_INVALID")
    archive_names = [n for n in out if n.startswith("control.tar.") or n.startswith("data.tar.")]
    require(sum(n.startswith("control.tar.") for n in archive_names) == 1, "CONTROL_ARCHIVE_COUNT_INVALID")
    require(sum(n.startswith("data.tar.") for n in archive_names) == 1, "DATA_ARCHIVE_COUNT_INVALID")
    require(set(out) == required | set(archive_names), "UNEXPECTED_AR_MEMBERS", ",".join(sorted(set(out) - required - set(archive_names))))
    require(all(out[n] <= MAX_CONTROL_TAR_BYTES for n in archive_names if n.startswith("control.tar.")),
            "CONTROL_ARCHIVE_TOO_LARGE")
    return out


def control_name(name: str) -> str:
    value = name
    while value.startswith("./"):
        value = value[2:]
    require(value not in {"", "."} and not value.startswith("/") and "\\" not in value and "\x00" not in value,
            "CONTROL_PATH_INVALID", name)
    require(all(part not in {"", ".", ".."} for part in value.split("/")), "CONTROL_PATH_TRAVERSAL", name)
    require("/" not in value, "CONTROL_PATH_NESTED", name)
    return value


def scan_tar(command: list[str], callback: Callable[[tarfile.TarFile, tarfile.TarInfo], None], total_limit: int,
             timeout_seconds: int = 90) -> None:
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    total = 0
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as archive:
            for member in archive:
                total += max(member.size, 0)
                require(total <= total_limit, "UNPACKED_ARCHIVE_TOO_LARGE", str(total))
                callback(archive, member)
        proc.stdout.close()
        try:
            stderr = proc.stderr.read(16 * 1024) if proc.stderr else b""
            code = proc.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise AuditError("DPKG_DEB_TIMEOUT", command[1])
        require(code == 0, "DPKG_DEB_ARCHIVE_READ_FAILED", stderr.decode("utf-8", "replace")[:800])
    except Exception:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        raise


def read_regular(archive: tarfile.TarFile, member: tarfile.TarInfo, limit: int) -> bytes:
    require(member.size <= limit, "TAR_MEMBER_TOO_LARGE", member.name)
    extracted = archive.extractfile(member)
    require(extracted is not None, "TAR_MEMBER_UNREADABLE", member.name)
    data = extracted.read(limit + 1)
    require(len(data) == member.size, "TAR_MEMBER_SIZE_MISMATCH", member.name)
    return data


def parse_control(data: bytes) -> email.message.Message:
    try:
        text = data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        raise AuditError("CONTROL_NOT_UTF8")
    msg = email.parser.Parser().parsestr(text)
    for field in ("Package", "Version", "Architecture", "Maintainer", "Description"):
        require(len(msg.get_all(field, [])) == 1, "CONTROL_FIELD_MISSING_OR_DUPLICATE", field)
    return msg


def split_relation_field(value: str | None) -> list[str]:
    if not value:
        return []
    return sorted({m.group(1) for m in re.finditer(r"(?:^|[,|])\s*([a-z0-9][a-z0-9+.-]*)", value)})


def normalize_payload_path(name: str) -> str:
    require("\x00" not in name and "\\" not in name, "PAYLOAD_PATH_INVALID", name)
    value = name
    while value.startswith("./"):
        value = value[2:]
    if value in {"", "."}:
        return "/"
    require(not value.startswith("/"), "ABSOLUTE_TAR_MEMBER_PATH", name)
    parts = value.split("/")
    require(all(part not in {"", ".", ".."} for part in parts), "PAYLOAD_PATH_TRAVERSAL", name)
    return "/" + "/".join(parts)


def check_inside_prefix(path: str, prefix: str, code: str) -> None:
    require(path == prefix or path.startswith(prefix + "/"), code, path)


def resolve_link(member_path: str, target: str, is_symlink: bool, prefix: str) -> str:
    require(target and "\x00" not in target and "\\" not in target, "LINK_TARGET_INVALID", member_path)
    if target.startswith("/"):
        resolved = posixpath.normpath(target)
    elif is_symlink:
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member_path), target))
    else:
        resolved = normalize_payload_path(target)
    check_inside_prefix(resolved, prefix, "LINK_ESCAPES_PRIVATE_PREFIX")
    return resolved


def scan_embedded_paths(data: bytes, prefix: str, app_home: str, payload_path: str) -> None:
    for match in FOREIGN_ANDROID_PATH_RE.finditer(data):
        candidate = match.group(0).decode("ascii", "strict")
        require(posixpath.normpath(candidate) == candidate,
                "ANDROID_PATH_NOT_CANONICAL", f"{payload_path}: {candidate}")
        allowed_roots = (prefix, app_home)
        if not any(candidate == root or candidate.startswith(root + "/") for root in allowed_roots):
            raise AuditError("FOREIGN_ANDROID_APP_PATH", f"{payload_path}: {candidate}")
    require(b"/storage/emulated/0/AIBuilderTermux" not in data,
            "PERSISTENT_PROJECT_ROOT_EMBEDDED_IN_PACKAGE", payload_path)


def readelf_info(path: pathlib.Path, relative_path: str, prefix: str, manifest: dict[str, Any]) -> dict[str, Any]:
    content = path.read_bytes()
    require(len(content) >= 64 and content[:4] == b"\x7fELF", "ELF_HEADER_INVALID", relative_path)
    require(content[4] == 2 and content[5] == 1, "ELF_MUST_BE_64BIT_LITTLE_ENDIAN", relative_path)
    e_type = struct.unpack_from("<H", content, 16)[0]
    e_machine = struct.unpack_from("<H", content, 18)[0]
    require(e_machine == 183, "ELF_MACHINE_NOT_AARCH64", relative_path)

    header = subprocess.run(["readelf", "-hW", str(path)], capture_output=True, text=True, check=False)
    require(header.returncode == 0 and "Machine:" in header.stdout and "AArch64" in header.stdout,
            "READELF_HEADER_REJECTED", relative_path)
    program = subprocess.run(["readelf", "-lW", str(path)], capture_output=True, text=True, check=False)
    require(program.returncode == 0, "READELF_PROGRAM_HEADERS_FAILED", relative_path)
    match = re.search(r"Requesting program interpreter: ([^\]]+)", program.stdout)
    interpreter = match.group(1).strip() if match else None
    if relative_path == manifest["package"]["requiredExecutableRelativePath"]:
        require(interpreter == "/system/bin/linker64", "MAKE_INTERPRETER_NOT_ANDROID_LINKER64", str(interpreter))
    elif interpreter:
        require(interpreter == "/system/bin/linker64", "ELF_INTERPRETER_NOT_ANDROID_LINKER64", f"{relative_path}: {interpreter}")

    dynamic = subprocess.run(["readelf", "-dW", str(path)], capture_output=True, text=True, check=False)
    require(dynamic.returncode == 0, "READELF_DYNAMIC_SECTION_FAILED", relative_path)
    needed = sorted(set(re.findall(r"\(NEEDED\).*?Shared library: \[([^]]+)\]", dynamic.stdout)))
    allowed = set(manifest["package"].get("platformElfLibrariesAllowed", []))
    allowed.update(manifest["package"].get("baseRuntimeElfLibraries", {}).keys())
    runtime_packages = set(manifest["package"].get("runtimeDependenciesExpected", []))
    library_map = manifest["package"].get("elfLibraryProviders", {})
    for library in needed:
        require(library in allowed or library_map.get(library) in runtime_packages,
                "ELF_NEEDED_LIBRARY_UNPROVEN", f"{relative_path}: {library}")

    rpaths: list[str] = []
    for value in re.findall(r"\((?:RPATH|RUNPATH)\).*?Library (?:rpath|runpath): \[([^]]*)\]", dynamic.stdout):
        for item in filter(None, value.split(":")):
            if item.startswith("/"):
                resolved = posixpath.normpath(item)
            else:
                origin = posixpath.dirname(prefix + "/" + relative_path)
                if item == "$ORIGIN" or item == "${ORIGIN}":
                    resolved = origin
                elif item.startswith("$ORIGIN/"):
                    resolved = posixpath.normpath(posixpath.join(origin, item[len("$ORIGIN/"):]))
                elif item.startswith("${ORIGIN}/"):
                    resolved = posixpath.normpath(posixpath.join(origin, item[len("${ORIGIN}/"):]))
                else:
                    raise AuditError("ELF_RPATH_VARIABLE_UNSUPPORTED", f"{relative_path}: {item}")
            check_inside_prefix(resolved, prefix, "ELF_RPATH_ESCAPES_PRIVATE_PREFIX")
            rpaths.append(item)
    return {"path": relative_path, "machine": "AArch64", "elfType": e_type,
            "interpreter": interpreter, "needed": needed, "rpathRunpath": rpaths}


def audit(args: argparse.Namespace) -> dict[str, Any]:
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    require(manifest.get("schemaVersion") == 1, "MANIFEST_SCHEMA_UNSUPPORTED")
    pkg = manifest["package"]
    prefix = normalize_prefix(args.prefix)
    app_data_dir = prefix.removesuffix("/files/usr")
    app_home = app_data_dir + "/files/home"
    require(pkg["name"] == "make" and pkg["architecture"] == "aarch64", "LOCKED_PACKAGE_MANIFEST_UNEXPECTED")
    deb = args.deb.resolve(strict=True)
    members = ar_members(deb)

    dpkg_deb = shutil.which("dpkg-deb")
    readelf = shutil.which("readelf")
    require(dpkg_deb is not None and readelf is not None, "DPKG_DEB_AND_READELF_REQUIRED")

    control_files: dict[str, bytes] = {}
    hooks: list[str] = []
    control_total = 0

    def control_cb(archive: tarfile.TarFile, item: tarfile.TarInfo) -> None:
        nonlocal control_total
        if item.isdir() and item.name in {".", "./"}:
            return
        name = control_name(item.name)
        require(name in CONTROL_ALLOWLIST or name in MAINTAINER_HOOKS,
                "UNKNOWN_CONTROL_ARCHIVE_FILE", name)
        require(name not in control_files, "DUPLICATE_CONTROL_ARCHIVE_FILE", name)
        require(item.isreg(), "NONREGULAR_CONTROL_MEMBER", name)
        control_total += max(item.size, 0)
        require(control_total <= MAX_CONTROL_TAR_BYTES, "CONTROL_FILES_TOO_LARGE")
        content = read_regular(archive, item, MAX_CONTROL_FILE_BYTES)
        control_files[name] = content
        if name in MAINTAINER_HOOKS:
            hooks.append(name)

    control_name_ar = next(n for n in members if n.startswith("control.tar."))
    scan_tar([dpkg_deb, "--ctrl-tarfile", str(deb)], control_cb, MAX_CONTROL_TAR_BYTES)
    require("control" in control_files, "CONTROL_FILE_MISSING")
    require(not hooks, "MAINTAINER_SCRIPTS_NOT_ALLOWED_FOR_MAKE", ",".join(hooks))
    control = parse_control(control_files["control"])

    for field, expected in (("Package", pkg["name"]), ("Version", pkg["version"]),
                            ("Architecture", pkg["architecture"]), ("Maintainer", pkg["maintainer"])):
        require(control.get(field) == expected, "CONTROL_FIELD_MISMATCH", f"{field}: {control.get(field)!r}")
    actual_depends = split_relation_field(control.get("Depends"))
    expected_depends = sorted(pkg.get("runtimeDependenciesExpected", []))
    require(actual_depends == expected_depends, "RUNTIME_DEPENDENCY_SET_MISMATCH",
            f"expected={expected_depends} actual={actual_depends}")
    for field, expected in pkg.get("expectedControlRelations", {}).items():
        actual = split_relation_field(control.get(field))
        require(actual == sorted(expected), "CONTROL_RELATION_MISMATCH", f"{field}: expected={sorted(expected)} actual={actual}")

    payload: dict[str, dict[str, Any]] = {}
    symlinks: list[dict[str, str]] = []
    hardlinks: list[dict[str, str]] = []
    elf_records: list[dict[str, Any]] = []
    license_candidates: dict[str, bytes] = {}
    payload_total = 0
    required_exec = prefix + "/" + pkg["requiredExecutableRelativePath"]

    def payload_cb(archive: tarfile.TarFile, item: tarfile.TarInfo) -> None:
        nonlocal payload_total
        path = normalize_payload_path(item.name)
        if path == "/":
            return
        # dpkg archives may carry empty directory records for ancestors of the
        # install prefix. They are allowed only as directories; no file/link
        # payload may be placed outside the exact app-private prefix.
        ancestors = {posixpath.dirname(prefix)}
        current = posixpath.dirname(prefix)
        while current != "/":
            ancestors.add(current)
            current = posixpath.dirname(current)
        if item.isdir() and path in ancestors:
            payload[path] = {"type": "ancestor-directory", "mode": oct(item.mode)}
            return
        check_inside_prefix(path, prefix, "PAYLOAD_OUTSIDE_PRIVATE_PREFIX")
        require(path not in payload, "DUPLICATE_PAYLOAD_PATH", path)
        if item.isdir():
            payload[path] = {"type": "directory", "mode": oct(item.mode)}
            return
        if item.issym():
            target = resolve_link(path, item.linkname, True, prefix)
            payload[path] = {"type": "symlink", "target": item.linkname}
            symlinks.append({"path": path, "target": item.linkname, "resolvedTarget": target})
            return
        if item.islnk():
            target = resolve_link(path, item.linkname, False, prefix)
            payload[path] = {"type": "hardlink", "target": item.linkname}
            hardlinks.append({"path": path, "target": item.linkname, "resolvedTarget": target})
            return
        require(item.isreg(), "SPECIAL_PAYLOAD_FILE_REJECTED", path)
        payload_total += item.size
        require(payload_total <= MAX_UNPACKED_BYTES, "PAYLOAD_UNPACKED_SIZE_TOO_LARGE")
        data = read_regular(archive, item, MAX_MEMBER_BYTES)
        scan_embedded_paths(data, prefix, app_home, path)
        if data.startswith(b"#!"):
            first_line = data.splitlines()[0][2:].decode("utf-8", "replace").strip().split()
            require(bool(first_line), "EMPTY_SHEBANG", path)
            interpreter = first_line[0]
            require(interpreter.startswith(prefix + "/") or interpreter in {"/system/bin/sh", "/system/bin/env"},
                    "SHEBANG_OUTSIDE_PRIVATE_RUNTIME", f"{path}: {interpreter}")
        payload[path] = {"type": "file", "mode": oct(item.mode), "size": item.size,
                         "sha256": hashlib.sha256(data).hexdigest()}
        rel = path[len(prefix) + 1:]
        if path.startswith(prefix + "/share/doc/make/") and pathlib.PurePosixPath(path).name.lower() in {
                "copyright", "license", "copying", "copying3"}:
            license_candidates[path] = data
        if data.startswith(b"\x7fELF"):
            with tempfile.NamedTemporaryFile(prefix="aib-deb-audit-", delete=False) as tmp:
                tmp.write(data)
                temp_name = tmp.name
            try:
                elf_records.append(readelf_info(pathlib.Path(temp_name), rel, prefix, manifest))
            finally:
                pathlib.Path(temp_name).unlink(missing_ok=True)

    data_name_ar = next(n for n in members if n.startswith("data.tar."))
    scan_tar([dpkg_deb, "--fsys-tarfile", str(deb)], payload_cb, MAX_UNPACKED_BYTES)
    require(required_exec in payload and payload[required_exec]["type"] == "file", "MAKE_EXECUTABLE_MISSING")
    require(any(record["path"] == pkg["requiredExecutableRelativePath"] for record in elf_records),
            "MAKE_EXECUTABLE_NOT_AARCH64_ELF")
    require(int(payload[required_exec]["mode"], 8) & 0o111 != 0, "MAKE_EXECUTABLE_NOT_EXECUTABLE")

    expected_license_relative = pkg.get("sourceLicenseRelativePath")
    require(expected_license_relative == "share/doc/make/COPYING", "SOURCE_LICENSE_PATH_NOT_ALLOWLISTED")
    expected_license_sha256 = pkg.get("sourceLicenseSha256", "")
    require(bool(re.fullmatch(r"[0-9a-f]{64}", expected_license_sha256)),
            "LOCKED_SOURCE_LICENSE_HASH_INVALID")
    license_path = prefix + "/" + expected_license_relative
    license_data = license_candidates.get(license_path)
    require(license_data is not None, "SOURCE_LICENSE_FILE_MISSING", license_path)
    license_sha256 = hashlib.sha256(license_data).hexdigest()
    require(license_sha256 == expected_license_sha256, "SOURCE_LICENSE_SHA256_MISMATCH",
            f"{license_path}: {license_sha256}")
    license_body = license_data.decode("utf-8", "replace")
    require("GNU GENERAL PUBLIC LICENSE" in license_body and
            re.search(r"Version\s+3", license_body, re.I) is not None,
            "GPL3_LICENSE_EVIDENCE_MISSING", license_path)

    return {
        "ok": True,
        "status": "static-audit-passed; installation-and-device-runtime-unverified",
        "file": deb.name,
        "sha256": hashlib.sha256(deb.read_bytes()).hexdigest(),
        "package": {"name": control.get("Package"), "version": control.get("Version"),
                    "architecture": control.get("Architecture"), "depends": actual_depends,
                    "breaks": split_relation_field(control.get("Breaks")),
                    "replaces": split_relation_field(control.get("Replaces")),
                    "conflicts": split_relation_field(control.get("Conflicts")),
                    "licenseSpdxFromLockedRecipe": pkg["licenseSpdx"],
                    "licenseEvidencePath": expected_license_relative,
                    "licenseEvidenceSha256": license_sha256},
        "target": {"applicationId": APP_ID, "prefix": prefix,
                   "allowedEmbeddedPathRoots": [prefix, app_home],
                   "persistentProjectRoot": manifest["target"]["persistentProjectRoot"],
                   "projectRootInPayload": False},
        "debArMembers": sorted(members),
        "maintainerScripts": hooks,
        "payloadFileCount": sum(1 for row in payload.values() if row["type"] == "file"),
        "payloadSymlinks": symlinks,
        "payloadHardlinks": hardlinks,
        "payloadPaths": sorted(payload),
        "elf": elf_records,
        "archiveMembersInspected": [control_name_ar, data_name_ar]
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--deb", type=pathlib.Path, required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--report", type=pathlib.Path)
    args = parser.parse_args()
    result: dict[str, Any]
    try:
        result = audit(args)
        code = 0
    except AuditError as exc:
        result = {"ok": False, "error": exc.code, "detail": exc.detail}
        code = 2
    except (OSError, subprocess.SubprocessError, tarfile.TarError, ValueError, KeyError) as exc:
        result = {"ok": False, "error": "AUDIT_INTERNAL_OR_FORMAT_FAILURE", "detail": str(exc)[:1000]}
        code = 2
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
