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

    def test_native_java_evidence_validator_matches_raw_producer_schema(self):
        source_sha, published_sha = "a" * 64, "b" * 64
        distribution_sha, license_sha = "c" * 64, "d" * 64
        pin = {
            "sourceCommit": "source-commit", "sourceTree": "source-tree",
            "sourceTag": "0.22-milestone-29",
            "sourceRepository": "https://github.com/gradle/native-platform.git",
            "sourceBuiltJarSha256": source_sha, "publishedSignedJarSha256": published_sha,
            "separateApacheLicenseSha256": license_sha,
        }
        gradle_pin = {"hostDistributionRunId": 40079300326,
                      "hostDistributionSha256": distribution_sha}
        comparison = {
            "sourceBuiltVsPreviouslyVerifiedGradleDistribution": {
                "normalizedEntryContentIdentical": True,
                "embeddedJarByteIdenticalToAuthenticatedPublishedJar": True,
                "embeddedJarSha256": published_sha,
                "previousDistributionArchiveSha256": distribution_sha,
                "previousDistributionRunId": "40079300326",
                "sourceBuiltVsPublishedComparison": {
                    "contentDifferingEntries": [], "leftEntryCount": 143, "rightEntryCount": 143,
                    "leftSha256": source_sha, "rightSha256": published_sha,
                },
            },
            "sourceBuiltVsPublished": {
                "byteIdentical": False, "contentDifferingEntries": [],
                "leftEntryCount": 143, "rightEntryCount": 143,
                "leftSha256": source_sha, "rightSha256": published_sha,
            },
        }
        evidence = {
            "schemaVersion": 1,
            "experiment": "native-platform-java-api-jar-source-provenance-audit",
            "outcome": "PASS_NORMALIZED_JAR_CONTENT_IDENTICAL_CONTAINER_METADATA_DIFFERS",
            "classification": "ISOLATED_CI_EXPERIMENT_ONLY", "blocker": None,
            "source": {
                "actualCommit": pin["sourceCommit"], "expectedCommit": pin["sourceCommit"],
                "actualTree": pin["sourceTree"], "expectedTree": pin["sourceTree"],
                "tag": pin["sourceTag"], "repository": pin["sourceRepository"],
                "cleanCheckoutBeforeBuild": True, "gitStatusBeforeBuild": "", "license": "Apache-2.0",
            },
            "build": {
                "exitCode": 0, "jarSha256": source_sha, "dependencyVerificationEnabled": True,
                "dependencyVerificationMode": "strict", "dependencyVerificationMetadataUsed": True,
                "wrapperExecuted": False,
                "taskGraphPreflight": {"exitCode": 0, "requestedTask": ":native-platform:jar",
                                       "noPublishOrUploadTasks": True, "publishOrUploadTasks": []},
                "publishConfiguration": {
                    "actualCredentialsSupplied": False,
                    "propertiesPassedEmpty": ["publishUserName", "publishApiKey"],
                    "publishUserName": "", "publishApiKey": "",
                    "publishOrUploadTasksInvoked": False, "upstreamSourceModified": False,
                },
            },
            "publishedArtifact": {
                "jarSha256Actual": published_sha,
                "jarSha256ExpectedFromOfficialSidecarAndPinnedSignature": published_sha,
                "jarSha256Sidecar": published_sha,
                "jarSignature": {"verification": "VALID_SIGNATURE_PINNED_OFFICIAL_KEY", "gpgExitCode": 0,
                                 "primaryFingerprintActual": "fingerprint",
                                 "primaryFingerprintExpected": "fingerprint",
                                 "signaturePredatesOfficialRetirement": True},
            },
            "comparison": comparison,
            "licenseAudit": {
                "upstreamRootLicensePresent": True,
                "packageLicenseFileRequiredForAnyFuturePackaging": True,
                "licenseCopiedSeparatelyToArtifact": "UPSTREAM-LICENSE-Apache-2.0.txt",
                "licenseSha256": license_sha,
            },
            "gates": {"packageCreated": False, "feedCreated": False,
                      "androidBionicRuntimeVerified": False, "deviceTestsRun": False,
                      "productionAllowed": False, "candidateEligibilityChanged": False},
        }
        ASSEMBLER.verify_native_java_artifact_evidence(evidence, pin, gradle_pin)
        bad_build = dict(evidence["build"], jarSha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "NATIVE_JAVA_API_BUILD_MISMATCH"):
            ASSEMBLER.verify_native_java_artifact_evidence(
                dict(evidence, build=bad_build), pin, gradle_pin)
        bad_publish = dict(evidence["build"]["publishConfiguration"], actualCredentialsSupplied=True)
        bad_build = dict(evidence["build"], publishConfiguration=bad_publish)
        with self.assertRaisesRegex(ValueError, "NATIVE_JAVA_API_PUBLICATION_GUARD_MISMATCH"):
            ASSEMBLER.verify_native_java_artifact_evidence(
                dict(evidence, build=bad_build), pin, gradle_pin)

    def test_native_java_jar_layout_counts_files_not_directory_entries(self):
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-jar-layout-") as tmp:
            jar = Path(tmp) / "native-platform.jar"
            with zipfile.ZipFile(jar, "w") as archive:
                for directory in range(10):
                    archive.writestr(f"pkg{directory}/", b"")
                for index in range(143):
                    archive.writestr(f"pkg{index % 10}/entry{index}.class", b"class-bytes")
            content, names = ASSEMBLER.verify_native_java_jar_layout(jar)
            self.assertEqual(len(content), 143)
            self.assertEqual(len(names), 153)
            with zipfile.ZipFile(jar, "a") as archive:
                archive.writestr("pkg0/libnative-platform.so", b"native")
            with self.assertRaisesRegex(ValueError, "NATIVE_JAVA_API_SOURCE_JAR_LAYOUT_MISMATCH"):
                ASSEMBLER.verify_native_java_jar_layout(jar)

    def test_read_jar_accepts_only_empty_legacy_dos_directory_encoding(self):
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-jar-dir-encoding-") as tmp:
            jar = Path(tmp) / "dependency.jar"
            with zipfile.ZipFile(jar, "w") as archive:
                directory = zipfile.ZipInfo("META-INF/maven/")
                directory.create_system = 3
                directory.external_attr = 0xFFFF0010
                archive.writestr(directory, b"")
                archive.writestr("META-INF/maven/pom.xml", b"<project/>")
            content, names = ASSEMBLER.read_jar(jar, "TEST_JAR")
            self.assertEqual(len(content), 1)
            self.assertIn("META-INF/maven/", names)

            bad_attr = Path(tmp) / "bad-directory-attribute.jar"
            with zipfile.ZipFile(bad_attr, "w") as archive:
                directory = zipfile.ZipInfo("META-INF/maven/")
                directory.create_system = 3
                directory.external_attr = 0xFFFF0000
                archive.writestr(directory, b"")
            with self.assertRaisesRegex(ValueError, "TEST_JAR_NONDIR_DIRECTORY_ENTRY"):
                ASSEMBLER.read_jar(bad_attr, "TEST_JAR")

            bad_file = Path(tmp) / "bad-file-attribute.jar"
            with zipfile.ZipFile(bad_file, "w") as archive:
                file = zipfile.ZipInfo("META-INF/file.bin")
                file.create_system = 3
                file.external_attr = 0xFFFF0010
                archive.writestr(file, b"data")
            with self.assertRaisesRegex(ValueError, "TEST_JAR_NONREGULAR_ENTRY"):
                ASSEMBLER.read_jar(bad_file, "TEST_JAR")

    def test_pinned_provider_strip_is_deterministic_and_preserves_all_java_content(self):
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-native-strip-") as tmp:
            root = Path(tmp)
            template = root / "template.jar"
            entries = {
                "META-INF/MANIFEST.MF": b"Manifest-Version: 1.0\n\n",
                "pkg/Runner.class": b"unchanged-java-class-bytes",
                "pkg/data.txt": b"unchanged-resource-bytes",
                "pkg/linux-aarch64/libhelper.so": b"native-so-payload",
                "pkg/aix/libhelper.a": b"native-static-archive",
            }
            with zipfile.ZipFile(template, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("pkg/", b"")
                for name, payload in entries.items():
                    info = zipfile.ZipInfo(name, date_time=(2020, 1, 2, 3, 4, 6))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, payload)
            before, before_names = ASSEMBLER.read_jar(template, "TEST_PROVIDER")
            native_entries = []
            with zipfile.ZipFile(template) as archive:
                for info in archive.infolist():
                    if not info.is_dir() and info.filename.lower().endswith(ASSEMBLER.NATIVE_CODE_SUFFIXES):
                        payload = archive.read(info)
                        native_entries.append({
                            "path": info.filename,
                            "sha256": hashlib.sha256(payload).hexdigest(),
                            "sizeBytes": len(payload),
                        })
            provider = {
                "jarPath": "lib/example-provider.jar",
                "sourceJarSha256": ASSEMBLER.sha_file(template),
                "sourceJarSizeBytes": template.stat().st_size,
                "sourceEntryCount": len(before_names),
                "signatureFiles": [],
                "nativeEntries": native_entries,
            }
            outputs = []
            for index in (1, 2):
                jar = root / f"copy{index}" / "lib" / "example-provider.jar"
                jar.parent.mkdir(parents=True)
                shutil.copyfile(template, jar)
                report = ASSEMBLER.strip_pinned_native_provider_jar(
                    jar, provider, ASSEMBLER.NATIVE_CODE_SUFFIXES)
                after, after_names = ASSEMBLER.read_jar(jar, "TEST_PROVIDER_SANITIZED")
                expected = {name: digest for name, digest in before.items()
                            if not name.lower().endswith(ASSEMBLER.NATIVE_CODE_SUFFIXES)}
                self.assertEqual(after, expected)
                self.assertEqual(after_names, [name for name in before_names
                                               if not name.lower().endswith(ASSEMBLER.NATIVE_CODE_SUFFIXES)])
                self.assertEqual(report["removedNativeEntryCount"], 2)
                self.assertTrue(report["allNonNativeEntryContentsPreserved"])
                self.assertEqual(report["javaClassEntryCount"], 1)
                self.assertEqual(report["signatureFilesRemoved"], False)
                outputs.append(jar.read_bytes())
            self.assertEqual(outputs[0], outputs[1])

    def test_pinned_provider_strip_rejects_changed_hashes_and_unlisted_native_entries(self):
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-native-strip-reject-") as tmp:
            jar = Path(tmp) / "provider.jar"
            with zipfile.ZipFile(jar, "w") as archive:
                archive.writestr("pkg/Runner.class", b"class")
                archive.writestr("pkg/linux/lib.so", b"one")
                archive.writestr("pkg/windows/lib.dll", b"two")
            content, names = ASSEMBLER.read_jar(jar, "TEST_PROVIDER")
            provider = {
                "jarPath": "lib/example-provider.jar",
                "sourceJarSha256": ASSEMBLER.sha_file(jar),
                "sourceJarSizeBytes": jar.stat().st_size,
                "sourceEntryCount": len(names),
                "signatureFiles": [],
                "nativeEntries": [{"path": "pkg/linux/lib.so", "sha256": content["pkg/linux/lib.so"],
                                   "sizeBytes": 3}],
            }
            with self.assertRaisesRegex(ValueError, "NATIVE_PROVIDER_NATIVE_ENTRY_SET_OR_HASH_MISMATCH"):
                ASSEMBLER.strip_pinned_native_provider_jar(
                    jar, provider, ASSEMBLER.NATIVE_CODE_SUFFIXES)
            provider["nativeEntries"].append({"path": "pkg/windows/lib.dll",
                                              "sha256": content["pkg/windows/lib.dll"], "sizeBytes": 3})
            provider["sourceJarSha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "NATIVE_PROVIDER_SOURCE_JAR_SHA256_MISMATCH"):
                ASSEMBLER.strip_pinned_native_provider_jar(
                    jar, provider, ASSEMBLER.NATIVE_CODE_SUFFIXES)

    def test_native_provider_policy_requires_exact_pinned_provider_set(self):
        lock = {
            "gradleSourceBuild": {"hostDistributionSha256": "a" * 64},
            "nativeProviderSanitization": {
                "schemaVersion": 1,
                "policyId": ASSEMBLER.EXPECTED_NATIVE_PROVIDER_POLICY_ID,
                "sourceDistributionSha256": "a" * 64,
                "runtimeStatus": "NOT_DEVICE_VERIFIED",
                "nativeExtensions": list(ASSEMBLER.NATIVE_CODE_SUFFIXES),
                "providerJars": [],
            },
        }
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-native-policy-") as tmp:
            with self.assertRaisesRegex(ValueError, "NATIVE_PROVIDER_POLICY_JAR_SET_MISMATCH"):
                ASSEMBLER.strip_pinned_native_provider_jars(Path(tmp), lock)

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

    def test_binary_distribution_version_markers_replace_source_only_version_txt(self):
        with tempfile.TemporaryDirectory(prefix="gradle-candidate-version-markers-") as tmp:
            root = Path(tmp)

            def make_archive(path: Path, version: str) -> None:
                entries = {
                    "bin/gradle": (b"#!/bin/sh\nexit 0\n", 0o100755),
                    "LICENSE": (b"license\n", 0o100644),
                    "NOTICE": (b"notice\n", 0o100644),
                    f"lib/gradle-core-{version}.jar": (b"core", 0o100644),
                    f"lib/gradle-launcher-{version}.jar": (b"launcher", 0o100644),
                    f"lib/gradle-base-services-{version}.jar": (b"base", 0o100644),
                }
                with zipfile.ZipFile(path, "w") as archive:
                    for name, (payload, mode) in entries.items():
                        info = zipfile.ZipInfo("gradle-9.8.2/" + name)
                        info.create_system = 3
                        info.external_attr = mode << 16
                        archive.writestr(info, payload)

            good_zip = root / "gradle-9.8.2-bin.zip"
            make_archive(good_zip, "9.8.2")
            result = ASSEMBLER.extract_distribution(good_zip, root / "good-extract")
            extracted_root = Path(result["root"])
            self.assertTrue((extracted_root / "lib/gradle-core-9.8.2.jar").is_file())
            self.assertFalse((extracted_root / "version.txt").exists())

            bad_zip = root / "wrong-version-bin.zip"
            make_archive(bad_zip, "9.8.1")
            with self.assertRaisesRegex(ValueError, "GRADLE_DISTRIBUTION_VERSION_MARKERS_MISMATCH"):
                ASSEMBLER.extract_distribution(bad_zip, root / "bad-extract")

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
