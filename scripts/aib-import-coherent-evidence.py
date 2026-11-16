#!/usr/bin/env python3
"""Import the immutable successful CI candidate; never sign, publish, or install packages."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_SHA256 = '24248695b2af16f876935c7f3b152dc4a34849ebacb4dde9ab0507281df8e8e7'
INVENTORY_SHA256 = '77fb565ce17fd99aa3f1e350c5affe4e09c40adc5be6771a808d2e9ecee2554c'
SUMMARY_SHA256 = '134b459f80a77006a9fc1e501aa90f63b64579c2864735ffd62c5f963dcc6a72'
CI_RUN_ID = '39299572605'
ASSET_FILES = {'dists/stable/Release', 'dists/stable/Release.gpg', 'dists/stable/InRelease', 'dists/stable/main/binary-aarch64/Packages', 'dists/stable/main/binary-aarch64/Packages.gz', 'keys/aibuilder-termux-feed-keyring.gpg'}

def need(condition, message):
    if not condition:
        raise ValueError(message)

def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('archive', 'inventory', 'summary'):
        p.add_argument('--' + name, required=True, type=Path)
    args = p.parse_args()
    for path, expected in ((args.archive, ARCHIVE_SHA256), (args.inventory, INVENTORY_SHA256), (args.summary, SUMMARY_SHA256)):
        need(path.is_file() and not path.is_symlink() and sha(path) == expected, 'PINNED_CI_INPUT_MISMATCH:' + path.name)
    inventory = json.loads(args.inventory.read_text())
    summary = json.loads(args.summary.read_text())
    need(inventory['archiveSha256'] == ARCHIVE_SHA256 and summary['valid'] is True, 'CI_REPLAY_NOT_VALID')
    need(str(summary['aggregateRunId']) == CI_RUN_ID and summary['packageCount'] == 82 and summary['requestedRootCount'] == 13, 'CI_REPLAY_SCOPE_MISMATCH')
    need(summary['qualified'] is False and summary['productionAllowed'] is False and summary['android'] == 'NOT_RUN' and summary['bootstrapChanged'] is False, 'CI_REPLAY_QUALIFICATION_MISREPRESENTED')
    need(summary['signedAptRootPlan'] == 'PASS' and summary['signedAptFullReinstallPlan'] == 'PASS' and summary['authenticatedArchiveCopies'] == 82 and summary['compressionBaselineAbi'] == 'PASS' and summary['pinnedSourceHostBehavior'] == 'PASS', 'REQUIRED_CI_GATE_NOT_PASSED')
    doc = ROOT / 'docs/coherent-candidate'
    assets = ROOT / 'assets/termux-candidate-full'
    doc.mkdir(parents=True, exist_ok=True)
    expected = inventory['files']
    need(len(expected) == inventory['regularFileCount'], 'INVENTORY_COUNT_MISMATCH')
    found = set()
    imported_packages = 0
    reused_packages = 0
    with tempfile.TemporaryDirectory(prefix='verified-coherent-docs-') as temporary:
        stage = Path(temporary)
        with tarfile.open(args.archive, 'r:gz') as archive:
            for member in archive:
                rel = PurePosixPath(member.name)
                need(not rel.is_absolute() and '..' not in rel.parts and member.isfile() and member.name in expected and member.name not in found, 'UNSAFE_OR_UNEXPECTED_ARCHIVE_MEMBER')
                pin = expected[member.name]
                need(member.size == pin['size'] and member.size <= 512 * 1024 * 1024, 'MEMBER_SIZE_MISMATCH')
                target = None
                is_package = False
                prefix = 'aggregate/candidate-feed/'
                if member.name.startswith(prefix):
                    asset_rel = member.name[len(prefix):]
                    if asset_rel.startswith('pool/') and asset_rel.endswith('.deb'):
                        target = assets / asset_rel
                        is_package = True
                    elif asset_rel in ASSET_FILES:
                        target = assets / asset_rel
                if target is None and member.name.startswith('aggregate/'):
                    target = stage / member.name[len('aggregate/'):]
                elif target is None and member.name.startswith(('source-build-a/', 'source-build-b/', 'producer/')):
                    target = stage / member.name
                unchanged = is_package and target.is_file() and not target.is_symlink() and sha(target) == pin['sha256']
                if target is not None and not unchanged:
                    need(not target.is_symlink(), 'SYMLINK_OUTPUT_REJECTED')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    for parent in target.parents:
                        need(not parent.is_symlink(), 'SYMLINK_OUTPUT_PARENT_REJECTED')
                    output = target.open('wb')
                else:
                    output = None
                digest = hashlib.sha256()
                try:
                    with archive.extractfile(member) as source:
                        for chunk in iter(lambda: source.read(1024 * 1024), b''):
                            digest.update(chunk)
                            if output is not None:
                                output.write(chunk)
                finally:
                    if output is not None:
                        output.close()
                need(digest.hexdigest() == pin['sha256'], 'ARCHIVE_MEMBER_DIGEST_MISMATCH:' + member.name)
                if member.name.startswith(prefix) and member.name[len(prefix):] in ASSET_FILES:
                    alias = stage / 'candidate-feed' / member.name[len(prefix):]
                    alias.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(target, alias)
                if is_package:
                    imported_packages += 1
                    reused_packages += bool(unchanged)
                found.add(member.name)
        need(found == set(expected) and imported_packages == 82, 'INCOMPLETE_CANDIDATE_ARCHIVE')
        manifest = json.loads((stage / 'aggregate-manifest.json').read_text())
        need(sha(stage / 'aggregate-manifest.json') == summary['manifestSha256'], 'CI_MANIFEST_BINDING_MISMATCH')
        key = assets / 'keys/aibuilder-termux-feed-keyring.gpg'
        need(sha(key) == summary['publicKeyringSha256'], 'CI_PUBLIC_KEY_BINDING_MISMATCH')
        verification = subprocess.run(['gpgv', '--status-fd=1', '--keyring', str(key), str(stage / 'aggregate-manifest.json.asc'), str(stage / 'aggregate-manifest.json')], capture_output=True, text=True, check=True)
        need('VALIDSIG ' + summary['fingerprint'] + ' ' in verification.stdout, 'CI_MANIFEST_SIGNATURE_REJECTED')
        need(not any(marker in verification.stdout for marker in ('EXPKEYSIG', 'REVKEYSIG', 'BADSIG', 'ERRSIG', 'KEYEXPIRED')), 'CI_MANIFEST_SIGNER_NO_LONGER_VALID')
        need(len(manifest['packages']) == 82, 'SIGNED_PACKAGE_COUNT_MISMATCH')
        for path in sorted(stage.rglob('*')):
            if path.is_file():
                destination = doc / path.relative_to(stage)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
    shutil.copyfile(args.inventory, doc / 'aggregate-archive-inventory.json')
    shutil.copyfile(args.summary, doc / 'replay-summary.json')
    receipt = {'valid': True, 'ciRunId': CI_RUN_ID, 'archiveSha256': ARCHIVE_SHA256, 'manifestSha256': summary['manifestSha256'], 'archiveInventorySha256': INVENTORY_SHA256, 'summarySha256': SUMMARY_SHA256, 'fingerprint': summary['fingerprint'], 'publicKeyringSha256': summary['publicKeyringSha256'], 'importedPackageCount': imported_packages, 'reusedUnchangedPackages': reused_packages, 'signedManifestVerified': True, 'qualified': False, 'productionAllowed': False, 'android': 'NOT_RUN'}
    (ROOT / 'verification-v493/coherent-import.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2), flush=True)

if __name__ == '__main__':
    main()
