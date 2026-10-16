#!/usr/bin/env python3
"""Fail-closed static audit for the pinned AI Builder GitHub CLI candidate."""
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
SOURCE_REPO = "https://github.com/termux/termux-packages.git"
SOURCE_COMMIT = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
RECIPE_SHA256 = "a26022905b66f39851553abea3b5e68c38671988b4e2a9a649366845dadfb266"
SOURCE_URL = "https://github.com/cli/cli/archive/refs/tags/v2.102.0.tar.gz"
SOURCE_SHA256 = "08bf0ef8b4409893889175e0f5279d30d6edd96465816042c0d7c72eac598158"
LICENSE_SHA256 = "6da4adc42392c8485e40b4251c7e332fc3352df1947c9ffade71dd60b14a7a4f"
BUILDER_IMAGE = "ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9"
MAX_DEB_BYTES = 256 * 1024 * 1024
MAX_CONTROL_BYTES = 16 * 1024 * 1024
MAX_CONTROL_MEMBER_BYTES = 2 * 1024 * 1024
MAX_PAYLOAD_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
CONTROL_ALLOWLIST = {"control", "md5sums", "conffiles", "triggers", "shlibs", "symbols", "copyright", "postinst"}
PLATFORM_ELF_LIBRARIES = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so", "libz.so", "libgcc.so", "libpthread.so"}
APP_DATA_RE = re.compile(r"^/data/(?:data|user/0)/com\.karat\.aibuilder$")
FOREIGN_ANDROID_PATH_RE = re.compile(rb"/data/(?:data|user/0)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._+-]+)*")


class AuditError(Exception):
    pass


def require(condition: bool, code: str, detail: str = "") -> None:
    if not condition:
        raise AuditError(code + (f": {detail}" if detail else ""))


def normalize_prefix(raw: str) -> str:
    prefix = raw.rstrip("/")
    require(prefix.endswith("/files/usr"), "PREFIX_NOT_FILES_USR")
    data_dir = prefix.removesuffix("/files/usr")
    require(bool(APP_DATA_RE.fullmatch(data_dir)), "PREFIX_NOT_CANONICAL_AI_BUILDER_PATH")
    return prefix


def normalize_payload_path(raw: str) -> str:
    value = raw.rstrip("/")
    while value.startswith("./"):
        value = value[2:]
    require(value not in {"", "."} and not value.startswith("/") and "\\" not in value and "\x00" not in value,
            "PAYLOAD_PATH_INVALID", raw)
    parts = value.split("/")
    require(all(part not in {"", ".", ".."} for part in parts), "PAYLOAD_PATH_TRAVERSAL", raw)
    return "/" + "/".join(parts)


def ensure_inside(path: str, prefix: str, code: str) -> None:
    require(path == prefix or path.startswith(prefix + "/"), code, path)


def validate_payload_location(path: str, prefix: str, *, is_directory: bool) -> None:
    if is_directory:
        is_ancestor = prefix.startswith(path.rstrip("/") + "/")
        is_descendant = path == prefix or path.startswith(prefix + "/")
        require(is_ancestor or is_descendant, "PAYLOAD_DIRECTORY_OUTSIDE_PRIVATE_PREFIX", path)
    else:
        ensure_inside(path, prefix, "PAYLOAD_OUTSIDE_APP_PRIVATE_PREFIX")


def resolve_link(member_path: str, target: str, *, hardlink: bool, prefix: str) -> str:
    require(target and "\\" not in target and "\x00" not in target, "LINK_TARGET_INVALID", member_path)
    if target.startswith("/"):
        resolved = posixpath.normpath(target)
    elif hardlink:
        resolved = normalize_payload_path(target)
    else:
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member_path), target))
    ensure_inside(resolved, prefix, "LINK_ESCAPES_PRIVATE_PREFIX")
    return resolved


