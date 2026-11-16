#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
javac -d "$tmp" "$root/tools/offline-bundle/KaratManifestSigner.java" "$root/tools/offline-bundle/KaratManifestSignerSelfTest.java"
java -cp "$tmp" com.karat.aibuilder.offline.KaratManifestSignerSelfTest
