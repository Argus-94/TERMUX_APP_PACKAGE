#!/system/bin/sh
# Explicit user-approved TEST-ONLY transaction for the one pinned make package.
# No production feed, arbitrary package name, mirror, unsigned package or dependency fallback.
set -Eeuo pipefail
umask 077
fail() { printf 'AIB_CANDIDATE_MAKE_FAIL: %s\n' "$*" >&2; exit 78; }
[[ $# == 1 ]] || fail 'expected immutable native stage root'
ROOT=$1
[[ "$ROOT" =~ ^/data/user/0/com\.karat\.aibuilder/files/candidate-probes/probe-[a-f0-9-]{36}$ ]] || fail 'exact modeled app prefix required'
[[ "${PREFIX:-}" == /data/user/0/com.karat.aibuilder/files/usr && "${HOME:-}" == /data/user/0/com.karat.aibuilder/files/home ]] || fail 'wrong embedded runtime'
# Authenticate and retrieve with the exact independent production probe before any package mutation.
"$PREFIX/bin/bash" --noprofile --norc "$ROOT/probe.sh" "$ROOT" > "$ROOT/authentication.log" 2>&1 || { cat "$ROOT/authentication.log" >&2; fail 'signed delivery preflight failed'; }
export LC_ALL=C PATH="$PREFIX/bin:$PREFIX/bin/applets:/system/bin"
CORE="$PREFIX/bin/coreutils"
QUERY="$PREFIX/bin/dpkg-query"
APT="$PREFIX/bin/apt-get"
WORK="$ROOT/work"
export APT_CONFIG="$WORK/apt.conf" TMPDIR="$WORK/tmp" GNUPGHOME="$WORK/gnupg"
# Run potential package hooks with an isolated HOME, never the user's project/home configuration.
export HOME="$WORK/home"
[[ -x "$QUERY" && ! -L "$QUERY" ]] || fail 'private dpkg query unavailable'
EXPECTED_MAKE=ef187a6e59c60a46439f9d76d8d11e175fdaacd770d27b1d11bfc9749a6f4332
verify_make() {
  [[ -f "$PREFIX/bin/make" && ! -L "$PREFIX/bin/make" ]] || return 1
  local value version
  value=$("$CORE" sha256sum "$PREFIX/bin/make") || return 1
  [[ "${value%% *}" == "$EXPECTED_MAKE" ]] || return 1
  version=$("$QUERY" --admindir="$PREFIX/var/lib/dpkg" -W '-f=${db:Status-Status}\t${Version}\n' make 2>/dev/null) || return 1
  [[ "$version" == $'installed\t4.4.1-1' ]] || return 1
  "$PREFIX/bin/make" --version > "$ROOT/make-version.log" 2>&1 || return 1
  IFS= read -r version < "$ROOT/make-version.log"
  [[ "$version" == 'GNU Make 4.4.1' ]]
}
if verify_make; then
  printf '%s\n' 'TEST_ONLY make=4.4.1-1 already-present exact-payload-and-runtime-verified qualified=false production=false'
  printf '%s\n' AIB_CANDIDATE_MAKE_INSTALLED
  exit 0
fi
# Do not replace an existing installation, a conflicting package, an incomplete transaction or unowned files.
set +e
EXISTING=$("$QUERY" --admindir="$PREFIX/var/lib/dpkg" -W '-f=${binary:Package}\t${db:Status-Status}\n' make make-dev make-guile 2> "$ROOT/existing-query.log")
QUERY_EXIT=$?
set -e
[[ "$QUERY_EXIT" == 1 && -z "$EXISTING" ]] || fail 'existing or ambiguous make/conflict state; no overwrite permitted'
for rel in bin/make include/gnumake.h share/doc/make/COPYING share/info/make.info share/info/make.info-1 share/info/make.info-2 share/info/make.info-3 share/man/man1/make.1.gz; do
  path="$PREFIX/$rel"
  [[ ! -e "$path" && ! -L "$path" ]] || fail 'candidate payload would replace an existing file'
  parent=${path%/*}
  while [[ "$parent" != "$PREFIX" ]]; do
    [[ ! -L "$parent" && ( ! -e "$parent" || -d "$parent" ) ]] || fail 'redirected or invalid payload directory'
    parent=${parent%/*}
  done
done
# Never accept additional dependencies, upgrades or removals for this bounded trial.
"$APT" -o "Dir::State::status=$PREFIX/var/lib/dpkg/status" -s --no-remove --no-upgrade --no-install-recommends install 'make=4.4.1-1' > "$ROOT/install-plan.log" 2>&1 || fail 'candidate install plan rejected'
INSTALL_COUNT=0
while IFS= read -r line; do
  case "$line" in
    'Inst make ('*) INSTALL_COUNT=$((INSTALL_COUNT + 1));;
    'Inst '*|'Remv '*|'Purg '*) fail 'plan changes another package';;
  esac
done < "$ROOT/install-plan.log"
[[ "$INSTALL_COUNT" == 1 ]] || fail 'expected exactly one new make package'
"$CORE" cp -- "$PREFIX/var/lib/dpkg/status" "$ROOT/dpkg-status-before"
printf '%s\n' 'make=4.4.1-1' 'state=started' > "$ROOT/install-state.txt"
# APT authenticates the same local feed. Its indexes/logs remain isolated; only this transaction uses the real private registry.
# No force-overwrite, allow-unauthenticated, downgrade or remove option is used.
if ! "$APT" -o "Dir::State::status=$PREFIX/var/lib/dpkg/status" -o "DPkg::Options::=--admindir=$PREFIX/var/lib/dpkg" --assume-yes --no-remove --no-upgrade --no-install-recommends install 'make=4.4.1-1' > "$ROOT/install.log" 2>&1; then
  cat "$ROOT/install.log" >&2
  fail 'installation failed or incomplete; evidence retained; do not blindly retry or restore the status file'
fi
verify_make || fail 'post-install version, payload or runtime check failed; installation outcome unconfirmed'
printf '%s\n' 'make=4.4.1-1' 'state=verified' > "$ROOT/install-state.txt"
printf '%s\n' 'TEST_ONLY make=4.4.1-1 installed=verified candidate-runtime=version-probed qualified=false production=false'
printf '%s\n' AIB_CANDIDATE_MAKE_INSTALLED