def expected_postinst(prefix: str) -> bytes:
    return (
        f"#!{prefix}/bin/sh\n"
        f"gh completion -s bash > {prefix}/share/bash-completion/completions/gh.bash\n"
        f"gh completion -s zsh > {prefix}/share/zsh/site-functions/_gh\n"
        f"gh completion -s fish > {prefix}/share/fish/vendor_completions.d/gh.fish\n"
    ).encode("utf-8")


def parse_control(data: bytes) -> email.message.Message:
    try:
        control = email.parser.Parser().parsestr(data.decode("utf-8", "strict"))
    except UnicodeDecodeError as exc:
        raise AuditError("CONTROL_NOT_UTF8") from exc
    for field in ("Package", "Version", "Architecture", "Maintainer", "Description"):
        require(len(control.get_all(field, [])) == 1, "CONTROL_FIELD_MISSING_OR_DUPLICATE", field)
    require(control.get("Package") == "gh", "CONTROL_PACKAGE_MISMATCH")
    require(control.get("Version") == "2.102.0", "CONTROL_VERSION_MISMATCH")
    require(control.get("Architecture") == "aarch64", "CONTROL_ARCHITECTURE_MISMATCH")
    require(not control.get("Depends", "").strip(), "UNEXPECTED_RUNTIME_DEPENDS", control.get("Depends", ""))
    require(not control.get("Pre-Depends", "").strip(), "UNEXPECTED_RUNTIME_PREDEPENDS", control.get("Pre-Depends", ""))
    require(control.get("Recommends", "").strip() == "openssh", "RECOMMENDS_NOT_SOURCE_ALLOWLISTED",
            control.get("Recommends", ""))
    return control


def validate_candidate_set(path: pathlib.Path) -> tuple[dict[str, Any], str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AuditError("CANDIDATE_SET_UNREADABLE") from exc
    require(isinstance(value, dict) and value.get("schemaVersion") == 1, "CANDIDATE_SET_SCHEMA_UNSUPPORTED")
    require(value.get("channel") == "candidate-only", "CANDIDATE_CHANNEL_NOT_CANDIDATE_ONLY")
    target = value.get("target", {})
    require(target.get("applicationId") == APP_ID and target.get("architecture") == "aarch64",
            "CANDIDATE_TARGET_MISMATCH")
    prefix = normalize_prefix(str(target.get("modeledPrefix", "")))
    require(target.get("modeledDataDir") == prefix.removesuffix("/files/usr"), "CANDIDATE_DATA_DIR_MISMATCH")
    release = value.get("releaseGate", {})
    require(release.get("publicationAllowed") is False, "PRODUCTION_PUBLICATION_MUST_REMAIN_DISABLED")
    require(release.get("deviceInstall") == "NOT_RUN" and release.get("rollback") == "NOT_RUN",
            "DEVICE_STATUS_MUST_REMAIN_UNPROVEN")
    require(release.get("deviceEvidenceSha256") is None, "DEVICE_EVIDENCE_MUST_NOT_BE_FABRICATED")
    packages = value.get("packages")
    require(isinstance(packages, list) and len(packages) == 1 and isinstance(packages[0], dict),
            "CANDIDATE_PACKAGE_SET_NOT_EXACT")
    spec = packages[0]
    exact = {
        "name": "gh", "version": "2.102.0", "architecture": "aarch64",
        "sourceRepository": SOURCE_REPO, "sourceCommit": SOURCE_COMMIT,
        "recipePath": "packages/gh/build.sh", "recipeSha256": RECIPE_SHA256,
        "sourceUrl": SOURCE_URL, "sourceSha256": SOURCE_SHA256,
        "sourceLicenseFile": "LICENSE", "sourceLicenseRelativePath": "share/doc/gh/copyright",
        "sourceLicenseSha256": LICENSE_SHA256, "builderImage": BUILDER_IMAGE,
        "runtimeDependenciesExpected": [], "recommendationsExpected": ["openssh"],
        "staticAuditRequired": True, "deviceInstallAndRollbackRequired": True,
    }
    for key, expected in exact.items():
        require(spec.get(key) == expected, "CANDIDATE_FIELD_NOT_ALLOWLISTED_" + key.upper())
    return spec, prefix


def read_control_files(deb: pathlib.Path) -> dict[str, bytes]:
    proc = subprocess.run(["dpkg-deb", "--ctrl-tarfile", str(deb)], capture_output=True, check=False, timeout=60)
    require(proc.returncode == 0, "CONTROL_ARCHIVE_READ_FAILED", proc.stderr.decode("utf-8", "replace")[:500])
    require(len(proc.stdout) <= MAX_CONTROL_BYTES, "CONTROL_ARCHIVE_TOO_LARGE")
    result: dict[str, bytes] = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(proc.stdout), mode="r:*") as archive:
            for member in archive:
                raw = member.name
                while raw.startswith("./"):
                    raw = raw[2:]
                if raw in {"", "."} and member.isdir():
                    continue
                require("/" not in raw and raw in CONTROL_ALLOWLIST, "UNKNOWN_CONTROL_ARCHIVE_FILE", raw)
                require(raw not in result and member.isreg(), "CONTROL_MEMBER_DUPLICATE_OR_NONREGULAR", raw)
                require(member.size <= MAX_CONTROL_MEMBER_BYTES, "CONTROL_MEMBER_TOO_LARGE", raw)
                stream = archive.extractfile(member)
                require(stream is not None, "CONTROL_MEMBER_UNREADABLE", raw)
                data = stream.read(member.size + 1)
                require(len(data) == member.size, "CONTROL_MEMBER_SIZE_MISMATCH", raw)
                result[raw] = data
    except (tarfile.TarError, OSError) as exc:
        raise AuditError("CONTROL_ARCHIVE_INVALID") from exc
    require("control" in result, "CONTROL_FILE_MISSING")
    require("postinst" in result, "EXPECTED_POSTINST_MISSING")
    require(set(result).issubset(CONTROL_ALLOWLIST), "CONTROL_FILE_NOT_ALLOWLISTED")
    return result


