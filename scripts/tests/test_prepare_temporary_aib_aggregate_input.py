import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "prepare-temporary-aib-aggregate-input.py"
SPEC = importlib.util.spec_from_file_location("prepare_temporary_aib_aggregate_input", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
aggregate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(aggregate)


class DebIdentityTests(unittest.TestCase):
    def test_returns_bare_values_for_reported_closure_identities(self):
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
                aggregate.subprocess, "check_output", return_value=raw
            ):
                self.assertEqual(aggregate.deb_identity(pathlib.Path("candidate.deb")), expected)

    def test_rejects_malformed_or_misordered_field_labels(self):
        malformed = [
            "Package: sample\nVersion: 1.0\nArch: all\n",
            "Package: sample\nArchitecture: all\nVersion: 1.0\n",
            "Package: sample\nVersion: 1.0\n",
            "Package: sample\nVersion: 1.0\nArchitecture: all\nExtra: value\n",
        ]
        for raw in malformed:
            with self.subTest(raw=raw), mock.patch.object(
                aggregate.subprocess, "check_output", return_value=raw
            ):
                with self.assertRaisesRegex(SystemExit, "AGGREGATE_INPUT_REJECTED:INVALID_DEB_IDENTITY"):
                    aggregate.deb_identity(pathlib.Path("invalid.deb"))


class ProfileArchiveTests(unittest.TestCase):
    def test_unpack_preserves_colon_epoch_deb_filename_and_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            artifact_root = root / "downloaded"
            artifact_dir = artifact_root / "aib-v525-profile-openjdk17-123456"
            artifact_dir.mkdir(parents=True)
            archive_path = artifact_dir / "openjdk17.tar.gz"
            filename = "ca-certificates_1:2026.09.25_all.deb"
            original_bytes = b"fixture-deb-bytes-with-epoch\x00\xff"
            with tarfile.open(archive_path, "w:gz") as archive:
                package_dir = tarfile.TarInfo("packages")
                package_dir.type = tarfile.DIRTYPE
                archive.addfile(package_dir)
                for name in sorted(aggregate.PROFILE_EVIDENCE_FILES):
                    data = b"{}\n"
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
                deb = tarfile.TarInfo(f"packages/{filename}")
                deb.size = len(original_bytes)
                archive.addfile(deb, io.BytesIO(original_bytes))

            unpacked = aggregate.unpack_profile_artifacts(
                artifact_root, {"openjdk17"}, root / "unpacked"
            )
            result = unpacked / "openjdk17" / "packages" / filename
            self.assertTrue(result.is_file())
            self.assertEqual(result.name, filename)
            self.assertEqual(result.read_bytes(), original_bytes)

    def test_rejects_archive_member_path_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive_path = root / "python.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                data = b"escape"
                member = tarfile.TarInfo("../escape.deb")
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            with self.assertRaisesRegex(SystemExit, "AGGREGATE_INPUT_REJECTED:PROFILE_ARCHIVE_MEMBER_PATH_INVALID"):
                aggregate.safe_extract_profile_archive(archive_path, root / "out")

    def test_rejects_normalized_dot_segment_archive_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            archive_path = root / "python.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                data = b"dot-segment"
                member = tarfile.TarInfo("packages/./escape.deb")
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            with self.assertRaisesRegex(SystemExit, "AGGREGATE_INPUT_REJECTED:PROFILE_ARCHIVE_MEMBER_PATH_INVALID"):
                aggregate.safe_extract_profile_archive(archive_path, root / "out")

    def test_rejects_symlinked_artifact_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            target = root / "real-artifacts"
            target.mkdir()
            alias = root / "artifact-link"
            alias.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(SystemExit, "AGGREGATE_INPUT_REJECTED:PROFILE_ARTIFACT_ROOT_INVALID"):
                aggregate.unpack_profile_artifacts(alias, set(), root / "out")


if __name__ == "__main__":
    unittest.main()
