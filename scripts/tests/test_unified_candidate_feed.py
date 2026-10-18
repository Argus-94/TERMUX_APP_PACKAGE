#!/usr/bin/env python3
"""Disposable TEST-ONLY package fixtures; never install or retain as candidates."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('aggregatefeed', REPO / 'scripts/build-unified-candidate-feed.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)

@unittest.skipUnless(all(shutil.which(x) for x in ('gpg', 'gpgv', 'dpkg-deb', 'dpkg-scanpackages', 'apt-get')), 'native test tools required')
class AggregateFeed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='aib-aggregate-TEST-ONLY-')
        cls.root = Path(cls.tmp.name)
        cls.packages = cls.root / 'packages'
        cls.packages.mkdir()
        cls.roots = ['cue-aggregate-fixture-root-a', 'cue-aggregate-fixture-root-c', 'cue-aggregate-fixture-root-d']
        cls.names = cls.roots + ['cue-aggregate-fixture-shared']
        specs = []
        for name in cls.names:
            arch = 'all' if name.endswith(('root-c', 'shared')) else 'amd64'
            stage = cls.root / name
            control = stage / 'DEBIAN'
            control.mkdir(parents=True)
            deps = 'Depends: cue-aggregate-fixture-shared (= 1.0)\n' if name in cls.roots else ''
            (control / 'control').write_text(f'Package: {name}\nVersion: 1.0\nArchitecture: {arch}\nMaintainer: Disposable Test <test@example.invalid>\n' + deps + 'Description: TEST ONLY disposable aggregate fixture\n Not a candidate, never installed or retained.\n')
            deb = cls.packages / f'{name}_1.0_{arch}.deb'
            subprocess.run(['dpkg-deb', '--build', '--root-owner-group', str(stage), str(deb)], capture_output=True, check=True)
            specs.append({'name': name, 'version': '1.0', 'architecture': arch, 'sha256': hashlib.sha256(deb.read_bytes()).hexdigest()})
        cls.manifest = {'schemaVersion': 1, 'channel': 'candidate-only', 'testOnlySynthetic': True, 'productionAllowed': False, 'qualified': False, 'target': {'architecture': 'amd64'}, 'releaseGate': {'publicationAllowed': False, 'deviceInstall': 'NOT RUN', 'rollback': 'NOT RUN'}, 'packages': specs}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_build(self, manifest=None, packages=None):
        data = copy.deepcopy(self.manifest if manifest is None else manifest)
        path = self.root / (self._testMethodName + '.json')
        path.write_text(json.dumps(data))
        return M.build(REPO, path, packages or self.packages, self.root / self._testMethodName, self.roots)

    def test_real_signature_and_exact_mixed_architecture_transaction(self):
        report = self.run_build()
        self.assertTrue(report['valid'])
        self.assertEqual(report['packageCount'], 4)
        self.assertEqual(len(report['rootSpecs']), 3)
        self.assertEqual(report['aptSimulation'], 'PASS')
        self.assertTrue(report['testOnlySynthetic'])
        self.assertFalse(report['productionAllowed'] or report['qualified'] or report['installPerformed'] or report['privateKeyRetained'])
        self.assertEqual(report['android'], 'NOT_RUN')
        output = self.root / self._testMethodName
        self.assertFalse(list(output.rglob('private-keys-v1.d')) + list(output.rglob('secring.gpg')))
        for name in self.names:
            self.assertNotEqual(subprocess.run(['dpkg-query', '-W', '-f=${db:Status-Status}', name], capture_output=True).returncode, 0)

    def test_open_publication_gate_rejected(self):
        data = copy.deepcopy(self.manifest)
        data['releaseGate']['publicationAllowed'] = True
        with self.assertRaisesRegex(ValueError, 'GATES_MUST_REMAIN_CLOSED'):
            self.run_build(data)

    def test_wrong_package_hash_rejected_before_signing(self):
        data = copy.deepcopy(self.manifest)
        data['packages'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'EXPECTED_DEB_SHA256_MISMATCH'):
            self.run_build(data)

    def test_duplicate_identity_rejected(self):
        data = copy.deepcopy(self.manifest)
        data['packages'].append(data['packages'][0])
        with self.assertRaisesRegex(ValueError, 'MANIFEST_DUPLICATE'):
            self.run_build(data)

    def test_incomplete_set_rejected(self):
        subset = self.root / 'incomplete'
        subset.mkdir()
        for deb in sorted(self.packages.glob('*.deb'))[:-1]:
            shutil.copyfile(deb, subset / deb.name)
        with self.assertRaisesRegex(ValueError, 'DEB_SET_INCOMPLETE'):
            self.run_build(packages=subset)

    def test_synthetic_root_override_cannot_change_real_candidate_scope(self):
        data = copy.deepcopy(self.manifest)
        data['testOnlySynthetic'] = False
        with self.assertRaisesRegex(ValueError, 'TEST_ONLY_ROOTS_REQUIRES_SYNTHETIC_MANIFEST'):
            self.run_build(data)

if __name__ == '__main__':
    unittest.main(verbosity=2)
