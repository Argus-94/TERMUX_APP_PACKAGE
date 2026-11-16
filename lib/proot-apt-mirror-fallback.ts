import type { ProotDistroAlias } from "./proot-distro-state.ts";

export type ProotAptUpdateClass =
  | "success"
  | "transport"
  | "signature"
  | "http-client"
  | "package"
  | "permission-disk"
  | "unsupported"
  | "unknown";

export type ProotAptFallbackResult = "installed" | "not-eligible" | "failed" | "signature" | "unsupported" | "transport-exhausted" | "install-failed";

const SAFE_APT_PACKAGES = /^[a-z0-9][a-z0-9.+:-]{0,100}$/;
const ALIASES: readonly ProotDistroAlias[] = ["debian", "ubuntu"];

/** Fixed official endpoints only; no registry scraping or log-supplied URLs. */
export const PROOT_APT_OFFICIAL_FALLBACK_ENDPOINTS = Object.freeze({
  debian: "https://deb.debian.org/debian",
  ubuntuArchive: "https://archive.ubuntu.com/ubuntu",
  ubuntuPorts: "https://ports.ubuntu.com/ubuntu-ports",
});

/**
 * Classify only machine markers emitted by buildProotAptSourceUpdateCommand.
 * Raw apt output is kept in guest-local temporary files and never forwarded to
 * app logs, where a source URL could contain userinfo.
 */
export function classifyProotAptSourceUpdate(result: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
}): ProotAptUpdateClass {
  if (result.timedOut || result.outputTruncated) return "unknown";
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/^AIB_APT_SOURCE_UPDATE_CLASS:(success|transport|signature|http-client|package|permission-disk|unsupported|unknown)$/m);
  if (!match) return "unknown";
  return match[1] as ProotAptUpdateClass;
}

export function parseProotAptFallbackResult(result: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
}): ProotAptFallbackResult {
  if (result.timedOut || result.outputTruncated) return "failed";
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/^AIB_APT_FALLBACK_RESULT:(installed|not-eligible|failed|signature|unsupported|transport-exhausted|install-failed)$/m);
  if (!match || result.exitCode !== 0) return match?.[1] === "signature" ? "signature" : match?.[1] === "unsupported" ? "unsupported" : match?.[1] === "transport-exhausted" ? "transport-exhausted" : match?.[1] === "install-failed" ? "install-failed" : match?.[1] === "not-eligible" ? "not-eligible" : "failed";
  return match[1] as ProotAptFallbackResult;
}

/**
 * Run apt-get update using only the guest's existing configuration, but capture
 * the transcript locally and emit normalized markers rather than source URLs.
 * One subsequent fallback attempt is permitted only for class=transport.
 */
