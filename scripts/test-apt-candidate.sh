#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/keys/feed-signing.json"
fail() { printf 'ERROR:%s\n' "$*" >&2; exit 2; }
[[ $# -eq 4 ]] || fail 'USAGE:test-apt-candidate.sh <feed-root> <aarch64|amd64> <package> <version>'
FEED_ROOT="$(realpath -e -- "$1")"
ARCH="$2"
PACKAGE="$3"
VERSION="$4"
case "$ARCH" in aarch64|amd64) ;; *) fail 'ARCHITECTURE_NOT_ALLOWLISTED';; esac
[[ "$PACKAGE" =~ ^[a-z0-9][a-z0-9+.-]*$ ]] || fail 'PACKAGE_NAME_INVALID'
[[ "$VERSION" =~ ^[A-Za-z0-9.+:~_-]+$ ]] || fail 'PACKAGE_VERSION_INVALID'
[[ -f "$MANIFEST" ]] || fail 'SIGNING_MANIFEST_MISSING'
for tool in gpg gpgv sha256sum python3 apt-get apt-cache; do command -v "$tool" >/dev/null 2>&1 || fail "TOOL_REQUIRED:$tool"; done

mapfile -t META < <(python3 - "$MANIFEST" <<'PY'
import json,pathlib,re,sys
m=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
fpr=m.get('fingerprint',''); rel=m.get('publicKeyring',''); digest=m.get('publicKeyringSha256','')
if not re.fullmatch(r'[A-F0-9]{40}',fpr): raise SystemExit('BAD_FINGERPRINT')
if not re.fullmatch(r'[a-f0-9]{64}',digest): raise SystemExit('BAD_KEYRING_SHA256')
p=pathlib.PurePosixPath(rel)
if not rel or p.is_absolute() or '..' in p.parts: raise SystemExit('BAD_KEYRING_PATH')
print(fpr); print(rel); print(digest)
PY
) || fail 'SIGNING_MANIFEST_INVALID'
EXPECTED_FPR="${META[0]}"
KEYRING="$ROOT/${META[1]}"
EXPECTED_KEY_HASH="${META[2]}"
[[ -f "$KEYRING" && ! -L "$KEYRING" ]] || fail 'PUBLIC_KEYRING_MISSING_OR_SYMLINK'
[[ "$(sha256sum "$KEYRING" | awk '{print $1}')" == "$EXPECTED_KEY_HASH" ]] || fail 'PUBLIC_KEYRING_HASH_MISMATCH'
ACTUAL_FPR="$(gpg --batch --show-keys --with-colons "$KEYRING" 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')"
[[ "$ACTUAL_FPR" == "$EXPECTED_FPR" ]] || fail 'PUBLIC_KEYRING_FINGERPRINT_MISMATCH'

DIST="$FEED_ROOT/dists/stable"
[[ -s "$DIST/Release" && -s "$DIST/InRelease" && -s "$DIST/Release.gpg" ]] || fail 'SIGNED_RELEASE_FILES_MISSING'
gpgv --keyring "$KEYRING" "$DIST/Release.gpg" "$DIST/Release" >/dev/null 2>&1 || fail 'DETACHED_RELEASE_SIGNATURE_INVALID'
gpgv --keyring "$KEYRING" "$DIST/InRelease" >/dev/null 2>&1 || fail 'INRELEASE_SIGNATURE_INVALID'

