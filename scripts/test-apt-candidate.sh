#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_ROOT="${AIB_TERMUX_FEED_SIGNING_CONFIG_ROOT:-$ROOT}"
MANIFEST="$CONFIG_ROOT/keys/feed-signing.json"
fail() { printf 'ERROR:%s\n' "$*" >&2; exit 2; }
[[ $# -ge 4 ]] || fail 'USAGE:test-apt-candidate.sh <feed-root> <aarch64|amd64> <package> <version> [expected-source-deb-count] [expected-root-architecture] [additional-package=exact-version ...]'
FEED_ROOT="$(realpath -e -- "$1")"
ARCH="$2"
PACKAGE="$3"
VERSION="$4"
EXPECTED_SOURCE_DEB_COUNT="${5:-1}"
EXPECTED_ROOT_ARCH="${6:-$ARCH}"
case "$ARCH" in aarch64|amd64) ;; *) fail 'ARCHITECTURE_NOT_ALLOWLISTED';; esac
[[ "$EXPECTED_ROOT_ARCH" == "$ARCH" || "$EXPECTED_ROOT_ARCH" == all ]] || fail 'ROOT_ARCHITECTURE_NOT_ALLOWLISTED'
[[ "$PACKAGE" =~ ^[a-z0-9][a-z0-9+.-]*$ ]] || fail 'PACKAGE_NAME_INVALID'
[[ "$VERSION" =~ ^[A-Za-z0-9.+:~_-]+$ ]] || fail 'PACKAGE_VERSION_INVALID'
[[ "$EXPECTED_SOURCE_DEB_COUNT" =~ ^[1-9][0-9]*$ ]] || fail 'EXPECTED_SOURCE_DEB_COUNT_INVALID'
INSTALL_SPECS=("$PACKAGE=$VERSION")
declare -A ROOT_NAMES=(["$PACKAGE"]=1)
for ((arg_index=7; arg_index<=$#; arg_index++)); do
  spec="${!arg_index}"
  [[ "$spec" =~ ^[a-z0-9][a-z0-9+.-]*=[A-Za-z0-9.+:~_-]+$ ]] || fail 'ADDITIONAL_ROOT_SPEC_INVALID'
  spec_name="${spec%%=*}"
  [[ "$spec_name" != "$PACKAGE" ]] || fail 'ADDITIONAL_ROOT_DUPLICATES_PRIMARY'
  [[ -z "${ROOT_NAMES[$spec_name]+present}" ]] || fail 'ADDITIONAL_ROOT_DUPLICATE_NAME'
  ROOT_NAMES["$spec_name"]=1
  INSTALL_SPECS+=("$spec")
done
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
KEYRING="$CONFIG_ROOT/${META[1]}"
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
grep -Fxq "Architecture: $EXPECTED_ROOT_ARCH" "$TMP/show.log" || fail 'APT_PACKAGE_ARCHITECTURE_MISMATCH'
APT_CONFIG="$TMP/apt.conf" apt-get --simulate --no-install-recommends install "${INSTALL_SPECS[@]}" >"$TMP/simulate.log" 2>&1 || { cat "$TMP/simulate.log" >&2; fail 'APT_SIMULATED_INSTALL_REJECTED'; }
if [[ -n "${AIB_APT_SIMULATION_LOG_PATH:-}" ]]; then
  SIMULATION_LOG_PATH="$(realpath -m -- "$AIB_APT_SIMULATION_LOG_PATH")"
  [[ "$SIMULATION_LOG_PATH" != "$TMP/simulate.log" ]] || fail 'APT_SIMULATION_LOG_PATH_COLLISION'
  mkdir -p -- "$(dirname -- "$SIMULATION_LOG_PATH")"
  install -m 0600 -- "$TMP/simulate.log" "$SIMULATION_LOG_PATH"
fi
if [[ "${AIB_APT_EXPECT_EXACT_SOURCE_CLOSURE:-0}" == 1 ]]; then
  python3 - "$TMP/simulate.log" "$FEED_ROOT/pool" <<'PY'
import pathlib,re,subprocess,sys
expected={}
for deb in pathlib.Path(sys.argv[2]).rglob('*.deb'):
    name=subprocess.check_output(['dpkg-deb','-f',str(deb),'Package'],text=True).strip()
    version=subprocess.check_output(['dpkg-deb','-f',str(deb),'Version'],text=True).strip()
    if name in expected: raise SystemExit('APT_SOURCE_PACKAGE_DUPLICATE:'+name)
    expected[name]=version
actual={}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not line.startswith('Inst '): continue
    match=re.match(r'^Inst ([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9-]+)? \((\S+)',line)
    if not match or match[1] in actual: raise SystemExit('APT_SIMULATION_RECORD_INVALID')
    actual[match[1]]=match[2]
if actual!=expected: raise SystemExit('APT_SIMULATED_EXACT_CLOSURE_MISMATCH')
print('APT_SIMULATED_EXACT_SOURCE_CLOSURE_OK packages='+str(len(actual)))
PY
fi
(
  cd "$TMP/downloads"
  APT_CONFIG="$TMP/apt.conf" apt-get download "${INSTALL_SPECS[@]}" >"$TMP/download.log" 2>&1 || { cat "$TMP/download.log" >&2; fail 'APT_DOWNLOAD_FAILED'; }
)
mapfile -t DOWNLOADED < <(find "$TMP/downloads" -maxdepth 1 -type f -name '*.deb' -print)
mapfile -t SOURCE_DEBS < <(find "$FEED_ROOT/pool" -type f -name '*.deb' -print)
    ((${#DOWNLOADED[@]} == ${#INSTALL_SPECS[@]} && ${#SOURCE_DEBS[@]} == EXPECTED_SOURCE_DEB_COUNT)) || fail 'DOWNLOADED_OR_SOURCE_DEB_COUNT_MISMATCH'
for spec in "${INSTALL_SPECS[@]}"; do
  requested_name="${spec%%=*}"; requested_version="${spec#*=}"
  requested_arch=''; source_root_matches=0
  for source_deb in "${SOURCE_DEBS[@]}"; do
    [[ "$(dpkg-deb -f "$source_deb" Package 2>/dev/null)" == "$requested_name" ]] || continue
    [[ "$(dpkg-deb -f "$source_deb" Version 2>/dev/null)" == "$requested_version" ]] || continue
    candidate_arch="$(dpkg-deb -f "$source_deb" Architecture 2>/dev/null)"
    [[ "$candidate_arch" == "$ARCH" || "$candidate_arch" == all ]] || fail 'SOURCE_ROOT_ARCHITECTURE_NOT_ALLOWLISTED'
    requested_arch="$candidate_arch"; ((source_root_matches += 1))
  done
  ((source_root_matches == 1)) || fail 'SOURCE_ROOT_NOT_EXACTLY_ONCE'
  if [[ "$requested_name" == "$PACKAGE" ]]; then
    [[ "$requested_arch" == "$EXPECTED_ROOT_ARCH" ]] || fail 'SOURCE_PRIMARY_ARCHITECTURE_PIN_MISMATCH'
  fi
  downloaded_matches=0
  for downloaded_deb in "${DOWNLOADED[@]}"; do
    [[ "$(dpkg-deb -f "$downloaded_deb" Package 2>/dev/null)" == "$requested_name" ]] || continue
    [[ "$(dpkg-deb -f "$downloaded_deb" Version 2>/dev/null)" == "$requested_version" ]] || fail 'DOWNLOADED_ROOT_VERSION_MISMATCH'
    [[ "$(dpkg-deb -f "$downloaded_deb" Architecture 2>/dev/null)" == "$requested_arch" ]] || fail 'DOWNLOADED_ROOT_ARCHITECTURE_MISMATCH'
    ((downloaded_matches += 1))
    downloaded_hash="$(sha256sum "$downloaded_deb" | awk '{print $1}')"; matches=0
    for source_deb in "${SOURCE_DEBS[@]}"; do
      [[ "$(dpkg-deb -f "$source_deb" Package 2>/dev/null)" == "$requested_name" ]] || continue
      [[ "$(dpkg-deb -f "$source_deb" Version 2>/dev/null)" == "$requested_version" ]] || continue
      [[ "$(dpkg-deb -f "$source_deb" Architecture 2>/dev/null)" == "$requested_arch" ]] || continue
      [[ "$(sha256sum "$source_deb" | awk '{print $1}')" == "$downloaded_hash" ]] && ((matches += 1))
    done
    ((matches == 1)) || fail 'DOWNLOADED_PACKAGE_HASH_OR_IDENTITY_MISMATCH'
  done
  ((downloaded_matches == 1)) || fail 'DOWNLOADED_ROOT_NOT_EXACTLY_ONCE'
done
printf 'APT_CANDIDATE_DOWNLOAD_AND_SIMULATED_INSTALL_OK package=%s version=%s arch=%s roots=%s signed_by=1 install_performed=0 rollback_performed=0\n' "$PACKAGE" "$VERSION" "$ARCH" "${#INSTALL_SPECS[@]}"