def scan_embedded_paths(data: bytes, prefix: str, path: str) -> None:
    app_data = prefix.removesuffix("/files/usr")
    app_home = app_data + "/files/home"
    require(b"/storage/emulated/0/AIBuilderTermux" not in data,
            "PERSISTENT_PROJECT_ROOT_EMBEDDED_IN_PACKAGE", path)
    require(b"com.termux" not in data, "COM_TERMUX_REFERENCE_EMBEDDED", path)
    for match in FOREIGN_ANDROID_PATH_RE.finditer(data):
        candidate = match.group(0).decode("ascii", "strict")
        require(posixpath.normpath(candidate) == candidate, "ANDROID_PATH_NOT_CANONICAL", f"{path}: {candidate}")
        require(any(candidate == root or candidate.startswith(root + "/") for root in (prefix, app_home)),
                "FOREIGN_ANDROID_APP_PATH", f"{path}: {candidate}")


def readelf_info(data: bytes, relative_path: str, prefix: str) -> dict[str, Any]:
    require(len(data) >= 64 and data[:4] == b"\x7fELF", "ELF_HEADER_INVALID", relative_path)
    require(data[4] == 2 and data[5] == 1, "ELF_MUST_BE_64BIT_LITTLE_ENDIAN", relative_path)
    require(int.from_bytes(data[18:20], "little") == 183, "ELF_MACHINE_NOT_AARCH64", relative_path)
    with tempfile.NamedTemporaryFile(prefix="aib-gh-audit-", delete=True) as stream:
        stream.write(data)
        stream.flush()
        header = subprocess.run(["readelf", "-hW", stream.name], capture_output=True, text=True, check=False, timeout=20)
        require(header.returncode == 0 and "Machine:" in header.stdout and "AArch64" in header.stdout,
                "READELF_HEADER_REJECTED", relative_path)
        program = subprocess.run(["readelf", "-lW", stream.name], capture_output=True, text=True, check=False, timeout=20)
        require(program.returncode == 0, "READELF_PROGRAM_HEADERS_FAILED", relative_path)
        match = re.search(r"Requesting program interpreter: ([^\]]+)", program.stdout)
        interpreter = match.group(1).strip() if match else None
        require(interpreter in {None, "/system/bin/linker64"}, "ELF_INTERPRETER_NOT_ANDROID_LINKER64",
                f"{relative_path}: {interpreter}")
        dynamic = subprocess.run(["readelf", "-dW", stream.name], capture_output=True, text=True, check=False, timeout=20)
        require(dynamic.returncode == 0, "READELF_DYNAMIC_SECTION_FAILED", relative_path)
        needed = sorted(set(re.findall(r"\(NEEDED\).*?Shared library: \[([^]]+)\]", dynamic.stdout)))
        require(set(needed).issubset(PLATFORM_ELF_LIBRARIES), "ELF_NEEDED_LIBRARY_UNPROVEN",
                f"{relative_path}: {','.join(sorted(set(needed) - PLATFORM_ELF_LIBRARIES))}")
        rpaths: list[str] = []
        for value in re.findall(r"\((?:RPATH|RUNPATH)\).*?Library (?:rpath|runpath): \[([^]]*)\]", dynamic.stdout):
            for item in filter(None, value.split(":")):
                if item.startswith("/"):
                    resolved = posixpath.normpath(item)
                elif item in {"$ORIGIN", "${ORIGIN}"}:
                    resolved = posixpath.dirname(prefix + "/" + relative_path)
                elif item.startswith("$ORIGIN/"):
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(prefix + "/" + relative_path), item[8:]))
                elif item.startswith("${ORIGIN}/"):
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(prefix + "/" + relative_path), item[10:]))
                else:
                    raise AuditError("ELF_RPATH_VARIABLE_UNSUPPORTED: " + relative_path + ": " + item)
                ensure_inside(resolved, prefix, "ELF_RPATH_ESCAPES_PRIVATE_PREFIX")
                rpaths.append(item)
        return {"path": relative_path, "machine": "AArch64", "interpreter": interpreter,
                "needed": needed, "rpathRunpath": rpaths}


