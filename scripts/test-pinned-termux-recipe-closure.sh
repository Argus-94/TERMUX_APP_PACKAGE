#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/aib-termux-source-closure.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT
SRC="$TMP/source"
mkdir -p "$SRC/packages" "$TMP/config"
git -C "$SRC" init -q
git -C "$SRC" config user.name 'closure fixture'
git -C "$SRC" config user.email 'closure-fixture@example.invalid'

mkdir -p "$SRC/packages/alpha" "$SRC/packages/bravo" "$SRC/packages/parent" "$SRC/packages/support" "$SRC/packages/optional"
cat > "$SRC/packages/alpha/build.sh" <<'EOF'
TERMUX_PKG_VERSION="1.0"
TERMUX_PKG_DEPENDS="bravo (>= 2.0)"
TERMUX_PKG_RECOMMENDS="optional"
EOF
cat > "$SRC/packages/bravo/build.sh" <<'EOF'
TERMUX_PKG_VERSION="2.0"
TERMUX_PKG_DEPENDS="subtool, helper"
EOF
cat > "$SRC/packages/parent/build.sh" <<'EOF'
TERMUX_PKG_VERSION="3.0"
TERMUX_PKG_REVISION=1
TERMUX_PKG_DEPENDS="support"
EOF
cat > "$SRC/packages/parent/subtool.subpackage.sh" <<'EOF'
TERMUX_SUBPKG_DEPENDS="support"
TERMUX_SUBPKG_DEPEND_ON_PARENT=false
EOF
cat > "$SRC/packages/parent/helper.subpackage.sh" <<'EOF'
TERMUX_SUBPKG_DESCRIPTION="Synthetic helper"
EOF
cat > "$SRC/packages/support/build.sh" <<'EOF'
TERMUX_PKG_VERSION=4.0
EOF
cat > "$SRC/packages/optional/build.sh" <<'EOF'
TERMUX_PKG_VERSION=5.0
EOF
git -C "$SRC" add packages
git -C "$SRC" commit -qm 'synthetic pinned source fixture'
PIN="$(git -C "$SRC" rev-parse HEAD)"
cat > "$TMP/config/scope.json" <<EOF
{"schemaVersion":1,"sourceRepository":"https://example.invalid/termux-packages.git","sourceCommit":"$PIN","inventoryOnly":true,"candidateInstallable":false,"profiles":{"base":["alpha"],"extras":["helper"]}}
EOF
CHECKER="$ROOT/scripts/resolve-pinned-termux-recipe-closure.py"
python3 "$CHECKER" --source-root "$SRC" --scope "$TMP/config/scope.json" --profile base > "$TMP/base.json"
python3 - "$TMP/base.json" <<'PY'
import json, pathlib, sys
result=json.loads(pathlib.Path(sys.argv[1]).read_text())
packages={item['name']:item for item in result['packages']}
assert set(packages)=={'alpha','bravo','helper','parent','subtool','support'}, set(packages)
assert packages['helper']['parentDependencyRule']=='true'
assert packages['helper']['dependencyGroups'][-1][0]['sourceRelation']=='parent (= parent-build-version)'
assert packages['subtool']['parentDependencyRule']=='none'
assert packages['subtool']['dependencyGroups'][0][0]['name']=='support'
assert packages['alpha']['recommendationGroupsNotIncludedInRequiredClosure'][0][0]['name']=='optional'
assert 'optional' not in packages
assert packages['parent']['sourceRevisionExpression']=='1'
assert all(item['recipeSha256'] for item in packages.values())
print('PINNED_TERMUX_RECIPE_CLOSURE_TESTS_OK recursion=1 alternatives=1 subpackage_parent=1 explicit_parent_off=1 recommendations_excluded=1 hashes=1')
PY
python3 "$CHECKER" --source-root "$SRC" --scope "$TMP/config/scope.json" --profile extras > "$TMP/extras.json"
python3 - "$TMP/extras.json" <<'PY'
import json, pathlib, sys
result=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert result['rootPackages']==['helper']
assert {'helper','parent','support'}=={item['name'] for item in result['packages']}
PY
sed -i 's/"sourceCommit":"[0-9a-f]*/"sourceCommit":"0000000000000000000000000000000000000000/' "$TMP/config/scope.json"
if python3 "$CHECKER" --source-root "$SRC" --scope "$TMP/config/scope.json" --profile base >"$TMP/pin.out" 2>&1; then
  echo 'ERROR:SOURCE_PIN_MISMATCH_ACCEPTED' >&2; exit 2
fi
grep -q 'SOURCE_COMMIT_MISMATCH' "$TMP/pin.out"
printf 'PINNED_TERMUX_RECIPE_CLOSURE_NEGATIVE_TESTS_OK source_pin_mismatch=1\n'
