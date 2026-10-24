#!/usr/bin/env python3
"""Small fail-closed regression tests for the Android Gradle candidate helpers."""
from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load " + filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ASSEMBLER = load("gradle_assembler", "assemble-gradle-android-distribution.py")
FEED = load("gradle_feed_validator", "validate-gradle-android-candidate-feed.py")
STAGER = load("gradle_stager", "stage-gradle-android-candidate.py")
BASE = load("gradle_base_verifier", "verify-gradle-android-base82-archive.py")
AUDITOR = load("gradle_package_auditor", "audit-gradle-android-package.py")


class GradleCandidateToolTests(unittest.TestCase):
    def test_optional_source_artifact_run_id_metadata_is_checked_when_present(self):
        expected = "40090638892"
        self.assertFalse(ASSEMBLER.verify_optional_workflow_run_id({}, expected, "RUN_ID_MISMATCH"))
        self.assertTrue(ASSEMBLER.verify_optional_workflow_run_id(
            {"workflow": {"runId": 40090638892}}, expected, "RUN_ID_MISMATCH"))
        with self.assertRaisesRegex(ValueError, "RUN_ID_MISMATCH"):
            ASSEMBLER.verify_optional_workflow_run_id(
                {"workflow": {"runId": "40000000000"}}, expected, "RUN_ID_MISMATCH")

    def test_all_archive_path_helpers_reject_traversal(self):
        for module, function_name in ((ASSEMBLER, "safe_rel"), (FEED, "safe_rel"),
                                      (STAGER, "safe_rel"), (BASE, "safe_relative")):
            function = getattr(module, function_name)
            with self.subTest(module=module.__name__, path="../escape"):
                with self.assertRaises(ValueError):
                    function("../escape")
            with self.subTest(module=module.__name__, path="/absolute"):
                with self.assertRaises(ValueError):
                    function("/absolute")
            with self.subTest(module=module.__name__, path="a\\b"):
                with self.assertRaises(ValueError):
                    function("a\\b")
            self.assertEqual(function("pool/main/gradle/package.deb").as_posix(),
                             "pool/main/gradle/package.deb")

    def test_android_resource_jar_is_single_deterministic_entry(self):
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-unit-") as tmp:
            root = Path(tmp)
            library = root / "libnative-platform.so"
            library.write_bytes(b"synthetic ELF bytes for layout test")
            jar = root / "native-platform-linux-aarch64-test.jar"
            resource = "net/rubygrapefruit/platform/linux-aarch64/libnative-platform.so"
            first_hash = ASSEMBLER.write_deterministic_target_jar(jar, resource, library)
            first_bytes = jar.read_bytes()
            second_hash = ASSEMBLER.write_deterministic_target_jar(jar, resource, library)
            self.assertEqual(first_hash, second_hash)
            self.assertEqual(first_bytes, jar.read_bytes())
            content, names = ASSEMBLER.read_jar(jar, "TEST_JAR")
            self.assertEqual(names, [resource])
            self.assertEqual(list(content), [resource])
            self.assertEqual(content[resource], hashlib.sha256(library.read_bytes()).hexdigest())

    def test_deterministic_distribution_zip_is_stable(self):
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-zip-") as tmp:
            root = Path(tmp)
            tree = root / "tree"
            (tree / "gradle-9.8.2" / "bin").mkdir(parents=True)
            file = tree / "gradle-9.8.2" / "bin" / "gradle"
            file.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            file.chmod(0o755)
            output = root / "candidate.zip"
            digest1, size1 = ASSEMBLER.deterministic_zip(tree, output)
            os.utime(file, (1_700_000_000, 1_700_000_000))
            digest2, size2 = ASSEMBLER.deterministic_zip(tree, output)
            self.assertEqual((digest1, size1), (digest2, size2))
            with zipfile.ZipFile(output) as archive:
                self.assertIsNone(archive.testzip())
                self.assertIn("gradle-9.8.2/bin/gradle", archive.namelist())

    @unittest.skipUnless(shutil.which("dpkg-deb"), "dpkg-deb is required")
    def test_feed_index_binds_identity_size_and_hash_to_deb_bytes(self):
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-feed-") as tmp:
            root = Path(tmp)
            feed = root / "feed"
            deb_dir = feed / "pool/main/gradle"
            deb_dir.mkdir(parents=True)
            package_root = root / "package"
            control = package_root / "DEBIAN" / "control"
            control.parent.mkdir(parents=True)
            control.write_text(
                "Package: gradle\nVersion: 1:9.8.2\nArchitecture: aarch64\n"
                "Depends: openjdk-17\nDescription: synthetic unit fixture\n",
                encoding="utf-8",
            )
            payload = package_root / "data" / "marker"
            payload.parent.mkdir(parents=True)
            payload.write_text("test-only\n", encoding="utf-8")
            deb = deb_dir / "gradle_1%3a9.8.2_aarch64.deb"
            subprocess.run(["dpkg-deb", "--build", "--root-owner-group", str(package_root), str(deb)],
                           check=True, capture_output=True, text=True)
            digest = hashlib.sha256(deb.read_bytes()).hexdigest()
            index = feed / "Packages"
            index.write_text(
                "Package: gradle\nVersion: 1:9.8.2\nArchitecture: aarch64\nDepends: openjdk-17\n"
                f"Filename: pool/main/gradle/{deb.name}\nSize: {deb.stat().st_size}\nSHA256: {digest}\n",
                encoding="utf-8",
            )
            records = FEED.index_records(index, feed)
            self.assertEqual(set(records), {("gradle", "1:9.8.2", "aarch64")})
            self.assertEqual(records[("gradle", "1:9.8.2", "aarch64")]["Depends"], "openjdk-17")
            # Mutating the package bytes after indexing must fail closed.
            deb.write_bytes(deb.read_bytes() + b"tamper")
            with self.assertRaises(ValueError):
                FEED.index_records(index, feed)

    @unittest.skipUnless(shutil.which("dpkg-deb"), "dpkg-deb is required")
    def test_package_auditor_rejects_directories_outside_modeled_prefix(self):
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-audit-") as tmp:
            root = Path(tmp)
            package_root = root / "package"
            control = package_root / "DEBIAN" / "control"
            control.parent.mkdir(parents=True)
            control.write_text("Package: fixture\nVersion: 1\nArchitecture: aarch64\nDescription: test\n",
                               encoding="utf-8")
            payload = package_root / "usr" / "share" / "unexpected" / "marker"
            payload.parent.mkdir(parents=True)
            payload.write_text("outside-prefix\n", encoding="utf-8")
            deb = root / "fixture.deb"
            subprocess.run(["dpkg-deb", "--build", "--root-owner-group", str(package_root), str(deb)],
                           check=True, capture_output=True, text=True)
            with self.assertRaisesRegex(ValueError, "PACKAGE_(DIRECTORY|PATH)_OUTSIDE_MODELED_PREFIX"):
                AUDITOR.data_inventory(deb, "/data/user/0/com.karat.aibuilder/files/usr")


if __name__ == "__main__":
    unittest.main(verbosity=2)
