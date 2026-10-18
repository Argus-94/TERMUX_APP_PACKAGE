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
from unittest import mock

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

    def test_supplemental_license_is_explicit_root_in_signed_apt_transaction(self):
        license_name = 'termux-licenses'
        license_stage = self.root / license_name
        control = license_stage / 'DEBIAN'
        control.mkdir(parents=True)
        (control / 'control').write_text(
            'Package: termux-licenses\nVersion: 2.2\nArchitecture: all\n'
            'Maintainer: Disposable Test <test@example.invalid>\n'
            'Description: TEST ONLY supplemental license fixture\n'
        )
        license_deb = self.root / 'termux-licenses_2.2_all.deb'
        subprocess.run(['dpkg-deb', '--build', '--root-owner-group', str(license_stage), str(license_deb)], capture_output=True, check=True)
        bundle = self.root / 'support-bundle'
        (bundle / 'packages').mkdir(parents=True)
        shutil.copyfile(license_deb, bundle / 'packages' / license_deb.name)
        license_hash = hashlib.sha256(license_deb.read_bytes()).hexdigest()
        manifest = copy.deepcopy(self.manifest)
        manifest['packages'].append({'name': license_name, 'version': '2.2', 'architecture': 'all', 'sha256': license_hash})
        path = self.root / (self._testMethodName + '.json')
        path.write_text(json.dumps(manifest))
        original_run = subprocess.run

        def verifier_fixture(args, **kwargs):
            if len(args) > 1 and str(args[1]).endswith('verify-candidate-license-support.py'):
                self.assertEqual(args[args.index('--expected-fingerprint') + 1], 'A' * 64)
                self.assertEqual(args[args.index('--expected-producer') + 1], 'TEST-ONLY')
                report_path = Path(args[args.index('--report') + 1])
                report_path.write_text(json.dumps({'valid': True, 'package': {'sha256': license_hash}}))
                return subprocess.CompletedProcess(args, 0, b'', b'')
            return original_run(args, **kwargs)

        with mock.patch.object(M.subprocess, 'run', side_effect=verifier_fixture):
            report = M.build(REPO, path, self.packages, self.root / self._testMethodName,
                             self.roots, bundle, 'A' * 64, 'TEST-ONLY')
        self.assertEqual(report['nativePackageCount'], 4)
        self.assertEqual(report['supplementalPackageCount'], 1)
        self.assertEqual(len(report['nativeToolRootSpecs']), 3)
        self.assertEqual(report['supportRootSpecs'], ['termux-licenses=2.2'])
        self.assertEqual(len(report['rootSpecs']), 4)
        self.assertEqual(report['packageCount'], 5)
        self.assertEqual(report['aptSimulation'], 'PASS')
        self.assertFalse(report['productionAllowed'] or report['qualified'] or report['installPerformed'])
        self.assertIn('roots=4', (self.root / self._testMethodName / 'apt-validation.log').read_text())

    def test_support_pin_rejection_prevents_feed_creation(self):
        license_name = 'termux-licenses'
        license_deb = self.root / 'termux-licenses_2.2_all.deb'
        stage = self.root / 'wrong-pin-license'
        control = stage / 'DEBIAN'
        control.mkdir(parents=True)
        (control / 'control').write_text('Package: termux-licenses\nVersion: 2.2\nArchitecture: all\nDescription: TEST ONLY\n')
        subprocess.run(['dpkg-deb', '--build', '--root-owner-group', str(stage), str(license_deb)], capture_output=True, check=True)
        bundle = self.root / 'wrong-pin-bundle'
        (bundle / 'packages').mkdir(parents=True)
        shutil.copyfile(license_deb, bundle / 'packages' / license_deb.name)
        manifest = copy.deepcopy(self.manifest)
        manifest['packages'].append({'name': license_name, 'version': '2.2', 'architecture': 'all', 'sha256': hashlib.sha256(license_deb.read_bytes()).hexdigest()})
        path = self.root / (self._testMethodName + '.json')
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, 'COMMAND_REJECTED'):
            M.build(REPO, path, self.packages, self.root / self._testMethodName,
                    self.roots, bundle, '0' * 64, 'wrong-producer')
        self.assertFalse((self.root / self._testMethodName).exists())

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
