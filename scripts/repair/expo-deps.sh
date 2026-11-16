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
AIB_PRIVATE_ROOT="${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}"
PROJ=$(cat "$AIB_PRIVATE_ROOT/work/proj_path" 2>/dev/null || true)
ROOT="${PROJ:-$PWD}"
# Walk up for package.json (Expo root may be parent of android/)
CUR="$ROOT"
for i in 1 2 3 4; do
  [ -f "$CUR/package.json" ] && ROOT="$CUR" && break
  CUR=$(dirname "$CUR")
done
cd "$ROOT" || exit 1
if command -v pnpm >/dev/null 2>&1 && [ -f pnpm-lock.yaml ]; then
  pnpm install --frozen-lockfile 2>&1 | tail -30
elif command -v pnpm >/dev/null 2>&1; then
  pnpm install 2>&1 | tail -30
elif command -v npm >/dev/null 2>&1; then
  npm install --legacy-peer-deps 2>&1 | tail -30
else
  echo NO_PACKAGE_MANAGER
  exit 1
fi
test -d node_modules
echo REPAIR_OK:expo-deps
