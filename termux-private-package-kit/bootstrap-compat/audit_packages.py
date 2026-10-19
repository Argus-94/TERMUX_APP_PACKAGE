#!/usr/bin/env python3
"""Audit source-built split packages without repacking any control or payload."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

root = pathlib.Path(sys.argv[1])
report = pathlib.Path(sys.argv[2])
prefix = pathlib.PurePosixPath('data/user/0/com.karat.aibuilder/files/usr')
expected = {'libbz2': ('1.0.8-8', None), 'bzip2': ('1.0.8-8', 'libbz2'), 'liblzma': ('5.8.4', None), 'xz-utils': ('5.8.4', 'liblzma')}
found = {}
for deb in sorted(root.glob('*.deb')):
    fields = {name: subprocess.check_output(['dpkg-deb', '-f', str(deb), name], text=True).strip() for name in ['Package', 'Version', 'Architecture', 'Depends', 'Essential']}
    name = fields['Package']
    if name not in expected or name in found:
        raise SystemExit('UNEXPECTED_OR_DUPLICATE_PACKAGE:' + name)
    version, parent = expected[name]
    if fields['Version'] != version or fields['Architecture'] != 'aarch64' or fields['Essential'] != 'yes':
        raise SystemExit('METADATA_MISMATCH:' + name)
    if parent and not re.search(r'(^|,\s*)' + re.escape(parent) + r'\s*\(=\s*' + re.escape(version) + r'\)(,|$)', fields['Depends']):
        raise SystemExit('SPLIT_DEPENDENCY_MISMATCH:' + name)
    with tempfile.TemporaryDirectory() as temp:
        subprocess.run(['dpkg-deb', '-x', str(deb), temp], check=True)
        for base, dirs, files in os.walk(temp, followlinks=False):
            for entry in dirs + files:
                path = pathlib.Path(base) / entry
                rel = pathlib.PurePosixPath(path.relative_to(temp).as_posix())
                inside = rel == prefix or prefix in rel.parents
                ancestor = rel in prefix.parents
                if not inside and not (ancestor and path.is_dir() and not path.is_symlink()):
                    raise SystemExit('OUTSIDE_PRIVATE_PREFIX:' + str(rel))
                if path.is_symlink():
                    target = os.readlink(path)
                    resolved = pathlib.PurePosixPath(os.path.normpath(str(rel.parent / target))) if not target.startswith('/') else pathlib.PurePosixPath(target.lstrip('/'))
                    if resolved != prefix and prefix not in resolved.parents:
                        raise SystemExit('UNSAFE_SYMLINK:' + str(rel))
                elif path.is_file() and path.read_bytes()[:4] == b'\x7fELF':
                    header = subprocess.check_output(['readelf', '-h', str(path)], text=True)
                    if 'AArch64' not in header:
                        raise SystemExit('ELF_ARCH:' + str(rel))
                    dynamic = subprocess.run(['readelf', '-d', str(path)], text=True, capture_output=True, check=True).stdout
                    for rpath in re.findall(r'\((?:RPATH|RUNPATH)\).*?\[([^]]+)\]', dynamic):
                        if any(item != '/' + str(prefix) + '/lib' for item in rpath.split(':')):
                            raise SystemExit('ELF_FOREIGN_RPATH:' + str(rel))
                elif not path.is_dir():
                    raise SystemExit('SPECIAL_PAYLOAD_OBJECT:' + str(rel))
    found[name] = {'version': version, 'architecture': fields['Architecture'], 'depends': fields['Depends'], 'essential': fields['Essential'], 'sha256': hashlib.sha256(deb.read_bytes()).hexdigest(), 'file': deb.name}
if set(found) != set(expected):
    raise SystemExit('PACKAGE_SET_MISMATCH:' + str(sorted(found)))
report.write_text(json.dumps({'result': 'PASS', 'packages': found, 'prefix': '/' + str(prefix), 'sourceRepacked': False, 'runtime': 'NOT_RUN'}, indent=2) + '\n')
