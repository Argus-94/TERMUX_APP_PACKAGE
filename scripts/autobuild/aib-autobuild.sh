# AI_BUILDER_AUTOBUILD_ENGINE:v1
# Internal runtime only: this body can also be sourced without the JS/UI gates.
case "${PREFIX:-}:${HOME:-}" in
  /data/data/com.karat.aibuilder/files/usr:/data/data/com.karat.aibuilder/files/home|/data/user/0/com.karat.aibuilder/files/usr:/data/user/0/com.karat.aibuilder/files/home) ;;
  *) printf '%s\n' AIB_PRIVATE_RUNTIME_REQUIRED >&2; return 78 2>/dev/null || exit 78 ;;
esac
# No environment variable qualifies a feed/toolchain. Stop before any I/O.
# Recipes below remain dormant until a separately qualified implementation exists.
printf '%s\n' AIB_PRIVATE_TOOLCHAIN_NOT_QUALIFIED >&2
return 78 2>/dev/null || exit 78
# Self-healing build engine. Sourced by generated build-apk-<name>.sh scripts.
# Contract (set by the generated header before this body):
#   AIB_AB_BACKEND   termux | ubuntu-proot
#   AIB_AB_KIND      gradle | expo | react-native | capacitor | cordova | maven | native | flutter | unknown
#   AIB_AB_MAX       max build attempts            (default 10)
#   AIB_AB_WALL      wall-clock budget in seconds  (default 9000)
#   aib_primary()    the real build command (defined by the header; runs in a subshell)
# Behaviour: preflight (install what is missing) -> build -> read the log ->
# apply every matching fixer -> rebuild. Unknown failures climb a reset ladder
# and are finally handed back with AIB_AUTOBUILD_NEEDS_LLM=1 so the agent can
# write the next script from the real log.

AIB_AB_BACKEND="${AIB_AB_BACKEND:-termux}"
AIB_AB_KIND="${AIB_AB_KIND:-unknown}"
AIB_AB_MAX="${AIB_AB_MAX:-10}"
AIB_AB_WALL="${AIB_AB_WALL:-9000}"
AIB_AB_FIX_LIMIT="${AIB_AB_FIX_LIMIT:-3}"
AIB_AB_WORK="${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}/work"
mkdir -p "$AIB_AB_WORK" 2>/dev/null
AIB_AB_LOG="$AIB_AB_WORK/autobuild-current.log"
AIB_AB_HISTORY="$AIB_AB_WORK/autobuild-history.log"
AIB_AB_FIXED=""
AIB_AB_APPLIED_IDS=""
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"
mkdir -p "$GRADLE_USER_HOME" 2>/dev/null

aib_ab_log() { printf '[AIB-AUTOBUILD %s] %s\n' "$(date +%H:%M:%S 2>/dev/null)" "$*"; }
aib_ab_have() { command -v "$1" >/dev/null 2>&1; }
aib_ab_arch() { uname -m 2>/dev/null || echo unknown; }
aib_ab_is_arm() { case "$(aib_ab_arch)" in aarch64|arm64|armv7*|armv8*|arm*) return 0;; *) return 1;; esac; }
aib_ab_count() { printf '%s\n' "$AIB_AB_FIXED" | grep -c -x -- "$1"; }

# ---------- package manager ----------
aib_ab_pm_update() {
  if [ "$AIB_AB_BACKEND" = termux ]; then
    pkg update -y 2>&1 | tail -n 3
  else
    DEBIAN_FRONTEND=noninteractive apt-get update -y 2>&1 | tail -n 3
  fi
}
aib_ab_pm_install() {
  aib_ab_log "install: $*"
  if [ "$AIB_AB_BACKEND" = termux ]; then
    pkg install -y "$@" 2>&1 | tail -n 4
    local ec=${PIPESTATUS[0]}
    if [ "$ec" -ne 0 ]; then aib_ab_pm_update >/dev/null 2>&1; pkg install -y "$@" 2>&1 | tail -n 4; ec=${PIPESTATUS[0]}; fi
    return "$ec"
  fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" 2>&1 | tail -n 4
  local ec2=${PIPESTATUS[0]}
  if [ "$ec2" -ne 0 ]; then aib_ab_pm_update >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" 2>&1 | tail -n 4; ec2=${PIPESTATUS[0]}; fi
  return "$ec2"
}
aib_ab_net_ok() {
  if aib_ab_have curl; then curl -fsI --max-time 10 https://dl.google.com >/dev/null 2>&1 && return 0; curl -fsI --max-time 10 https://repo.maven.apache.org >/dev/null 2>&1 && return 0; return 1; fi
  if aib_ab_have wget; then wget -q --spider --timeout=10 https://dl.google.com 2>/dev/null && return 0; fi
  return 1
}
aib_ab_download() { # url dest
  local n=0 ec
  while [ "$n" -lt 3 ]; do
    n=$((n + 1))
    if aib_ab_have curl; then
      curl -fL --retry 2 --connect-timeout 20 -o "$2" "$1" >/dev/null 2>&1; ec=$?
    elif aib_ab_have wget; then
      wget -q -O "$2" "$1"; ec=$?
    else
      return 1
    fi
    [ "$ec" -eq 0 ] && [ -s "$2" ] && return 0
    sleep $((n * 3))
  done
  return 1
}
aib_ab_gprop_set() { # key value -> user-level gradle.properties (never the project file)
  local f="$GRADLE_USER_HOME/gradle.properties"; touch "$f"
  grep -v -E "^$(printf '%s' "$1" | sed 's/[.[\*^$]/\\&/g')=" "$f" > "$f.tmp" 2>/dev/null; printf '%s=%s\n' "$1" "$2" >> "$f.tmp"; mv -f "$f.tmp" "$f"
}

