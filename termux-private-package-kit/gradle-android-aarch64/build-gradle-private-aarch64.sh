#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ID='com.karat.aibuilder'
readonly KIT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT="$(cd -- "$KIT_DIR/../../.." && pwd)"
readonly MIN_FREE_BYTES=$((3 * 1024 * 1024 * 1024))
readonly REFERENCE_RECIPE_SHA='7daf2cfa39cc2340fb3efbb16099e9e14bb42f08d03db963b8420ce6fd6332bb'
readonly PROPERTIES_SHA='238a19b2f29ef5eed5806a21bee8f5a51bc5031e7db3fcc393d831292300b725'
readonly BUILD_PACKAGE_SHA='5a7e3c1b85a8ddd6b5c197c47d6d384de4b387fa5114a0f679f19d9925f02204'
readonly RUN_DOCKER_SHA='d67b37a9f1142b5f12b5818f312df7b33889158541e74f04524d1378cabf60b2'
readonly POLICY_PATCHER="$ROOT/scripts/apply-candidate-packaging-policy.py"
readonly PROPERTIES_PATCHER="$ROOT/termux-private-package-kit/make-v476/patch_properties.py"
readonly TEMPLATE="$KIT_DIR/build.sh.in"
readonly PACKAGE_AUDITOR="$ROOT/scripts/audit-gradle-android-package.py"

fail() { printf 'ERROR:%s\n' "$*" >&2; exit 2; }
usage() {
  cat <<'EOF'
Usage:
  AIB_TERMUX_APP_DATA_DIR=/data/user/0/com.karat.aibuilder \
  AIB_TERMUX_PREFIX=/data/user/0/com.karat.aibuilder/files/usr \
  AIB_TERMUX_BUILDER_IMAGE_REF=ghcr.io/termux/package-builder@sha256:<64hex> \
  ./build-gradle-private-aarch64.sh /path/to/pinned-termux-packages \
    /path/to/gradle-9.8.2-android-aarch64.zip /path/to/assembly-report.json \
    /path/to/gradle-android-package-candidate-inputs.json /path/to/new-empty-output

Builds one AArch64 .deb in a digest-pinned Termux container and audits it before copying.
The package is not installed. No APT feed is signed/published and no device runtime is claimed.
EOF
}

