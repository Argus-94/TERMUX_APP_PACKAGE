#!/data/data/com.karat.aibuilder/files/usr/bin/bash
# Embedded runtime only: refuse foreign or missing process environment before any I/O.
case "${PREFIX:-}:${HOME:-}" in
  /data/data/com.karat.aibuilder/files/usr:/data/data/com.karat.aibuilder/files/home|/data/user/0/com.karat.aibuilder/files/usr:/data/user/0/com.karat.aibuilder/files/home) ;;
  *) echo AIB_PRIVATE_RUNTIME_REQUIRED >&2; exit 78 ;;
esac
# Private package-feed qualification is still pending; never fall back to stock feeds.
pkg() { echo AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED >&2; return 78; }
set -euo pipefail

AIB_PRIVATE_ROOT="${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}"
AIB_ALLOWED_ROOT="/storage/emulated/0/AIBuilderTermux"
PROJ=$(cat "$AIB_PRIVATE_ROOT/work/proj_path" 2>/dev/null || true)
ROOT="${PROJ:-}"

[ -d "$AIB_ALLOWED_ROOT" ] || { echo AIB_PROJECT_ROOT_MISSING >&2; exit 1; }
[ -n "$ROOT" ] && [ -d "$ROOT" ] && [ ! -L "$ROOT" ] || { echo AIB_PROJECT_ROOT_INVALID >&2; exit 1; }
ROOT_CANON=$(CDPATH= cd -- "$ROOT" && pwd -P) || { echo AIB_PROJECT_ROOT_UNAVAILABLE >&2; exit 1; }
ALLOWED_CANON=$(CDPATH= cd -- "$AIB_ALLOWED_ROOT" && pwd -P) || { echo AIB_PROJECT_ROOT_MISSING >&2; exit 1; }
case "$ROOT_CANON" in
  "$ALLOWED_CANON"/*) ;;
  *) echo PROJECT_OUTSIDE_ALLOWED_ROOT >&2; exit 1 ;;
esac
cd -- "$ROOT_CANON"

[ -f gradlew ] && [ ! -L gradlew ] || { echo NO_VERIFIED_PROJECT_GRADLE_LAUNCHER >&2; exit 1; }
[ ! -L gradle ] && [ ! -L gradle/wrapper ] || { echo GRADLE_WRAPPER_SYMLINK_DENIED >&2; exit 1; }
[ ! -L gradle/wrapper/gradle-wrapper.jar ] || { echo GRADLE_WRAPPER_TARGET_SYMLINK_DENIED >&2; exit 1; }
[ -f gradle/wrapper/gradle-wrapper.properties ] && [ ! -L gradle/wrapper/gradle-wrapper.properties ] || {
  echo GRADLE_WRAPPER_PROPERTIES_MISSING_OR_UNTRUSTED >&2
  exit 1
}
if [ -s gradle/wrapper/gradle-wrapper.jar ]; then
  echo WRAPPER_JAR_ALREADY_PRESENT
  exit 0
fi
WJAR=""
for candidate in \
  "$PREFIX/opt/aibuilder-toolpack/gradle/wrapper/gradle-wrapper.jar" \
  "$AIB_PRIVATE_ROOT/cache/gradle-wrapper.jar"; do
  [ -s "$candidate" ] && [ ! -L "$candidate" ] && { WJAR="$candidate"; break; }
done
[ -n "$WJAR" ] || { echo 'NO_VERIFIED_GRADLE_WRAPPER: verified Termux tool-pack/cache unavailable' >&2; exit 1; }

mkdir -p gradle/wrapper
[ ! -L gradle/wrapper ] || { echo GRADLE_WRAPPER_SYMLINK_DENIED >&2; exit 1; }
cp -n -- "$WJAR" gradle/wrapper/gradle-wrapper.jar
[ -s gradle/wrapper/gradle-wrapper.jar ] || { echo GRADLE_WRAPPER_COPY_FAILED >&2; exit 1; }
echo "wrapper_restored=$WJAR"
echo REPAIR_OK:gradle-wrapper-source=verified-toolpack
