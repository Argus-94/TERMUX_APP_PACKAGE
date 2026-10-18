#!/usr/bin/env python3
"""Synthetic source-data tests; no Android packages, builds or binary provenance."""
import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('effective', ROOT / 'scripts/effective-candidate-recipes.py')
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)


class EffectiveRecipeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.source = self.root / 'source'
        self.repo.mkdir()
        self.recipe = 'packages/demo/build.sh'
        self.sub = 'packages/demo/tool.subpackage.sh'
        self.put(self.source, self.recipe, b'VERSION=1\n')
        self.put(self.source, self.sub, b'CONTENTS=bin/tool\n')
        self.nodes = {'demo': {'recipePath': self.recipe, 'recipeSha256': e.sha(b'VERSION=1\n'),
                               'subpackagePath': None, 'subpackageSha256': None},
                      'tool': {'recipePath': self.recipe, 'recipeSha256': e.sha(b'VERSION=1\n'),
                               'subpackagePath': self.sub, 'subpackageSha256': e.sha(b'CONTENTS=bin/tool\n')}}

    def put(self, root, name, data):
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def patch(self, path=None, old='VERSION=1', new='VERSION=2'):
        path = path or self.recipe
        return (f'diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n'
                f'@@ -1 +1 @@\n-{old}\n+{new}\n').encode()

    def run_patch(self, data, digest=None):
        self.put(self.repo, 'overlay.patch', data)
        return e.effective_inputs(self.repo, self.source, self.nodes,
                                  [('overlay.patch', digest or e.sha(data))])

    def test_unpatched_identity(self):
        r = e.effective_inputs(self.repo, self.source, self.nodes, [])
        self.assertEqual(r['demo']['effectiveRecipeSha256'], self.nodes['demo']['recipeSha256'])
        self.assertFalse(r['demo']['overlayTouchesPackageInputs'])

    def test_patch_and_source_unchanged(self):
        r = self.run_patch(self.patch())
        self.assertEqual(r['demo']['effectiveRecipeSha256'], e.sha(b'VERSION=2\n'))
        self.assertEqual(r['tool']['effectiveRecipeSha256'], e.sha(b'VERSION=2\n'))
        self.assertEqual((self.source / self.recipe).read_bytes(), b'VERSION=1\n')
        self.assertTrue(r['demo']['overlayTouchesPackageInputs'])

    def test_subpackage_hash_and_parent_context(self):
        base = e.effective_inputs(self.repo, self.source, self.nodes, [])
        r = self.run_patch(self.patch(self.sub, 'CONTENTS=bin/tool', 'CONTENTS=bin/new'))
        self.assertNotEqual(r['tool']['effectiveSubpackageSha256'], base['tool']['effectiveSubpackageSha256'])
        self.assertNotEqual(r['demo']['effectiveRecipeContextSha256'], base['demo']['effectiveRecipeContextSha256'])

    def test_sibling_not_in_runtime_closure(self):
        self.nodes.pop('tool')
        r = self.run_patch(self.patch(self.sub, 'CONTENTS=bin/tool', 'CONTENTS=bin/new'))
        self.assertEqual(set(r), {'demo'})

    def test_divergence_not_binary_equivalence(self):
        base = e.effective_inputs(self.repo, self.source, self.nodes, [])
        other = self.run_patch(self.patch())
        package = {'name': 'demo', 'occurrences': [base['demo'], other['demo']]}
        self.assertEqual(e.divergent_duplicates([package]), ['demo'])
        package['occurrences'][1] = copy.deepcopy(package['occurrences'][0])
        self.assertEqual(e.divergent_duplicates([package]), [])
        self.assertNotIn('qualified', base['demo'])
        self.assertNotIn('binarySha256', base['demo'])

    def test_wrong_patch_hash(self):
        with self.assertRaisesRegex(e.GateError, 'LOCAL_PATCH_HASH_MISMATCH'):
            self.run_patch(self.patch(), '0' * 64)

    def test_base_hash_mismatch(self):
        self.put(self.source, self.recipe, b'VERSION=99\n')
        with self.assertRaisesRegex(e.GateError, 'BASE_RECIPE_HASH_MISMATCH'):
            self.run_patch(self.patch())

    def test_wrong_hunk(self):
        with self.assertRaisesRegex(e.GateError, 'PATCH_APPLY_REJECTED'):
            self.run_patch(self.patch(old='VERSION=99'))

    def test_outside_closure(self):
        with self.assertRaises(e.GateError):
            self.run_patch(self.patch('packages/other/build.sh'))

    def test_traversal_absolute_backslash_and_quoted(self):
        for target in ('../escape', '/tmp/escape', 'packages/../escape/build.sh',
                       'packages/demo/../../escape', 'packages\\demo\\build.sh', '"packages/demo/build.sh"'):
            with self.subTest(target=target), self.assertRaises(e.GateError):
                self.run_patch(self.patch(target))

    def test_renames_copy_modes_binary_rejected(self):
        for metadata in ('old mode 100644\nnew mode 100755', 'new file mode 100644',
                         'deleted file mode 100644', 'rename from packages/demo/build.sh',
                         'copy from packages/demo/build.sh', 'new mode 120000', 'new mode 160000',
                         'Binary files a/file and b/file differ'):
            data = self.patch().replace(b'--- a/', metadata.encode() + b'\n--- a/', 1)
            with self.subTest(metadata=metadata), self.assertRaises(e.GateError):
                self.run_patch(data)

    def test_different_old_new_paths(self):
        data = self.patch().replace(b'+++ b/packages/demo/build.sh', b'+++ b/packages/demo/tool.subpackage.sh')
        with self.assertRaises(e.GateError):
            self.run_patch(data)

    def test_duplicate_target(self):
        with self.assertRaises(e.GateError):
            self.run_patch(self.patch() + self.patch())

    def test_empty_malformed_truncated_and_nul(self):
        for data in (b'', b'not a patch\n', self.patch()[:-15], self.patch() + b'\0'):
            with self.subTest(data=data), self.assertRaises(e.GateError):
                self.run_patch(data)

    def test_non_utf8_rejected(self):
        with self.assertRaises(UnicodeError):
            self.run_patch(self.patch() + b'\xff')

    def test_source_symlink_file(self):
        p = self.source / self.recipe
        p.unlink()
        p.symlink_to(self.source / self.sub)
        with self.assertRaisesRegex(e.GateError, 'SYMLINK_INPUT_REJECTED'):
            self.run_patch(self.patch())

    def test_source_symlink_parent(self):
        directory = self.source / 'packages/demo'
        directory.rename(self.source / 'real')
        directory.symlink_to(self.source / 'real', target_is_directory=True)
        with self.assertRaisesRegex(e.GateError, 'SYMLINK_INPUT_REJECTED'):
            self.run_patch(self.patch())

    def test_patch_symlink(self):
        p = self.repo / 'overlay.patch'
        p.symlink_to(self.source / self.recipe)
        with self.assertRaisesRegex(e.GateError, 'SYMLINK_INPUT_REJECTED'):
            e.effective_inputs(self.repo, self.source, self.nodes, [('overlay.patch', '0' * 64)])

    def test_patch_path_traversal(self):
        with self.assertRaisesRegex(e.GateError, 'UNSAFE_INPUT_PATH'):
            e.effective_inputs(self.repo, self.source, self.nodes, [('../outside.patch', '0' * 64)])

    def test_oversized_input(self):
        self.put(self.repo, 'overlay.patch', b'x' * (1024 * 1024 + 1))
        with self.assertRaisesRegex(e.GateError, 'INPUT_TOO_LARGE'):
            e.effective_inputs(self.repo, self.source, self.nodes, [('overlay.patch', '0' * 64)])

    def test_ordered_patches(self):
        p1, p2 = self.patch(), self.patch(old='VERSION=2', new='VERSION=3')
        self.put(self.repo, 'a.patch', p1)
        self.put(self.repo, 'b.patch', p2)
        patches = [('a.patch', e.sha(p1)), ('b.patch', e.sha(p2))]
        r = e.effective_inputs(self.repo, self.source, self.nodes, patches)
        self.assertEqual(r['demo']['effectiveRecipeSha256'], e.sha(b'VERSION=3\n'))
        with self.assertRaises(e.GateError):
            e.effective_inputs(self.repo, self.source, self.nodes, patches[::-1])

    def test_git_environment_isolated(self):
        with mock.patch.dict('os.environ', {'GIT_DIR': '/not/ours', 'GIT_WORK_TREE': '/not/ours'}):
            self.run_patch(self.patch())

    def test_timeout_not_swallowed(self):
        import subprocess
        with mock.patch.object(e.subprocess, 'run', side_effect=subprocess.TimeoutExpired('git', 30)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_patch(self.patch())


    def pulse_fixture(self):
        import shutil
        import subprocess
        registry = 'termux-private-package-kit/openjdk17/upstream-recipe-inputs.json'
        patch = 'termux-private-package-kit/openjdk17/patches/pulseaudio-api24-source.patch'
        self.put(self.repo, registry, (ROOT / registry).read_bytes())
        self.put(self.repo, patch, (ROOT / patch).read_bytes())
        meson = 'packages/pulseaudio/meson.patch'
        pulse_recipe = 'packages/pulseaudio/build.sh'
        fixtures = ROOT / 'scripts/tests/fixtures/pulseaudio-505e06e'
        registered = json.loads((ROOT / registry).read_text())['files']
        for name in (meson, pulse_recipe):
            data = (fixtures / pathlib.Path(name).name).read_bytes()
            self.assertEqual(e.sha(data), registered[name])
            self.put(self.source, name, data)
        # The registered overlay is consumed after openjdk17-license-notices.patch
        # in the actual package workflow; model its pulseaudio recipe context here.
        legacy = ROOT / 'termux-private-package-kit/openjdk17/openjdk17-license-notices.patch'
        result = subprocess.run(['git', '-C', str(self.source), 'apply', '--include=' + pulse_recipe, str(legacy)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        pulse_data = (self.source / pulse_recipe).read_bytes()
        nodes = {'pulseaudio': {'recipePath': pulse_recipe, 'recipeSha256': e.sha(pulse_data),
                                'subpackagePath': None, 'subpackageSha256': None}}
        return patch, meson, nodes
    def test_registered_pulseaudio_data_overlay(self):
        patch, meson, nodes = self.pulse_fixture()
        digest = e.sha((self.repo / patch).read_bytes())
        result = e.effective_inputs(self.repo, self.source, nodes, [(patch, digest)])
        self.assertTrue(result['pulseaudio']['overlayTouchesPackageInputs'])
        self.assertNotEqual(result['pulseaudio']['effectiveRecipeContextSha256'], e.sha(b'{}'))
    def test_pulseaudio_base_hash_mutation_rejected(self):
        patch, meson, nodes = self.pulse_fixture()
        (self.source / meson).write_bytes(b'tampered\n')
        with self.assertRaisesRegex(e.GateError, 'BASE_HASH_MISMATCH'):
            e.effective_inputs(self.repo, self.source, nodes, [(patch, e.sha((self.repo / patch).read_bytes()))])
    def test_pulseaudio_overlay_cannot_target_other_file(self):
        patch, meson, nodes = self.pulse_fixture()
        data = (self.repo / patch).read_text()
        bad = data.replace('packages/pulseaudio/meson.patch', 'packages/pulseaudio/build.sh')
        (self.repo / patch).write_text(bad)
        with self.assertRaises(e.GateError):
            e.effective_inputs(self.repo, self.source, nodes, [(patch, e.sha(bad.encode()))])
if __name__ == '__main__':
    unittest.main()
