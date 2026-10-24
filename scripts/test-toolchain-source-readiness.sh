#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ROOT="${1:?Usage: test-toolchain-source-readiness.sh <clean-pinned-termux-source> }"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/aib-toolchain-readiness.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

python3 "$ROOT/scripts/verify-toolchain-source-readiness.py" \
  --repo-root "$ROOT" --source-root "$SOURCE_ROOT"

mkdir -p "$TMP/scripts"
mkdir -p "$TMP/docs/evidence"
cp "$ROOT/scripts/resolve-pinned-termux-recipe-closure.py" "$TMP/scripts/"
cp "$ROOT/termux-package-source-scope.json" "$TMP/"
cp "$ROOT/toolchain-source-readiness-inventory.json" "$TMP/"
cp "$ROOT/docs/evidence/gradle-source-bootstrap-inspection.json" "$TMP/docs/evidence/"

PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/tests/test_gradle_source_archive_inspection.py"

python3 - "$TMP/toolchain-source-readiness-inventory.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
value["gates"]["productionAllowed"] = True
path.write_text(json.dumps(value), encoding="utf-8")
PY
if python3 "$ROOT/scripts/verify-toolchain-source-readiness.py" \
  --repo-root "$TMP" --source-root "$SOURCE_ROOT" >"$TMP/open-gate.out" 2>&1; then
  echo 'ERROR:OPEN_PRODUCTION_GATE_ACCEPTED' >&2
  exit 2
fi
grep -q 'INVENTORY_GATES_MUST_REMAIN_CLOSED' "$TMP/open-gate.out"

cp "$ROOT/toolchain-source-readiness-inventory.json" "$TMP/toolchain-source-readiness-inventory.json"
python3 - "$TMP/toolchain-source-readiness-inventory.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
value["profiles"]["clang"]["candidateEligible"] = True
path.write_text(json.dumps(value), encoding="utf-8")
PY
if python3 "$ROOT/scripts/verify-toolchain-source-readiness.py" \
  --repo-root "$TMP" --source-root "$SOURCE_ROOT" >"$TMP/candidate.out" 2>&1; then
  echo 'ERROR:BLOCKED_CLANG_PROFILE_ACCEPTED_AS_CANDIDATE' >&2
  exit 2
fi
grep -q 'PROFILE_CANDIDATE_MUST_REMAIN_CLOSED' "$TMP/candidate.out"

cp "$ROOT/toolchain-source-readiness-inventory.json" "$TMP/toolchain-source-readiness-inventory.json"
python3 - "$TMP/toolchain-source-readiness-inventory.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding="utf-8"))
value["profiles"]["gradle"]["sourceArchiveInspection"]["wrapper"]["distributionUrl"] = "https://services.gradle.org/distributions/gradle-9.8.2-bin.zip"
path.write_text(json.dumps(value), encoding="utf-8")
PY
if python3 "$ROOT/scripts/verify-toolchain-source-readiness.py" \
  --repo-root "$TMP" --source-root "$SOURCE_ROOT" >"$TMP/source-evidence.out" 2>&1; then
  echo 'ERROR:DRIFTED_GRADLE_SOURCE_EVIDENCE_ACCEPTED' >&2
  exit 2
fi
grep -q 'GRADLE_SOURCE_INSPECTION_EVIDENCE_MISMATCH' "$TMP/source-evidence.out"

printf 'TOOLCHAIN_READINESS_TESTS_OK valid_inventory=1 open_production_gate_rejected=1 blocked_profile_promotion_rejected=1 gradle_source_unit_tests=6 drifted_archive_evidence_rejected=1\n'
