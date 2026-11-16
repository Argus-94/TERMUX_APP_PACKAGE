#!/usr/bin/env python3
"""Read-only static audit of the public AIB Termux package index and .deb payloads.

This never installs a package, writes to GitHub, or modifies the repository. It
fetches public artifacts into temporary files, validates archive metadata and
payload paths, inspects ELF metadata and dependency candidates, and emits JSON
under /tmp. Android installation/runtime behavior is outside this audit.
"""
import hashlib, io, json, os, posixpath, re, struct, subprocess, tarfile, tempfile, urllib.request, zipfile

BASE = 'https://raw.githubusercontent.com/Argus-94/TERMUX_APP_PACKAGE/main/apt/termux-main/'
INDEX_URL = BASE + 'dists/stable/main/binary-aarch64/Packages'
BOOTSTRAP = '/workspace/AIBuilder-Expo-v479/assets/termux-bootstrap/termux-bootstrap-aarch64.zip'
PREFIX = 'data/data/com.karat.aibuilder/files/usr'
ANCESTORS = {'data','data/data','data/data/com.karat.aibuilder','data/data/com.karat.aibuilder/files'}
FOREIGN = re.compile(rb'/data/(?:data|user/0)/([^/\x00\s]+)')
SYSTEM_LIBS = {'libc.so','libm.so','libdl.so','liblog.so','libandroid.so','libandroid_runtime.so','libjnigraphics.so','libmediandk.so','libEGL.so','libGLESv1_CM.so','libGLESv2.so','libOpenSLES.so','libvulkan.so','libcamera2ndk.so','libaaudio.so','libnativewindow.so','libsync.so','libui.so','libutils.so','libbinder_ndk.so','libcutils.so','libbase.so','libandroid.so','libz.so'}


def control_fields(text):
    out = {}; current = None
    for line in text.splitlines():
        if line.startswith((' ', '\t')) and current:
            out[current] += '\n' + line[1:]
        elif ': ' in line:
            current, value = line.split(': ', 1); out[current] = value
    return out


def split_top(text, delimiter=','):
    result = []; start = 0; depth = 0
    for i, ch in enumerate(text):
        if ch == '(': depth += 1
        elif ch == ')': depth = max(0, depth - 1)
        elif ch == delimiter and depth == 0:
            result.append(text[start:i].strip()); start = i + 1
    if text[start:].strip(): result.append(text[start:].strip())
    return result


def relation_item(text):
    text = text.strip().split('[', 1)[0].strip()
    text = text.split('<', 1)[0].strip()
    m = re.match(r'^([a-z0-9][a-z0-9+.-]*)(?::[a-zA-Z0-9-]+)?\s*(?:\((<<|<=|=|>=|>>)\s*([^()]+)\))?', text)
    if not m: return None
    return m.group(1), m.group(2), m.group(3).strip() if m.group(3) else None


def version_ok(candidate, op, required):
    if not op: return True
    return subprocess.run(['dpkg', '--compare-versions', candidate, op, required]).returncode == 0


def parse_relations(value):
    groups = []
    if not value: return groups
    for group in split_top(value):
        items = []
        for item in split_top(group, '|'):
            parsed = relation_item(item)
            if parsed: items.append(parsed)
        groups.append(items)
    return groups


