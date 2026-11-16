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
# Use only the project-pinned Expo CLI; never download and execute an unpinned package.
if [ -x "node_modules/.bin/expo" ]; then
  ./node_modules/.bin/expo --version 2>&1 | tail -5
else
  echo "EXPO_CLI_MISSING: install this project from its lockfile first" >&2
  exit 127
fi
command -v node
echo REPAIR_OK:expo-cli
