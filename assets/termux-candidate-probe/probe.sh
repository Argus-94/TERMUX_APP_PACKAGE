#!/system/bin/sh
# Invoked explicitly with the embedded Bash, never by the shebang.
# TEST ONLY: authenticate, simulate and retrieve locally. Never install/extract/execute candidate packages.
set -Eeuo pipefail
umask 077
export LC_ALL=C
fail() { printf 'AIB_CANDIDATE_PROBE_FAIL: %s\n' "$*" >&2; exit 78; }
[[ $# == 1 ]] || fail 'expected staged candidate root'
ROOT=$1
[[ "$ROOT" =~ ^/data/(user/0|data)/com\.karat\.aibuilder/files/candidate-probes/probe-[a-f0-9-]{36}$ ]] || fail 'private root identity mismatch'
[[ -d "$ROOT" && ! -L "$ROOT" && "$(cd -P -- "$ROOT" && pwd -P)" == "$ROOT" ]] || fail 'noncanonical probe root'
FILES_DIR=${ROOT%/candidate-probes/*}
for dir in "$FILES_DIR" "$FILES_DIR/usr" "$FILES_DIR/home" "$FILES_DIR/candidate-probes" "$ROOT/feed"; do
  [[ -d "$dir" && ! -L "$dir" ]] || fail 'missing or redirected private directory'
done
[[ "${PREFIX:-}" == "$FILES_DIR/usr" && "${HOME:-}" == "$FILES_DIR/home" ]] || fail 'private runtime environment mismatch'
export PATH="$PREFIX/bin:$PREFIX/bin/applets:/system/bin"
APT="$PREFIX/bin/apt-get"
DPKG="$PREFIX/bin/dpkg"
GPGV="$PREFIX/bin/gpgv"
CORE="$PREFIX/bin/coreutils"
CMP="$PREFIX/bin/cmp"
for tool in "$APT" "$DPKG" "$GPGV" "$CORE" "$CMP"; do
  [[ -x "$tool" && ! -L "$tool" ]] || fail 'required bootstrap utility unavailable'
done
[[ "$UID" == "$("$CORE" stat -c %u "$FILES_DIR")" ]] || fail 'application UID mismatch'
[[ "$("$DPKG" --print-architecture)" == aarch64 ]] || fail 'private dpkg architecture mismatch'
FEED="$ROOT/feed"
KEY="$FEED/keys/aibuilder-termux-feed-keyring.gpg"
KEY_HASH=$("$CORE" sha256sum "$KEY")
[[ "${KEY_HASH%% *}" == a9ec552d8f0eb5b5d8846623e5b98ca46fce2ad4533f74301e6dbcae9cf3e3d2 ]] || fail 'pinned candidate key mismatch'
WORK="$ROOT/work"
[[ ! -e "$WORK" && ! -L "$WORK" ]] || fail 'probe already used'
"$CORE" mkdir -m 700 "$WORK"
export HOME="$WORK/home" TMPDIR="$WORK/tmp" GNUPGHOME="$WORK/gnupg"
"$CORE" mkdir -p "$HOME" "$TMPDIR" "$GNUPGHOME" "$WORK/lists/partial" "$WORK/archives/partial" "$WORK/parts" "$WORK/sources.d" "$WORK/trusted.d" "$WORK/preferences.d" "$WORK/download" "$WORK/log"
# Evidence is retained under this private UUID root, with no cleanup outside it.
verify_signer() {
  local status
  status=$("$GPGV" --homedir "$GNUPGHOME" --status-fd=1 --keyring "$KEY" "$@") || return 1
  [[ "$status" == *'[GNUPG:] VALIDSIG 90CD2EAF115DA42B87194C5C8BB5824E095857FE '* ]]
}
verify_signer "$FEED/dists/stable/Release.gpg" "$FEED/dists/stable/Release" || fail 'detached Release authentication failed'
verify_signer --output "$WORK/verified-release" "$FEED/dists/stable/InRelease" || fail 'InRelease authentication failed'
"$CMP" -s "$WORK/verified-release" "$FEED/dists/stable/Release" || fail 'Release payload disagreement'
# Real private package status is only read; APT receives a private snapshot.
[[ -f "$PREFIX/var/lib/dpkg/status" && ! -L "$PREFIX/var/lib/dpkg/status" ]] || fail 'private package status unavailable'
"$CORE" cp -- "$PREFIX/var/lib/dpkg/status" "$WORK/status"
"$CORE" chmod 400 "$WORK/status"
for empty in main.conf trusted.gpg preferences extended_states; do : > "$WORK/$empty"; done
printf 'deb [arch=aarch64 signed-by=%s] file:%s stable main\n' "$KEY" "$FEED" > "$WORK/sources.list"
cat > "$WORK/apt.conf" <<EOF
Dir "$WORK";
Dir::Etc::main "$WORK/main.conf";
Dir::Etc::parts "$WORK/parts";
Dir::Etc::sourcelist "$WORK/sources.list";
Dir::Etc::sourceparts "$WORK/sources.d";
Dir::Etc::trusted "$WORK/trusted.gpg";
Dir::Etc::trustedparts "$WORK/trusted.d";
Dir::Etc::preferences "$WORK/preferences";
Dir::Etc::preferencesparts "$WORK/preferences.d";
Dir::State "$WORK/state";
Dir::State::status "$WORK/status";
Dir::State::extended_states "$WORK/extended_states";
Dir::State::lists "$WORK/lists";
Dir::Cache "$WORK/cache";
Dir::Cache::archives "$WORK/archives";
Dir::Cache::pkgcache "$WORK/pkgcache.bin";
Dir::Cache::srcpkgcache "$WORK/srcpkgcache.bin";
Dir::Log "$WORK/log";
Dir::Bin::dpkg "$DPKG";
Dir::Bin::gpgv "$GPGV";
APT::Architecture "aarch64";
APT::Architectures { "aarch64"; };
APT::Sandbox::User "";
APT::Get::AllowUnauthenticated "false";
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
Acquire::Check-Date "true";
Acquire::Check-Valid-Until "true";
Acquire::Max-FutureTime "10";
Acquire::Languages "none";
Acquire::Retries "0";
EOF
export APT_CONFIG="$WORK/apt.conf"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
"$APT" update > "$WORK/update.log" 2>&1 || { cat "$WORK/update.log" >&2; fail 'signed APT update rejected'; }
"$APT" -s --no-remove --no-install-recommends install 'make=4.4.1-1' > "$WORK/simulate.log" 2>&1 || { cat "$WORK/simulate.log" >&2; fail 'APT simulation failed'; }
(cd "$WORK/download" && "$APT" download 'make=4.4.1-1') > "$WORK/download.log" 2>&1 || { cat "$WORK/download.log" >&2; fail 'local authenticated retrieval failed'; }
DEB="$WORK/download/make_4.4.1-1_aarch64.deb"
[[ -f "$DEB" && ! -L "$DEB" ]] || fail 'exact candidate archive missing'
DEB_HASH=$("$CORE" sha256sum "$DEB")
[[ "${DEB_HASH%% *}" == 466531ed242215361f3bf18dc995d9b3358dd422b71db2c6addeedf17f2b563f ]] || fail 'retrieved archive hash mismatch'
printf '%s\n' 'TEST_ONLY make=4.4.1-1 signature=verified retrieval=local installation=NOT_RUN candidate_execution=NOT_RUN qualified=false production=false'
printf '%s\n' AIB_CANDIDATE_PROBE_OK