def elf_info(data):
    if len(data) < 64 or data[:4] != b'\x7fELF': return None
    if data[4] != 2 or data[5] != 1: return {'error': 'not-elf64-little-endian'}
    try:
        hdr = struct.unpack_from('<HHIQQQIHHHHHH', data, 16)
        machine = hdr[1]; phoff = hdr[4]; phentsize = hdr[8]; phnum = hdr[9]
        ph = []
        for i in range(phnum):
            off = phoff + i * phentsize
            if off + 56 > len(data): return {'error': 'truncated-program-header'}
            row = struct.unpack_from('<IIQQQQQQ', data, off)
            ph.append({'type': row[0], 'offset': row[2], 'vaddr': row[3], 'filesz': row[5]})
        interp = None; dynamic = None; loads = [p for p in ph if p['type'] == 1]
        for p in ph:
            if p['type'] == 3: interp = data[p['offset']:p['offset'] + p['filesz']].split(b'\0', 1)[0].decode('utf8', 'replace')
            elif p['type'] == 2: dynamic = p
        result = {'machine': machine, 'interpreter': interp, 'needed': [], 'rpath': [], 'runpath': []}
        if dynamic:
            dyn = []
            for off in range(dynamic['offset'], min(dynamic['offset'] + dynamic['filesz'], len(data)), 16):
                if off + 16 > len(data): break
                tag, val = struct.unpack_from('<qQ', data, off); dyn.append((tag, val))
                if tag == 0: break
            strtab_addr = next((v for t, v in dyn if t == 5), None)
            strsz = next((v for t, v in dyn if t == 10), None)
            strtab_off = None
            if strtab_addr is not None:
                for p in loads:
                    if p['vaddr'] <= strtab_addr < p['vaddr'] + p['filesz']:
                        strtab_off = p['offset'] + (strtab_addr - p['vaddr']); break
            def getstr(ix):
                if strtab_off is None or ix < 0 or (strsz is not None and ix >= strsz): return ''
                start = strtab_off + ix; end = data.find(b'\0', start, min(len(data), strtab_off + (strsz or len(data))))
                return data[start:end if end >= 0 else len(data)].decode('utf8', 'replace')
            for tag, val in dyn:
                if tag == 1: result['needed'].append(getstr(val))
                elif tag == 15: result['rpath'].append(getstr(val))
                elif tag == 29: result['runpath'].append(getstr(val))
        return result
    except Exception as exc:
        return {'error': 'elf-parse-' + type(exc).__name__ + ':' + str(exc)[:80]}


def foreign_refs(data):
    return [(m.group(1).decode('ascii', 'replace'), m.start()) for m in FOREIGN.finditer(data) if m.group(1) != b'com.karat.aibuilder']


def parse_base():
    packages = {}; file_names = set()
    with zipfile.ZipFile(BOOTSTRAP) as z:
        status_name = next((n for n in z.namelist() if n.endswith('/var/lib/dpkg/status') or n == 'var/lib/dpkg/status'), None)
        if status_name:
            text = z.read(status_name).decode('utf8', 'replace')
            for block in re.split(r'\n\s*\n', text):
                f = control_fields(block)
                if f.get('Package') and f.get('Status', '').endswith('installed'): packages[f['Package']] = f.get('Version', '')
        for n in z.namelist():
            name = n.rsplit('/', 1)[-1]
            if name: file_names.add(name)
        symlink_manifest = next((n for n in z.namelist() if n.endswith('/SYMLINKS.txt') or n == 'SYMLINKS.txt'), None)
        if symlink_manifest:
            for line in z.read(symlink_manifest).decode('utf8', 'replace').splitlines():
                if '←' in line:
                    target, link = line.split('←', 1)
                    for candidate in (target.strip(), link.strip()):
                        if candidate: file_names.add(candidate.rsplit('/', 1)[-1])
    return packages, file_names


with urllib.request.urlopen(INDEX_URL, timeout=30) as response: index = response.read().decode('utf8')
records = []
for block in re.split(r'\n\s*\n', index):
    f = control_fields(block)
    if f.get('Package'): records.append(f)
base_packages, base_files = parse_base()
per_package = []; all_file_names = set(base_files); elfs = []

