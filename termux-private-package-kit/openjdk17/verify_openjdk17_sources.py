#!/usr/bin/env python3
"""Verify exact upstream recipe inputs and hashed OpenJDK archive, without extraction."""
from __future__ import annotations
import argparse
import hashlib
import json
import pathlib
import subprocess
import tarfile
import urllib.request

PIN = '505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
INPUT_LOCK_SHA = '98c6585c348954f844c4943f08ce1f6fc91afc337f8002bd9401a0c9b3d790c1'
SOURCE_URL = 'https://github.com/openjdk/jdk17u/archive/refs/tags/jdk-17.0.20-ga.tar.gz'
SOURCE_SHA = 'ba3ac4b9d7f2c050f46ddcec39b4258660a3f09836f5a71617fd3f7311d06c0b'
TAG_OBJECT = '54877207ef029d155cb3a6bd02bfe6bace8b6c9c'
SOURCE_COMMIT = '8cbbca61432426a3441aa08838d930ef954ea1ba'
LICENSE_HASHES = {
    'LICENSE': '4b9abebc4338048a7c2dc184e9f800deb349366bdf28eb23c2677a77b4c87726',
    'ADDITIONAL_LICENSE_INFO': 'a69bce275ba7a3570af6579cb0f55682cd75fedfcd49e0e8e9022270c447c916',
    'ASSEMBLY_EXCEPTION': 'a44eb7b5caf5534c6ef536b21edb40b4d6babf91bf97d9d45596868618b2c6fb',
}

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''): h.update(b)
    return h.hexdigest()

def verify_inputs(source: pathlib.Path):
    lock_path = pathlib.Path(__file__).with_name('upstream-recipe-inputs.json')
    if sha(lock_path) != INPUT_LOCK_SHA: raise ValueError('INPUT_LOCK_HASH_MISMATCH')
    lock = json.loads(lock_path.read_text())
    if lock['sourceCommit'] != PIN: raise ValueError('INPUT_LOCK_SOURCE_PIN_MISMATCH')
    actual = {}
    for d in lock['recipeDirectories']:
        base = source / d
        if not base.is_relative_to(source) or not base.is_dir(): raise ValueError('INPUT_DIRECTORY_INVALID')
        for p in sorted(base.rglob('*')):
            if p.is_symlink(): raise ValueError('INPUT_SYMLINK_REJECTED')
            if p.is_file(): actual[p.relative_to(source).as_posix()] = sha(p)
    if actual != lock['files']: raise ValueError('RECIPE_PATCH_INPUT_SET_OR_HASH_MISMATCH')
    return len(actual)

def verify_archive(archive: pathlib.Path):
    if sha(archive) != SOURCE_SHA: raise ValueError('OPENJDK_SOURCE_ARCHIVE_SHA256_MISMATCH')
    notices = {}
    with tarfile.open(archive, 'r:gz') as t:
        for name, expected in LICENSE_HASHES.items():
            member = t.getmember('jdk17u-jdk-17.0.20-ga/' + name)
            if not member.isreg() or not 0 < member.size <= 1024 * 1024:
                raise ValueError('SOURCE_NOTICE_TYPE_OR_SIZE_INVALID:' + name)
            f = t.extractfile(member)
            if f is None: raise ValueError('SOURCE_NOTICE_UNREADABLE:' + name)
            digest = hashlib.sha256(f.read()).hexdigest()
            if digest != expected: raise ValueError('SOURCE_NOTICE_HASH_MISMATCH:' + name)
            notices[name] = digest
    return notices

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-root', required=True, type=pathlib.Path)
    p.add_argument('--output', required=True, type=pathlib.Path)
    a = p.parse_args(); source = a.source_root.resolve()
    count = verify_inputs(source)
    refs = subprocess.run(['git', 'ls-remote', 'https://github.com/openjdk/jdk17u.git',
                           'refs/tags/jdk-17.0.20-ga', 'refs/tags/jdk-17.0.20-ga^{}'],
                          capture_output=True, text=True, check=True, timeout=120).stdout
    actual = {ref: commit for commit, ref in (line.split() for line in refs.splitlines())}
    if actual != {'refs/tags/jdk-17.0.20-ga': TAG_OBJECT, 'refs/tags/jdk-17.0.20-ga^{}': SOURCE_COMMIT}:
        raise ValueError('UPSTREAM_TAG_COMMIT_CHANGED')
    archive = a.output / 'openjdk17-source.tar.gz'
    if archive.exists(): raise ValueError('SOURCE_ARCHIVE_OUTPUT_ALREADY_EXISTS')
    try:
        req = urllib.request.Request(SOURCE_URL, headers={'User-Agent': 'pinned-candidate-source-verifier'})
        with urllib.request.urlopen(req, timeout=180) as response, archive.open('xb') as f:
            total = 0
            while True:
                b = response.read(1024 * 1024)
                if not b: break
                total += len(b)
                if total > 512 * 1024 * 1024: raise ValueError('SOURCE_ARCHIVE_TOO_LARGE')
                f.write(b)
        notices = verify_archive(archive)
        report = {'sourceRepositoryCommit': PIN, 'upstreamSourceCommit': SOURCE_COMMIT,
                  'upstreamTagObject': TAG_OBJECT, 'sourceUrl': SOURCE_URL,
                  'sourceSha256': SOURCE_SHA, 'licenseSourceHashes': notices,
                  'recipeInputCount': count, 'recipeInputLockSha256': INPUT_LOCK_SHA,
                  'verification': 'source-only; no Android runtime evidence'}
        (a.output / 'source-provenance.json').write_text(json.dumps(report, sort_keys=True, indent=2) + '\n')
        print('OPENJDK17_SOURCE_PROVENANCE_OK recipe_inputs={} license_notices=3'.format(count), flush=True)
    finally:
        archive.unlink(missing_ok=True)

if __name__ == '__main__': main()
