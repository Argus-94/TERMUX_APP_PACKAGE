#!/usr/bin/env python3
"""Retain a source-verified test candidate only after all prerequisite receipts agree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

def need(ok, reason):
    if not ok:
        raise ValueError(reason)

def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def load(path):
    need(path.is_file() and not path.is_symlink(), 'RECEIPT_NOT_REGULAR:' + str(path.name))
    return json.loads(path.read_text())

def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('aggregate', 'base-root', 'repro-a', 'repro-b', 'lock', 'output'):
        p.add_argument('--' + name, required=True, type=Path)
    args = p.parse_args()
    root = args.aggregate
    feed = root / 'candidate-feed'
    lock = load(args.lock)
    manifest = load(feed / 'aggregate-manifest.json')
    coverage = load(feed / 'full-reproducibility-coverage.json')
    source = load(feed / 'compat-report.json')
    apt = load(root / 'apt-proof/apt-proof-report.json')
    abi = load(root / 'compression-abi.json')
    behavior = load(root / 'compression-host-behavior.json')
    payload = load(root / 'aggregate-payload-report.json')
    controls = load(root / 'aggregate-control-report.json')
    need(len(manifest['packages']) == 82 and manifest['qualified'] is False and manifest['productionAllowed'] is False, 'MANIFEST_SCOPE_INVALID')
    need(source['valid'] is True and source['newPackagesReproducible'] is True and source['retainedBaseCount'] == 80 and source['newPackageCount'] == 2 and source['privateKeyRetained'] is False, 'SOURCE_REPRODUCIBILITY_NOT_PROVEN')
    need(source['producerCommit'] == lock['buildProducerCommit'], 'SOURCE_PRODUCER_MISMATCH')
    need(source['manifestSha256'] == sha(feed / 'aggregate-manifest.json'), 'SOURCE_MANIFEST_BINDING_MISMATCH')
    need(coverage['complete'] is True and coverage['packageCount'] == 82 and len(coverage['packages']) == 82 and all(row['reproducibilityVerified'] is True for row in coverage['packages']), 'FULL_REPRODUCIBILITY_COVERAGE_MISSING')
    need(sha(feed / 'full-reproducibility-coverage.json') == manifest['reproducibilityCoverageSha256'], 'COVERAGE_MANIFEST_BINDING_MISMATCH')
    need(apt['valid'] is True and apt['requestedRootCount'] == 13 and apt['packageCount'] == 82 and apt['aptDownloadCount'] == 82 and apt['fullPlanInstCount'] == 82 and apt['installPerformed'] is False and apt['android'] == 'NOT_RUN', 'APT_BOOTSTRAP_COMPATIBILITY_NOT_PROVEN')
    need(apt['manifestSha256'] == sha(feed / 'aggregate-manifest.json'), 'APT_MANIFEST_BINDING_MISMATCH')
    need(abi['abi_compatible'] is True and not abi['errors'] and len(abi['libraries']) >= 2, 'COMPRESSION_ABI_NOT_PROVEN')
    need(behavior['status'] == 'PASS' and behavior['host_behavior_tested'] is True and behavior['android_target_behavior_tested'] is False, 'HOST_BEHAVIOR_NOT_PROVEN')
    for report,verdict in ((payload,'pass-limited-no-ELF-or-ABI-qualification'),(controls,'PASS_STATIC_CONTROL_METADATA_ONLY')):
        need(report['packageCount'] == 82 and report['result']==verdict and report['qualified'] is False and report['productionAllowed'] is False, 'WHOLE_AGGREGATE_STATIC_AUDIT_REJECTED')
    signing = load(feed / 'keys/feed-signing.json')
    key = feed / signing['publicKeyring']
    need(sha(key) == signing['publicKeyringSha256'], 'KEYRING_BINDING_MISMATCH')
    verification = subprocess.run(['gpgv', '--status-fd=1', '--keyring', str(key), str(feed / 'aggregate-manifest.json.asc'), str(feed / 'aggregate-manifest.json')], capture_output=True, text=True, check=True)
    need('VALIDSIG ' + signing['fingerprint'] + ' ' in verification.stdout, 'SIGNED_MANIFEST_REJECTED')
    summary = {
        'valid': True, 'status': 'SOURCE_VERIFIED_TEST_ONLY_CANDIDATE',
        'packageCount': 82, 'requestedRootCount': 13, 'requestedRoots': lock['requestedRoots'],
        'sourceBuildRunId': lock['buildRunId'], 'sourceBuildProducerCommit': lock['buildProducerCommit'],
        'aggregateProducerCommit': os.environ.get('GITHUB_SHA'), 'aggregateRunId': os.environ.get('GITHUB_RUN_ID'),
        'retainedOriginalPackages': 80, 'newSourceBuiltCompanions': 2,
        'bootstrapChanged': False, 'bootstrapSha256': lock['bootstrap']['sha256'],
        'manifestSha256': sha(feed / 'aggregate-manifest.json'),
        'fingerprint': signing['fingerprint'], 'publicKeyringSha256': signing['publicKeyringSha256'],
        'fullReproducibilityCoverageSha256': sha(feed / 'full-reproducibility-coverage.json'),
        'signedAptRootPlan': 'PASS', 'signedAptFullReinstallPlan': 'PASS', 'authenticatedArchiveCopies': 82,
        'compressionBaselineAbi': 'PASS', 'pinnedSourceHostBehavior': 'PASS',
        'wholePayloadAudit': payload['result'], 'wholeControlAudit': controls['result'],
        'sourceCandidatePreparedForDeviceTest': True, 'allToolsAndroidReady': False,
        'installPerformed': False, 'android': 'NOT_RUN', 'qualified': False, 'productionAllowed': False,
        'pagesEnabled': False, 'privateKeyRetained': False,
    }
    (root / 'replay-summary.json').write_text(json.dumps(summary, indent=2, sort_keys=True) + '\n')
    shutil.copyfile(feed / 'aggregate-manifest.json', root / 'aggregate-manifest.json')
    shutil.copyfile(feed / 'aggregate-manifest.json.asc', root / 'aggregate-manifest.json.asc')
    shutil.copyfile(feed / 'full-reproducibility-coverage.json', root / 'full-reproducibility-coverage.json')
    need(not args.output.exists(), 'OUTPUT_MUST_BE_NEW')
    args.output.mkdir(parents=True)
    archive_path = args.output / 'aggregate82-bootstrap-compatible-evidence.tar.gz'
    entries = {}
    def include(path, relative):
        need(path.is_file() and not path.is_symlink(), 'EVIDENCE_NOT_REGULAR:' + relative)
        need(relative not in entries, 'DUPLICATE_EVIDENCE_PATH:' + relative)
        entries[relative] = path
    for path in sorted(root.rglob('*')):
        if path.is_file():
            include(path, 'aggregate/' + path.relative_to(root).as_posix())
    for path in sorted(args.base_root.rglob('*')):
        if path.is_file() and path.suffix != '.deb':
            include(path, 'retained-base-evidence/' + path.relative_to(args.base_root).as_posix())
    for label, directory in (('a', args.repro_a), ('b', args.repro_b)):
        for path in sorted(directory.rglob('*')):
            if path.is_file() and path.suffix != '.deb':
                include(path, 'source-build-' + label + '/' + path.relative_to(directory).as_posix())
    include(args.lock, 'producer/bootstrap-compatible-candidate-inputs.json')
    repo = Path(__file__).resolve().parent.parent
    for directory in ('scripts', 'termux-private-package-kit/bootstrap-compat', '.github/workflows'):
        for path in sorted((repo / directory).rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts and path.suffix in ('.py', '.sh', '.yml'):
                include(path, 'producer/' + path.relative_to(repo).as_posix())
    inventory = {}
    with tarfile.open(archive_path, 'w:gz', compresslevel=6) as archive:
        for relative, path in sorted(entries.items()):
            info = tarfile.TarInfo(relative)
            info.size = path.stat().st_size
            info.mode = 0o644
            info.mtime = 0
            with path.open('rb') as data:
                archive.addfile(info, data)
            inventory[relative] = {'sha256': sha(path), 'size': info.size}
    receipt = {'archiveFile': archive_path.name, 'archiveSha256': sha(archive_path), 'regularFileCount': len(inventory), 'files': inventory, 'qualified': False, 'productionAllowed': False, 'android': 'NOT_RUN', 'aggregateRunId': os.environ.get('GITHUB_RUN_ID')}
    (args.output / 'aggregate-archive-inventory.json').write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n')
    print('BOOTSTRAP_COMPAT_EVIDENCE_READY packages=82 roots=13 production=false android=NOT_RUN archiveSha256=' + receipt['archiveSha256'], flush=True)

if __name__ == '__main__':
    main()
