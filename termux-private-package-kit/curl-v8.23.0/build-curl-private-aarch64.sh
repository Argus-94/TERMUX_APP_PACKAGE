#!/usr/bin/env bash
set -Eeuo pipefail

readonly PIN='505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
readonly APP_ID='com.karat.aibuilder'
readonly IMAGE='ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9'
readonly MIN_FREE_BYTES=$((5 * 1024 * 1024 * 1024))
readonly KIT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT="$(cd -- "$KIT_DIR/../.." && pwd)"
fail() { printf 'ERROR:%s\n' "$*" >&2; exit 2; }

[[ $# -eq 3 ]] || fail 'USAGE:build-curl-private-aarch64.sh <pinned-source> <package-set.json> <new-empty-output>'
SOURCE_REPO="$(realpath "$1")"
PACKAGE_SET="$(realpath "$2")"
OUTPUT_DIR="$(realpath -m "$3")"
: "${AIB_TERMUX_APP_DATA_DIR:?Set canonical modeled app data path}"
: "${AIB_TERMUX_PREFIX:?Set matching modeled filesDir/usr path}"
: "${AIB_TERMUX_BUILDER_IMAGE_REF:?Set the digest-pinned official Termux builder}"
APP_DATA_DIR="${AIB_TERMUX_APP_DATA_DIR%/}"
PREFIX="${AIB_TERMUX_PREFIX%/}"
[[ "$APP_DATA_DIR" == '/data/user/0/com.karat.aibuilder' || "$APP_DATA_DIR" == '/data/data/com.karat.aibuilder' ]] || fail 'APP_DATA_DIR_NOT_CANONICAL'
[[ "$PREFIX" == "$APP_DATA_DIR/files/usr" ]] || fail 'PREFIX_MISMATCH'
[[ "$AIB_TERMUX_BUILDER_IMAGE_REF" == "$IMAGE" ]] || fail 'BUILDER_IMAGE_NOT_ALLOWLISTED'
for tool in git docker dpkg-deb readelf python3; do command -v "$tool" >/dev/null || fail "TOOL_REQUIRED:$tool"; done
[[ -d "$SOURCE_REPO/.git" ]] || fail 'SOURCE_CHECKOUT_REQUIRED'
[[ "$(git -C "$SOURCE_REPO" rev-parse HEAD)" == "$PIN" ]] || fail 'SOURCE_COMMIT_MISMATCH'
[[ -z "$(git -C "$SOURCE_REPO" status --porcelain=v1)" ]] || fail 'SOURCE_CHECKOUT_NOT_CLEAN'
case "$OUTPUT_DIR/" in "$SOURCE_REPO/"*) fail 'OUTPUT_MUST_NOT_BE_INSIDE_SOURCE_CHECKOUT';; esac
if [[ -e "$OUTPUT_DIR" ]]; then
  [[ -d "$OUTPUT_DIR" ]] || fail 'OUTPUT_PATH_EXISTS_NOT_DIRECTORY'
  [[ -z "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'OUTPUT_DIRECTORY_MUST_BE_NEW_OR_EMPTY'
else
  mkdir -p -- "$OUTPUT_DIR"
fi

python3 - "$PACKAGE_SET" <<'PY'
import json,pathlib,sys
m=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
assert m['schemaVersion']==1 and m['channel']=='candidate-only'
assert m['source']['commit']=='505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
assert m['source']['builderImage']=='ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9'
assert m['source']['restrictedAppArmorProfileSha256']=='ec7680c466c03c9354b890e6860f9fb3e1b5512d380c9d05e426cb47548abbe8'
assert m['source']['restrictedAppArmorOutputAllow']=='/home/builder/termux-packages/output/** rw,'
assert m['sourceClosure']['profile']=='curl-candidate' and m['sourceClosure']['rootPackages']==['curl']
assert m['sourceClosure']['buildTargetPackage']=='libcurl'
assert m['sourceClosure']['expectedPackageCount']==9 and m['sourceClosure']['expectedDependencyAlternativeCount']==12
assert len(m['packages'])==9 and [p['name'] for p in m['packages']]==sorted(p['name'] for p in m['packages'])
assert m['releaseGate']['publicationAllowed'] is False
assert m['releaseGate']['deviceInstall']=='NOT RUN' and m['releaseGate']['rollback']=='NOT RUN'
assert m['releaseGate']['deviceEvidenceSha256'] is None

PY

source_actual="$(git -C "$SOURCE_REPO" rev-parse HEAD)"
python3 "$ROOT/scripts/resolve-pinned-termux-recipe-closure.py" \
  --source-root "$SOURCE_REPO" --scope "$ROOT/termux-package-source-scope.json" \
  --profile curl-candidate > "$OUTPUT_DIR/source-closure.json"
python3 - "$OUTPUT_DIR/source-closure.json" "$PACKAGE_SET" <<'PY'
import json,pathlib,sys
closure=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
manifest=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))
fields=('recipePath','recipeSha256','packageType','parentPackage','parentDependencyRule','subpackagePath','subpackageSha256','sourceVersionExpression','sourceRevisionExpression','versionExpressionIsLiteral','revisionExpressionIsLiteral','dependencyGroups','recommendationGroupsNotIncludedInRequiredClosure')
actual={x['name']:{k:x[k] for k in fields} for x in closure['packages']}
expected={x['name']:{k:x[k] for k in fields} for x in manifest['packages']}
assert closure['sourceCommit']==manifest['source']['commit']=='505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
assert closure['profile']=='curl-candidate' and closure['rootPackages']==['curl']
assert closure['packageCount']==manifest['sourceClosure']['expectedPackageCount']==9
assert closure['dependencyAlternativeCount']==manifest['sourceClosure']['expectedDependencyAlternativeCount']==12
assert actual==expected,(sorted(actual.items()),sorted(expected.items()))
root=next(x for x in closure['packages'] if x['name']=='curl')
direct={a['name'] for group in root['dependencyGroups'] for a in group}
assert direct==set(manifest['runtimeDependencies']['curlRequires'])=={'libcurl'}
libcurl=next(x for x in closure['packages'] if x['name']=='libcurl')
libcurl_direct={a['name'] for group in libcurl['dependencyGroups'] for a in group}
assert libcurl_direct==set(manifest['runtimeDependencies']['libcurlRequires'])
recommendations={a['name'] for x in closure['packages'] for group in x['recommendationGroupsNotIncludedInRequiredClosure'] for a in group}
assert recommendations==set(manifest['runtimeDependencies']['recommendationsExcludedFromInstallSimulation'])
print('PINNED_CURL_SOURCE_CLOSURE_OK packages=9 dependency_alternatives=12 root=curl subpackage_hash=checked recommendations_excluded=0')

PY

for pair in \
  'scripts/properties.sh 238a19b2f29ef5eed5806a21bee8f5a51bc5031e7db3fcc393d831292300b725' \
  'build-package.sh 5a7e3c1b85a8ddd6b5c197c47d6d384de4b387fa5114a0f679f19d9925f02204' \
  'scripts/run-docker.sh d67b37a9f1142b5f12b5818f312df7b33889158541e74f04524d1378cabf60b2' \
  'scripts/profile-restricted.apparmor ec7680c466c03c9354b890e6860f9fb3e1b5512d380c9d05e426cb47548abbe8'; do
  read -r path expected <<< "$pair"
  actual="$(git -C "$SOURCE_REPO" show "$PIN:$path" | sha256sum | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fail "LOCKED_UPSTREAM_SCRIPT_HASH_MISMATCH:$path"
done
grep -Fq -- 'allow /home/builder/termux-packages/output/** rw,' "$SOURCE_REPO/scripts/profile-restricted.apparmor" || fail 'PINNED_APPARMOR_OUTPUT_ALLOW_NOT_FOUND'
grep -Fq -- 'deny /home/builder/termux-packages/[^o]** wlk,' "$SOURCE_REPO/scripts/profile-restricted.apparmor" || fail 'PINNED_APPARMOR_SOURCE_TREE_DENY_NOT_FOUND'

mkdir -p "$OUTPUT_DIR/work"
WORKTREE="$OUTPUT_DIR/work/termux-packages"
git clone --shared --dissociate --no-checkout "$SOURCE_REPO" "$WORKTREE" >/dev/null
git -C "$WORKTREE" checkout --detach "$PIN" >/dev/null
OVERLAY="$KIT_DIR/libcurl-disable-optional-zstd.patch"
[[ "$(sha256sum "$OVERLAY" | awk '{print $1}')" == '69ddb473018aa7bc6500350d8dbbda309393c62a3956d2ddad3d8f4f4d07c788' ]] || fail 'CURL_OVERLAY_HASH_MISMATCH'
git -C "$WORKTREE" apply --check "$OVERLAY"
git -C "$WORKTREE" apply "$OVERLAY"
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$PIN" ]] || fail 'WORKTREE_COMMIT_MISMATCH'
python3 "$ROOT/termux-private-package-kit/make-v476/patch_properties.py" \
  "$WORKTREE/scripts/properties.sh" --data-dir "$APP_DATA_DIR" --prefix "$PREFIX"
git -C "$WORKTREE" diff -- scripts/properties.sh > "$OUTPUT_DIR/app-private-properties.patch"
[[ -s "$OUTPUT_DIR/app-private-properties.patch" ]] || fail 'EXPECTED_PROPERTIES_PATCH_NOT_CREATED'
PROPERTIES_PATCH_SHA="$(sha256sum "$OUTPUT_DIR/app-private-properties.patch" | awk '{print $1}')"

cat > "$WORKTREE/.aib-private-layout-preflight.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/builder/termux-packages
source scripts/properties.sh
[[ "\$TERMUX_APP__PACKAGE_NAME" == "$APP_ID" ]]
[[ "\$TERMUX_APP__DATA_DIR" == "$APP_DATA_DIR" ]]
[[ "\$TERMUX__PREFIX" == "$PREFIX" ]]
[[ "\$TERMUX_PREFIX" == "$PREFIX" ]]
printf 'AIB_MODELED_PROPERTY_PATHS_MATCH app=%s prefix=%s\\n' "\$TERMUX_APP__PACKAGE_NAME" "\$TERMUX_PREFIX"
EOF
chmod 700 "$WORKTREE/.aib-private-layout-preflight.sh"
mkdir -p "$WORKTREE/output/.aib-private-curl-debs"
free_bytes="$(df -PB1 "$OUTPUT_DIR" | awk 'END {print $4}')"
[[ "$free_bytes" =~ ^[0-9]+$ ]] || fail 'DISK_SPACE_CHECK_FAILED'
(( free_bytes >= MIN_FREE_BYTES )) || fail 'LESS_THAN_5_GIB_FREE; NO_BUILD_STARTED'
docker info >/dev/null 2>&1 || fail 'DOCKER_DAEMON_UNAVAILABLE'
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail 'PINNED_BUILDER_IMAGE_NOT_PRESENT_LOCALLY; NO_PULL_ATTEMPTED'
export TERMUX_BUILDER_IMAGE_NAME="$IMAGE"
export CONTAINER_NAME="aib-private-curl-v8230-$$"
cleanup_container() { docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1 && docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true; }
trap cleanup_container EXIT
{
  printf 'Pinned source commit: %s\n' "$source_actual"
  printf 'Source recipe closure: 9 exact packages, 12 dependency alternatives\n'
  printf 'Builder image: %s\n' "$IMAGE"
  printf 'Builder image ID: %s\n' "$(docker image inspect --format '{{.Id}}' "$IMAGE")"
  printf 'Modeled AI Builder prefix (not device observed): %s\n' "$PREFIX"
  printf 'Patched properties SHA-256: %s\n' "$PROPERTIES_PATCH_SHA"
  printf 'Build started UTC: %s\n\n=== layout preflight ===\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$OUTPUT_DIR/build.log"
(
  cd "$WORKTREE"
  ./scripts/run-docker.sh bash /home/builder/termux-packages/.aib-private-layout-preflight.sh
) 2>&1 | tee -a "$OUTPUT_DIR/build.log"
(
  cd "$WORKTREE"
  # Upstream buildorder resolves package Depends from this pinned checkout; downloads stay disabled.
  ./scripts/run-docker.sh bash -c 'set -Eeuo pipefail; cd /home/builder/termux-packages; export TERMUX_INSTALL_DEPS=false; ./build-package.sh -a aarch64 --format debian -o /home/builder/termux-packages/output/.aib-private-curl-debs libcurl; printf "PINNED_CONTAINER_OUTPUT_DEBS_BEGIN\n"; find /home/builder/termux-packages/output -type f -name "*.deb" -printf "%P %s bytes\n" | sort; printf "PINNED_CONTAINER_OUTPUT_DEBS_END\n"'
) 2>&1 | tee -a "$OUTPUT_DIR/build.log"
printf 'PINNED_HOST_OUTPUT_DEBS_BEGIN\n' | tee -a "$OUTPUT_DIR/build.log"
find "$WORKTREE/output" -type f -name '*.deb' -printf '%P %s bytes\n' | sort | tee -a "$OUTPUT_DIR/build.log"
printf 'PINNED_HOST_OUTPUT_DEBS_END\n' | tee -a "$OUTPUT_DIR/build.log"

mkdir -p "$OUTPUT_DIR/packages"
python3 - "$WORKTREE/output" "$PACKAGE_SET" "$OUTPUT_DIR/packages" <<'PY'
import hashlib,json,pathlib,shutil,subprocess,sys
build_root=pathlib.Path(sys.argv[1]); manifest=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8')); dest=pathlib.Path(sys.argv[3])
specs={x['name']:x for x in manifest['packages']}; found={}; seen_hashes={}; identical_duplicates=0
debs=sorted(build_root.rglob('*.deb'))
print('PINNED_BUILD_OUTPUT_DISCOVERED_DEBS count={} root={}'.format(len(debs),build_root))
for deb in debs:
    control_text=subprocess.run(['dpkg-deb','-f',str(deb)],capture_output=True,text=True,check=True).stdout
    control={}
    for line in control_text.splitlines():
        if not line or line[0].isspace() or ':' not in line: continue
        key,value=line.split(':',1); control[key.strip()]=value.strip()
    if any(not control.get(key) for key in ('Package','Version','Architecture')):
        raise SystemExit('BUILD_OUTPUT_CONTROL_FIELDS_INVALID:'+deb.name)
    name,version,arch=(control[key] for key in ('Package','Version','Architecture'))
    if name not in specs: continue
    spec=specs[name]
    if (version,arch)!=(spec['version'],spec['architecture']):
        raise SystemExit('PINNED_DEB_IDENTITY_MISMATCH:'+name+':'+version+':'+arch)
    digest=hashlib.sha256(deb.read_bytes()).hexdigest()
    if name in found:
        if seen_hashes[name]!=digest:
            raise SystemExit('DUPLICATE_PINNED_CANDIDATE_DEB_DIFFERENT_BYTES:'+name)
        identical_duplicates+=1
        print('IDENTICAL_DUPLICATE_PINNED_DEB_EXCLUDED:'+name+':'+str(deb.relative_to(build_root)))
        continue
    found[name]=deb; seen_hashes[name]=digest
missing=set(specs)-set(found)
if missing: raise SystemExit('PINNED_DEPENDENCY_DEB_MISSING:'+','.join(sorted(missing)))
for name,deb in sorted(found.items()): shutil.copy2(deb,dest/deb.name)
print('PINNED_CURL_DEB_SET_READY packages={} identical_duplicates_excluded={} extras_in_build_output_excluded=1'.format(len(found),identical_duplicates))
PY
python3 "$KIT_DIR/audit_curl_closure.py" --package-set "$PACKAGE_SET" --packages-dir "$OUTPUT_DIR/packages" --prefix "$PREFIX" --report "$OUTPUT_DIR/audit-report.json" | tee -a "$OUTPUT_DIR/build.log"
python3 - "$OUTPUT_DIR/build-result.json" "$PACKAGE_SET" "$OUTPUT_DIR/audit-report.json" "$IMAGE" "$PIN" "$PREFIX" "$PROPERTIES_PATCH_SHA" <<'PY'
import json,pathlib,sys
out,manifest_path,audit_path,image,pin,prefix,props_sha=map(str,sys.argv[1:])
m=json.loads(pathlib.Path(manifest_path).read_text(encoding='utf-8')); a=json.loads(pathlib.Path(audit_path).read_text(encoding='utf-8'))
r={"schemaVersion":1,"status":"audit-passed; device-runtime-test-not-run","sourceRepository":m['source']['repository'],"sourceCommit":pin,"builderImageRef":image,"restrictedAppArmorProfileSha256":m['source']['restrictedAppArmorProfileSha256'],"builderPropertiesPatchSha256":props_sha,"applicationId":"com.karat.aibuilder","architecture":"aarch64","prefix":prefix,"prefixProvenance":"ci-model-only; device-observation-not-run","sourceClosure":{"profile":"curl-candidate","rootPackages":["curl"],"buildTargetPackage":m['sourceClosure']['buildTargetPackage'],"packageCount":a['sourceClosurePackageCount'],"dependencyAlternativeCount":a['sourceClosureDependencyAlternativeCount'],"buildStrategy":"pinned-termux-buildorder-recursion; dependency-downloads-disabled","directCurlDepends":m['runtimeDependencies']['curlRequires'],"directLibcurlDepends":m['runtimeDependencies']['libcurlRequires'],"excludedRecommendations":m['runtimeDependencies']['recommendationsExcludedFromInstallSimulation']},"packages":a['packages'],"installed":False,"deviceSmokeTest":"NOT RUN","rollback":"NOT RUN"}
pathlib.Path(out).write_text(json.dumps(r,sort_keys=True,indent=2)+'\n',encoding='utf-8')
print('PINNED_CURL_BUILD_RESULT_OK package_count={} device_install=NOT_RUN'.format(len(a['packages'])))
PY
printf 'AUDITED_CURL_CANDIDATE_SET_READY %s\n' "$OUTPUT_DIR/packages"
