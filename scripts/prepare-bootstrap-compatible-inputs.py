#!/usr/bin/env python3
"""Fetch immutable candidate inputs from this repository only; never install them."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import requests

REPOSITORY = 'Argus-94/TERMUX_APP_PACKAGE'

def need(ok, reason):
    if not ok:
        raise ValueError(reason)

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def fetch(asset, expected, destination):
    token = os.environ.get('GH_TOKEN')
    need(bool(token), 'REPOSITORY_TOKEN_REQUIRED')
    # Requests removes Authorization on a cross-host redirect to an asset CDN.
    url = f'https://api.github.com/repos/{REPOSITORY}/releases/assets/{int(asset)}'
    with requests.get(url, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/octet-stream'}, stream=True, timeout=(30, 120)) as response:
        need(response.status_code == 200, 'ASSET_FETCH_REJECTED:' + str(asset) + ':' + str(response.status_code))
        total = 0
        with destination.open('xb') as out:
            for block in response.iter_content(1024 * 1024):
                total += len(block)
                need(total <= 512 * 1024 * 1024, 'ASSET_TOO_LARGE')
                out.write(block)
    need(digest(destination) == expected, 'ASSET_SHA256_MISMATCH:' + str(asset))
    print(f'INPUT_VERIFIED asset={int(asset)} bytes={total}', flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text())
    need(lock['repository'] == REPOSITORY and lock['qualified'] is False and lock['productionAllowed'] is False, 'INPUT_LOCK_SCOPE_INVALID')
    need(not args.output.exists(), 'OUTPUT_MUST_BE_NEW')
    args.output.mkdir(parents=True, mode=0o700)
    base = lock['baseAggregate']
    fetch(base['assetId'], base['sha256'], args.output / 'base80.tar.gz')
    fetch(base['inventoryAssetId'], base['inventorySha256'], args.output / 'base80-inventory.json')
    bootstrap = lock['bootstrap']
    fetch(bootstrap['assetId'], bootstrap['sha256'], args.output / 'bootstrap.zip')
    fetch(bootstrap['provenanceAssetId'], bootstrap['provenanceSha256'], args.output / 'bootstrap-provenance.json')
    inventory = json.loads((args.output / 'base80-inventory.json').read_text())
    need(inventory['archiveSha256'] == base['sha256'], 'INVENTORY_ARCHIVE_BINDING_MISMATCH')
    expected = inventory['files']
    destination = args.output / 'base80'
    destination.mkdir()
    found = set()
    checksums = None
    with tarfile.open(args.output / 'base80.tar.gz', 'r:gz') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            need(not name.is_absolute() and '..' not in name.parts and member.isfile(), 'ARCHIVE_MEMBER_UNSAFE')
            if member.name == 'SHA256SUMS':
                need(checksums is None and member.size <= 1024 * 1024, 'CHECKSUM_MEMBER_INVALID')
                data = archive.extractfile(member).read()
                checksums = {}
                for line in data.decode('ascii').splitlines():
                    digest_value, relative = line.split('  ', 1)
                    need(relative not in checksums, 'DUPLICATE_CHECKSUM_RECORD')
                    checksums[relative] = digest_value
                (destination / 'SHA256SUMS').write_bytes(data)
                continue
            need(member.name in expected and member.name not in found, 'ARCHIVE_MEMBER_SET_MISMATCH')
            spec = expected[member.name]
            need(member.size == spec['size'] and member.size <= 512 * 1024 * 1024, 'ARCHIVE_MEMBER_SIZE_MISMATCH')
            target = destination.joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            need(source is not None, 'ARCHIVE_MEMBER_UNREADABLE')
            with target.open('xb') as out:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    out.write(block)
            need(digest(target) == spec['sha256'], 'ARCHIVE_MEMBER_SHA256_MISMATCH')
            found.add(member.name)
    need(found == set(expected), 'ARCHIVE_INCOMPLETE')
    need(checksums == {name: spec['sha256'] for name, spec in expected.items()}, 'CHECKSUM_MANIFEST_MISMATCH')
    need(digest(destination / 'aggregate/aggregate-manifest.json') == base['manifestSha256'], 'BASE_MANIFEST_BINDING_MISMATCH')
    (args.output / 'input-fetch-receipt.json').write_text(json.dumps({'valid': True, 'repository': REPOSITORY, 'archiveSha256': base['sha256'], 'bootstrapSha256': bootstrap['sha256'], 'regularFileCount': len(found) + 1, 'inventoryFileCount': len(found), 'qualified': False, 'productionAllowed': False}, indent=2) + '\n')
    print('IMMUTABLE_BOOTSTRAP_COMPAT_INPUTS_READY', flush=True)

if __name__ == '__main__':
    main()
