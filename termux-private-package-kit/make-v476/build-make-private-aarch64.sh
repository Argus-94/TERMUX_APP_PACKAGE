#!/usr/bin/env bash
set -Eeuo pipefail

readonly PIN='505e06ef0c8dbd7611abfb90e9eb60826dcd01d7'
readonly APP_ID='com.karat.aibuilder'
readonly MIN_FREE_BYTES=$((3 * 1024 * 1024 * 1024))
readonly KIT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

fail() { printf 'ERROR:%s\n' "$*" >&2; exit 2; }
usage() {
  cat <<'EOF'
Usage:
  AIB_TERMUX_APP_DATA_DIR=<canonical-app-data-dir> \
  AIB_TERMUX_PREFIX=<validated-filesDir/usr> \
  AIB_TERMUX_BUILDER_IMAGE_REF=ghcr.io/termux/package-builder@sha256:<64hex> \
  ./build-make-private-aarch64.sh /path/to/pinned-termux-packages /path/to/new-empty-output

No package is installed. A successful .deb is copied only after audit_deb.py passes.
EOF
}

if [[ "${1:-}" == '-h' || "${1:-}" == '--help' ]]; then usage; exit 0; fi
[[ $# -eq 2 ]] || { usage >&2; fail 'ARGUMENT_COUNT'; }
SOURCE_REPO="$(realpath "$1")"
OUTPUT_DIR="$(realpath -m "$2")"

: "${AIB_TERMUX_APP_DATA_DIR:?Set this from the installed AI Builder runtime; do not guess}"
: "${AIB_TERMUX_PREFIX:?Set this from the validated embedded runtime layout; do not guess}"
: "${AIB_TERMUX_BUILDER_IMAGE_REF:?Use a digest-pinned builder image reference}"

APP_DATA_DIR="${AIB_TERMUX_APP_DATA_DIR%/}"
PREFIX="${AIB_TERMUX_PREFIX%/}"
[[ "$APP_DATA_DIR" =~ ^/data/(data|user/0)/com\.karat\.aibuilder$ ]] || fail 'APP_DATA_DIR_NOT_CANONICAL_AI_BUILDER'
[[ "$PREFIX" == "$APP_DATA_DIR/files/usr" ]] || fail 'PREFIX_MISMATCH_EXPECTED_CANONICAL_FILESDIR_USR'
[[ "$AIB_TERMUX_BUILDER_IMAGE_REF" =~ ^ghcr\.io/termux/package-builder@sha256:[a-f0-9]{64}$ ]] || fail 'BUILDER_IMAGE_MUST_USE_GHCR_SHA256_DIGEST'

command -v git >/dev/null || fail 'GIT_REQUIRED'
command -v docker >/dev/null || fail 'DOCKER_REQUIRED'
command -v dpkg-deb >/dev/null || fail 'DPKG_DEB_REQUIRED'
command -v readelf >/dev/null || fail 'READELF_REQUIRED'
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

available_bytes="$(df -PB1 "$OUTPUT_DIR" | awk 'END {print $4}')"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || fail 'DISK_SPACE_CHECK_FAILED'
(( available_bytes >= MIN_FREE_BYTES )) || fail 'LESS_THAN_3_GIB_FREE; NO_BUILD_STARTED'

docker info >/dev/null 2>&1 || fail 'DOCKER_DAEMON_UNAVAILABLE'
docker image inspect "$AIB_TERMUX_BUILDER_IMAGE_REF" >/dev/null 2>&1 || fail 'PINNED_BUILDER_IMAGE_NOT_PRESENT_LOCALLY; NO_PULL_ATTEMPTED'

check_git_blob() {
  local path="$1" expected="$2" actual
  actual="$(git -C "$SOURCE_REPO" show "$PIN:$path" | sha256sum | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fail "LOCKED_SOURCE_HASH_MISMATCH:$path"
}
check_git_blob 'packages/make/build.sh' '8a55794717f4ea018324b1bbb8f2dfd549dd054152798c913a40d49f4baf432c'
check_git_blob 'packages/make/src-job.c.patch' '87ef62d072c2def6e0778e71283fb32d7bc4f00dadadd52eca822bf444a4dc10'
check_git_blob 'scripts/properties.sh' '238a19b2f29ef5eed5806a21bee8f5a51bc5031e7db3fcc393d831292300b725'
check_git_blob 'build-package.sh' '5a7e3c1b85a8ddd6b5c197c47d6d384de4b387fa5114a0f679f19d9925f02204'
check_git_blob 'scripts/run-docker.sh' 'd67b37a9f1142b5f12b5818f312df7b33889158541e74f04524d1378cabf60b2'

mkdir -p "$OUTPUT_DIR/work"
WORKTREE="$OUTPUT_DIR/work/termux-packages"
git clone --shared --dissociate --no-checkout "$SOURCE_REPO" "$WORKTREE"
git -C "$WORKTREE" checkout --detach "$PIN"
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$PIN" ]] || fail 'WORKTREE_COMMIT_MISMATCH'

python3 "$KIT_DIR/patch_properties.py" "$WORKTREE/scripts/properties.sh" --data-dir "$APP_DATA_DIR" --prefix "$PREFIX"
git -C "$WORKTREE" diff -- scripts/properties.sh > "$OUTPUT_DIR/app-private-properties.patch"
[[ -s "$OUTPUT_DIR/app-private-properties.patch" ]] || fail 'EXPECTED_PROPERTIES_PATCH_NOT_CREATED'

cat > "$WORKTREE/.aib-private-layout-preflight.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/builder/termux-packages
source scripts/properties.sh
[[ "\$TERMUX_APP__PACKAGE_NAME" == "$APP_ID" ]]
[[ "\$TERMUX_APP__DATA_DIR" == "$APP_DATA_DIR" ]]
[[ "\$TERMUX__PREFIX" == "$PREFIX" ]]
[[ "\$TERMUX_PREFIX" == "$PREFIX" ]]
printf 'AIB_TARGET_LAYOUT_OK app=%s prefix=%s\\n' "\$TERMUX_APP__PACKAGE_NAME" "\$TERMUX_PREFIX"
EOF
chmod 700 "$WORKTREE/.aib-private-layout-preflight.sh"

export TERMUX_BUILDER_IMAGE_NAME="$AIB_TERMUX_BUILDER_IMAGE_REF"
export CONTAINER_NAME="aib-private-make-v476-$$"
{
  printf 'Source commit: %s\n' "$PIN"
  printf 'App ID: %s\n' "$APP_ID"
  printf 'Validated private prefix: %s\n' "$PREFIX"
  printf 'Builder image ref: %s\n' "$AIB_TERMUX_BUILDER_IMAGE_REF"
  printf 'Builder image ID: %s\n' "$(docker image inspect --format '{{.Id}}' "$AIB_TERMUX_BUILDER_IMAGE_REF")"
  printf 'Build started UTC: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '\n=== private-layout preflight ===\n'
} | tee "$OUTPUT_DIR/build.log"

(
  cd "$WORKTREE"
  ./scripts/run-docker.sh bash /home/builder/termux-packages/.aib-private-layout-preflight.sh
) 2>&1 | tee -a "$OUTPUT_DIR/build.log"

(
  cd "$WORKTREE"
  ./scripts/run-docker.sh bash -c 'set -Eeuo pipefail; cd /home/builder/termux-packages; export TERMUX_TOPDIR=/home/builder/termux-packages/.aib-private-make-build-cache; ./build-package.sh -a aarch64 -o /home/builder/termux-packages/.aib-private-make-debs make'
) 2>&1 | tee -a "$OUTPUT_DIR/build.log"

mapfile -t DEBS < <(find "$WORKTREE/.aib-private-make-debs" -maxdepth 1 -type f -name 'make_*_aarch64.deb' -print | sort)
((${#DEBS[@]} == 1)) || fail 'EXPECTED_EXACTLY_ONE_MAKE_AARCH64_DEB'

mkdir -p "$OUTPUT_DIR/packages"
python3 "$KIT_DIR/audit_deb.py" --manifest "$KIT_DIR/manifest.json" --deb "${DEBS[0]}" --prefix "$PREFIX" --report "$OUTPUT_DIR/audit-report.json" | tee -a "$OUTPUT_DIR/build.log"
cp -- "${DEBS[0]}" "$OUTPUT_DIR/packages/"
sha256sum "$OUTPUT_DIR/packages/$(basename "${DEBS[0]}")" > "$OUTPUT_DIR/packages/SHA256SUMS"
python3 - "$OUTPUT_DIR/build-result.json" "$AIB_TERMUX_BUILDER_IMAGE_REF" "$PIN" "$PREFIX" "${DEBS[0]}" <<'PY'
import hashlib,json,pathlib,sys
out=pathlib.Path(sys.argv[1]); image,revision,prefix,deb=sys.argv[2:]
p=pathlib.Path(deb)
record={"schemaVersion":1,"status":"audit-passed; device-runtime-test-not-run","sourceCommit":revision,"builderImageRef":image,"applicationId":"com.karat.aibuilder","prefix":prefix,"packageFile":p.name,"packageSha256":hashlib.sha256(p.read_bytes()).hexdigest(),"installed":False,"deviceSmokeTest":"NOT RUN"}
out.write_text(json.dumps(record,indent=2)+"\n")
PY
printf 'AUDITED_PACKAGE_READY %s\n' "$OUTPUT_DIR/packages/$(basename "${DEBS[0]}")"
