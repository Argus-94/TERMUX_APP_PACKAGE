#!/usr/bin/env bash
set -euo pipefail
PKGS="${*:-git openssh python}"
APP_ID="com.karat.aibuilder"
WORKDIR="${WORKDIR:-$HOME/aib-termux-build}"
REPO_OUT="${REPO_OUT:-$PWD/out-apt}"
mkdir -p "$WORKDIR" "$REPO_OUT/apt/termux-main/pool/main" \
  "$REPO_OUT/apt/termux-main/dists/stable/main/binary-aarch64"
[ -d "$WORKDIR/termux-packages/.git" ] || git clone https://github.com/termux/termux-packages.git "$WORKDIR/termux-packages"
cd "$WORKDIR/termux-packages"
sed -i "s/^TERMUX_APP__PACKAGE_NAME=.*/TERMUX_APP__PACKAGE_NAME=\"$APP_ID\"/" scripts/properties.sh 2>/dev/null || \
  echo "TERMUX_APP__PACKAGE_NAME=\"$APP_ID\"" >> scripts/properties.sh
for p in $PKGS; do ./scripts/run-docker.sh ./build-package.sh -a aarch64 -f "$p" || true; done
find . -name '*_aarch64.deb' -type f | while read -r deb; do
  name=$(basename "$deb" | sed 's/_.*//')
  mkdir -p "$REPO_OUT/apt/termux-main/pool/main/$name"
  cp -v "$deb" "$REPO_OUT/apt/termux-main/pool/main/$name/"
done
cd "$REPO_OUT/apt/termux-main"
dpkg-scanpackages -m pool /dev/null > dists/stable/main/binary-aarch64/Packages
gzip -9cf dists/stable/main/binary-aarch64/Packages > dists/stable/main/binary-aarch64/Packages.gz
echo "Copy apt/ to repo and push"