export function buildProotAptSourceUpdateCommand(
  aliasInput: ProotDistroAlias,
  paths: Readonly<{ guestRoot?: string }> = {},
): string {
  const alias = safeAlias(aliasInput);
  const root = safeGuestRoot(paths.guestRoot ?? "/");
  const aptDir = root === "/" ? "/etc/apt" : `${root}/etc/apt`;
  const aptDirQ = `'${aptDir.replace(/'/g, `'\\''`)}'`;
  return `${aptClassifierShell()}
set +e
umask 077
AIB_APT_DIR=${aptDirQ}
if [ -n "\${APT_CONFIG-}" ]; then
  echo AIB_APT_SOURCE_UPDATE_CLASS:unsupported
  echo AIB_APT_SOURCE_UPDATE_EXIT:custom-apt-config
  exit 78
fi
for _conf in "$AIB_APT_DIR/apt.conf" "$AIB_APT_DIR"/apt.conf.d/*; do
  [ -f "$_conf" ] || continue
  if grep -Eiq 'AllowInsecureRepositories|AllowDowngradeToInsecureRepositories|AllowUnauthenticated|Check-Valid-Until|Check-Date|Trusted[[:space:]]*[:=]' "$_conf" 2>/dev/null; then
    echo AIB_APT_SOURCE_UPDATE_CLASS:unsupported
    echo AIB_APT_SOURCE_UPDATE_EXIT:insecure-config-override
    exit 78
  fi
done
for _source in "$AIB_APT_DIR/sources.list" "$AIB_APT_DIR"/sources.list.d/*.list "$AIB_APT_DIR"/sources.list.d/*.sources; do
  [ -f "$_source" ] || continue
  if grep -Eiq 'trusted[[:space:]]*=[[:space:]]*(yes|true|1)|^[[:space:]]*trusted[[:space:]]*:[[:space:]]*(yes|true|1)|allow-(insecure|weak|downgrade-to-insecure)|Allow-Insecure:[[:space:]]*(yes|true|1)|Allow-Weak:[[:space:]]*(yes|true|1)|Check-Valid-Until:[[:space:]]*(no|false|0)' "$_source" 2>/dev/null; then
    echo AIB_APT_SOURCE_UPDATE_CLASS:unsupported
    echo AIB_APT_SOURCE_UPDATE_EXIT:insecure-source-override
    exit 78
  fi
done
AIB_APT_CAPTURE_DIR=$(mktemp -d "/tmp/aib-runtime-apt-update-${alias}.XXXXXX" 2>/dev/null)
if [ -z "$AIB_APT_CAPTURE_DIR" ] || [ ! -d "$AIB_APT_CAPTURE_DIR" ]; then
  echo AIB_APT_SOURCE_UPDATE_CLASS:unknown
  echo AIB_APT_SOURCE_UPDATE_EXIT:unavailable
  exit 73
fi
trap 'rm -rf -- "$AIB_APT_CAPTURE_DIR"' EXIT
AIB_APT_UPDATE_LOG="$AIB_APT_CAPTURE_DIR/update.log"
AIB_APT_SECURITY_OPTIONS='-o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Check-Valid-Until=true -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false -o APT::Get::AllowUnauthenticated=false'
apt-get $AIB_APT_SECURITY_OPTIONS update >"$AIB_APT_CAPTURE_DIR/stdout" 2>"$AIB_APT_CAPTURE_DIR/stderr"
AIB_APT_UPDATE_EXIT=$?
cat "$AIB_APT_CAPTURE_DIR/stdout" "$AIB_APT_CAPTURE_DIR/stderr" >"$AIB_APT_UPDATE_LOG" 2>/dev/null
AIB_APT_UPDATE_CLASS=$(aib_classify_apt_log "$AIB_APT_UPDATE_LOG" "$AIB_APT_UPDATE_EXIT")
echo "AIB_APT_SOURCE_UPDATE_CLASS:$AIB_APT_UPDATE_CLASS"
echo "AIB_APT_SOURCE_UPDATE_EXIT:$AIB_APT_UPDATE_EXIT"
if [ "$AIB_APT_UPDATE_CLASS" = success ]; then exit 0; fi
if [ "$AIB_APT_UPDATE_EXIT" -eq 0 ]; then exit 100; fi
exit "$AIB_APT_UPDATE_EXIT"`;
}

/**
 * One bounded retry using a family-specific fixed official endpoint. The user's
 * apt sources/configuration are never edited: fallback sources and indexes are
 * transaction-local, apt-secure remains enabled, and cleanup runs on every exit.
 * The fallback transaction includes install so its temporary APT_CONFIG cannot
 * leak into or be required by a later native command.
 */
export function buildProotAptFallbackInstallCommand(
  aliasInput: ProotDistroAlias,
  packagesInput: readonly string[],
  paths: Readonly<{ guestRoot?: string }> = {},
): string {
  const alias = safeAlias(aliasInput);
  const packages = [...new Set(packagesInput.map((item) => String(item)))];
  if (!packages.length || packages.some((item) => !SAFE_APT_PACKAGES.test(item))) throw new Error("PROOT_APT_PACKAGE_NOT_ALLOWED");
  const root = safeGuestRoot(paths.guestRoot ?? "/");
  const prefix = root === "/" ? "" : root;
  const aptDir = `${prefix}/etc/apt`;
  const osRelease = `${prefix}/etc/os-release`;
  const tmpRoot = `${prefix}/tmp`;
  const dpkgStatus = `${prefix}/var/lib/dpkg/status`;
  const quoted = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const aptDirQ = quoted(aptDir);
  const osReleaseQ = quoted(osRelease);
  const tmpRootQ = quoted(tmpRoot);
  const dpkgStatusQ = quoted(dpkgStatus);
  const pkgList = packages.join(" ");

  return `${aptClassifierShell()}
set +e
export DEBIAN_FRONTEND=noninteractive
umask 077
AIB_APT_DIR=${aptDirQ}
AIB_OS_RELEASE=${osReleaseQ}
AIB_TMP_ROOT=${tmpRootQ}
AIB_DPKG_STATUS=${dpkgStatusQ}
AIB_APT_FALLBACK_DIR=""
AIB_PREFLIGHT_RESULT=not-eligible
aib_cleanup_proot_apt_fallback() {
  if [ -n "$AIB_APT_FALLBACK_DIR" ]; then
    case "$AIB_APT_FALLBACK_DIR" in "$AIB_TMP_ROOT"/aib-runtime-apt-fallback-${alias}.*) rm -rf -- "$AIB_APT_FALLBACK_DIR" ;; esac
  fi
}
trap aib_cleanup_proot_apt_fallback EXIT

aib_fallback_preflight() {
  [ -z "\${APT_CONFIG-}" ] || return 1
  [ -r "$AIB_OS_RELEASE" ] || return 1
  AIB_GUEST_ID=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2; exit }' "$AIB_OS_RELEASE" 2>/dev/null)
  AIB_GUEST_SUITE=$(awk -F= '$1 == "VERSION_CODENAME" { gsub(/"/, "", $2); print $2; exit }' "$AIB_OS_RELEASE" 2>/dev/null)
  if [ "$AIB_GUEST_ID" != ${quoted(alias)} ] || ! printf '%s' "$AIB_GUEST_SUITE" | grep -Eq '^[a-z][a-z0-9.-]{0,63}$'; then AIB_PREFLIGHT_RESULT=unsupported; return 1; fi
  [ -s "$AIB_APT_DIR/sources.list" ] || return 1
  AIB_ACTIVE_LINES=$(grep -Ec '^[[:space:]]*[^#[:space:]]' "$AIB_APT_DIR/sources.list" 2>/dev/null || true)
  [ "$AIB_ACTIVE_LINES" = 1 ] || return 1
  AIB_SOURCE_LINE=$(grep -Ev '^[[:space:]]*(#|$)' "$AIB_APT_DIR/sources.list" 2>/dev/null)
  set -f
  set -- $AIB_SOURCE_LINE
  set +f
  [ "$#" -ge 4 ] || return 1
  [ "$1" = deb ] || return 1
  AIB_SOURCE_URL=$2
  if [ "$3" != "$AIB_GUEST_SUITE" ]; then AIB_PREFLIGHT_RESULT=unsupported; return 1; fi
  case "$AIB_SOURCE_URL" in http://*|https://*) ;; *) return 1 ;; esac
  case "$AIB_SOURCE_URL" in *"@"*|*"?"*|*"#"*) return 1 ;; esac
  printf '%s' "$AIB_SOURCE_URL" | grep -Fq '\\' && return 1
  shift 3
  AIB_HAS_MAIN=0
  AIB_SOURCE_COMPONENTS=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      main) AIB_HAS_MAIN=1 ;;
      contrib|non-free|non-free-firmware|restricted|universe|multiverse) ;;
      *) return 1 ;;
    esac
    if [ -n "$AIB_SOURCE_COMPONENTS" ]; then AIB_SOURCE_COMPONENTS="$AIB_SOURCE_COMPONENTS $1"; else AIB_SOURCE_COMPONENTS=$1; fi
    shift
  done
  [ "$AIB_HAS_MAIN" = 1 ] || return 1
  for _source in "$AIB_APT_DIR"/sources.list.d/*.list "$AIB_APT_DIR"/sources.list.d/*.sources; do
    [ -f "$_source" ] || continue
    if grep -Eq '^[[:space:]]*[^#[:space:]]' "$_source" 2>/dev/null; then return 1; fi
  done
  for _conf in "$AIB_APT_DIR/apt.conf" "$AIB_APT_DIR"/apt.conf.d/*; do
    [ -f "$_conf" ] || continue
    if grep -Eiq 'Dir::Etc::(sourcelist|sourceparts)|Dir::State::lists|AllowUnauthenticated|AllowInsecureRepositories|AllowDowngradeToInsecureRepositories|Check-Valid-Until|Check-Date|Trusted[[:space:]]*[:=]' "$_conf" 2>/dev/null; then return 1; fi
  done
  AIB_ARCH=$(dpkg --print-architecture 2>/dev/null)
  case "${alias}:$AIB_ARCH" in
    debian:amd64|debian:i386|debian:arm64|debian:armhf|debian:armel|debian:ppc64el|debian:s390x|debian:riscv64) AIB_FALLBACK_URL=${PROOT_APT_OFFICIAL_FALLBACK_ENDPOINTS.debian} ;;
    ubuntu:amd64|ubuntu:i386)
      case "$AIB_SOURCE_URL" in *"/ubuntu"|*"/ubuntu/"*) AIB_FALLBACK_URL=${PROOT_APT_OFFICIAL_FALLBACK_ENDPOINTS.ubuntuArchive} ;; *) return 1 ;; esac ;;
    ubuntu:arm64|ubuntu:armhf)
      case "$AIB_SOURCE_URL" in *"/ubuntu-ports"|*"/ubuntu-ports/"*) AIB_FALLBACK_URL=${PROOT_APT_OFFICIAL_FALLBACK_ENDPOINTS.ubuntuPorts} ;; *) return 1 ;; esac ;;
    *) AIB_PREFLIGHT_RESULT=unsupported; return 1 ;;
  esac
  AIB_SOURCE_CANONICAL=$(printf '%s' "$AIB_SOURCE_URL" | sed -E 's#^https?://##; s#/$##')
  AIB_FALLBACK_CANONICAL=$(printf '%s' "$AIB_FALLBACK_URL" | sed -E 's#^https?://##; s#/$##')
  [ "$AIB_SOURCE_CANONICAL" != "$AIB_FALLBACK_CANONICAL" ] || return 1
  return 0
}

if ! aib_fallback_preflight; then
  echo "AIB_APT_FALLBACK_RESULT:$AIB_PREFLIGHT_RESULT"
  echo AIB_APT_FALLBACK_TRIES:0
  exit 78
fi
mkdir -p "$AIB_TMP_ROOT" || { echo AIB_APT_FALLBACK_RESULT:failed; echo AIB_APT_FALLBACK_CAUSE:permission-disk; exit 73; }
AIB_APT_FALLBACK_DIR=$(mktemp -d "$AIB_TMP_ROOT/aib-runtime-apt-fallback-${alias}.XXXXXX" 2>/dev/null)
if [ -z "$AIB_APT_FALLBACK_DIR" ] || [ ! -d "$AIB_APT_FALLBACK_DIR" ]; then
  echo AIB_APT_FALLBACK_RESULT:failed
  echo AIB_APT_FALLBACK_CAUSE:permission-disk
  exit 73
fi
mkdir -p "$AIB_APT_FALLBACK_DIR/lists/partial" || { echo AIB_APT_FALLBACK_RESULT:failed; echo AIB_APT_FALLBACK_CAUSE:permission-disk; exit 73; }
printf 'deb [arch=%s] %s %s %s\\n' "$AIB_ARCH" "$AIB_FALLBACK_URL" "$AIB_GUEST_SUITE" "$AIB_SOURCE_COMPONENTS" > "$AIB_APT_FALLBACK_DIR/sources.list" || { echo AIB_APT_FALLBACK_RESULT:failed; echo AIB_APT_FALLBACK_CAUSE:permission-disk; exit 73; }
printf 'Dir::Etc::sourcelist "%s/sources.list";\\nDir::Etc::sourceparts "-";\\nDir::State::lists "%s/lists";\\nDir::State::status "%s";\\n' "$AIB_APT_FALLBACK_DIR" "$AIB_APT_FALLBACK_DIR" "$AIB_DPKG_STATUS" > "$AIB_APT_FALLBACK_DIR/apt.conf" || { echo AIB_APT_FALLBACK_RESULT:failed; echo AIB_APT_FALLBACK_CAUSE:permission-disk; exit 73; }
AIB_APT_FALLBACK_OPTIONS='-o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Check-Valid-Until=true -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false -o APT::Get::AllowUnauthenticated=false'
aib_fallback_apt() { APT_CONFIG="$AIB_APT_FALLBACK_DIR/apt.conf" apt-get $AIB_APT_FALLBACK_OPTIONS "$@"; }

aib_fallback_apt update >"$AIB_APT_FALLBACK_DIR/update.stdout" 2>"$AIB_APT_FALLBACK_DIR/update.stderr"
AIB_APT_FALLBACK_UPDATE_EXIT=$?
cat "$AIB_APT_FALLBACK_DIR/update.stdout" "$AIB_APT_FALLBACK_DIR/update.stderr" > "$AIB_APT_FALLBACK_DIR/update.log" 2>/dev/null
AIB_APT_FALLBACK_UPDATE_CLASS=$(aib_classify_apt_log "$AIB_APT_FALLBACK_DIR/update.log" "$AIB_APT_FALLBACK_UPDATE_EXIT")
echo "AIB_APT_FALLBACK_TRIES:1"
echo "AIB_APT_FALLBACK_UPDATE_CLASS:$AIB_APT_FALLBACK_UPDATE_CLASS"
echo "AIB_APT_FALLBACK_UPDATE_EXIT:$AIB_APT_FALLBACK_UPDATE_EXIT"
if [ "$AIB_APT_FALLBACK_UPDATE_CLASS" = signature ]; then
  echo AIB_APT_FALLBACK_RESULT:signature
  exit 100
fi
if [ "$AIB_APT_FALLBACK_UPDATE_CLASS" = http-client ]; then
  echo AIB_APT_FALLBACK_RESULT:unsupported
  exit 100
fi
if [ "$AIB_APT_FALLBACK_UPDATE_CLASS" = transport ]; then
  echo AIB_APT_FALLBACK_RESULT:transport-exhausted
  exit 100
fi
if [ "$AIB_APT_FALLBACK_UPDATE_CLASS" != success ]; then
  echo AIB_APT_FALLBACK_RESULT:failed
  echo "AIB_APT_FALLBACK_CAUSE:$AIB_APT_FALLBACK_UPDATE_CLASS"
  exit 100
fi
if ! find "$AIB_APT_FALLBACK_DIR/lists" -type f -name '*InRelease' -size +0c -print -quit 2>/dev/null | grep -q . || ! find "$AIB_APT_FALLBACK_DIR/lists" -type f -name '*Packages*' -size +0c -print -quit 2>/dev/null | grep -q .; then
  echo AIB_APT_FALLBACK_RESULT:unsupported
  echo AIB_APT_FALLBACK_CAUSE:verified-index-missing
  exit 100
fi
AIB_RELEASE_FILE_COUNT=$(find "$AIB_APT_FALLBACK_DIR/lists" -type f -name '*InRelease' -size +0c -print 2>/dev/null | wc -l | tr -d ' ')
AIB_RELEASE_FILE=$(find "$AIB_APT_FALLBACK_DIR/lists" -type f -name '*InRelease' -size +0c -print -quit 2>/dev/null)
AIB_RELEASE_ORIGIN=$(awk -F': ' '$1 == "Origin" { print $2; exit }' "$AIB_RELEASE_FILE" 2>/dev/null)
AIB_RELEASE_CODENAME=$(awk -F': ' '$1 == "Codename" { print $2; exit }' "$AIB_RELEASE_FILE" 2>/dev/null)
if [ "$AIB_RELEASE_FILE_COUNT" != 1 ] || [ "$AIB_RELEASE_ORIGIN" != "${alias == "debian" ? "Debian" : "Ubuntu"}" ] || [ "$AIB_RELEASE_CODENAME" != "$AIB_GUEST_SUITE" ]; then
  echo AIB_APT_FALLBACK_RESULT:unsupported
  echo AIB_APT_FALLBACK_CAUSE:release-identity-mismatch
  exit 100
fi
aib_fallback_apt install -y --no-install-recommends ${pkgList} >"$AIB_APT_FALLBACK_DIR/install.stdout" 2>"$AIB_APT_FALLBACK_DIR/install.stderr"
AIB_APT_FALLBACK_INSTALL_EXIT=$?
cat "$AIB_APT_FALLBACK_DIR/install.stdout" "$AIB_APT_FALLBACK_DIR/install.stderr" > "$AIB_APT_FALLBACK_DIR/install.log" 2>/dev/null
AIB_APT_FALLBACK_INSTALL_CLASS=$(aib_classify_apt_log "$AIB_APT_FALLBACK_DIR/install.log" "$AIB_APT_FALLBACK_INSTALL_EXIT")
echo "AIB_APT_FALLBACK_INSTALL_CLASS:$AIB_APT_FALLBACK_INSTALL_CLASS"
echo "AIB_APT_FALLBACK_INSTALL_EXIT:$AIB_APT_FALLBACK_INSTALL_EXIT"
if [ "$AIB_APT_FALLBACK_INSTALL_CLASS" != success ]; then
  echo AIB_APT_FALLBACK_RESULT:install-failed
  exit "$AIB_APT_FALLBACK_INSTALL_EXIT"
fi
echo AIB_APT_FALLBACK_RESULT:installed
exit 0`;
}

/** A normal apt install wrapper, also keeping raw repository diagnostics guest-local. */
export function buildProotAptInstallCommand(
  packagesInput: readonly string[],
  paths: Readonly<{ guestRoot?: string }> = {},
): string {
  const packages = [...new Set(packagesInput.map((item) => String(item)))];
  if (!packages.length || packages.some((item) => !SAFE_APT_PACKAGES.test(item))) throw new Error("PROOT_APT_PACKAGE_NOT_ALLOWED");
  const root = safeGuestRoot(paths.guestRoot ?? "/");
  const aptDir = root === "/" ? "/etc/apt" : `${root}/etc/apt`;
  const aptDirQ = `'${aptDir.replace(/'/g, `'\\''`)}'`;
  const pkgList = packages.join(" ");
  return `${aptClassifierShell()}
set +e
export DEBIAN_FRONTEND=noninteractive
umask 077
AIB_APT_DIR=${aptDirQ}
if [ -n "\${APT_CONFIG-}" ]; then
  echo AIB_APT_GUEST_INSTALL_CLASS:unsupported
  echo AIB_APT_GUEST_INSTALL_EXIT:custom-apt-config
  exit 78
fi
for _conf in "$AIB_APT_DIR/apt.conf" "$AIB_APT_DIR"/apt.conf.d/*; do
  [ -f "$_conf" ] || continue
  if grep -Eiq 'AllowInsecureRepositories|AllowDowngradeToInsecureRepositories|AllowUnauthenticated|Check-Valid-Until|Check-Date|Trusted[[:space:]]*[:=]' "$_conf" 2>/dev/null; then
    echo AIB_APT_GUEST_INSTALL_CLASS:unsupported
    echo AIB_APT_GUEST_INSTALL_EXIT:insecure-config-override
    exit 78
  fi
done
for _source in "$AIB_APT_DIR/sources.list" "$AIB_APT_DIR"/sources.list.d/*.list "$AIB_APT_DIR"/sources.list.d/*.sources; do
  [ -f "$_source" ] || continue
  if grep -Eiq 'trusted[[:space:]]*=[[:space:]]*(yes|true|1)|^[[:space:]]*trusted[[:space:]]*:[[:space:]]*(yes|true|1)|allow-(insecure|weak|downgrade-to-insecure)|Allow-Insecure:[[:space:]]*(yes|true|1)|Allow-Weak:[[:space:]]*(yes|true|1)|Check-Valid-Until:[[:space:]]*(no|false|0)' "$_source" 2>/dev/null; then
    echo AIB_APT_GUEST_INSTALL_CLASS:unsupported
    echo AIB_APT_GUEST_INSTALL_EXIT:insecure-source-override
    exit 78
  fi
done
AIB_APT_CAPTURE_DIR=$(mktemp -d "/tmp/aib-runtime-apt-install.XXXXXX" 2>/dev/null)
if [ -z "$AIB_APT_CAPTURE_DIR" ] || [ ! -d "$AIB_APT_CAPTURE_DIR" ]; then
  echo AIB_APT_GUEST_INSTALL_CLASS:unknown
  echo AIB_APT_GUEST_INSTALL_EXIT:unavailable
  exit 73
fi
trap 'rm -rf -- "$AIB_APT_CAPTURE_DIR"' EXIT
AIB_APT_SECURITY_OPTIONS='-o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Check-Valid-Until=true -o Acquire::AllowInsecureRepositories=false -o Acquire::AllowDowngradeToInsecureRepositories=false -o APT::Get::AllowUnauthenticated=false'
apt-get $AIB_APT_SECURITY_OPTIONS install -y --no-install-recommends ${pkgList} >"$AIB_APT_CAPTURE_DIR/stdout" 2>"$AIB_APT_CAPTURE_DIR/stderr"
AIB_APT_INSTALL_EXIT=$?
cat "$AIB_APT_CAPTURE_DIR/stdout" "$AIB_APT_CAPTURE_DIR/stderr" > "$AIB_APT_CAPTURE_DIR/install.log" 2>/dev/null
AIB_APT_INSTALL_CLASS=$(aib_classify_apt_log "$AIB_APT_CAPTURE_DIR/install.log" "$AIB_APT_INSTALL_EXIT")
echo "AIB_APT_GUEST_INSTALL_CLASS:$AIB_APT_INSTALL_CLASS"
echo "AIB_APT_GUEST_INSTALL_EXIT:$AIB_APT_INSTALL_EXIT"
if [ "$AIB_APT_INSTALL_CLASS" = success ]; then exit 0; fi
if [ "$AIB_APT_INSTALL_EXIT" -eq 0 ]; then exit 100; fi
exit "$AIB_APT_INSTALL_EXIT"`;
}

function aptClassifierShell(): string {
  return `aib_classify_apt_log() {
  _aib_log="$1"
  _aib_exit="$2"
  if grep -Eiq 'NO_PUBKEY|EXPKEYSIG|BADSIG|REVKEYSIG|signature|not signed|signatures could not be verified|Hash Sum mismatch|Release file.*(not valid|expired)|Clearsigned file.*not valid|does not have a Release file|changed its .*(Origin|Label|Suite|Codename)|incompatible release|not valid yet|is expired|valid-until|unauthenticated|certificate|TLS|SSL' "$_aib_log" 2>/dev/null; then echo signature; return 0; fi
  if grep -Eiq '(^|[^0-9])(401|403|404)([^0-9]|$)|404[[:space:]]+Not Found|401[[:space:]]+Unauthorized|403[[:space:]]+Forbidden|407[[:space:]]+Proxy Authentication' "$_aib_log" 2>/dev/null; then echo http-client; return 0; fi
  if grep -Eiq 'Unable to locate package|no installation candidate|unmet dependencies|held broken packages|dependency problems|Unable to correct problems|but it is not installable' "$_aib_log" 2>/dev/null; then echo package; return 0; fi
  if grep -Eiq 'Permission denied|Could not open lock|Could not get lock|unable to lock|read-only file system|No space left|not enough (free )?space|disk is full|Could not create temporary file|Couldn.t create temporary file|Input/output error' "$_aib_log" 2>/dev/null; then echo permission-disk; return 0; fi
  if grep -Eiq 'Temporary failure resolving|Could not resolve|Network is unreachable|Connection timed out|Could not connect to|Failed to connect to|Connection refused|408[[:space:]]+Request Timeout|425[[:space:]]+Too Early|429[[:space:]]+Too Many Requests|HTTP[^0-9]*5[0-9][0-9]|Failed to fetch.*[[:space:]]5[0-9][0-9]([[:space:]]|$)' "$_aib_log" 2>/dev/null; then echo transport; return 0; fi
  if [ "$_aib_exit" = 0 ]; then echo success; else echo unknown; fi
}`;
}

function safeAlias(value: ProotDistroAlias): ProotDistroAlias {
  if (!(ALIASES as readonly string[]).includes(value)) throw new Error("PROOT_DISTRO_ALIAS_NOT_ALLOWED");
  return value;
}

function safeGuestRoot(value: string): string {
  if (!value.startsWith("/") || /[^A-Za-z0-9._/-]/.test(value) || value.includes("//") || value.split("/").includes("..")) {
    throw new Error("PROOT_APT_TEST_ROOT_NOT_ALLOWED");
  }
  return value === "/" ? "/" : value.replace(/\/$/, "");
}
