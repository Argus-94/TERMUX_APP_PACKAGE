import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "audit_closure.py"
SPEC = importlib.util.spec_from_file_location("git_closure_auditor", MODULE_PATH)
auditor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(auditor)

PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"


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


if __name__ == "__main__":
    unittest.main()
