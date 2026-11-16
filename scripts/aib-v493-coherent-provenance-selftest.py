#!/usr/bin/env python3
"""Verify the installed source bundle's sealed CI bindings; no package install or Android execution."""
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile
import datetime
import email.utils

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / 'docs/coherent-candidate'
ASSETS = ROOT / 'assets/termux-candidate-full'

def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def signed(key, fingerprint, args):
    result = subprocess.run(['gpgv', '--status-fd=1', '--keyring', str(key)] + [str(x) for x in args], capture_output=True, text=True, check=True)
    assert 'VALIDSIG ' + fingerprint + ' ' in result.stdout
    assert not any(marker in result.stdout for marker in ('EXPKEYSIG', 'REVKEYSIG', 'BADSIG', 'ERRSIG', 'KEYEXPIRED'))

def main():
    assert digest(DOC / 'replay-summary.json') == '134b459f80a77006a9fc1e501aa90f63b64579c2864735ffd62c5f963dcc6a72'
    assert digest(DOC / 'aggregate-archive-inventory.json') == '77fb565ce17fd99aa3f1e350c5affe4e09c40adc5be6771a808d2e9ecee2554c'
    summary = json.loads((DOC / 'replay-summary.json').read_text())
    assert summary['valid'] is True and str(summary['aggregateRunId']) == '39299572605'
    assert summary['qualified'] is False and summary['productionAllowed'] is False and summary['android'] == 'NOT_RUN'
    assert summary['packageCount'] == 82 and summary['requestedRootCount'] == 13 and summary['authenticatedArchiveCopies'] == 82
    assert summary['signedAptRootPlan'] == summary['signedAptFullReinstallPlan'] == summary['compressionBaselineAbi'] == summary['pinnedSourceHostBehavior'] == 'PASS'
    assert summary['retainedOriginalPackages'] == 80 and summary['newSourceBuiltCompanions'] == 2 and summary['bootstrapChanged'] is False
    assert digest(DOC / 'aggregate-manifest.json') == summary['manifestSha256']
    key = ASSETS / 'keys/aibuilder-termux-feed-keyring.gpg'
    assert digest(key) == summary['publicKeyringSha256']
    signed(key, summary['fingerprint'], [DOC / 'aggregate-manifest.json.asc', DOC / 'aggregate-manifest.json'])
    signed(key, summary['fingerprint'], [ASSETS / 'dists/stable/Release.gpg', ASSETS / 'dists/stable/Release'])
    with tempfile.TemporaryDirectory(prefix='aib-source-signature-') as temporary:
        output = Path(temporary) / 'release'
        signed(key, summary['fingerprint'], ['--output', output, ASSETS / 'dists/stable/InRelease'])
        assert output.read_bytes() == (ASSETS / 'dists/stable/Release').read_bytes()
    release = (ASSETS / 'dists/stable/Release').read_text()
    validity = email.utils.parsedate_to_datetime(next(line.split(': ', 1)[1] for line in release.splitlines() if line.startswith('Valid-Until: ')))
    assert validity > datetime.datetime.now(datetime.timezone.utc), 'TEST_FEED_EXPIRED_REQUIRES_FRESH_SOURCE_VERIFIED_CI'
    manifest = json.loads((DOC / 'aggregate-manifest.json').read_text())
    assert len(manifest['packages']) == 82
    expected = {item['filename']: item for item in manifest['packages']}
    assert len(expected) == 82
    actual = list((ASSETS / 'pool').rglob('*.deb'))
    assert len(actual) == 82
    for path in actual:
        assert path.is_file() and not path.is_symlink() and path.name in expected
        assert digest(path) == expected[path.name]['sha256']
    bootstrap = ROOT / 'assets/termux-bootstrap/termux-bootstrap-aarch64.zip'
    assert digest(bootstrap) == summary['bootstrapSha256']
    generated = json.loads((DOC / 'full-candidate-inputs.json').read_text())
    assert generated['packageCount'] == 82 and generated['manifestSha256'] == summary['manifestSha256']
    assert generated['qualified'] is False and generated['productionAllowed'] is False and generated['android'] == 'NOT_RUN'
    template = (ROOT / 'scripts/candidate-cohort-install-template.sh').read_text()
    replacements = {'@@CACHE_NAME@@': 'candidate-feed-' + summary['manifestSha256'][:12], '@@KEY_SHA@@': summary['publicKeyringSha256'], '@@FINGERPRINT@@': summary['fingerprint'], '@@REQUIRED_SPACE_BYTES@@': str(generated['requiredPrivateFreeBytes'])}
    for token, value in replacements.items():
        assert token in template
        template = template.replace(token, value)
    assert template == (ASSETS / 'candidate-command.sh').read_text(), 'CLI_DIFFERS_FROM_TESTED_SOURCE_TEMPLATE'
    rows = [line.split('\t') for line in (ASSETS / 'payloads.tsv').read_text().splitlines()]
    declared = {(name, path) for name, evidence in generated['controlTarEvidence'].items() for path in evidence['sourceDeclaredConffiles']}
    configs = {(name, path) for name, path, kind, value in rows if kind == 'conffile'}
    assert configs == declared, 'CONFFILE_EXEMPTIONS_NOT_EXACT_SIGNED_CONTROL_DECLARATIONS'
    assert all(kind in ('file', 'conffile', 'symlink', 'dir') for name, path, kind, value in rows)
    for name, expected_hash in generated['inputs'].items():
        assert digest(ASSETS / name) == expected_hash
    receipt = {'status': 'PASS', 'ciRunId': summary['aggregateRunId'], 'packageCount': len(actual), 'rootCount': summary['requestedRootCount'], 'signedManifestSha256': summary['manifestSha256'], 'scriptMatchesTestedTemplate': True, 'signedControlConffileCount': len(configs), 'bootstrapUnchanged': True, 'qualified': False, 'productionAllowed': False, 'androidExecution': 'NOT_RUN'}
    receipt_path = ROOT / 'verification-v493/coherent-provenance.json'
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    print('COHERENT_SOURCE_PROVENANCE_PASS packages=82 roots=13 signatures=PASS template=PASS conffiles=exact-signed-control production=false Android=NOT_RUN')

if __name__ == '__main__':
    main()
