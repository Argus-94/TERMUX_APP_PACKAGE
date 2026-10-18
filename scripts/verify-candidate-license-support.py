#!/usr/bin/env python3
"""Strict, non-installing verification of supplemental termux-licenses candidate bundles."""
import argparse, hashlib, json, pathlib, re, subprocess, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = ROOT / 'candidate-license-support-lock.json'
EXPECTED_SOURCE = '505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
PREFIX = 'data/user/0/com.karat.aibuilder/files/usr/'
REQUIRED = {'candidate-package-set.json', 'provenance.json', 'candidate-license-support-lock.json', 'keys/aibuilder-termux-feed-keyring.gpg', 'keys/feed-signing.json', 'signed-inventory.json', 'signed-inventory.json.asc', 'packages/termux-licenses_2.2_all.deb'}

def need(ok, why):
    if not ok: raise ValueError(why)
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def verify(bundle, fingerprint, producer):
    b = pathlib.Path(bundle).resolve(strict=True)
    need(re.fullmatch(r'[A-F0-9]{40}', fingerprint or '') is not None, 'EXTERNAL_FINGERPRINT_INVALID')
    need(re.fullmatch(r'[0-9a-f]{40}', producer or '') is not None, 'EXTERNAL_PRODUCER_INVALID')
    actual = set()
    for p in b.rglob('*'):
        rel = p.relative_to(b).as_posix()
        need(not p.is_symlink(), 'BUNDLE_SYMLINK_FORBIDDEN')
        if p.is_file():
            need('..' not in pathlib.PurePosixPath(rel).parts, 'BUNDLE_PATH_TRAVERSAL'); actual.add(rel)
    need(actual == REQUIRED, 'BUNDLE_ALLOWLIST_MISMATCH')
    inv = json.loads((b/'signed-inventory.json').read_text()); files = inv.get('files')
    expected_inventory = REQUIRED - {'signed-inventory.json', 'signed-inventory.json.asc'}
    need(isinstance(files, dict) and set(files) == expected_inventory, 'INVENTORY_FILE_SET_MISMATCH')
    for rel, h in files.items():
        need(isinstance(h, str) and re.fullmatch(r'[0-9a-f]{64}', h) and sha(b/rel) == h, 'INVENTORY_HASH_MISMATCH:'+rel)
    key = b/'keys/aibuilder-termux-feed-keyring.gpg'
    meta = json.loads((b/'keys/feed-signing.json').read_text())
    need(meta.get('schemaVersion') == 1 and meta.get('publicKeyring') == 'keys/aibuilder-termux-feed-keyring.gpg' and meta.get('publicKeyringSha256') == sha(key), 'PUBLIC_KEYRING_METADATA_MISMATCH')
    need(re.fullmatch(r'[A-F0-9]{40}', str(meta.get('fingerprint', ''))) is not None, 'PUBLIC_KEY_FINGERPRINT_METADATA_INVALID')
    p = subprocess.run(['gpgv', '--status-fd=1', '--keyring', str(key), str(b/'signed-inventory.json.asc'), str(b/'signed-inventory.json')], capture_output=True)
    status = p.stdout.decode('utf8', 'replace'); valid = [x.split() for x in status.splitlines() if '[GNUPG:] VALIDSIG ' in x]
    need(p.returncode == 0 and len(valid) == 1 and valid[0][2] == fingerprint, 'EXTERNAL_SIGNATURE_FINGERPRINT_MISMATCH')
    need(meta.get('fingerprint') == fingerprint, 'PUBLIC_KEY_FINGERPRINT_MISMATCH')
    lock_bytes = (b/'candidate-license-support-lock.json').read_bytes(); canonical = LOCK.read_bytes()
    need(lock_bytes == canonical, 'NONCANONICAL_SUPPORT_LOCK')
    lock = json.loads(lock_bytes)
    need(lock.get('schemaVersion') == 1 and lock.get('sourceCommit') == EXPECTED_SOURCE and lock.get('sourceRepository') == 'https://github.com/termux/termux-packages.git', 'SOURCE_LOCK_SCHEMA_MISMATCH')
    need(isinstance(lock.get('files'), dict) and isinstance(lock.get('packageTree'), dict) and isinstance(lock.get('package'), dict) and isinstance(lock.get('qualification'), dict), 'SOURCE_LOCK_SCHEMA_MISMATCH')
    # The source lock inventories all recipe inputs; only actual LICENSES/*.txt payloads ship.
    licenses = {name: digest for name, digest in lock['files'].items() if pathlib.PurePosixPath(name).parent.as_posix() == 'LICENSES' and pathlib.PurePosixPath(name).suffix == '.txt'}
    need(licenses and all(re.fullmatch(r'[0-9a-f]{64}', h or '') for h in licenses.values()), 'SOURCE_LOCK_LICENSE_SET_INVALID')
    prov = json.loads((b/'provenance.json').read_text())
    need(prov.get('sourceCommit') == EXPECTED_SOURCE, 'SOURCE_COMMIT_MISMATCH')
    need(prov.get('repositoryCommit') == producer, 'PRODUCER_COMMIT_MISMATCH')
    need(prov.get('builderImageDigest') == lock.get('builderImageDigest'), 'BUILDER_IMAGE_MISMATCH')
    need(prov.get('sourceLockSha256') == hashlib.sha256(lock_bytes).hexdigest(), 'SOURCE_LOCK_HASH_MISMATCH')
    need(prov.get('repeatBuildMatch') is True and re.fullmatch(r'[0-9a-f]{64}', str(prov.get('repeatBuildSha256', ''))) is not None, 'REPEAT_BUILD_MISMATCH')
    need(prov.get('qualified') is False and prov.get('productionAllowed') is False and prov.get('noAndroidInstallation') is True, 'QUALIFICATION_GATE_MISMATCH')
    pset = json.loads((b/'candidate-package-set.json').read_text()); packages = pset.get('packages')
    need(isinstance(packages, list) and len(packages) == 1 and pset.get('qualified') is False and pset.get('productionAllowed') is False, 'SUPPORT_PACKAGE_SET_NOT_EXACT')
    pkg = packages[0]; deb = b/'packages/termux-licenses_2.2_all.deb'; package_sha = sha(deb)
    need((pkg.get('name'), pkg.get('version'), pkg.get('architecture')) == ('termux-licenses', '2.2', 'all') and pkg.get('filename') == 'packages/termux-licenses_2.2_all.deb' and pkg.get('sha256') == package_sha == prov.get('packageSha256') == prov.get('repeatBuildSha256'), 'PACKAGE_IDENTITY_OR_HASH_MISMATCH')
    with tempfile.TemporaryDirectory() as td:
        root = pathlib.Path(td); data = root/'data'; control = root/'control'; data.mkdir(); control.mkdir()
        subprocess.run(['dpkg-deb', '-x', str(deb), str(data)], check=True, capture_output=True)
        subprocess.run(['dpkg-deb', '-e', str(deb), str(control)], check=True, capture_output=True)
        fields = subprocess.check_output(['dpkg-deb', '-f', str(deb), 'Package'], text=True).strip(), subprocess.check_output(['dpkg-deb', '-f', str(deb), 'Version'], text=True).strip(), subprocess.check_output(['dpkg-deb', '-f', str(deb), 'Architecture'], text=True).strip()
        need(fields == ('termux-licenses', '2.2', 'all'), 'DEB_CONTROL_IDENTITY_MISMATCH')
        payload = {p.relative_to(data).as_posix() for p in data.rglob('*') if p.is_file() or p.is_symlink()}
        need(not any(p.is_symlink() for p in data.rglob('*')), 'PAYLOAD_SYMLINK_FORBIDDEN')
        licdir = PREFIX+'share/LICENSES'; expected = {licdir+'/'+pathlib.PurePosixPath(f).name for f in licenses}
        expected.add(PREFIX+'share/doc/termux-licenses/copyright')
        need(payload == expected, 'PAYLOAD_PATH_SET_MISMATCH')
        for source, h in licenses.items():
            target = data/(licdir+'/'+pathlib.PurePosixPath(source).name)
            need(sha(target) == h, 'LICENSE_CONTENT_HASH_MISMATCH:'+target.name)
        need(sha(data/(PREFIX+'share/doc/termux-licenses/copyright')) == licenses['LICENSES/GPL-3.0.txt'], 'COPYRIGHT_HASH_MISMATCH')
    return {'valid': True, 'qualified': False, 'productionAllowed': False, 'android': 'NOT_RUN', 'installPerformed': False, 'package': {'name':'termux-licenses','version':'2.2','architecture':'all','sha256':package_sha}, 'sourceCommit':EXPECTED_SOURCE,'producerCommit':producer,'fingerprint':fingerprint,'builderImageDigest':lock['builderImageDigest'],'supportLockSha256':hashlib.sha256(lock_bytes).hexdigest()}
def main():
    p=argparse.ArgumentParser(); p.add_argument('--bundle-dir',required=True); p.add_argument('--expected-fingerprint',required=True); p.add_argument('--expected-producer',required=True); p.add_argument('--report',type=pathlib.Path); a=p.parse_args(); r=verify(a.bundle_dir,a.expected_fingerprint,a.expected_producer); text=json.dumps(r,indent=2,sort_keys=True)+'\n'; a.report.write_text(text) if a.report else print(text)
if __name__=='__main__':
    try: main()
    except Exception as e: print('support verifier: '+str(e),file=sys.stderr); sys.exit(2)