for i, idx in enumerate(records, 1):
    pkg = idx['Package']; reasons = []; warnings = []; elfrecs = []; payload_names = []; total = 0
    name = idx.get('Filename', '')
    if not name.startswith('pool/main/'): reasons.append('bad-filename-path')
    fd, path = tempfile.mkstemp(suffix='.deb'); os.close(fd)
    try:
        h = hashlib.sha256(); size = 0
        req = urllib.request.Request(BASE + name, headers={'User-Agent': 'AIBuilder-static-feed-audit'})
        with urllib.request.urlopen(req, timeout=45) as r, open(path, 'wb') as out:
            while True:
                chunk = r.read(1024 * 1024)
                if not chunk: break
                h.update(chunk); size += len(chunk); out.write(chunk)
        total = size
        if size != int(idx.get('Size', '-1')) or h.hexdigest() != idx.get('SHA256', ''): reasons.append('index-size-or-sha256-mismatch')
        control = subprocess.run(['dpkg-deb', '-f', path], capture_output=True, text=True, check=True).stdout
        ctl = control_fields(control)
        for field in ('Package', 'Version', 'Architecture'):
            if ctl.get(field) != idx.get(field): reasons.append('control-' + field.lower() + '-mismatch')
        if ctl.get('Architecture') != 'aarch64': reasons.append('control-architecture-not-aarch64')
        proc = subprocess.Popen(['dpkg-deb', '--fsys-tarfile', path], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with tarfile.open(fileobj=proc.stdout, mode='r|') as tf:
            for member in tf:
                rel = member.name
                while rel.startswith('./'): rel = rel[2:]
                rel = rel.rstrip('/')
                if not rel or rel == '.': continue
                if rel not in ANCESTORS and not (rel == PREFIX or rel.startswith(PREFIX + '/')): reasons.append('payload-outside-builder-prefix:' + rel)
                if member.issym():
                    all_file_names.add(rel.rsplit('/', 1)[-1]); target = member.linkname
                    resolved = posixpath.normpath(target if target.startswith('/') else posixpath.join(posixpath.dirname('/' + rel), target))
                    if not (resolved == '/' + PREFIX or resolved.startswith('/' + PREFIX + '/')): reasons.append('symlink-escapes-prefix:' + rel + '->' + target)
                elif member.islnk():
                    all_file_names.add(rel.rsplit('/', 1)[-1]); target = member.linkname.lstrip('./')
                    if not (target == PREFIX or target.startswith(PREFIX + '/')): reasons.append('hardlink-escapes-prefix:' + rel + '->' + member.linkname)
                if member.isfile():
                    payload_names.append(rel.rsplit('/', 1)[-1]); all_file_names.add(rel.rsplit('/', 1)[-1])
                    stream = tf.extractfile(member)
                    if not stream: continue
                    first = stream.read(64)
                    if first.startswith(b'\x7fELF'):
                        data = first + stream.read(); info = elf_info(data)
                        if not info: reasons.append('elf-parse-failed:' + rel)
                        elif info.get('error'): reasons.append('elf-unconfirmed:' + rel + ':' + info['error'])
                        else:
                            if info.get('machine') != 183: reasons.append('elf-machine-not-aarch64:' + rel + ':' + str(info.get('machine')))
                            if info.get('interpreter') not in (None, '/system/bin/linker64', '/system/bin/linker'): reasons.append('elf-interpreter-unconfirmed:' + rel + ':' + str(info.get('interpreter')))
                            for rpath in info.get('rpath', []) + info.get('runpath', []):
                                for entry in rpath.split(':'):
                                    expanded = entry.replace('$ORIGIN', posixpath.dirname('/' + rel)).replace('${ORIGIN}', posixpath.dirname('/' + rel))
                                    if '$' in expanded: reasons.append('elf-rpath-token-unconfirmed:' + rel + ':' + entry)
                                    elif expanded.startswith('/') and not (posixpath.normpath(expanded) == '/' + PREFIX or posixpath.normpath(expanded).startswith('/' + PREFIX + '/')): reasons.append('elf-rpath-outside-prefix:' + rel + ':' + entry)
                                    elif not expanded.startswith('/'): reasons.append('elf-rpath-relative-unconfirmed:' + rel + ':' + entry)
                            refs = foreign_refs(data)
                            if refs: reasons.append('foreign-namespace-string-in-elf:' + rel + ':' + ','.join(x[0] for x in refs[:3]))
                            row = {'package': pkg, 'path': rel, 'needed': info.get('needed', []), 'rpath': info.get('rpath', []), 'runpath': info.get('runpath', [])}
                            elfrecs.append(row); elfs.append(row)
                    else:
                        tail = first[-160:]; refs = []
                        while True:
                            chunk = stream.read(1024 * 1024)
                            if not chunk: break
                            for app, offset in foreign_refs(tail + chunk): refs.append(app)
                            tail = (tail + chunk)[-160:]
                        is_doc = '/share/doc/' in '/' + rel or (rel.lower().endswith('.pod') and '/pod/' in '/' + rel)
                        is_header = '/include/' in '/' + rel
                        if refs:
                            if is_doc: warnings.append('foreign-doc-example:' + rel)
                            elif is_header: warnings.append('foreign-development-header-default:' + rel)
                            elif first.startswith(b'#!') and (member.mode & 0o111): warnings.append('foreign-path-in-executable-script-needs-comment-review:' + rel)
                            else: reasons.append('foreign-namespace-string-in-runtime-file:' + rel)
                        if first.startswith(b'#!'):
                            shebang = first.splitlines()[0][2:].decode('utf8', 'replace').strip().split()
                            if shebang and shebang[0].startswith('/') and not (shebang[0].startswith('/system/bin/') or shebang[0].startswith('/' + PREFIX + '/')): reasons.append('shebang-outside-runtime:' + rel + ':' + shebang[0])
        stderr = proc.stderr.read() if proc.stderr else b''; rc = proc.wait()
        if rc: reasons.append('payload-archive-read-failed:' + stderr.decode('utf8', 'replace')[:120])
        ctrl = subprocess.run(['dpkg-deb', '--ctrl-tarfile', path], capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(ctrl), mode='r:*') as ctf:
            for member in ctf:
                base_name = member.name.lstrip('./')
                if base_name in {'preinst', 'postinst', 'prerm', 'postrm', 'config'} and member.isfile():
                    data = ctf.extractfile(member).read()
                    if foreign_refs(data): reasons.append('foreign-namespace-in-maintainer-script:' + base_name)
        fields = ctl
        for key in ('Depends', 'Pre-Depends'):
            for group in parse_relations(fields.get(key, '')):
                if not group: reasons.append('dependency-syntax-unparsed:' + key)
        row = {'package': pkg, 'version': ctl.get('Version', ''), 'size': size, 'sha256_ok': size == int(idx.get('Size', '-1')) and h.hexdigest() == idx.get('SHA256', ''), 'architecture': ctl.get('Architecture', ''), 'depends': fields.get('Depends', ''), 'pre_depends': fields.get('Pre-Depends', ''), 'provides': fields.get('Provides', ''), 'reasons': reasons, 'warnings': warnings, 'payload_files': len(payload_names), 'elf_count': len(elfrecs), 'elf_records': elfrecs}
        per_package.append(row)
    except Exception as exc:
        per_package.append({'package': pkg, 'version': idx.get('Version', ''), 'size': total, 'sha256_ok': False, 'architecture': idx.get('Architecture', ''), 'reasons': ['audit-exception:' + type(exc).__name__ + ':' + str(exc)[:120]], 'warnings': [], 'payload_files': 0, 'elf_count': 0, 'elf_records': []})
    finally:
        try: os.unlink(path)
        except FileNotFoundError: pass
    if i % 20 == 0 or i == len(records): print(f'archive/ELF pass {i}/{len(records)} {pkg}', flush=True)

versions = {}; providers = {}
for row in per_package:
    if row.get('package') and row.get('version'): versions.setdefault(row['package'], []).append(row['version'])
    for group in parse_relations(row.get('provides', '')):
        for name, op, ver in group: providers.setdefault(name, []).append((row.get('package'), ver))


def relation_satisfied(name, op, required):
    candidates = list(versions.get(name, [])) + ([base_packages[name]] if name in base_packages and base_packages[name] else [])
    for provider, version in providers.get(name, []):
        if version: candidates.append(version)
        elif not op: return True
    for candidate in candidates:
        if candidate and version_ok(candidate, op, required): return True
    return False


for row in per_package:
    for key in ('Pre-Depends', 'Depends'):
        raw = row.get('pre_depends' if key == 'Pre-Depends' else 'depends', '')
        for group in parse_relations(raw):
            if group and not any(relation_satisfied(name, op, ver) for name, op, ver in group):
                row['reasons'].append('unresolved-' + key.lower().replace('-', '_') + ':' + raw[:220])

for row in per_package:
    if row.get('warnings') and row['package'] == 'termux-auth':
        row['reasons'].append('termux-auth-development-header-default-com.termux')
    row['classification'] = 'static-compatible' if not row.get('reasons') else 'unconfirmed'

summary = {'package_count': len(records), 'bytes': sum(r.get('size', 0) for r in per_package), 'static_compatible': [r['package'] for r in per_package if r['classification'] == 'static-compatible'], 'unconfirmed': [{'package': r['package'], 'reasons': r['reasons'], 'warnings': r['warnings']} for r in per_package if r['classification'] != 'static-compatible'], 'elf_count': len(elfs), 'base_package_count': len(base_packages), 'base_file_basename_count': len(base_files), 'note': 'Static audit only; no package installation or Android runtime test.'}
with open('/tmp/aib_termux_feed_audit_results.json', 'w') as f: json.dump({'summary': summary, 'packages': per_package}, f, indent=2)
print('SUMMARY', json.dumps({k: v for k, v in summary.items() if k not in ('static_compatible', 'unconfirmed')}, sort_keys=True), flush=True)
print('STATIC_COMPATIBLE', len(summary['static_compatible']), ','.join(summary['static_compatible']), flush=True)
print('UNCONFIRMED', len(summary['unconfirmed']), flush=True)
for row in summary['unconfirmed']: print('UNCONFIRMED', row['package'], '; '.join(row['reasons'][:5]), 'WARN', ','.join(row['warnings'][:3]), flush=True)