# ---------- base tools / JDK ----------
aib_ab_ensure_base() {
  local missing=""
  for t in curl unzip git; do aib_ab_have "$t" || missing="$missing $t"; done
  if [ "$AIB_AB_BACKEND" != termux ]; then aib_ab_have xz || missing="$missing xz-utils"; [ -d /etc/ssl/certs ] || missing="$missing ca-certificates"; fi
  [ -n "$missing" ] && aib_ab_pm_install $missing
  return 0
}
aib_ab_java_ok() { [ -x "$1/bin/java" ] || return 1; local m; m=$("$1/bin/java" -version 2>&1 | sed -nE 's/.*version "([0-9]+).*/\1/p' | head -1); case "$m" in ""|*[!0-9]*) return 1;; esac; [ "$m" -ge 17 ]; }
aib_ab_find_java() {
  local d
  for d in "${JAVA_HOME:-}" ${AIB_AB_JVM_GLOBS:-"${PREFIX:-/nonexistent}"/lib/jvm/java-17-openjdk "${PREFIX:-/nonexistent}"/lib/jvm/java-21-openjdk /usr/lib/jvm/java-17-openjdk-* /usr/lib/jvm/java-17-openjdk /usr/lib/jvm/java-21-openjdk-* /usr/lib/jvm/default-java}; do
    [ -n "$d" ] && aib_ab_java_ok "$d" && { export JAVA_HOME="$d"; export PATH="$JAVA_HOME/bin:$PATH"; return 0; }
  done
  return 1
}
aib_ab_ensure_java() {
  aib_ab_find_java && return 0
  aib_ab_log "JDK 17+ not found: installing"
  if [ "$AIB_AB_BACKEND" = termux ]; then aib_ab_pm_install openjdk-17; else aib_ab_pm_install openjdk-17-jdk-headless; fi
  aib_ab_find_java && { aib_ab_log "JAVA_HOME=$JAVA_HOME"; return 0; }
  return 1
}

# ---------- Android SDK ----------
aib_ab_pick_sdk() {
  local d
  for d in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/android-sdk" "$HOME/Android/Sdk" "${PREFIX:-/nonexistent}/opt/android-sdk" /opt/android-sdk /usr/lib/android-sdk; do
    [ -n "$d" ] && [ -d "$d" ] && { export ANDROID_HOME="$d" ANDROID_SDK_ROOT="$d"; return 0; }
  done
  mkdir -p "$HOME/android-sdk" && export ANDROID_HOME="$HOME/android-sdk" ANDROID_SDK_ROOT="$HOME/android-sdk"
}
aib_ab_sdkmanager() { local c; for c in "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "$ANDROID_HOME"/cmdline-tools/*/bin/sdkmanager; do [ -x "$c" ] && { printf '%s' "$c"; return 0; }; done; return 1; }
aib_ab_ensure_cmdline_tools() {
  aib_ab_sdkmanager >/dev/null && return 0
  aib_ab_log "Android cmdline-tools missing: downloading"
  local tmp="$AIB_AB_WORK/cmdline-tools.zip" ok=1 v
  for v in 11076708 10406996 9477386; do
    aib_ab_download "https://dl.google.com/android/repository/commandlinetools-linux-${v}_latest.zip" "$tmp" && unzip -tq "$tmp" >/dev/null 2>&1 && { ok=0; break; }
  done
  [ "$ok" -eq 0 ] || return 1
  rm -rf "$ANDROID_HOME/cmdline-tools/.aib-unpack"; mkdir -p "$ANDROID_HOME/cmdline-tools/.aib-unpack" && unzip -q -o "$tmp" -d "$ANDROID_HOME/cmdline-tools/.aib-unpack" || return 1
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"; mv "$ANDROID_HOME/cmdline-tools/.aib-unpack/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" && rm -rf "$ANDROID_HOME/cmdline-tools/.aib-unpack" "$tmp"
  aib_ab_sdkmanager >/dev/null
}
aib_ab_accept_licenses() {
  mkdir -p "$ANDROID_HOME/licenses"
  printf '%s\n' 24333f8a63b6825ea9c5514f83c2829b004d1fee 8933bad161af4178b1185d1a37fbf41ea5269c55 d56f5187479451eabf01fb78af6dfcb131a6481e e9acab5b5fbb560a72cfaecce8946896ff6aab9d > "$ANDROID_HOME/licenses/android-sdk-license"
  printf '%s\n' 84831b9409646a918e30573bab4c9c91346d8abd > "$ANDROID_HOME/licenses/android-sdk-preview-license"
  local sm; sm=$(aib_ab_sdkmanager) && { yes 2>/dev/null | timeout 300 "$sm" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1; }
  return 0
}
aib_ab_sdk_install() { # "platforms;android-34" ...
  local sm; sm=$(aib_ab_sdkmanager) || { aib_ab_ensure_cmdline_tools && sm=$(aib_ab_sdkmanager); } || return 1
  aib_ab_accept_licenses
  aib_ab_log "sdkmanager install: $*"
  yes 2>/dev/null | timeout 1800 "$sm" --sdk_root="$ANDROID_HOME" "$@" 2>&1 | grep -v -E '^\[=*[ =]*\]|^Warning: Could not create settings' | tail -n 6
  return "${PIPESTATUS[1]}"
}
aib_ab_local_properties() { # build root = AIB_PROJECT_BUILD_ROOT or cwd
  local root="${AIB_PROJECT_BUILD_ROOT:-$PWD}" f
  [ -f "$root/gradlew" ] || [ -f "$root/settings.gradle" ] || [ -f "$root/settings.gradle.kts" ] || return 0
  f="$root/local.properties"
  if [ -f "$f" ] && grep -q "^sdk.dir=$ANDROID_HOME\$" "$f"; then return 0; fi
  { [ -f "$f" ] && grep -v '^sdk.dir=' "$f"; printf 'sdk.dir=%s\n' "$ANDROID_HOME"; } > "$f.aib" 2>/dev/null && mv -f "$f.aib" "$f"
}
aib_ab_aapt2_override() { # native aapt2 for ARM hosts (Maven aapt2 is x86_64)
  aib_ab_is_arm || return 0
  local a
  for a in "${PREFIX:-/nonexistent}/bin/aapt2" /usr/bin/aapt2 "$(command -v aapt2 2>/dev/null)"; do [ -n "$a" ] && [ -x "$a" ] && "$a" version >/dev/null 2>&1 && { aib_ab_gprop_set android.aapt2FromMavenOverride "$a"; return 0; }; done
  if [ "$AIB_AB_BACKEND" = termux ]; then aib_ab_pm_install aapt2 apksigner >/dev/null 2>&1; else aib_ab_pm_install aapt >/dev/null 2>&1; fi
  for a in "${PREFIX:-/nonexistent}/bin/aapt2" /usr/bin/aapt2 "$(command -v aapt2 2>/dev/null)"; do [ -n "$a" ] && [ -x "$a" ] && { aib_ab_gprop_set android.aapt2FromMavenOverride "$a"; aib_ab_log "aapt2 override: $a"; return 0; }; done
  return 1
}
aib_ab_base_gradle_props() {
  local mem_kb mem_mb xmx
  mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null); mem_mb=$(( ${mem_kb:-4000000} / 1024 ))
  xmx=$(( mem_mb * 45 / 100 )); [ "$xmx" -gt 2048 ] && xmx=2048; [ "$xmx" -lt 1024 ] && xmx=1024
  grep -q '^org.gradle.jvmargs=' "$GRADLE_USER_HOME/gradle.properties" 2>/dev/null || aib_ab_gprop_set org.gradle.jvmargs "-Xmx${xmx}m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8"
  grep -q '^org.gradle.workers.max=' "$GRADLE_USER_HOME/gradle.properties" 2>/dev/null || aib_ab_gprop_set org.gradle.workers.max 2
}

