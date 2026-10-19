#!/usr/bin/env python3
"""Prove a bootstrap candidate using isolated, non-installing host APT operations."""
import argparse
import hashlib
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

BOOTSTRAP_SHA256 = '08a447f60c06783f33561583553149cf992ac7d9779071c71b8aaeeb452451b4'
SOURCE_COMMIT = '505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
ROOTS = ['make=4.4.1-1', 'gh=2.102.0', 'git=2.56.0', 'curl=8.23.0', 'wget=1.25.0-1', 'pkg-config=0.29.2-3', 'python=3.14.6-1', 'nodejs=26.4.0-1', 'npm=11.20.0', 'openjdk-17=17.0.20', 'cmake=4.4.4', 'ninja=1.13.2', 'termux-licenses=2.2']


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def parse_plan(text):
    """Parse apt simulation actions; retain old-version transition metadata."""
    actions = []
    for line in text.splitlines():
        m = re.match(r'^(Inst|Remv|Conf)\s+(\S+)(?:\s+\[([^]]*)\])?(?:\s+\(([^)]*)\))?', line)
        if m:
            actions.append({'action': m.group(1), 'package': m.group(2), 'oldVersion': m.group(3), 'details': m.group(4)})
    return actions


def validate_plan(text, expected, allow_baseline_installed=False, baseline_versions=None):
    actions = parse_plan(text)
    require(not re.search(r'^Remv\s+', text, re.M), 'APT_PLAN_REMOVES_PACKAGE')
    require(not re.search(r'^Downgrade\s*:|will be DOWNGRADED', text, re.M), 'APT_PLAN_DOWNGRADE')
    inst = {}
    for action in actions:
        if action['action'] != 'Inst': continue
        name = action['package']; detail = action['details'] or ''
        ver = re.match(r'([^\s]+)', detail)
        require(ver is not None, 'APT_PLAN_INST_VERSION_MISSING:' + name)
        require(name not in inst, 'APT_PLAN_DUPLICATE_INST:' + name)
        inst[name] = ver.group(1)
        if action['oldVersion']:
            lower = subprocess.run(['dpkg','--compare-versions',ver.group(1),'lt',action['oldVersion']], check=False).returncode
            require(lower != 0, 'APT_PLAN_DOWNGRADE:' + name)
    for name, version in expected.items():
        if inst.get(name) == version: continue
        require(allow_baseline_installed and (baseline_versions or {}).get(name) == version, 'APT_PLAN_PACKAGE_MISSING_OR_VERSION_MISMATCH:' + name)
    return actions


def installed_versions(data):
    rows = {}
    for paragraph in data.decode('utf-8', 'strict').split('\n\n'):
        fields = dict(line.split(': ',1) for line in paragraph.splitlines() if ': ' in line and not line[0].isspace())
        if fields.get('Status') == 'install ok installed': rows[fields['Package']] = fields.get('Version')
    return rows


def status_packages(data):
    names = set()
    for paragraph in data.decode('utf-8', 'strict').split('\n\n'):
        m = re.search(r'(?m)^Package: (\S+)$', paragraph)
        if m:
            names.add(m.group(1))
    return names


