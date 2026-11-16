#!/data/data/com.karat.aibuilder/files/usr/bin/bash
# Embedded runtime only: refuse foreign or missing process environment before any I/O.
case "${PREFIX:-}:${HOME:-}" in
  /data/data/com.karat.aibuilder/files/usr:/data/data/com.karat.aibuilder/files/home|/data/user/0/com.karat.aibuilder/files/usr:/data/user/0/com.karat.aibuilder/files/home) ;;
  *) echo AIB_PRIVATE_RUNTIME_REQUIRED >&2; exit 78 ;;
esac
# Private package-feed qualification is still pending; never fall back to stock feeds.
pkg() { echo AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED >&2; return 78; }
# Allowlisted: locate aapt2 in SDK build-tools
set -e
if command -v aapt2 >/dev/null 2>&1; then
  command -v aapt2
  echo REPAIR_OK:aapt2
  exit 0
fi
found=$(find "$PREFIX/opt/android-sdk/build-tools" -name aapt2 -type f 2>/dev/null | head -1)
if [ -n "$found" ]; then
  echo "$found"
  echo REPAIR_OK:aapt2
  exit 0
fi
echo AAPT2_MISSING
exit 1
