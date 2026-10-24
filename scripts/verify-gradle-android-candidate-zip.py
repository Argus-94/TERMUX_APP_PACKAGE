#!/usr/bin/env python3
"""Strictly verify the Gradle test-only candidate artifact as uploaded by Actions."""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from typing import Any

MAX_MEMBERS = 20_000
MAX_TOTAL = 2 * 1024**3
MAX_FILE = 1024**3
KEY_NAME = "aibuilder-termux-feed-keyring.gpg"


class Invalid(ValueError):
    pass


def need(ok: bool, message: str) -> None:
    if not ok:
        raise Invalid(message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def safe_path(name: str) -> PurePosixPath:
    need(name and "\\" not in name, "archive path is empty or contains a backslash")
    p = PurePosixPath(name)
    need(not p.is_absolute() and p.as_posix() == name
         and all(part not in ("", ".", "..") for part in name.split("/")),
         "archive path is absolute, noncanonical, or traverses")
    return p


def inspect_zip(path: Path) -> dict[str, bytes]:
    found: dict[str, bytes] = {}
    total = 0
    try:
        with zipfile.ZipFile(path, "r") as archive:
            infos = archive.infolist()
            need(len(infos) <= MAX_MEMBERS, "ZIP member count exceeds bound")
            for info in infos:
                name = info.filename
                safe_path(name)
                need(not info.is_dir(), "ZIP directory entries are forbidden")
                need(name not in found, "duplicate ZIP path")
                need(not (info.flag_bits & 0x1), "encrypted ZIP entries are forbidden")
                need(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                     "unsupported ZIP compression method")
                mode = (info.external_attr >> 16) & 0xFFFF
                kind = stat.S_IFMT(mode)
                need(kind in (0, stat.S_IFREG), "ZIP links or non-regular entries are forbidden")
                need(0 <= info.file_size <= MAX_FILE, "ZIP member exceeds size bound")
                total += info.file_size
                need(total <= MAX_TOTAL, "ZIP expanded size exceeds bound")
                with archive.open(info, "r") as stream:
                    chunks: list[bytes] = []
                    size = 0
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        need(size <= info.file_size and size <= MAX_FILE, "ZIP member expanded beyond declared size")
                        chunks.append(chunk)
                need(size == info.file_size, "truncated ZIP member")
                found[name] = b"".join(chunks)
    except (OSError, zipfile.BadZipFile, RuntimeError, EOFError) as exc:
        raise Invalid("invalid candidate ZIP archive") from exc
    names = set(found)
    for name in names:
        parts = name.split("/")
        for i in range(1, len(parts)):
            need("/".join(parts[:i]) not in names, "ZIP file is ancestor of another path")
    return found


def inspect_pax_tar(raw: bytes) -> dict[str, bytes]:
    found: dict[str, bytes] = {}
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            need(archive.format == tarfile.PAX_FORMAT, "signed feed archive is not PAX tar")
            for i, member in enumerate(archive):
                need(i < MAX_MEMBERS, "PAX member count exceeds bound")
                name = member.name
                safe_path(name)
                need(member.isfile(), "PAX links, directories, and special entries are forbidden")
                need(name not in found, "duplicate PAX path")
                need(0 <= member.size <= MAX_FILE, "PAX member exceeds size bound")
                total += member.size
                need(total <= MAX_TOTAL, "PAX expanded size exceeds bound")
                stream = archive.extractfile(member)
                need(stream is not None, "cannot read PAX member")
                body = stream.read(MAX_FILE + 1)
                need(len(body) == member.size, "truncated PAX member")
                found[name] = body
    except (OSError, tarfile.TarError, EOFError) as exc:
        raise Invalid("invalid PAX signed-feed archive") from exc
    names = set(found)
    for name in names:
        parts = name.split("/")
        for i in range(1, len(parts)):
            need("/".join(parts[:i]) not in names, "PAX file is ancestor of another path")
    return found


def load_json_bytes(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise Invalid("invalid JSON: " + label) from exc
    need(isinstance(value, dict), "JSON root is not an object: " + label)
    return value


def parse_packages(raw: bytes) -> list[dict[str, str]]:
    try:
        text = raw.decode("utf-8")
    except UnicodeError as exc:
        raise Invalid("Packages index is not UTF-8") from exc
    records: list[dict[str, str]] = []
    for stanza in re.split(r"\n\s*\n", text.strip()):
        if not stanza:
            continue
        fields: dict[str, str] = {}
        previous: str | None = None
        for line in stanza.splitlines():
            if line[:1].isspace():
                need(previous is not None, "orphan Packages continuation")
                fields[previous] += "\n" + line
                continue
            key, sep, value = line.partition(":")
            need(bool(sep) and bool(key) and key not in fields, "malformed or duplicate Packages field")
            fields[key] = value.lstrip()
            previous = key
        required = ("Package", "Version", "Architecture", "Filename", "Size", "SHA256")
        need(all(key in fields for key in required), "Packages record lacks required fields")
        need(re.fullmatch(r"[0-9]+", fields["Size"]) is not None
             and re.fullmatch(r"[0-9a-f]{64}", fields["SHA256"]) is not None,
             "invalid Packages size or digest")
        records.append(fields)
    return records


def verify_gpg(data: bytes, keyring: Path, fingerprint: str, *, signature: bytes | None = None,
               cleartext: bool = False) -> bytes | None:
    with tempfile.TemporaryDirectory(prefix="candidate-gpgv-") as td:
        root = Path(td)
        payload = root / "payload"
        payload.write_bytes(data)
        args = ["gpgv", "--homedir", str(root), "--keyring", str(keyring), "--status-fd", "1"]
        plain: Path | None = None
        if cleartext:
            plain = root / "cleartext"
            args += ["--output", str(plain), str(payload)]
        else:
            need(signature is not None, "detached signature is missing")
            sig = root / "signature.asc"
            sig.write_bytes(signature)
            args += [str(sig), str(payload)]
        try:
            result = subprocess.run(args, check=True, text=True, capture_output=True, timeout=60)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise Invalid("GPG signature verification failed") from exc
        fingerprints = re.findall(r"\[GNUPG:\] VALIDSIG ([0-9A-F]+)", result.stdout + result.stderr)
        need(bool(fingerprints) and all(item == fingerprint for item in fingerprints),
             "GPG signing fingerprint mismatch")
        return plain.read_bytes() if plain else None


def sha256_sums(data: bytes, members: dict[str, bytes], expected_names: set[str]) -> None:
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeError as exc:
        raise Invalid("SHA256SUMS is not UTF-8") from exc
    actual: dict[str, str] = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9_./:%+@=-]+)", line)
        need(match is not None, "malformed SHA256SUMS entry")
        digest, name = match.groups()
        safe_path(name)
        need(name not in actual, "duplicate SHA256SUMS path")
        actual[name] = digest
    need(set(actual) == expected_names, "SHA256SUMS does not exactly cover signed bundle files")
    need(all(actual[name] == sha(members[name]) for name in actual), "SHA256SUMS digest mismatch")


