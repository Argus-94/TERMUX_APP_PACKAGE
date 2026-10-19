import copy
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('effective', ROOT / 'scripts/effective-candidate-recipes.py')
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)

class ReproducibleRecipeOverlayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.repo, self.source = self.root/'repo', self.root/'source'
        self.repo.mkdir(); self.source.mkdir()
        self.recipe = 'packages/openjdk-17/build.sh'
        self.patch_path = 'termux-private-package-kit/openjdk17/patches/openjdk17-reproducible-source.patch'
        self.registry_path = 'termux-private-package-kit/openjdk17/upstream-recipe-inputs.json'
        self.base = (ROOT/'scripts/tests/fixtures/openjdk17-505e06e/build.sh').read_bytes()
        self.patch = (ROOT/self.patch_path).read_bytes()
        self.registry = json.loads((ROOT/self.registry_path).read_text())
        self._put(self.repo,self.registry_path,(ROOT/self.registry_path).read_bytes())
        self._put(self.repo,self.patch_path,self.patch)
        self._put(self.source,self.recipe,self.base)
        self.node={'openjdk-17':{'recipePath':self.recipe,'recipeSha256':e.sha(self.base),'subpackagePath':None,'subpackageSha256':None}}

    def _put(self,root,name,data):
        path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data);return path

    def test_pinned_fixture_and_overlay_content(self):
        self.assertEqual(e.sha(self.base),self.registry['files'][self.recipe])
        result=e.effective_inputs(self.repo,self.source,self.node,[(self.patch_path,e.sha(self.patch))])
        self.assertTrue(result['openjdk-17']['overlayTouchesPackageInputs'])
        import subprocess
        applied=subprocess.run(['git','-C',str(self.source),'apply',str(self.repo/self.patch_path)],capture_output=True,text=True)
        self.assertEqual(applied.returncode,0,applied.stderr)
        text=(self.source/self.recipe).read_text()
        for expected in ('SOURCE_DATE_EPOCH=1791971743','--with-source-date="$SOURCE_DATE_EPOCH"','--enable-reproducible-build','gzip -n "$manpage"'):
            self.assertIn(expected,text)

    def test_epoch_and_gzip_n_tampering_rejected_by_registered_patch_guard(self):
        for old,new in ((b'SOURCE_DATE_EPOCH=1791971743',b'SOURCE_DATE_EPOCH=1791971744'),(b'gzip -n "$manpage"',b'gzip "$manpage"')):
            mutated=self.patch.replace(old,new);self._put(self.repo,self.patch_path,mutated)
            with self.subTest(old=old),self.assertRaises(e.GateError):
                e.effective_inputs(self.repo,self.source,self.node,[(self.patch_path,e.sha(mutated))])


    def test_wrapper_actual_python_contract_against_manifest(self):
        wrapper=(ROOT/'termux-private-package-kit/openjdk17/build-openjdk17-private-aarch64.sh').read_text()
        block=wrapper.split("python3 - \"$PACKAGE_SET\" \"$EXPECTED_REPRO_PATCH_SHA\" <<'PY'\n",1)[1].split('\nPY\n',1)[0]
        manifest=ROOT/'openjdk17-candidate-package-set.json'
        import subprocess
        result=subprocess.run(['python3','-',str(manifest),'81cea0230ad5de232a1c72b168d6f944d42f39e7448d44eef686f34e6e005ad5'],input=block,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        bad=subprocess.run(['python3','-',str(manifest),'0'*64],input=block,text=True,capture_output=True)
        self.assertNotEqual(bad.returncode,0)

    def test_registry_and_patch_mutation_cannot_authorize_shell(self):
        mutated=self.patch.replace(b'SOURCE_DATE_EPOCH=1791971743',b'export SOURCE_DATE_EPOCH=$(date +%s)')
        registry=copy.deepcopy(self.registry)
        registry['registeredLocalRecipePatches'][self.patch_path]['sha256']=e.sha(mutated)
        self._put(self.repo,self.patch_path,mutated)
        self._put(self.repo,self.registry_path,json.dumps(registry).encode())
        with self.assertRaises(e.GateError):
            e.effective_inputs(self.repo,self.source,self.node,[(self.patch_path,e.sha(mutated))])

if __name__=='__main__': unittest.main()
