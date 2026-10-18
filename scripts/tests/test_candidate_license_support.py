import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import textwrap
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / 'build-candidate-license-support.py'
spec = importlib.util.spec_from_file_location('builder', SCRIPT)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.pkg = self.root / 'source/packages/termux-licenses'
        (self.pkg / 'LICENSES').mkdir(parents=True)
        (self.pkg / 'LICENSES/GPL-3.0.txt').write_text('fixture complete GPL text\n')
        (self.pkg / 'LICENSES/Other.txt').write_text('fixture license\n')
        (self.pkg / 'build.sh').write_text(
            'TERMUX_PKG_VERSION=2.2\n'
            'termux_step_make_install() { mkdir -p "$TERMUX_PREFIX/share/LICENSES"; '
            'for LICENSE in "$TERMUX_PKG_BUILDER_DIR/LICENSES/"*.txt; do '
            'cp -df "$LICENSE" "$TERMUX_PREFIX/share/LICENSES/"; done; }\n'
        )
        self.lock = {'packageTree': builder.tree(self.pkg), 'recipeText': (self.pkg / 'build.sh').read_text()}

    def tearDown(self):
        self.temp.cleanup()

    def verify_fixture(self):
        if builder.tree(self.pkg) != self.lock['packageTree']:
            raise ValueError('locked fixture package tree mismatch')
        if (self.pkg / 'build.sh').read_text() != self.lock['recipeText']:
            raise ValueError('locked fixture recipe mismatch')

    def build_pair(self):
        self.verify_fixture()
        first, second = self.root / 'a.deb', self.root / 'b.deb'
        builder.make_deb(self.pkg, 1700000000, first)
        builder.make_deb(self.pkg, 1700000000, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        return first

    def test_real_deb_metadata_extract_and_archive_paths_and_modes(self):
        deb = self.build_pair()
        fields = {
            key: subprocess.check_output(['dpkg-deb', '-f', str(deb), key], text=True).strip()
            for key in ('Package', 'Version', 'Architecture')
        }
        self.assertEqual(fields, {'Package': 'termux-licenses', 'Version': '2.2', 'Architecture': 'all'})
        control_dir = self.root / 'control-extracted'
        subprocess.run(['dpkg-deb', '-e', str(deb), str(control_dir)], check=True)
        self.assertTrue((control_dir / 'control').is_file())
        self.assertFalse((control_dir / 'DEBIAN').exists())
        control_tar = self.root / 'control.tar.gz'
        control_tar.write_bytes(subprocess.check_output(['ar', 'p', str(deb), 'control.tar.gz']))
        self.assertEqual(subprocess.check_output(['tar', '-tzf', str(control_tar)], text=True).splitlines(), ['control'])
        extracted = self.root / 'extracted'
        subprocess.run(['dpkg-deb', '-x', str(deb), str(extracted)], check=True)
        self.assertEqual((extracted / builder.PREFIX / 'share/LICENSES/GPL-3.0.txt').read_text(), 'fixture complete GPL text\n')
        data_tar = self.root / 'data.tar.gz'
        data_tar.write_bytes(subprocess.check_output(['ar', 'p', str(deb), 'data.tar.gz']))
        members = subprocess.check_output(['tar', '-tvzf', str(data_tar)], text=True).splitlines()
        names = [line.split()[-1].rstrip('/') for line in members]
        self.assertIn(builder.PREFIX, names)
        ancestors = {'data', 'data/user', 'data/user/0', 'data/user/0/com.karat.aibuilder',
                     'data/user/0/com.karat.aibuilder/files'}
        self.assertFalse(ancestors.intersection(names))
        self.assertTrue(all('com.termux' not in name for name in names))
        for line in members:
            mode, name = line.split()[0], line.split()[-1]
            if name.endswith('/'):
                self.assertEqual(mode, 'drwx------')
            else:
                self.assertEqual(mode, '-rw-r--r--')
        self.assertIn(builder.PREFIX + '/share/doc/termux-licenses/copyright', names)

    def test_modified_fixture_rejected(self):
        (self.pkg / 'LICENSES/Other.txt').write_text('edited')
        with self.assertRaises(ValueError):
            self.verify_fixture()
        (self.pkg / 'LICENSES/Other.txt').write_text('fixture license\n')
        (self.pkg / 'build.sh').write_text('changed recipe')
        with self.assertRaises(ValueError):
            self.verify_fixture()

    def test_private_prefix_and_unexpected_tree_entries(self):
        self.assertNotIn('/data/data/', builder.PREFIX)
        self.assertNotIn('/data/user/0/com.termux/', builder.PREFIX)
        (self.pkg / 'unexpected').write_text('foreign')
        with self.assertRaises(ValueError):
            self.verify_fixture()

    def workflow_python(self, number):
        workflow = (SCRIPT.parents[1] / '.github/workflows/license-support-candidate.yml').read_text()
        block = workflow.split("          python3 - <<'PY'\n")[number].split('          PY\n', 1)[0]
        return textwrap.dedent(block)

    def test_actual_workflow_image_guard(self):
        lock = json.loads((SCRIPT.parents[1] / 'candidate-license-support-lock.json').read_text())
        for image, valid in ((lock['builderImageDigest'], True), ('ghcr.io/termux/package-builder:latest', False)):
            result = subprocess.run(['python3', '-c', self.workflow_python(1)],
                                    cwd=SCRIPT.parents[1], env={**os.environ, 'IMAGE': image}, capture_output=True)
            self.assertEqual(result.returncode == 0, valid, result.stderr.decode())

    def test_actual_workflow_provenance_contract_with_test_only_deb(self):
        # This is an ephemeral TEST fixture, never a candidate or retained artifact.
        deb = self.build_pair()
        out = self.root / 'test-only-bundle'
        (out / 'packages').mkdir(parents=True)
        (out / 'packages/termux-licenses_2.2_all.deb').write_bytes(deb.read_bytes())
        (self.root / 'reproducible-sha256.txt').write_text(builder.sha(deb) + '\n')
        lock = json.loads((SCRIPT.parents[1] / 'candidate-license-support-lock.json').read_text())
        result = subprocess.run(['python3', '-c', self.workflow_python(2)], cwd=SCRIPT.parents[1],
                                env={**os.environ, 'OUT': str(out), 'RUNNER_TEMP': str(self.root),
                                     'REPO_COMMIT': '0' * 40, 'SOURCE_COMMIT': lock['sourceCommit'],
                                     'IMAGE': lock['builderImageDigest']}, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        provenance = json.loads((out / 'provenance.json').read_text())
        self.assertEqual(provenance['builderImageDigest'], lock['builderImageDigest'])
        self.assertEqual(provenance['packageSha256'], provenance['repeatBuildSha256'])
        self.assertIs(provenance['repeatBuildMatch'], True)
        self.assertIs(provenance['productionAllowed'], False)
        self.assertIs(provenance['noAndroidInstallation'], True)


if __name__ == '__main__':
    unittest.main()
