#!/usr/bin/env python3
"""Isolated host APT proof for the signed 80-package Termux candidate feed.

No package is installed. The copied CLI's verify action performs signed local-feed
verification and writes the fresh apt.conf consumed by host APT simulation/download.
"""
from __future__ import annotations
import hashlib, json, os, pathlib, shutil, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[1]
ASSET = ROOT / 'assets/termux-candidate-full'
OUT = ROOT / 'verification-v493'
FIX = pathlib.Path('/dev/shm/aib-v493-full-host-FIXED')
FILES = FIX / 'files'
CACHE = FILES / 'candidate-feed-e5a2e3cdb0d1'
PREFIX = FILES / 'usr'
LOGDIR = OUT / 'full-candidate-host-apt-logs'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if FIX.exists():
        shutil.rmtree(FIX)
    FIX.mkdir(parents=True)
    LOGDIR.mkdir(parents=True, exist_ok=True)
    for p in LOGDIR.iterdir():
        if p.is_file(): p.unlink()
    plan = {'fixture': str(FIX), 'cache': str(CACHE), 'asset': str(ASSET),
            'real_signed_host_apt': True, 'production_source_files_modified': False,
            'package_installation_performed': False, 'commands': [], 'transforms': [],
            'caveats': []}
    # /dev/shm and /workspace are separate filesystems: hardlinks cannot cross them.
    # Copy all regular assets (never symlinks) into the requested isolated fixture.
    shutil.copytree(ASSET, CACHE, symlinks=False)
    if any(p.is_symlink() for p in CACHE.rglob('*')):
        raise RuntimeError('unexpected symlink in copied asset cache')
    plan['caveats'].append('Asset source and requested /dev/shm fixture are different filesystems; hardlinks are impossible (EXDEV), so cache assets were copied as regular files. No symlinks were used.')
    CLI = CACHE / 'candidate-command.sh'
    raw = CLI.read_text()
    old = '/data/user/0/com.karat.aibuilder/files/candidate-feed-e5a2e3cdb0d1'
    if raw.count(old) != 1:
        raise RuntimeError(f'expected exactly one cache literal, found {raw.count(old)}')
    new = str(CACHE)
    CLI.write_text(raw.replace(old, new))
    CLI.chmod(0o700)
    plan['transforms'].append({'file': str(CLI), 'from': old, 'to': new, 'occurrences': 1,
                               'scope': 'fixture-only CLI path retarget'})
    home = FILES / 'home'
    home.mkdir(parents=True)
    (PREFIX / 'bin').mkdir(parents=True)
    (PREFIX / 'var/lib/dpkg').mkdir(parents=True)
    status_src = OUT / 'bootstrap-private-status.txt'
    shutil.copyfile(status_src, PREFIX / 'var/lib/dpkg/status')
    (PREFIX / 'var/lib/dpkg/status').chmod(0o600)
    # wrappers are regular executable scripts, scoped to the fixture's private PATH.
    wrappers = {
      'coreutils': '#!/bin/bash\nset -e\n[[ $# -ge 1 ]] || exit 64\ntool=$1; shift\nexec "/usr/bin/$tool" "$@"\n',
      'dpkg': '#!/bin/bash\nset -e\nif [[ "${1:-}" == --print-architecture ]]; then printf aarch64; exit 0; fi\nif [[ "${1:-}" == --compare-versions ]]; then exec /usr/bin/dpkg "$@"; fi\nprintf "host wrapper forbids dpkg mutation/unsupported action: %s\\n" "${1:-}" >&2; exit 64\n',
      'dpkg-query': '#!/bin/bash\nexec /usr/bin/dpkg-query --admindir="' + str(PREFIX / 'var/lib/dpkg') + '" "$@"\n',
      'gpgv': '#!/bin/bash\nexec /usr/bin/gpgv "$@"\n',
      'cmp': '#!/bin/bash\nexec /usr/bin/cmp "$@"\n',
      'cat': '#!/bin/bash\nexec /usr/bin/cat "$@"\n',
      'apt-get': '#!/bin/bash\nexport PATH=/usr/bin:/bin\nexec /usr/bin/apt-get -o Dir::Bin::methods=/usr/lib/apt/methods -o Dir::Bin::gpgv=/usr/bin/gpgv "$@"\n',
    }
    for name, body in wrappers.items():
        p = PREFIX / 'bin' / name
        p.write_text(body)
        p.chmod(0o700)
    env = os.environ.copy()
    env.update({'HOME': str(home), 'PREFIX': str(PREFIX), 'PATH': str(PREFIX / 'bin') + ':/usr/bin:/bin', 'LC_ALL':'C'})
    for var in ('http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','all_proxy'):
        env.pop(var, None)
    commands=[]
    def run(label, argv, *, runenv=env, timeout=160, expected=0, runcwd=None):
        start=time.time()
        try:
            p=subprocess.run(argv, cwd=str(runcwd or FIX), env=runenv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, timeout=timeout)
            code=p.returncode; text=p.stdout
        except subprocess.TimeoutExpired as e:
            code=124; text=(e.stdout or '') + '\nHARNESS_TIMEOUT\n'
            if isinstance(text,bytes): text=text.decode(errors='replace')
        log=LOGDIR/(label+'.log')
        log.write_text(text)
        rec={'label':label,'argv':argv,'exit_code':code,'expected_exit_code':expected,
             'seconds':round(time.time()-start,3),'log':str(log),'output_tail':text[-12000:]}
        commands.append(rec)
        return code,text
    # Record host tool versions used, without relying on the Android/private tools.
    versions={}
    for name, argv in {'apt-get':['/usr/bin/apt-get','--version'], 'dpkg':['/usr/bin/dpkg','--version'],
                       'gpgv':['/usr/bin/gpgv','--version']}.items():
        try: versions[name]=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=10).stdout.splitlines()[:2]
        except Exception as e: versions[name]=[str(e)]
    plan['host_tool_versions']=versions
    # Run unchanged CLI content except its single fixed cache-path replacement, explicitly under bash.
    c,txt=run('cli-verify',['/bin/bash',str(CLI),str(CACHE),'verify'],timeout=100)
    if c != 0:
        plan.update(status='FAIL',failed_step='cli-verify',failure_exit_code=c)
        plan['commands']=commands
        (OUT/'full-candidate-host-apt-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
        (OUT/'full-candidate-host-apt-status.txt').write_text('FAIL cli-verify exit='+str(c)+'\n')
        return c or 1
    evidence=None
    for line in txt.splitlines():
        if line.startswith('AIB_FULL_CANDIDATE_EVIDENCE:'): evidence=pathlib.Path(line.split(':',1)[1])
    if not evidence or not (evidence/'apt.conf').is_file():
        plan.update(status='FAIL',failed_step='fresh-apt-config-not-found')
        plan['commands']=commands
        (OUT/'full-candidate-host-apt-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
        (OUT/'full-candidate-host-apt-status.txt').write_text('FAIL fresh APT configuration missing\n')
        return 1
    aptenv=env.copy(); aptenv['APT_CONFIG']=str(evidence/'apt.conf')
    packages=[]
    for line in (CACHE/'packages.tsv').read_text().splitlines():
        cols=line.split('\t')
        if len(cols)!=5: raise RuntimeError('malformed package manifest row')
        packages.append((cols[0],cols[1],cols[3],cols[4]))
    if len(packages)!=80: raise RuntimeError(f'expected 80 packages, got {len(packages)}')
    args=[f'{name}={version}' for name,version,_,_ in packages]
    common=['--no-install-recommends','install','--reinstall']
    base=['/usr/bin/apt-get','-s','--no-install-recommends','--reinstall','install']+args
    c,sim=run('apt-simulate',base,runenv=aptenv,timeout=120)
    if c != 100 or 'bzip2 : Depends: libbz2 (= 1.0.8-6)' not in sim or 'xz-utils : Depends: liblzma (= 5.8.1)' not in sim:
        plan.update(status='FAIL', failed_step='expected-bootstrap-incompatibility-not-proven', commands=commands)
        (OUT/'full-candidate-host-apt-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
        return 1
    plan['bootstrap_compatibility'] = 'BLOCKED: exact bzip2/libbz2 and xz-utils/liblzma dependency conflicts'
    plan['full_installation_ready'] = False
    # This separate empty-status simulation is evidence about the feed itself, not the actual bootstrap/runtime.
    empty = evidence / 'empty-status'
    empty.write_text('')
    extra = ['-o', 'Dir::State::status=' + str(empty), '-o', 'Dir::Bin::methods=/usr/lib/apt/methods', '-o', 'Dir::Bin::gpgv=/usr/bin/gpgv']
    c, sim = run('apt-empty-status-simulate', ['/usr/bin/apt-get', *extra, '-s', '--no-remove', '--no-install-recommends', '--reinstall', 'install', *args], runenv=aptenv, timeout=120)
    if c != 0:
        plan.update(status='FAIL', failed_step='independent-empty-status-simulation', commands=commands)
        (OUT/'full-candidate-host-apt-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
        return c or 1
    inst=[]; unexpected=[]
    for line in sim.splitlines():
        cols=line.split()
        if cols and cols[0]=='Inst' and len(cols)>=3:
            name=cols[1].split(':',1)[0]
            ver=line.split('(', 1)[1].split()[0]
            inst.append((name,ver))
        elif cols and cols[0] in ('Remv','Downgrade'):
            unexpected.append(line)
    expected={(n,v) for n,v,_,_ in packages}
    if set(inst)!=expected or len(inst)!=80 or unexpected:
        plan.update(status='FAIL',failed_step='simulation-plan-mismatch',simulation_inst=inst,unexpected=unexpected)
        plan['commands']=commands
        (OUT/'full-candidate-host-apt-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
        (OUT/'full-candidate-host-apt-status.txt').write_text(f'FAIL simulation expected 80 Inst, got {len(inst)}, unexpected={unexpected}\n')
        return 1
    # Download-only with apt explicit dry-run safety flags; no dpkg mutation command is possible.
    downloads=evidence/'downloaded'; downloads.mkdir()
    dl=['/usr/bin/apt-get',*extra,'download']+args
    c,downloadlog=run('apt-download-exact',dl,runenv=aptenv,timeout=180,runcwd=downloads)
    if c!=0:
        plan.update(status='FAIL',failed_step='apt-download-only',failure_exit_code=c)
        plan['commands']=commands
        (OUT/'full-candidate-host-apt-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
        (OUT/'full-candidate-host-apt-status.txt').write_text('FAIL apt download-only exit='+str(c)+'\n')
        return c or 1
    archives=downloads
    downloaded=[]
    for deb in archives.glob('*.deb'):
        h=hashlib.sha256()
        with deb.open('rb') as f:
            for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
        downloaded.append((deb.name,h.hexdigest()))
    got_hashes=sorted(h for _,h in downloaded)
    expected_hashes=sorted(h for _,_,h,_ in packages)
    inventory={'count':len(downloaded),'expected_count':80,'files':[{'filename':n,'sha256':h} for n,h in sorted(downloaded)],
               'manifest_sha256':expected_hashes,'exact_hash_set_match':got_hashes==expected_hashes}
    (OUT/'full-candidate-host-apt-inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
    if len(downloaded)!=80 or got_hashes!=expected_hashes:
        plan.update(status='FAIL',failed_step='download-hash-mismatch',download_count=len(downloaded),hash_set_match=got_hashes==expected_hashes)
        plan['commands']=commands
        (OUT/'full-candidate-host-apt-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
        (OUT/'full-candidate-host-apt-status.txt').write_text(f'FAIL download count={len(downloaded)} exact_hash_set_match={got_hashes==expected_hashes}\n')
        return 1
    # Remove only downloaded ephemeral copies, retain signed feed assets and logs/inventory.
    for deb in archives.glob('*.deb'): deb.unlink()
    plan.update(status='PASS_BOUNDARY_ONLY',cli_verify='PASS',signed_repository_update='PASS (via CLI)',simulation='EMPTY STATUS ONLY: 80 exact package/version pairs; actual bootstrap is BLOCKED',
                download_only='APT download (no installation): 80 exact archive SHA256 values',downloads_removed_after_verification=True,
                apt_config=str(evidence/'apt.conf'),transaction_work=str(evidence),packages=[{'name':n,'version':v,'sha256':h,'relative_archive':r} for n,v,h,r in packages],
                commands=commands)
    (OUT/'full-candidate-host-apt-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
    (OUT/'full-candidate-host-apt-status.txt').write_text('PASS_BOUNDARY_ONLY: real bootstrap simulation is BLOCKED by exact bzip2/libbz2 and xz-utils/liblzma dependencies. Independent EMPTY-STATUS simulation/download validates 80 signed archives only. No installed runtime readiness or Android qualification; no dpkg installation performed.\n')
    return 0

if __name__=='__main__':
    try: sys.exit(main())
    except Exception as e:
        OUT.mkdir(parents=True,exist_ok=True)
        (OUT/'full-candidate-host-apt-status.txt').write_text('FAIL harness exception: '+repr(e)+'\n')
        print(repr(e),file=sys.stderr)
        sys.exit(1)
