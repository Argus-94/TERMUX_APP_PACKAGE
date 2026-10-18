#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/aib-device-artifact-test.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

for tool in dpkg-deb dpkg-scanpackages gzip gpg gpgv python3; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'ERROR:TOOL_REQUIRED:%s\n' "$tool" >&2; exit 2; }
done

PACKAGE_SET="$ROOT/candidate-package-set.json"
FEED="$TMP/feed"
PKG="$TMP/pkg"
KEY_ROOT="$TMP/signing-config"
OUT="$TMP/artifact"
mkdir -p "$PKG/DEBIAN" "$FEED/pool/main/make" "$FEED/dists/stable/main/binary-aarch64"
cat > "$PKG/DEBIAN/control" <<'EOF'
Package: make
Version: 4.4.1-1
Architecture: aarch64
Maintainer: Synthetic staging fixture <noreply@example.invalid>
Description: Synthetic artifact-staging test only; never install
EOF
mkdir -p "$PKG/data/data/com.karat.aibuilder/files/usr/bin"
printf '#!/system/bin/sh\nexit 0\n' > "$PKG/data/data/com.karat.aibuilder/files/usr/bin/make"
chmod 755 "$PKG/data/data/com.karat.aibuilder/files/usr/bin/make"
find "$PKG" -type d -exec chmod 755 {} +
find "$PKG" -type f ! -path '*/bin/make' -exec chmod 644 {} +
DEB="$FEED/pool/main/make/make_4.4.1-1_aarch64.deb"
dpkg-deb --build --root-owner-group "$PKG" "$DEB" >/dev/null
(cd "$FEED" && dpkg-scanpackages -m pool /dev/null > dists/stable/main/binary-aarch64/Packages)
gzip -n -9c "$FEED/dists/stable/main/binary-aarch64/Packages" > "$FEED/dists/stable/main/binary-aarch64/Packages.gz"

"$ROOT/scripts/create-ephemeral-feed-signing-key.sh" "$KEY_ROOT" >/dev/null
export AIB_TERMUX_FEED_SIGNING_CONFIG_ROOT="$KEY_ROOT"
export GNUPGHOME="$KEY_ROOT/gnupg"
"$ROOT/scripts/create-signed-feed-release.sh" "$FEED" aarch64 >/dev/null

python3 - "$PACKAGE_SET" "$DEB" "$TMP/build-result.json" "$TMP/audit-report.json" <<'PY'
import hashlib, json, pathlib, sys
package_set=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
deb=pathlib.Path(sys.argv[2])
spec=package_set["packages"][0]
prefix=package_set["target"]["modeledPrefix"]
digest=hashlib.sha256(deb.read_bytes()).hexdigest()
build={
  "status":"audit-passed; device-runtime-test-not-run",
  "applicationId":"com.karat.aibuilder",
  "prefix":prefix,
  "prefixProvenance":"ci-model-only; device-observation-not-run",
  "sourceCommit":spec["sourceCommit"],
  "builderImageRef":spec["builderImage"],
  "candidateRecipePatchSha256":spec["localRecipePatchSha256"],
  "sourceLicenseSha256":spec["sourceLicenseSha256"],
  "packageFile":deb.name,
  "packageSha256":digest,
  "installed":False,
  "deviceSmokeTest":"NOT RUN"
}
audit={
  "ok":True,
  "status":"static-audit-passed; installation-and-device-runtime-unverified",
  "sha256":digest,
  "package":{
    "name":spec["name"],"version":spec["version"],"architecture":spec["architecture"],
    "licenseEvidencePath":spec["sourceLicenseRelativePath"],
    "licenseEvidenceSha256":spec["sourceLicenseSha256"]
  },
  "target":{"applicationId":"com.karat.aibuilder","prefix":prefix}
}
pathlib.Path(sys.argv[3]).write_text(json.dumps(build),encoding="utf-8")
pathlib.Path(sys.argv[4]).write_text(json.dumps(audit),encoding="utf-8")
PY

python3 "$ROOT/scripts/validate-candidate-feed.py" \
  --package-set "$PACKAGE_SET" --feed-root "$FEED" \
  --build-result "$TMP/build-result.json" --audit-report "$TMP/audit-report.json" >/dev/null
python3 "$ROOT/scripts/stage-device-test-artifact.py" \
  --package-set "$PACKAGE_SET" --feed-root "$FEED" \
  --build-result "$TMP/build-result.json" --audit-report "$TMP/audit-report.json" \
  --key-root "$KEY_ROOT" --destination "$OUT"
