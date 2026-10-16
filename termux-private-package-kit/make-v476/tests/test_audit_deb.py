from __future__ import annotations

import hashlib
import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
AUDITOR = ROOT / "audit_deb.py"
MANIFEST = ROOT / "manifest.json"
APP_PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"
TEST_GPLV3_TEXT = b"GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\nSynthetic auditor fixture only.\n"


def fake_aarch64_elf() -> bytes:
    ident = b"\x7fELF" + bytes([2, 1, 1, 0, 0]) + bytes(7)
    interpreter = b"/system/bin/linker64\0"
    header = struct.pack(
        "<16sHHIQQQIHHHHHH",
        ident, 2, 183, 1, 0, 64, 0, 0, 64, 56, 1, 64, 0, 0,
    )
    program_header = struct.pack(
        "<IIQQQQQQ", 3, 4, 120, 0, 0, len(interpreter), len(interpreter), 1,
    )
    return header + program_header + interpreter


def make_fixture(root: pathlib.Path, *, architecture: str = "aarch64", version: str = "4.4.1-1",
                 wrong_payload_prefix: bool = False, escaping_symlink: bool = False,
                 foreign_string: bool = False, maintainer_script: bool = False,
                 non_elf_make: bool = False, depends: str | None = None,
                 app_home_string: bool = False, foreign_app_private_string: bool = False,
                 noncanonical_android_path: bool = False, missing_license: bool = False,
                 wrong_license_hash: bool = False) -> pathlib.Path:
    package = root / "pkg"
    (package / "DEBIAN").mkdir(parents=True)
    control = [
        "Package: make",
        f"Version: {version}",
        f"Architecture: {architecture}",
        "Maintainer: @termux",
        "Breaks: make-dev",
        "Replaces: make-dev",
        "Conflicts: make-guile",
    ]
    if depends:
        control.append(f"Depends: {depends}")
    control.extend(["Description: synthetic non-installable audit fixture", " Test fixture only.", ""])
    (package / "DEBIAN" / "control").write_text("\n".join(control), encoding="utf-8")
    if maintainer_script:
        (package / "DEBIAN" / "postinst").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        (package / "DEBIAN" / "postinst").chmod(0o755)

    prefix = "/data/data/com.termux/files/usr" if wrong_payload_prefix else APP_PREFIX
    base = package.joinpath(*prefix.lstrip("/").split("/"))
    (base / "bin").mkdir(parents=True)
    make_path = base / "bin" / "make"
    make_path.write_bytes(b"#!/system/bin/sh\necho not-an-elf\n" if non_elf_make else fake_aarch64_elf())
    make_path.chmod(0o755)
    if escaping_symlink:
        os.symlink("../../../../../../tmp/payload-escape", base / "bin" / "make-alias")
    else:
        os.symlink("make", base / "bin" / "gmake")
    docs = base / "share" / "doc" / "make"
    docs.mkdir(parents=True)
    if not missing_license:
        license_text = (b"GNU GENERAL PUBLIC LICENSE\nVersion 3, modified fixture.\n"
                        if wrong_license_hash else TEST_GPLV3_TEXT)
        (docs / "COPYING").write_bytes(license_text)
    if foreign_string:
        (docs / "payload-note.txt").write_text(
            "bad path /data/data/com.termux/files/usr/bin/sh\n", encoding="utf-8"
        )
    if app_home_string:
        (docs / "app-home-note.txt").write_text(
            "private app home /data/user/0/com.karat.aibuilder/files/home/.cache\n", encoding="utf-8"
        )
    if foreign_app_private_string:
        (docs / "foreign-private-note.txt").write_text(
            "unexpected app-private path /data/user/0/com.karat.aibuilder/files/cache\n", encoding="utf-8"
        )
    if noncanonical_android_path:
        (docs / "noncanonical-path-note.txt").write_text(
            "noncanonical path /data/user/0/com.karat.aibuilder/files/usr/../files/home\n", encoding="utf-8"
        )
    deb = root / "fixture.deb"
    subprocess.run(
        ["dpkg-deb", "--build", "--root-owner-group", str(package), str(deb)],
        check=True, capture_output=True, text=True,
    )
    return deb


