from __future__ import annotations

import gzip
import hashlib
import json
import tempfile
import pathlib
import sys
import unittest

KIT = pathlib.Path(__file__).resolve().parents[1]
REPO = KIT.parents[1]
sys.path.insert(0, str(KIT))
import validate_openjdk17_feed as feed  # noqa: E402


class OpenJDK17FeedValidatorTests(unittest.TestCase):
    def test_indexes_reject_compressed_mismatch_corruption_missing_and_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            base = root / "dists/stable/main/binary-aarch64"
            base.mkdir(parents=True)
            index = base / "Packages"
            zipped = base / "Packages.gz"
            content = b"Package: demo\nVersion: 1\nArchitecture: aarch64\nFilename: pool/main/demo/demo.txt\nSize: 4\nSHA256: " + hashlib.sha256(b"data").hexdigest().encode() + b"\n\n"
            deb = root / "pool/main/demo/demo.txt"
            deb.parent.mkdir(parents=True)
            deb.write_bytes(b"data")
            record = content
            # helper enforces the production record count; use a wrapper with synthetic constant for lightweight fixtures.
            original = feed.EXPECTED_COUNT
            feed.EXPECTED_COUNT = 1
            specs = {"demo": {"version": "1", "architecture": "aarch64"}}
            files = {"demo": deb}
            try:
                index.write_bytes(content)
                zipped.write_bytes(gzip.compress(content + b"different"))
                with self.assertRaisesRegex(ValueError, "PACKAGES_GZIP_MISMATCH"):
                    feed.validate_indexes(root, files, specs)
                zipped.write_bytes(b"not gzip")
                with self.assertRaisesRegex(ValueError, "PACKAGES_GZIP_INVALID"):
                    feed.validate_indexes(root, files, specs)
                zipped.unlink()
                with self.assertRaisesRegex(ValueError, "PACKAGES_INDEX_MISSING"):
                    feed.validate_indexes(root, files, specs)
                zipped.symlink_to(index)
                with self.assertRaisesRegex(ValueError, "PACKAGES_INDEX_MISSING"):
                    feed.validate_indexes(root, files, specs)
                zipped.unlink()
                zipped.write_bytes(gzip.compress(content))
                index.unlink(); index.symlink_to(deb)
                with self.assertRaisesRegex(ValueError, "PACKAGES_INDEX_MISSING"):
                    feed.validate_indexes(root, files, specs)
            finally:
                feed.EXPECTED_COUNT = original

    def test_index_checks_audited_path_size_and_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            base = root / "dists/stable/main/binary-aarch64"
            base.mkdir(parents=True)
            deb = root / "pool/main/demo/demo.txt"
            deb.parent.mkdir(parents=True)
            deb.write_bytes(b"data")
            specs = {"demo": {"version": "1", "architecture": "aarch64"}}
            original = feed.EXPECTED_COUNT
            feed.EXPECTED_COUNT = 1
            try:
                fields = {"Package":"demo", "Version":"1", "Architecture":"aarch64",
                          "Filename":"pool/main/demo/demo.txt", "Size":"4",
                          "SHA256":hashlib.sha256(b"data").hexdigest()}
                def exercise() -> None:
                    body = "\n".join(f"{k}: {v}" for k,v in fields.items()) + "\n\n"
                    (base / "Packages").write_text(body)
                    (base / "Packages.gz").write_bytes(gzip.compress(body.encode()))
                    feed.validate_indexes(root, {"demo": deb}, specs)
                exercise()
                fields["Filename"] = "pool/main/other/demo.txt"
                with self.assertRaisesRegex(ValueError, "INDEX_FILENAME_MISMATCH"): exercise()
                fields["Filename"] = "../demo.txt"
                with self.assertRaisesRegex(ValueError, "INDEX_FILENAME_TRAVERSAL"): exercise()
                fields["Filename"] = "pool/main/demo/demo.txt"
                fields["Size"] = "5"
                with self.assertRaisesRegex(ValueError, "INDEX_PACKAGE_FILE_MISMATCH"): exercise()
                fields["Size"] = "4"
                fields["SHA256"] = "0" * 64
                with self.assertRaisesRegex(ValueError, "INDEX_PACKAGE_SHA256_MISMATCH"): exercise()
                deb.unlink(); deb.symlink_to(root / "target.txt")
                (root / "target.txt").write_text("data")
                fields["SHA256"] = hashlib.sha256(b"data").hexdigest()
                with self.assertRaisesRegex(ValueError, "INDEX_PACKAGE_FILE_MISMATCH"): exercise()
            finally:
                feed.EXPECTED_COUNT = original

    def test_root_depends_string_matches_pinned_recipe_groups(self) -> None:
        closure = json.loads((REPO / "toolchain-candidate-source-closures/openjdk17-candidate.json").read_text(encoding="utf-8"))
        root = next(item for item in closure["packages"] if item["name"] == "openjdk-17")
        expected = ", ".join(group[0]["sourceRelation"] for group in root["dependencyGroups"])
        self.assertEqual(feed.OPENJDK_DEPENDS, expected)
        self.assertEqual(len(root["dependencyGroups"]), 7)


if __name__ == "__main__":
    unittest.main()
