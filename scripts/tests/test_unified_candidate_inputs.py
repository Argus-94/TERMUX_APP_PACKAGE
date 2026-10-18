#!/usr/bin/env python3
"""Source preflight tests, NOT binary aggregate/signature/collision qualification."""
import copy
import importlib.util
import json
import os
import pathlib
import shutil
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('unified', ROOT / 'scripts/audit-unified-candidate-inputs.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


def relation(name, operator=None, version=None, qualifier=None):
    return {'name': name, 'operator': operator, 'version': version, 'qualifier': qualifier}


class SourceDependencyTests(unittest.TestCase):
    def setUp(self):
        self.available = {'consumer': {'version': '2', 'architecture': 'aarch64'},
                          'provider': {'version': '1:3.6.5', 'architecture': 'aarch64'}}

    def test_complete(self):
        u.check_dependencies(self.available, {'consumer': [[relation('provider')]]}, 'union')

    def test_cross_family_provider_omission(self):
        del self.available['provider']
        with self.assertRaisesRegex(u.GateError, 'SOURCE_DEPENDENCY_HOLE:union:consumer'):
            u.check_dependencies(self.available, {'consumer': [[relation('provider')]]}, 'union')

    def test_version_hole(self):
        with self.assertRaises(u.GateError):
            u.check_dependencies(self.available, {'consumer': [[relation('provider', '>=', '1:4')]]}, 'union')

    def test_epoch_relation(self):
        u.check_dependencies(self.available, {'consumer': [[relation('provider', '>=', '1:3')]]}, 'union')

    def test_alternative(self):
        u.check_dependencies(self.available, {'consumer': [[relation('absent'), relation('provider')]]}, 'union')

    def test_all_alternatives_missing(self):
        with self.assertRaises(u.GateError):
            u.check_dependencies(self.available, {'consumer': [[relation('absent'), relation('absent2')]]}, 'union')

    def test_parent_exact_version(self):
        self.available['provider']['version'] = '2'
        u.check_dependencies(self.available, {'consumer': [[relation('provider', '=', 'parent-build-version')]]}, 'union')

    def test_parent_version_mismatch(self):
        with self.assertRaises(u.GateError):
            u.check_dependencies(self.available, {'consumer': [[relation('provider', '=', 'parent-build-version')]]}, 'union')

    def test_architecture_qualifier(self):
        self.available['provider']['architecture'] = 'all'
        with self.assertRaises(u.GateError):
            u.check_dependencies(self.available, {'consumer': [[relation('provider', qualifier='aarch64')]]}, 'union')


@unittest.skipUnless(os.environ.get('AIB_PINNED_SOURCE_ROOT'), 'requires clean exact pinned source; CI supplies it')
class InventoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_root = pathlib.Path(os.environ['AIB_PINNED_SOURCE_ROOT'])
        cls.baseline = u.inventory(ROOT, cls.source_root)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = pathlib.Path(self.tmp.name)
        files = {'termux-package-source-scope.json', 'scripts/candidate-packaging-policy.py', 'scripts/apply-candidate-packaging-policy.py'}
        files.update(str(p.relative_to(ROOT)) for p in (ROOT / 'termux-private-package-kit').glob('*/build-*.sh'))
        for manifest, workflow, _ in u.PROFILES.values():
            files.update((manifest, '.github/workflows/' + workflow))
        for profile in self.baseline['profiles'].values():
            files.update(p['path'] for p in profile['localPatches'])
        for file in files:
            target = self.repo / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / file, target)

    def mutate(self, file, operation):
        p = self.repo / file
        value = json.loads(p.read_text())
        operation(value)
        p.write_text(json.dumps(value))

    def reject(self, code):
        with self.assertRaisesRegex(u.GateError, code):
            u.inventory(self.repo, self.source_root)

    def test_exact_committed_lock(self):
        self.assertEqual((ROOT / u.LOCK).read_text(), u.encode(self.baseline))

    def test_counts_and_unproven_status(self):
        self.assertEqual(self.baseline['summary']['uniquePackageCount'], 79)
        self.assertEqual(self.baseline['summary']['occurrenceCount'], 144)
        self.assertEqual(self.baseline['summary']['profileCount'], 10)
        self.assertFalse(self.baseline['aggregateReady'])
        self.assertFalse(self.baseline['publicationAllowed'])
        self.assertTrue(all(p['signedBinaryBundle'] is None for p in self.baseline['profiles'].values()))
        self.assertTrue(all(o['binarySha256'] is None for p in self.baseline['packages'] for o in p['occurrences']))

    def test_computed_common_recipes_not_binary_equivalence(self):
        self.assertEqual(self.baseline['summary']['effectiveRecipeDivergentDuplicateNames'], [])
        packages = {p['name']: p for p in self.baseline['packages']}
        for name in ('libcurl', 'ncurses'):
            occurrences = packages[name]['occurrences']
            self.assertEqual(len({o['effectiveRecipeSha256'] for o in occurrences}), 1)
            self.assertEqual(len({o['effectiveRecipeContextSha256'] for o in occurrences}), 1)
            self.assertNotEqual(occurrences[0]['effectiveRecipeSha256'], packages[name]['recipeSha256'])
            self.assertTrue(all(o['binarySha256'] is None for o in occurrences))
        self.assertFalse(self.baseline['aggregateReady'])

    def test_missing_common_overlay_restores_divergence(self):
        def omit(m):
            p = next(p for p in m['packages'] if p['name'] == 'libcurl')
            p.pop('localRecipePatchPath')
            p.pop('localRecipePatchSha256')
        self.mutate('git-candidate-package-set.json', omit)
        changed = u.inventory(self.repo, self.source_root)
        self.assertIn('libcurl', changed['summary']['effectiveRecipeDivergentDuplicateNames'])

    def test_missing_license_overlay_restores_ncurses_divergence(self):
        def omit(m):
            p = next(p for p in m['packages'] if p['name'] == 'ncurses')
            p.pop('localRecipePatchPath')
            p.pop('localRecipePatchSha256')
        self.mutate('git-candidate-package-set.json', omit)
        changed = u.inventory(self.repo, self.source_root)
        self.assertIn('ncurses', changed['summary']['effectiveRecipeDivergentDuplicateNames'])

    def test_false_effective_hash_not_accepted_from_manifest(self):
        def tamper(m):
            next(p for p in m['packages'] if p['name'] == 'libcurl')['effectiveRecipeSha256'] = '0' * 64
        self.mutate('cmake-ninja-candidate-package-set.json', tamper)
        # Effective bytes must be independently reproduced, never copied from
        # an arbitrary success flag/hash in the manifest.
        changed = u.inventory(self.repo, self.source_root)
        curl = next(p for p in changed['packages'] if p['name'] == 'libcurl')
        occurrence = next(o for o in curl['occurrences'] if o['profile'] == 'cmake-ninja')
        self.assertEqual(occurrence['effectiveRecipeSha256'],
                         'ba13efc16ac98cec77ebd9c0718c65ea69cef87c96e3cb0c27864593f8ede348')

    def test_omitted_package(self):
        self.mutate('curl-candidate-package-set.json', lambda m: m['packages'].pop())
        self.reject('PROFILE_SOURCE_SET_MISMATCH')

    def test_duplicate_identity(self):
        self.mutate('curl-candidate-package-set.json', lambda m: m['packages'].append(copy.deepcopy(m['packages'][0])))
        self.reject('PROFILE_DUPLICATE_PACKAGE')

    def test_duplicate_version_disagreement(self):
        self.mutate('git-candidate-package-set.json', lambda m: m['packages'][0].update(version='999'))
        self.reject('SOURCE_IDENTITY_MISMATCH')

    def test_singleton_wrong_source_version(self):
        self.mutate('gh-candidate-package-set.json', lambda m: m['packages'][0].update(version='999'))
        self.reject('SOURCE_IDENTITY_MISMATCH')

    def test_wrong_source_architecture(self):
        self.mutate('gh-candidate-package-set.json', lambda m: m['packages'][0].update(architecture='all'))
        self.reject('SOURCE_IDENTITY_MISMATCH')

    def test_subpackage_hash_tamper(self):
        def tamper(m):
            next(p for p in m['packages'] if p['name'] == 'curl')['subpackageSha256'] = '0' * 64
        self.mutate('curl-candidate-package-set.json', tamper)
        self.reject('SUBPACKAGE_PROVENANCE_MISMATCH')

    def test_subpackage_path_tamper(self):
        def tamper(m):
            next(p for p in m['packages'] if p['name'] == 'curl')['subpackagePath'] = 'packages/other.subpackage.sh'
        self.mutate('curl-candidate-package-set.json', tamper)
        self.reject('SUBPACKAGE_PROVENANCE_MISMATCH')

    def test_subpackage_and_parent_false_version(self):
        def tamper(m):
            for p in m['packages']:
                if p['name'] in ('curl', 'libcurl'):
                    p['version'] = '999'
        self.mutate('curl-candidate-package-set.json', tamper)
        self.reject('SOURCE_IDENTITY_MISMATCH')

    def test_recipe_hash_tamper(self):
        self.mutate('gh-candidate-package-set.json', lambda m: m['packages'][0].update(recipeSha256='0' * 64))
        self.reject('RECIPE_PROVENANCE_MISMATCH')

    def test_patch_hash_tamper(self):
        patch = self.repo / 'termux-private-package-kit/cmake-ninja/libcurl-disable-optional-zstd.patch'
        patch.write_text(patch.read_text() + '\n# tamper\n')
        self.reject('LOCAL_PATCH_HASH_MISMATCH')

    def test_profile_channel(self):
        self.mutate('candidate-package-set.json', lambda m: m.update(channel='production'))
        self.reject('CHANNEL_NOT_CANDIDATE_ONLY')

    def test_publication_stays_disabled(self):
        self.mutate('candidate-package-set.json', lambda m: m['releaseGate'].update(publicationAllowed=True))
        self.reject('PUBLICATION_MUST_REMAIN_DISABLED')

    def test_wrong_target(self):
        self.mutate('candidate-package-set.json', lambda m: m['target'].update(applicationId='com.termux'))
        self.reject('TARGET_MISMATCH')

    def test_source_dependency_tamper(self):
        self.mutate('curl-candidate-package-set.json', lambda m: m['packages'][0].update(dependencyGroups=[[relation('fake')]]))
        self.reject('SOURCE_DEPENDENCY_METADATA_MISMATCH')

    def test_all_wrappers_invoke_policy_and_hashes_are_global(self):
        policy = self.baseline['packagingPolicy']
        helper = u.packaging_policy.policy_description(self.repo, self.source_root)
        for key in ('baseCommit', 'baseInputs', 'patchedInputs', 'helperSha256', 'applierSha256'):
            self.assertEqual(policy[key], helper[key])
        self.assertEqual(len(policy['buildWrapperSha256']), 10)
        for rel, expected in policy['buildWrapperSha256'].items():
            self.assertEqual(u.digest(self.repo / rel), expected)
            text = (self.repo / rel).read_text()
            self.assertEqual(text.count('apply-candidate-packaging-policy.py'), 2)
            self.assertEqual(text.count('--verify-only'), 1)

    def test_missing_wrapper_policy_call_rejected(self):
        rel = sorted(self.baseline['packagingPolicy']['buildWrapperSha256'])[0]
        path = self.repo / rel
        path.write_text(path.read_text().replace(
            'python3 "$ROOT/scripts/apply-candidate-packaging-policy.py" --source-root "$WORKTREE"\n', '', 1).replace(
            'python3 "$ROOT/scripts/apply-candidate-packaging-policy.py" --source-root "$W"\n', '', 1))
        with self.assertRaisesRegex(u.GateError, 'PACKAGING_POLICY_INVOCATION_MISSING_OR_DUPLICATE'):
            u.validate_policy_wrappers(self.repo)

    def test_missing_final_policy_verification_rejected(self):
        rel = sorted(self.baseline['packagingPolicy']['buildWrapperSha256'])[0]
        path = self.repo / rel
        path.write_text(''.join(line for line in path.read_text().splitlines(True)
                                if '--verify-only' not in line))
        with self.assertRaisesRegex(u.GateError, 'PACKAGING_POLICY_VERIFY_BEFORE_BUILD_REQUIRED'):
            u.validate_policy_wrappers(self.repo)

    def test_workflow_hash_bound(self):
        p = self.repo / '.github/workflows/curl-package-candidate.yml'
        p.write_text(p.read_text() + '\n# changed\n')
        self.assertNotEqual(u.encode(u.inventory(self.repo, self.source_root)), u.encode(self.baseline))


if __name__ == '__main__':
    unittest.main()
