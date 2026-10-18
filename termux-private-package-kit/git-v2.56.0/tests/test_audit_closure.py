import hashlib
import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "audit_closure.py"
SPEC = importlib.util.spec_from_file_location("git_closure_auditor", MODULE_PATH)
auditor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(auditor)

PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"
LESS_FILES = {
    "share/doc/less/COPYING": "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
    "share/doc/less/LICENSE": "0f94cd7f9b1d122522e1b988e42be49c88a997781494615113e7bbcf28d2c952",
}


class OverlayPolicyTests(unittest.TestCase):
    def test_build_script_hash_is_reviewed(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        builder = root / "build-git-private-aarch64.sh"
        self.assertEqual(hashlib.sha256(builder.read_bytes()).hexdigest(), "a94dd2c147bc427f74dd25cde324423e784d554da5c4717ac2bc7c04e5863667")
    def test_local_recipe_overlays_are_pinned_in_candidate_manifest(self):
        root = pathlib.Path(__file__).resolve().parents[3]
        manifest = __import__("json").loads((root / "git-candidate-package-set.json").read_text())
        specs = {x["name"]: x for x in manifest["packages"]}
        for name, patch_name, expected in (
            ("libcurl", "libcurl-disable-optional-zstd.patch", "69ddb473018aa7bc6500350d8dbbda309393c62a3956d2ddad3d8f4f4d07c788"),
            ("ncurses", "ncurses-ui-libs-license.patch", "f29765e65520dacedb70c79e6156ffa247e47849c982d0e233ed4a88817876c9"),
        ):
            spec = specs[name]
            patch = root / spec["localRecipePatchPath"]
            self.assertEqual(spec["localRecipePatchSha256"], expected)
            self.assertEqual(hashlib.sha256(patch.read_bytes()).hexdigest(), expected)

class PrivatePathTests(unittest.TestCase):
    def test_only_canonical_builder_prefixes_are_accepted(self):
        self.assertEqual(auditor.normalize_prefix(PREFIX), PREFIX)
        with self.assertRaises(auditor.AuditError):
            auditor.normalize_prefix("/data/user/0/com.other.app/files/usr")

    def test_payload_paths_reject_traversal_and_absolute_archive_names(self):
        with self.assertRaises(auditor.AuditError):
            auditor.normalize_member("../../etc/passwd")
        with self.assertRaises(auditor.AuditError):
            auditor.normalize_member("/data/user/0/com.karat.aibuilder/files/usr/bin/git")

    def test_only_ancestor_directories_or_prefix_descendants_are_allowed(self):
        auditor.ensure_payload_path("/data", PREFIX, True)
        auditor.ensure_payload_path(PREFIX + "/bin/git", PREFIX, False)
        with self.assertRaises(auditor.AuditError):
            auditor.ensure_payload_path("/data/user/0/com.other.app", PREFIX, True)
        with self.assertRaises(auditor.AuditError):
            auditor.ensure_payload_path("/etc/passwd", PREFIX, False)

    def test_symlinks_must_resolve_inside_private_prefix(self):
        resolved = auditor.resolve_link(PREFIX + "/share/doc/git/copyright", "../../LICENSES/GPL-2.0.txt", False, PREFIX)
        self.assertEqual(resolved, PREFIX + "/share/LICENSES/GPL-2.0.txt")
        with self.assertRaises(auditor.AuditError):
            auditor.resolve_link(PREFIX + "/bin/git", "../../../../etc/passwd", False, PREFIX)
        with self.assertRaises(auditor.AuditError):
            auditor.resolve_link(PREFIX + "/bin/git", "/system/bin/sh", False, PREFIX)

    def test_embedded_android_app_paths_must_be_builder_private(self):
        auditor.scan_paths((PREFIX + "/bin/git").encode(), PREFIX, "git:bin/git")
        with self.assertRaises(auditor.AuditError):
            auditor.scan_paths(b"/data/user/0/com.termux/files/usr/bin/git", PREFIX, "git:bad")
        with self.assertRaises(auditor.AuditError):
            auditor.scan_paths(b"/storage/emulated/0/AIBuilderTermux/project", PREFIX, "git:bad")


class LicenseEvidenceTests(unittest.TestCase):
    def less_spec(self):
        return {
            "name": "less",
            "sourceUrl": "https://www.greenwoodsoftware.com/less/less-710.tar.gz",
            "sourceSha256": "d1008fb78dcae1323ddab664bcb352a61f022b1b131bd8018548e021d975ec7a",
            "licenseEvidenceSha256": dict(LESS_FILES),
        }

    def test_less_license_evidence_is_exactly_pinned_to_source_archive(self):
        self.assertEqual(auditor.expected_source_license_files(self.less_spec()), LESS_FILES)

    def test_wrong_less_source_archive_or_license_hash_is_rejected(self):
        wrong_source = self.less_spec()
        wrong_source["sourceSha256"] = "0" * 64
        with self.assertRaises(auditor.AuditError):
            auditor.expected_source_license_files(wrong_source)
        wrong_file = self.less_spec()
        wrong_file["licenseEvidenceSha256"]["share/doc/less/LICENSE"] = "0" * 64
        with self.assertRaises(auditor.AuditError):
            auditor.expected_source_license_files(wrong_file)
        missing_file = self.less_spec()
        del missing_file["licenseEvidenceSha256"]["share/doc/less/LICENSE"]
        with self.assertRaises(auditor.AuditError):
            auditor.expected_source_license_files(missing_file)

    def test_other_packages_cannot_add_unreviewed_license_evidence(self):
        with self.assertRaises(auditor.AuditError):
            auditor.expected_source_license_files({"name": "git", "licenseEvidenceSha256": dict(LESS_FILES)})

    def test_pinned_license_payload_hash_is_verified(self):
        content = b"exact fixture license bytes"
        expected = {"share/doc/less/LICENSE": hashlib.sha256(content).hexdigest()}
        self.assertEqual(
            auditor.verify_pinned_license_payload("less", "share/doc/less/LICENSE", content, expected),
            expected["share/doc/less/LICENSE"],
        )
        with self.assertRaises(auditor.AuditError):
            auditor.verify_pinned_license_payload("less", "share/doc/less/LICENSE", b"tampered", expected)
        self.assertIsNone(auditor.verify_pinned_license_payload("less", "share/doc/less/OTHER", content, expected))


if __name__ == "__main__":
    unittest.main()
