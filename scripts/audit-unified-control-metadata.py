#!/usr/bin/env python3
"""Non-executing static control audit, separate from aggregate payload/ELF/runtime checks."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import tarfile

MAX_FILE = 512 * 1024 * 1024
MAX_TOTAL = 2 * 1024 * 1024 * 1024
CONTROL_MEMBERS = {'control', 'md5sums', 'conffiles', 'triggers', 'preinst', 'postinst', 'prerm', 'postrm', 'config', 'templates', 'shlibs', 'symbols'}
SCRIPT_MEMBERS = {'preinst', 'postinst', 'prerm', 'postrm', 'config'}
class Reject(ValueError):
    pass

def req(ok, reason):
    if not ok:
        raise Reject(reason)

def env():
    return {**{k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR') if k in os.environ}, 'LC_ALL': 'C'}

def norm(name):
    req(name and not name.startswith('/') and '\\' not in name and '\0' not in name, 'UNSAFE_PATH')
    if name.startswith('./'):
        name = name[2:]
    name = name.rstrip('/')
    req(name == '.' or all(x not in ('', '.', '..') for x in name.split('/')), 'UNSAFE_PATH')
    return name

def confined(path, prefix):
    req(path.startswith('/') and (path == prefix or path.startswith(prefix + '/')), 'OUTSIDE_PREFIX:' + path)
    norm(path[1:])
    return path[1:]

def control_parse(data):
    fields = {}; previous = None
    for line in data.decode('utf8', 'strict').splitlines():
        if not line:
            previous = None
            continue
        if line[:1].isspace():
            req(previous is not None, 'CONTROL_ORPHAN_CONTINUATION')
            fields[previous] += '\n' + line
            continue
        name, sep, value = line.partition(':')
        req(sep and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*', name), 'CONTROL_FIELD_INVALID')
        name = name.lower()
        req(name not in fields, 'CONTROL_DUPLICATE_FIELD')
        fields[name] = value.strip(); previous = name
    for name in ('package', 'version', 'architecture', 'installed-size', 'maintainer', 'description'):
        req(bool(fields.get(name)), 'CONTROL_REQUIRED:' + name)
    req(re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', fields['package']), 'PACKAGE_NAME_INVALID')
    req(re.fullmatch(r'[a-z0-9][a-z0-9-]*', fields['architecture']), 'ARCHITECTURE_INVALID')
    req(re.fullmatch(r'[0-9]+', fields['installed-size']), 'INSTALLED_SIZE_INVALID')
    p = subprocess.run(['dpkg', '--validate-version', fields['version']], capture_output=True, env=env(), timeout=30)
    req(p.returncode == 0, 'VERSION_INVALID')
    return fields

def archive(path, flag, consume):
    p = subprocess.Popen(['dpkg-deb', flag, str(path)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env())
    try:
        with tarfile.open(fileobj=p.stdout, mode='r|') as tf:
            answer = consume(tf)
        p.stdout.close()
        req(p.wait(timeout=30) == 0, 'DPKG_ARCHIVE_REJECTED')
        return answer
    except BaseException:
        p.kill(); p.wait()
        raise

def read_control(tf):
    result = {}; seen = set(); total = 0
    for i, member in enumerate(tf):
        req(i < 1000, 'CONTROL_MEMBER_LIMIT')
        name = norm(member.name)
        req(name not in seen, 'CONTROL_DUPLICATE_MEMBER'); seen.add(name)
        req(member.uid == member.gid == 0 and not member.mode & 0o6002, 'CONTROL_OWNER_OR_MODE')
        if name == '.':
            req(member.isdir(), 'CONTROL_ROOT_NOT_DIRECTORY')
            continue
        req(name in CONTROL_MEMBERS and member.isfile(), 'CONTROL_MEMBER_NOT_REGULAR_OR_ALLOWED:' + name)
        total += member.size
        req(member.size <= 8 * 1024 * 1024 and total <= 32 * 1024 * 1024, 'CONTROL_SIZE_LIMIT')
        body = tf.extractfile(member).read(8 * 1024 * 1024 + 1)
        req(len(body) == member.size, 'CONTROL_SIZE_MISMATCH')
        result[name] = (body, member.mode)
    req('control' in result, 'CONTROL_MEMBER_MISSING')
    return result

def read_payload(tf, prefix):
    result = {}; total = 0
    for i, member in enumerate(tf):
        req(i < 100000, 'PAYLOAD_MEMBER_LIMIT')
        name = norm(member.name)
        req(name not in result, 'PAYLOAD_DUPLICATE_MEMBER')
        req(member.uid == member.gid == 0 and not member.mode & 0o6000, 'PAYLOAD_OWNER_OR_SETID')
        req(member.isfile() or member.isdir() or member.issym() or member.islnk(), 'PAYLOAD_SPECIAL_MEMBER')
        req(member.issym() or not member.mode & 0o002, 'WORLD_WRITABLE:' + name)
        if name == '.':
            req(member.isdir(), 'PAYLOAD_ROOT_NOT_DIRECTORY')
        else:
            confined('/' + name, prefix)
        total += member.size
        req(member.size <= MAX_FILE and total <= MAX_TOTAL, 'PAYLOAD_SIZE_LIMIT')
        kind = 'file' if member.isfile() else 'dir' if member.isdir() else 'symlink' if member.issym() else 'hardlink'
        item = {'kind': kind, 'mode': member.mode, 'link': member.linkname}
        if member.isfile():
            sha = hashlib.sha256(); md5 = hashlib.md5(); size = 0; stream = tf.extractfile(member)
            while chunk := stream.read(1024 * 1024):
                size += len(chunk); sha.update(chunk); md5.update(chunk)
            req(size == member.size, 'PAYLOAD_SIZE_MISMATCH')
            item.update(sha256=sha.hexdigest(), md5=md5.hexdigest())
        result[name] = item
    return result

def file_entry(entries, name, seen=()):
    req(name not in seen and name in entries, 'MISSING_OR_CYCLIC_PAYLOAD_FILE:' + name)
    item = entries[name]
    if item['kind'] == 'hardlink':
        return file_entry(entries, norm(item['link']), seen + (name,))
    req(item['kind'] == 'file', 'NOT_REGULAR_PAYLOAD_FILE:' + name)
    return item

def check_aux(controls, entries, prefix):
    inventory = {'conffiles': [], 'triggers': [], 'md5sums': 'ABSENT_OPTIONAL'}
    seen = set()
    for line in controls.get('conffiles', (b'', 0))[0].decode('utf8', 'strict').splitlines():
        req(bool(line.strip()), 'CONFFILE_EMPTY_LINE')
        obsolete = line.startswith('remove-on-upgrade ')
        path = line[len('remove-on-upgrade '):].strip() if obsolete else line.strip()
        name = confined(path, prefix)
        req(name not in seen, 'CONFFILE_DUPLICATE'); seen.add(name)
        if obsolete:
            req(name not in entries, 'OBSOLETE_CONFFILE_IN_PAYLOAD')
        else:
            file_entry(entries, name)
        inventory['conffiles'].append({'path': path, 'removeOnUpgrade': obsolete})
    for line in controls.get('triggers', (b'', 0))[0].decode('utf8', 'strict').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        bits = line.split()
        req(len(bits) == 2 and bits[0] in {'interest', 'interest-await', 'interest-noawait', 'activate', 'activate-await', 'activate-noawait'}, 'TRIGGER_GRAMMAR')
        if bits[1].startswith('/'):
            confined(bits[1], prefix)
        else:
            req(re.fullmatch(r'[A-Za-z0-9+_.:/-]+', bits[1]) and '..' not in bits[1].split('/'), 'TRIGGER_NAME_INVALID')
        inventory['triggers'].append({'kind': bits[0], 'name': bits[1]})
    if 'md5sums' in controls:
        seen = set()
        for line in controls['md5sums'][0].decode('utf8', 'strict').splitlines():
            match = re.fullmatch(r'([0-9a-fA-F]{32})  (.+)', line)
            req(match is not None, 'MD5SUMS_GRAMMAR')
            name = norm(match[2]); req(name not in seen, 'MD5SUMS_DUPLICATE'); seen.add(name)
            req(file_entry(entries, name)['md5'] == match[1].lower(), 'MD5SUMS_MISMATCH')
        inventory['md5sums'] = 'PASS_PRESENT_ENTRIES_ONLY'
    return inventory

def check_scripts(controls):
    result = []
    for name in sorted(SCRIPT_MEMBERS & controls.keys()):
        body, mode = controls[name]
        # dpkg script.c: maintscript_exec calls setexecute(), chmod(0755) if needed.
        # Record this installer requirement; actual APK behavior remains NOT_RUN.
        text = body.decode('utf8', 'strict')
        req('\0' not in text, 'MAINTSCRIPT_NUL')
        fallback = not text.startswith('#!')
        req(not re.search(r'/data/(?:data|user/0)/com\.termux(?:/|\b)', text), 'FOREIGN_STOCK_TERMUX_PATH')
        interpreter = ['sh'] if fallback else shlex.split(text.splitlines()[0][2:])
        req(bool(interpreter), 'MAINTSCRIPT_SHEBANG_MISSING')
        program = PurePosixPath(interpreter[0]).name
        if program == 'env':
            args = interpreter[1:]
            if args[:1] == ['-S']:
                args = args[1:]
            program = args[0] if args else ''
        syntax = 'NOT_CHECKED_NON_SHELL'
        if program in ('sh', 'bash'):
            command = ['bash', '--noprofile', '--norc', '-n']
            p = subprocess.run(command, input=body, capture_output=True, env=env(), timeout=15)
            req(p.returncode == 0, 'MAINTSCRIPT_SHELL_SYNTAX')
            syntax = 'PASS_BASH_PARSE_ONLY'
        result.append({'member': name, 'archivedMode': oct(mode), 'requiresDpkgSetexecute': mode & 0o555 != 0o555, 'sha256': hashlib.sha256(body).hexdigest(), 'shebang': None if fallback else text.splitlines()[0], 'requiresExecvpShellFallback': fallback, 'syntax': syntax, 'androidInterpreterAndEffects': 'NOT_RUN'})
    return result

def audit(manifest, prefix, paths):
    req(prefix.startswith('/') and prefix != '/' and not prefix.endswith('/'), 'PREFIX_INVALID')
    norm(prefix[1:]); specs = {}; results = []; found = set()
    for row in json.loads(manifest.read_text())['packages']:
        identity = tuple(row[x] for x in ('name', 'version', 'architecture'))
        req(identity not in specs, 'MANIFEST_DUPLICATE_IDENTITY')
        digest = row.get('sha256', '')
        req(isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest), 'MANIFEST_SHA256_REQUIRED')
        specs[identity] = digest
    req(bool(specs), 'MANIFEST_EMPTY')
    for path in paths:
        req(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_FILE, 'DEB_INPUT_INVALID')
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        controls = archive(path, '--ctrl-tarfile', read_control)
        fields = control_parse(controls['control'][0]); identity = tuple(fields[x] for x in ('package', 'version', 'architecture'))
        req(identity in specs and digest == specs[identity], 'MANIFEST_IDENTITY_OR_SHA256_MISMATCH')
        req(identity not in found, 'DUPLICATE_PACKAGE_IDENTITY'); found.add(identity)
        dpkg_fields = subprocess.run(['dpkg-deb', '-f', str(path)], capture_output=True, check=True, env=env(), timeout=30).stdout
        req(control_parse(dpkg_fields) == fields, 'CONTROL_DPKG_F_MISMATCH')
        entries = archive(path, '--fsys-tarfile', lambda tf: read_payload(tf, prefix))
        auxiliary = check_aux(controls, entries, prefix)
        results.append({'identity': list(identity), 'sha256': digest, 'controlFields': sorted(fields), 'controlMemberHashes': {k: hashlib.sha256(v[0]).hexdigest() for k, v in controls.items()}, 'maintainerScripts': check_scripts(controls), **auxiliary})
    req(found == set(specs), 'PACKAGE_SET_INCOMPLETE')
    return {'result': 'PASS_STATIC_CONTROL_METADATA_ONLY', 'qualified': False, 'productionAllowed': False, 'actualAndroidMaintainerEffects': 'NOT_RUN', 'payloadLinkClosure': 'SEPARATE_AGGREGATE_AUDIT_REQUIRED', 'packageCount': len(results), 'packages': results}

def main():
    p = argparse.ArgumentParser(); p.add_argument('--package-set', type=Path, required=True); p.add_argument('--prefix', required=True); p.add_argument('--report', type=Path, required=True); p.add_argument('debs', type=Path, nargs='+'); args = p.parse_args()
    try:
        report = audit(args.package_set, args.prefix, args.debs); code = 0
    except (Reject, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, tarfile.TarError) as error:
        report = {'result': 'REJECTED', 'reason': str(error), 'qualified': False, 'productionAllowed': False, 'actualAndroidMaintainerEffects': 'NOT_RUN'}; code = 2
    args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'packages'})); return code
if __name__ == '__main__':
    sys.exit(main())
