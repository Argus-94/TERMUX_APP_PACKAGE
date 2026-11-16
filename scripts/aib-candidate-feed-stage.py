#!/usr/bin/env python3
"""Validate a pinned, signed 80-package candidate feed and stage test-only files."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

APP = "com.karat.aibuilder"
PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"
PINNED_MANIFEST_SHA256 = "e5a2e3cdb0d1010436f850da4511b993bac9ddb8d9f9f6b941c29a925386d911"
PINNED_INVENTORY_SHA256 = "54b5234027eee61dd4407b7287b7a0d2f6f040169c7a182eefba8cac74d0b716"
KEY_SHA256 = "a9ec552d8f0eb5b5d8846623e5b98ca46fce2ad4533f74301e6dbcae9cf3e3d2"
FINGERPRINT = "90CD2EAF115DA42B87194C5C8BB5824E095857FE"
DEFAULT_MANIFEST = Path(__file__).resolve().parents[1] / "docs/candidate-feed-probe/aggregate-manifest.json"
DEFAULT_INVENTORY = Path(__file__).resolve().parents[1] / "docs/candidate-feed-probe/aggregate-archive-inventory.json"
RELEASE = "dists/stable/Release"
DETACHED = "dists/stable/Release.gpg"
INLINE = "dists/stable/InRelease"
PACKAGES = "dists/stable/main/binary-aarch64/Packages"
PACKAGES_GZ = PACKAGES + ".gz"
KEY = "keys/aibuilder-termux-feed-keyring.gpg"
MAX_METADATA = 4 * 1024 * 1024
MAX_PACKAGE = 128 * 1024 * 1024
MAX_TIMEOUT = 20


def reject(message: str) -> None:
    raise ValueError(message)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def check_components(path: Path, include_leaf: bool = True) -> None:
    """Reject symlinks in every existing path component; no race-freedom implied."""
    absolute = Path(os.path.abspath(path))
    parts = absolute.parts
    current = Path(parts[0])
    for part in parts[1:] if include_leaf else parts[1:-1]:
        current = current / part
        if current.is_symlink():
            reject(f"symlink path component forbidden: {current}")


def regular_file(root: Path, rel: str, limit: int = MAX_METADATA) -> Path:
    if Path(rel).is_absolute() or ".." in Path(rel).parts:
        reject("unsafe relative path")
    p = root / rel
    check_components(p)
    try:
        st = p.lstat()
    except OSError:
        reject(f"missing required file: {rel}")
    if not p.is_file() or p.is_symlink() or st.st_size > limit:
        reject(f"not a bounded regular file: {rel}")
    return p


def parse_control(raw: bytes) -> list[dict[str, str]]:
    text = raw.decode("utf-8", "strict")
    records: list[dict[str, str]] = []
    fields: dict[str, str] = {}
    last = None
    for line in text.splitlines() + [""]:
        if not line:
            if fields:
                records.append(fields)
                fields, last = {}, None
            continue
        if line.startswith((" ", "\t")):
            if last is None:
                reject("orphan Packages continuation")
            fields[last] += "\n" + line[1:]
            continue
        if ":" not in line:
            reject("malformed Packages field")
        name, value = line.split(":", 1)
        name = name.lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", name) or name in fields:
            reject("invalid/duplicate Packages field")
        fields[name], last = value.strip(), name
    return records


def load_pins(manifest_path: Path, inventory_path: Path) -> tuple[dict, dict]:
    for path, expected in ((manifest_path, PINNED_MANIFEST_SHA256), (inventory_path, PINNED_INVENTORY_SHA256)):
        check_components(path)
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
            reject("baseline document missing or oversized")
        if sha256(path) != expected:
            reject("baseline document digest differs from source-pinned digest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    if len(manifest.get("packages", [])) != 80:
        reject("pinned baseline must contain exactly 80 packages")
    if manifest.get("target", {}).get("applicationId") != APP or manifest.get("target", {}).get("modeledPrefix") != PREFIX:
        reject("pinned manifest target identity mismatch")
    return manifest, inventory


def package_pins(manifest: dict) -> dict[tuple[str, str, str, str], str]:
    result = {}
    for item in manifest["packages"]:
        if set(item) != {"architecture", "filename", "name", "occurrenceCount", "sha256", "version"}:
            reject("unexpected pinned package fields")
        identity = (item["name"], item["version"], item["architecture"], item["filename"])
        if identity in result or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]):
            reject("duplicate/invalid pinned package identity or hash")
        if not re.fullmatch(r"[^/]+\.deb", item["filename"]):
            reject("unsafe pinned package filename")
        result[identity] = item["sha256"]
    return result


def inventory_entry(inventory: dict, rel: str) -> dict:
    key = "aggregate/candidate-feed/" + rel
    item = inventory.get("files", {}).get(key)
    if not isinstance(item, dict) or set(item) != {"sha256", "size"}:
        reject(f"inventory lacks pinned feed file {rel}")
    return item


def verify_inventory_file(root: Path, rel: str, inventory: dict, limit: int) -> Path:
    p = regular_file(root, rel, limit)
    pin = inventory_entry(inventory, rel)
    if p.stat().st_size != pin["size"] or sha256(p) != pin["sha256"]:
        reject(f"file differs from exact archive inventory pin: {rel}")
    return p


def verify_feed(feed: Path, manifest: dict, inventory: dict) -> tuple[set[str], dict[str, Path]]:
    check_components(feed)
    if not feed.is_dir() or feed.is_symlink():
        reject("feed-root must be a real directory")
    # Scan without following symlinks; reject every unlisted file, directory symlink, and special object.
    all_paths: set[str] = set()
    for base, dirs, files in os.walk(feed, followlinks=False):
        base_path = Path(base)
        for name in list(dirs):
            p = base_path / name
            if p.is_symlink() or not p.is_dir():
                reject(f"symlink/non-directory feed component: {p.relative_to(feed)}")
        for name in files:
            p = base_path / name
            rel = p.relative_to(feed).as_posix()
            check_components(p)
            if p.is_symlink() or not p.is_file():
                reject(f"symlink/non-regular feed entry: {rel}")
            all_paths.add(rel)

    manifest_file = regular_file(feed, "aggregate-manifest.json", 2 * 1024 * 1024)
    if sha256(manifest_file) != PINNED_MANIFEST_SHA256:
        reject("feed manifest is not the pinned baseline")
    feed_manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if feed_manifest != manifest:
        reject("feed manifest content differs from pinned baseline")
    pins = package_pins(manifest)
    allowed = {RELEASE, DETACHED, INLINE, PACKAGES, PACKAGES_GZ, KEY, "aggregate-manifest.json"}
    release = verify_inventory_file(feed, RELEASE, inventory, MAX_METADATA)
    detached = verify_inventory_file(feed, DETACHED, inventory, MAX_METADATA)
    inline = verify_inventory_file(feed, INLINE, inventory, MAX_METADATA)
    index = verify_inventory_file(feed, PACKAGES, inventory, MAX_METADATA)
    compressed = verify_inventory_file(feed, PACKAGES_GZ, inventory, MAX_METADATA)
    key = verify_inventory_file(feed, KEY, inventory, MAX_METADATA)
    if sha256(key) != KEY_SHA256:
        reject("pinned feed key hash mismatch")

    for metadata_rel in ("aggregate-manifest.json",):
        pin = inventory_entry(inventory, metadata_rel)
        path = regular_file(feed, metadata_rel, 2 * 1024 * 1024)
        if path.stat().st_size != pin["size"] or sha256(path) != pin["sha256"]:
            reject("feed aggregate manifest inventory mismatch")

    with tempfile.TemporaryDirectory(prefix="aib-feed-key-") as td:
        ring = Path(td) / "trusted.gpg"
        shutil.copyfile(key, ring)
        listing = subprocess.run(["gpg", "--batch", "--no-default-keyring", "--keyring", str(ring), "--with-colons", "--fingerprint"], capture_output=True, text=True, check=True, timeout=MAX_TIMEOUT).stdout
        fingerprints = [line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:")]
        if FINGERPRINT not in fingerprints or len(fingerprints) != 1:
            reject("unexpected signing key fingerprint")
        subprocess.run(["gpgv", "--keyring", str(ring), str(detached), str(release)], capture_output=True, check=True, timeout=MAX_TIMEOUT)
        decoded = subprocess.run(["gpg", "--batch", "--no-options", "--no-default-keyring", "--keyring", str(ring), "--decrypt", str(inline)], capture_output=True, check=True, timeout=MAX_TIMEOUT).stdout
    release_bytes = release.read_bytes()
    if decoded != release_bytes:
        reject("InRelease decoded payload differs byte-for-byte from Release")

    release_text = release_bytes.decode("utf-8", "strict")
    for field in ("Origin", "Label", "Suite", "Codename", "Architectures", "Components"):
        match = re.search(rf"^{field}:\s*(.*?)\s*$", release_text, re.M)
        if not match:
            reject(f"Release lacks {field}")
    if not re.search(r"^Architectures:.*\baarch64\b", release_text, re.M) or not re.search(r"^Components:.*\bmain\b", release_text, re.M):
        reject("Release architecture/component identity mismatch")
    for field in ("Date", "Valid-Until"):
        match = re.search(rf"^{field}:\s*(.+)$", release_text, re.M)
        if not match:
            reject(f"Release lacks {field}")
        dt = parsedate_to_datetime(match.group(1))
        if dt.tzinfo is None:
            reject(f"Release {field} has no timezone")
        timestamp = dt.astimezone(timezone.utc).timestamp()
        now = time.time()
        if field == "Date" and timestamp > now + 300:
            reject("Release Date is in the future")
        if field == "Valid-Until" and (timestamp <= now or timestamp > now + 366 * 86400):
            reject("Release Valid-Until expired or implausibly far in future")

    section = re.search(r"^SHA256:\s*\n(.*?)(?=^[A-Za-z][A-Za-z0-9-]*:|\Z)", release_text, re.M | re.S)
    if not section:
        reject("Release lacks SHA256 table")
    entries = {}
    for line in section.group(1).splitlines():
        match = re.fullmatch(r"\s*([0-9a-f]{64})\s+(\d+)\s+(\S+)\s*", line)
        if match:
            path = match.group(3)
            if path in entries:
                reject("duplicate Release SHA256 path")
            entries[path] = (match.group(1), int(match.group(2)))
    for rel, path in ((PACKAGES, index), (PACKAGES_GZ, compressed)):
        relative = rel.split("/stable/", 1)[1]
        if entries.get(relative) != (sha256(path), path.stat().st_size):
            reject(f"Release index digest/size mismatch: {rel}")
    if gzip.decompress(compressed.read_bytes()) != index.read_bytes():
        reject("Packages.gz payload does not exactly match Packages")

    records = parse_control(index.read_bytes())
    if len(records) != 80:
        reject("signed Packages must contain exactly 80 records")
    seen = set()
    package_paths: dict[str, Path] = {}
    for record in records:
        filename = record.get("filename", "")
        identity = (record.get("package"), record.get("version"), record.get("architecture"), Path(filename).name)
        if identity not in pins or identity in seen:
            reject("Packages identity missing from exact pinned baseline or duplicated")
        seen.add(identity)
        if not re.fullmatch(r"pool/main/[A-Za-z0-9+._:-]+/[A-Za-z0-9+._:-]+\.deb", filename):
            reject("unsafe Packages pool path")
        if record.get("sha256") != pins[identity] or not record.get("size", "").isdigit():
            reject("Packages SHA256/size differs from pinned package identity")
        path = regular_file(feed, filename, MAX_PACKAGE)
        pin = inventory_entry(inventory, filename)
        if path.stat().st_size != int(record["size"]) or path.stat().st_size != pin["size"] or sha256(path) != pins[identity] or sha256(path) != pin["sha256"]:
            reject(f"package bytes differ from both exact pins: {filename}")
        control_text = subprocess.run(["dpkg-deb", "--field", str(path)], capture_output=True, check=True, timeout=MAX_TIMEOUT).stdout
        control = parse_control(control_text)
        if len(control) != 1 or tuple(control[0].get(field, "") for field in ("package", "version", "architecture")) != identity[:3]:
            reject(f"actual .deb control identity differs from Packages: {filename}")
        package_paths[filename] = path
        allowed.add(filename)
    if seen != set(pins):
        reject("Packages does not enumerate the exact pinned 80-package set")
    missing = allowed - all_paths
    if missing:
        reject(f"feed lacks required pinned files: {sorted(missing)[:4]}")
    for rel in all_paths - allowed:
        suffix = Path(rel).suffix.lower()
        if suffix == ".deb" or suffix in {".gpg", ".asc", ".key", ".pub", ".pgp"}:
            reject(f"unlisted package or key file in feed: {rel}")
    return allowed, package_paths


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feed-root", required=True)
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--inventory", default=str(DEFAULT_INVENTORY))
    parser.add_argument("--destination", required=True)
    args = parser.parse_args()
    feed = Path(os.path.abspath(args.feed_root))
    destination = Path(os.path.abspath(args.destination))
    manifest_path, inventory_path = Path(os.path.abspath(args.manifest)), Path(os.path.abspath(args.inventory))
    manifest, inventory = load_pins(manifest_path, inventory_path)
    check_components(destination, include_leaf=False)
    parent = destination.parent
    if not parent.is_dir():
        reject("destination parent must already exist")
    if destination.exists() or destination.is_symlink():
        reject("destination must not already exist")
    allowed, _ = verify_feed(feed, manifest, inventory)

    created = False
    try:
        destination.mkdir()
        created = True
        for rel in sorted(allowed):
            source = regular_file(feed, rel, MAX_PACKAGE if rel.endswith(".deb") else MAX_METADATA)
            target = destination / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            if target.stat().st_size != source.stat().st_size or sha256(target) != sha256(source):
                reject(f"copied output rehash mismatch: {rel}")
        summary = {
            "testOnly": True, "production": False, "install": False, "publish": False,
            "targetApplication": APP, "modeledPrefix": PREFIX, "packageCount": 80,
            "manifestSha256": PINNED_MANIFEST_SHA256, "inventorySha256": PINNED_INVENTORY_SHA256,
            "feedKeyFingerprint": FINGERPRINT, "feedKeySha256": KEY_SHA256,
        }
        (destination / "TEST-ONLY-SUMMARY.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        for base, dirs, files in os.walk(destination, followlinks=False):
            if any((Path(base) / name).is_symlink() for name in dirs + files):
                reject("symlink appeared in staged output")
        expected_output = allowed | {"TEST-ONLY-SUMMARY.json"}
        actual_output = {p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file()}
        if actual_output != expected_output:
            reject("staged output does not match exact allowlist")
    except Exception:
        if created and destination.is_dir() and not destination.is_symlink():
            shutil.rmtree(destination)
        raise
    print(f"STAGED TEST ONLY: {destination} (80 pinned packages); no install or publication performed")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"REJECTED: {error}", file=sys.stderr)
        sys.exit(2)
