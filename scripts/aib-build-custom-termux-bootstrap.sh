#!/usr/bin/env bash
# Build a Termux bootstrap for AI Builder's own application namespace.
# Requires a prepared termux-packages checkout and its supported Docker toolchain.
set -Eeuo pipefail

APP_ID='com.karat.aibuilder'
ARCH="${AIB_TERMUX_ARCH:-aarch64}"
TERMUX_PACKAGES_DIR="${1:-}"
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${AIB_BOOTSTRAP_OUTPUT_DIR:-$PROJECT_ROOT/artifacts/termux-bootstrap}"
# Resolve a caller-supplied relative path before changing into the upstream checkout.
if [[ "$OUTPUT_DIR" != /* ]]; then OUTPUT_DIR="$PROJECT_ROOT/$OUTPUT_DIR"; fi

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }
[[ -n "$TERMUX_PACKAGES_DIR" ]] || fail "Usage: $0 /path/to/termux-packages [AIB_TERMUX_ARCH=aarch64]"
[[ -d "$TERMUX_PACKAGES_DIR/.git" ]] || fail "Not a termux-packages git checkout: $TERMUX_PACKAGES_DIR"
[[ "$ARCH" =~ ^(aarch64|arm|i686|x86_64)$ ]] || fail "Unsupported Termux architecture: $ARCH"

PROPERTIES="$TERMUX_PACKAGES_DIR/scripts/properties.sh"
BUILDER="$TERMUX_PACKAGES_DIR/scripts/build-bootstraps.sh"
[[ -f "$PROPERTIES" ]] || fail "Missing scripts/properties.sh"
[[ -f "$BUILDER" ]] || fail "Missing scripts/build-bootstraps.sh"

# Current upstream uses TERMUX_APP__PACKAGE_NAME. The deprecated alias alone
# is insufficient: paths and package metadata derive from the double-underscore name.
if ! grep -E '^[[:space:]]*TERMUX_APP__PACKAGE_NAME[[:space:]]*=' "$PROPERTIES" | grep -Fq "$APP_ID"; then
  fail "TERMUX_APP__PACKAGE_NAME must be explicitly configured as $APP_ID in scripts/properties.sh. Changing only deprecated TERMUX_APP_PACKAGE is insufficient. Official com.termux package artifacts are incompatible. See docs/termux-integration/CUSTOM_BOOTSTRAP_BUILD_RU.md"
fi

node "$PROJECT_ROOT/scripts/aib-termux-bootstrap-preflight.mjs" "$TERMUX_PACKAGES_DIR" "$APP_ID" "$ARCH"

BUILD_STARTED_AT=$(date +%s.%N)
SOURCE_COMMIT=$(git -C "$TERMUX_PACKAGES_DIR" rev-parse HEAD)
SOURCE_BRANCH=$(git -C "$TERMUX_PACKAGES_DIR" branch --show-current)
SOURCE_DIR=$(cd "$TERMUX_PACKAGES_DIR" && pwd)
mkdir -p "$OUTPUT_DIR"
BUILD_LOG="$OUTPUT_DIR/build-$ARCH-$(date -u +%Y%m%dT%H%M%SZ).log"
printf 'Build log: %s\n' "$BUILD_LOG"
printf 'Building custom bootstrap for app=%s arch=%s\n' "$APP_ID" "$ARCH"
printf 'Output directory: %s\n' "$OUTPUT_DIR"
printf 'Source checkout: %s\n' "$(cd "$TERMUX_PACKAGES_DIR" && pwd)"
cd "$TERMUX_PACKAGES_DIR"
# Package namespace changes affect package paths and compiled binaries. Force a clean rebuild.
./scripts/run-docker.sh ./clean.sh 2>&1 | tee "$BUILD_LOG"
./scripts/run-docker.sh ./scripts/build-bootstraps.sh --architectures "$ARCH" 2>&1 | tee -a "$BUILD_LOG"

# Do not guess the generated filename or claim success unless a ZIP exists and has shell entrypoint.
mapfile -t CANDIDATES < <(find . -maxdepth 3 -type f -iname '*bootstrap*.zip' -newermt "@$BUILD_STARTED_AT" -printf '%p\n' | sort)
((${#CANDIDATES[@]} > 0)) || fail "Build command returned without a bootstrap ZIP; inspect build logs and toolchain branch."
FOUND=0
for archive in "${CANDIDATES[@]}"; do
  if unzip -t "$archive" >/dev/null 2>&1 && unzip -Z1 "$archive" | sed 's#^\./##' | grep -Fxq 'bin/bash'; then
    DEST="$OUTPUT_DIR/termux-bootstrap-$ARCH.zip"
    cp -- "$archive" "$DEST.tmp"
    mv -- "$DEST.tmp" "$DEST"
    printf '\nVerified archive: %s\n' "$DEST"
    sha256sum "$DEST" | tee "$DEST.sha256"
    ARCHIVE_SHA256=$(sha256sum "$DEST" | awk '{print $1}')
    BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    PROVENANCE="$DEST.provenance.json"
    printf '{\n  \"schemaVersion\": 1,\n  \"applicationId\": \"%s\",\n  \"architecture\": \"%s\",\n  \"bootstrapVersion\": \"custom-unreleased\",\n  \"archiveFile\": \"%s\",\n  \"archiveSha256\": \"%s\",\n  \"sourceRepository\": \"%s\",\n  \"sourceBranch\": \"%s\",\n  \"sourceCommit\": \"%s\",\n  \"builtAtUtc\": \"%s\",\n  \"archiveStructureVerified\": true,\n  \"runtimeVerified\": false,\n  \"apkIntegrated\": false\n}\n' \
      "$APP_ID" "$ARCH" "$(basename "$DEST")" "$ARCHIVE_SHA256" "$SOURCE_DIR" "$SOURCE_BRANCH" "$SOURCE_COMMIT" "$BUILT_AT" > "$PROVENANCE.tmp"
    mv -- "$PROVENANCE.tmp" "$PROVENANCE"
    printf 'Provenance manifest: %s\n' "$PROVENANCE"
    printf 'NOTE: structure only; runtime compatibility and APK integration remain unverified.\n'
    FOUND=1
  fi
done
((FOUND == 1)) || fail "No generated bootstrap ZIP passed ZIP integrity and prefix-root bin/bash checks."
