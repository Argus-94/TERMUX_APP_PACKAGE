#!/usr/bin/env python3
"""Compare candidate bzip2/xz ELF ABI against the pinned private aarch64 bootstrap."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile

LIBS = ('libbz2.so', 'liblzma.so')
PACKAGES = {'libbz2': ('1.0.8-8', 'aarch64'), 'bzip2': ('1.0.8-8', 'aarch64'),
            'liblzma': ('5.8.4', 'aarch64'), 'xz-utils': ('5.8.4', 'aarch64')}
BOOTSTRAP_SHA256 = '08a447f60c06783f33561583553149cf992ac7d9779071c71b8aaeeb452451b4'
PREFIX = pathlib.PurePosixPath('data/user/0/com.karat.aibuilder/files/usr')


def run(*args):
    p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode:
        raise RuntimeError(f'{args[0]} failed: {p.stderr.strip()}')
    return p.stdout


def safe_name(n):
    p = pathlib.PurePosixPath(n)
    return not p.is_absolute() and '..' not in p.parts


def elf(data):
    return data[:4] == b'\x7fELF'


def _symbols(path):
    rows = []
    text = run('readelf', '--dyn-syms', '--wide', str(path))
    for line in text.splitlines():
        # Num Value Size Type Bind Vis Ndx Name
        m = re.match(r'^\s*\d+:\s+([0-9a-fA-F]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$', line)
        if not m:
            continue
        value, size, typ, bind, visibility, ndx, name = m.groups()
        rows.append({'value': int(value, 16), 'size': int(size), 'type': typ,
                     'bind': bind, 'visibility': visibility, 'ndx': ndx,
                     'name': name})
    return rows


def _normalized_name(name):
    # GNU default-version spelling is also visible to unversioned references.
    if '@@' in name:
        return name.split('@@', 1)[0], name.split('@@', 1)[1], True
    if '@' in name:
        base, version = name.split('@', 1)
        return base, version, False
    return name, None, False


def exported(path):
    out = {}
    for s in _symbols(path):
        if s['ndx'] == 'UND' or s['bind'] not in ('GLOBAL', 'WEAK') or s['visibility'] not in ('DEFAULT', 'PROTECTED'):
            continue
        base, version, is_default = _normalized_name(s['name'])
        if base in ('', '0'):
            continue
        out[(base, version)] = s
        if version is None or is_default:
            out[(base, None)] = s
    return out


def undefined(path):
    rows = [s for s in _symbols(path) if s['ndx'] == 'UND' and s['bind'] == 'GLOBAL']
    # Prefer a strong undefined reference over a weak duplicate.
    return {_normalized_name(s['name'])[:2] for s in rows}


def dyn(path):
    return run('readelf', '-d', str(path))


def needed(path):
    return re.findall(r'\(NEEDED\).*?\[(.*?)\]', dyn(path))


def soname(path):
    m = re.search(r'\(SONAME\).*?\[(.*?)\]', dyn(path))
    return m.group(1) if m else path.name


def walk_elf(root):
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if not (pathlib.Path(base) / d).is_symlink()]
        for f in files:
            p = pathlib.Path(base) / f
            if p.is_symlink():
                continue
            try:
                with p.open('rb') as h:
                    magic = h.read(4)
                if elf(magic):
                    yield p
            except OSError:
                pass


def parse_symlinks(z):
    try:
        raw = z.read('SYMLINKS.txt').decode('utf-8', 'strict')
    except KeyError:
        return []
    rows = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        if '←' in line:
            target, link = line.split('←', 1)
        elif ' -> ' in line:  # Accept old fixture spelling, with conventional link -> target order.
            link, target = line.split(' -> ', 1)
        else:
            raise ValueError('INVALID_SYMLINK_MANIFEST_LINE:' + line)
        rows.append((link.strip(), target.strip()))
    return rows


def _inside_prefix(path):
    return path == PREFIX or PREFIX in path.parents


def _validate_link(link, target):
    lp = pathlib.PurePosixPath(link)
    tp = pathlib.PurePosixPath(target)
    if not safe_name(link) or not link.startswith('./'):
        raise ValueError(f'UNSAFE_BASELINE_SYMLINK:{link}:{target}')
    if tp.is_absolute():
        # Platform links may intentionally resolve outside the private prefix; record, never follow.
        return False
    link_path = pathlib.PurePosixPath(os.path.normpath(str(PREFIX / lp)))
    resolved = tp if tp.is_absolute() else pathlib.PurePosixPath(os.path.normpath(str(link_path.parent / tp)))
    if not _inside_prefix(resolved):
        raise ValueError(f'UNSAFE_BASELINE_SYMLINK:{link}:{target}')
    return True


def extract_bootstrap(zip_path, dest):
    files = []
    with zipfile.ZipFile(zip_path) as z:
        links = parse_symlinks(z)
        for link, target in links:
            _validate_link(link, target)
        for info in z.infolist():
            name = info.filename.rstrip('/')
            if not name or name == 'SYMLINKS.txt':
                continue
            if not safe_name(name):
                raise ValueError('UNSAFE_BOOTSTRAP_PATH:' + name)
            mode = (info.external_attr >> 16) & 0xffff
            if stat.S_ISLNK(mode):
                raise ValueError('ZIP_SYMLINK_PAYLOAD:' + name)
            if info.is_dir():
                continue
            if mode and not stat.S_ISREG(mode):
                raise ValueError('NONREGULAR_ZIP_MEMBER:' + name)
            if not name.startswith(('bin/', 'lib/', 'libexec/')):
                continue
            data = z.read(info)
            if not elf(data):
                continue
            p = dest / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            files.append(p)
    return files, links


def extract_deb_safe(deb, dest):
    proc = subprocess.Popen(['dpkg-deb', '--fsys-tarfile', str(deb)], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=proc.stdout, mode='r|') as tf:
            for member in tf:
                name = member.name[2:] if member.name.startswith('./') else member.name
                if name in ('', '.') and member.isdir():
                    continue
                rel = pathlib.PurePosixPath(name)
                # Archive has the full Android private-prefix path, with directories above it permitted.
                if rel.is_absolute() or '..' in rel.parts:
                    raise ValueError('UNSAFE_CANDIDATE_PATH:' + member.name)
                if not member.isdir() and not (rel == PREFIX or PREFIX in rel.parents):
                    raise ValueError('CANDIDATE_OUTSIDE_PREFIX:' + member.name)
                if member.isdir():
                    # Only prefix ancestors and descendants are permitted.
                    if not (rel == PREFIX or PREFIX in rel.parents or rel in PREFIX.parents):
                        raise ValueError('CANDIDATE_OUTSIDE_PREFIX:' + member.name)
                    (dest / pathlib.Path(*rel.parts)).mkdir(parents=True, exist_ok=True)
                    continue
                if member.issym() or member.islnk():
                    target = pathlib.PurePosixPath(member.linkname)
                    if target.is_absolute():
                        resolved = pathlib.PurePosixPath(os.path.normpath(str(target).lstrip('/')))
                    elif member.islnk():
                        resolved = pathlib.PurePosixPath(os.path.normpath(str(target)))
                    else:
                        resolved = pathlib.PurePosixPath(os.path.normpath(str(rel.parent / target)))
                    if not _inside_prefix(resolved):
                        raise ValueError('UNSAFE_CANDIDATE_LINK:' + member.name)
                    continue
                if not member.isfile():
                    raise ValueError('UNSAFE_CANDIDATE_TYPE:' + member.name)
                src = tf.extractfile(member)
                out = dest / pathlib.Path(*rel.parts)
                out.parent.mkdir(parents=True, exist_ok=True)
                with out.open('wb') as f:
                    shutil.copyfileobj(src, f)
                out.chmod(member.mode & 0o777)
    finally:
        proc.stdout.close()
    if proc.wait():
        raise RuntimeError('dpkg-deb --fsys-tarfile failed')


def _rpath_errors(dynamic_text):
    failures = []
    allowed = {str(PREFIX / 'lib'), '/' + str(PREFIX / 'lib')}
    for rpath in re.findall(r'\((?:RPATH|RUNPATH)\).*?\[(.*?)\]', dynamic_text):
        failures.extend(entry for entry in rpath.split(':') if entry not in allowed)
    return failures


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--bootstrap-zip', required=True)
    ap.add_argument('--packages-dir', required=True)
    ap.add_argument('--report', required=True)
    a = ap.parse_args()
    report = pathlib.Path(a.report)
    errors, proof = [], []
    if hashlib.sha256(pathlib.Path(a.bootstrap_zip).read_bytes()).hexdigest() != BOOTSTRAP_SHA256:
        raise ValueError('BOOTSTRAP_SHA256_MISMATCH')
    with tempfile.TemporaryDirectory(prefix='bootstrap-abi-') as td:
        temp = pathlib.Path(td)
        base, cand = temp / 'base', temp / 'candidate'
        base.mkdir(); cand.mkdir()
        baseline, links = extract_bootstrap(a.bootstrap_zip, base)
        if not baseline:
            errors.append('BOOTSTRAP_ELF_NOT_FOUND')
        debs = list(pathlib.Path(a.packages_dir).glob('*.deb'))
        found = {}
        for deb in debs:
            fields = {k: run('dpkg-deb', '-f', str(deb), k).strip() for k in ('Package', 'Version', 'Architecture')}
            name = fields['Package']
            if name not in PACKAGES or name in found:
                errors.append('UNEXPECTED_OR_DUPLICATE_PACKAGE:' + name)
                continue
            if (fields['Version'], fields['Architecture']) != PACKAGES[name]:
                errors.append('PACKAGE_METADATA:' + name)
            found[name] = deb
            dest = cand / name
            dest.mkdir()
            extract_deb_safe(deb, dest)
        if set(found) != set(PACKAGES):
            errors.append('PACKAGE_SET:' + ','.join(sorted(found)))
        candidate = list(walk_elf(cand))
        for p in candidate:
            rel = p.relative_to(cand)
            hdr, dt = run('readelf', '-h', str(p)), dyn(p)
            if 'AArch64' not in hdr:
                errors.append('CANDIDATE_ARCH:' + str(rel))
            for entry in _rpath_errors(dt):
                errors.append(f'CANDIDATE_RPATH:{rel}:{entry}')
            ph = run('readelf', '-l', str(p))
            for interp in re.findall(r'Requesting program interpreter:\s*([^]]+)', ph):
                if interp != '/system/bin/linker64':
                    errors.append(f'CANDIDATE_INTERPRETER:{rel}:{interp}')
        libs = {}
        for lib in LIBS:
            matching = [p for p in candidate if p.name.startswith(lib)]
            old = [p for p in baseline if p.name.startswith(lib)]
            if not matching:
                errors.append('CANDIDATE_LIBRARY_MISSING:' + lib)
                continue
            if not old:
                errors.append('BASELINE_LIBRARY_MISSING:' + lib)
                continue
            for cp in matching:
                cs, ce = soname(cp), exported(cp)
                old_for = [p for p in old if soname(p) == cs or p.name == cs]
                if not old_for:
                    errors.append('SONAME_NOT_IN_BASELINE:' + cs)
                    continue
                for op in old_for:
                    oe = exported(op)
                    missing = sorted(set(oe) - set(ce))
                    if missing:
                        errors.append(f'MISSING_EXPORTS:{cs}:{op.name}:{";".join(n + ("@" + v if v else "") for n, v in missing)}')
                    for key, old_sym in oe.items():
                        new_sym = ce.get(key)
                        if new_sym and old_sym['type'] in ('OBJECT', 'TLS') and new_sym['size'] < old_sym['size']:
                            errors.append(f'EXPORT_SIZE_SHRUNK:{cs}:{key[0]}')
                libs[cs] = ce
                proof.append({'candidate': str(cp.relative_to(cand)), 'soname': cs, 'candidate_exports': len(ce)})
        base_libs = {soname(p): p for p in baseline if any(p.name.startswith(x) for x in LIBS)}
        consumer_count = 0
        for p in baseline:
            if any(p.name.startswith(x) for x in LIBS):
                continue
            deps = needed(p)
            for so in (x for x in deps if x in base_libs):
                consumer_count += 1
                old = exported(base_libs[so]); new = libs.get(so, {})
                missing = []
                for name, version in undefined(p):
                    if (name, version) in old and (name, version) not in new:
                        missing.append(name + (('@' + version) if version else ''))
                if missing:
                    errors.append(f'CONSUMER_UNRESOLVED:{p.relative_to(base)}:{so}:{";".join(sorted(missing))}')
        result = {'abi_compatible': not errors, 'scope': 'ELF ABI compatibility evidence only; not Android runtime/device qualification',
                  'bootstrap_zip': str(pathlib.Path(a.bootstrap_zip).resolve()), 'bootstrap_sha256': BOOTSTRAP_SHA256,
                  'packages': {k: v.name for k, v in found.items()}, 'baseline_elf_count': len(baseline),
                  'baseline_symlink_manifest_entries': len(links), 'baseline_consumers_using_compression_libraries': consumer_count,
                  'libraries': proof, 'errors': errors}
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(result, indent=2) + '\n')
    return 0 if result['abi_compatible'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        raise SystemExit(2)
