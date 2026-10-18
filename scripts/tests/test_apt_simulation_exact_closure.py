#!/usr/bin/env python3
"""Exercise the APT simulation parser with mocked metadata; no debs are created."""
import contextlib
import io
import pathlib
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/test-apt-candidate.sh'


class ExactSimulationTests(unittest.TestCase):
    def run_parser(self, simulation, packages):
        helper = HELPER.read_text()
        code = helper.split('import pathlib,re,subprocess,sys\n', 1)[1].split('\nPY\n', 1)[0]
        code = 'import pathlib,re,subprocess,sys\n' + code
        with tempfile.TemporaryDirectory() as temp:
            log = pathlib.Path(temp) / 'simulation.log'
            log.write_text(simulation)
            files = [pathlib.Path(temp) / (str(i) + '.deb') for i in range(len(packages))]
            identities = dict(zip(map(str, files), packages))
            def metadata(command, **kwargs):
                name, version = identities[command[2]]
                return (name if command[3] == 'Package' else version) + '\n'
            with mock.patch('sys.argv', ['parser', str(log), temp]), \
                 mock.patch.object(pathlib.Path, 'rglob', return_value=iter(files)), \
                 mock.patch('subprocess.check_output', side_effect=metadata), \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                exec(compile(code, str(HELPER), 'exec'), {})
                return output.getvalue()

    def test_exact_node_npm_set(self):
        output = self.run_parser('Inst nodejs (26.4.0-1 localhost [aarch64])\nInst npm (11.20.0 localhost [all])\n', [('nodejs', '26.4.0-1'), ('npm', '11.20.0')])
        self.assertIn('packages=2', output)

    def test_exact_independent_cmake_ninja_roots(self):
        output = self.run_parser('Inst cmake (4.4.4 localhost [aarch64])\nInst ninja (1.13.2 localhost [aarch64])\n', [('cmake', '4.4.4'), ('ninja', '1.13.2')])
        self.assertIn('packages=2', output)

    def test_missing_independent_ninja_root_rejected(self):
        with self.assertRaisesRegex(SystemExit, 'EXACT_CLOSURE_MISMATCH'):
            self.run_parser('Inst cmake (4.4.4 localhost [aarch64])\n', [('cmake', '4.4.4'), ('ninja', '1.13.2')])

    def test_wrong_provider_rejected(self):
        with self.assertRaisesRegex(SystemExit, 'EXACT_CLOSURE_MISMATCH'):
            self.run_parser('Inst nodejs-lts (24.18.0 localhost [aarch64])\n', [('nodejs', '26.4.0-1')])

    def test_missing_package_rejected(self):
        with self.assertRaisesRegex(SystemExit, 'EXACT_CLOSURE_MISMATCH'):
            self.run_parser('', [('npm', '11.20.0')])

    def test_version_drift_rejected(self):
        with self.assertRaisesRegex(SystemExit, 'EXACT_CLOSURE_MISMATCH'):
            self.run_parser('Inst npm (11.20.1 localhost [all])\n', [('npm', '11.20.0')])

    def test_duplicate_inst_rejected(self):
        with self.assertRaisesRegex(SystemExit, 'RECORD_INVALID'):
            self.run_parser('Inst npm (11.20.0 localhost [all])\nInst npm (11.20.0 localhost [all])\n', [('npm', '11.20.0')])

    def test_duplicate_source_rejected(self):
        with self.assertRaisesRegex(SystemExit, 'SOURCE_PACKAGE_DUPLICATE'):
            self.run_parser('', [('npm', '11.20.0'), ('npm', '11.20.0')])

    def test_qualified_architecture(self):
        self.assertIn('packages=1', self.run_parser('Inst nodejs:aarch64 (26.4.0-1 localhost [aarch64])\n', [('nodejs', '26.4.0-1')]))

    def test_malformed_inst_rejected(self):
        with self.assertRaisesRegex(SystemExit, 'RECORD_INVALID'):
            self.run_parser('Inst npm unexpected\n', [('npm', '11.20.0')])


if __name__ == '__main__':
    unittest.main()
