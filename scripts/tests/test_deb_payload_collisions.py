import importlib.util
import io
import pathlib
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'audit-deb-payload-collisions.py'
spec = importlib.util.spec_from_file_location('deb_audit', SCRIPT)
auditmod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auditmod)


def tarbytes(items):
    buffer = io.BytesIO()
    with __import__('tarfile').open(fileobj=buffer, mode='w:gz') as archive:
        for name, kind, payload, mode in items:
            info = __import__('tarfile').TarInfo(name)
            info.mode = mode
            if kind == 'dir':
                info.type = __import__('tarfile').DIRTYPE
                archive.addfile(info)
            elif kind in ('link', 'hard', 'fifo'):
                info.type = {'link': __import__('tarfile').SYMTYPE,
                             'hard': __import__('tarfile').LNKTYPE,
                             'fifo': __import__('tarfile').FIFOTYPE}[kind]
                info.linkname = payload if kind != 'fifo' else ''
                archive.addfile(info)
            else:
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def arbytes(members, corrupt_padding=False):
    output = bytearray(b'!<arch>\n')
    for name, data in members:
        header = (name + '/').ljust(16) + '0'.ljust(12) + '0'.ljust(6) + '0'.ljust(6)
        header += str(100644).ljust(8) + str(len(data)).ljust(10) + '`\n'
        output.extend(header.encode())
        output.extend(data)
        if len(data) % 2:
            output.extend(b'X' if corrupt_padding else b'\n')
    return bytes(output)


def control_tar(package='a', fields=None):
    content = f'Package: {package}\nVersion: 1\nArchitecture: all\n'.encode()
    if fields:
        content = fields.encode()
    return tarbytes([('./control', 'file', content, 0o644)])


def deb(package, payload, version='1', arch='all', control=None, extra=None):
    members = [('debian-binary', b'2.0\n'),
               ('control.tar.gz', control or control_tar(package)),
               ('data.tar.gz', tarbytes(payload))]
    if extra:
        members.extend(extra)
    return arbytes(members)


class DebPayloadAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, name, data):
        path = self.directory / name
        path.write_bytes(data)
        return path

    def rejected(self, blobs, token):
        paths = [self.file(f'{index}.deb', blob) for index, blob in enumerate(blobs)]
        with self.assertRaisesRegex(auditmod.Reject, token):
            auditmod.audit(paths)

    def test_normal_dot_root_and_dot_slash_paths(self):
        package = deb('a', [('./', 'dir', b'', 0o755),
                            ('./usr/', 'dir', b'', 0o755),
                            ('./usr/bin/tool', 'file', b'x', 0o755)])
        path = self.file('normal.deb', package)
        self.assertEqual(auditmod.audit([path])['result'], 'no-collisions')

    def test_shared_directories_allowed(self):
        first = self.file('a.deb', deb('a', [('./usr/', 'dir', b'', 0o755),
                                             ('./usr/bin/a', 'file', b'a', 0o755)]))
        second = self.file('b.deb', deb('b', [('./usr/', 'dir', b'', 0o755),
                                              ('./usr/bin/b', 'file', b'b', 0o755)]))
        result = auditmod.audit([first, second])
        self.assertFalse(result['qualified'])
        self.assertEqual(result['packageCount'], 2)

    def test_file_collisions(self):
        self.rejected([deb('a', [('./opt/x', 'file', b'a', 0o644)]),
                       deb('b', [('./opt/x', 'file', b'b', 0o644)])], 'CROSS_PACKAGE_COLLISION')

    def test_file_directory_collision(self):
        self.rejected([deb('a', [('./opt/x', 'file', b'a', 0o644)]),
                       deb('b', [('./opt/x/', 'dir', b'', 0o755)])], 'CROSS_PACKAGE_COLLISION')

    def test_cross_package_implicit_file_ancestor_both_orders(self):
        file_package = deb('file', [('./usr/x', 'file', b'x', 0o644)])
        child_package = deb('child', [('./usr/x/y', 'file', b'y', 0o644)])
        self.rejected([file_package, child_package], 'CROSS_PACKAGE_COLLISION')
        self.rejected([child_package, file_package], 'CROSS_PACKAGE_COLLISION')

    def test_in_package_implicit_file_ancestor_both_orders(self):
        for items in ([('./usr/x', 'file', b'x', 0o644), ('./usr/x/y', 'file', b'y', 0o644)],
                      [('./usr/x/y', 'file', b'y', 0o644), ('./usr/x', 'file', b'x', 0o644)]):
            with self.subTest(items=items):
                self.rejected([deb('a', items)], 'INTRA_PACKAGE_COLLISION')

    def test_traversal_and_absolute(self):
        for name in ('../escape', '/usr/bin/x', './usr/../x', '././usr/x', './'):
            if name == './':
                # Root is permitted only as a directory.
                self.rejected([deb('a', [(name, 'file', b'x', 0o644)])], 'UNSAFE_PATH')
            else:
                with self.subTest(name=name):
                    self.rejected([deb('a', [(name, 'file', b'x', 0o644)])], 'UNSAFE_PATH')

    def test_links_specials_and_setid_rejected(self):
        for kind in ('link', 'hard', 'fifo'):
            with self.subTest(kind=kind):
                self.rejected([deb('a', [('./usr/x', kind, 'target', 0o644)])],
                              'LINK_OR_SPECIAL_REJECTED')
        self.rejected([deb('a', [('./usr/bin/x', 'file', b'x', 0o4755)])], 'SETID_MODE')

    def test_duplicate_identity_different_hash_rejected(self):
        self.rejected([deb('a', [('./x', 'file', b'a', 0o644)]),
                       deb('a', [('./x', 'file', b'b', 0o644)])],
                      'DUPLICATE_PACKAGE_DIFFERENT_HASH')

    def test_duplicate_identical_hash_reported_once(self):
        first = self.file('same-a.deb', deb('a', [('./x', 'file', b'a', 0o644)]))
        second = self.file('same-b.deb', first.read_bytes())
        result = auditmod.audit([first, second])
        self.assertEqual(result['packageCount'], 1)
        self.assertFalse(result['provenanceValidated'])

    def test_duplicate_control_identity_field_rejected(self):
        fields = 'Package: a\nPackage: b\nVersion: 1\nArchitecture: all\n'
        self.rejected([deb('a', [('./x', 'file', b'x', 0o644)], control=control_tar(fields=fields))],
                      'CONTROL_DUPLICATE_FIELD')

    def test_ar_alternative_combinations_and_member_order_rejected(self):
        ct = control_tar()
        dt = tarbytes([])
        self.rejected([deb('a', [], extra=[('control.tar.xz', ct)])], 'BAD_DEB_MEMBERS')
        members = [('debian-binary', b'2.0\n'), ('data.tar.gz', dt), ('control.tar.gz', ct)]
        path = self.file('order.deb', arbytes(members))
        with self.assertRaisesRegex(auditmod.Reject, 'BAD_DEB_MEMBER_ORDER'):
            auditmod.audit([path])

    def test_bad_odd_ar_padding_rejected(self):
        path = self.file('padding.deb', arbytes([('debian-binary', b'2.0\nx')], corrupt_padding=True))
        with self.assertRaisesRegex(auditmod.Reject, 'BAD_AR_PADDING'):
            auditmod.audit([path])

    def test_unknown_archive_and_bad_compression_rejected_cleanly(self):
        path = self.file('unknown.deb', b'not an ar archive')
        with self.assertRaisesRegex(auditmod.Reject, 'NOT_AR'):
            auditmod.audit([path])
        bad = arbytes([('debian-binary', b'2.0\n'), ('control.tar.gz', b'not gzip'),
                       ('data.tar.gz', b'not gzip')])
        path = self.file('bad-compression.deb', bad)
        with self.assertRaisesRegex(auditmod.Reject, 'BAD_COMPRESSED_TAR'):
            auditmod.audit([path])

    def test_unknown_ar_member_compression_rejected(self):
        path = self.file('unknown-compression.deb', arbytes([
            ('debian-binary', b'2.0\n'), ('control.tar.zst', b'anything'),
            ('data.tar.gz', tarbytes([]))]))
        with self.assertRaisesRegex(auditmod.Reject, 'UNSUPPORTED_AR_MEMBER'):
            auditmod.audit([path])

    def test_payload_symlink_never_extracted(self):
        target = self.directory / 'created-by-extraction'
        payload = deb('a', [('./escape-link', 'link', str(target), 0o777)])
        self.rejected([payload], 'LINK_OR_SPECIAL_REJECTED')
        self.assertFalse(target.exists())

    def test_duplicate_control_member_rejected(self):
        fields = b'Package: a\nVersion: 1\nArchitecture: all\n'
        control = tarbytes([('./control', 'file', fields, 0o644),
                            ('control', 'file', fields, 0o644)])
        self.rejected([deb('a', [], control=control)], 'DUPLICATE_CONTROL_MEMBER')

    def test_decompression_limit_enforced(self):
        with mock.patch.object(auditmod, 'MAX_TAR_SIZE', 100):
            self.rejected([deb('a', [])], 'DECOMPRESSED_TAR_TOO_LARGE')

    def test_large_inventory_ancestor_validation(self):
        entries = {f'usr/share/fixtures/file-{i}': 'file' for i in range(10000)}
        auditmod.reject_ancestor_conflicts(entries, 'COLLISION')
        entries['usr/share'] = 'file'
        with self.assertRaisesRegex(auditmod.Reject, 'COLLISION'):
            auditmod.reject_ancestor_conflicts(entries, 'COLLISION')


if __name__ == '__main__':
    unittest.main()
