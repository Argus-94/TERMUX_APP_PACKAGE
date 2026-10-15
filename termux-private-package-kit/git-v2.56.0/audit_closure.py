#!/usr/bin/env python3
"""Static, fail-closed audit of the pinned Git runtime package closure."""
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
PINNED_PACKAGE_COUNT = 14
PLATFORM_LIBS = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so", "libz.so", "libgcc.so", "libpthread.so", "libatomic.so"}
ANDROID_PATH_RE = re.compile(rb"/data/(?:data|user/0)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._+-]+)*")
CONTROL_ALLOWLIST = {"control", "md5sums", "conffiles", "triggers", "shlibs", "symbols", "copyright", "postinst", "postrm", "preinst", "prerm", "config"}
MAX_DEB_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
EXPECTED_LICENSES = {
    "ca-certificates": "MPL-2.0", "git": "GPL-2.0", "less": "GPL-3.0, custom",
    "libcurl": "MIT", "libexpat": "MIT", "libiconv": "LGPL-2.1, GPL-3.0",
    "libnghttp2": "MIT", "libnghttp3": "MIT", "libngtcp2": "MIT",
    "libssh2": "BSD 3-Clause", "ncurses": "MIT", "openssl": "Apache-2.0",
    "pcre2": "BSD 3-Clause", "zlib": "ZLIB",
}


class AuditError(Exception):
    pass


def require(ok: bool, code: str, detail: str = "") -> None:
    if not ok:
        raise AuditError(code + (":" + detail if detail else ""))


def normalize_prefix(value: str) -> str:
    prefix = value.rstrip("/")
    require(prefix in {"/data/user/0/com.karat.aibuilder/files/usr", "/data/data/com.karat.aibuilder/files/usr"}, "PREFIX_NOT_CANONICAL")
    return prefix


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


def audit_one(deb: pathlib.Path, spec: dict[str, Any], prefix: str, temp: pathlib.Path) -> dict[str, Any]:
    require(deb.is_file() and not deb.is_symlink() and 0 < deb.stat().st_size <= MAX_DEB_BYTES, "DEB_INVALID", str(deb.name))
    sha = hashlib.sha256(deb.read_bytes()).hexdigest()
    controls, fields = parse_control_archive(deb, prefix)
    name = spec["name"]
    require(fields["Package"] == name and fields["Version"] == spec["version"] and fields["Architecture"] == spec["architecture"], "DEB_IDENTITY_NOT_ALLOWLISTED", name)
    require(spec["licenseExpression"] == EXPECTED_LICENSES[name], "LICENSE_EXPRESSION_NOT_ALLOWLISTED", name)
    proc = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(deb)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    paths: set[str] = set()
    license_paths: set[str] = set()
    git_executable_present = False
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
                    if name == "git" and path == prefix + "/bin/git" and (member.mode & 0o111):
                        git_executable_present = True
                    if path.startswith(prefix + "/share/doc/" + name + "/copyright"):
                        license_paths.add(path)
                    continue
                require(member.isdir() or member.isreg(), "PAYLOAD_MEMBER_TYPE_REJECTED", name + ":" + path)
                if name == "git" and path == prefix + "/bin/git" and member.isreg() and (member.mode & 0o111):
                    git_executable_present = True
                if member.isdir():
                    continue
                stream = archive.extractfile(member)
                require(stream is not None, "PAYLOAD_MEMBER_UNREADABLE", name + ":" + path)
                content = stream.read(member.size + 1)
                require(len(content) == member.size, "PAYLOAD_MEMBER_SIZE_MISMATCH", name + ":" + path)
                scan_paths(content, prefix, name + ":" + path)
                if path.startswith(prefix + "/share/doc/" + name + "/copyright"):
                    license_paths.add(path)
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
    require(bool(license_paths), "LICENSE_EVIDENCE_MISSING", name)
    if name == "git":
        require(git_executable_present, "GIT_EXECUTABLE_MISSING_OR_NOT_EXECUTABLE")
    return {"name": name, "version": spec["version"], "architecture": spec["architecture"], "sha256": sha,
            "filename": deb.name, "licenseExpression": spec["licenseExpression"], "licenseEvidencePaths": sorted(license_paths),
            "licenseEvidenceKind": "pinned Termux source installer output; copyright file or prefix-contained shared-license symlink",
            "payloadEntries": count, "payloadBytes": total, "elf": elf_records,
            "depends": fields.get("Depends", ""), "preDepends": fields.get("Pre-Depends", ""),
            "recommends": fields.get("Recommends", ""), "maintainerScripts": sorted(set(controls) & {"preinst", "postinst", "prerm", "postrm", "config"})}


def audit(args: argparse.Namespace) -> dict[str, Any]:
    manifest = json.loads(args.package_set.read_text(encoding="utf-8"))
    require(manifest.get("schemaVersion") == 1 and manifest.get("channel") == "candidate-only", "PACKAGE_SET_NOT_CANDIDATE_ONLY")
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
    require(closure.get("profile") == "git-candidate" and closure.get("rootPackages") == ["git"] and closure.get("expectedPackageCount") == PINNED_PACKAGE_COUNT, "SOURCE_CLOSURE_NOT_ALLOWLISTED")
    require(isinstance(specs, list) and len(specs) == PINNED_PACKAGE_COUNT, "PACKAGE_SET_COUNT_NOT_ALLOWLISTED")
    names = [x.get("name") for x in specs]
    require(len(set(names)) == PINNED_PACKAGE_COUNT and set(names) == set(EXPECTED_LICENSES), "PACKAGE_NAMES_NOT_EXACT")
    require([x["name"] for x in specs] == sorted(names), "PACKAGE_SET_NOT_SORTED")
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
    with tempfile.TemporaryDirectory(prefix="aib-git-audit-") as td:
        temp = pathlib.Path(td)
        for spec in specs:
            result = audit_one(file_by_name[spec["name"]], spec, prefix, temp)
            all_results.append(result)
            for elf in result["elf"]:
                all_elf.append({**elf, "package": spec["name"]})
    providers: set[str] = set(PLATFORM_LIBS)
    for item in all_elf:
        if item["soname"]:
            providers.add(item["soname"])
    for item in all_elf:
        for library in item["needed"]:
            require(library in providers, "ELF_NEEDED_LIBRARY_UNPROVEN", item["package"] + ":" + item["path"] + ":" + library)
    return {"schemaVersion": 1, "ok": True, "status": "static-audit-passed; installation-and-device-runtime-unverified",
            "applicationId": APP_ID, "prefix": prefix, "prefixProvenance": "ci-model-only; device-observation-not-run",
            "sourceCommit": SOURCE_COMMIT, "builderImage": BUILDER_IMAGE, "sourceClosureProfile": "git-candidate",
            "restrictedAppArmorProfileSha256": source["restrictedAppArmorProfileSha256"],
            "sourceClosurePackageCount": PINNED_PACKAGE_COUNT, "sourceClosureDependencyAlternativeCount": closure["expectedDependencyAlternativeCount"],
            "candidatePackageCount": len(all_results), "packages": all_results,
            "elfProviders": sorted(providers), "elfCount": len(all_elf), "deviceInstall": "NOT RUN", "rollback": "NOT RUN"}


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
        print("GIT_CANDIDATE_STATIC_AUDIT_OK packages={} elf={} app_private_prefix=1 device_install=NOT_RUN".format(report["candidatePackageCount"], report["elfCount"]))
        return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print("GIT_CANDIDATE_STATIC_AUDIT_REJECTED:" + (str(exc) if isinstance(exc, AuditError) else "INPUT_INVALID"), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
