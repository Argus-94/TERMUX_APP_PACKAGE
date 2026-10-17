import pathlib
import hashlib
import sys
import unittest
KIT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(KIT))
import verify_openjdk17_buildorder as gate

class BuildOrderTests(unittest.TestCase):
    def test_workflow_and_wrapper_manifest_locks_are_current(self):
        repo=KIT.parents[1]
        digest=hashlib.sha256((repo/'openjdk17-candidate-package-set.json').read_bytes()).hexdigest()
        self.assertIn(digest,(repo/'.github/workflows/openjdk17-package-candidate.yml').read_text())
        self.assertIn(digest,(KIT/'build-openjdk17-private-aarch64.sh').read_text())
    def rows(self): return ['libmpg123','libsndfile','pulseaudio']+['dependency-'+str(i) for i in range(117)]
    def test_valid_supported_decoder_order(self): gate.validate_order(self.rows())
    def test_missing_duplicate_or_extra_package_rejected(self):
        rows=self.rows()
        for bad in [rows[:-1],rows+['extra'],rows[:-1]+[rows[0]]]:
            with self.subTest(bad=bad[-2:]),self.assertRaises(ValueError): gate.validate_order(bad)
    def test_reversed_audio_order_rejected(self):
        rows=self.rows();rows[:3]=list(reversed(rows[:3]))
        with self.assertRaises(ValueError):gate.validate_order(rows)
    def test_console_subpackage_rejected(self):
        rows=self.rows();rows[-1]='mpg123'
        with self.assertRaises(ValueError):gate.validate_order(rows)
    def test_audio_package_missing_rejected(self):
        rows=self.rows();rows[0]='other'
        with self.assertRaises(ValueError):gate.validate_order(rows)

if __name__=='__main__':unittest.main()
