import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "validate_wget_feed.py"
SPEC = importlib.util.spec_from_file_location("wget_feed_validator", MODULE_PATH)
validator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(validator)


class PackageIndexParserTests(unittest.TestCase):
    def test_parses_identity_and_dependency_continuation(self):
        records = validator.package_records_from_text(
            "Package: wget\nVersion: 1.25.0-1\nArchitecture: aarch64\n"
            "Depends: libandroid-support, libiconv,\n openssl, zlib\n"
            "Description: downloader\n continuation text\n\n"
        )
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["Package"], "wget")
        self.assertEqual(records[0]["Depends"], "libandroid-support, libiconv, openssl, zlib")
        self.assertEqual(records[0]["Description"], "downloader continuation text")

    def test_duplicate_field_is_rejected(self):
        with self.assertRaises(ValueError):
            validator.package_records_from_text("Package: wget\nVersion: 1\nVersion: 2\n\n")

    def test_orphan_continuation_is_rejected(self):
        with self.assertRaises(ValueError):
            validator.package_records_from_text(" orphan\n\n")


if __name__ == "__main__":
    unittest.main()
