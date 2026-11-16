#!/data/data/com.karat.aibuilder/files/usr/bin/bash
# Embedded runtime only: refuse foreign or missing process environment before any I/O.
case "${PREFIX:-}:${HOME:-}" in
  /data/data/com.karat.aibuilder/files/usr:/data/data/com.karat.aibuilder/files/home|/data/user/0/com.karat.aibuilder/files/usr:/data/user/0/com.karat.aibuilder/files/home) ;;
  *) echo AIB_PRIVATE_RUNTIME_REQUIRED >&2; exit 78 ;;
esac
# Private package-feed qualification is still pending; never fall back to stock feeds.
pkg() { echo AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED >&2; return 78; }
# Allowlisted: probe aarch64 NDK path
set -e
if [ -d "$PREFIX/opt/android-ndk" ]; then
  echo "NDK_OK $PREFIX/opt/android-ndk"
  [ -f "$PREFIX/opt/android-ndk/source.properties" ] && head -3 "$PREFIX/opt/android-ndk/source.properties" || true
  echo REPAIR_OK:ndk
  exit 0
fi
echo NDK_MISSING
echo REPAIR_OK:ndk-missing
exit 0
