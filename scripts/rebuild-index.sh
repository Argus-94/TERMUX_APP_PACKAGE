#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN="$ROOT/apt/termux-main"
cd "$MAIN"
mkdir -p dists/stable/main/binary-aarch64 pool/main
if command -v dpkg-scanpackages >/dev/null 2>&1; then
  dpkg-scanpackages -m pool /dev/null > dists/stable/main/binary-aarch64/Packages
else
  echo "dpkg-scanpackages not found; leaving Packages as-is" >&2
fi
gzip -9c dists/stable/main/binary-aarch64/Packages > dists/stable/main/binary-aarch64/Packages.gz
echo "Packages entries: $(grep -c '^Package:' dists/stable/main/binary-aarch64/Packages || true)"
echo "Done."