if [[ "${1:-}" == '-h' || "${1:-}" == '--help' ]]; then usage; exit 0; fi
[[ $# -eq 5 ]] || { usage >&2; fail 'ARGUMENT_COUNT'; }
SOURCE_REPO="$(realpath "$1")"
DIST_ZIP="$(realpath "$2")"
ASSEMBLY_REPORT="$(realpath "$3")"
LOCK="$(realpath "$4")"
OUTPUT_DIR="$(realpath -m "$5")"

: "${AIB_TERMUX_APP_DATA_DIR:?Set the canonical modeled AI Builder app-data path}"
: "${AIB_TERMUX_PREFIX:?Set the matching modeled filesDir/usr path}"
: "${AIB_TERMUX_BUILDER_IMAGE_REF:?Set the digest-pinned Termux builder image}"
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
[[ -f "$DIST_ZIP" && -f "$ASSEMBLY_REPORT" && -f "$LOCK" ]] || fail 'INPUT_FILE_MISSING'
[[ -f "$TEMPLATE" && -f "$POLICY_PATCHER" && -f "$PROPERTIES_PATCHER" && -f "$PACKAGE_AUDITOR" ]] || fail 'PACKAGE_KIT_INPUT_MISSING'

mapfile -t LOCK_VALUES < <(python3 - "$LOCK" "$ASSEMBLY_REPORT" "$DIST_ZIP" <<'PY'
import hashlib, json, pathlib, sys
lock = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
report = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
zip_path = pathlib.Path(sys.argv[3])
def sha(p):
    h=hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda:f.read(1024*1024), b""): h.update(b)
    return h.hexdigest()
assert lock["repository"] == "Argus-94/TERMUX_APP_PACKAGE"
assert lock["branch"] == "work/bootstrap-compatibility-20261019"
assert lock["applicationId"] == "com.karat.aibuilder"
assert lock["package"] == {"name":"gradle", "version":"1:9.8.2", "architecture":"aarch64", "depends":"openjdk-17", "expectedJdk17Version":"17.0.20", "candidateOnly":True}
assert lock["termuxBuilder"]["sourceCommit"] == "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
assert lock["termuxBuilder"]["referenceGradleRecipeSha256"] == "7daf2cfa39cc2340fb3efbb16099e9e14bb42f08d03db963b8420ce6fd6332bb"
assert lock["termuxBuilder"]["supportsLocalFileSource"] is True
assert report["result"] == "ANDROID_GRADLE_DISTRIBUTION_ASSEMBLY_PASS_TEST_CANDIDATE_ONLY"
assert report["gates"]["productionAllowed"] is False and report["gates"]["candidateEligible"] is False
assert report["distribution"]["sha256"] == sha(zip_path)
assert report["distribution"]["filename"] == zip_path.name
print(lock["termuxBuilder"]["sourceCommit"])
print(lock["termuxBuilder"]["builderImage"])
print(lock["target"]["modeledDataDir"])
print(lock["target"]["modeledPrefix"])
print(report["distribution"]["sha256"])
PY
)
[[ ${#LOCK_VALUES[@]} -eq 5 ]] || fail 'LOCK_VALIDATION_OUTPUT_MISMATCH'
readonly PIN="${LOCK_VALUES[0]}"
readonly LOCKED_BUILDER_REF="${LOCK_VALUES[1]}"
readonly LOCKED_DATA_DIR="${LOCK_VALUES[2]}"
readonly LOCKED_PREFIX="${LOCK_VALUES[3]}"
readonly DIST_SHA="${LOCK_VALUES[4]}"
[[ "$PIN" == "$(git -C "$SOURCE_REPO" rev-parse HEAD)" ]] || fail 'TERMUX_SOURCE_COMMIT_MISMATCH'
[[ -z "$(git -C "$SOURCE_REPO" status --porcelain=v1)" ]] || fail 'TERMUX_SOURCE_CHECKOUT_NOT_CLEAN'
[[ "$AIB_TERMUX_BUILDER_IMAGE_REF" == "$LOCKED_BUILDER_REF" ]] || fail 'BUILDER_IMAGE_DIFFERS_FROM_LOCK'
[[ "$APP_DATA_DIR" == "$LOCKED_DATA_DIR" && "$PREFIX" == "$LOCKED_PREFIX" ]] || fail 'APP_PRIVATE_LAYOUT_DIFFERS_FROM_LOCK'
[[ "$DIST_SHA" =~ ^[a-f0-9]{64}$ ]] || fail 'DISTRIBUTION_SHA256_INVALID'
[[ -x "$SOURCE_REPO/build-package.sh" ]] || fail 'TERMUX_BUILD_PACKAGE_ENTRYPOINT_MISSING'

if [[ -e "$OUTPUT_DIR" ]]; then
  [[ -d "$OUTPUT_DIR" ]] || fail 'OUTPUT_PATH_EXISTS_NOT_DIRECTORY'
  [[ -z "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'OUTPUT_DIRECTORY_MUST_BE_NEW_OR_EMPTY'
else
  mkdir -p -- "$OUTPUT_DIR"
fi
case "$OUTPUT_DIR/" in "$SOURCE_REPO/"*) fail 'OUTPUT_MUST_NOT_BE_INSIDE_SOURCE_CHECKOUT';; esac
available_bytes="$(df -PB1 "$OUTPUT_DIR" | awk 'END {print $4}')"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || fail 'DISK_SPACE_CHECK_FAILED'
(( available_bytes >= MIN_FREE_BYTES )) || fail 'LESS_THAN_3_GIB_FREE; NO_BUILD_STARTED'

docker info >/dev/null 2>&1 || fail 'DOCKER_DAEMON_UNAVAILABLE'
docker image inspect "$AIB_TERMUX_BUILDER_IMAGE_REF" >/dev/null 2>&1 || fail 'PINNED_BUILDER_IMAGE_NOT_PRESENT_LOCALLY; NO_PULL_ATTEMPTED'

check_git_blob() {
  local path="$1" expected="$2" actual
  actual="$(git -C "$SOURCE_REPO" show "$PIN:$path" | sha256sum | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fail "LOCKED_TERMUX_SOURCE_HASH_MISMATCH:$path"
}
check_git_blob 'packages/gradle/build.sh' "$REFERENCE_RECIPE_SHA"
check_git_blob 'scripts/properties.sh' "$PROPERTIES_SHA"
check_git_blob 'build-package.sh' "$BUILD_PACKAGE_SHA"
check_git_blob 'scripts/run-docker.sh' "$RUN_DOCKER_SHA"

mkdir -p "$OUTPUT_DIR/work"
WORKTREE="$OUTPUT_DIR/work/termux-packages"
git clone --shared --dissociate --no-checkout "$SOURCE_REPO" "$WORKTREE"
git -C "$WORKTREE" checkout --detach "$PIN"
python3 "$POLICY_PATCHER" --source-root "$WORKTREE"
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$PIN" ]] || fail 'WORKTREE_COMMIT_MISMATCH'
python3 "$PROPERTIES_PATCHER" "$WORKTREE/scripts/properties.sh" --data-dir "$APP_DATA_DIR" --prefix "$PREFIX"

DIST_NAME='gradle-9.8.2-android-aarch64.zip'
cp -- "$DIST_ZIP" "$WORKTREE/$DIST_NAME"
[[ "$(sha256sum "$WORKTREE/$DIST_NAME" | awk '{print $1}')" == "$DIST_SHA" ]] || fail 'STAGED_DISTRIBUTION_SHA256_MISMATCH'
python3 - "$TEMPLATE" "$WORKTREE/packages/gradle/build.sh" "$DIST_SHA" <<'PY'
import pathlib, sys
source, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
text = source.read_text(encoding="utf-8")
needle = "@AIB_GRADLE_PACKAGE_INPUT_SHA256@"
assert text.count(needle) == 1
text = text.replace(needle, sys.argv[3])
target.write_text(text, encoding="utf-8")
PY

mkdir -p "$OUTPUT_DIR/packages" "$WORKTREE/output/.aib-private-gradle-debs"
python3 "$POLICY_PATCHER" --source-root "$WORKTREE" --verify-only
git -C "$WORKTREE" diff --check
git -C "$WORKTREE" diff -- scripts/properties.sh packages/gradle/build.sh > "$OUTPUT_DIR/app-private-gradle-recipe.patch"
[[ -s "$OUTPUT_DIR/app-private-gradle-recipe.patch" ]] || fail 'EXPECTED_PRIVATE_PATCH_NOT_CREATED'

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

export TERMUX_BUILDER_IMAGE_NAME="$AIB_TERMUX_BUILDER_IMAGE_REF"
export CONTAINER_NAME="aib-private-gradle-982-$$"
cleanup_container() {
  if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup_container EXIT
{
  printf 'Termux source commit: %s\n' "$PIN"
  printf 'Application ID: %s\n' "$APP_ID"
  printf 'Modeled app-private prefix (not device-observed): %s\n' "$PREFIX"
  printf 'Builder image ref: %s\n' "$AIB_TERMUX_BUILDER_IMAGE_REF"
  printf 'Builder image ID: %s\n' "$(docker image inspect --format '{{.Id}}' "$AIB_TERMUX_BUILDER_IMAGE_REF")"
  printf 'Android-specific Gradle ZIP SHA-256: %s\n' "$DIST_SHA"
  printf 'Build started UTC: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '\n=== app-private layout preflight ===\n'
} | tee "$OUTPUT_DIR/build.log"
(
  cd "$WORKTREE"
  ./scripts/run-docker.sh bash /home/builder/termux-packages/.aib-private-layout-preflight.sh
) 2>&1 | tee -a "$OUTPUT_DIR/build.log"
(
  cd "$WORKTREE"
  ./scripts/run-docker.sh bash -c 'set -Eeuo pipefail; cd /home/builder/termux-packages; ./build-package.sh -a aarch64 -o /home/builder/termux-packages/output/.aib-private-gradle-debs gradle'
) 2>&1 | tee -a "$OUTPUT_DIR/build.log"

mapfile -t DEBS < <(find "$WORKTREE/output/.aib-private-gradle-debs" -maxdepth 1 -type f -name 'gradle_*_aarch64.deb' -print | sort)
((${#DEBS[@]} == 1)) || fail 'EXPECTED_EXACTLY_ONE_GRADLE_AARCH64_DEB'
python3 "$PACKAGE_AUDITOR" --input-lock "$LOCK" --distribution-zip "$DIST_ZIP" --assembly-report "$ASSEMBLY_REPORT" --deb "${DEBS[0]}" --prefix "$PREFIX" --report "$OUTPUT_DIR/audit-report.json" | tee -a "$OUTPUT_DIR/build.log"
cp -- "${DEBS[0]}" "$OUTPUT_DIR/packages/"
sha256sum "$OUTPUT_DIR/packages/$(basename "${DEBS[0]}")" > "$OUTPUT_DIR/package-SHA256SUMS"

python3 - "$OUTPUT_DIR/build-result.json" "$AIB_TERMUX_BUILDER_IMAGE_REF" "$PIN" "$PREFIX" "$DIST_SHA" "$OUTPUT_DIR/packages/$(basename "${DEBS[0]}")" "$REFERENCE_RECIPE_SHA" <<'PY'
import hashlib,json,pathlib,sys
out=pathlib.Path(sys.argv[1]); image,revision,prefix,dist_sha,deb,recipe_sha=sys.argv[2:]
p=pathlib.Path(deb)
record={"schemaVersion":1,"status":"package-built-and-static-audits-passed-test-only","sourceCommit":revision,"builderImageRef":image,"referenceGradleRecipeSha256":recipe_sha,"androidDistributionSha256":dist_sha,"applicationId":"com.karat.aibuilder","prefix":prefix,"prefixProvenance":"ci-model-only; device-observation-not-run","packageFile":p.name,"packageSha256":hashlib.sha256(p.read_bytes()).hexdigest(),"installed":False,"aptSimulation":"NOT_RUN","deviceSmokeTest":"NOT RUN","candidateEligible":False,"qualified":False,"productionAllowed":False}
out.write_text(json.dumps(record,indent=2,sort_keys=True)+"\n")
PY
printf 'AUDITED_PACKAGE_READY %s\n' "$OUTPUT_DIR/packages/$(basename "${DEBS[0]}")"
