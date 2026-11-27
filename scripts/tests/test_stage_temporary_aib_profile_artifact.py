import importlib.util
import pathlib
import tarfile
import tempfile
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


class ProfileArchiveTests(unittest.TestCase):
    def test_colon_epoch_deb_is_preserved_inside_safe_outer_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            stage_dir = root / "stage"
            packages = stage_dir / "packages"
            packages.mkdir(parents=True)
            filename = "ca-certificates_1:2026.09.25_all.deb"
            original_bytes = b"fixture-deb-bytes-with-epoch\x00\xff"
            (packages / filename).write_bytes(original_bytes)
            archive_path = root / "python.tar.gz"

            result = stage.create_profile_archive(stage_dir, archive_path)

            self.assertEqual(result, archive_path)
            self.assertTrue(archive_path.name.endswith(".tar.gz"))
            self.assertNotIn(":", archive_path.name)
            with tarfile.open(archive_path, "r:gz") as archive:
                member = archive.getmember(f"packages/{filename}")
                with archive.extractfile(member) as payload:
                    self.assertEqual(payload.read(), original_bytes)

    def test_outer_archive_name_with_colon_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            stage_dir = root / "stage"
            stage_dir.mkdir()
            with self.assertRaisesRegex(SystemExit, "PROFILE_STAGE_REJECTED:ARCHIVE_FILENAME_UNSAFE"):
                stage.create_profile_archive(stage_dir, root / "profile:unsafe.tar.gz")

    def test_workflow_uploads_only_safe_outer_archive(self):
        repo = pathlib.Path(__file__).resolve().parents[2]
        workflow = (repo / ".github/workflows/temporary-aib-v525-arm64-closure.yml").read_text()
        self.assertIn('--archive-out "$RUNNER_TEMP/aib-v525-profile-stage/$PROFILE_ID.tar.gz"', workflow)
        self.assertIn(
            "path: ${{ runner.temp }}/aib-v525-profile-stage/${{ matrix.profile }}.tar.gz",
            workflow,
        )


if __name__ == "__main__":
    unittest.main()
