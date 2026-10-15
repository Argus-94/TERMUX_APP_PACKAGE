#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${ROOT}/keys/feed-signing.json"
: "${AIB_TERMUX_FEED_SIGNING_KEY:?Actions signing key secret is required}"
[[ -f "$MANIFEST" ]] || { echo 'ERROR:SIGNING_MANIFEST_MISSING' >&2; exit 2; }
for tool in gpg gpgv dpkg-deb dpkg-scanpackages apt-get python3 sha256sum sudo; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR:TOOL_REQUIRED:$tool" >&2; exit 2; }
done

mapfile -t META < <(python3 - "$MANIFEST" <<'PY'
import json, pathlib, re, sys
m=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
fpr=m.get('fingerprint','')
key=m.get('publicKeyring','')
digest=m.get('publicKeyringSha256','')
if not re.fullmatch(r'[A-F0-9]{40}', fpr): raise SystemExit('BAD_FINGERPRINT')
if not re.fullmatch(r'[a-f0-9]{64}', digest): raise SystemExit('BAD_KEYRING_SHA256')
if not key or pathlib.PurePosixPath(key).is_absolute() or '..' in pathlib.PurePosixPath(key).parts:
    raise SystemExit('BAD_KEYRING_PATH')
print(fpr)
print(key)
print(digest)
PY
)
EXPECTED_FPR="${META[0]}"
PUBLIC_KEYRING="${ROOT}/${META[1]}"
EXPECTED_KEYRING_SHA256="${META[2]}"
[[ -f "$PUBLIC_KEYRING" ]] || { echo 'ERROR:PUBLIC_KEYRING_MISSING' >&2; exit 2; }
[[ "$(sha256sum "$PUBLIC_KEYRING" | awk '{print $1}')" == "$EXPECTED_KEYRING_SHA256" ]] || {
  echo 'ERROR:PUBLIC_KEYRING_HASH_MISMATCH' >&2; exit 2;
}

TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/aib-feed-signing-smoke.XXXXXX")"
cleanup() {
  if [[ -n "${TMP:-}" && -d "$TMP" ]]; then
    sudo rm -rf -- "$TMP" || rm -rf -- "$TMP"
  fi
}
trap cleanup EXIT
chmod 755 "$TMP"
export GNUPGHOME="${TMP}/gnupg"
mkdir -m 700 "$GNUPGHOME"

printf '%s' "$AIB_TERMUX_FEED_SIGNING_KEY" | gpg --batch --import >/dev/null 2>"${TMP}/gpg-import.log"
ACTUAL_FPR="$(gpg --batch --with-colons --list-secret-keys 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')"
[[ "$ACTUAL_FPR" == "$EXPECTED_FPR" ]] || { echo 'ERROR:PRIVATE_KEY_FINGERPRINT_MISMATCH' >&2; exit 2; }
gpg --batch --export "$ACTUAL_FPR" > "${TMP}/exported-public.gpg"
[[ "$(sha256sum "${TMP}/exported-public.gpg" | awk '{print $1}')" == "$EXPECTED_KEYRING_SHA256" ]] || {
  echo 'ERROR:PRIVATE_KEY_DOES_NOT_MATCH_COMMITTED_PUBLIC_KEY' >&2; exit 2;
}

FEED="${TMP}/site/apt/termux-main"
PKGROOT="${TMP}/package"
mkdir -p "${PKGROOT}/DEBIAN" "${FEED}/pool/main/aibuilder-signing-smoke" \
  "${FEED}/dists/stable/main/binary-amd64"
cat > "${PKGROOT}/DEBIAN/control" <<'EOF'
Package: aibuilder-feed-signing-smoke
Version: 0.1
Architecture: amd64
Maintainer: AI Builder Feed Signing Test <noreply@example.invalid>
Description: Temporary signing test fixture; not an installable Builder package
EOF
dpkg-deb --build --root-owner-group "$PKGROOT" \
  "${FEED}/pool/main/aibuilder-signing-smoke/aibuilder-feed-signing-smoke_0.1_amd64.deb" >/dev/null
(
  cd "$FEED"
  dpkg-scanpackages -m pool /dev/null > dists/stable/main/binary-amd64/Packages
)
gzip -n -9c "${FEED}/dists/stable/main/binary-amd64/Packages" > \
  "${FEED}/dists/stable/main/binary-amd64/Packages.gz"
"${ROOT}/scripts/create-signed-feed-release.sh" "$FEED" amd64

SOURCE_LIST="${TMP}/sources.list"
printf 'deb [arch=amd64 signed-by=%s] file:%s stable main\n' "$PUBLIC_KEYRING" "$FEED" > "$SOURCE_LIST"
: > "${TMP}/status"
: > "${TMP}/apt-main.conf"
: > "${TMP}/empty-trusted.gpg"
: > "${TMP}/preferences"
mkdir -p "${TMP}/parts" "${TMP}/sources.d" "${TMP}/trusted.d" "${TMP}/preferences.d"
mkdir -p "${TMP}/lists/partial" "${TMP}/archives/partial"
APT_CONF="${TMP}/apt.conf"
cat > "$APT_CONF" <<EOF
Dir {
  Etc {
    main "${TMP}/apt-main.conf";
    parts "${TMP}/parts";
    sourcelist "${SOURCE_LIST}";
    sourceparts "${TMP}/sources.d";
    trusted "${TMP}/empty-trusted.gpg";
    trustedparts "${TMP}/trusted.d";
    preferences "${TMP}/preferences";
    preferencesparts "${TMP}/preferences.d";
  };
  State {
    lists "${TMP}/lists/";
    lists::partial "${TMP}/lists/partial/";
    status "${TMP}/status";
    extended_states "${TMP}/extended_states";
  };
  Cache {
    archives "${TMP}/archives/";
    archives::partial "${TMP}/archives/partial/";
    pkgcache "${TMP}/pkgcache.bin";
    srcpkgcache "${TMP}/srcpkgcache.bin";
  };
  Log {
    History "${TMP}/history.log";
    Terminal "${TMP}/terminal.log";
    Planner "${TMP}/planner.log";
  };
}
APT::Architecture "amd64";
APT::Get::List-Cleanup "0";
APT::Get::AllowUnauthenticated "false";
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
Acquire::Languages "none";
Acquire::Retries "0";
EOF

APT_CONFIG="$APT_CONF" sudo -E apt-get update

printf '# tamper test\n' >> "${FEED}/dists/stable/main/binary-amd64/Packages.gz"
sudo rm -rf -- "${TMP}/lists"
mkdir -p "${TMP}/lists/partial"
if APT_CONFIG="$APT_CONF" sudo -E apt-get update >"${TMP}/tamper.log" 2>&1; then
  echo 'ERROR:APT_ACCEPTED_TAMPERED_PACKAGES_GZ' >&2
  cat "${TMP}/tamper.log" >&2
  exit 2
fi
if ! grep -Eiq 'Hash Sum mismatch|hashes of expected file|unexpected size' "${TMP}/tamper.log"; then
  echo 'ERROR:APT_FAILED_FOR_UNEXPECTED_REASON_DURING_TAMPER_TEST' >&2
  cat "${TMP}/tamper.log" >&2
  exit 2
fi
printf 'APT_SIGNING_SMOKE_OK fingerprint=%s public_keyring_sha256=%s signed_by=1 tamper_rejected=1 install_performed=0 package_published=0\n' \
  "$EXPECTED_FPR" "$EXPECTED_KEYRING_SHA256"