def read_payload(deb: pathlib.Path, prefix: str) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    proc = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(deb)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(proc.stdout is not None, "PAYLOAD_ARCHIVE_STREAM_UNAVAILABLE")
    payload: dict[str, dict[str, Any]] = {}
    elf_records: list[dict[str, Any]] = []
    total = 0
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|*") as archive:
            for member in archive:
                raw = member.name
                if member.isdir() and raw.rstrip("/") in {"", ".", "./"}:
                    continue
                path = normalize_payload_path(raw)
                validate_payload_location(path, prefix, is_directory=member.isdir())
                if member.isdir():
                    continue
                if member.issym() or member.islnk():
                    resolve_link(path, member.linkname, hardlink=member.islnk(), prefix=prefix)
                    rel = path[len(prefix):].lstrip("/")
                    require(rel not in payload, "PAYLOAD_PATH_DUPLICATE", rel)
                    payload[rel] = {"type": "symlink" if member.issym() else "hardlink", "target": member.linkname}
                    continue
                require(member.isreg(), "SPECIAL_PAYLOAD_FILE_REJECTED", path)
                require(member.size <= MAX_MEMBER_BYTES, "PAYLOAD_MEMBER_TOO_LARGE", path)
                total += member.size
                require(total <= MAX_PAYLOAD_BYTES, "PAYLOAD_TOTAL_TOO_LARGE")
                data_stream = archive.extractfile(member)
                require(data_stream is not None, "PAYLOAD_MEMBER_UNREADABLE", path)
                data = data_stream.read(member.size + 1)
                require(len(data) == member.size, "PAYLOAD_MEMBER_SIZE_MISMATCH", path)
                scan_embedded_paths(data, prefix, path)
                rel = path[len(prefix):].lstrip("/")
                require(rel not in payload, "PAYLOAD_PATH_DUPLICATE", rel)
                payload[rel] = {"type": "file", "size": member.size, "mode": member.mode,
                                "sha256": hashlib.sha256(data).hexdigest()}
                if data.startswith(b"\x7fELF"):
                    elf_records.append(readelf_info(data, rel, prefix))
        proc.stdout.close()
        stderr = proc.stderr.read(16 * 1024) if proc.stderr else b""
        code = proc.wait(timeout=120)
        require(code == 0, "PAYLOAD_ARCHIVE_READ_FAILED", stderr.decode("utf-8", "replace")[:500])
    except Exception:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        raise
    return payload, elf_records


