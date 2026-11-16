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
# Clear stale Gradle/daemon locks under AI Builder homes only
for d in "${HOME}/.aibuilder-gradle" "${GRADLE_USER_HOME:-}" "${HOME}/.gradle"; do
  [ -n "$d" ] && [ -d "$d" ] || continue
  find "$d" -name "*.lock" -type f -delete 2>/dev/null || true
  find "$d" -name "registry.bin.lock" -type f -delete 2>/dev/null || true
done
echo REPAIR_OK:build-lock
