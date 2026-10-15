#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/aib-dependency-closure.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT
command -v dpkg >/dev/null 2>&1 || { echo 'ERROR:TOOL_REQUIRED:dpkg' >&2; exit 2; }

python3 - "$TMP" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
packages=[
 {'name':'make','version':'4.4.1-1','architecture':'aarch64'},
 {'name':'libcurl','version':'8.5.0-1','architecture':'aarch64'},
 {'name':'openssl','version':'3.2.1-1','architecture':'aarch64'},
]
(root/'set.json').write_text(json.dumps({'schemaVersion':1,'channel':'candidate-only','packages':packages}),encoding='utf-8')
(root/'good.Packages').write_text(
 'Package: make\nVersion: 4.4.1-1\nArchitecture: aarch64\nDepends: libcurl (>= 8.0) | curl\n\n'
 'Package: libcurl\nVersion: 8.5.0-1\nArchitecture: aarch64\nPre-Depends: openssl (>= 3.0)\n\n'
 'Package: openssl\nVersion: 3.2.1-1\nArchitecture: aarch64\n\n',encoding='utf-8')
missing={'schemaVersion':1,'channel':'candidate-only','packages':packages[:2]}
(root/'missing-set.json').write_text(json.dumps(missing),encoding='utf-8')
old_version_specs=[*packages[:2], {'name':'openssl','version':'2.9.9-1','architecture':'aarch64'}]
(root/'old-version-set.json').write_text(json.dumps({'schemaVersion':1,'channel':'candidate-only','packages':old_version_specs}),encoding='utf-8')
(root/'missing.Packages').write_text(
 'Package: make\nVersion: 4.4.1-1\nArchitecture: aarch64\nDepends: libcurl (>= 8.0)\n\n'
 'Package: libcurl\nVersion: 8.5.0-1\nArchitecture: aarch64\nDepends: openssl (>= 3.0)\n\n',encoding='utf-8')
(root/'old-version.Packages').write_text(
 'Package: make\nVersion: 4.4.1-1\nArchitecture: aarch64\nDepends: libcurl (>= 8.0)\n\n'
 'Package: libcurl\nVersion: 8.5.0-1\nArchitecture: aarch64\nDepends: openssl (>= 3.0)\n\n'
 'Package: openssl\nVersion: 2.9.9-1\nArchitecture: aarch64\n\n',encoding='utf-8')
(root/'unsupported.Packages').write_text(
 'Package: make\nVersion: 4.4.1-1\nArchitecture: aarch64\nDepends: libcurl [aarch64]\n\n'
 'Package: libcurl\nVersion: 8.5.0-1\nArchitecture: aarch64\nPre-Depends: openssl (>= 3.0)\n\n'
 'Package: openssl\nVersion: 3.2.1-1\nArchitecture: aarch64\n\n',encoding='utf-8')
PY
CHECKER="$ROOT/scripts/verify-candidate-dependency-closure.py"
python3 "$CHECKER" --package-set "$TMP/set.json" --packages-index "$TMP/good.Packages"
if python3 "$CHECKER" --package-set "$TMP/missing-set.json" --packages-index "$TMP/missing.Packages" >"$TMP/missing.out" 2>&1; then
  echo 'ERROR:MISSING_DEPENDENCY_ACCEPTED' >&2; exit 2
fi
grep -q 'DEPENDENCY_CLOSURE_INCOMPLETE_libcurl_DEPENDS' "$TMP/missing.out"
if python3 "$CHECKER" --package-set "$TMP/old-version-set.json" --packages-index "$TMP/old-version.Packages" >"$TMP/version.out" 2>&1; then
  echo 'ERROR:INCOMPATIBLE_DEPENDENCY_VERSION_ACCEPTED' >&2; exit 2
fi
grep -q 'DEPENDENCY_CLOSURE_INCOMPLETE_libcurl_DEPENDS' "$TMP/version.out"
if python3 "$CHECKER" --package-set "$TMP/set.json" --packages-index "$TMP/unsupported.Packages" >"$TMP/syntax.out" 2>&1; then
  echo 'ERROR:UNSUPPORTED_DEPENDENCY_SYNTAX_ACCEPTED' >&2; exit 2
fi
grep -q 'DEPENDENCY_RELATION_SYNTAX_UNSUPPORTED' "$TMP/syntax.out"
printf 'CANDIDATE_DEPENDENCY_CLOSURE_TESTS_OK complete=1 missing=1 incompatible_version=1 unsupported_syntax=1\n'
