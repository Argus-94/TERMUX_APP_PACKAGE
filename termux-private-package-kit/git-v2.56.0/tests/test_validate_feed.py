import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "validate_feed.py"
SPEC = importlib.util.spec_from_file_location("git_closure_feed_validator", MODULE_PATH)
validator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(validator)


class DebIdentityParserTests(unittest.TestCase):
    def test_parses_labelled_fields_and_ignores_description_continuations(self):
        text = (
            "Package: git\n"
            "Version: 2.56.0\n"
            "Architecture: aarch64\n"
            "Description: Git version control\n"
            " extended description\n"
        )
        self.assertEqual(validator.parse_deb_identity(text), ("git", "2.56.0", "aarch64"))

    def test_duplicate_identity_field_is_rejected(self):
        with self.assertRaises(validator.GateError):
            validator.parse_deb_identity("Package: git\nPackage: fake\nVersion: 2.56.0\nArchitecture: aarch64\n")

    def test_missing_identity_field_is_rejected(self):
        with self.assertRaises(validator.GateError):
            validator.parse_deb_identity("Package: git\nVersion: 2.56.0\n")


if __name__ == "__main__":
    unittest.main()