def verify_feed(feed: dict[str, bytes], manifest: dict[str, Any], keyring: Path,
                fingerprint: str, lock: dict[str, Any], members: dict[str, bytes]) -> tuple[list[dict[str, str]], dict[tuple[str, str, str], bytes]]:
    spec = manifest.get("signedFeedArchive")
    need(isinstance(spec, dict) and spec.get("path") == "signed-feed.tar", "signed feed archive metadata is invalid")
    rows = spec.get("files")
    need(isinstance(rows, list), "signed feed file inventory is missing")
    expected: dict[str, tuple[int, str]] = {}
    for row in rows:
        need(isinstance(row, dict), "signed feed inventory row is invalid")
        name = str(row.get("path", ""))
        safe_path(name)
        need(name not in expected and isinstance(row.get("sizeBytes"), int)
             and re.fullmatch(r"[0-9a-f]{64}", str(row.get("sha256", ""))) is not None,
             "signed feed inventory row is duplicated or malformed")
        expected[name] = (row["sizeBytes"], row["sha256"])
    need(set(feed) == set(expected), "PAX feed files differ from the signed bundle inventory")
    need(all(len(feed[name]) == size and sha(feed[name]) == digest for name, (size, digest) in expected.items()),
         "PAX feed file size or digest mismatch")
    need(manifest.get("feedPackageCount") == 83 and spec.get("fileCount") == len(feed),
         "feed package/file count mismatch")
    need(spec.get("sha256") == sha(members["signed-feed.tar"]), "PAX archive digest differs from manifest")

    release_name = "dists/stable/Release"
    inrelease_name = "dists/stable/InRelease"
    detached_name = "dists/stable/Release.gpg"
    release = feed.get(release_name)
    need(release is not None and feed.get("Release") == release, "signed feed Release copies differ")
    need(inrelease_name in feed and detached_name in feed, "signed feed signatures are missing")
    plain = verify_gpg(feed[inrelease_name], keyring, fingerprint, cleartext=True)
    need(plain == release, "InRelease cleartext differs from Release")
    verify_gpg(release, keyring, fingerprint, signature=feed[detached_name])

    base = "dists/stable/main/binary-aarch64/"
    index_path = base + "Packages"
    gz_path = base + "Packages.gz"
    need(index_path in feed and gz_path in feed, "signed feed package indexes are missing")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(feed[gz_path])) as stream:
            need(stream.read(len(feed[index_path]) + 1) == feed[index_path], "Packages.gz differs from Packages")
    except (OSError, EOFError) as exc:
        raise Invalid("invalid Packages.gz") from exc
    try:
        release_text = release.decode("utf-8")
    except UnicodeError as exc:
        raise Invalid("Release is not UTF-8") from exc
    release_hashes: dict[str, tuple[str, int]] = {}
    in_section = False
    for line in release_text.splitlines():
        if line == "SHA256:":
            in_section = True
            continue
        if in_section:
            if line and not line[0].isspace():
                in_section = False
                continue
            match = re.fullmatch(r"\s+([0-9a-f]{64})\s+([0-9]+)\s+(\S+)\s*", line)
            need(match is not None, "malformed Release SHA256 entry")
            digest, size, name = match.groups()
            need(name not in release_hashes, "duplicate Release path")
            release_hashes[name] = (digest, int(size))
    for name in (index_path, gz_path):
        need(release_hashes.get(name) == (sha(feed[name]), len(feed[name])),
             "Release index digest or size mismatch: " + name)

    records = parse_packages(feed[index_path])
    need(len(records) == 83, "signed feed does not contain exactly 83 package records")
    packages: dict[tuple[str, str, str], bytes] = {}
    expected_debs = {name for name in feed if name.startswith("pool/") and name.endswith(".deb")}
    need(len(expected_debs) == 83, "signed feed does not contain exactly 83 package files")
    indexed: set[str] = set()
    for row in records:
        identity = (row["Package"], row["Version"], row["Architecture"])
        need(identity not in packages, "duplicate package identity in Packages")
        rel = safe_path(row["Filename"]).as_posix()
        need(rel in expected_debs and rel not in indexed, "Packages Filename is not an exact retained pool path")
        body = feed[rel]
        need(int(row["Size"]) == len(body) and row["SHA256"] == sha(body),
             "Packages size or SHA256 differs from retained package")
        with tempfile.NamedTemporaryFile(prefix="candidate-deb-", suffix=".deb") as tmp:
            Path(tmp.name).write_bytes(body)
            try:
                result = subprocess.run(["dpkg-deb", "-f", tmp.name, "Package", "Version", "Architecture"],
                                        check=True, capture_output=True, text=True, timeout=60)
            except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                raise Invalid("dpkg-deb metadata inspection failed") from exc
        fields = dict(line.split(": ", 1) for line in result.stdout.splitlines() if ": " in line)
        need(tuple(fields.get(k) for k in ("Package", "Version", "Architecture")) == identity,
             "retained .deb control identity differs from Packages")
        indexed.add(rel)
        packages[identity] = body
    need(indexed == expected_debs, "Packages does not enumerate the exact signed feed pool")

    base_lock = lock.get("base82Cohort", {})
    base_manifest = load_json_bytes(members["metadata/base82-aggregate-manifest.json"], "base82 manifest")
    need(sha(members["metadata/base82-aggregate-manifest.json"]) == base_lock.get("embeddedManifestSha256"),
         "base82 manifest hash differs from immutable input lock")
    inventory = load_json_bytes(members["metadata/aggregate-archive-inventory.json"], "base82 archive inventory")
    need(sha(members["metadata/aggregate-archive-inventory.json"]) == base_lock.get("inventorySha256"),
         "base82 archive inventory hash differs from immutable input lock")
    need(inventory.get("aggregateRunId") == str(base_lock.get("aggregateRunId"))
         and inventory.get("archiveSha256") == base_lock.get("archiveSha256")
         and inventory.get("archiveFile") == base_lock.get("archiveFilename")
         and inventory.get("regularFileCount") == 426 and len(inventory.get("files", {})) == 426
         and inventory.get("productionAllowed") is False and inventory.get("qualified") is False,
         "base82 inventory provenance or closed gates mismatch")
    need(base_manifest.get("sourceCommit") == lock.get("termuxBuilder", {}).get("sourceCommit"),
         "signed base82 manifest source commit differs from immutable input lock")
    base_meta = load_json_bytes(members["metadata/base82-signed-feed/keys/feed-signing.json"],
                                "base82 signing metadata")
    base_fingerprint = str(base_meta.get("fingerprint", "")).replace(" ", "").upper()
    need(base_fingerprint == str(base_lock.get("signingFingerprint", "")).replace(" ", "").upper(),
         "base82 signing fingerprint differs from input lock")
    base_key_rel = str(base_meta.get("publicKeyring", ""))
    safe_path(base_key_rel)
    base_key_bytes = members.get("metadata/base82-signed-feed/" + base_key_rel)
    need(base_key_bytes is not None and sha(base_key_bytes) == base_lock.get("publicKeyringSha256")
         and base_meta.get("publicKeyringSha256") == base_lock.get("publicKeyringSha256"),
         "base82 public keyring differs from input lock")
    with tempfile.TemporaryDirectory(prefix="candidate-base-key-") as td:
        base_key = Path(td) / KEY_NAME
        base_key.write_bytes(base_key_bytes)
        base_prefix = "metadata/base82-signed-feed/"
        base_manifest_sig = members[base_prefix + "aggregate-manifest.json.asc"]
        verify_gpg(members["metadata/base82-aggregate-manifest.json"], base_key, base_fingerprint,
                   signature=base_manifest_sig)
        base_release = members[base_prefix + "dists/stable/Release"]
        need(members[base_prefix + "dists/stable/InRelease"] == members[base_prefix + "dists/stable/InRelease"],
             "base82 InRelease missing")
        base_plain = verify_gpg(members[base_prefix + "dists/stable/InRelease"], base_key,
                                base_fingerprint, cleartext=True)
        need(base_plain == base_release, "base82 InRelease cleartext differs from Release")
        verify_gpg(base_release, base_key, base_fingerprint,
                   signature=members[base_prefix + "dists/stable/Release.gpg"])
    base_records = base_manifest.get("packages")
    need(isinstance(base_records, list) and len(base_records) == 82
         and base_manifest.get("qualified") is False and base_manifest.get("productionAllowed") is False,
         "signed base82 manifest package count or gates mismatch")
    base_index = members["metadata/base82-signed-feed/dists/stable/main/binary-aarch64/Packages"]
    base_index_gz = members["metadata/base82-signed-feed/dists/stable/main/binary-aarch64/Packages.gz"]
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(base_index_gz)) as stream:
            need(stream.read(len(base_index) + 1) == base_index, "base82 Packages.gz differs from Packages")
        base_release_text = base_release.decode("utf-8")
    except (OSError, EOFError, UnicodeError) as exc:
        raise Invalid("invalid base82 signed feed metadata") from exc
    for name, body in (("main/binary-aarch64/Packages", base_index),
                       ("main/binary-aarch64/Packages.gz", base_index_gz)):
        pattern = (r"(?m)^\s+" + re.escape(sha(body)) + r"\s+" + str(len(body))
                   + r"\s+" + re.escape(name) + r"$")
        need(re.search(pattern, base_release_text) is not None,
             "base82 Release does not authenticate package index: " + name)
    base_rows = parse_packages(base_index)
    need(len(base_rows) == 82, "signed base82 Packages count mismatch")
    manifest_by_id: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in base_records:
        need(isinstance(row, dict), "base82 manifest package row is invalid")
        ident = (str(row.get("name", "")), str(row.get("version", "")), str(row.get("architecture", "")))
        need(all(ident) and ident not in manifest_by_id
             and re.fullmatch(r"[0-9a-f]{64}", str(row.get("sha256", ""))) is not None,
             "base82 manifest package identity or hash is invalid")
        manifest_by_id[ident] = row
    base_index_by_id = {(r["Package"], r["Version"], r["Architecture"]): r for r in base_rows}
    need(len(base_index_by_id) == 82 and set(base_index_by_id) == set(manifest_by_id),
         "signed base82 Packages identities differ from signed manifest")
    for ident, row in manifest_by_id.items():
        base_row = base_index_by_id[ident]
        filename = str(row.get("filename", ""))
        need(PurePosixPath(base_row["Filename"]).name == filename
             and base_row["SHA256"] == row["sha256"], "base82 index and manifest package mismatch")
        final = packages.get(ident)
        need(final is not None and sha(final) == row["sha256"] and len(final) == int(base_row["Size"]),
             "final test feed changed a signed base82 package: " + ident[0])
    need(len(packages) == 83 and manifest.get("base82Unchanged") is True,
         "final feed does not preserve all 82 base packages plus one candidate")
    return records, packages