class AuditDebTests(unittest.TestCase):
    def run_audit(self, deb: pathlib.Path, prefix: str = APP_PREFIX) -> subprocess.CompletedProcess[str]:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        manifest["package"]["sourceLicenseSha256"] = hashlib.sha256(TEST_GPLV3_TEXT).hexdigest()
        temp = tempfile.TemporaryDirectory(prefix="aib-audit-manifest-")
        self.addCleanup(temp.cleanup)
        manifest_path = pathlib.Path(temp.name) / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(AUDITOR), "--manifest", str(manifest_path), "--deb", str(deb), "--prefix", prefix],
            capture_output=True, text=True,
        )

    def fixture_and_audit(self, **kwargs):
        temp = tempfile.TemporaryDirectory(prefix="aib-audit-fixture-")
        self.addCleanup(temp.cleanup)
        deb = make_fixture(pathlib.Path(temp.name), **kwargs)
        return self.run_audit(deb)

    def test_valid_synthetic_aarch64_fixture_passes_static_audit(self):
        result = self.fixture_and_audit()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["package"]["architecture"], "aarch64")
        self.assertEqual(report["package"]["licenseSpdxFromLockedRecipe"], "GPL-3.0")
        self.assertEqual(report["package"]["licenseEvidencePath"], "share/doc/make/COPYING")
        self.assertEqual(report["package"]["licenseEvidenceSha256"], hashlib.sha256(TEST_GPLV3_TEXT).hexdigest())
        self.assertFalse(report["target"]["projectRootInPayload"])
        self.assertEqual(report["elf"][0]["machine"], "AArch64")

    def test_missing_source_copying_file_is_rejected(self):
        result = self.fixture_and_audit(missing_license=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("SOURCE_LICENSE_FILE_MISSING", result.stdout)

    def test_modified_source_copying_hash_is_rejected(self):
        result = self.fixture_and_audit(wrong_license_hash=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("SOURCE_LICENSE_SHA256_MISMATCH", result.stdout)

    def test_wrong_target_prefix_is_rejected(self):
        result = self.fixture_and_audit(wrong_payload_prefix=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("PAYLOAD_OUTSIDE_PRIVATE_PREFIX", result.stdout)

    def test_foreign_com_termux_path_embedded_in_payload_is_rejected(self):
        result = self.fixture_and_audit(foreign_string=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("FOREIGN_ANDROID_APP_PATH", result.stdout)

    def test_exact_app_private_home_path_is_allowed_in_embedded_strings(self):
        result = self.fixture_and_audit(app_home_string=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["target"]["allowedEmbeddedPathRoots"], [APP_PREFIX, "/data/user/0/com.karat.aibuilder/files/home"])

    def test_unrelated_app_private_path_is_rejected(self):
        result = self.fixture_and_audit(foreign_app_private_string=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("FOREIGN_ANDROID_APP_PATH", result.stdout)

    def test_noncanonical_android_path_traversal_is_rejected(self):
        result = self.fixture_and_audit(noncanonical_android_path=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("ANDROID_PATH_NOT_CANONICAL", result.stdout)

    def test_symlink_escape_is_rejected(self):
        result = self.fixture_and_audit(escaping_symlink=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("LINK_ESCAPES_PRIVATE_PREFIX", result.stdout)

    def test_wrong_architecture_is_rejected(self):
        result = self.fixture_and_audit(architecture="amd64")
        self.assertEqual(result.returncode, 2)
        self.assertIn("CONTROL_FIELD_MISMATCH", result.stdout)

    def test_unexpected_maintainer_hook_is_rejected(self):
        result = self.fixture_and_audit(maintainer_script=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("MAINTAINER_SCRIPTS_NOT_ALLOWED_FOR_MAKE", result.stdout)

    def test_wrong_version_is_rejected(self):
        result = self.fixture_and_audit(version="4.4.0-1")
        self.assertEqual(result.returncode, 2)
        self.assertIn("CONTROL_FIELD_MISMATCH", result.stdout)

    def test_unresolved_runtime_dependency_is_rejected(self):
        result = self.fixture_and_audit(depends="libandroid-spawn")
        self.assertEqual(result.returncode, 2)
        self.assertIn("RUNTIME_DEPENDENCY_SET_MISMATCH", result.stdout)

    def test_non_elf_make_is_rejected(self):
        result = self.fixture_and_audit(non_elf_make=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("MAKE_EXECUTABLE_NOT_AARCH64_ELF", result.stdout)


if __name__ == "__main__":
    unittest.main()
