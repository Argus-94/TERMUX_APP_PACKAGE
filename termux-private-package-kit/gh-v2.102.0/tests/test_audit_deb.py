import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "audit_deb.py"
SPEC = importlib.util.spec_from_file_location("aib_gh_audit", SCRIPT)
assert SPEC and SPEC.loader
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)

PREFIX = "/data/user/0/com.karat.aibuilder/files/usr"


class GhAuditTests(unittest.TestCase):
    def test_only_canonical_builder_prefix_is_accepted(self):
        self.assertEqual(AUDIT.normalize_prefix(PREFIX), PREFIX)
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.normalize_prefix("/data/user/0/com.termux/files/usr")

    def test_payload_paths_are_confined_and_normalized(self):
        self.assertEqual(AUDIT.normalize_payload_path("./data/user/0/com.karat.aibuilder/files/usr/bin/gh"),
                         "/data/user/0/com.karat.aibuilder/files/usr/bin/gh")
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.normalize_payload_path("./data/user/0/com.karat.aibuilder/files/usr/../other")
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.resolve_link(PREFIX + "/bin/gh", "../../../../outside", hardlink=False, prefix=PREFIX)
        self.assertEqual(AUDIT.resolve_link(PREFIX + "/share/doc/gh/copy", "." + PREFIX + "/bin/gh",
                                             hardlink=True, prefix=PREFIX), PREFIX + "/bin/gh")

    def test_only_modeled_prefix_ancestor_directories_are_allowed(self):
        AUDIT.validate_payload_location("/data", PREFIX, is_directory=True)
        AUDIT.validate_payload_location(PREFIX + "/share/doc/gh", PREFIX, is_directory=True)
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.validate_payload_location("/data/user/0/com.termux", PREFIX, is_directory=True)
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.validate_payload_location("/data", PREFIX, is_directory=False)

    def test_postinst_is_exact_and_app_private(self):
        script = AUDIT.expected_postinst(PREFIX)
        self.assertEqual(script.count(b"\n"), 4)
        self.assertIn((PREFIX + "/bin/sh").encode(), script)
        self.assertNotIn(b"com.termux", script)
        self.assertIn((PREFIX + "/share/fish/vendor_completions.d/gh.fish").encode(), script)

    def test_control_requires_zero_depends_and_only_openssh_recommendation(self):
        good = (b"Package: gh\nVersion: 2.102.0\nArchitecture: aarch64\n"
                b"Maintainer: Example Maintainer\nDescription: GitHub CLI\nRecommends: openssh\n")
        parsed = AUDIT.parse_control(good)
        self.assertEqual(parsed.get("Package"), "gh")
        bad = good + b"Depends: libcurl\n"
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.parse_control(bad)
        bad_recommendation = good.replace(b"Recommends: openssh", b"Recommends: openssh, git")
        with self.assertRaises(AUDIT.AuditError):
            AUDIT.parse_control(bad_recommendation)


if __name__ == "__main__":
    unittest.main()
