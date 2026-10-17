#!/usr/bin/env python3
"""Regression for resetdeps restoring vendor bytes from an archive-only source."""
import pathlib
import subprocess
import tempfile
import unittest

KIT = pathlib.Path(__file__).resolve().parents[1]


class NpmArchiveIndexTests(unittest.TestCase):
    def test_index_restores_vendor_without_creating_source_commit(self):
        with tempfile.TemporaryDirectory(prefix='npm-archive-index-test-') as tmp:
            root = pathlib.Path(tmp)
            payload = root / 'node_modules/vendor/file.js'
            payload.parent.mkdir(parents=True)
            original = b'// pinned archive vendor bytes\n'
            payload.write_bytes(original)
            git = lambda *args, **kwargs: subprocess.run(['git', '-C', tmp, *args], capture_output=True, check=kwargs.get('check', True))
            git('init', '--quiet')
            git('-c', 'core.autocrlf=false', 'add', '--force', '--', 'node_modules')
            git('status')
            payload.unlink()
            git('checkout', 'node_modules/')
            self.assertEqual(payload.read_bytes(), original)
            self.assertNotEqual(git('rev-parse', '--verify', 'HEAD', check=False).returncode, 0)

    def test_patch_keeps_archive_hash_and_scopes_index_to_vendor(self):
        patch = (KIT / 'nodejs-npm-source-provenance.patch').read_text()
        self.assertIn('+TERMUX_PKG_SHA256=590722fbc114915e695814686a0b9996696456b2999c581523b8514d996bfb96', patch)
        added = [line[1:].strip() for line in patch.splitlines() if line.startswith('+') and not line.startswith('+++')]
        self.assertIn('git -C "$TERMUX_PKG_SRCDIR" -c core.autocrlf=false add --force -- node_modules', added)
        self.assertFalse(any('git commit' in line for line in added))
        driver = (KIT / 'build-nodejs-npm-private-aarch64.sh').read_text()
        self.assertIn('debs npm; ./build-package.sh', driver)


if __name__ == '__main__':
    unittest.main()
