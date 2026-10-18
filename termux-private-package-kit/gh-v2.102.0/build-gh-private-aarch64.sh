#!/usr/bin/env bash
set -Eeuo pipefail

readonly PIN='505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
readonly APP_ID='com.karat.aibuilder'
readonly MIN_FREE_BYTES=$((3 * 1024 * 1024 * 1024))
readonly ROOT="$(cd -- "$KIT_DIR/../.." && pwd)"
readonly KIT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly AUDITOR="$KIT_DIR/audit_deb.py"

fail() { printf 'ERROR:%s\n' "$*" >&2; exit 2; }
usage() {
  cat <<'EOF'
Usage:
  AIB_TERMUX_APP_DATA_DIR=<canonical-app-data-dir> \
  AIB_TERMUX_PREFIX=<matching-filesDir/usr> \
  AIB_TERMUX_BUILDER_IMAGE_REF=ghcr.io/termux/package-builder@sha256:<64hex> \
  ./build-gh-private-aarch64.sh /path/to/pinned-termux-packages /path/to/gh-candidate-package-set.json /path/to/new-empty-output

This builds only the pinned gh candidate in the official isolated Termux container, audits it, and never installs or publishes it.
EOF
}

if [[ "${1:-}" == '-h' || "${1:-}" == '--help' ]]; then usage; exit 0; fi
[[ $# -eq 3 ]] || { usage >&2; fail 'ARGUMENT_COUNT'; }
SOURCE_REPO="$(realpath "$1")"
PACKAGE_SET="$(realpath "$2")"
OUTPUT_DIR="$(realpath -m "$3")"

: "${AIB_TERMUX_APP_DATA_DIR:?Set the canonical modeled app-data path}"
: "${AIB_TERMUX_PREFIX:?Set the matching modeled filesDir/usr path}"
: "${AIB_TERMUX_BUILDER_IMAGE_REF:?Use the digest-pinned official builder image}"
APP_DATA_DIR="${AIB_TERMUX_APP_DATA_DIR%/}"
PREFIX="${AIB_TERMUX_PREFIX%/}"
[[ "$APP_DATA_DIR" =~ ^/data/(data|user/0)/com\.karat\.aibuilder$ ]] || fail 'APP_DATA_DIR_NOT_CANONICAL_AI_BUILDER'
[[ "$PREFIX" == "$APP_DATA_DIR/files/usr" ]] || fail 'PREFIX_MISMATCH_EXPECTED_CANONICAL_FILESDIR_USR'
[[ "$AIB_TERMUX_BUILDER_IMAGE_REF" == 'ghcr.io/termux/package-builder@sha256:44999857244619e25bc8e3427904a16d36cc0c0e087704af039e5bdf94814ac9' ]] || fail 'BUILDER_IMAGE_NOT_ALLOWLISTED'

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
assert m['target']['applicationId']=='com.karat.aibuilder'
assert m['target']['architecture']=='aarch64'
assert m['target']['modeledPrefix']=='/data/user/0/com.karat.aibuilder/files/usr'
p=m['packages']; assert len(p)==1
x=p[0]
assert (x['name'],x['version'],x['architecture'])==('gh','2.102.0','aarch64')
assert x['sourceCommit']=='505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
assert x['recipePath']=='packages/gh/build.sh'
assert x['recipeSha256']=='a26022905b66f39851553abea3b5e68c38671988b4e2a9a649366845dadfb266'
assert x['sourceSha256']=='08bf0ef8b4409893889175e0f5279d30d6edd96465816042c0d7c72eac598158'
assert x['sourceLicenseSha256']=='6da4adc42392c8485e40b4251c7e332fc3352df1947c9ffade71dd60b14a7a4f'
assert x['runtimeDependenciesExpected']==[] and x['recommendationsExpected']==['openssh']
assert m['releaseGate']['publicationAllowed'] is False
assert m['releaseGate']['deviceInstall']=='NOT_RUN' and m['releaseGate']['rollback']=='NOT_RUN'
PY

check_git_blob() {
  local path="$1" expected="$2" actual
  actual="$(git -C "$SOURCE_REPO" show "$PIN:$path" | sha256sum | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fail "LOCKED_SOURCE_HASH_MISMATCH:$path"
}
check_git_blob 'packages/gh/build.sh' 'a26022905b66f39851553abea3b5e68c38671988b4e2a9a649366845dadfb266'
check_git_blob 'scripts/properties.sh' '238a19b2f29ef5eed5806a21bee8f5a51bc5031e7db3fcc393d831292300b725'
check_git_blob 'build-package.sh' '5a7e3c1b85a8ddd6b5c197c47d6d384de4b387fa5114a0f679f19d9925f02204'
check_git_blob 'scripts/run-docker.sh' 'd67b37a9f1142b5f12b5818f312df7b33889158541e74f04524d1378cabf60b2'

mkdir -p "$OUTPUT_DIR/work"
WORKTREE="$OUTPUT_DIR/work/termux-packages"
git clone --shared --dissociate --no-checkout "$SOURCE_REPO" "$WORKTREE"
git -C "$WORKTREE" checkout --detach "$PIN"
python3 "$ROOT/scripts/apply-candidate-packaging-policy.py" --source-root "$WORKTREE"
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$PIN" ]] || fail 'WORKTREE_COMMIT_MISMATCH'
python3 "$KIT_DIR/../make-v476/patch_properties.py" "$WORKTREE/scripts/properties.sh" --data-dir "$APP_DATA_DIR" --prefix "$PREFIX"
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

available_bytes="$(df -PB1 "$OUTPUT_DIR" | awk 'END {print $4}')"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || fail 'DISK_SPACE_CHECK_FAILED'
(( available_bytes >= MIN_FREE_BYTES )) || fail 'LESS_THAN_3_GIB_FREE; NO_BUILD_STARTED'
docker info >/dev/null 2>&1 || fail 'DOCKER_DAEMON_UNAVAILABLE'
docker image inspect "$AIB_TERMUX_BUILDER_IMAGE_REF" >/dev/null 2>&1 || fail 'PINNED_BUILDER_IMAGE_NOT_PRESENT_LOCALLY; NO_PULL_ATTEMPTED'

export TERMUX_BUILDER_IMAGE_NAME="$AIB_TERMUX_BUILDER_IMAGE_REF"
export CONTAINER_NAME="aib-private-gh-v2102-$$"
cleanup_container() {
  if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup_container EXIT
{
  printf 'Source commit: %s\n' "$PIN"
  printf 'Recipe SHA-256: %s\n' 'a26022905b66f39851553abea3b5e68c38671988b4e2a9a649366845dadfb266'
  printf 'Source archive SHA-256: %s\n' '08bf0ef8b4409893889175e0f5279d30d6edd96465816042c0d7c72eac598158'
  printf 'MIT license SHA-256: %s\n' '6da4adc42392c8485e40b4251c7e332fc3352df1947c9ffade71dd60b14a7a4f'
  printf 'App ID: %s\n' "$APP_ID"
  printf 'CI modeled target prefix (not device-observed): %s\n' "$PREFIX"
  printf 'Builder image ref: %s\n' "$AIB_TERMUX_BUILDER_IMAGE_REF"
  printf 'Builder image ID: %s\n' "$(docker image inspect --format '{{.Id}}' "$AIB_TERMUX_BUILDER_IMAGE_REF")"
  printf 'Properties patch SHA-256: %s\n' "$PROPERTIES_PATCH_SHA"
  printf 'Build started UTC: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '\n=== private-layout preflight ===\n'
} | tee "$OUTPUT_DIR/build.log"
(
  cd "$WORKTREE"
  ./scripts/run-docker.sh bash /home/builder/termux-packages/.aib-private-layout-preflight.sh
) 2>&1 | tee -a "$OUTPUT_DIR/build.log"
(
  cd "$WORKTREE"
  # Do not override TERMUX_TOPDIR; the pinned AppArmor profile only permits package output below output/.
  ./scripts/run-docker.sh bash -c 'set -Eeuo pipefail; cd /home/builder/termux-packages; ./build-package.sh -a aarch64 -o /home/builder/termux-packages/output/.aib-private-gh-debs gh'
) 2>&1 | tee -a "$OUTPUT_DIR/build.log"

mapfile -t DEBS < <(find "$WORKTREE/output/.aib-private-gh-debs" -maxdepth 1 -type f -name 'gh_*_aarch64.deb' -print | sort)
((${#DEBS[@]} == 1)) || fail 'EXPECTED_EXACTLY_ONE_GH_AARCH64_DEB'
mkdir -p "$OUTPUT_DIR/packages"
python3 "$AUDITOR" --package-set "$PACKAGE_SET" --deb "${DEBS[0]}" --prefix "$PREFIX" --report "$OUTPUT_DIR/audit-report.json" | tee -a "$OUTPUT_DIR/build.log"
cp -- "${DEBS[0]}" "$OUTPUT_DIR/packages/"
sha256sum "$OUTPUT_DIR/packages/$(basename "${DEBS[0]}")" > "$OUTPUT_DIR/packages/SHA256SUMS"
python3 - "$OUTPUT_DIR/build-result.json" "$PACKAGE_SET" "$AIB_TERMUX_BUILDER_IMAGE_REF" "$PIN" "$PREFIX" "$PROPERTIES_PATCH_SHA" "$OUTPUT_DIR/packages/$(basename "${DEBS[0]}")" <<'PY'
import hashlib,json,pathlib,sys
out=pathlib.Path(sys.argv[1]); manifest=pathlib.Path(sys.argv[2]); image,revision,prefix,properties_sha,deb=sys.argv[3:]
m=json.loads(manifest.read_text(encoding='utf-8')); p=m['packages'][0]; f=pathlib.Path(deb)
r={"schemaVersion":1,"status":"audit-passed; device-runtime-test-not-run","sourceRepository":p['sourceRepository'],"sourceCommit":revision,"recipePath":p['recipePath'],"recipeSha256":p['recipeSha256'],"sourceUrl":p['sourceUrl'],"sourceSha256":p['sourceSha256'],"sourceLicenseFile":p['sourceLicenseFile'],"sourceLicenseRelativePath":p['sourceLicenseRelativePath'],"sourceLicenseSha256":p['sourceLicenseSha256'],"builderImageRef":image,"builderPropertiesPatchSha256":properties_sha,"applicationId":"com.karat.aibuilder","architecture":"aarch64","prefix":prefix,"prefixProvenance":"ci-model-only; device-observation-not-run","packageName":p['name'],"packageVersion":p['version'],"packageArchitecture":p['architecture'],"packageFile":f.name,"packageSha256":hashlib.sha256(f.read_bytes()).hexdigest(),"sourceClosure":{"profile":"builder-cli","rootPackages":["gh"],"packageCount":1,"requiredDependencyAlternativeCount":0,"recommendationsExcluded":["openssh"]},"installed":False,"deviceSmokeTest":"NOT RUN"}
out.write_text(json.dumps(r,sort_keys=True,indent=2)+"\n",encoding="utf-8")
PY
printf 'AUDITED_PACKAGE_READY %s\n' "$OUTPUT_DIR/packages/$(basename "${DEBS[0]}")"