def audit(args: argparse.Namespace) -> dict[str, Any]:
    spec, prefix = validate_candidate_set(args.package_set)
    require(not args.deb.is_symlink(), "DEB_SYMLINK_REJECTED")
    deb = args.deb.resolve(strict=True)
    require(deb.is_file(), "DEB_NOT_REGULAR")
    size = deb.stat().st_size
    require(0 < size <= MAX_DEB_BYTES, "DEB_SIZE_OUT_OF_BOUNDS", str(size))
    controls = read_control_files(deb)
    control = parse_control(controls["control"])
    require(controls["postinst"] == expected_postinst(prefix), "POSTINST_NOT_EXACTLY_ALLOWLISTED")
    postinst_sha = hashlib.sha256(controls["postinst"]).hexdigest()
    payload, elf_records = read_payload(deb, prefix)
    gh = payload.get("bin/gh")
    require(gh is not None and gh["type"] == "file" and gh["mode"] & 0o111,
            "GH_EXECUTABLE_MISSING_OR_NOT_EXECUTABLE")
    require(any(item["path"] == "bin/gh" for item in elf_records), "GH_EXECUTABLE_NOT_AARCH64_ELF")
    license_path = spec["sourceLicenseRelativePath"]
    license_record = payload.get(license_path)
    require(license_record is not None and license_record["type"] == "file", "SOURCE_LICENSE_FILE_MISSING", license_path)
    require(license_record["sha256"] == LICENSE_SHA256, "SOURCE_LICENSE_SHA256_MISMATCH", license_path)
    completion_paths = (
        "share/bash-completion/completions/gh.bash",
        "share/zsh/site-functions/_gh",
        "share/fish/vendor_completions.d/gh.fish",
    )
    for path in completion_paths:
        require(path in payload and payload[path]["type"] == "file", "COMPLETION_PLACEHOLDER_MISSING", path)
    deb_sha = hashlib.sha256(deb.read_bytes()).hexdigest()
    return {
        "ok": True,
        "status": "static-audit-passed; installation-and-device-runtime-unverified",
        "sha256": deb_sha,
        "package": {
            "name": control.get("Package"), "version": control.get("Version"),
            "architecture": control.get("Architecture"),
            "depends": [], "preDepends": [], "recommends": ["openssh"],
            "licenseEvidencePath": license_path, "licenseEvidenceSha256": license_record["sha256"],
            "postinstSha256": postinst_sha, "payloadFileCount": sum(x["type"] == "file" for x in payload.values()),
            "elf": elf_records,
        },
        "source": {"repository": SOURCE_REPO, "commit": SOURCE_COMMIT,
                   "recipePath": spec["recipePath"], "recipeSha256": RECIPE_SHA256,
                   "archiveUrl": SOURCE_URL, "archiveSha256": SOURCE_SHA256},
        "target": {"applicationId": APP_ID, "architecture": "aarch64", "prefix": prefix,
                   "prefixProvenance": "ci-model-only; device-observation-not-run"},
        "installed": False,
        "deviceSmokeTest": "NOT RUN",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-set", type=pathlib.Path, required=True)
    parser.add_argument("--deb", type=pathlib.Path, required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--report", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        report = audit(args)
        args.report.write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        print("GH_STATIC_AUDIT_OK package=gh version=2.102.0 arch=aarch64 depends=0 recommends=openssh license=MIT aarch64_elf=1 exact_postinst=1 device_install=NOT_RUN")
        return 0
    except (AuditError, OSError, ValueError, KeyError, subprocess.SubprocessError, tarfile.TarError) as exc:
        print("GH_STATIC_AUDIT_REJECTED:" + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
