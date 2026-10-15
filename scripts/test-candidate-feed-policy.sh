#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/aib-candidate-policy.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

for tool in python3 dpkg-deb dpkg-scanpackages gzip; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'ERROR:TOOL_REQUIRED:%s\n' "$tool" >&2; exit 2; }
done

python3 - "$ROOT" "$TMP" <<'PY'
import hashlib, json, pathlib, subprocess, sys
root=pathlib.Path(sys.argv[1])
tmp=pathlib.Path(sys.argv[2])
feed=tmp/'feed'
pkg=tmp/'pkg'
(pkg/'DEBIAN').mkdir(parents=True)
control=(
    'Package: make\nVersion: 4.4.1-1\nArchitecture: aarch64\n'
    'Maintainer: Candidate fixture <noreply@example.invalid>\n'
    'Description: Synthetic policy-test package; never install\n'
)
(pkg/'DEBIAN/control').write_text(control, encoding='utf-8')
marker=pkg/'data/data/com.karat.aibuilder/files/usr/bin/make'
marker.parent.mkdir(parents=True)
marker.write_text('#!/system/bin/sh\nexit 0\n', encoding='utf-8')
marker.chmod(0o755)
(feed/'pool/main/make').mkdir(parents=True)
deb=feed/'pool/main/make/make_4.4.1-1_aarch64.deb'
subprocess.run(['dpkg-deb','--build','--root-owner-group',str(pkg),str(deb)],check=True,stdout=subprocess.DEVNULL)
index_dir=feed/'dists/stable/main/binary-aarch64'
index_dir.mkdir(parents=True)
subprocess.run(['dpkg-scanpackages','-m','pool','/dev/null'],cwd=feed,check=True,stdout=(index_dir/'Packages').open('wb'),stderr=subprocess.DEVNULL)
(index_dir/'Packages.gz').write_bytes(__import__('gzip').compress((index_dir/'Packages').read_bytes(),mtime=0))
digest=hashlib.sha256(deb.read_bytes()).hexdigest()
prefix='/data/user/0/com.karat.aibuilder/files/usr'
build={
 'status':'audit-passed; device-runtime-test-not-run','sourceCommit':'505e06ef0c8dbd7611abfb90e9eb60826dcd01d7',
 'builderImageRef':'ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9',
 'applicationId':'com.karat.aibuilder','prefix':prefix,'packageFile':deb.name,'packageSha256':digest,
 'installed':False,'deviceSmokeTest':'NOT RUN'
}
audit={'ok':True,'status':'static-audit-passed; installation-and-device-runtime-unverified','sha256':digest,
 'package':{'name':'make','version':'4.4.1-1','architecture':'aarch64'},
 'target':{'applicationId':'com.karat.aibuilder','prefix':prefix}}
(tmp/'build-result.json').write_text(json.dumps(build),encoding='utf-8')
(tmp/'audit-report.json').write_text(json.dumps(audit),encoding='utf-8')
(tmp/'feed-root.txt').write_text(str(feed),encoding='utf-8')
PY

VALIDATOR="$ROOT/scripts/validate-candidate-feed.py"
PACKAGE_SET="$ROOT/candidate-package-set.json"
FEED="$(cat "$TMP/feed-root.txt")"
ARGS=(--package-set "$PACKAGE_SET" --feed-root "$FEED" --build-result "$TMP/build-result.json" --audit-report "$TMP/audit-report.json")
python3 "$VALIDATOR" "${ARGS[@]}"

cp "$FEED/pool/main/make/make_4.4.1-1_aarch64.deb" "$FEED/pool/main/make/unapproved_1_aarch64.deb"
if python3 "$VALIDATOR" "${ARGS[@]}" >"$TMP/extra.out" 2>&1; then
  echo 'ERROR:UNAPPROVED_EXTRA_PACKAGE_ACCEPTED' >&2; exit 2
fi
grep -q 'POOL_PACKAGE_SET_MISMATCH' "$TMP/extra.out"
rm "$FEED/pool/main/make/unapproved_1_aarch64.deb"

python3 - "$PACKAGE_SET" "$TMP/open-gate.json" <<'PY'
import json,pathlib,sys
v=json.loads(pathlib.Path(sys.argv[1]).read_text()); v['releaseGate']['publicationAllowed']=True
pathlib.Path(sys.argv[2]).write_text(json.dumps(v),encoding='utf-8')
PY
if python3 "$VALIDATOR" --package-set "$TMP/open-gate.json" --feed-root "$FEED" --build-result "$TMP/build-result.json" --audit-report "$TMP/audit-report.json" >"$TMP/gate.out" 2>&1; then
  echo 'ERROR:OPEN_PRODUCTION_GATE_ACCEPTED' >&2; exit 2
fi
grep -q 'PRODUCTION_PUBLICATION_MUST_REMAIN_DISABLED' "$TMP/gate.out"

printf 'CANDIDATE_POLICY_TESTS_OK positive=1 extra-package-rejected=1 open-production-gate-rejected=1\n'
