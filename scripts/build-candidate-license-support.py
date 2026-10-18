#!/usr/bin/env python3
"""Build the supplemental termux-licenses candidate from its locked source recipe."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = ROOT / 'candidate-license-support-lock.json'
PREFIX = 'data/user/0/com.karat.aibuilder/files/usr'
SOURCE_COMMIT = '505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def tree(root):
    result = {}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root).as_posix()
        if path.is_symlink():
            result[rel] = {'type': 'symlink', 'target': os.readlink(path)}
        elif path.is_file():
            result[rel] = {'type': 'file', 'sha256': sha(path)}
        elif path.is_dir():
            result[rel] = {'type': 'directory'}
    return result


def verify(source, lock_path=LOCK):
    lock = json.loads(pathlib.Path(lock_path).read_text())
    source = pathlib.Path(source).resolve()
    if lock.get('sourceCommit') != SOURCE_COMMIT:
        raise ValueError('noncanonical source commit lock')
    if subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() != SOURCE_COMMIT:
        raise ValueError('source revision mismatch')
    if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True).strip():
        raise ValueError('source tree is dirty')
    package = source / 'packages/termux-licenses'
    if tree(package) != lock.get('packageTree'):
        raise ValueError('locked source package tree mismatch')
    if (package / 'build.sh').read_text() != lock.get('recipeText'):
        raise ValueError('recipe differs from locked recipe')
    return lock, package


def make_deb(target, epoch, out):
    """Package the already-validated source recipe; tests pass synthetic fixtures here."""
    with tempfile.TemporaryDirectory(prefix='license-candidate-') as temp:
        work = pathlib.Path(temp)
        control = work / 'control'
        data = work / 'data'
        (control / 'DEBIAN').mkdir(parents=True)
        data.mkdir()
        prefix = data / PREFIX
        prefix.mkdir(parents=True)
        shell = 'set -Eeuo pipefail; source "$1"; TERMUX_PREFIX="$2"; TERMUX_PKG_BUILDER_DIR="$(dirname "$1")"; termux_step_make_install'
        subprocess.run(['bash', '-c', shell, 'builder', str(target / 'build.sh'), str(prefix)], check=True)
        licenses = prefix / 'share/LICENSES'
        files = sorted(licenses.glob('*.txt'))
        if not files or any(not path.is_file() or path.is_symlink() for path in files):
            raise ValueError('missing/invalid installed licenses')
        if sorted(path.name for path in files) != sorted(path.name for path in (target / 'LICENSES').glob('*.txt')):
            raise ValueError('staged license set differs from recipe source')
        doc = prefix / 'share/doc/termux-licenses'
        doc.mkdir(parents=True)
        (doc / 'copyright').write_bytes((target / 'LICENSES/GPL-3.0.txt').read_bytes())
        for path in data.rglob('*'):
            if path.is_symlink():
                raise ValueError('unexpected symlink')
            path.chmod(0o700 if path.is_dir() else 0o644)
            os.utime(path, (epoch, epoch), follow_symlinks=False)

        policy_spec = importlib.util.spec_from_file_location('candidate_packaging_policy', ROOT / 'scripts/candidate-packaging-policy.py')
        policy = importlib.util.module_from_spec(policy_spec)
        policy_spec.loader.exec_module(policy)
        installed = policy.installed_size(prefix)
        control_text = (
            'Package: termux-licenses\nVersion: 2.2\nArchitecture: all\n'
            f'Installed-Size: {installed}\nSection: base\nPriority: important\nEssential: yes\n'
            'Maintainer: @termux\nDescription: Contains LICENSE files for common licenses\n\n'
        )
        control_file = control / 'DEBIAN/control'
        control_file.write_text(control_text)
        control_file.chmod(0o644)
        os.utime(control_file, (epoch, epoch))

        def tar_bytes(source, arcname, entries):
            list_file = work / f'{arcname}.list0'
            list_file.write_bytes(b''.join(os.fsencode(entry) + b'\0' for entry in sorted(entries)))
            tar_file = work / f'{arcname}.tar'
            subprocess.run([
                'tar', '--format=gnu', '--sort=name', f'--mtime=@{epoch}', '--owner=0', '--group=0',
                '--numeric-owner', '--no-recursion', '-C', str(source), '--null', '-T', str(list_file),
                '-cf', str(tar_file),
            ], check=True)
            compressed = pathlib.Path(str(tar_file) + '.gz')
            with open(compressed, 'wb') as stream:
                subprocess.run(['gzip', '-n', '-9', '-c', str(tar_file)], stdout=stream, check=True)
            return compressed

        # Archive the single control file from DEBIAN; never include DEBIAN/control itself.
        ct = tar_bytes(control / 'DEBIAN', 'control', ['control'])
        # Include PREFIX itself and descendants, never any of its Android ancestor directories.
        data_entries = [path.relative_to(data).as_posix() for path in [data / PREFIX, *sorted((data / PREFIX).rglob('*'))]]
        dt = tar_bytes(data, 'data', data_entries)
        deb = pathlib.Path(out)
        deb.parent.mkdir(parents=True, exist_ok=True)
        (work / 'debian-binary').write_text('2.0\n')
        for source, name in ((ct, 'control.tar.gz'), (dt, 'data.tar.gz')):
            (work / name).write_bytes(source.read_bytes())
        subprocess.run(['ar', 'rcD', str(deb), str(work / 'debian-binary'), 'control.tar.gz', 'data.tar.gz'], cwd=work, check=True)
        return deb


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    lock, _ = verify(args.source)
    epoch = int(subprocess.check_output(['git', '-C', args.source, 'show', '-s', '--format=%ct', lock['sourceCommit']], text=True).strip())
    make_deb(pathlib.Path(args.source) / 'packages/termux-licenses', epoch, args.output)
    print(sha(args.output))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'candidate builder: {error}', file=sys.stderr)
        sys.exit(2)
