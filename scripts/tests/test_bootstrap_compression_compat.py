import importlib.util
import os
import pathlib
import tempfile
import unittest
import zipfile

SCRIPT = pathlib.Path(__file__).parents[1] / 'audit-bootstrap-compression-compat.py'
spec = importlib.util.spec_from_file_location('audit_bootstrap_compat', SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class BootstrapCompressionCompatTests(unittest.TestCase):
    def test_safe_path_rejects_traversal_and_absolute(self):
        self.assertTrue(audit.safe_name('usr/lib/libbz2.so.1'))
        self.assertFalse(audit.safe_name('../escape'))
        self.assertFalse(audit.safe_name('/absolute'))

    def test_zip_rejects_unsafe_paths_and_symlink_members(self):
        for name, mode, error in [('../escape', 0, 'UNSAFE_BOOTSTRAP_PATH'),
                                  ('lib/fake.so', 0o120777, 'ZIP_SYMLINK_PAYLOAD')]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as td:
                zpath = pathlib.Path(td) / 'bad.zip'
                with zipfile.ZipFile(zpath, 'w') as z:
                    info = zipfile.ZipInfo(name)
                    if mode:
                        info.external_attr = mode << 16
                    z.writestr(info, b'not ELF')
                with zipfile.ZipFile(zpath) as z, self.assertRaisesRegex(ValueError, error):
                    audit.extract_bootstrap(zpath, pathlib.Path(td) / 'out')

    def test_real_readelf_fields_separate_exports_undefined_and_visibility(self):
        output = '''  Num:    Value          Size Type    Bind   Vis      Ndx Name
   1: 0000000000001000    12 FUNC    GLOBAL DEFAULT   10 BZ2_ok@@LIBBZ2_1.0
   2: 0000000000001010     4 OBJECT  WEAK   PROTECTED  11 data@LIBBZ2_1.0
   3: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND BZ2_need@LIBBZ2_1.0
   4: 0000000000000000     0 FUNC    WEAK   DEFAULT  UND weak_need
   5: 0000000000001020     1 FUNC    GLOBAL HIDDEN    12 hidden
   6: 0000000000001030     1 FUNC    LOCAL  DEFAULT   13 local
'''
        with tempfile.TemporaryDirectory() as td:
            tool = pathlib.Path(td) / 'readelf'
            tool.write_text('#!/bin/sh\ncat <<\'EOF\'\n' + output + 'EOF\n')
            tool.chmod(0o755)
            path = pathlib.Path(td) / 'sample.so'
            path.write_bytes(b'')
            old = os.environ.get('PATH', '')
            try:
                os.environ['PATH'] = td + os.pathsep + old
                exports = audit.exported(path)
                undefs = audit.undefined(path)
            finally:
                os.environ['PATH'] = old
        self.assertIn(('BZ2_ok', 'LIBBZ2_1.0'), exports)
        self.assertIn(('BZ2_ok', None), exports)  # default-version alias
        self.assertIn(('data', 'LIBBZ2_1.0'), exports)
        self.assertNotIn(('hidden', None), exports)
        self.assertEqual(undefs, {('BZ2_need', 'LIBBZ2_1.0')})

    def test_missing_baseline_export_is_detected_by_versioned_identity(self):
        baseline = {('BZ2_ok', 'LIBBZ2_1.0'), ('BZ2_old', 'LIBBZ2_1.0')}
        candidate = {('BZ2_ok', 'LIBBZ2_1.0')}
        self.assertEqual(baseline - candidate, {('BZ2_old', 'LIBBZ2_1.0')})

    def test_symlink_manifest_target_left_arrow_link_and_internal_parent_reference(self):
        with tempfile.TemporaryDirectory() as td:
            zpath = pathlib.Path(td) / 'manifest.zip'
            with zipfile.ZipFile(zpath, 'w') as z:
                z.writestr('SYMLINKS.txt', 'libbz2.so.1←./lib/libbz2.so\n/system/bin/tool←./lib/platform-link\n')
            with zipfile.ZipFile(zpath) as z:
                links = audit.parse_symlinks(z)
        self.assertEqual(links, [('./lib/libbz2.so', 'libbz2.so.1'), ('./lib/platform-link', '/system/bin/tool')])
        self.assertTrue(audit._validate_link('./lib/libbz2.so', 'libbz2.so.1'))
        # A platform target is recorded, not followed and not treated as unsafe.
        self.assertFalse(audit._validate_link('./lib/platform-link', '/system/bin/tool'))
        self.assertTrue(audit._validate_link('./lib/inside', '../bin/tool'))
        with self.assertRaisesRegex(ValueError, 'UNSAFE_BASELINE_SYMLINK'):
            audit._validate_link('./lib/escape', '../../../../outside')

    def test_private_termux_rpath_allowed_but_foreign_rejected(self):
        private_lib = str(audit.PREFIX / 'lib')
        self.assertEqual(private_lib, 'data/user/0/com.karat.aibuilder/files/usr/lib')
        self.assertEqual(audit._rpath_errors(f' 0x0000 (RUNPATH) Library runpath: [{private_lib}]'), [])
        self.assertEqual(audit._rpath_errors(f' 0x0000 (RUNPATH) Library runpath: [/{private_lib}]'), [])
        self.assertEqual(audit._rpath_errors(' 0x0000 (RPATH) Library rpath: [/system/lib64]'), ['/system/lib64'])


if __name__ == '__main__':
    unittest.main()