def manifest_records(manifest):
    rows = manifest.get('packages')
    require(isinstance(rows, list) and len(rows) == 82, 'MANIFEST_PACKAGE_COUNT_NOT_82')
    records = {}
    for row in rows:
        identity = (row.get('name'), row.get('version'), row.get('architecture'))
        require(all(identity) and identity[2] in ('aarch64','all'), 'MANIFEST_IDENTITY_INVALID')
        require(identity not in records, 'MANIFEST_DUPLICATE_IDENTITY')
        require(re.fullmatch(r'[0-9a-f]{64}', str(row.get('sha256', ''))) is not None, 'MANIFEST_HASH_INVALID')
        require(row.get('filename'), 'MANIFEST_FILENAME_MISSING')
        records[identity] = row
    require(manifest.get('qualified') is False and manifest.get('productionAllowed') is False, 'MANIFEST_GATES_MUST_REMAIN_CLOSED')
    require(manifest.get('sourceCommit') == SOURCE_COMMIT or manifest.get('buildResult', {}).get('sourceCommit') == SOURCE_COMMIT, 'SOURCE_COMMIT_NOT_PINNED')
    return records


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--feed-root', type=pathlib.Path, required=True)
    ap.add_argument('--manifest', type=pathlib.Path, required=True)
    ap.add_argument('--bootstrap-zip', type=pathlib.Path, required=True)
    ap.add_argument('--roots-file', type=pathlib.Path, required=True)
    ap.add_argument('--output', type=pathlib.Path, required=True)
    args = ap.parse_args(argv)
    report = {'valid': False, 'android': 'NOT_RUN', 'installPerformed': False, 'packageCount': 82, 'requestedRootCount': 13}
    try:
        feed = args.feed_root.resolve(strict=True)
        mp = args.manifest.resolve(strict=True)
        manifest = json.loads(mp.read_text())
        records = manifest_records(manifest)
        roots_data = json.loads(args.roots_file.read_text())
        require(roots_data.get('requestedRoots') == ROOTS, 'REQUESTED_ROOTS_LOCK_MISMATCH')
        require(args.bootstrap_zip.is_file() and sha(args.bootstrap_zip) == BOOTSTRAP_SHA256, 'BOOTSTRAP_ZIP_SHA256_MISMATCH')
        with zipfile.ZipFile(args.bootstrap_zip) as z:
            names = [n for n in z.namelist() if n.endswith('var/lib/dpkg/status') or n.endswith('/dpkg/status')]
            require(len(names) == 1, 'BOOTSTRAP_STATUS_MEMBER_INVALID')
            status_bytes = z.read(names[0])
        require(not args.output.exists(), 'OUTPUT_MUST_BE_NEW')
        args.output.mkdir(parents=True)
        signing = json.loads((feed / 'keys/feed-signing.json').read_text())
        key = (feed / signing['publicKeyring']).resolve(strict=True)
        require(feed in key.parents and sha(key) == signing.get('publicKeyringSha256'), 'FEED_PUBLIC_KEY_INVALID')
        fpr = signing.get('fingerprint', '')
        require(re.fullmatch(r'[A-F0-9]{40}', fpr) is not None, 'FEED_FINGERPRINT_INVALID')
        release_dir = feed / 'dists/stable'
        for cmd in (['gpgv', '--status-fd=1', '--keyring', str(key), str(release_dir/'Release.gpg'), str(release_dir/'Release')], ['gpgv', '--status-fd=1', '--keyring', str(key), '--output', str(args.output/'inline-verified-release'), str(release_dir/'InRelease')]):
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
            require(p.returncode == 0 and ('VALIDSIG ' + fpr + ' ') in p.stdout, 'FEED_GPG_SIGNATURE_INVALID')
        require((args.output/'inline-verified-release').read_bytes()==(release_dir/'Release').read_bytes(),'INLINE_RELEASE_PAYLOAD_MISMATCH')
        release = (release_dir/'Release').read_text()
        index = feed/'dists/stable/main/binary-aarch64/Packages'
        idxsum = sha(index)
        require(re.search(r'(?m)^SHA256:\s*$', release) is not None and re.search(r'(?m)^\s+'+idxsum+r'\s+\d+\s+main/binary-aarch64/Packages$', release), 'RELEASE_INDEX_HASH_MISMATCH')
        debs = {}
        for p in (feed/'pool').rglob('*.deb'):
            require(p.is_file() and not p.is_symlink(), 'FEED_DEB_NOT_REGULAR')
            if p.name in debs: raise ValueError('FEED_DEB_FILENAME_DUPLICATE')
            debs[p.name] = p
        require(len(debs) == 82, 'FEED_DEB_COUNT_NOT_82')
        expected = {}
        for ident, row in records.items():
            p = debs.get(row['filename'])
            require(p is not None and sha(p) == row['sha256'], 'MANIFEST_DEB_HASH_MISMATCH:' + ident[0])
            expected[ident[0]] = ident[1]
        require(len(expected) == 82, 'MANIFEST_PACKAGE_SET_INVALID')
        rootvers = dict(x.split('=', 1) for x in ROOTS)
        for n, v in rootvers.items(): require(expected.get(n) == v, 'ROOT_VERSION_LOCK_MISMATCH:' + n)
        with tempfile.TemporaryDirectory(prefix='bootstrap-apt-proof-') as td:
            t = pathlib.Path(td)
            state = t/'state'; lists = state/'lists'; lists.mkdir(parents=True)
            (lists/'partial').mkdir(); (state/'status').write_bytes(status_bytes)
            cache = t/'cache'; (cache/'archives/partial').mkdir(parents=True)
            etc = t/'etc'; etc.mkdir()
            source = etc/'sources.list'; source.write_text(f'deb [arch=aarch64 signed-by={key}] file:{feed} stable main\n')
            cfg = etc/'apt.conf'
            for empty in ('parts','sources.d','trusted.d','preferences.d'): (etc/empty).mkdir()
            for empty in ('main.conf','trusted.gpg','preferences'): (etc/empty).write_text('')
            q = lambda value: json.dumps(str(value))
            values={'Dir':t,'Dir::Etc':etc,'Dir::Etc::main':etc/'main.conf','Dir::Etc::parts':etc/'parts','Dir::Etc::sourcelist':source,'Dir::Etc::sourceparts':etc/'sources.d','Dir::Etc::trusted':etc/'trusted.gpg','Dir::Etc::trustedparts':etc/'trusted.d','Dir::Etc::preferences':etc/'preferences','Dir::Etc::preferencesparts':etc/'preferences.d','Dir::State':state,'Dir::State::lists':lists,'Dir::State::status':state/'status','Dir::State::extended_states':state/'extended_states','Dir::Cache':cache,'Dir::Cache::archives':cache/'archives','Dir::Bin::methods':'/usr/lib/apt/methods','Dir::Bin::dpkg':'/usr/bin/dpkg','Dir::Bin::gpgv':'/usr/bin/gpgv','APT::Architecture':'aarch64','APT::Sandbox::User':pwd.getpwuid(os.getuid()).pw_name,'Acquire::Languages':'none','Acquire::AllowInsecureRepositories':'false','Acquire::AllowDowngradeToInsecureRepositories':'false','APT::Get::AllowUnauthenticated':'false','Acquire::Check-Date':'true','Acquire::Check-Valid-Until':'true'}
            cfg.write_text('\n'.join(f'{key} {q(value)};' for key,value in values.items())+'\nAPT::Architectures { "aarch64"; };\n')
            env = {k:v for k,v in os.environ.items() if k in ('PATH','HOME','LANG','LC_ALL','TMPDIR')}
            env.update(APT_CONFIG=str(cfg),LC_ALL='C',LANG='C')
            command_number=0
            output_directory=args.output
            def apt(args, cwd=None):
                nonlocal command_number
                require(args and (args[0]=='-s' or args[0] in ('update','download')),'HOST_PACKAGE_MUTATION_FORBIDDEN')
                require(not any(x in ('--allow-unauthenticated','--allow-insecure-repositories','--allow-insecure') for x in args), 'APT_INSECURE_OPTION_FORBIDDEN')
                p = subprocess.run(['apt-get'] + args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=240)
                (log_path := output_directory / f'{command_number:02d}-{args[0].replace("-","")}.log').write_text(p.stdout)
                command_number+=1
                require(p.returncode == 0, 'APT_COMMAND_FAILED:' + p.stdout[-3000:])
                return p.stdout
            baseline_names = status_packages(status_bytes)
            apt(['update'])
            roots = apt(['-s','--no-remove','--no-install-recommends','install'] + ROOTS)
            rootplan = parse_plan(roots)
            require(all(a['package'] in expected for a in rootplan if a['action'] == 'Inst'), 'ROOT_PLAN_OUTSIDE_CATALOG')
            require(not re.search(r'^Remv\s+', roots, re.M), 'ROOT_PLAN_REMOVAL')
            # Requested roots must be resolved as exact versions or explicitly already installed at that version.
            validate_plan(roots, rootvers, allow_baseline_installed=True, baseline_versions=installed_versions(status_bytes))
            for action in rootplan:
                if action['action']=='Inst': validate_plan('Inst '+action['package']+' ('+(action['details'] or '')+')', {action['package']:expected[action['package']]})
            fullspec = [n+'='+v for n,v in expected.items()]
            full = apt(['-s','--no-remove','--no-install-recommends','--reinstall','install'] + fullspec)
            fullplan = parse_plan(full)
            require(all(a['package'] in expected for a in fullplan if a['action'] == 'Inst'), 'FULL_PLAN_OUTSIDE_CATALOG')
            validate_plan(full, expected)
            download_dir = t/'downloads'; download_dir.mkdir()
            downloaded = apt(['download'] + fullspec, cwd=download_dir)
            found = list(download_dir.glob('*.deb'))
            require(len(found) == 82, 'APT_DOWNLOAD_COUNT_NOT_82')
            for p in found:
                require(p.name in debs, 'APT_DOWNLOADED_UNKNOWN_DEB:'+p.name)
                require(sha(p) == next(r['sha256'] for r in records.values() if r['filename'] == p.name), 'APT_DOWNLOADED_HASH_MISMATCH:'+p.name)
            status_after = (state/'status').read_bytes()
            require(hashlib.sha256(status_after).digest() == hashlib.sha256(status_bytes).digest(), 'BOOTSTRAP_STATUS_CHANGED')
            inventory = {'packages': [{'filename': p.name, 'sha256': sha(p)} for p in sorted(found)], 'packageCount': len(found)}
            (args.output/'apt-download-inventory.json').write_text(json.dumps(inventory, indent=2, sort_keys=True)+'\n')
            (args.output/'root-plan.txt').write_text(roots)
            (args.output/'full-plan.txt').write_text(full)
        report.update({'valid': True, 'requestedRoots': ROOTS, 'packageCount': 82, 'requestedRootCount': 13, 'manifestSha256': sha(mp), 'releaseIndexSha256': idxsum, 'fingerprint': fpr, 'rootPlanInstCount': sum(a['action']=='Inst' for a in rootplan), 'fullPlanInstCount': sum(a['action']=='Inst' for a in parse_plan(full)), 'aptDownloadCount': 82, 'bootstrapStatusSha256': hashlib.sha256(status_bytes).hexdigest(), 'android': 'NOT_RUN', 'installPerformed': False})
    except Exception as e:
        report['error'] = str(e)
        print('ERROR:' + str(e), file=sys.stderr)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output/'apt-proof-report.json').write_text(json.dumps(report, indent=2, sort_keys=True)+'\n')
    if not report['valid']:
        return 2
    print('BOOTSTRAP_APT_PROOF valid=true packages=82 roots=13 installPerformed=false report=' + str(args.output/'apt-proof-report.json'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