# ---------- project SDK requirements (read from the project, never modified) ----------
aib_ab_gradle_files() { local r="${AIB_PROJECT_BUILD_ROOT:-$PWD}" f; for f in "$r/app/build.gradle" "$r/app/build.gradle.kts" "$r/build.gradle" "$r/build.gradle.kts" "$r/android/app/build.gradle" "$r/android/build.gradle"; do [ -f "$f" ] && printf '%s\n' "$f"; done; }
aib_ab_project_compile_sdk() {
  local f v
  for f in $(aib_ab_gradle_files); do
    v=$(sed -nE 's/^[[:space:]]*compileSdk(Version)?[[:space:]]*[=(]?[[:space:]]*"?(android-)?([0-9]{2})"?.*/\3/p' "$f" | head -n 1); [ -n "$v" ] && { printf '%s' "$v"; return 0; }
    v=$(sed -nE 's/.*compileSdkVersion[^0-9]*([0-9]{2}).*/\1/p' "$f" | head -n 1); [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  done
  return 1
}
aib_ab_project_build_tools() { local f v; for f in $(aib_ab_gradle_files); do v=$(sed -nE 's/.*buildToolsVersion[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$f" | head -n 1); [ -n "$v" ] && { printf '%s' "$v"; return 0; }; done; return 1; }
aib_ab_ensure_platform() {
  [ -n "${ANDROID_HOME:-}" ] || return 1
  local sdk bt; sdk=$(aib_ab_project_compile_sdk) || sdk=""
  if [ -n "$sdk" ] && [ -f "$ANDROID_HOME/platforms/android-$sdk/android.jar" ]; then :
  elif [ -z "$sdk" ] && ls "$ANDROID_HOME"/platforms/android-*/android.jar >/dev/null 2>&1; then :
  else aib_ab_sdk_install "platforms;android-${sdk:-34}"; fi
  bt=$(aib_ab_project_build_tools) || bt=""
  if [ -n "$bt" ]; then [ -d "$ANDROID_HOME/build-tools/$bt" ] || aib_ab_sdk_install "build-tools;$bt"
  elif ! ls -d "$ANDROID_HOME"/build-tools/*/ >/dev/null 2>&1; then aib_ab_sdk_install "build-tools;${sdk:-34}.0.0" || aib_ab_sdk_install "build-tools;34.0.0"; fi
  ls "$ANDROID_HOME"/platforms/android-*/android.jar >/dev/null 2>&1
}

aib_ab_ensure_native_sdk() { # only for projects that declare ndkVersion / externalNativeBuild
  local v f uses=0 ndk_ec=0
  for f in $(aib_ab_gradle_files); do grep -qE 'ndkVersion|externalNativeBuild|ndkBuild|cmake' "$f" 2>/dev/null && uses=1; done
  [ "$uses" -eq 1 ] || return 0
  v=$(aib_ab_project_ndk_version) || v=""
  if [ -n "$v" ]; then
    aib_ab_ndk_runs "$ANDROID_HOME/ndk/$v" || { AIB_AB_LOG=/dev/null aib_ab_fix_ndk; ndk_ec=$?; }
    [ "$ndk_ec" -eq 78 ] && return 78
  fi
  grep -qE 'cmake' $(aib_ab_gradle_files) 2>/dev/null && aib_ab_is_arm && aib_ab_fix_cmake
  return 0
}

# ---------- preflight (idempotent, non-fatal) ----------
aib_ab_preflight() {
  aib_ab_log "preflight backend=$AIB_AB_BACKEND kind=$AIB_AB_KIND arch=$(aib_ab_arch)"
  aib_ab_net_ok || aib_ab_log "network probe failed (will retry on demand)"
  aib_ab_ensure_base
  case "$AIB_AB_KIND" in
    gradle|expo|react-native|capacitor|cordova|unknown|flutter)
      aib_ab_ensure_java || aib_ab_log "JDK still missing"
      aib_ab_pick_sdk; aib_ab_ensure_cmdline_tools || aib_ab_log "cmdline-tools unavailable"
      aib_ab_accept_licenses; aib_ab_ensure_platform; aib_ab_ensure_native_sdk; local native_sdk_ec=$?; [ "$native_sdk_ec" -eq 78 ] && return 78; aib_ab_local_properties; aib_ab_base_gradle_props; aib_ab_aapt2_override ;;
    maven) aib_ab_have mvn || aib_ab_pm_install maven; aib_ab_ensure_java ;;
    native) aib_ab_have cmake || aib_ab_pm_install cmake; aib_ab_have make || aib_ab_pm_install make; aib_ab_have cc || { [ "$AIB_AB_BACKEND" = termux ] && aib_ab_pm_install clang || aib_ab_pm_install build-essential; } ;;
  esac
  case "$AIB_AB_KIND" in expo|react-native|capacitor|cordova) aib_ab_ensure_node ;; esac
  return 0
}

