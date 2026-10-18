"""Offline regression tests for OpenJDK 17 source provenance verification."""
import hashlib
import importlib.util
import io
import os
import pathlib
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'verify_openjdk17_sources.py'
SOURCE = pathlib.Path(os.environ.get('AIB_PINNED_SOURCE_ROOT', '/workspace/termux-source-505e06e'))
spec = importlib.util.spec_from_file_location('verify_openjdk17_sources', SCRIPT)
verifier = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = verifier
spec.loader.exec_module(verifier)


class SourceProvenanceTests(unittest.TestCase):
    def test_clean_pinned_source_has_138_recipe_inputs(self):
        self.assertEqual(verifier.verify_inputs(SOURCE), 138)

    def test_lock_hash_tampering_is_rejected(self):
        with mock.patch.object(verifier, 'INPUT_LOCK_SHA', '0' * 64):
            with self.assertRaisesRegex(ValueError, 'INPUT_LOCK_HASH_MISMATCH'):
                verifier.verify_inputs(SOURCE)

    def test_archive_with_wrong_sha_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / 'tiny.tar.gz'
            archive.write_bytes(b'not the pinned archive')
            with self.assertRaisesRegex(ValueError, 'OPENJDK_SOURCE_ARCHIVE_SHA256_MISMATCH'):
                verifier.verify_archive(archive)

    def test_archive_license_hash_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / 'fixture.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                for name in verifier.LICENSE_HASHES:
                    data = ('synthetic fixture: ' + name).encode()
                    info = tarfile.TarInfo('jdk17u-jdk-17.0.20-ga/' + name)
                    info.size = len(data)
                    tar.addfile(info, io.BytesIO(data))
            archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
            bad_hashes = dict(verifier.LICENSE_HASHES)
            bad_hashes['LICENSE'] = '0' * 64
            with mock.patch.object(verifier, 'SOURCE_SHA', archive_hash), \
                    mock.patch.object(verifier, 'LICENSE_HASHES', bad_hashes):
                with self.assertRaisesRegex(ValueError, 'SOURCE_NOTICE_HASH_MISMATCH:LICENSE'):
                    verifier.verify_archive(archive)

    def test_upstream_tag_object_and_commit_mapping(self):
        refs = (f'{verifier.TAG_OBJECT} refs/tags/jdk-17.0.20-ga\n'
                f'{verifier.SOURCE_COMMIT} refs/tags/jdk-17.0.20-ga^{{}}\n')
        actual = {ref: commit for commit, ref in (line.split() for line in refs.splitlines())}
        self.assertEqual(actual, {
            'refs/tags/jdk-17.0.20-ga': verifier.TAG_OBJECT,
            'refs/tags/jdk-17.0.20-ga^{}': verifier.SOURCE_COMMIT,
        })
        self.assertNotEqual(actual['refs/tags/jdk-17.0.20-ga'],
                            actual['refs/tags/jdk-17.0.20-ga^{}'])


if __name__ == '__main__':
    unittest.main()
