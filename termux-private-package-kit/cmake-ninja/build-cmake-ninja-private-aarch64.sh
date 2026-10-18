#!/usr/bin/env bash
set -Eeuo pipefail
readonly PIN=505e06ef0c8dbd7611abfb90e9eb60826dcd01d7
readonly IMAGE=ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9
readonly CLOSURE_SHA=9423ddd7b885395cea329ec4a8580de17589eb9a0106e58fd54f0ea5a28d22ff
readonly EXPECTED_MANIFEST_SHA='9eb4a0fdf2aa0f3996bb9938baacd72c0da53c1ddc0c1764d7aafd1ed57e4851'
readonly KIT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT="$(cd -- "$KIT/../.." && pwd)"
fail(){ echo "ERROR:$*" >&2; exit 2; }
[[ $# == 3 ]] || fail 'USAGE:build-cmake-ninja-private-aarch64.sh <pinned-source> <package-set.json> <new-empty-output>'
SRC=$(realpath "$1"); MANIFEST=$(realpath "$2"); OUT=$(realpath -m "$3")
: "${AIB_TERMUX_APP_DATA_DIR:?Set canonical modeled app data path}"; : "${AIB_TERMUX_PREFIX:?Set matching modeled prefix}"; : "${AIB_TERMUX_BUILDER_IMAGE_REF:?Set pinned builder image}"
[[ "$AIB_TERMUX_APP_DATA_DIR" == /data/user/0/com.karat.aibuilder || "$AIB_TERMUX_APP_DATA_DIR" == /data/data/com.karat.aibuilder ]] || fail APP_DATA_DIR_NOT_CANONICAL
[[ "$AIB_TERMUX_PREFIX" == "$AIB_TERMUX_APP_DATA_DIR/files/usr" ]] || fail PREFIX_MISMATCH
[[ "$AIB_TERMUX_BUILDER_IMAGE_REF" == "$IMAGE" ]] || fail BUILDER_IMAGE_NOT_ALLOWLISTED
for t in git docker dpkg-deb readelf python3 curl; do command -v "$t" >/dev/null || fail "TOOL_REQUIRED:$t"; done
[[ -d "$SRC/.git" && $(git -C "$SRC" rev-parse HEAD) == "$PIN" ]] || fail SOURCE_COMMIT_MISMATCH
[[ -z "$(git -C "$SRC" status --porcelain=v1)" ]] || fail SOURCE_CHECKOUT_NOT_CLEAN
case "$OUT/" in "$SRC/"*) fail OUTPUT_INSIDE_SOURCE;; esac
if [[ -e "$OUT" ]]; then [[ -d "$OUT" && -z "$(find "$OUT" -mindepth 1 -print -quit)" ]] || fail OUTPUT_MUST_BE_EMPTY; else mkdir -p "$OUT"; fi
[[ $(sha256sum "$MANIFEST"|awk '{print $1}') == "$EXPECTED_MANIFEST_SHA" ]] || fail PACKAGE_SET_SHA256_NOT_ALLOWLISTED
python3 - "$MANIFEST" <<'PY'
import json,pathlib,sys
m=json.loads(pathlib.Path(sys.argv[1]).read_text()); assert m['source']['commit']=='505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'; assert m['sourceClosure']['profile']=='cmake-ninja-candidate'; assert m['sourceClosure']['rootPackages']==['cmake','ninja']; assert m['sourceClosure']['buildTargetPackages']==['cmake','ninja']; assert m['sourceClosure']['expectedPackageCount']==22 and m['sourceClosure']['expectedDependencyAlternativeCount']==34; assert len(m['packages'])==22; assert m['releaseGate']=={'publicationAllowed':False,'deviceInstall':'NOT RUN','rollback':'NOT RUN','deviceEvidenceSha256':None}
PY
python3 "$ROOT/scripts/resolve-pinned-termux-recipe-closure.py" --source-root "$SRC" --scope "$ROOT/termux-package-source-scope.json" --profile cmake-ninja-candidate >"$OUT/source-closure.json"
[[ $(sha256sum "$OUT/source-closure.json"|awk '{print $1}') == "$CLOSURE_SHA" ]] || fail PINNED_SOURCE_CLOSURE_HASH_MISMATCH
python3 - "$KIT" "$MANIFEST" "$OUT/source-closure.json" "$AIB_TERMUX_PREFIX" <<'PYGATE'
import argparse,pathlib,sys
sys.path.insert(0,sys.argv[1])
from audit_cmake_ninja_closure import validate_manifest
validate_manifest(argparse.Namespace(package_set=pathlib.Path(sys.argv[2]),source_closure=pathlib.Path(sys.argv[3]),prefix=sys.argv[4]))
PYGATE
python3 - "$OUT/source-closure.json" "$MANIFEST" <<'PY'
import json,pathlib,sys
c=json.loads(pathlib.Path(sys.argv[1]).read_text());m=json.loads(pathlib.Path(sys.argv[2]).read_text()); fields=('recipePath','recipeSha256','packageType','parentPackage','parentDependencyRule','subpackagePath','subpackageSha256','sourceVersionExpression','sourceRevisionExpression','versionExpressionIsLiteral','revisionExpressionIsLiteral','dependencyGroups','recommendationGroupsNotIncludedInRequiredClosure'); assert c['sourceCommit']==m['source']['commit'] and c['profile']=='cmake-ninja-candidate' and c['rootPackages']==['cmake','ninja'] and c['packageCount']==22 and c['dependencyAlternativeCount']==34; assert {x['name']:{k:x[k] for k in fields} for x in c['packages']}=={x['name']:{k:x[k] for k in fields} for x in m['packages']}
PY
for p in 'scripts/properties.sh 238a19b2f29ef5eed5806a21bee8f5a51bc5031e7db3fcc393d831292300b725' 'build-package.sh 5a7e3c1b85a8ddd6b5c197c47d6d384de4b387fa5114a0f679f19d9925f02204' 'scripts/run-docker.sh d67b37a9f1142b5f12b5818f312df7b33889158541e74f04524d1378cabf60b2' 'scripts/profile-restricted.apparmor ec7680c466c03c9354b890e6860f9fb3e1b5512d380c9d05e426cb47548abbe8'; do read -r f h <<<"$p"; [[ $(git -C "$SRC" show "$PIN:$f"|sha256sum|awk '{print $1}') == "$h" ]] || fail "PINNED_SCRIPT_HASH:$f"; done
free_bytes=$(df -PB1 "$OUT" | awk 'END {print $4}'); (( free_bytes >= 8 * 1024 * 1024 * 1024 )) || fail LESS_THAN_8_GIB_FREE_NO_BUILD_STARTED
mkdir -p "$OUT/root-sources"
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 https://www.cmake.org/files/v4.4/cmake-4.4.4.tar.gz -o "$OUT/root-sources/cmake.tar.gz"
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 https://github.com/ninja-build/ninja/archive/refs/tags/v1.13.2.tar.gz -o "$OUT/root-sources/ninja.tar.gz"
python3 "$KIT/verify_cmake_ninja_source_inputs.py" --source-root "$SRC" --download-root "$OUT/root-sources" --package-set "$MANIFEST"
mkdir -p "$OUT/work"; W="$OUT/work/termux-packages"; git clone --shared --dissociate --no-checkout "$SRC" "$W" >/dev/null; git -C "$W" checkout --detach "$PIN" >/dev/null
python3 "$ROOT/termux-private-package-kit/make-v476/patch_properties.py" "$W/scripts/properties.sh" --data-dir "$AIB_TERMUX_APP_DATA_DIR" --prefix "$AIB_TERMUX_PREFIX"
git -C "$W" diff -- scripts/properties.sh > "$OUT/app-private-properties.patch"
test -s "$OUT/app-private-properties.patch" || fail PRIVATE_PROPERTIES_PATCH_MISSING
changed=$(git -C "$W" diff --name-only|sort); [[ "$changed" == 'scripts/properties.sh' ]] || fail PATCH_SCOPE_MISMATCH
cat > "$W/.aib-preflight.sh" <<EOF
#!/bin/bash
set -e; cd /home/builder/termux-packages; source scripts/properties.sh
[[ "\$TERMUX_APP__PACKAGE_NAME" == com.karat.aibuilder && "\$TERMUX_APP__DATA_DIR" == "$AIB_TERMUX_APP_DATA_DIR" && "\$TERMUX_PREFIX" == "$AIB_TERMUX_PREFIX" && "\$TERMUX__PREFIX" == "$AIB_TERMUX_PREFIX" ]]
EOF
chmod 700 "$W/.aib-preflight.sh"; mkdir -p "$W/output/.aib-private-cmake-ninja-debs"
free_bytes=$(df -PB1 "$OUT" | awk 'END {print $4}'); (( free_bytes >= 8 * 1024 * 1024 * 1024 )) || fail LESS_THAN_8_GIB_FREE_NO_BUILD_STARTED
docker info >/dev/null 2>&1 || fail DOCKER_UNAVAILABLE; docker image inspect "$IMAGE" >/dev/null 2>&1 || fail PINNED_IMAGE_NOT_PRESENT_NO_PULL_ATTEMPTED
export TERMUX_BUILDER_IMAGE_NAME="$IMAGE" CONTAINER_NAME="aib-cmake-ninja-$$"
trap 'docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1 && docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true' EXIT
(cd "$W" && ./scripts/run-docker.sh bash /home/builder/termux-packages/.aib-preflight.sh) | tee "$OUT/build.log"
(cd "$W" && ./scripts/run-docker.sh bash -c 'set -Eeuo pipefail; cd /home/builder/termux-packages; export TERMUX_INSTALL_DEPS=false; ./build-package.sh -a aarch64 --format debian -o /home/builder/termux-packages/output/.aib-private-cmake-ninja-debs cmake; ./build-package.sh -a aarch64 --format debian -o /home/builder/termux-packages/output/.aib-private-cmake-ninja-debs ninja') 2>&1 | tee -a "$OUT/build.log"
mkdir -p "$OUT/packages"; python3 - "$W/output" "$MANIFEST" "$OUT/packages" <<'PY'
import json,pathlib,shutil,subprocess,sys
root=pathlib.Path(sys.argv[1]);m=json.loads(pathlib.Path(sys.argv[2]).read_text());spec={p['name']:p for p in m['packages']}; found={}
for d in root.rglob('*.deb'):
 c=subprocess.check_output(['dpkg-deb','-f',str(d)],text=True); fields=dict(x.split(': ',1) for x in c.splitlines() if ': ' in x); n=fields.get('Package')
 if n in spec:
  assert (fields['Version'],fields['Architecture'])==(spec[n]['version'],spec[n]['architecture']),n
  if n in found: assert found[n].read_bytes()==d.read_bytes()
  else: found[n]=d
assert set(found)==set(spec),set(spec)-set(found)
for d in found.values():shutil.copy2(d,pathlib.Path(sys.argv[3])/d.name)
PY
python3 "$KIT/audit_cmake_ninja_closure.py" --package-set "$MANIFEST" --source-closure "$OUT/source-closure.json" --packages-dir "$OUT/packages" --prefix "$AIB_TERMUX_PREFIX" --report "$OUT/audit-report.json" | tee -a "$OUT/build.log"
python3 - "$OUT/build-result.json" "$MANIFEST" "$OUT/audit-report.json" "$IMAGE" "$PIN" "$AIB_TERMUX_PREFIX" <<'PY'
import json,pathlib,sys
out,mf,af,image,pin,prefix=map(str,sys.argv[1:]);m=json.loads(pathlib.Path(mf).read_text());a=json.loads(pathlib.Path(af).read_text()); ps=[]
import subprocess,hashlib
for p in m['packages']:
 d=next(pathlib.Path(out).parent.joinpath('packages').glob(p['name']+'_*_'+p['architecture']+'.deb')); c=subprocess.check_output(['dpkg-deb','-f',str(d)],text=True); f=dict(x.split(': ',1) for x in c.splitlines() if ': ' in x);ps.append({'name':p['name'],'version':f['Version'],'architecture':f['Architecture'],'file':d.name,'sha256':hashlib.sha256(d.read_bytes()).hexdigest()})
r={'schemaVersion':1,'status':'audit-passed; device-runtime-test-not-run','sourceCommit':pin,'builderImage':image,'prefix':prefix,'prefixProvenance':'ci-model-only; device-observation-not-run','sourceClosure':{'profile':'cmake-ninja-candidate','rootPackages':['cmake','ninja'],'buildTargetPackages':['cmake','ninja'],'packageCount':22,'dependencyAlternativeCount':34},'packages':ps,'baseLicenseProviderEvidence':m['baseLicenseProviderEvidence'],'installed':False,'deviceSmokeTest':'NOT RUN','rollback':'NOT RUN'};pathlib.Path(out).write_text(json.dumps(r,indent=2)+'\n')
PY
printf 'CMAKE_NINJA_BUILD_AND_STATIC_AUDIT_OK; no device install performed\n'
