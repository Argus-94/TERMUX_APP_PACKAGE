#!/usr/bin/env python3
"""Portable hostile tests for the candidate-feed staging validator."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGER = HERE / "aib-candidate-feed-stage.py"
DEFAULT_MANIFEST = HERE.parent / "docs/candidate-feed-probe/aggregate-manifest.json"
DEFAULT_INVENTORY = HERE.parent / "docs/candidate-feed-probe/aggregate-archive-inventory.json"


def invoke(feed: Path, manifest: Path, inventory: Path, destination: Path, succeeds: bool) -> subprocess.CompletedProcess:
    result = subprocess.run(
        [sys.executable, str(STAGER), "--feed-root", str(feed), "--manifest", str(manifest),
         "--inventory", str(inventory), "--destination", str(destination)],
        capture_output=True, text=True, timeout=180,
    )
    assert (result.returncode == 0) == succeeds, (result.stdout, result.stderr)
    return result


def clone_fixture(source: Path, dest: Path) -> None:
    shutil.copytree(source, dest, copy_function=os.link)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feed-root", default=os.environ.get("AIB_CANDIDATE_FEED"))
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--inventory", default=str(DEFAULT_INVENTORY))
    parser.add_argument("--static", action="store_true", help="run portable pin/path unit checks without a feed fixture")
    args = parser.parse_args()
    manifest, inventory = Path(args.manifest).resolve(), Path(args.inventory).resolve()
    if not manifest.is_file() or not inventory.is_file():
        raise AssertionError("manifest or inventory is unavailable; pass --manifest and --inventory")

    if args.static:
        expected = "e5a2e3cdb0d1010436f850da4511b993bac9ddb8d9f9f6b941c29a925386d911"
        inv_expected = "54b5234027eee61dd4407b7287b7a0d2f6f040169c7a182eefba8cac74d0b716"
        assert hashlib.sha256(manifest.read_bytes()).hexdigest() == expected
        assert hashlib.sha256(inventory.read_bytes()).hexdigest() == inv_expected
        document = json.loads(manifest.read_text())
        assert len(document["packages"]) == 80
        assert all(len(item["sha256"]) == 64 for item in document["packages"])
        print("PASS: portable pinned manifest/inventory digest and 80 package hash baseline")
        if not args.feed_root:
            return

    if not args.feed_root:
        raise SystemExit("provide --feed-root (or AIB_CANDIDATE_FEED), or use --static")
    feed = Path(args.feed_root).resolve()
    if not feed.is_dir():
        raise AssertionError(f"feed fixture does not exist: {feed}")
    with tempfile.TemporaryDirectory(prefix="aib-candidate-feed-selftest-", dir=feed.parent) as tmp:
        root = Path(tmp)
        # Valid, actually signed fixture must produce exactly payload allowlist + summary.
        staged = root / "valid"
        invoke(feed, manifest, inventory, staged, True)
        summary = json.loads((staged / "TEST-ONLY-SUMMARY.json").read_text())
        assert summary["packageCount"] == 80 and summary["production"] is False
        assert len([p for p in staged.rglob("*.deb")]) == 80
        assert not list(staged.rglob("*.key"))

        # Old but still signed feed, if supplied separately, must not match exact baseline pins.
        old = Path("/workspace/AIBuilder-Expo-v493/candidate-feed")
        if old.is_dir() and old.resolve() != feed:
            invoke(old, manifest, inventory, root / "old-feed", False)

        # Alter one data byte while keeping the package structure: inventory and signed index reject it.
        broken = root / "broken"
        clone_fixture(feed, broken)
        package = next((broken / "pool").rglob("*.deb"))
        package_copy = package.with_suffix(".deb.copy")
        shutil.copyfile(package, package_copy)
        package.unlink()
        package_copy.rename(package)
        with package.open("r+b") as stream:
            stream.seek(0)
            first = stream.read(1)
            stream.seek(0)
            stream.write(bytes([first[0] ^ 1]))
        invoke(broken, manifest, inventory, root / "corrupt", False)

        # A changed candidate manifest cannot be used as the source of actual hashes.
        changed = root / "changed-manifest"
        clone_fixture(feed, changed)
        target_manifest = changed / "aggregate-manifest.json"
        altered_contents = target_manifest.read_text(encoding="utf-8") + " "
        target_manifest.unlink()
        target_manifest.write_text(altered_contents, encoding="utf-8")
        invoke(changed, manifest, inventory, root / "altered-manifest", False)

        # Extra package and key are never staged; symlink traversal/links are rejected.
        extra = root / "extra"
        clone_fixture(feed, extra)
        (extra / "unexpected.deb").write_bytes(b"hostile")
        invoke(extra, manifest, inventory, root / "extra-output", False)

        link_fixture = root / "linked"
        clone_fixture(feed, link_fixture)
        link = link_fixture / "untrusted-link"
        link.symlink_to(feed / "Release")
        invoke(link_fixture, manifest, inventory, root / "symlink-output", False)

        traversal_fixture = root / "traversal"
        clone_fixture(feed, traversal_fixture)
        (traversal_fixture / "pool" / "main" / "escape.deb").symlink_to(root / "outside")
        invoke(traversal_fixture, manifest, inventory, root / "traversal-output", False)

        altered_pin = root / "altered-pin.json"
        altered_pin.write_text(manifest.read_text().replace('"candidate-only"', '"production"', 1), encoding="utf-8")
        invoke(feed, altered_pin, inventory, root / "bad-pin", False)
        invoke(feed, manifest, inventory, staged, False)
    print("PASS: final signed stage; corruption, altered feed manifest/pin, extra package, symlink/traversal, and existing destination rejected")


if __name__ == "__main__":
    main()
