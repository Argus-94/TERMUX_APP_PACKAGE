#!/usr/bin/env python3
"""Derive test-only runtime allowlists from the exact retained candidate and pinned bootstrap; never re-sign or install."""
import argparse
import hashlib
import io
import email.utils
import datetime
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PREFIX = 'data/user/0/com.karat.aibuilder/files/usr'
MANIFEST_SHA = None
SUMMARY_SHA = '134b459f80a77006a9fc1e501aa90f63b64579c2864735ffd62c5f963dcc6a72'
INVENTORY_SHA = '77fb565ce17fd99aa3f1e350c5affe4e09c40adc5be6771a808d2e9ecee2554c'


def digest_file(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def safe(value):
    if any(character in value for character in '\t\r\n\0'):
        raise ValueError('non-TSV input')
    return value


def relative(name):
    clean = name.removeprefix('./').rstrip('/')
    if clean.startswith('/') or '..' in PurePosixPath(clean).parts:
        raise ValueError('unsafe archive member: ' + clean)
    if clean == PREFIX:
        return '.'
    if clean.startswith(PREFIX + '/'):
        return safe(clean[len(PREFIX) + 1:])
    if PREFIX.startswith(clean + '/') or clean in ('', '.'):
        return None
    raise ValueError('payload escapes exact modeled app prefix: ' + clean)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--feed-root', required=True, type=Path)
    args = parser.parse_args()
    global MANIFEST_SHA
    summary_path = ROOT / 'docs/coherent-candidate/replay-summary.json'
    assert digest_file(summary_path) == SUMMARY_SHA
    summary = json.loads(summary_path.read_text())
    assert summary['valid'] is True and summary['productionAllowed'] is False and summary['qualified'] is False and summary['android'] == 'NOT_RUN'
    assert str(summary['aggregateRunId']) == '39299572605' and summary['packageCount'] == 82
    MANIFEST_SHA = summary['manifestSha256']
    manifest_path = ROOT / 'docs/coherent-candidate/aggregate-manifest.json'
    inventory_path = ROOT / 'docs/coherent-candidate/aggregate-archive-inventory.json'
    assert digest_file(manifest_path) == MANIFEST_SHA
    assert digest_file(inventory_path) == INVENTORY_SHA
    manifest = json.loads(manifest_path.read_text())
    inventory = json.loads(inventory_path.read_text())['files']
    packages = manifest['packages']
    assert len(packages) == 82
    by_basename = {PurePosixPath(name).name: name.removeprefix('aggregate/candidate-feed/') for name in inventory if name.startswith('aggregate/candidate-feed/pool/') and name.endswith('.deb')}
    assert len(by_basename) == 82
    output = ROOT / 'assets/termux-candidate-full'
    output.mkdir(parents=True, exist_ok=True)
    package_rows = []
    payload_rows = []
    control_evidence = {}
    installed_bytes = archive_bytes = 0
    for package in sorted(packages, key=lambda item: item['name']):
        name, version = package['name'], package['version']
        assert re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', name)
        assert re.fullmatch(r'[A-Za-z0-9.+:~_-]+', version)
        rel = by_basename[package['filename']]
        path = args.feed_root / rel
        assert path.is_file() and not path.is_symlink()
        assert digest_file(path) == package['sha256']
        package_rows.append([name, version, package['architecture'], package['sha256'], rel])
        control = subprocess.check_output(['dpkg-deb', '--ctrl-tarfile', str(path)])
        conffiles = set()
        with tarfile.open(fileobj=io.BytesIO(control)) as controls:
            conf = next((item for item in controls if item.name.removeprefix('./') == 'conffiles'), None)
            if conf is not None:
                assert conf.isfile()
                for line in controls.extractfile(conf).read().decode().splitlines():
                    if line.strip():
                        absolute = line.split()[0]
                        assert absolute.startswith('/' + PREFIX + '/')
                        conffiles.add(relative(absolute.removeprefix('/')))
        kib = subprocess.check_output(['dpkg-deb', '-f', str(path), 'Installed-Size']).decode().strip()
        assert re.fullmatch(r'[0-9]+', kib)
        installed_bytes += int(kib) * 1024
        archive_bytes += path.stat().st_size
        process = subprocess.Popen(['dpkg-deb', '--fsys-tarfile', str(path)], stdout=subprocess.PIPE)
        known = {}
        with tarfile.open(fileobj=process.stdout, mode='r|*') as archive:
            for member in archive:
                relpath = relative(member.name)
                if relpath is None:
                    assert member.isdir()
                    continue
                if member.isdir():
                    kind, value = 'dir', '-'
                elif member.issym():
                    kind, value = 'symlink', safe(member.linkname)
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname('/' + PREFIX + '/' + relpath), value))
                    assert resolved == '/' + PREFIX or resolved.startswith('/' + PREFIX + '/'), (name, relpath, value)
                elif member.isreg():
                    kind = 'conffile' if relpath in conffiles else 'file'
                    h = hashlib.sha256()
                    stream = archive.extractfile(member)
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        h.update(chunk)
                    value = h.hexdigest()
                    known[member.name.removeprefix('./')] = value
                elif member.islnk():
                    target = member.linkname.removeprefix('./')
                    kind, value = 'file', known[target]
                else:
                    raise ValueError('special device/FIFO in candidate: ' + member.name)
                payload_rows.append([name, relpath, kind, value])
        process.stdout.close()
        assert process.wait() == 0
        control_evidence[name] = {'controlTarSha256': hashlib.sha256(control).hexdigest(), 'packageSha256': package['sha256'], 'sourceDeclaredConffiles': sorted(conffiles)}
    bootstrap_path = ROOT / 'assets/termux-bootstrap/termux-bootstrap-aarch64.zip'
    provenance = json.loads((ROOT / 'assets/termux-bootstrap/termux-bootstrap-aarch64.zip.provenance.json').read_text())
    assert digest_file(bootstrap_path) == provenance['archiveSha256'] == summary['bootstrapSha256']
    bootstrap_rows = []
    with zipfile.ZipFile(bootstrap_path) as archive:
        for member in archive.infolist():
            rel = member.filename.removeprefix('./').rstrip('/')
            if member.is_dir() or rel == 'SYMLINKS.txt':
                continue
            assert not rel.startswith('/') and '..' not in PurePosixPath(rel).parts
            bootstrap_rows.append([safe(rel), 'file', hashlib.sha256(archive.read(member)).hexdigest()])
        for line in archive.read('SYMLINKS.txt').decode().splitlines():
            if not line.strip():
                continue
            target, rel = line.split('←', 1)
            bootstrap_rows.append([safe(rel.removeprefix('./')), 'symlink', safe(target)])
        status_text = archive.read('var/lib/dpkg/status').decode()
    bootstrap_paths = {row[0] for row in bootstrap_rows}
    protected = sorted({name for name, rel, kind, value in payload_rows if kind != 'dir' and rel in bootstrap_paths})
    for filename, rows in [('packages.tsv', package_rows), ('payloads.tsv', payload_rows), ('bootstrap-baseline.tsv', bootstrap_rows)]:
        (output / filename).write_text(''.join('\t'.join(row) + '\n' for row in rows))
    definitions = [{'name': row[0], 'version': row[1], 'architecture': row[2], 'sha256': row[3]} for row in package_rows]
    release = (output / 'dists/stable/Release').read_text()
    valid_line = next(line.split(': ', 1)[1] for line in release.splitlines() if line.startswith('Valid-Until: '))
    valid_until = email.utils.parsedate_to_datetime(valid_line).astimezone(datetime.timezone.utc)
    assert valid_until > datetime.datetime.now(datetime.timezone.utc)
    cache_name = 'candidate-feed-' + MANIFEST_SHA[:12]
    required_free_bytes = installed_bytes + 2 * archive_bytes + 128 * 1024 * 1024
    template = (ROOT / 'scripts/candidate-cohort-install-template.sh').read_text()
    replacements = {'@@CACHE_NAME@@': cache_name, '@@KEY_SHA@@': summary['publicKeyringSha256'], '@@FINGERPRINT@@': summary['fingerprint'], '@@REQUIRED_SPACE_BYTES@@': str(required_free_bytes)}
    for token, value in replacements.items():
        assert token in template
        template = template.replace(token, value)
    assert '@@' not in template
    (output / 'candidate-command.sh').write_text(template)
    generated = '// Generated by scripts/aib-full-candidate-inputs.py from exact immutable retained hashes.\n'
    generated += 'export const CANDIDATE_PACKAGES = ' + json.dumps(definitions, ensure_ascii=False, indent=2) + ' as const;\n'
    generated += 'export const CANDIDATE_PROTECTED_PACKAGES: readonly string[] = ' + json.dumps(protected) + ';\n'
    for field, value in [('CANDIDATE_CACHE_NAME', cache_name), ('CANDIDATE_MANIFEST_SHA256', MANIFEST_SHA), ('CANDIDATE_SIGNER_FINGERPRINT', summary['fingerprint']), ('CANDIDATE_RELEASE_VALID_UNTIL', valid_until.isoformat()), ('CANDIDATE_REQUIRED_PRIVATE_FREE_BYTES', required_free_bytes)]:
        generated += 'export const ' + field + ' = ' + json.dumps(value) + ' as const;\n'
    (ROOT / 'lib/candidate-full-packages.generated.ts').write_text(generated)
    evidence = {'manifestSha256': MANIFEST_SHA, 'archiveInventorySha256': INVENTORY_SHA,
                'bootstrapSha256': provenance['archiveSha256'], 'packageCount': len(packages),
                'payloadCount': len(payload_rows), 'bootstrapPayloadCount': len(bootstrap_rows),
                'protectedRemovalPackages': protected, 'controlTarEvidence': control_evidence, 'requiredPrivateFreeBytes': required_free_bytes, 'installedPayloadBytes': installed_bytes, 'archiveBytes': archive_bytes, 'releaseValidUntilUtc': valid_until.isoformat(), 'coherentCiRunId': str(summary['aggregateRunId']), 'configurationPolicy': 'preserve only signed-control-declared conffiles and record their hashes; verify every immutable payload', 'qualified': False, 'productionAllowed': False, 'android': 'NOT_RUN',
                'inputs': {filename: digest_file(output / filename) for filename in ['packages.tsv', 'payloads.tsv', 'bootstrap-baseline.tsv']}}
    (ROOT / 'docs/coherent-candidate/full-candidate-inputs.json').write_text(json.dumps(evidence, indent=2) + '\n')
    (ROOT / 'verification-v493/bootstrap-private-status.txt').write_text(status_text)
    print(json.dumps({key: value for key, value in evidence.items() if key != 'controlTarEvidence'}, indent=2))


if __name__ == '__main__':
    main()
