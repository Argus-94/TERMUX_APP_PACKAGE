#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT="$ROOT/scripts/validate-aib-v507-offline-bundle.py"
LOCK="$ROOT/termux-private-package-kit/v507/package-lock.json"
fail(){ printf 'AIB_V507_APT_REJECTED:%s\n' "$1" >&2; exit 2; }
[[ $# -eq 2 ]] || fail 'USAGE: test-aib-v507-offline-apt.sh FEED_ROOT BOOTSTRAP_STATUS'
FEED="$(realpath -e -- "$1")"; STATUS="$(realpath -e -- "$2")"; BUNDLE="$(dirname -- "$FEED")"
for t in apt-get python3; do command -v "$t" >/dev/null || fail "TOOL_MISSING_$t"; done
[[ -s "$STATUS" && -s "$BUNDLE/manifest.json" ]] || fail 'STATUS_OR_MANIFEST_MISSING'
# This CI-only source trust follows verification of every feed file against the build manifest.
python3 "$AUDIT" verify-manifest --root "$BUNDLE"
python3 - "$LOCK" "$STATUS" <<'PY'
import hashlib,json,pathlib,sys
lock=json.loads(pathlib.Path(sys.argv[1]).read_text()); p=pathlib.Path(sys.argv[2])
assert hashlib.sha256(p.read_bytes()).hexdigest()==lock['bootstrap']['statusSha256'], 'BOOTSTRAP_STATUS_HASH_MISMATCH'
PY
TMP="$(mktemp -d "${TMPDIR:-/tmp}/aib-v507-apt.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP/lists/partial" "$TMP/archives/partial" "$TMP/parts" "$TMP/sources.d" "$TMP/trusted.d" "$TMP/preferences.d"
cp -- "$STATUS" "$TMP/status"
: > "$TMP/extended_states"; : > "$TMP/empty-trust-store"; : > "$TMP/apt-main.conf"; : > "$TMP/preferences"
# trusted=yes is confined to this temporary file: source after manifest hashes pass; no network source is configured.
printf 'deb [arch=aarch64 trusted=yes] file:%s stable main\n' "$FEED" > "$TMP/sources.list"
cat > "$TMP/apt.conf" <<EOF
Dir {
  Etc { main "$TMP/apt-main.conf"; parts "$TMP/parts"; sourcelist "$TMP/sources.list"; sourceparts "$TMP/sources.d"; trusted "$TMP/empty-trust-store"; trustedparts "$TMP/trusted.d"; preferences "$TMP/preferences"; preferencesparts "$TMP/preferences.d"; };
  State { lists "$TMP/lists/"; lists::partial "$TMP/lists/partial/"; status "$TMP/status"; extended_states "$TMP/extended_states"; };
  Cache { archives "$TMP/archives/"; archives::partial "$TMP/archives/partial/"; pkgcache "$TMP/pkgcache.bin"; srcpkgcache "$TMP/srcpkgcache.bin"; }
  Log { History "$TMP/history.log"; Terminal "$TMP/terminal.log"; Planner "$TMP/planner.log"; }
}
APT::Architecture "aarch64";
APT::Architectures { "aarch64"; };
APT::Get::AllowUnauthenticated "false";
APT::Get::AllowInsecureRepositories "false";
Acquire::Languages "none";
Acquire::Retries "0";
Acquire::http::Proxy "http://127.0.0.1:9";
Acquire::https::Proxy "http://127.0.0.1:9";
Acquire::ftp::Proxy "http://127.0.0.1:9";
EOF
apt-get -c "$TMP/apt.conf" -o Debug::NoLocking=1 update >"$TMP/update.log" 2>&1 || { tail -40 "$TMP/update.log" >&2; fail 'LOCAL_FILE_ONLY_APT_UPDATE_FAILED'; }
mapfile -t NAMES < <(python3 - "$FEED/dists/stable/main/binary-aarch64/Packages" <<'PY'
import pathlib,sys
text=pathlib.Path(sys.argv[1]).read_text()
for n in sorted({b.splitlines()[0].partition(':')[2].strip() for b in text.split('\n\n') if b.strip() and b.splitlines()[0].startswith('Package: ')}): print(n)
PY
)
((${#NAMES[@]} > 0)) || fail 'EMPTY_PACKAGE_NAME_SET'
REMOVE_PATTERN='(^[[:space:]]*(Remv|Remove)[[:space:]]|^[[:space:]]*[0-9]+(:[0-9]+)? upgraded, [0-9]+ newly installed, [1-9][0-9]* to remove([[:space:]]|$)|^[[:space:]]*The following packages will be REMOVED:)'
# Regression fixtures: APT's harmless "0 to remove" summary must not look like an action.
if printf '%s\n' '36:25 upgraded, 106 newly installed, 0 to remove and 0 not upgraded.' | grep -Eiq "$REMOVE_PATTERN"; then fail 'REMOVAL_PARSER_FALSE_POSITIVE'; fi
printf '%s\n' 'Remv old-package [1.0] [2.0]' | grep -Eiq "$REMOVE_PATTERN" || fail 'REMOVAL_PARSER_MISSED_ACTION'
printf '%s\n' '1 upgraded, 0 newly installed, 1 to remove and 0 not upgraded.' | grep -Eiq "$REMOVE_PATTERN" || fail 'REMOVAL_PARSER_MISSED_NONZERO_SUMMARY'
apt-get -c "$TMP/apt.conf" -o Debug::NoLocking=1 --simulate --no-download --no-install-recommends --no-remove install "${NAMES[@]}" >"$TMP/simulate.log" 2>&1 || { tail -80 "$TMP/simulate.log" >&2; fail 'LOCAL_NO_DOWNLOAD_SIMULATION_FAILED'; }
if grep -Eiq "$REMOVE_PATTERN" "$TMP/simulate.log"; then
  printf 'AIB_V507_APT_PLAN_REMOVALS_BEGIN\n' >&2
  grep -Ein "$REMOVE_PATTERN" "$TMP/simulate.log" >&2 || true
  printf 'AIB_V507_APT_PLAN_TAIL_BEGIN\n' >&2
  tail -80 "$TMP/simulate.log" >&2
  fail 'APT_PLANNED_REMOVAL'
fi
printf 'AIB_V507_LOCAL_APT_UPDATE_AND_SIMULATION_OK names=%s download=NO install=NO remove=NO recommends=NO network_sources=NONE arch=aarch64 manifest_hashes=verified\n' "${#NAMES[@]}"
