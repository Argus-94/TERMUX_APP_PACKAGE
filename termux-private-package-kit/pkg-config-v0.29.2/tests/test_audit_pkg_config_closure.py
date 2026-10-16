from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

KIT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT))
import audit_pkg_config_closure as audit  # noqa: E402


REPO = KIT.parents[1]
MANIFEST = REPO / "pkg-config-candidate-package-set.json"
PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"


class PkgConfigAuditTests(unittest.TestCase):
    def test_locked_manifest_digest_and_exact_package_identities(self) -> None:
        raw = MANIFEST.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), audit.PACKAGE_SET_SHA256)
        manifest = json.loads(raw)
        self.assertEqual(len(manifest["packages"]), audit.PACKAGE_COUNT)
        self.assertEqual({item["name"] for item in manifest["packages"]}, set(audit.EXPECTED_PACKAGES))
        for item in manifest["packages"]:
            self.assertEqual(
                (item["version"], item["architecture"], item["licenseExpression"]),
                audit.EXPECTED_PACKAGES[item["name"]],
            )

    def test_manifest_validates_with_exact_locked_fields(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            closure = pathlib.Path(td) / "closure.json"
            closure.write_bytes(b"test-only closure digest fixture")
            digest = hashlib.sha256(closure.read_bytes()).hexdigest()
            args = argparse.Namespace(package_set=MANIFEST, source_closure=closure, prefix=PREFIX)
            with mock.patch.object(audit, "SOURCE_CLOSURE_SHA256", digest):
                manifest, prefix, specs = audit.validate_manifest(args)
            self.assertEqual(prefix, PREFIX)
            self.assertEqual(len(specs), 22)
            self.assertEqual(manifest["sourceClosure"]["profile"], "pkg-config-candidate")

    def test_only_canonical_app_private_prefix_is_accepted(self) -> None:
        self.assertEqual(audit.normalize_prefix(PREFIX), PREFIX)
        self.assertEqual(audit.normalize_prefix("/data/data/com.karat.aibuilder/files/usr"),
                         "/data/data/com.karat.aibuilder/files/usr")
        for value in (
            "/data/data/com.termux/files/usr",
            "/data/user/0/com.pocketforge/files/usr",
            "/usr",
            "/data/user/0/com.karat.aibuilder/files/usr/../../com.termux",
        ):
            with self.subTest(value=value), self.assertRaises(audit.AuditError):
                audit.normalize_prefix(value)

    def test_payload_path_normalization_rejects_escape_and_ambiguity(self) -> None:
        self.assertEqual(audit.normalize_member("./data/user/0/com.karat.aibuilder/files/usr/bin/pkg-config"),
                         "/data/user/0/com.karat.aibuilder/files/usr/bin/pkg-config")
        for value in (
            "../../etc/passwd",
            "/data/user/0/com.karat.aibuilder/files/usr/bin/pkg-config",
            "data/user/0/com.karat.aibuilder/files/usr/lib/../etc/passwd",
            "data\\user\\0\\com.karat.aibuilder\\files\\usr\\bin\\x",
        ):
            with self.subTest(value=value), self.assertRaises(audit.AuditError):
                audit.normalize_member(value)

    def test_links_must_resolve_inside_private_prefix(self) -> None:
        internal = audit.resolve_link(PREFIX + "/lib/libdemo.so.1", "libdemo.so.1.2", False, PREFIX)
        self.assertEqual(internal, PREFIX + "/lib/libdemo.so.1.2")
        with self.assertRaises(audit.AuditError):
            audit.resolve_link(PREFIX + "/lib/link", "../../../../../../system/bin/sh", False, PREFIX)
        with self.assertRaises(audit.AuditError):
            audit.resolve_link(PREFIX + "/lib/link", "/system/bin/sh", True, PREFIX)

    def test_only_allowed_license_doc_roots_are_recognized(self) -> None:
        self.assertTrue(audit.is_license_doc(PREFIX + "/share/doc/python/LICENSE", "python", PREFIX))
        self.assertTrue(audit.is_license_doc(PREFIX + "/share/doc/ncurses/copyright", "ncurses", PREFIX))
        self.assertTrue(audit.is_license_doc(PREFIX + "/share/doc/ncurses-ui-libs/COPYING", "ncurses-ui-libs", PREFIX))
        self.assertFalse(audit.is_license_doc(PREFIX + "/share/doc/other/LICENSE", "python", PREFIX))
        self.assertFalse(audit.is_license_doc(PREFIX + "/share/doc/ncurses/copyright", "ncurses-ui-libs", PREFIX))
        self.assertFalse(audit.is_license_doc(PREFIX + "/share/doc/ncurses-ui-libs/notes.txt", "ncurses-ui-libs", PREFIX))

    def test_split_ncurses_packages_have_separate_source_pinned_license_copies(self) -> None:
        evidence = audit.EXPECTED_SOURCE_LICENSE_EVIDENCE["ncurses"]
        self.assertEqual(evidence["sourceSha256"], "28cd102efe6a2610e830cc79cf270da6ff0427b2022900a9a36d2761522f9576")
        self.assertEqual(evidence["licensePayloadSha256"], "708999f95527e1ffa670c6fce288c6c600cb477dd04afcc1171422b3dd4ee226")
        self.assertEqual(audit.EXPECTED_LOCAL_LICENSE_PATHS["ncurses"], {"share/doc/ncurses/copyright"})
        self.assertEqual(audit.EXPECTED_LOCAL_LICENSE_PATHS["ncurses-ui-libs"], {"share/doc/ncurses-ui-libs/COPYING"})

    def test_foreign_android_app_paths_are_rejected(self) -> None:
        audit.scan_paths((PREFIX + "/lib/libdemo.so").encode(), PREFIX, "fixture")
        with self.assertRaises(audit.AuditError):
            audit.scan_paths(b"/data/data/com.termux/files/usr/lib/libc.so", PREFIX, "fixture")

    def test_elf_needed_provider_must_be_exact_or_platform_allowlisted(self) -> None:
        records = [
            {"package": "libandroid-posix-semaphore", "path": "lib/libandroid-posix-semaphore.so", "soname": None, "needed": []},
            {"package": "libandroid-support", "path": "lib/libandroid-support.so", "soname": None, "needed": []},
            {"package": "libxml2", "path": "lib/libxml2.so", "soname": "libxml2.so", "needed": []},
            {"package": "pkg-config", "path": "bin/pkg-config", "soname": None, "needed": ["libc.so", "libxml2.so"]},
        ]
        result = audit.validate_elf_needed_providers(records)
        self.assertIn("libxml2.so", result["providers"])
        self.assertEqual(len(result["packageFileProviders"]), 2)
        with self.assertRaises(audit.AuditError):
            audit.validate_elf_needed_providers(records[:-1] + [
                {"package": "pkg-config", "path": "bin/pkg-config", "soname": None, "needed": ["libmissing-private.so"]}
            ])
        with self.assertRaises(audit.AuditError):
            audit.validate_elf_needed_providers(records + [
                {"package": "another", "path": "lib/duplicate.so", "soname": "libxml2.so", "needed": []}
            ])

    def test_pinned_libsqlite_symlink_proves_sqlite_elf_provider(self) -> None:
        records = [
            {"package": "libandroid-posix-semaphore", "path": "lib/libandroid-posix-semaphore.so", "soname": None, "needed": []},
            {"package": "libandroid-support", "path": "lib/libandroid-support.so", "soname": None, "needed": []},
            {"package": "libsqlite", "path": "lib/libsqlite3.so.3.54.0", "soname": "libsqlite3.so.0", "needed": []},
            {"package": "python", "path": "lib/python3.14/lib-dynload/_sqlite3.cpython-314-aarch64-linux-android.so", "soname": None, "needed": ["libsqlite3.so"]},
        ]
        link = {"package": "libsqlite", "path": "lib/libsqlite3.so", "target": "lib/libsqlite3.so.3.54.0"}
        result = audit.validate_elf_needed_providers(records, [link])
        self.assertIn("libsqlite3.so", result["providers"])
        self.assertEqual(result["packageFileSymlinkProviders"][0]["target"], "lib/libsqlite3.so.3.54.0")
        with self.assertRaises(audit.AuditError):
            audit.validate_elf_needed_providers(records, [{**link, "target": "lib/libother.so"}])
        with self.assertRaises(audit.AuditError):
            audit.validate_elf_needed_providers(records[:-2] + [records[-1]], [link])

    def test_release_gate_remains_blocked_in_exact_manifest(self) -> None:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["releaseGate"], {
            "publicationAllowed": False,
            "deviceInstall": "NOT RUN",
            "rollback": "NOT RUN",
            "deviceEvidenceSha256": None,
        })
        self.assertFalse(manifest["baseLicenseProviderEvidence"]["deviceObserved"])


if __name__ == "__main__":
    unittest.main()
