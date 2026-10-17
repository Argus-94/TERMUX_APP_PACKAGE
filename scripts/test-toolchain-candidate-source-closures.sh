#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $# -eq 1 ]] || { echo 'USAGE: bash test-toolchain-candidate-source-closures.sh <clean-pinned-termux-source>' >&2; exit 2; }
SOURCE_ROOT="$(realpath -e -- "$1")"
LOCK="$ROOT/toolchain-candidate-source-closure-locks.json"
SCOPE="$ROOT/termux-package-source-scope.json"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/aib-toolchain-source-closures.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

python3 - "$LOCK" "$SCOPE" "$ROOT" <<'PY'
import json, pathlib, sys
lock_path, scope_path, root_path = map(pathlib.Path, sys.argv[1:])
lock = json.loads(lock_path.read_text(encoding="utf-8"))
scope = json.loads(scope_path.read_text(encoding="utf-8"))
root = root_path.resolve()
expected = {
    "nodejs-npm-candidate": (["nodejs", "npm"], 11, 14),
    "openjdk17-candidate": (["openjdk-17"], 36, 46),
    "python-candidate": (["python"], 17, 25),
    "cmake-ninja-candidate": (["cmake", "ninja"], 22, 34),
}
assert lock["schemaVersion"] == 1
assert lock["status"] == "inventory-only; no package build or install authorization"
assert lock["sourceRepository"] == scope["sourceRepository"]
assert lock["sourceCommit"] == scope["sourceCommit"] == "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
assert scope["inventoryOnly"] is True and scope["candidateInstallable"] is False
assert set(lock["profiles"]) == set(expected)
for profile, (roots, count, alternatives) in expected.items():
    spec = lock["profiles"][profile]
    assert scope["profiles"][profile] == roots == spec["rootPackages"]
    assert spec["packageCount"] == count
    assert spec["dependencyAlternativeCount"] == alternatives
    assert len(spec["packageNames"]) == count
    assert spec["packageNames"] == sorted(set(spec["packageNames"]))
    assert len(spec["closureSha256"]) == 64
    closure_file = (root / spec["closureFile"]).resolve()
    assert closure_file.is_relative_to(root) and closure_file.is_file()
    if profile == "nodejs-npm-candidate":
        expected_choice = [{
            "package": "npm",
            "dependencyGroupIndex": 0,
            "alternatives": ["nodejs", "nodejs-lts"],
            "selected": "nodejs",
        }]
        assert scope["dependencyChoices"][profile] == expected_choice
        assert spec["selectedDependencyAlternatives"] == expected_choice
        assert "nodejs-lts" not in spec["packageNames"]
    else:
        assert spec["selectedDependencyAlternatives"] == []
print("TOOLCHAIN_SOURCE_CLOSURE_LOCK_METADATA_OK profiles=4 installable=false")
PY

for profile in nodejs-npm-candidate openjdk17-candidate python-candidate cmake-ninja-candidate; do
  current="$TMP/$profile.json"
  python3 "$ROOT/scripts/resolve-pinned-termux-recipe-closure.py" \
    --source-root "$SOURCE_ROOT" --scope "$SCOPE" --profile "$profile" > "$current"
  expected_file="$(python3 - "$LOCK" "$profile" <<'PY'
import json, pathlib, sys
lock=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
print(lock["profiles"][sys.argv[2]]["closureFile"])
PY
  )"
  if ! cmp -s -- "$current" "$ROOT/$expected_file"; then
    echo "ERROR:SOURCE_CLOSURE_SNAPSHOT_MISMATCH:$profile" >&2
    exit 2
  fi
  expected_sha="$(python3 - "$LOCK" "$profile" <<'PY'
import json, pathlib, sys
lock=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
print(lock["profiles"][sys.argv[2]]["closureSha256"])
PY
  )"
  actual_sha="$(sha256sum "$current" | awk '{print $1}')"
  [[ "$actual_sha" == "$expected_sha" ]] || { echo "ERROR:CLOSURE_SHA256_MISMATCH:$profile" >&2; exit 2; }
  printf 'SOURCE_CLOSURE_LOCK_OK profile=%s sha256=%s\n' "$profile" "$actual_sha"
done
printf 'TOOLCHAIN_SOURCE_CLOSURES_VERIFIED profiles=4 build=NOT_RUN install=NOT_RUN publication=NOT_AUTHORIZED\n'
