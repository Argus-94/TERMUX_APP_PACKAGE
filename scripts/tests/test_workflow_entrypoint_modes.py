#!/usr/bin/env python3
"""Catch the actual signed APT entrypoint permission regression before compilation."""
import os
import pathlib
import stat
import unittest
ROOT = pathlib.Path(__file__).resolve().parents[2]

class WorkflowEntrypointModesTests(unittest.TestCase):
    def test_signed_apt_entrypoint_is_executable_in_checkout(self):
        rel = 'scripts/test-apt-candidate.sh'
        callers = [p for p in (ROOT / '.github/workflows').glob('*package*candidate*.yml')
                   if './' + rel in p.read_text()]
        self.assertGreaterEqual(len(callers), 9)
        path = ROOT / rel
        self.assertFalse(path.is_symlink())
        self.assertTrue(path.is_file() and stat.S_ISREG(path.stat().st_mode))
        self.assertTrue(path.stat().st_mode & 0o111 and os.access(path, os.X_OK),
                        rel + ' must be executable: package workflows invoke it directly')

if __name__ == '__main__':
    unittest.main()