# ---------- JS toolchain ----------
aib_ab_ensure_node() {
  if aib_ab_have node; then return 0; fi
  aib_ab_log "node missing: installing"
  if [ "$AIB_AB_BACKEND" = termux ]; then aib_ab_pm_install nodejs; return; fi
  local arch tarball
  case "$(aib_ab_arch)" in aarch64|arm64) arch=arm64;; x86_64) arch=x64;; *) arch="" ;; esac
  if [ -n "$arch" ]; then
    tarball="$AIB_AB_WORK/node.tar.xz"
    if aib_ab_download "https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-$arch.tar.xz" "$tarball"; then
      mkdir -p "$HOME/.aib-node" && tar -xJf "$tarball" -C "$HOME/.aib-node" --strip-components=1 && export PATH="$HOME/.aib-node/bin:$PATH"; rm -f "$tarball"
    fi
  fi
  aib_ab_have node || aib_ab_pm_install nodejs npm
  aib_ab_have node
}
aib_ab_js_manager() { local r="${AIB_PROJECT_ROOT:-$PWD}"; if [ -f "$r/pnpm-lock.yaml" ]; then echo pnpm; elif [ -f "$r/yarn.lock" ]; then echo yarn; else echo npm; fi; }
aib_ab_js_deps() {
  local r="${AIB_PROJECT_ROOT:-$PWD}" m ec=0; [ -f "$r/package.json" ] || return 1
  aib_ab_ensure_node || return 1; m=$(aib_ab_js_manager)
  if [ "$m" = pnpm ] && ! aib_ab_have pnpm; then
    if aib_ab_have corepack; then corepack enable >/dev/null 2>&1; fi
    aib_ab_have pnpm || npm install -g pnpm 2>&1 | tail -n 2
  fi
  if [ "$m" = yarn ] && ! aib_ab_have yarn; then npm install -g yarn 2>&1 | tail -n 2; fi
  aib_ab_log "JS deps via $m"
  cd "$r" || return 1
  case "$m" in
    pnpm) pnpm install --frozen-lockfile >"$AIB_AB_WORK/js-deps.out" 2>&1 || pnpm install >"$AIB_AB_WORK/js-deps.out" 2>&1; ec=$? ;;
    yarn) yarn install --frozen-lockfile >"$AIB_AB_WORK/js-deps.out" 2>&1; ec=$? ;;
    *) if [ -f package-lock.json ]; then npm ci --legacy-peer-deps >"$AIB_AB_WORK/js-deps.out" 2>&1 || npm install --legacy-peer-deps >"$AIB_AB_WORK/js-deps.out" 2>&1; else npm install --legacy-peer-deps >"$AIB_AB_WORK/js-deps.out" 2>&1; fi; ec=$? ;;
  esac
  tail -n 8 "$AIB_AB_WORK/js-deps.out"; cd - >/dev/null 2>&1
  return "$ec"
}
aib_ab_expo_prebuild() {
  local r="${AIB_PROJECT_ROOT:-$PWD}"; [ -d "$r/android" ] && return 0; [ -f "$r/package.json" ] && grep -q '"expo"' "$r/package.json" || return 1
  aib_ab_log "expo prebuild (android dir missing)"; ( cd "$r" && npx --yes expo prebuild --platform android --no-install --non-interactive 2>&1 | tail -n 10 )
}

