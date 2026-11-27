import importlib.util
import pathlib
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "stage-temporary-aib-profile-artifact.py"
SPEC = importlib.util.spec_from_file_location("stage_temporary_aib_profile_artifact", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
stage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage)


class IdentityFromDebTests(unittest.TestCase):
    def test_returns_bare_values_for_all_six_reported_identities(self):
        cases = [
            (
                "Package: abseil-cpp\nVersion: 20260526.0\nArchitecture: aarch64\n",
                ("abseil-cpp", "20260526.0", "aarch64"),
            ),
            (
                "Package: ca-certificates\nVersion: 1:2026.09.25\nArchitecture: all\n",
                ("ca-certificates", "1:2026.09.25", "all"),
            ),
            (
                "Package: c-ares\nVersion: 1.34.8\nArchitecture: aarch64\n",
                ("c-ares", "1.34.8", "aarch64"),
            ),
            (
                "Package: make\nVersion: 4.4.1-1\nArchitecture: aarch64\n",
                ("make", "4.4.1-1", "aarch64"),
            ),
        ]
        for raw, expected in cases:
            with self.subTest(expected=expected), mock.patch.object(
                stage.subprocess, "check_output", return_value=raw
            ):
                self.assertEqual(stage.identity_from_deb(pathlib.Path("candidate.deb")), expected)

    def test_rejects_malformed_or_misordered_field_labels(self):
        malformed = [
            "Package: sample\nVersion: 1.0\nArch: all\n",
            "Package: sample\nArchitecture: all\nVersion: 1.0\n",
            "Package: sample\nVersion: 1.0\n",
            "Package: sample\nVersion: 1.0\nArchitecture: all\nExtra: value\n",
        ]
        for raw in malformed:
            with self.subTest(raw=raw), mock.patch.object(
                stage.subprocess, "check_output", return_value=raw
            ):
                with self.assertRaisesRegex(SystemExit, "PROFILE_STAGE_REJECTED:INVALID_DEB_IDENTITY"):
                    stage.identity_from_deb(pathlib.Path("invalid.deb"))


if __name__ == "__main__":
    unittest.main()
