#!/data/data/com.karat.aibuilder/files/usr/bin/bash
# Embedded runtime only: refuse foreign or missing process environment before any I/O.
case "${PREFIX:-}:${HOME:-}" in
  /data/data/com.karat.aibuilder/files/usr:/data/data/com.karat.aibuilder/files/home|/data/user/0/com.karat.aibuilder/files/usr:/data/user/0/com.karat.aibuilder/files/home) ;;
  *) echo AIB_PRIVATE_RUNTIME_REQUIRED >&2; exit 78 ;;
esac
# Private package-feed qualification is still pending; never fall back to stock feeds.
pkg() { echo AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED >&2; return 78; }
# Allowlisted: ensure durable HOME layout
set -e
[ -d /storage/emulated/0/AIBuilderTermux ] || { echo AIB_SHARED_WORKSPACE_ACCESS_REQUIRED >&2; exit 78; }
mkdir -p "$HOME/.aibuilder"
ls -ld "$HOME/.aibuilder" /storage/emulated/0/AIBuilderTermux
echo REPAIR_OK:home-layout