TMP="$(mktemp -d "${TMPDIR:-/tmp}/aib-apt-candidate.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP/lists/partial" "$TMP/archives/partial" "$TMP/parts" "$TMP/sources.d" "$TMP/trusted.d" "$TMP/preferences.d" "$TMP/downloads"
: > "$TMP/status"
: > "$TMP/extended_states"
: > "$TMP/empty-trusted.gpg"
: > "$TMP/apt-main.conf"
: > "$TMP/preferences"
printf 'deb [arch=%s signed-by=%s] file:%s stable main\n' "$ARCH" "$KEYRING" "$FEED_ROOT" > "$TMP/sources.list"
cat > "$TMP/apt.conf" <<EOF
Dir {
  Etc {
    main "$TMP/apt-main.conf";
    parts "$TMP/parts";
    sourcelist "$TMP/sources.list";
    sourceparts "$TMP/sources.d";
    trusted "$TMP/empty-trusted.gpg";
    trustedparts "$TMP/trusted.d";
    preferences "$TMP/preferences";
    preferencesparts "$TMP/preferences.d";
  };
  State {
    lists "$TMP/lists/";
    lists::partial "$TMP/lists/partial/";
    status "$TMP/status";
    extended_states "$TMP/extended_states";
  };
  Cache {
    archives "$TMP/archives/";
    archives::partial "$TMP/archives/partial/";
    pkgcache "$TMP/pkgcache.bin";
    srcpkgcache "$TMP/srcpkgcache.bin";
  };
  Log {
    History "$TMP/history.log";
    Terminal "$TMP/terminal.log";
    Planner "$TMP/planner.log";
  };
}
APT::Architecture "$ARCH";
APT::Get::List-Cleanup "0";
APT::Get::AllowUnauthenticated "false";
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
Acquire::Languages "none";
Acquire::Retries "0";
EOF

APT_CONFIG="$TMP/apt.conf" apt-get update >"$TMP/update.log" 2>&1 || { cat "$TMP/update.log" >&2; fail 'APT_UPDATE_REJECTED_SIGNED_CANDIDATE'; }
APT_CONFIG="$TMP/apt.conf" apt-cache show "$PACKAGE" >"$TMP/show.log" 2>&1 || { cat "$TMP/show.log" >&2; fail 'APT_CANDIDATE_NOT_QUERYABLE'; }
grep -Fxq "Package: $PACKAGE" "$TMP/show.log" || fail 'APT_PACKAGE_NAME_MISMATCH'
grep -Fxq "Version: $VERSION" "$TMP/show.log" || fail 'APT_PACKAGE_VERSION_MISMATCH'
grep -Fxq "Architecture: $ARCH" "$TMP/show.log" || fail 'APT_PACKAGE_ARCHITECTURE_MISMATCH'
APT_CONFIG="$TMP/apt.conf" apt-get --simulate --no-install-recommends install "$PACKAGE=$VERSION" >"$TMP/simulate.log" 2>&1 || { cat "$TMP/simulate.log" >&2; fail 'APT_SIMULATED_INSTALL_REJECTED'; }
(
  cd "$TMP/downloads"
  APT_CONFIG="$TMP/apt.conf" apt-get download "$PACKAGE=$VERSION" >"$TMP/download.log" 2>&1 || { cat "$TMP/download.log" >&2; fail 'APT_DOWNLOAD_FAILED'; }
)
mapfile -t DOWNLOADED < <(find "$TMP/downloads" -maxdepth 1 -type f -name '*.deb' -print)
mapfile -t SOURCE_DEBS < <(find "$FEED_ROOT/pool" -type f -name '*.deb' -print)
((${#DOWNLOADED[@]} == 1 && ${#SOURCE_DEBS[@]} == 1)) || fail 'EXPECTED_EXACTLY_ONE_DOWNLOADED_AND_SOURCE_DEB'
[[ "$(sha256sum "${DOWNLOADED[0]}" | awk '{print $1}')" == "$(sha256sum "${SOURCE_DEBS[0]}" | awk '{print $1}')" ]] || fail 'DOWNLOADED_PACKAGE_HASH_MISMATCH'
printf 'APT_CANDIDATE_DOWNLOAD_AND_SIMULATED_INSTALL_OK package=%s version=%s arch=%s signed_by=1 install_performed=0 rollback_performed=0\n' "$PACKAGE" "$VERSION" "$ARCH"
