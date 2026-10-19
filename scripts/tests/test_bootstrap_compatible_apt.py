import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / 'test-bootstrap-compatible-apt.py'
spec = importlib.util.spec_from_file_location('bootstrap_apt_proof', SCRIPT)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class PlanParserTests(unittest.TestCase):
    def test_installed_and_upgrade_versions_are_parsed(self):
        actions = proof.parse_plan('Inst make (4.4.1-1 aarch64 [upgradeable from: 4.3])\nInst bzip2 (1.0.8-8 aarch64)\n')
        self.assertEqual(actions[0]['oldVersion'], None)
        self.assertEqual(actions[0]['details'], '4.4.1-1 aarch64 [upgradeable from: 4.3]')
        self.assertEqual(actions[1]['package'], 'bzip2')
        proof.validate_plan('Inst make (4.4.1-1 aarch64)\n', {'make': '4.4.1-1'})

    def test_old_version_annotation_does_not_hide_new_version(self):
        text = 'Inst libexample [1.0] (2.0 aarch64 [old version: 1.0])\n'
        acts = proof.parse_plan(text)
        self.assertEqual(acts[0]['oldVersion'], '1.0')
        self.assertEqual(acts[0]['details'], '2.0 aarch64 [old version: 1.0]')
        proof.validate_plan(text, {'libexample': '2.0'})

    def test_malformed_inst_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'VERSION_MISSING'):
            proof.validate_plan('Inst make\n', {'make': '4.4.1-1'})

    def test_outsider_and_missing_expected_package_rejected(self):
        with self.assertRaisesRegex(ValueError, 'PACKAGE_MISSING_OR_VERSION_MISMATCH'):
            proof.validate_plan('Inst outsider (1 aarch64)\n', {'make': '4.4.1-1'})

    def test_downgrade_marker_and_removal_rejected(self):
        for text, error in [('Downgrade: make\n', 'DOWNGRADE'), ('Remv libexample [2]\n', 'REMOVES')]:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, error):
                proof.validate_plan(text, {})

    def test_wrong_installed_version_rejected(self):
        with self.assertRaisesRegex(ValueError, 'VERSION_MISMATCH'):
            proof.validate_plan('Inst make (4.3 aarch64)\n', {'make': '4.4.1-1'})


if __name__ == '__main__':
    unittest.main()
