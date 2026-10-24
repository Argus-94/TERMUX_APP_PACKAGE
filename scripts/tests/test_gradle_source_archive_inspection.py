from __future__ import annotations

import hashlib
import importlib.util
import pathlib
import tempfile
import unittest
import warnings
import zipfile
from unittest import mock

SCRIPT = pathlib.Path(__file__).parents[1] / "inspect-gradle-source-archive.py"
SPEC = importlib.util.spec_from_file_location("gradle_source_inspector", SCRIPT)
INSPECTOR = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(INSPECTOR)

EXPECTED_URL = "https://services.gradle.org/distributions/gradle-9.8.1-bin.zip"


def make_archive(path: pathlib.Path, *, distribution_url: str = EXPECTED_URL,
                 duplicate: bool = False, extra_path: str | None = None) -> str:
    properties = (
        "distributionBase=GRADLE_USER_HOME\n"
        "distributionPath=wrapper/dists\n"
        "distributionUrl=https\\://" + distribution_url.removeprefix("https://") + "\n"
        "networkTimeout=10000\n"
        "retries=0\n"
        "validateDistributionUrl=true\n"
        "zipStoreBase=GRADLE_USER_HOME\n"
        "zipStorePath=wrapper/dists\n"
    ).encode()
    entries = {
        INSPECTOR.WRAPPER_PROPERTIES: properties,
        INSPECTOR.WRAPPER_JAR: b"wrapper jar fixture",
        INSPECTOR.WRAPPER_LAUNCHER: b"#!/bin/sh\n# do not execute\n",
        "gradle-9.8.2/build.gradle.kts": b"plugins {}\n",
        "gradle-9.8.2/gradle/verification-metadata.xml": b"<verification-metadata/>\n",
    }
    if extra_path:
        entries[extra_path] = b"unsafe fixture"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
        if duplicate:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                zf.writestr(INSPECTOR.WRAPPER_PROPERTIES, properties)
    return hashlib.sha256(path.read_bytes()).hexdigest()


class GradleSourceArchiveInspectionTests(unittest.TestCase):
    def test_source_archive_records_binary_wrapper_as_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            archive = pathlib.Path(td) / "source.zip"
            digest = make_archive(archive)
            with mock.patch.object(INSPECTOR, "SOURCE_SHA256", digest):
                report = INSPECTOR.inspect_archive(archive)
        self.assertEqual(report["wrapper"]["distributionUrl"], EXPECTED_URL)
        self.assertEqual(report["wrapper"]["distributionSha256Sum"], None)
        self.assertEqual(report["bootstrap"]["decision"], "BLOCKED_PREBUILT_GRADLE_BINARY")
        self.assertFalse(report["bootstrap"]["wrapperExecuted"])
        self.assertFalse(report["bootstrap"]["binaryDistributionDownloaded"])
        self.assertFalse(report["gates"]["candidateEligible"])
        self.assertFalse(report["gates"]["productionAllowed"])

    def test_rejects_archive_with_unpinned_digest(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            archive = pathlib.Path(td) / "source.zip"
            make_archive(archive)
            with self.assertRaisesRegex(INSPECTOR.InspectionError,
                                        "GRADLE_SOURCE_ARCHIVE_SHA256_MISMATCH"):
                INSPECTOR.inspect_archive(archive)

    def test_rejects_changed_wrapper_distribution_reference(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            archive = pathlib.Path(td) / "source.zip"
            digest = make_archive(archive)
            changed = "https://services.gradle.org/distributions/gradle-9.8.2-bin.zip"
            with mock.patch.object(INSPECTOR, "SOURCE_SHA256", digest), \
                 mock.patch.object(INSPECTOR, "EXPECTED_DISTRIBUTION_URL", changed):
                with self.assertRaisesRegex(INSPECTOR.InspectionError,
                                            "GRADLE_WRAPPER_DISTRIBUTION_REFERENCE_CHANGED"):
                    INSPECTOR.inspect_archive(archive)

    def test_rejects_duplicate_zip_entries(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            archive = pathlib.Path(td) / "source.zip"
            digest = make_archive(archive, duplicate=True)
            with mock.patch.object(INSPECTOR, "SOURCE_SHA256", digest):
                with self.assertRaisesRegex(INSPECTOR.InspectionError,
                                            "GRADLE_SOURCE_ARCHIVE_DUPLICATE_ENTRIES"):
                    INSPECTOR.inspect_archive(archive)

    def test_rejects_unsafe_zip_member_path(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            archive = pathlib.Path(td) / "source.zip"
            digest = make_archive(archive, extra_path="gradle-9.8.2/../escape")
            with mock.patch.object(INSPECTOR, "SOURCE_SHA256", digest):
                with self.assertRaisesRegex(INSPECTOR.InspectionError,
                                            "GRADLE_SOURCE_ARCHIVE_UNSAFE_MEMBER_PATH"):
                    INSPECTOR.inspect_archive(archive)

    def test_unescapes_wrapper_url_property(self) -> None:
        self.assertEqual(
            INSPECTOR.parse_properties(r"distributionUrl=https\://example.invalid/a.zip")["distributionUrl"],
            ["https://example.invalid/a.zip"],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
