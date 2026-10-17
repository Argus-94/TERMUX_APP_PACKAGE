from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import unittest

KIT = pathlib.Path(__file__).resolve().parents[1]
REPO = KIT.parents[1]
sys.path.insert(0, str(KIT))
import audit_python_closure as audit  # noqa: E402

MANIFEST = REPO / "python-candidate-package-set.json"
SOURCE_CLOSURE = REPO / "toolchain-candidate-source-closures/python-candidate.json"
PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"


class PythonAuditTests(unittest.TestCase):
    def test_locked_manifest_and_source_closure_hashes(self) -> None:
        self.assertEqual(hashlib.sha256(MANIFEST.read_bytes()).hexdigest(), audit.PACKAGE_SET_SHA256)
        self.assertEqual(hashlib.sha256(SOURCE_CLOSURE.read_bytes()).hexdigest(), audit.SOURCE_CLOSURE_SHA256)
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        closure = json.loads(SOURCE_CLOSURE.read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["packages"]), 17)
        self.assertEqual({item["name"] for item in manifest["packages"]}, set(audit.EXPECTED_PACKAGES))
        self.assertEqual(closure["rootPackages"], ["python"])
        self.assertEqual(closure["packageCount"], 17)
        for item in manifest["packages"]:
            self.assertEqual(
                (item["version"], item["architecture"], item["licenseExpression"]),
                audit.EXPECTED_PACKAGES[item["name"]],
            )

    def test_manifest_validates_against_pinned_metadata(self) -> None:
        args = argparse.Namespace(package_set=MANIFEST, source_closure=SOURCE_CLOSURE, prefix=PREFIX)
        manifest, prefix, specs = audit.validate_manifest(args)
        self.assertEqual(prefix, PREFIX)
        self.assertEqual(len(specs), 17)
        self.assertEqual(manifest["sourceClosure"]["profile"], "python-candidate")
        self.assertEqual(manifest["runtimeDependencies"]["buildOnlyDependencies"], ["tk"])
        self.assertNotIn("python-tkinter", {item["name"] for item in specs})

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

    def test_payload_paths_links_and_embedded_android_paths_fail_closed(self) -> None:
        self.assertEqual(audit.normalize_member("./data/user/0/com.karat.aibuilder/files/usr/bin/python3.14"),
                         "/data/user/0/com.karat.aibuilder/files/usr/bin/python3.14")
        for value in ("../../etc/passwd", "/data/user/0/com.karat.aibuilder/files/usr/bin/python",
                      "data/user/0/com.karat.aibuilder/files/usr/lib/../etc/passwd", "data\\user\\0\\x"):
            with self.subTest(value=value), self.assertRaises(audit.AuditError):
                audit.normalize_member(value)
        self.assertEqual(audit.resolve_link(PREFIX + "/bin/python", "python3.14", False, PREFIX),
                         PREFIX + "/bin/python3.14")
        with self.assertRaises(audit.AuditError):
            audit.resolve_link(PREFIX + "/bin/escape", "../../../../system/bin/sh", False, PREFIX)
        audit.scan_paths((PREFIX + "/lib/python3.14/site.py").encode(), PREFIX, "fixture")
        with self.assertRaises(audit.AuditError):
            audit.scan_paths(b"/data/data/com.termux/files/usr/lib/libc.so", PREFIX, "fixture")

    def test_python_and_ncurses_source_license_evidence_is_pinned(self) -> None:
        self.assertEqual(audit.EXPECTED_SOURCE_LICENSE_EVIDENCE["python"]["sourceSha256"],
                         "143b1dddefaec3bd2e21e3b839b34a2b7fb9842272883c576420d605e9f30c63")
        self.assertEqual(audit.EXPECTED_SOURCE_LICENSE_EVIDENCE["ncurses"]["licensePayloadSha256"],
                         "708999f95527e1ffa670c6fce288c6c600cb477dd04afcc1171422b3dd4ee226")
        self.assertEqual(audit.EXPECTED_LOCAL_LICENSE_PATHS["python"], {"share/doc/python/LICENSE"})
        self.assertTrue(audit.is_license_doc(PREFIX + "/share/doc/python/LICENSE", "python", PREFIX))
        self.assertFalse(audit.is_license_doc(PREFIX + "/share/doc/python/notes.txt", "python", PREFIX))

    def test_required_package_file_and_sqlite_symlink_providers(self) -> None:
        records = [
            {"package": "libandroid-posix-semaphore", "path": "lib/libandroid-posix-semaphore.so", "soname": None, "needed": []},
            {"package": "libandroid-support", "path": "lib/libandroid-support.so", "soname": None, "needed": []},
            {"package": "libsqlite", "path": "lib/libsqlite3.so.3.54.0", "soname": "libsqlite3.so.0", "needed": []},
            {"package": "python", "path": "lib/python3.14/lib-dynload/_sqlite3.cpython-314-aarch64-linux-android.so",
             "soname": None, "needed": ["libsqlite3.so"]},
        ]
        link = {"package": "libsqlite", "path": "lib/libsqlite3.so", "target": "lib/libsqlite3.so.3.54.0"}
        result = audit.validate_elf_needed_providers(records, [link])
        self.assertIn("libsqlite3.so", result["providers"])
        self.assertEqual(result["packageFileSymlinkProviders"][0]["target"], "lib/libsqlite3.so.3.54.0")
        with self.assertRaises(audit.AuditError):
            audit.validate_elf_needed_providers(records[:-2] + [records[-1]], [link])
        with self.assertRaises(audit.AuditError):
            audit.validate_elf_needed_providers(records, [{**link, "target": "lib/libother.so"}])

    def test_installation_and_publication_gates_remain_blocked(self) -> None:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["releaseGate"], {
            "publicationAllowed": False,
            "deviceInstall": "NOT RUN",
            "rollback": "NOT RUN",
            "deviceEvidenceSha256": None,
        })
        self.assertFalse(manifest["baseLicenseProviderEvidence"]["deviceObserved"])
        self.assertNotIn("tk", {item["name"] for item in manifest["packages"]})
        self.assertNotIn("python-pip", {item["name"] for item in manifest["packages"]})


if __name__ == "__main__":
    unittest.main()