# ---------- fixers: return 0 when they changed something ----------
aib_ab_first() { grep -o -E "$1" "$AIB_AB_LOG" | head -n 1; }
aib_ab_fix_jdk() { aib_ab_ensure_java && { aib_ab_find_java; return 0; }; return 1; }
aib_ab_fix_sdk_dir() { aib_ab_pick_sdk; aib_ab_ensure_cmdline_tools; aib_ab_local_properties; return 0; }
aib_ab_fix_licenses() { aib_ab_pick_sdk; aib_ab_ensure_cmdline_tools; aib_ab_accept_licenses; return 0; }
aib_ab_fix_platform() {
  local p; p=$(aib_ab_first 'platforms;android-[0-9A-Za-z.-]+')
  [ -z "$p" ] && { p=$(aib_ab_first "android-[0-9]+" | head -n 1); [ -n "$p" ] && p="platforms;$p"; }
  aib_ab_pick_sdk; aib_ab_ensure_cmdline_tools
  if [ -n "$p" ]; then aib_ab_sdk_install "$p"; else aib_ab_ensure_platform; fi
  ls "$ANDROID_HOME"/platforms/android-*/android.jar >/dev/null 2>&1
}
aib_ab_fix_buildtools() {
  local v; v=$(aib_ab_first 'build-tools;[0-9.]+'); [ -z "$v" ] && v="build-tools;$(sed -nE 's/.*Build ?[Tt]ools revision ([0-9.]+).*/\1/p' "$AIB_AB_LOG" | head -n 1)"
  [ "$v" = "build-tools;" ] && v="build-tools;34.0.0"; aib_ab_pick_sdk; aib_ab_sdk_install "$v"
}
aib_ab_prop_set() { # file key value (machine-local file, e.g. local.properties)
  local f="$1"; touch "$f" 2>/dev/null; { grep -v "^$2=" "$f" 2>/dev/null; printf '%s=%s\n' "$2" "$3"; } > "$f.aib" && mv -f "$f.aib" "$f"
}
aib_ab_project_ndk_version() { local f v; for f in $(aib_ab_gradle_files); do v=$(sed -nE 's/.*ndkVersion[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$f" | head -n 1); [ -n "$v" ] && { printf '%s' "$v"; return 0; }; done; return 1; }

# CMake: Google's cmake package is x86_64. On ARM hosts use the system cmake through AGP's cmake.dir.
aib_ab_fix_cmake() {
  local v; v=$(sed -nE "s/.*CMake '([0-9.]+)' was not found.*/\1/p" "$AIB_AB_LOG" | head -n 1); [ -z "$v" ] && v=$(aib_ab_first 'cmake;[0-9.]+' | sed 's/^cmake;//'); [ -z "$v" ] && v=3.22.1
  aib_ab_pick_sdk
  if aib_ab_is_arm; then
    aib_ab_have cmake || aib_ab_pm_install cmake; aib_ab_have ninja || aib_ab_pm_install ninja 2>/dev/null || aib_ab_pm_install ninja-build
    aib_ab_have cmake || return 1
    local pre; pre=$(dirname "$(dirname "$(command -v cmake)")")
    aib_ab_prop_set "${AIB_PROJECT_BUILD_ROOT:-$PWD}/local.properties" cmake.dir "$pre"
    aib_ab_log "ARM host: system cmake via cmake.dir=$pre"; return 0
  fi
  aib_ab_sdk_install "cmake;$v"
}

# NDK: Google's NDK host tools are x86_64.
#  termux       -> existing app-compatible aarch64 NDK only; no unqualified downloads
#  ubuntu-proot -> official NDK for sysroot/libs + system clang/lld symlinked in place of the x86_64 host tools (experimental)
aib_ab_ndk_release_for() { # revision -> rNN
  case "$1" in 25.2.*) echo r25c;; 26.1.*) echo r26b;; 26.2.*) echo r26c;; 27.0.*) echo r27;; 27.1.*) echo r27b;; 27.2.*) echo r27c;; 28.0.*) echo r28;; 28.1.*) echo r28b;; *) echo r27b;; esac
}
aib_ab_ndk_host_dir() { local d; for d in "$1"/toolchains/llvm/prebuilt/linux-aarch64 "$1"/toolchains/llvm/prebuilt/linux-x86_64; do [ -d "$d/bin" ] && { printf '%s' "$d"; return 0; }; done; return 1; }
aib_ab_ndk_runs() { local h; h=$(aib_ab_ndk_host_dir "$1") || return 1; "$h/bin/clang" --version >/dev/null 2>&1; }
aib_ab_install_ndk_termux() { # requested revision
  # Use only an already provisioned, qualified toolchain. No stock-Termux binary fallback.
  local req="$1" dest="$ANDROID_HOME/ndk/$1"
  if [ -f "$dest/source.properties" ] && grep -Eq "^Pkg.Revision[[:space:]]*=[[:space:]]*$req$" "$dest/source.properties" && aib_ab_ndk_runs "$dest"; then
    return 0
  fi
  aib_ab_log "AIB_PRIVATE_NDK_NOT_QUALIFIED: exact revision $req must be provisioned for this app namespace"
  return 78
}
aib_ab_install_ndk_ubuntu() { # requested revision
  local req="$1" dest="$ANDROID_HOME/ndk/$1" h b
  [ -d "$dest" ] || aib_ab_sdk_install "ndk;$req" || return 1
  aib_ab_have clang || aib_ab_pm_install clang lld llvm; aib_ab_have clang || return 1
  h="$dest/toolchains/llvm/prebuilt/linux-x86_64"; [ -d "$h/bin" ] || return 1
  mkdir -p "$h/bin.x86_64-orig" && cp -an "$h/bin/." "$h/bin.x86_64-orig/" 2>/dev/null
  for b in clang clang++ ld.lld lld llvm-ar llvm-ranlib llvm-strip llvm-nm llvm-objcopy llvm-objdump llvm-readelf llvm-as; do
    [ -x "$(command -v $b 2>/dev/null)" ] && ln -sf "$(command -v $b)" "$h/bin/$b"
  done
  aib_ab_log "NDK_UBUNTU_ARM_EXPERIMENTAL: system clang/lld linked into the official NDK sysroot"
  "$h/bin/clang" --version >/dev/null 2>&1
}
aib_ab_fix_ndk() {
  local v; v=$(aib_ab_first 'ndk;[0-9.]+' | sed 's/^ndk;//'); [ -z "$v" ] && v=$(aib_ab_project_ndk_version); [ -z "$v" ] && v=$(sed -nE 's/.*(NDK|ndkVersion)[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\2/p' "$AIB_AB_LOG" | head -n 1); [ -z "$v" ] && v=26.1.10909125
  aib_ab_pick_sdk
  if [ "$AIB_AB_BACKEND" = termux ]; then aib_ab_install_ndk_termux "$v"; return $?; fi
  if aib_ab_is_arm; then
    aib_ab_ndk_runs "$ANDROID_HOME/ndk/$v" && return 0
    if [ "$AIB_AB_BACKEND" = termux ]; then aib_ab_install_ndk_termux "$v"; else aib_ab_install_ndk_ubuntu "$v"; fi
    return $?
  fi
  aib_ab_sdk_install "ndk;$v"
}
aib_ab_fix_aapt2() { aib_ab_aapt2_override; grep -q '^android.aapt2FromMavenOverride=' "$GRADLE_USER_HOME/gradle.properties" 2>/dev/null; }
aib_ab_fix_oom() {
  local mem_kb mem_mb cur next cap
  mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null); mem_mb=$(( ${mem_kb:-4000000} / 1024 )); cap=$(( mem_mb * 70 / 100 ))
  cur=$(sed -nE 's/^org.gradle.jvmargs=.*-Xmx([0-9]+)m.*/\1/p' "$GRADLE_USER_HOME/gradle.properties" 2>/dev/null | head -n 1); cur=${cur:-1024}
  next=$(( cur * 3 / 2 )); [ "$next" -gt "$cap" ] && next=$cap
  [ "$next" -le "$cur" ] && { aib_ab_gprop_set org.gradle.workers.max 1; aib_ab_gprop_set kotlin.compiler.execution.strategy in-process; return 0; }
  aib_ab_gprop_set org.gradle.jvmargs "-Xmx${next}m -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8"; aib_ab_gprop_set org.gradle.workers.max 1
  pkill -f GradleDaemon >/dev/null 2>&1; aib_ab_log "Gradle heap -> ${next}m (cap ${cap}m)"; return 0
}
aib_ab_fix_network() {
  local n=0; while [ "$n" -lt 6 ]; do aib_ab_net_ok && break; n=$((n + 1)); aib_ab_log "network down, wait ${n}/6"; sleep $((n * 10)); done
  aib_ab_net_ok || return 1; export AIB_GRADLE_EXTRA_FLAGS="--refresh-dependencies"; return 0
}
aib_ab_gradle_for_agp() { # AGP major.minor -> Gradle version
  local f agp
  for f in $(aib_ab_gradle_files) "${AIB_PROJECT_BUILD_ROOT:-$PWD}/settings.gradle" "${AIB_PROJECT_BUILD_ROOT:-$PWD}/settings.gradle.kts"; do
    [ -f "$f" ] && agp=$(sed -nE 's/.*com\.android\.(tools\.build:gradle:|application"?[^0-9]*)([0-9]+\.[0-9]+).*/\2/p' "$f" | head -n 1) && [ -n "$agp" ] && break
  done
  case "$agp" in 7.0|7.1) echo 7.2;; 7.2) echo 7.3.3;; 7.3) echo 7.4;; 7.4) echo 7.5;; 8.0|8.1) echo 8.0;; 8.2) echo 8.2;; 8.3) echo 8.4;; 8.4) echo 8.6;; 8.5|8.6) echo 8.7;; 8.7) echo 8.9;; 8.8|8.9) echo 8.10.2;; *) echo 8.7;; esac
}
aib_ab_fix_wrapper() {
  local root="${AIB_PROJECT_BUILD_ROOT:-$PWD}" props url zip dist g ver
  props="$root/gradle/wrapper/gradle-wrapper.properties"
  [ -f "$root/gradlew" ] && chmod +x "$root/gradlew" 2>/dev/null
  [ -f "$root/gradle/wrapper/gradle-wrapper.jar" ] && [ -f "$root/gradlew" ] && return 0
  if [ -f "$props" ]; then
    url=$(sed -nE 's/^distributionUrl=(.*)/\1/p' "$props" | head -n 1 | sed 's#\\##g')
  else
    ver=$(aib_ab_gradle_for_agp); url="https://services.gradle.org/distributions/gradle-${ver}-bin.zip"
    aib_ab_log "no wrapper in project: generating one for Gradle $ver"
  fi
  [ -n "$url" ] || return 1
  zip="$AIB_AB_WORK/gradle-dist.zip"; aib_ab_download "$url" "$zip" || return 1
  dist="$HOME/.aib-gradle-dist"; rm -rf "$dist"; mkdir -p "$dist" && unzip -q -o "$zip" -d "$dist" || return 1
  g=$(ls -d "$dist"/gradle-*/bin/gradle 2>/dev/null | head -n 1); [ -x "$g" ] || return 1
  ( cd "$root" && "$g" wrapper --gradle-distribution-url "$url" --no-daemon 2>&1 | tail -n 4 ); rm -f "$zip"
  [ -f "$root/gradle/wrapper/gradle-wrapper.jar" ] && [ -f "$root/gradlew" ] && chmod +x "$root/gradlew"
}
aib_ab_fix_gradle_cache() {
  pkill -f GradleDaemon >/dev/null 2>&1
  rm -rf "$GRADLE_USER_HOME"/caches/transforms-* "$GRADLE_USER_HOME"/caches/journal-1 "$GRADLE_USER_HOME"/daemon "$GRADLE_USER_HOME"/native 2>/dev/null
  find "$GRADLE_USER_HOME/caches" -name '*.lock' -delete 2>/dev/null
  aib_ab_gprop_set org.gradle.native false; return 0
}
aib_ab_fix_native_platform() { aib_ab_gprop_set org.gradle.native false; aib_ab_gprop_set org.gradle.daemon false; rm -rf "$GRADLE_USER_HOME/native" 2>/dev/null; return 0; }
aib_ab_fix_kotlin_daemon() { aib_ab_gprop_set kotlin.compiler.execution.strategy in-process; return 0; }
aib_ab_fix_disk() {
  rm -rf "$GRADLE_USER_HOME"/caches/transforms-* "$GRADLE_USER_HOME"/caches/build-cache-* 2>/dev/null
  if [ "$AIB_AB_BACKEND" = termux ]; then apt-get clean >/dev/null 2>&1; else apt-get clean >/dev/null 2>&1; fi
  aib_ab_have npm && npm cache clean --force >/dev/null 2>&1; return 0
}
aib_ab_fix_js() { aib_ab_ensure_node && aib_ab_js_deps; aib_ab_expo_prebuild; return 0; }
aib_ab_fix_maven() { aib_ab_have mvn || aib_ab_pm_install maven; aib_ab_have mvn; }
aib_ab_fix_native_tools() { aib_ab_have cmake || aib_ab_pm_install cmake; aib_ab_have make || aib_ab_pm_install make; aib_ab_have cc || { [ "$AIB_AB_BACKEND" = termux ] && aib_ab_pm_install clang || aib_ab_pm_install build-essential; }; return 0; }
aib_ab_fix_perm() { local root="${AIB_PROJECT_BUILD_ROOT:-$PWD}"; [ -f "$root/gradlew" ] && chmod +x "$root/gradlew"; return 0; }

