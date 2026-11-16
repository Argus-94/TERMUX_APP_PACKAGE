#!/data/data/com.karat.aibuilder/files/usr/bin/bash
# Embedded runtime only: refuse foreign or missing process environment before any I/O.
case "${PREFIX:-}:${HOME:-}" in
  /data/data/com.karat.aibuilder/files/usr:/data/data/com.karat.aibuilder/files/home|/data/user/0/com.karat.aibuilder/files/usr:/data/user/0/com.karat.aibuilder/files/home) ;;
  *) echo AIB_PRIVATE_RUNTIME_REQUIRED >&2; exit 78 ;;
esac
# Private package-feed qualification is still pending; never fall back to stock feeds.
pkg() { echo AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED >&2; return 78; }
set -e
set -o pipefail
# Locate apksigner/zipalign from SDK build-tools — no unverified downloads
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$PREFIX/opt/android-sdk}}"
BT=$(ls -d "$SDK/build-tools"/*/ 2>/dev/null | tail -1)
if [ -n "$BT" ]; then
  echo "build-tools=$BT"
  command -v apksigner >/dev/null || [ -x "${BT}apksigner" ] && echo apksigner=OK
  command -v zipalign >/dev/null || [ -x "${BT}zipalign" ] && echo zipalign=OK
  echo REPAIR_OK:signing-tools
else
  echo SIGNING_TOOLS_MISSING
  exit 1
fi