def verify_candidate_zip(archive: Path, repository: str, commit: str, run_id: str, fingerprint: str,
                         repo_root: Path, outdir: Path, report: Path) -> None:
    need(repository == "Argus-94/TERMUX_APP_PACKAGE", "repository mismatch")
    need(re.fullmatch(r"[0-9a-f]{40}", commit or "") is not None
         and re.fullmatch(r"[0-9]+", str(run_id)) is not None, "invalid commit or workflow run id")
    need(re.fullmatch(r"[0-9A-F]{40,64}", fingerprint or "") is not None,
         "external fingerprint must be uppercase hexadecimal")
    members = inspect_zip(archive)
    fixed = {"bundle-manifest.json", "provenance.json", "provenance.json.asc", "SHA256SUMS", "SHA256SUMS.asc",
             "signed-feed.tar", "public-key/" + KEY_NAME, "public-key/feed-signing.json",
             "metadata/gradle-android-package-candidate-inputs.json", "metadata/base82-aggregate-manifest.json",
             "metadata/aggregate-archive-inventory.json", "metadata/base82-signed-feed/aggregate-manifest.json.asc",
             "metadata/base82-signed-feed/keys/feed-signing.json",
             "metadata/base82-signed-feed/keys/" + KEY_NAME,
             "metadata/base82-signed-feed/dists/stable/Release",
             "metadata/base82-signed-feed/dists/stable/InRelease",
             "metadata/base82-signed-feed/dists/stable/Release.gpg",
             "metadata/base82-signed-feed/dists/stable/main/binary-aarch64/Packages",
             "metadata/base82-signed-feed/dists/stable/main/binary-aarch64/Packages.gz",
             "reports/build-result.json", "reports/package-audit.json", "reports/feed-validation.json",
             "reports/apt-simulation-proof.json", "reports/apt-simulation-plan.log",
             "candidate-package/"}
    required_prefixes = ("candidate-package/", "distribution/", "metadata/", "public-key/", "reports/",
                         "source-artifacts/")
    need(fixed - {"candidate-package/"} <= set(members), "required candidate evidence is missing")
    for name in members:
        safe_path(name)
        need(name not in ("SHA256SUMS", "SHA256SUMS.asc", "provenance.json", "provenance.json.asc",
                          "bundle-manifest.json") or name in fixed,
             "unexpected root metadata path")
        need(name == "bundle-manifest.json" or name in fixed or name.startswith(required_prefixes),
             "unexpected candidate bundle path: " + name)
        low = name.lower()
        need("gnupg" not in low and "private-key" not in low and "secret-key" not in low
             and "secring" not in low and not low.endswith((".pem", ".p12", ".pfx")),
             "private signing material path is forbidden")

    manifest = load_json_bytes(members["bundle-manifest.json"], "bundle manifest")
    need(manifest.get("schemaVersion") == 2
         and manifest.get("classification") == "SHORT_RETENTION_TEST_ONLY_CANDIDATE_EVIDENCE",
         "candidate manifest schema or classification mismatch")
    need(manifest.get("repository") == repository
         and manifest.get("branch") == "work/bootstrap-compatibility-20261019"
         and manifest.get("repositoryCommit") == commit
         and str(manifest.get("workflowRunId")) == str(run_id),
         "bundle repository, branch, commit, or run linkage mismatch")
    need(manifest.get("feedSigningFingerprint") == fingerprint,
         "bundle manifest signing fingerprint mismatch")
    need(manifest.get("base82Unchanged") is True and manifest.get("feedPackageCount") == 83
         and manifest.get("androidDeviceRuntime") == "NOT_RUN" and manifest.get("aptSimulation") == "PASS; simulated only; no install"
         and manifest.get("candidateEligible") is False and manifest.get("qualified") is False
         and manifest.get("productionAllowed") is False and manifest.get("privateSigningMaterialIncluded") is False,
         "candidate-only gates are not closed")
    inventory = manifest.get("files")
    need(isinstance(inventory, list) and manifest.get("fileCount") == len(inventory),
         "bundle file inventory count mismatch")
    expected_files: dict[str, tuple[int, str]] = {}
    for row in inventory:
        need(isinstance(row, dict), "bundle file inventory row is invalid")
        name = str(row.get("path", ""))
        safe_path(name)
        need(name not in expected_files and isinstance(row.get("sizeBytes"), int)
             and re.fullmatch(r"[0-9a-f]{64}", str(row.get("sha256", ""))) is not None,
             "bundle file inventory row is duplicated or malformed")
        expected_files[name] = (row["sizeBytes"], row["sha256"])
    signed_meta = {"bundle-manifest.json", "provenance.json", "provenance.json.asc", "SHA256SUMS", "SHA256SUMS.asc"}
    need(set(members) == set(expected_files) | signed_meta,
         "ZIP members do not exactly match the signed bundle inventory")
    need(all(name in members and len(members[name]) == size and sha(members[name]) == digest
             for name, (size, digest) in expected_files.items()), "bundle manifest file hash mismatch")
    need(manifest.get("inputLockSha256") == sha(members["metadata/gradle-android-package-candidate-inputs.json"]),
         "input lock hash differs from bundle manifest")

    keymeta = load_json_bytes(members["public-key/feed-signing.json"], "ephemeral feed signing metadata")
    actual = str(keymeta.get("fingerprint", "")).replace(" ", "").upper()
    key_bytes = members["public-key/" + KEY_NAME]
    need(actual == fingerprint and keymeta.get("status") == "ephemeral-only; no production feed publication"
         and keymeta.get("publicKeyringSha256") == sha(key_bytes), "ephemeral signing key metadata mismatch")
    lock = load_json_bytes(members["metadata/gradle-android-package-candidate-inputs.json"], "candidate input lock")
    need(lock.get("repository") == repository and lock.get("branch") == manifest.get("branch")
         and lock.get("package") == manifest.get("package")
         and manifest.get("applicationId") == lock.get("applicationId"),
         "immutable input lock differs from candidate manifest")
    package_lock = lock["package"]
    root = repo_root.resolve()
    head = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], check=True,
                          capture_output=True, text=True).stdout.strip()
    need(head == commit, "pinned checkout HEAD differs from --commit")
    tracked_status = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"],
                                    check=True, capture_output=True, text=True).stdout
    need(not tracked_status.strip(), "pinned checkout has modified tracked files")
    pinned_lock = root / "gradle-android-package-candidate-inputs.json"
    need(pinned_lock.is_file() and not pinned_lock.is_symlink()
         and file_sha(pinned_lock) == manifest["inputLockSha256"],
         "archived input lock differs from pinned checkout")

    keyring_path: Path
    with tempfile.TemporaryDirectory(prefix="candidate-verify-keys-") as td:
        keyring_path = Path(td) / KEY_NAME
        keyring_path.write_bytes(key_bytes)
        sums = members["SHA256SUMS"]
        signed_names = set(expected_files) | {"bundle-manifest.json", "provenance.json", "provenance.json.asc"}
        sha256_sums(sums, members, signed_names)
        verify_gpg(sums, keyring_path, fingerprint, signature=members["SHA256SUMS.asc"])
        provenance_bytes = members["provenance.json"]
        verify_gpg(provenance_bytes, keyring_path, fingerprint, signature=members["provenance.json.asc"])
        provenance = load_json_bytes(provenance_bytes, "signed provenance")
        need(provenance.get("schemaVersion") == 1
             and provenance.get("classification") == "SHORT_RETENTION_TEST_ONLY_CANDIDATE_EVIDENCE"
             and provenance.get("repository") == repository and provenance.get("branch") == manifest.get("branch")
             and provenance.get("repositoryCommit") == commit and str(provenance.get("workflowRunId")) == str(run_id),
             "signed provenance repository, commit, or run linkage mismatch")
        need(provenance.get("manifest") == "bundle-manifest.json"
             and provenance.get("manifestSha256") == sha(members["bundle-manifest.json"])
             and provenance.get("inputLock") == "metadata/gradle-android-package-candidate-inputs.json"
             and provenance.get("inputLockSha256") == manifest["inputLockSha256"],
             "signed provenance manifest or input-lock hash mismatch")
        need(provenance.get("feedSigningFingerprint") == fingerprint
             and provenance.get("packageCount") == 83 and provenance.get("installed") is False
             and provenance.get("androidDeviceRuntime") == "NOT_RUN"
             and provenance.get("candidateEligible") is False and provenance.get("qualified") is False
             and provenance.get("productionAllowed") is False,
             "signed provenance has invalid package count or open qualification gates")
        builder = str(lock.get("termuxBuilder", {}).get("builderImage", ""))
        source_commit = str(lock.get("termuxBuilder", {}).get("sourceCommit", ""))
        need("@sha256:" in builder and provenance.get("builderImageDigest") == builder
             and provenance.get("sourceCommit") == source_commit,
             "signed provenance source or digest-pinned builder mismatch")
        build = load_json_bytes(members["reports/build-result.json"], "build result")
        audit = load_json_bytes(members["reports/package-audit.json"], "package audit")
        feed_report = load_json_bytes(members["reports/feed-validation.json"], "feed validation")
        apt = load_json_bytes(members["reports/apt-simulation-proof.json"], "APT simulation proof")
        need(build.get("status") == "package-built-and-static-audits-passed-test-only"
             and build.get("installed") is False and build.get("aptSimulation") == "NOT_RUN"
             and build.get("sourceCommit") == source_commit and build.get("builderImageRef") == builder
             and build.get("productionAllowed") is False and build.get("qualified") is False,
             "build report status or provenance mismatch")
        need(audit.get("result") == "GRADLE_AARCH64_DEB_STATIC_AUDIT_PASS_TEST_ONLY"
             and audit.get("installed") is False and audit.get("productionAllowed") is False
             and audit.get("qualified") is False, "package audit gates are not closed")
        need(feed_report.get("result") == "GRADLE_SEPARATE_TEST_FEED_PASS_82_BASE_PACKAGES_UNCHANGED_PLUS_ONE"
             and feed_report.get("feedPackageCount") == 83
             and feed_report.get("ephemeralSigningFingerprint", "").replace(" ", "").upper() == fingerprint
             and feed_report.get("ephemeralSigningPublicKeyringSha256") == sha(key_bytes)
             and feed_report.get("reservedProductionSigningFingerprintNotUsed") is True
             and feed_report.get("privateKeyRetained") is False
             and feed_report.get("base82PackagesUnchanged") is True
             and feed_report.get("base82PackageCount") == 82
             and feed_report.get("base82ArchiveSha256") == lock["base82Cohort"]["archiveSha256"]
             and feed_report.get("productionAllowed") is False,
             "signed feed report mismatch")
        need(apt.get("result") == "APT_SIGNATURE_DOWNLOAD_SIMULATION_PASS_TEST_ONLY"
             and apt.get("aptGetUpdateSignatureAndHashes") == "PASS"
             and apt.get("aptGetSimulatedInstall") == "PASS"
             and apt.get("installPerformed") is False and apt.get("rollbackPerformed") is False
             and apt.get("reservedProductionSigningKeyUsed") is False
             and apt.get("productionAllowed") is False and apt.get("qualified") is False,
             "APT simulation proof is invalid or opens a closed gate")
        plan = members["reports/apt-simulation-plan.log"]
        need(apt.get("aptSimulationPlanSha256") == sha(plan), "APT simulation plan hash mismatch")
        need(apt.get("requestedRootDownloadsVerified") == 2 and apt.get("feedPackageCount") == 83,
             "APT simulation proof roots or feed count mismatch")
        expected_roots = [f"{package_lock['name']}={package_lock['version']}",
                          f"openjdk-17={package_lock['expectedJdk17Version']}"]
        need(apt.get("requestedRoots") == expected_roots
             and apt.get("simulatedInstallPlanPackageCount") == len(apt.get("simulatedInstallPlan", [])),
             "APT proof requested roots or simulated plan count mismatch")
        apt_plan_rows = apt.get("simulatedInstallPlan", [])
        apt_names = [item.get("name") for item in apt_plan_rows if isinstance(item, dict)]
        need(len(apt_names) == len(apt_plan_rows) and len(set(apt_names)) == len(apt_names)
             and {"gradle", "openjdk-17"} <= set(apt_names), "APT simulated plan identities are invalid")
        need(feed_report.get("aptProofSha256") == sha(members["reports/apt-simulation-proof.json"])
             and feed_report.get("aptSimulationPlanSha256") == sha(plan)
             and feed_report.get("aptSimulationPlanPackageCount") == len(apt_plan_rows),
             "feed validation does not bind the exact APT proof and plan")
        marker = "APT_CANDIDATE_DOWNLOAD_AND_SIMULATED_INSTALL_OK package=gradle version=1:9.8.2 arch=aarch64 roots=2 signed_by=1 install_performed=0 rollback_performed=0"
        need(marker.encode() in members["reports/apt-simulation.log"]
             and b"Remv " not in plan and apt.get("successMarker") == marker,
             "APT simulation log marker or no-removals invariant mismatch")
        package_spec = manifest.get("candidatePackageArtifact", {})
        candidate_path = str(package_spec.get("path", ""))
        safe_path(candidate_path)
        original_name = f"{package_lock['name']}_{package_lock['version']}_{package_lock['architecture']}.deb"
        expected_path = "candidate-package/" + original_name.replace(":", "%3a")
        candidate_paths = [name for name in members if name.startswith("candidate-package/") and name.endswith(".deb")]
        need(candidate_path == expected_path and candidate_paths == [candidate_path]
             and package_spec.get("originalDebFilename") == original_name
             and package_spec.get("filenameColonEscapedAs") == "%3a",
             "candidate package filename/path is not the exact locked package")
        need(candidate_path in members and package_spec.get("sha256") == sha(members[candidate_path])
             and provenance.get("packageSha256") == package_spec.get("sha256")
             and build.get("packageSha256") == package_spec.get("sha256")
             and audit.get("packageSha256") == package_spec.get("sha256"),
             "Gradle candidate package hash chain mismatch")
        need(manifest.get("package") == package_lock, "candidate package identity differs from input lock")
        need(provenance.get("package") == package_lock, "signed provenance package identity mismatch")
        records, feed_packages = verify_feed(inspect_pax_tar(members["signed-feed.tar"]), manifest,
                                             keyring_path, fingerprint, lock, members)
        candidate_identity = (package_lock["name"], package_lock["version"], package_lock["architecture"])
        need(candidate_identity in feed_packages and feed_packages[candidate_identity] == members[candidate_path],
             "candidate package bytes are not the package signed in the test feed")
        need(len(records) == 83, "signed feed record count mismatch")

    if outdir.exists():
        raise Invalid("output directory must not already exist")
    outdir.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".candidate-verify-", dir=str(outdir.parent)))
    try:
        for name, body in members.items():
            target = stage.joinpath(*safe_path(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        stage.rename(outdir)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    result = {
        "valid": True,
        "format": "GitHub Actions ZIP containing a signed PAX feed archive",
        "productionAllowed": False,
        "qualified": False,
        "candidateEligible": False,
        "android": "NOT_RUN",
        "fingerprint": fingerprint,
        "feedPackageCount": 83,
        "base82Unchanged": True,
        "archiveSha256": file_sha(archive),
        "repositoryCommit": commit,
        "workflowRunId": str(run_id),
        "sourceCommit": source_commit,
        "builderImageDigest": builder,
        "manifestSha256": sha(members["bundle-manifest.json"]),
        "signedInputValidated": True,
        "signedProvenanceValidated": True,
        "aptSimulation": "PASS; simulated only; no install",
        "installPerformed": False,
    }
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
