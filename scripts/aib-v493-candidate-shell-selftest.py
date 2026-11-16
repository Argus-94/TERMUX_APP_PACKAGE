#!/usr/bin/env python3
"""Real host signed APT delivery + explicitly mocked installer state machine; never Android qualification."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import traceback

BASE = Path(__file__).resolve().parent.parent
ASSET = BASE / 'assets/termux-candidate-probe'
OUT = BASE / 'verification-v493'
UUID = 'probe-01234567-89ab-cdef-0123-456789abcdef'
PROBE_GUARD = r'^/data/(user/0|data)/com\.karat\.aibuilder/files/candidate-probes/probe-[a-f0-9-]{36}$'
INSTALL_GUARD = r'^/data/user/0/com\.karat\.aibuilder/files/candidate-probes/probe-[a-f0-9-]{36}$'
PREFIX = '/data/user/0/com.karat.aibuilder/files/usr'
HOME = '/data/user/0/com.karat.aibuilder/files/home'
EXPECTED_MAKE = 'ef187a6e59c60a46439f9d76d8d11e175fdaacd770d27b1d11bfc9749a6f4332'
results = []
transformations = []


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def record(name, ok, detail=''):
    results.append({'test': name, 'passed': bool(ok), 'detail': str(detail)})


def write_executable(path, body):
    # Never open a symlink for writing, including fixture tool aliases.
    if path.is_symlink():
        path.unlink()
    path.write_text(body)
    path.chmod(0o700)


def run(script, root, prefix, home):
    env = dict(os.environ, PREFIX=str(prefix), HOME=str(home))
    return subprocess.run(['/bin/bash', str(script), str(root)], env=env, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=40)


def retarget(text, guard, root, installer=False):
    assert text.count(guard) == 1
    changed = text.replace(guard, '^' + re.escape(str(root)) + '$')
    if installer:
        changed = changed.replace(PREFIX, str(root.parents[1] / 'usr')).replace(HOME, str(root.parents[1] / 'home'))
    transformations.append({'kind': 'mock-installer' if installer else 'real-host-probe',
                            'root': str(root), 'changes': 'fixed lexical root guard and, for installer, fixed PREFIX/HOME literals only'})
    return changed


def base_fixture(directory):
    files = directory / 'app/files'
    root = files / 'candidate-probes' / UUID
    prefix = files / 'usr'
    home = files / 'home'
    for child in [prefix / 'bin/applets', prefix / 'var/lib/dpkg', prefix / 'etc/apt', home, root]:
        child.mkdir(parents=True, exist_ok=True)
    (prefix / 'var/lib/dpkg/status').write_text('')
    (prefix / 'etc/apt/sources.list').write_text('PRIVATE_SOURCE_SENTINEL_DO_NOT_READ_OR_CHANGE\n')
    return root, prefix, home


def host_probe_case(directory, text, corruption=None):
    root, prefix, home = base_fixture(directory)
    for name in ['dists', 'keys', 'pool']:
        shutil.copytree(ASSET / name, root / 'feed' / name)
    wrappers = {
        'apt-get': '#!/bin/sh\nexport PATH="$PATH:/usr/bin:/bin"\nexec /usr/bin/apt-get -o Dir::Bin::methods=/usr/lib/apt/methods -o Dir::Bin::gpgv=/usr/bin/gpgv "$@"\n',
        'gpgv': '#!/bin/sh\nexec /usr/bin/gpgv "$@"\n',
        'cmp': '#!/bin/sh\nexec /usr/bin/cmp "$@"\n',
        'cat': '#!/bin/sh\nexec /usr/bin/cat "$@"\n',
        'dpkg': '#!/bin/sh\n[ "$1" = --print-architecture ] && { echo aarch64; exit 0; }\necho HOST_DPKG_EXECUTION_FORBIDDEN >&2\nexit 99\n',
        'coreutils': '#!/bin/sh\nx="$1"; shift\nexec "/usr/bin/$x" "$@"\n',
    }
    for name, body in wrappers.items():
        write_executable(prefix / 'bin' / name, body)
    if corruption:
        targets = {
            'key': ['keys/aibuilder-termux-feed-keyring.gpg'],
            'signature': ['dists/stable/Release.gpg'],
            'index': ['dists/stable/main/binary-aarch64/Packages', 'dists/stable/main/binary-aarch64/Packages.gz'],
            'deb': ['pool/main/make/make_4.4.1-1_aarch64.deb'],
        }
        for rel in targets[corruption]:
            with (root / 'feed' / rel).open('ab') as output:
                output.write(b'CORRUPT')
    script = directory / 'host-probe.sh'
    script.write_text(retarget(text, PROBE_GUARD, root))
    before = {str(path): sha(path) for path in [prefix / 'var/lib/dpkg/status', prefix / 'etc/apt/sources.list']}
    result = run(script, root, prefix, home)
    after = {name: sha(name) for name in before}
    record('real_host_' + (corruption + '_rejected' if corruption else 'signed_apt_delivery'),
           result.returncode != 0 if corruption else result.returncode == 0 and result.stdout.splitlines().count('AIB_CANDIDATE_PROBE_OK') == 1,
           f'exit={result.returncode}\n{result.stdout[-2000:]}')
    record('real_host_' + str(corruption or 'valid') + '_private_state_unchanged', before == after)
    if not corruption:
        downloaded = root / 'work/download/make_4.4.1-1_aarch64.deb'
        record('real_host_exact_download_hash', downloaded.is_file() and sha(downloaded) == sha(ASSET / 'pool/main/make/make_4.4.1-1_aarch64.deb'))
        again = run(script, root, prefix, home)
        record('real_host_reused_root_rejected', again.returncode != 0 and 'probe already used' in again.stdout)
        original = run(ASSET / 'probe.sh', root, prefix, home)
        record('production_guard_rejects_host_root', original.returncode != 0)
        moved = root.with_name('actual-stage')
        root.rename(moved)
        root.symlink_to(moved, target_is_directory=True)
        redirected = run(script, root, prefix, home)
        record('real_host_symlink_root_rejected', redirected.returncode != 0)


def mocked_install_case(directory, text, mode):
    root, prefix, home = base_fixture(directory)
    state = directory / 'installed-state'
    binary_body = '#!/bin/sh\n' + ('exit 12\n' if mode == 'makeversionfail' else "printf '%s\\n' 'GNU Make 4.4.1'\n")
    binary_fixture = directory / 'fake-make'
    write_executable(binary_fixture, binary_body)
    for rel in ['include', 'share/doc/make', 'share/info', 'share/man/man1']:
        (prefix / rel).mkdir(parents=True, exist_ok=True)
    write_executable(root / 'probe.sh', '#!/bin/sh\n/usr/bin/mkdir -p "$1/work/tmp"\n: > "$1/work/apt.conf"\nexit 0\n')
    tools = {
        'bash': '#!/bin/sh\nexec /bin/bash "$@"\n',
        'cat': '#!/bin/sh\nexec /usr/bin/cat "$@"\n',
        'coreutils': '#!/bin/sh\nif [ "$1" = sha256sum ] && [ "$2" = "$PREFIX/bin/make" ]; then\n  echo ' + ('bad' if mode == 'wronghash' else EXPECTED_MAKE) + ' " $2"\n  exit 0\nfi\nx="$1"; shift\nexec "/usr/bin/$x" "$@"\n',
        'dpkg-query': '#!/bin/sh\ncase "$*" in\n  *binary:Package*) ' + ("printf 'make-dev\\tinstalled\\n'; exit 0" if mode == 'conflictstate' else 'exit 1') + ';;\n  *) [ -f "' + str(state) + '" ] && ' + ('false' if mode == 'querybad' else 'true') + ' && { printf "installed\\t4.4.1-1\\n"; exit 0; }; exit 1;;\nesac\n',
        'apt-get': '#!/bin/sh\ncase " $* " in\n  *" -s "*) printf "%s\\n" "Inst make (4.4.1-1 stable [aarch64])"; ' + ('echo "Inst extra (1 stable [aarch64])";' if mode == 'planextra' else '') + ' exit 0;;\nesac\n' + ('exit 42\n' if mode == 'APTfail' else '/usr/bin/cp "' + str(binary_fixture) + '" "$PREFIX/bin/make"\n: > "' + str(state) + '"\nexit 0\n'),
    }
    for name, body in tools.items():
        write_executable(prefix / 'bin' / name, body)
    if mode == 'preexistingpayload':
        (prefix / 'include/gnumake.h').write_text('DO NOT OVERWRITE\n')
    script = directory / 'mock-install.sh'
    script.write_text(retarget(text, INSTALL_GUARD, root, installer=True))
    result = run(script, root, prefix, home)
    marker = result.stdout.splitlines().count('AIB_CANDIDATE_MAKE_INSTALLED')
    expected = mode == 'success'
    record('MOCK_installer_' + mode, result.returncode == (0 if expected else 78) and marker == (1 if expected else 0),
           f'exit={result.returncode} marker={marker}\n{result.stdout[-1200:]}')
    if mode in ['conflictstate', 'preexistingpayload', 'planextra']:
        record('MOCK_' + mode + '_no_install_dispatched', not state.exists())


def main():
    OUT.mkdir(exist_ok=True)
    baseline = {name: sha(ASSET / name) for name in ['probe.sh', 'install-make.sh']}
    probe = (ASSET / 'probe.sh').read_text()
    installer = (ASSET / 'install-make.sh').read_text()
    try:
        with tempfile.TemporaryDirectory(prefix='aib-v493-shell-') as td:
            temp = Path(td)
            for corruption in [None, 'key', 'signature', 'index', 'deb']:
                directory = temp / ('real-' + str(corruption))
                directory.mkdir()
                host_probe_case(directory, probe, corruption)
            for mode in ['success', 'conflictstate', 'preexistingpayload', 'planextra', 'APTfail', 'wronghash', 'querybad', 'makeversionfail']:
                directory = temp / ('mock-' + mode)
                directory.mkdir()
                mocked_install_case(directory, installer, mode)
    except Exception:
        record('harness_execution', False, traceback.format_exc())
    record('source_assets_unchanged', baseline == {name: sha(ASSET / name) for name in baseline})
    record('evidence_scope', True, 'Actual host gpgv/APT local delivery; installer uses explicit fake tools. No host dpkg install, /data access, Android execution or production qualification.')
    passed = sum(item['passed'] for item in results)
    failed = sum(not item['passed'] for item in results)
    (OUT / 'candidate-shell-results.json').write_text(json.dumps({'passed': passed, 'failed': failed, 'tests': results}, indent=2) + '\n')
    (OUT / 'candidate-shell-transformations.json').write_text(json.dumps({'productionFilesEdited': False, 'transformations': transformations}, indent=2) + '\n')
    (OUT / 'candidate-shell-selftest.log').write_text('\n'.join(('PASS ' if item['passed'] else 'FAIL ') + item['test'] + '\n' + item['detail'] for item in results) + '\n')
    print(f'candidate-shell-selftest: {passed} PASS, {failed} FAIL (host APT + mocked installer; Android NOT RUN)')
    for item in results:
        if not item['passed']:
            print('FAIL', item['test'], item['detail'])
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