aib_ab_fix_flutter() {
  local d="$HOME/flutter"
  if ! aib_ab_have flutter; then
    [ -x "$d/bin/flutter" ] || { aib_ab_have git || aib_ab_pm_install git; git clone --depth 1 -b stable https://github.com/flutter/flutter.git "$d" 2>&1 | tail -n 2; }
    [ -x "$d/bin/flutter" ] && export PATH="$d/bin:$PATH"
  fi
  aib_ab_have flutter || return 1
  flutter config --no-analytics >/dev/null 2>&1; flutter precache --android 2>&1 | tail -n 3
  ( cd "${AIB_PROJECT_ROOT:-$PWD}" && flutter pub get 2>&1 | tail -n 3 )
  return 0
}

# ---------- diagnosis: log -> ordered fixer ids ----------
aib_ab_diagnose() {
  local L="$1"; local ids=""
  add() { ids="$ids $1"; }
  grep -qE 'JAVA_MISSING|NO_JAVA' "$L" && add jdk
  grep -qE 'SDK_MISSING|NO_SDK' "$L" && add sdk_dir
  grep -qE 'SDK_PLATFORM_MISSING|SKIP_OFFLINE_NO_PLATFORM' "$L" && add platform
  grep -qE 'NO_VERIFIED_GRADLE|NO_WRAPPER' "$L" && add wrapper
  grep -qiE 'JAVA_HOME is not set|Unable to locate a Java Runtime|java: (command )?not found|Unsupported class file major version|Could not determine java version|requires Java|invalid source release|Unsupported major\.minor|class file has wrong version|No Java compiler' "$L" && add jdk
  grep -qiE 'SDK location not found|Define a valid SDK location' "$L" && add sdk_dir
  grep -qiE 'licen[cs]es? .*not been accepted|not accepted the license|License for package .* not accepted|accept the SDK license' "$L" && add licenses
  grep -qiE "Failed to find target with hash string|Failed to find Platform SDK|platforms;android-" "$L" && add platform
  grep -qiE 'Failed to find Build Tools|Build-tool .* is missing|build-tools;[0-9]|Installed Build Tools revision .* is corrupted' "$L" && add buildtools
  grep -qiE "CMake '[0-9.]+' was not found|Could not find CMake|cmake;[0-9]" "$L" && add cmake
  grep -qiE 'toolchains/llvm/prebuilt/linux-x86_64/bin/[a-z+.-]+.*(Exec format error|cannot execute|not found|No such file)|ndk.*(Exec format error|cannot execute binary)' "$L" && add ndk
  grep -qiE 'cmake.*(Exec format error|cannot execute binary)|CMake Error.*(not found|No such file)' "$L" && add cmake
  grep -qiE 'NDK is missing|No version of NDK matched|did not have a source\.properties|ndkVersion|NDK not configured|ndk;[0-9]' "$L" && add ndk
  { grep -qiE 'aapt2.*(error|failed|not found|Syntax error|Exec format|cannot execute)|(Exec format error|cannot execute binary file).*aapt|AAPT2.*Daemon startup failed' "$L"; } && add aapt2
  grep -qiE "OutOfMemoryError|GC overhead limit|Metaspace|Java heap space|daemon disappeared unexpectedly|Cannot allocate memory|exit code 137|^Killed" "$L" && add oom
  grep -qiE 'Could not resolve|Could not GET|Could not HEAD|Connection (reset|refused|timed out)|Read timed out|UnknownHost|SSLHandshake|Network is unreachable|Temporary failure in name resolution|Premature end of Content-Length|Remote host terminated' "$L" && add network
  grep -qiE 'GradleWrapperMain|gradle-wrapper\.jar|gradlew: (not found|No such file)|Wrapper .*(not found|missing)' "$L" && add wrapper
  grep -qiE 'No space left on device|ENOSPC|Disk quota' "$L" && add disk
  grep -qiE "Timeout waiting to lock|Could not create service of type|Could not read workspace metadata|cache .*corrupt|corrupted .*cache" "$L" && add gradle_cache
  grep -qiE "Failed to load native library|libnative-platform|NativeIntegrationUnavailableException" "$L" && add native_platform
  grep -qiE "Could not connect to kotlin daemon|Kotlin compile daemon|kotlin daemon" "$L" && add kotlin_daemon
  grep -qiE "Cannot find module|MODULE_NOT_FOUND|ERR_PNPM|ENOENT.*node_modules|(node|pnpm|npm|yarn|expo): (command )?not found|Unable to resolve module|expo.*(prebuild|CLI).*(missing|failed)" "$L" && add js
  grep -qiE 'flutter: (command )?not found|Flutter SDK|pub get failed|Could not find a file named "pubspec' "$L" && add flutter
  grep -qiE 'mvn: (command )?not found' "$L" && add maven
  grep -qiE '(cmake|make|clang|gcc|cc): (command )?not found' "$L" && add native_tools
  grep -qiE 'gradlew.*Permission denied|Permission denied.*gradlew' "$L" && add perm
  printf '%s\n' $ids | awk '!seen[$0]++'
}
aib_ab_first_error() {
  { grep -m1 -E 'FAILURE: Build failed|What went wrong|Execution failed for task|error: |Error: |Could not |Exception' "$AIB_AB_LOG"; } 2>/dev/null | head -n 1 | cut -c1-300
}
aib_ab_reset_tier() {
  case "$1" in
    1) aib_ab_log "reset tier 1: stop daemons, clear project build outputs, refresh dependencies"
       pkill -f GradleDaemon >/dev/null 2>&1; local r="${AIB_PROJECT_BUILD_ROOT:-$PWD}"
       rm -rf "$r/.gradle" "$r/build" "$r/app/build" 2>/dev/null
       rm -rf "$GRADLE_USER_HOME"/caches/transforms-* 2>/dev/null; export AIB_GRADLE_EXTRA_FLAGS="--refresh-dependencies"; return 0 ;;
    2) aib_ab_log "reset tier 2: reinstall JS deps, restore wrapper, re-run preflight"
       aib_ab_js_deps >/dev/null 2>&1; aib_ab_fix_wrapper >/dev/null 2>&1; aib_ab_preflight >/dev/null 2>&1; return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- main loop ----------
