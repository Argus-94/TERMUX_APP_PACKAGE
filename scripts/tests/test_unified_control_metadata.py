"""Real disposable TEST-ONLY ar/tar fixtures, never installed or retained as candidates."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('controlaudit', Path(__file__).resolve().parents[1] / 'audit-unified-control-metadata.py')
M = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(M)
PREFIX = '/data/user/0/com.karat.aibuilder/files/usr'
FILE = PREFIX.lstrip('/') + '/etc/config'
CONTROL = b'Package: cue-control-fixture\nVersion: 1:1.0-1\nArchitecture: all\nInstalled-Size: 1\nMaintainer: TEST ONLY <test@example.invalid>\nDescription: disposable TEST ONLY fixture\n more text\nX-Test-Extension: allowed\n'

def tar(members):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as archive:
        for name, body, mode, kind, target in members:
            info = tarfile.TarInfo(name); info.mode = mode; info.type = kind; info.linkname = target
            info.size = len(body) if kind == tarfile.REGTYPE else 0
            archive.addfile(info, io.BytesIO(body) if info.size else None)
    return out.getvalue()

def ar(members):
    out = bytearray(b'!<arch>\n')
    for name, body in members:
        out.extend(f'{name + "/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(body):<10}`\n'.encode())
        out.extend(body)
        if len(body) % 2: out.extend(b'\n')
    return bytes(out)

class ControlAudit(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='control-TEST-ONLY-')
        self.addCleanup(self.temp.cleanup); self.root = Path(self.temp.name)

    def fixture(self, controls=None, payload=None):
        ctl = [('control', CONTROL, 0o644, tarfile.REGTYPE, '')] + list(controls or [])
        data = payload if payload is not None else [(FILE, b'TEST ONLY config\n', 0o644, tarfile.REGTYPE, '')]
        deb = self.root / 'TEST-ONLY.deb'
        deb.write_bytes(ar([('debian-binary', b'2.0\n'), ('control.tar', tar(ctl)), ('data.tar', tar(data))]))
        self.manifest = self.root / 'manifest.json'
        self.manifest.write_text(json.dumps({'packages': [{'name': 'cue-control-fixture', 'version': '1:1.0-1', 'architecture': 'all', 'sha256': hashlib.sha256(deb.read_bytes()).hexdigest()}]}))
        return deb

    def run_audit(self, deb):
        return M.audit(self.manifest, PREFIX, [deb])

    def test_real_epoch_control_and_extension(self):
        report = self.run_audit(self.fixture())
        self.assertEqual(report['packageCount'], 1)
        self.assertFalse(report['qualified'] or report['productionAllowed'])
        self.assertEqual(report['packages'][0]['md5sums'], 'ABSENT_OPTIONAL')

    def test_symlink_777_is_not_world_writable_regular_file(self):
        payload = [(FILE, b'config', 0o644, tarfile.REGTYPE, ''), (FILE + '.link', b'', 0o777, tarfile.SYMTYPE, 'config')]
        self.assertEqual(self.run_audit(self.fixture(payload=payload))['packageCount'], 1)

    def test_world_writable_regular_rejected(self):
        deb = self.fixture(payload=[(FILE, b'bad', 0o666, tarfile.REGTYPE, '')])
        with self.assertRaisesRegex(M.Reject, 'WORLD_WRITABLE'): self.run_audit(deb)

    def test_absolute_conffile_and_leading_remove_on_upgrade(self):
        body = f'{PREFIX}/etc/config\nremove-on-upgrade {PREFIX}/etc/old.conf\n'.encode()
        report = self.run_audit(self.fixture([('conffiles', body, 0o644, tarfile.REGTYPE, '')]))
        self.assertEqual(len(report['packages'][0]['conffiles']), 2)

    def test_obsolete_conffile_must_not_be_shipped(self):
        deb = self.fixture([('conffiles', f'remove-on-upgrade {PREFIX}/etc/config\n'.encode(), 0o644, tarfile.REGTYPE, '')])
        with self.assertRaisesRegex(M.Reject, 'OBSOLETE_CONFFILE_IN_PAYLOAD'): self.run_audit(deb)

    def test_named_and_path_await_triggers(self):
        body = f'interest-await cue-test-trigger\nactivate-noawait {PREFIX}/share/schema\n'.encode()
        report = self.run_audit(self.fixture([('triggers', body, 0o644, tarfile.REGTYPE, '')]))
        self.assertEqual(len(report['packages'][0]['triggers']), 2)

    def test_md5sums_archive_root_paths(self):
        body = (hashlib.md5(b'TEST ONLY config\n').hexdigest() + '  ' + FILE + '\n').encode()
        report = self.run_audit(self.fixture([('md5sums', body, 0o644, tarfile.REGTYPE, '')]))
        self.assertEqual(report['packages'][0]['md5sums'], 'PASS_PRESENT_ENTRIES_ONLY')

    def test_wrong_md5_rejected(self):
        deb = self.fixture([('md5sums', ('0' * 32 + '  ' + FILE + '\n').encode(), 0o644, tarfile.REGTYPE, '')])
        with self.assertRaisesRegex(M.Reject, 'MD5SUMS_MISMATCH'): self.run_audit(deb)

    def test_duplicate_md5_rejected(self):
        line = (hashlib.md5(b'TEST ONLY config\n').hexdigest() + '  ' + FILE + '\n').encode()
        deb = self.fixture([('md5sums', line * 2, 0o644, tarfile.REGTYPE, '')])
        with self.assertRaisesRegex(M.Reject, 'MD5SUMS_DUPLICATE'): self.run_audit(deb)

    def test_sh_script_syntax_only_never_executes(self):
        marker = self.root / 'MUST-NOT-EXIST'
        body = f'#!{PREFIX}/bin/sh\ntouch {marker}\n'.encode()
        report = self.run_audit(self.fixture([('postinst', body, 0o755, tarfile.REGTYPE, '')]))
        self.assertFalse(marker.exists())
        self.assertEqual(report['packages'][0]['maintainerScripts'][0]['syntax'], 'PASS_BASH_PARSE_ONLY')

    def test_0644_records_upstream_dpkg_setexecute_requirement(self):
        report = self.run_audit(self.fixture([('postinst', b'#!/bin/sh\necho TEST ONLY\n', 0o644, tarfile.REGTYPE, '')]))
        script = report['packages'][0]['maintainerScripts'][0]
        self.assertTrue(script['requiresDpkgSetexecute'])
        self.assertEqual(script['archivedMode'], '0o644')
        self.assertEqual(script['androidInterpreterAndEffects'], 'NOT_RUN')

    def test_no_shebang_records_execvp_fallback_without_execution(self):
        marker = self.root / 'MUST-NOT-RUN'
        body = f'touch {marker}\n'.encode()
        report = self.run_audit(self.fixture([('preinst', body, 0o644, tarfile.REGTYPE, '')]))
        script = report['packages'][0]['maintainerScripts'][0]
        self.assertTrue(script['requiresExecvpShellFallback'])
        self.assertEqual(script['syntax'], 'PASS_BASH_PARSE_ONLY')
        self.assertFalse(marker.exists())

    def test_broken_shell_rejected(self):
        deb = self.fixture([('postinst', b'#!/bin/sh\nif true; then\n', 0o755, tarfile.REGTYPE, '')])
        with self.assertRaisesRegex(M.Reject, 'MAINTSCRIPT_SHELL_SYNTAX'): self.run_audit(deb)

    def test_unknown_interpreter_is_not_executed(self):
        report = self.run_audit(self.fixture([('postinst', b'#!/nonexistent/interpreter\nTEST ONLY\n', 0o755, tarfile.REGTYPE, '')]))
        self.assertEqual(report['packages'][0]['maintainerScripts'][0]['syntax'], 'NOT_CHECKED_NON_SHELL')

    def test_foreign_app_path_rejected(self):
        deb = self.fixture([('postinst', b'#!/bin/sh\necho /data/data/com.termux/files/usr\n', 0o755, tarfile.REGTYPE, '')])
        with self.assertRaisesRegex(M.Reject, 'FOREIGN_STOCK_TERMUX_PATH'): self.run_audit(deb)

    def test_duplicate_control_member_rejected(self):
        deb = self.fixture([('control', CONTROL, 0o644, tarfile.REGTYPE, '')])
        with self.assertRaisesRegex(M.Reject, 'CONTROL_DUPLICATE_MEMBER'): self.run_audit(deb)

    def test_manifest_hash_required(self):
        deb = self.fixture(); data = json.loads(self.manifest.read_text()); del data['packages'][0]['sha256']; self.manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(M.Reject, 'MANIFEST_SHA256_REQUIRED'): self.run_audit(deb)

    def test_manifest_duplicate_and_input_duplicate_rejected(self):
        deb = self.fixture()
        with self.assertRaisesRegex(M.Reject, 'DUPLICATE_PACKAGE_IDENTITY'): M.audit(self.manifest, PREFIX, [deb, deb])
        data = json.loads(self.manifest.read_text()); data['packages'] *= 2; self.manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(M.Reject, 'MANIFEST_DUPLICATE_IDENTITY'): self.run_audit(deb)

if __name__ == '__main__':
    unittest.main(verbosity=2)
