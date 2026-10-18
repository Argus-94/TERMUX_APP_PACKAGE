#!/usr/bin/env python3
"""Stage validated candidate build evidence; never follow symlinks or retain signing secrets."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import tarfile
from pathlib import Path

METADATA = {"InRelease", "Release", "Release.gpg", "Packages", "Packages.gz"}
PUBLIC_KEY = "aibuilder-termux-feed-keyring.gpg"
PUBLIC_META = "feed-signing.json"


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_path(path):
    """Require every existing component to be a real non-symlink, non-special path."""
    path = Path(os.path.abspath(path))
    cur = Path(path.anchor)
    for part in path.parts[1:]:
        cur = cur / part
        if cur.is_symlink():
            raise ValueError(f"symlink path rejected: {cur}")
    return path


def regular(path):
    safe_path(path)
    if not path.is_file():
        raise ValueError(f"required regular file missing: {path}")
    return path


def manifest_packages(manifest):
    data = json.loads(regular(manifest).read_text(encoding="utf-8"))
    records = data.get("packages")
    if not isinstance(records, list) or not records:
        raise ValueError("manifest package allowlist missing")
    normalized = set()
    for p in records:
        try:
            name, version, arch = p["name"], p["version"], p["architecture"]
        except (TypeError, KeyError):
            raise ValueError("invalid package record")
        if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9+_.-]+", name)
                or not isinstance(arch, str) or not re.fullmatch(r"[A-Za-z0-9+_.-]+", arch)
                or not isinstance(version, str) or not re.fullmatch(r"[0-9][A-Za-z0-9.+:~_-]*", version)):
            raise ValueError("unsafe package identity")
        normalized.add((name, version, arch))
    if len(normalized) != len(records):
        raise ValueError("duplicate manifest package identities")
    return data, normalized


def deb_identity(path):
    try:
        result = subprocess.run(["dpkg-deb", "-f", str(path), "Package", "Version", "Architecture"],
                               check=True, text=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as e:
        raise ValueError(f"dpkg-deb identity inspection failed: {path}") from e
    fields = {}
    for line in result.stdout.splitlines():
        if ": " in line:
            k, v = line.split(": ", 1)
            fields[k] = v
    if not all(k in fields for k in ("Package", "Version", "Architecture")):
        raise ValueError(f"invalid dpkg-deb identity output: {path}")
    return fields["Package"], fields["Version"], fields["Architecture"]


def files_under(root):
    """Enumerate without following links; reject any symlink or non-regular entry."""
    safe_path(root)
    if not root.is_dir():
        raise ValueError(f"required directory missing: {root}")
    found = []
    for base, dirs, files in os.walk(root, followlinks=False):
        base = Path(base)
        for name in list(dirs) + list(files):
            p = base / name
            if p.is_symlink():
                raise ValueError(f"symlink rejected: {p}")
            if p.is_file():
                found.append(p)
            elif not p.is_dir():
                raise ValueError(f"special filesystem entry rejected: {p}")
    return found


def check_signature(feed, keyring, fingerprint):
    # Verify every present signature against only the staged public keyring; both forms required.
    inrelease = regular(feed / "dists/stable/InRelease")
    release = regular(feed / "dists/stable/Release")
    detached = regular(feed / "dists/stable/Release.gpg")
    with tempfile.TemporaryDirectory(prefix="candidate-gpg-verify-") as homedir:
      for args in (["gpgv", "--homedir", homedir, "--keyring", str(keyring), "--status-fd", "1", str(inrelease)],
                   ["gpgv", "--homedir", homedir, "--keyring", str(keyring), "--status-fd", "1", str(detached), str(release)]):
        try:
            r = subprocess.run(args, check=True, text=True, capture_output=True)
        except (OSError, subprocess.CalledProcessError) as e:
            raise ValueError("feed GPG signature verification failed") from e
        status = r.stdout + r.stderr
        if f"VALIDSIG {fingerprint}" not in status:
            raise ValueError("feed signature fingerprint mismatch")


def stage(output, feed, keyroot, manifest, destination, repo, runid, sha_commit,
          source_commit, builder, repository=None, source_closure=None):
    output, feed, keyroot, manifest, destination, repo = map(Path, (output, feed, keyroot, manifest, destination, repo))
    output, feed, keyroot, manifest, repo = map(safe_path, (output, feed, keyroot, manifest, repo))
    data, expected = manifest_packages(manifest)
    if source_commit != data.get("packages", [{}])[0].get("sourceCommit", source_commit):
        raise ValueError("SOURCE_COMMIT does not match manifest")
    if not re.fullmatch(r"[0-9a-f]{40}", str(sha_commit)) or not re.fullmatch(r"[0-9a-f]{40}", str(source_commit)):
        raise ValueError("invalid repository/source commit")
    if not builder or "@sha256:" not in builder:
        raise ValueError("BUILDER_IMAGE_REF must be digest-pinned")

    reports = {n: regular(output / n) for n in ("build-result.json", "audit-report.json", "app-private-properties.patch")}
    result = json.loads(reports["build-result.json"].read_text(encoding="utf-8"))
    audit = json.loads(reports["audit-report.json"].read_text(encoding="utf-8"))
    if result.get("status") != "audit-passed; device-runtime-test-not-run" or result.get("installed") is not False:
        raise ValueError("candidate build result is not a successful non-install build")
    if audit.get("ok") is not True or "audit-passed" not in audit.get("status", ""):
        raise ValueError("candidate audit report is not successful")
    if result.get("sourceCommit") != source_commit:
        raise ValueError("SOURCE_COMMIT disagrees with build report")
    if result.get("builderImageRef", result.get("builderImage")) != builder:
        raise ValueError("BUILDER_IMAGE_REF disagrees with build report")

    debdir = output / "packages"
    debs = files_under(debdir)
    if any(p.suffix != ".deb" for p in debs) or len(debs) != len(expected):
        expected_records = [dict(name=n, version=v, architecture=a) for n, v, a in sorted(expected)]
        found_names = sorted(p.name for p in debs)
        detail = json.dumps({"expectedCount": len(expected), "expectedIdentities": expected_records,
                             "foundCount": len(debs), "foundFilenames": found_names},
                            ensure_ascii=True, sort_keys=True)
        raise ValueError(f"package output mismatch: {detail}")
    identities = {deb_identity(p): p for p in debs}
    if set(identities) != expected:
        raise ValueError("package-set mismatch with manifest")
    if len(identities) != len(debs):
        raise ValueError("duplicate package identity")
    report_packages = result.get("packages")
    if report_packages is None:
        record = {"name": result.get("packageName"), "version": result.get("packageVersion"),
                  "architecture": result.get("packageArchitecture"), "file": result.get("packageFile"),
                  "sha256": result.get("packageSha256")}
        if len(expected) == 1:
            ident = next(iter(expected))
            record.update({k: record[k] or v for k, v in zip(("name", "version", "architecture"), ident)})
        report_packages = [record]
    records = {}
    for rec in report_packages:
        ident = (rec.get("name"), rec.get("version"), rec.get("architecture"))
        records[ident] = (rec.get("file", rec.get("filename", rec.get("packageFile"))), rec.get("sha256", rec.get("packageSha256")))
    if set(records) != expected:
        raise ValueError("build report package identities differ from manifest")
    for ident, p in identities.items():
        filename, digest = records[ident]
        if digest != sha(p) or filename != p.name:
            raise ValueError("build report package hash/name disagrees with candidate")

    pool = feed / "pool"
    pool_files = files_under(pool)
    if len(pool_files) != len(debs) or any(p.suffix != ".deb" for p in pool_files):
        raise ValueError("feed pool contains unexpected files or wrong package count")
    pool_by_identity = {deb_identity(p): p for p in pool_files}
    if set(pool_by_identity) != expected:
        raise ValueError("feed pool package-set mismatch")
    for ident, source in identities.items():
        if sha(source) != sha(pool_by_identity[ident]):
            raise ValueError("feed pool package hash differs from audited output")

    key = regular(keyroot / "keys" / PUBLIC_KEY)
    keymeta = regular(keyroot / "keys" / PUBLIC_META)
    fingerprint = json.loads(keymeta.read_text(encoding="utf-8")).get("fingerprint", "").replace(" ", "").upper()
    if not re.fullmatch(r"[0-9A-F]{40,64}", fingerprint):
        raise ValueError("invalid public-key fingerprint metadata")
    gpg_home = keyroot / "gnupg"
    # Do not enumerate gnupg at all: it can contain private keys and live sockets.
    # Root entries are restricted to the public keys directory, ephemeral GPG home,
    # and the exact harmless log emitted by key creation.
    allowed_root = {"keys", "gnupg", "gpg-generate.log"}
    if any(p.name not in allowed_root or p.is_symlink() for p in keyroot.iterdir()):
        raise ValueError("unexpected key-root file; private key material is never retained")
    if {p.name for p in (keyroot / "keys").iterdir()} != {PUBLIC_KEY, PUBLIC_META}:
        raise ValueError("public keys directory contains unexpected files")
    check_signature(feed, key, fingerprint)

    dists = feed / "dists"
    dist_files = files_under(dists)
    allowed_rel = {Path("stable/Release"), Path("stable/InRelease"), Path("stable/Release.gpg"),
                   Path("stable/main/binary-aarch64/Packages"), Path("stable/main/binary-aarch64/Packages.gz")}
    if {p.relative_to(dists) for p in dist_files} != allowed_rel:
        raise ValueError("unexpected or missing feed metadata")
    if not source_closure and (output / "source-closure.json").exists():
        source_closure = output / "source-closure.json"
    if source_closure:
        source_closure = regular(source_closure)
        closure = json.loads(source_closure.read_text())
        if (closure.get("sourceCommit") != source_commit or
                {p["name"] for p in closure.get("packages", [])} != {i[0] for i in expected}):
            raise ValueError("source closure does not match exact candidate package set")
    elif len(expected) > 1:
        raise ValueError("source closure required for multi-package candidate")

    safe_path(destination)
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            raise ValueError("unsafe destination")
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    bundle_packages = destination / "packages"
    bundle_packages.mkdir()
    for p in debs:
        shutil.copyfile(p, bundle_packages / p.name)
    bundle_reports = destination / "reports"
    bundle_reports.mkdir()
    for name in ("build-result.json", "audit-report.json", "app-private-properties.patch"):
        shutil.copyfile(reports[name], bundle_reports / name)
    if source_closure:
        shutil.copyfile(source_closure, bundle_reports / "source-closure.json")

    signed = destination / "signed-feed"
    for rel in ("dists/stable/Release", "dists/stable/InRelease", "dists/stable/Release.gpg"):
        src = feed / rel
        target = signed / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)
    for p in dist_files:
        if p.name in ("Packages", "Packages.gz"):
            target = signed / p.relative_to(feed)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, target)
    for p in pool_files:
        target = signed / p.relative_to(feed)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, target)
    pub = destination / "public-key"
    pub.mkdir()
    shutil.copyfile(key, pub / PUBLIC_KEY)
    shutil.copyfile(keymeta, pub / PUBLIC_META)
    shutil.copyfile(manifest, destination / manifest.name)

    metadata = destination / "input-metadata"
    metadata.mkdir()
    lock_hashes = {}
    for name in ("unified-candidate-input-lock.json", "toolchain-candidate-source-closure-locks.json"):
        src = repo / name
        if src.is_file() and not src.is_symlink():
            shutil.copyfile(src, metadata / name)
            lock_hashes[name] = sha(src)
    script_hashes = {}
    candidates = [repo / "scripts/stage-candidate-retention.py", repo / "scripts/verify-candidate-dependency-closure.py",
                  repo / "scripts/resolve-pinned-termux-recipe-closure.py"]
    candidates += list(repo.glob("scripts/*.sh")) + list(repo.glob("scripts/*.py"))
    candidates += list(repo.glob("termux-private-package-kit/*/*.sh"))
    candidates += list(repo.glob("termux-private-package-kit/*/*.py"))
    candidates += list(repo.glob("termux-private-package-kit/*/*.json"))
    candidates += list(repo.glob("termux-private-package-kit/*/*.patch"))
    for src in sorted(set(candidates)):
        if src.is_file() and not src.is_symlink():
            script_hashes[src.relative_to(repo).as_posix()] = sha(src)
    (metadata / "script-hashes.json").write_text(json.dumps(script_hashes, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    fingerprint_sha = sha(keymeta)
    provenance = {"schemaVersion": 1, "qualification": "self-signed ephemeral CI evidence; NOT independently trusted or production-qualified",
                  "repository": repository or os.environ.get("GITHUB_REPOSITORY", "unknown"), "repositoryCommit": sha_commit,
                  "workflowRunId": str(runid), "sourceCommit": source_commit, "builderImageDigest": builder,
                  "manifest": manifest.name, "manifestSha256": sha(manifest), "publicKeyFingerprint": fingerprint,
                  "publicKeyMetadataSha256": fingerprint_sha, "packageCount": len(debs), "signatures": ["signed-feed/dists/stable/InRelease", "signed-feed/dists/stable/Release.gpg"]}
    provenance["inputLockHashes"] = lock_hashes
    provenance["scriptHashes"] = script_hashes
    provenance["evidenceHashes"] = {name: sha(path) for name, path in reports.items()}
    if source_closure:
        provenance["evidenceHashes"]["source-closure.json"] = sha(source_closure)
    if not repository and os.environ.get("GITHUB_REPOSITORY"):
        provenance["repository"] = os.environ["GITHUB_REPOSITORY"]
    (destination / "provenance.json").write_text(json.dumps(provenance, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    # Ephemeral private key stays in keyroot. Sign only provenance and the bundle checksum list.
    if gpg_home.is_dir() and not gpg_home.is_symlink():
        sums = destination / "SHA256SUMS"
        entries = [f"{sha(p)}  {p.relative_to(destination).as_posix()}" for p in sorted(destination.rglob("*")) if p.is_file() and p != sums]
        sums.write_text("\n".join(entries) + "\n", encoding="utf-8")
        for name in ("provenance.json", "SHA256SUMS"):
            subprocess.run(["gpg", "--batch", "--homedir", str(gpg_home), "--armor", "--detach-sign", "--output", str(destination / (name + ".asc")), str(destination / name)], check=True, capture_output=True)
    else:
        raise ValueError("ephemeral signer required for retained provenance")
    # Keep original Debian filenames and signed feed metadata byte-for-byte intact;
    # the single portable artifact avoids upload-artifact path restrictions (e.g. ':').
    archive = destination.with_name(destination.name + ".tar.gz")
    if archive.exists() or archive.is_symlink():
        if archive.is_dir() and not archive.is_symlink():
            shutil.rmtree(archive)
        else:
            archive.unlink()
    with tarfile.open(archive, "w:gz") as tar:
        for path in sorted(destination.rglob("*")):
            if path.is_file():
                tar.add(path, arcname=path.relative_to(destination).as_posix(), recursive=False)
    return archive


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", default=os.environ.get("CANDIDATE_OUTPUT"))
    ap.add_argument("--feed", default=os.environ.get("CANDIDATE_FEED"))
    ap.add_argument("--keyroot", default=os.environ.get("CANDIDATE_KEYROOT"))
    ap.add_argument("--manifest", default=os.environ.get("CANDIDATE_MANIFEST"))
    ap.add_argument("--destination", default=os.environ.get("BUNDLE_DIR"))
    ap.add_argument("--source-closure", default=os.environ.get("SOURCE_CLOSURE"))
    ap.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    ap.add_argument("--repository-dir", default=os.environ.get("GITHUB_WORKSPACE"))
    a = ap.parse_args()
    stage(a.output, a.feed, a.keyroot, a.manifest, a.destination, a.repository_dir,
          os.environ.get("GITHUB_RUN_ID", "local"), os.environ.get("GITHUB_SHA", "unknown"),
          os.environ.get("SOURCE_COMMIT", "unknown"), os.environ.get("BUILDER_IMAGE_REF", "unknown"),
          a.repository, a.source_closure)

if __name__ == "__main__":
    main()