aib_autobuild_main() {
  local start now attempt=0 rc=1 tier=0 ids id progressed frc
  start=$(date +%s); : > "$AIB_AB_HISTORY"
  aib_ab_preflight
  local preflight_ec=$?
  if [ "$preflight_ec" -eq 78 ]; then aib_ab_log "AIB_PRIVATE_NDK_NOT_QUALIFIED: build was not started"; return 78; fi
  while [ "$attempt" -lt "$AIB_AB_MAX" ]; do
    now=$(date +%s)
    if [ $((now - start)) -ge "$AIB_AB_WALL" ]; then aib_ab_log "wall-clock budget reached"; break; fi
    attempt=$((attempt + 1)); : > "$AIB_AB_LOG"
    aib_ab_log "build attempt $attempt/$AIB_AB_MAX"
    aib_primary 2>&1 | tee -a "$AIB_AB_LOG"; rc=${PIPESTATUS[0]}
    if [ "$rc" -eq 0 ]; then
      printf 'AIB_AUTOBUILD_RESULT=ok\nAIB_AUTOBUILD_ATTEMPTS=%s\nAIB_AUTOBUILD_FIXES=%s\n' "$attempt" "$(printf '%s' "$AIB_AB_APPLIED_IDS" | sed 's/^,//')"
      return 0
    fi
    tail -n 80 "$AIB_AB_LOG" >> "$AIB_AB_HISTORY"
    # The offline-first step of the app deliberately skips Expo projects; that is a routing decision, not a failure to repair.
    if grep -qE '^SKIP_OFFLINE_EXPO' "$AIB_AB_LOG"; then
      printf 'AIB_AUTOBUILD_RESULT=failed\nAIB_AUTOBUILD_ATTEMPTS=%s\nAIB_AUTOBUILD_FIXES=\nAIB_AUTOBUILD_NEEDS_LLM=0\nAIB_AUTOBUILD_FIRST_ERROR=SKIP_OFFLINE_EXPO\nAIB_AUTOBUILD_LOG=%s\n' "$attempt" "$AIB_AB_HISTORY"
      return "$rc"
    fi
    ids=$(aib_ab_diagnose "$AIB_AB_LOG"); progressed=0
    aib_ab_log "attempt $attempt failed rc=$rc; diagnosis: ${ids:-none}"
    for id in $ids; do
      [ "$(aib_ab_count "$id")" -ge "$AIB_AB_FIX_LIMIT" ] && continue
      aib_ab_log "fixer: $id"
      "aib_ab_fix_$id" >"$AIB_AB_WORK/fixer.out" 2>&1; frc=$?
      tail -n 12 "$AIB_AB_WORK/fixer.out"
      AIB_AB_FIXED="$AIB_AB_FIXED
$id"
      if [ "$frc" -eq 0 ]; then AIB_AB_APPLIED_IDS="$AIB_AB_APPLIED_IDS,$id"; progressed=1; fi
    done
    if [ "$progressed" -eq 0 ]; then
      tier=$((tier + 1)); aib_ab_reset_tier "$tier" || break
    fi
  done
  printf 'AIB_AUTOBUILD_RESULT=failed\nAIB_AUTOBUILD_ATTEMPTS=%s\nAIB_AUTOBUILD_FIXES=%s\nAIB_AUTOBUILD_NEEDS_LLM=1\nAIB_AUTOBUILD_FIRST_ERROR=%s\nAIB_AUTOBUILD_LOG=%s\n' "$attempt" "$(printf '%s' "$AIB_AB_APPLIED_IDS" | sed 's/^,//')" "$(aib_ab_first_error)" "$AIB_AB_HISTORY"
  return "${rc:-1}"
}
