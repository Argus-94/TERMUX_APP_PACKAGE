import importlib.util
import pathlib
import json
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).parents[1] / 'build-bootstrap-compatible-candidate.py'
spec = importlib.util.spec_from_file_location('bootstrap_candidate', SCRIPT)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

class AuthenticityGateTests(unittest.TestCase):
    def test_base_manifest_pin_is_not_a_mutable_claim(self):
        self.assertEqual(len(b.PINNED_OLD_MANIFEST), 64)
        self.assertEqual(b.PINNED_OLD_MANIFEST, 'e5a2e3cdb0d1010436f850da4511b993bac9ddb8d9f9f6b941c29a925386d911')

    def test_only_exact_expected_binary_identities_are_allowed(self):
        self.assertEqual(b.OLD_NAMES, {'libbz2':'1.0.8-8','bzip2':'1.0.8-8','liblzma':'5.8.4','xz-utils':'5.8.4'})
        self.assertNotIn('synthetic', b.OLD_NAMES)

    def test_unpinned_source_and_absent_provenance_fail(self):
        with tempfile_dir() as d:
            p=pathlib.Path(d)/'build-result.json'
            p.write_text('{"sourceCommit":"0000000000000000000000000000000000000000","valid":true,"provenance":{}}')
            with self.assertRaisesRegex(ValueError,'SOURCE_COMMIT_NOT_PINNED'):
                b.result_data(pathlib.Path(d), None)

    def test_pinned_source_still_requires_provenance(self):
        with tempfile_dir() as d:
            p=pathlib.Path(d)/'build-result.json'
            p.write_text(json.dumps({'sourceCommit':'505e06ef0c8dbd7611abfb90e9eb60826dcd01d7','producerCommit':'a'*40,'sourceBuild':True,'controlRepacked':False,'builderImage':json.loads((SCRIPT.parent.parent/'bootstrap-compatible-candidate-inputs.json').read_text())['builderImage']}))
            with self.assertRaisesRegex(ValueError,'SOURCE_PROVENANCE_MISSING'):
                b.result_data(pathlib.Path(d), 'a'*40)

    def test_nonregular_deb_not_accepted(self):
        # The scanner's regular-file/symlink gate is applied before parsing metadata.
        with tempfile_dir() as d:
            p=pathlib.Path(d)/'packages'; p.mkdir(); target=pathlib.Path(d)/'outside'; target.write_bytes(b'deb')
            (p/'linked.deb').symlink_to(target)
            with mock.patch.object(b, 'result_data', return_value={'provenance':{},'sourceCommit':'505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'}):
                with self.assertRaisesRegex(ValueError,'BUILD_DEB_NOT_REGULAR'):
                    b.scan_build(pathlib.Path(d), None)

class tempfile_dir:
    def __enter__(self):
        import tempfile
        self.t=tempfile.TemporaryDirectory(); return self.t.name
    def __exit__(self,*args): self.t.cleanup()

if __name__ == '__main__': unittest.main()
