#!/system/bin/sh
# Source template, rendered with sealed CI pins. Only embedded private bash may invoke it.
set -Eeuo pipefail
umask 077
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
fail(){ printf 'AIB_FULL_CANDIDATE_FAIL: %s\n' "$*" >&2; exit 78; }
[[ $# -ge 2 ]] || fail 'usage: CACHE ACTION [PACKAGE ...]'
CACHE=$1 ACTION=$2; shift 2
[[ "$ACTION" =~ ^(verify|install|reinstall|remove|check)$ ]] || fail 'unknown action'
case "$CACHE" in /data/user/0/com.karat.aibuilder/files/candidate-feed-45ae9894c036|/data/data/com.karat.aibuilder/files/candidate-feed-45ae9894c036) ;; *) fail 'cache identity mismatch';; esac
[[ -d "$CACHE" && ! -L "$CACHE" && "$(cd -P -- "$CACHE" && pwd -P)" == "$CACHE" ]] || fail 'noncanonical cache'
FILES=${CACHE%/candidate-feed-45ae9894c036}
case "${PREFIX:-}" in /data/user/0/com.karat.aibuilder/files/usr|/data/data/com.karat.aibuilder/files/usr) ;; *) fail 'private PREFIX required';; esac
case "${HOME:-}" in /data/user/0/com.karat.aibuilder/files/home|/data/data/com.karat.aibuilder/files/home) ;; *) fail 'private HOME required';; esac
[[ ! -L "$PREFIX" && ! -L "$HOME" && "$(cd -P -- "$PREFIX" && pwd -P)" == "$FILES/usr" && "$(cd -P -- "$HOME" && pwd -P)" == "$FILES/home" ]] || fail 'private runtime mismatch'
export PREFIX=$FILES/usr HOME=$FILES/home PATH="$FILES/usr/bin:$FILES/usr/bin/applets:/system/bin"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy ftp_proxy FTP_PROXY
APT=$PREFIX/bin/apt-get DPKG=$PREFIX/bin/dpkg DQ=$PREFIX/bin/dpkg-query GPGV=$PREFIX/bin/gpgv CORE=$PREFIX/bin/coreutils COREBIN=$PREFIX/bin CMP=$PREFIX/bin/cmp DF=$PREFIX/bin/df
for tool in "$APT" "$DPKG" "$DQ" "$GPGV" "$CORE" "$CMP"; do [[ -x "$tool" && -f "$tool" && ! -L "$tool" ]] || fail "private tool unavailable: $tool"; done
core(){
 local applet=$1; shift
 case "$applet" in stat|sha256sum|mkdir|mktemp|cp|cat|readlink) ;; *) fail "coreutils applet denied: $applet";; esac
 "$COREBIN/$applet" "$@"
}
for applet in stat sha256sum mkdir mktemp cp cat readlink; do appletPath=$COREBIN/$applet; [[ -L "$appletPath" && -x "$appletPath" && -f "$appletPath" ]] || fail "private coreutils applet unavailable: $applet"; done
[[ "$UID" == "$(core stat -c %u "$FILES")" && "$("$DPKG" --print-architecture)" == aarch64 ]] || fail 'UID/architecture mismatch'
for f in packages.tsv payloads.tsv bootstrap-baseline.tsv keys/aibuilder-termux-feed-keyring.gpg dists/stable/Release dists/stable/Release.gpg dists/stable/InRelease; do [[ -f "$CACHE/$f" && ! -L "$CACHE/$f" ]] || fail "missing cache file: $f"; done
safe_path(){ [[ -n "$1" && "$1" != /* && "/$1/" != *'/../'* && "/$1/" != *'/./'* && "$1" != *\\* && "$1" != *$'\t'* && "$1" != *$'\r'* && "$1" != *$'\n'* ]]; }
declare -A BASEK=() BASEV=()
dfExpected=
while IFS=$'\t' read -r r kind expected extra; do
 [[ -n "$r" ]] || continue
 [[ -z "${extra:-}" && "$kind" =~ ^(file|symlink)$ && -z "${BASEK[$r]+x}" ]] && safe_path "$r" || fail 'malformed bootstrap baseline'
 if [[ "$kind" == file ]]; then [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail 'malformed bootstrap file pin'; else [[ -n "$expected" ]] || fail 'malformed bootstrap symlink pin'; fi
 BASEK[$r]=$kind BASEV[$r]=$expected
 if [[ "$r" == bin/df ]]; then [[ "$kind" == file && -z "$dfExpected" ]] || fail 'invalid private df baseline'; dfExpected=$expected; fi
done < "$CACHE/bootstrap-baseline.tsv"
[[ -n "$dfExpected" ]] || fail 'private df baseline unavailable'
[[ -f "$DF" && ! -L "$DF" && -x "$DF" ]] || fail 'pinned private df unavailable'
hash=$(core sha256sum "$DF"); [[ ${hash%% *} == "$dfExpected" ]] || fail 'pinned private df baseline mismatch'
if [[ "$ACTION" == install || "$ACTION" == reinstall ]]; then
 dfOutput=$("$DF" -kP "$FILES") || fail 'private storage query failed'
 dfHeader=${dfOutput%%$'\n'*}; dfRow=${dfOutput#*$'\n'}
 [[ "$dfHeader" != "$dfOutput" && "$dfRow" != *$'\n'* ]] || fail 'private storage report malformed'
 read -r h1 h2 h3 h4 h5 h6 h7 hExtra <<< "$dfHeader"
 [[ -z "${hExtra:-}" && "$h1" == Filesystem && "$h2" =~ ^(1K-blocks|1024-blocks)$ && "$h3" == Used && "$h4" == Available && "$h5" =~ ^(Use%|Capacity)$ && "$h6" == Mounted && "$h7" == on ]] || fail 'private storage report malformed'
 read -r device total used available capacity mount extra <<< "$dfRow"
 [[ -z "${extra:-}" && -n "$device" && "$total" =~ ^[0-9]{1,18}$ && "$used" =~ ^[0-9]{1,18}$ && "$available" =~ ^[0-9]{1,18}$ && "$capacity" =~ ^([0-9]+%|-)$ && "$mount" == /* ]] || fail 'private storage report malformed'
 requiredBlocks=$(((1054357464 + 1023) / 1024))
 availableBlocks=$((10#$available))
 (( availableBlocks >= requiredBlocks )) || fail 'insufficient private storage for coherent installation'
fi
KEY=$CACHE/keys/aibuilder-termux-feed-keyring.gpg
hash=$(core sha256sum "$KEY"); [[ ${hash%% *} == 4071d14f1a4a1ab263c892fbdb3d061c6e38bd9ea40a6085026aacf23f823136 ]] || fail 'key hash mismatch'
WORKBASE=$FILES/candidate-transactions
[[ ! -L "$WORKBASE" ]] || fail 'redirected transaction directory'
if [[ ! -e "$WORKBASE" ]]; then core mkdir "$WORKBASE" || fail 'cannot create transaction directory'; fi
[[ -d "$WORKBASE" && "$(cd -P -- "$WORKBASE" && pwd -P)" == "$WORKBASE" && "$(core stat -c %u "$WORKBASE")" == "$UID" ]] || fail 'unsafe transaction directory'
WORK=$(core mktemp -d "$WORKBASE/tx-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX") || fail 'cannot create transaction'
printf 'AIB_FULL_CANDIDATE_EVIDENCE:%s\n' "$WORK"
MUTATED=0
trap 'rc=$?; printf "exit=%s action=%s mutationStarted=%s\n" "$rc" "$ACTION" "$MUTATED" >> "$WORK/result.log" 2>/dev/null || :; if [[ $rc != 0 && $MUTATED == 1 ]]; then printf "AIB_FULL_CANDIDATE_PARTIAL_RUNTIME_REPAIR_REQUIRED\n" >&2; fi; exit "$rc"' EXIT
export HOME=$WORK/home TMPDIR=$WORK/tmp GNUPGHOME=$WORK/gnupg
core mkdir -p "$HOME" "$TMPDIR" "$GNUPGHOME" "$WORK/lists/partial" "$WORK/archives/partial" "$WORK/parts" "$WORK/sources.d" "$WORK/trusted.d" "$WORK/preferences.d" "$WORK/log" "$WORK/state" "$WORK/downloads" "$WORK/cache"
verify_signer(){
 local status
 status=$("$GPGV" --homedir "$GNUPGHOME" --status-fd=1 --keyring "$KEY" "$@") || return 1
 [[ "$status" == *'[GNUPG:] VALIDSIG D2B7B46268D4CFC6FB24F18B4A43721D99DF1343 '* && "$status" != *EXPKEYSIG* && "$status" != *REVKEYSIG* && "$status" != *BADSIG* && "$status" != *ERRSIG* && "$status" != *KEYEXPIRED* ]]
}
verify_signer "$CACHE/dists/stable/Release.gpg" "$CACHE/dists/stable/Release" || fail 'detached signature invalid'
verify_signer --output "$WORK/verified-release" "$CACHE/dists/stable/InRelease" || fail 'inline signature invalid'
"$CMP" -s "$WORK/verified-release" "$CACHE/dists/stable/Release" || fail 'signature payload mismatch'
declare -A V=() ARCH=() HASH=() REL=() BYHASH=() DOWNLOADED=() SELECT=() PLAN=() REMOVALS=() PROTECTED=() OWN=()
private_registry_path(){
 local path=$1 r
 [[ "$path" != / ]] || return 0
 path=${path%/}
 case "$path" in
  /.|/data|/data/user|/data/user/0|/data/user/0/com.karat.aibuilder|/data/user/0/com.karat.aibuilder/files|/data/user/0/com.karat.aibuilder/files/usr|/data/user/0/com.karat.aibuilder/files/usr/.|/data/data|/data/data/com.karat.aibuilder|/data/data/com.karat.aibuilder/files|/data/data/com.karat.aibuilder/files/usr|/data/data/com.karat.aibuilder/files/usr/.) return 0;;
  /data/user/0/com.karat.aibuilder/files/usr/*) r=${path#/data/user/0/com.karat.aibuilder/files/usr/}; safe_path "$r";;
  /data/data/com.karat.aibuilder/files/usr/*) r=${path#/data/data/com.karat.aibuilder/files/usr/}; safe_path "$r";;
  *) return 1;;
 esac
}
count=0
while IFS=$'\t' read -r p v a h r extra; do
 [[ -n "$p" ]] || continue
 [[ -z "${extra:-}" && "$p" =~ ^[a-z0-9][a-z0-9+.-]{0,127}$ && "$v" =~ ^[A-Za-z0-9.+:~_-]+$ && "$a" =~ ^(aarch64|all)$ && "$h" =~ ^[0-9a-f]{64}$ && "$r" == pool/* && -z "${V[$p]+x}" && -z "${BYHASH[$h]+x}" ]] && safe_path "$r" || fail 'malformed package catalog'
 V[$p]=$v ARCH[$p]=$a HASH[$p]=$h REL[$p]=$r BYHASH[$h]=$p; ((count+=1))
done < "$CACHE/packages.tsv"
[[ $count == 82 ]] || fail 'package count is not 82'
while IFS=$'\t' read -r p r kind expected extra; do
 [[ -n "$p" ]] || continue
 [[ -z "${extra:-}" && -n "${V[$p]+x}" && "$kind" =~ ^(file|conffile|symlink|dir)$ ]] || fail 'malformed payload manifest'
 [[ "$r" == . && "$kind" == dir ]] || safe_path "$r" || fail 'unsafe payload path'
 [[ ( "$kind" != file && "$kind" != conffile ) || "$expected" =~ ^[0-9a-f]{64}$ ]] || fail 'bad payload hash'
 if [[ "$kind" != dir && -n "${BASEK[$r]+x}" ]]; then PROTECTED[$p]=1; fi
done < "$CACHE/payloads.tsv"
if [[ "$ACTION" == verify || "$ACTION" == check ]]; then [[ $# == 0 ]] || fail 'read-only actions take no selections'; else [[ $# -ge 1 && $# -le 82 ]] || fail 'supply 1..82 package names'; fi
for p in "$@"; do
 [[ "$p" =~ ^[a-z0-9][a-z0-9+.-]{0,127}$ && -n "${V[$p]+x}" && -z "${SELECT[$p]+x}" ]] || fail 'unknown/duplicate package'
 SELECT[$p]=1
done
while IFS=$'\t' read -r p v a h r; do
 [[ -f "$CACHE/$r" && ! -L "$CACHE/$r" ]] || fail "archive missing: $p"
 got=$(core sha256sum "$CACHE/$r"); [[ ${got%% *} == "$h" ]] || fail "archive hash mismatch: $p"
done < "$CACHE/packages.tsv"
for directory in "$PREFIX/var" "$PREFIX/var/lib" "$PREFIX/var/lib/dpkg"; do [[ -d "$directory" && ! -L "$directory" ]] || fail 'redirected private registry'; done
STATUS=$PREFIX/var/lib/dpkg/status
[[ -f "$STATUS" && ! -L "$STATUS" ]] || fail 'private status unavailable'
core cp "$STATUS" "$WORK/status"
for f in main.conf trusted.gpg preferences extended_states; do : > "$WORK/$f"; done
printf 'deb [arch=aarch64 signed-by=%s] file:%s stable main\n' "$KEY" "$CACHE" > "$WORK/sources.list"
core cat > "$WORK/apt.conf" <<EOF
Dir "$WORK";
Dir::Etc::main "$WORK/main.conf"; Dir::Etc::parts "$WORK/parts"; Dir::Etc::sourcelist "$WORK/sources.list"; Dir::Etc::sourceparts "$WORK/sources.d"; Dir::Etc::trusted "$WORK/trusted.gpg"; Dir::Etc::trustedparts "$WORK/trusted.d"; Dir::Etc::preferences "$WORK/preferences"; Dir::Etc::preferencesparts "$WORK/preferences.d";
Dir::State "$WORK/state"; Dir::State::status "$WORK/status"; Dir::State::extended_states "$WORK/extended_states"; Dir::State::lists "$WORK/lists";
Dir::Cache "$WORK/cache"; Dir::Cache::archives "$WORK/archives"; Dir::Cache::pkgcache "$WORK/pkgcache.bin"; Dir::Cache::srcpkgcache "$WORK/srcpkgcache.bin"; Dir::Log "$WORK/log";
Dir::Bin::dpkg "$DPKG"; Dir::Bin::gpgv "$GPGV"; Dir::Bin::methods "$PREFIX/lib/apt/methods";
APT::Architecture "aarch64"; APT::Architectures { "aarch64"; }; APT::Sandbox::User "";
APT::Get::AllowUnauthenticated "false"; Acquire::AllowInsecureRepositories "false"; Acquire::AllowDowngradeToInsecureRepositories "false";
Acquire::Check-Date "true"; Acquire::Check-Valid-Until "true"; Acquire::Max-FutureTime "10"; Acquire::Languages "none"; Acquire::Retries "0";
EOF
export APT_CONFIG=$WORK/apt.conf
"$APT" update > "$WORK/update.log" 2>&1 || { core cat "$WORK/update.log" >&2; fail 'authenticated APT update failed'; }
query(){ "$DQ" --admindir="$PREFIX/var/lib/dpkg" -W -f='${Status}\t${Version}' "$1" 2>/dev/null || :; }
if [[ "$ACTION" == verify || "$ACTION" == check ]]; then
 if [[ "$ACTION" == check ]]; then
  while IFS=$'\t' read -r p v a h r; do
   actual=$(query "$p")
   if [[ "$actual" == install\ ok\ installed$'\t'* ]]; then printf 'AIB_FULL_CANDIDATE_PACKAGE:%s:installed:%s\n' "$p" "${actual##*$'\t'}"; else printf 'AIB_FULL_CANDIDATE_PACKAGE:%s:absent:-\n' "$p"; fi
  done < "$CACHE/packages.tsv"
 fi
 printf 'AIB_FULL_CANDIDATE_OK:%s\n' "$ACTION"; exit 0
fi
if [[ "$ACTION" == remove ]]; then
 for p in "${!SELECT[@]}"; do
  [[ -z "${PROTECTED[$p]+x}" ]] || fail "bootstrap removal forbidden: $p"
  essential=$("$DQ" --admindir="$PREFIX/var/lib/dpkg" -W -f='${Essential}' "$p" 2>/dev/null || :)
  [[ "$essential" != yes ]] || fail "essential removal forbidden: $p"
  "$DQ" --admindir="$PREFIX/var/lib/dpkg" -L "$p" > "$WORK/removal-owned-$p" 2>/dev/null || :
  while IFS= read -r path; do private_registry_path "$path" || fail "registered removal path outside private runtime: $p"; done < "$WORK/removal-owned-$p"
 done
fi
declare -a SPECS=()
if [[ "$ACTION" == install || "$ACTION" == reinstall ]]; then
 # The entire signed coherent cohort is the tested install unit.
 while IFS=$'\t' read -r p v a h r; do SPECS+=("$p=$v"); done < "$CACHE/packages.tsv"
 "$APT" -s --no-remove --no-install-recommends --reinstall install "${SPECS[@]}" > "$WORK/plan.log" 2>&1 || { core cat "$WORK/plan.log" >&2; fail 'coherent APT plan failed'; }
else
 SPECS=("$@")
 "$APT" -s --no-install-recommends remove "${SPECS[@]}" > "$WORK/plan.log" 2>&1 || fail 'remove plan failed'
fi
instre='^Inst[[:space:]]+([^[:space:]]+)([[:space:]]+\[[^]]*\])?[[:space:]]+\(([^[:space:]]+)'
remre='^Remv[[:space:]]+([^[:space:]]+)'
confre='^Conf[[:space:]]+([^[:space:]]+)[[:space:]]+\(([^[:space:]]+)'
while IFS= read -r line; do
 if [[ "$line" == Inst\ * ]]; then
  [[ "$ACTION" != remove && "$line" =~ $instre ]] || fail 'unexpected/malformed install plan'
  p=${BASH_REMATCH[1]} v=${BASH_REMATCH[3]}
  [[ -n "${V[$p]+x}" && "$v" == "${V[$p]}" && -z "${PLAN[$p]+x}" ]] || fail 'install plan outside exact catalog'
  current=$(query "$p")
  if [[ "$current" == *$'\t'* ]]; then old=${current##*$'\t'}; "$DPKG" --compare-versions "$v" ge "$old" || fail "downgrade or invalid prior version: $p"; fi
  PLAN[$p]=$v
 elif [[ "$line" == Remv\ * ]]; then
  [[ "$ACTION" == remove && "$line" =~ $remre ]] || fail 'removal during installation forbidden'
  p=${BASH_REMATCH[1]}
  [[ -n "${SELECT[$p]+x}" && -z "${REMOVALS[$p]+x}" && -z "${PROTECTED[$p]+x}" ]] || fail 'unselected removal forbidden'
  REMOVALS[$p]=1
 elif [[ "$line" == Conf\ * ]]; then
  [[ "$ACTION" != remove && "$line" =~ $confre ]] || fail 'unexpected configuration plan'
  p=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}; [[ -n "${V[$p]+x}" && "$v" == "${V[$p]}" ]] || fail 'configuration outside exact catalog'
 fi
done < "$WORK/plan.log"
if [[ "$ACTION" == remove ]]; then [[ ${#REMOVALS[@]} == ${#SELECT[@]} ]] || fail 'incomplete removal plan'; else [[ ${#PLAN[@]} == 82 ]] || fail 'incomplete coherent install plan'; fi
check_ancestors(){
 local r=$1 part rest=$1 current=$PREFIX
 [[ "$r" != . ]] || return 0
 while [[ "$rest" == */* ]]; do
  part=${rest%%/*}; rest=${rest#*/}; current=$current/$part
  [[ ! -L "$current" && ( ! -e "$current" || -d "$current" ) ]] || return 1
 done
}
if [[ "$ACTION" != remove ]]; then
 for p in "${!PLAN[@]}"; do
  "$DQ" --admindir="$PREFIX/var/lib/dpkg" -L "$p" > "$WORK/owned-$p" 2>/dev/null || :
  while IFS= read -r path; do
   private_registry_path "$path" || fail "registered install path outside private runtime: $p"
   case "$path" in /data/user/0/com.karat.aibuilder/files/usr/*) r=${path#/data/user/0/com.karat.aibuilder/files/usr/};; /data/data/com.karat.aibuilder/files/usr/*) r=${path#/data/data/com.karat.aibuilder/files/usr/};; *) continue;; esac
   safe_path "$r" || fail 'unsafe registry path'
   if [[ -z "${OWN[$r]+x}" || "${OWN[$r]}" == "$p" ]]; then OWN[$r]=$p; else OWN[$r]=MULTIPLE; fi
  done < "$WORK/owned-$p"
 done
 while IFS=$'\t' read -r p r kind expected; do
  [[ -n "$p" ]] || continue
  check_ancestors "$r" || fail "redirected payload ancestor: $r"
  target=$PREFIX/$r
 [[ "$kind" != conffile || ! -L "$target" ]] || fail "conffile redirection before mutation: $r"
  if [[ "$kind" == dir ]]; then [[ ! -L "$target" && ( ! -e "$target" || -d "$target" ) ]] || fail "directory collision: $r"; continue; fi
  [[ -e "$target" || -L "$target" ]] || continue
  [[ "${OWN[$r]:-}" == "$p" ]] && continue
  allowed=0
  if [[ "${BASEK[$r]:-}" == file && -f "$target" && ! -L "$target" ]]; then digest=$(core sha256sum "$target"); [[ ${digest%% *} != "${BASEV[$r]}" ]] || allowed=1
  elif [[ "${BASEK[$r]:-}" == symlink && -L "$target" ]]; then [[ "$(core readlink "$target")" != "${BASEV[$r]}" ]] || allowed=1; fi
  if [[ $allowed == 0 && ( "$kind" == file || "$kind" == conffile ) && -f "$target" && ! -L "$target" ]]; then digest=$(core sha256sum "$target"); [[ ${digest%% *} != "$expected" ]] || allowed=1; fi
  if [[ $allowed == 0 && "$kind" == symlink && -L "$target" ]]; then [[ "$(core readlink "$target")" != "$expected" ]] || allowed=1; fi
  [[ $allowed == 1 ]] || fail "unowned or modified payload collision: $r"
 done < "$CACHE/payloads.tsv"
 ( cd "$WORK/downloads"; "$APT" download "${SPECS[@]}" ) > "$WORK/download.log" 2>&1 || fail 'authenticated archive download failed'
 shopt -s nullglob; copied=("$WORK/downloads/"*.deb); shopt -u nullglob
 [[ ${#copied[@]} == 82 ]] || fail 'downloaded archive count mismatch'
 # APT percent-encodes epoch colons. Signed bytes, not local filenames, identify archives.
 for archive in "${copied[@]}"; do
  [[ -f "$archive" && ! -L "$archive" ]] || fail 'download is not a regular file'
  digest=$(core sha256sum "$archive"); digest=${digest%% *}
  [[ -n "${BYHASH[$digest]+x}" ]] || fail 'download outside signed catalog'
  p=${BYHASH[$digest]}; [[ -z "${DOWNLOADED[$p]+x}" ]] || fail 'duplicate downloaded signed identity'
  DOWNLOADED[$p]=1
 done
 [[ ${#DOWNLOADED[@]} == 82 ]] || fail 'incomplete signed archive set'
fi
"$CMP" -s "$STATUS" "$WORK/status" || fail 'private registry changed during preparation'
printf 'Dir::State::status "%s";\nDPkg::Options { "--admindir=%s/var/lib/dpkg"; "--instdir=/"; "--force-confold"; };\n' "$STATUS" "$PREFIX" >> "$WORK/apt.conf"
MUTATED=1
if [[ "$ACTION" == remove ]]; then
 "$APT" -y --no-install-recommends remove "${SPECS[@]}" > "$WORK/apply.log" 2>&1 || fail 'remove transaction failed'
 for p in "${!SELECT[@]}"; do actual=$(query "$p"); [[ "$actual" != install\ ok\ installed$'\t'* ]] || fail "package remains installed: $p"; done
 for p in "${!SELECT[@]}"; do printf 'AIB_FULL_CANDIDATE_PACKAGE:%s:absent:-\n' "$p"; done
else
 "$APT" -y --no-remove --no-install-recommends --reinstall install "${SPECS[@]}" > "$WORK/apply.log" 2>&1 || fail 'coherent install transaction failed'
 for p in "${!V[@]}"; do actual=$(query "$p"); [[ "$actual" == install\ ok\ installed$'\t'"${V[$p]}" ]] || fail "private registry outcome mismatch: $p"; done
 : > "$WORK/installed.sha256"
 while IFS=$'\t' read -r p r kind expected; do
  [[ -n "$p" ]] || continue
  check_ancestors "$r" || fail "redirected installed ancestor: $r"
  target=$PREFIX/$r
  case "$kind" in
   file) [[ -f "$target" && ! -L "$target" ]] || fail "installed file missing: $r"; printf '%s  %s\n' "$expected" "$target" >> "$WORK/installed.sha256";;
   conffile) [[ -f "$target" && ! -L "$target" ]] || fail "installed conffile missing/redirected: $r"; digest=$(core sha256sum "$target"); printf '%s\t%s\t%s\t%s\n' "$p" "$r" "$expected" "${digest%% *}" >> "$WORK/config-state.tsv";;
   symlink) [[ -L "$target" && "$(core readlink "$target")" == "$expected" ]] || fail "installed link mismatch: $r";;
   dir) [[ -d "$target" && ! -L "$target" ]] || fail "installed directory mismatch: $r";;
  esac
 done < "$CACHE/payloads.tsv"
 core sha256sum --check --status "$WORK/installed.sha256" > "$WORK/payload-verification.log" 2>&1 || fail 'installed payload hash mismatch (immutable signed payload)'
 printf 'AIB_FULL_CANDIDATE_COHORT:82\n'
 while IFS=$'\t' read -r p v a h r; do printf 'AIB_FULL_CANDIDATE_PACKAGE:%s:installed:%s\n' "$p" "$v"; done < "$CACHE/packages.tsv"
fi
printf 'AIB_FULL_CANDIDATE_OK:%s\n' "$ACTION"
