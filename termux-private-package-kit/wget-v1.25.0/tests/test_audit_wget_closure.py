import ast
import hashlib
import importlib.util
import json
import pathlib
import re
import unittest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "audit_wget_closure.py"
SPEC = importlib.util.spec_from_file_location("wget_closure_auditor", MODULE_PATH)
auditor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(auditor)
REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
MANIFEST = REPO_ROOT / "wget-candidate-package-set.json"
PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"


class WgetAllowlistTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    def test_embedded_builder_python_heredocs_parse(self):
        builder = pathlib.Path(__file__).resolve().parents[1] / "build-wget-private-aarch64.sh"
        text = builder.read_text(encoding="utf-8")
        blocks = re.findall(r"<<'PY'\n(.*?)\nPY(?=\n|$)", text, re.S)
        self.assertGreaterEqual(len(blocks), 4)
        for index, block in enumerate(blocks):
            ast.parse(block, filename=f"{builder}:python-heredoc-{index + 1}")

    def test_exact_pinned_package_specs_are_accepted(self):
        auditor.validate_package_specs(self.manifest["packages"])

    def test_missing_extra_or_reordered_candidate_is_rejected(self):
        with self.assertRaises(auditor.AuditError):
            auditor.validate_package_specs(self.manifest["packages"][:-1])
        specs = json.loads(json.dumps(self.manifest["packages"]))
        specs[-1]["name"] = "unexpected"
        with self.assertRaises(auditor.AuditError):
            auditor.validate_package_specs(specs)
        specs = list(reversed(self.manifest["packages"]))
        with self.assertRaises(auditor.AuditError):
            auditor.validate_package_specs(specs)

    def test_changed_wget_recipe_hash_or_package_version_is_rejected(self):
        for field, value in (("recipeSha256", "0" * 64), ("version", "1.25.0")):
            specs = json.loads(json.dumps(self.manifest["packages"]))
            next(item for item in specs if item["name"] == "wget")[field] = value
            with self.assertRaises(auditor.AuditError):
                auditor.validate_package_specs(specs)

    def test_libuuid_is_exact_subpackage_without_parent_runtime_dependency(self):
        auditor.validate_subpackage_metadata(self.manifest["packages"])
        specs = json.loads(json.dumps(self.manifest["packages"]))
        next(item for item in specs if item["name"] == "libuuid")["parentDependencyRule"] = "true"
        with self.assertRaises(auditor.AuditError):
            auditor.validate_subpackage_metadata(specs)

    def test_wget_gpl_copy_is_pinned_to_archive_and_full_payload_hash(self):
        spec = next(item for item in self.manifest["packages"] if item["name"] == "wget")
        self.assertEqual(
            auditor.expected_source_license_files(spec),
            {"share/doc/wget/COPYING": "f7dc7522e7e1be9227f3dc8de8b39a4d1d2471968c893af15f00c1a2076a0eec"},
        )
        changed = dict(spec)
        changed["sourceSha256"] = "0" * 64
        with self.assertRaises(auditor.AuditError):
            auditor.expected_source_license_files(changed)

    def test_libuuid_license_documents_are_pinned_to_exact_source_archive(self):
        spec = next(item for item in self.manifest["packages"] if item["name"] == "libuuid")
        expected = {
            "share/doc/util-linux/COPYING.GPL-3.0-or-later": "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
            "share/doc/util-linux/COPYING.GPL-2.0-or-later": "8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643",
            "share/doc/util-linux/COPYING.LGPL-2.1-or-later": "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551",
            "share/doc/util-linux/COPYING.BSD-3-Clause": "9b718a9460fed5952466421235bc79eb49d4e9eacc920d7a9dd6285ab8fd6c6d",
            "share/doc/util-linux/COPYING.BSD-4-Clause-UC": "ba7640f00d93e72e92b94b9d71f25ec53bac2f1682f5c4adcccb0018359f60f8",
            "share/doc/util-linux/COPYING.ISC": "e53348ce276358e9997014071c5294b36a18c4b34f32f00ee57b9acce0aafd63",
        }
        self.assertEqual(auditor.expected_source_license_files(spec), expected)
        changed = dict(spec)
        changed["sourceSha256"] = "0" * 64
        with self.assertRaises(auditor.AuditError):
            auditor.expected_source_license_files(changed)

    def test_util_linux_license_list_patch_uses_pinned_helper_format(self):
        patch = pathlib.Path(__file__).resolve().parents[1] / "wget-license-file.patch"
        text = patch.read_text(encoding="utf-8")
        expected = '+TERMUX_PKG_LICENSE_FILE="Documentation/licenses/COPYING.GPL-3.0-or-later,Documentation/licenses/COPYING.GPL-2.0-or-later,Documentation/licenses/COPYING.LGPL-2.1-or-later,Documentation/licenses/COPYING.BSD-3-Clause,Documentation/licenses/COPYING.BSD-4-Clause-UC,Documentation/licenses/COPYING.ISC"'
        self.assertIn(expected, text)
        self.assertIn("+share/doc/util-linux", text)

    def test_build_patch_digest_matches_manifest_and_auditor_allowlist(self):
        patch = pathlib.Path(__file__).resolve().parents[1] / "wget-license-file.patch"
        actual = hashlib.sha256(patch.read_bytes()).hexdigest()
        self.assertEqual(actual, self.manifest["buildModifications"]["patchSha256"])
        self.assertEqual(actual, auditor.EXPECTED_BUILD_PATCH_SHA256)

    def test_base_bootstrap_license_provider_evidence_is_exact_and_archive_only(self):
        expected = auditor.validate_base_license_provider_evidence(self.manifest["baseLicenseProviderEvidence"])
        self.assertEqual(expected["packageName"], "termux-licenses")
        self.assertEqual(expected["version"], "2.1")
        self.assertIs(expected["deviceObserved"], False)
        changed = dict(expected)
        changed["archiveSha256"] = "0" * 64
        with self.assertRaises(auditor.AuditError):
            auditor.validate_base_license_provider_evidence(changed)

    def test_root_wget_must_be_regular_executable_at_exact_private_path(self):
        self.assertTrue(auditor.is_wget_executable("wget", PREFIX + "/bin/wget", True, 0o755, PREFIX))
        self.assertFalse(auditor.is_wget_executable("wget", PREFIX + "/bin/wget", False, 0o777, PREFIX))
        self.assertFalse(auditor.is_wget_executable("wget", PREFIX + "/bin/not-wget", True, 0o755, PREFIX))
        self.assertFalse(auditor.is_wget_executable("wget", "/usr/bin/wget", True, 0o755, PREFIX))
        self.assertFalse(auditor.is_wget_executable("wget", PREFIX + "/bin/wget", True, 0o644, PREFIX))
        self.assertTrue(auditor.is_wget_elf("wget", PREFIX + "/bin/wget", b"\x7fELF\x02", PREFIX))
        self.assertFalse(auditor.is_wget_elf("wget", PREFIX + "/bin/wget", b"#!/bin/sh", PREFIX))
        self.assertFalse(auditor.is_wget_elf("wget", PREFIX + "/bin/other", b"\x7fELF", PREFIX))

    def test_needed_library_provider_requires_exact_locked_candidate_elf_file(self):
        idn2 = {"package": "libidn2", "path": "bin/idn2", "soname": None, "needed": ["libandroid-support.so"]}
        uuid = {"package": "libuuid", "path": "lib/libuuid.so", "soname": "libuuid.so.1", "needed": ["libandroid-posix-semaphore.so"]}
        semaphore = {"package": "libandroid-posix-semaphore", "path": "lib/libandroid-posix-semaphore.so", "soname": None, "needed": []}
        support = {"package": "libandroid-support", "path": "lib/libandroid-support.so", "soname": None, "needed": []}
        result = auditor.validate_elf_needed_providers([idn2, uuid, semaphore, support])
        self.assertNotIn("libandroid-posix-semaphore.so", auditor.PLATFORM_LIBS)
        self.assertNotIn("libandroid-support.so", auditor.PLATFORM_LIBS)
        self.assertIn("libandroid-posix-semaphore.so", result["providers"])
        self.assertIn("libandroid-support.so", result["providers"])
        self.assertEqual(result["packageFileProviders"], [
            {"library": "libandroid-posix-semaphore.so", "package": "libandroid-posix-semaphore",
             "path": "lib/libandroid-posix-semaphore.so", "soname": None,
             "basis": "exact packaged AArch64 ELF path; package and recipe are pinned in the candidate closure"},
            {"library": "libandroid-support.so", "package": "libandroid-support",
             "path": "lib/libandroid-support.so", "soname": None,
             "basis": "exact packaged AArch64 ELF path; package and recipe are pinned in the candidate closure"},
        ])
        invalid_providers = [
            [idn2, uuid, semaphore],
            [idn2, uuid, semaphore, {**support, "package": "libidn2"}],
            [idn2, uuid, semaphore, {**support, "path": "lib/libandroid-support.so.29"}],
            [idn2, uuid, semaphore, {**support, "soname": "different.so"}],
            [idn2, uuid, support],
            [idn2, uuid, {**semaphore, "path": "lib/libandroid-posix-semaphore.so.1"}, support],
            [idn2, uuid, {**semaphore, "soname": "different.so"}, support],
            [{**idn2, "needed": ["unknown-provider.so"]}, uuid, semaphore, support],
        ]
        for records in invalid_providers:
            with self.subTest(records=records):
                with self.assertRaises(auditor.AuditError):
                    auditor.validate_elf_needed_providers(records)

    def test_license_paths_are_confined_to_each_package_document_directory(self):
        self.assertTrue(auditor.is_package_license_path(PREFIX + "/share/doc/wget/COPYING", PREFIX, "wget"))
        self.assertTrue(auditor.is_package_license_path(PREFIX + "/share/doc/pcre2/LICENCE.md", PREFIX, "pcre2"))
        self.assertTrue(auditor.is_package_license_path(PREFIX + "/share/doc/util-linux/COPYING.GPL-3.0-or-later", PREFIX, "libuuid"))
        self.assertFalse(auditor.is_package_license_path(PREFIX + "/share/doc/other/COPYING", PREFIX, "wget"))
        self.assertFalse(auditor.is_package_license_path(PREFIX + "/share/doc/wget/sub/COPYING", PREFIX, "wget"))
        self.assertFalse(auditor.is_package_license_path(PREFIX + "/share/doc/util-linux/README", PREFIX, "libuuid"))

    def test_private_path_helpers_reject_foreign_app_and_escape(self):
        self.assertEqual(auditor.normalize_prefix(PREFIX), PREFIX)
        with self.assertRaises(auditor.AuditError):
            auditor.normalize_prefix("/data/user/0/com.other.app/files/usr")
        with self.assertRaises(auditor.AuditError):
            auditor.resolve_link(PREFIX + "/share/doc/wget/copyright", "../../../../../etc/passwd", False, PREFIX)


if __name__ == "__main__":
    unittest.main()