python3 - "$OUT" <<'PY'
import pathlib, sys
root=pathlib.Path(sys.argv[1])
expected={
  "feed/Release",
  "feed/dists/stable/Release",
  "feed/dists/stable/InRelease",
  "feed/dists/stable/Release.gpg",
  "feed/dists/stable/main/binary-aarch64/Packages",
  "feed/dists/stable/main/binary-aarch64/Packages.gz",
  "feed/pool/main/make/make_4.4.1-1_aarch64.deb",
  "keys/aibuilder-termux-feed-keyring.gpg",
  "keys/feed-signing.json",
  "provenance/candidate-package-set.json",
  "provenance/build-result.json",
  "provenance/audit-report.json",
}
actual={p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
assert actual == expected, (sorted(actual), sorted(expected))
assert not any("gnupg" in p.parts or "private" in p.name.lower() for p in root.rglob("*"))
PY

cp -a "$FEED" "$TMP/tampered-feed"
printf '\n#tamper\n' >> "$TMP/tampered-feed/dists/stable/Release"
if python3 "$ROOT/scripts/stage-device-test-artifact.py" \
  --package-set "$PACKAGE_SET" --feed-root "$TMP/tampered-feed" \
  --build-result "$TMP/build-result.json" --audit-report "$TMP/audit-report.json" \
  --key-root "$KEY_ROOT" --destination "$TMP/tampered-artifact" >"$TMP/tamper.out" 2>&1; then
  echo 'ERROR:TAMPERED_RELEASE_ACCEPTED' >&2
  exit 2
fi
grep -q 'SIGNED_RELEASE_VERIFICATION_FAILED' "$TMP/tamper.out"
[[ ! -e "$TMP/tampered-artifact" ]] || { echo 'ERROR:FAILED_STAGING_LEFT_ARTIFACT' >&2; exit 2; }

# Each negative case uses a fresh feed copy and the fixture's ephemeral signing key.
expect_stage_rejection() {
  local name="$1" expected="$2" feed="$3" build="$4" package_set="$5"
  local destination="$TMP/negative-$name-artifact" output="$TMP/negative-$name.out"
  if python3 "$ROOT/scripts/stage-device-test-artifact.py" \
    --package-set "$package_set" --feed-root "$feed" \
    --build-result "$build" --audit-report "$TMP/audit-report.json" \
    --key-root "$KEY_ROOT" --destination "$destination" >"$output" 2>&1; then
    echo "ERROR:NEGATIVE_CASE_ACCEPTED:$name" >&2
    exit 2
  fi
  grep -q "$expected" "$output" || { cat "$output" >&2; echo "ERROR:WRONG_NEGATIVE_CASE_ERROR:$name expected=$expected" >&2; exit 2; }
  [[ ! -e "$destination" ]] || { echo "ERROR:FAILED_STAGING_LEFT_ARTIFACT:$name" >&2; exit 2; }
}

# A modified Packages file is not covered by its original, valid Release signature.
cp -a "$FEED" "$TMP/index-edit-feed"
python3 - "$TMP/index-edit-feed/dists/stable/main/binary-aarch64/Packages" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); data=p.read_bytes()
assert b'Description:' in data
p.write_bytes(data.replace(b'Description: Synthetic artifact-staging test only; never install', b'Description: Synthetic artifact-staging test only; never install\n extra unsigned continuation', 1))
PY
gzip -n -9c "$TMP/index-edit-feed/dists/stable/main/binary-aarch64/Packages" > "$TMP/index-edit-feed/dists/stable/main/binary-aarch64/Packages.gz"
expect_stage_rejection index-hash SIGNED_INDEX_HASH_MISMATCH "$TMP/index-edit-feed" "$TMP/build-result.json" "$PACKAGE_SET"

# Sign a different Release payload into a valid InRelease; both signatures verify,
# but the clear-signed payload must exactly match dists/stable/Release.
cp -a "$FEED" "$TMP/inrelease-mismatch-feed"
cp "$TMP/inrelease-mismatch-feed/dists/stable/Release" "$TMP/other-release"
printf '\nX-Synthetic-Mismatch: yes\n' >> "$TMP/other-release"
fingerprint="$(python3 - "$KEY_ROOT/keys/feed-signing.json" <<'PY'
import json, pathlib, sys
d=json.loads(pathlib.Path(sys.argv[1]).read_text())
print(d['fingerprint'])
PY
)"
gpg --batch --yes --local-user "$fingerprint" --clearsign --output "$TMP/inrelease-mismatch-feed/dists/stable/InRelease" "$TMP/other-release"
expect_stage_rejection inrelease-payload INRELEASE_PAYLOAD_MISMATCH "$TMP/inrelease-mismatch-feed" "$TMP/build-result.json" "$PACKAGE_SET"

# Change the root-level feed Release independently of the signed distribution.
cp -a "$FEED" "$TMP/root-release-mismatch-feed"
printf '\n# synthetic root release mismatch\n' >> "$TMP/root-release-mismatch-feed/Release"
expect_stage_rejection root-release ROOT_RELEASE_MISMATCH "$TMP/root-release-mismatch-feed" "$TMP/build-result.json" "$PACKAGE_SET"

# Candidate provenance policy must bind source commit and the pinned source hash.
python3 - "$TMP/build-result.json" "$TMP/altered-build-result.json" <<'PY'
import json, pathlib, sys
p=json.loads(pathlib.Path(sys.argv[1]).read_text()); p['sourceCommit']='0'*40
pathlib.Path(sys.argv[2]).write_text(json.dumps(p))
PY
expect_stage_rejection source-commit CANDIDATE_PROVENANCE_OR_FEED_POLICY_FAILED "$FEED" "$TMP/altered-build-result.json" "$PACKAGE_SET"
python3 - "$PACKAGE_SET" "$TMP/altered-package-set.json" <<'PY'
import json, pathlib, sys
p=json.loads(pathlib.Path(sys.argv[1]).read_text()); p['packages'][0]['sourceSha256']='0'*64
pathlib.Path(sys.argv[2]).write_text(json.dumps(p))
PY
expect_stage_rejection pinned-source-hash CANDIDATE_PROVENANCE_OR_FEED_POLICY_FAILED "$FEED" "$TMP/build-result.json" "$TMP/altered-package-set.json"

printf 'DEVICE_TEST_ARTIFACT_STAGING_TEST_OK synthetic_fixture_only=1 signed_metadata=verified exact_file_allowlist=12 tamper_rejected=1 private_key_included=0\n'
