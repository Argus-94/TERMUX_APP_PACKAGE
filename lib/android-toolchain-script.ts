/**
 * Read-only shell probe for ensureAndroidToolchain.
 * It inspects only the explicitly selected Termux host or Ubuntu/Debian guest.
 */
export type AndroidToolchainBackend = "termux" | "ubuntu-proot";

export function buildAndroidToolchainCommand(backend: AndroidToolchainBackend = "termux"): string {
  const isTermux = backend === "termux";
  const prefixInit = isTermux
    ? ': "${PREFIX:?AI_BUILDER_PRIVATE_PREFIX_REQUIRED}"'
    : 'unset PREFIX; PREFIX=""';
  const javaCandidates = isTermux
    ? [
        '"$PREFIX/lib/jvm/java-21-openjdk/bin/java"',
        '"$PREFIX/lib/jvm/java-17-openjdk/bin/java"',
        '"$PREFIX/lib/jvm/java-21-openjdk-aarch64/bin/java"',
        '"$PREFIX/lib/jvm/java-17-openjdk-aarch64/bin/java"',
        '"${JAVA_HOME:-/nonexistent}/bin/java"',
      ]
    : [
        '"${JAVA_HOME:-/nonexistent}/bin/java"',
        '"/usr/lib/jvm/java-17-openjdk-amd64/bin/java"',
        '"/usr/lib/jvm/java-17-openjdk-arm64/bin/java"',
        '"/usr/lib/jvm/java-17-openjdk-aarch64/bin/java"',
        '"/usr/lib/jvm/java-17-openjdk/bin/java"',
        '"/usr/lib/jvm/java-21-openjdk-amd64/bin/java"',
        '"/usr/lib/jvm/java-21-openjdk-arm64/bin/java"',
        '"/usr/lib/jvm/java-21-openjdk/bin/java"',
        '"/usr/lib/jvm/default-java/bin/java"',
      ];
  const sdkCandidates = isTermux
    ? [
        '"${ANDROID_HOME:-}"',
        '"${ANDROID_SDK_ROOT:-}"',
        '"$HOME/android-sdk"',
        '"$HOME/Android/Sdk"',
        '"$PREFIX/opt/aibuilder-toolpack/android-sdk"',
        '"$PREFIX/opt/android-sdk"',
        '"$PREFIX/share/android-sdk"',
        '"$PREFIX/lib/android-sdk"',
      ]
    : [
        '"${ANDROID_HOME:-}"',
        '"${ANDROID_SDK_ROOT:-}"',
        '"$HOME/android-sdk"',
        '"$HOME/Android/Sdk"',
        '"/opt/aibuilder-toolpack/android-sdk"',
        '"/opt/android-sdk"',
        '"/usr/local/android-sdk"',
        '"/usr/lib/android-sdk"',
      ];
  const javaLoop = `for JAVA_CANDIDATE in ${[...javaCandidates, '"$(command -v java 2>/dev/null || true)"'].join(" ")}; do`;
  const sdkLoop = `SDK=""; for d in ${sdkCandidates.join(" ")}; do`;

  return [
    "set +e",
    `AIB_TOOLCHAIN_BACKEND=${backend}`,
    prefixInit,
    'echo "AIB_TOOLCHAIN_START backend=$AIB_TOOLCHAIN_BACKEND"',
    'JAVA_BIN=""; JAVA_FIRST=""; JAVA_FAILURE=""; JAVA_SEEN=0',
    javaLoop,
    '  [ -n "$JAVA_CANDIDATE" ] && [ -x "$JAVA_CANDIDATE" ] || continue',
    '  JAVA_SEEN=1',
    '  JAVA_VERSION_OUTPUT=$("$JAVA_CANDIDATE" -version 2>&1); JAVA_EXIT=$?',
    '  JAVA_FIRST=$(printf "%s\\n" "$JAVA_VERSION_OUTPUT" | head -1)',
    '  JAVA_MAJOR=$(printf "%s\\n" "$JAVA_VERSION_OUTPUT" | sed -nE \'s/.*version "([0-9]+)(\\.[0-9]+)*".*/\\1/p\' | head -1)',
    '  case "$JAVA_MAJOR" in ""|*[!0-9]*) JAVA_MAJOR=0;; esac',
    '  if [ "$JAVA_EXIT" -eq 0 ] && [ "$JAVA_MAJOR" -ge 17 ]; then JAVA_BIN="$JAVA_CANDIDATE"; break; fi',
    '  if [ "$JAVA_EXIT" -ne 0 ]; then JAVA_FAILURE="BROKEN:$JAVA_CANDIDATE:$JAVA_FIRST"; elif [ "$JAVA_MAJOR" -gt 0 ]; then JAVA_FAILURE="TOO_OLD:$JAVA_CANDIDATE:$JAVA_FIRST"; else JAVA_FAILURE="VERSION_UNKNOWN:$JAVA_CANDIDATE:$JAVA_FIRST"; fi',
    "done",
    'if [ -n "$JAVA_BIN" ]; then echo "java=OK:$JAVA_BIN:$JAVA_FIRST"; elif [ "$JAVA_SEEN" = 1 ]; then echo "java=$JAVA_FAILURE"; echo "Java 17 or newer is required"; else echo java=MISSING; fi',
    'GRADLE_BIN=$(command -v gradle 2>/dev/null || true)',
    'if [ -n "$GRADLE_BIN" ]; then GV=$(gradle --version 2>&1); GEC=$?; GFIRST=$(printf "%s\\n" "$GV" | sed -n \'/^Gradle /{p;q;}\'); [ -n "$GFIRST" ] || GFIRST=$(printf "%s\\n" "$GV" | sed -n \'/[^[:space:]]/{p;q;}\'); if [ "$GEC" -eq 0 ] && [ -n "$GFIRST" ]; then echo "gradle=OK:path=$GRADLE_BIN:$GFIRST"; else echo "gradle=BROKEN:path=$GRADLE_BIN:no-version-output"; fi; else echo gradle=MISSING; fi',
    sdkLoop,
    '  [ -n "$d" ] || continue',
    '  [ -d "$d" ] || continue',
    '  if [ -d "$d/platforms" ] || [ -d "$d/build-tools" ] || [ -d "$d/cmdline-tools" ]; then SDK="$d"; break; fi',
    "done",
    'if [ -z "$SDK" ]; then echo sdk_dir=MISSING; echo sdk_platforms=MISSING; echo aapt2=MISSING; else',
    '  SDK_CANON=$(realpath -m -- "$SDK" 2>/dev/null || echo "$SDK")',
    '  echo "sdk_dir=$SDK_CANON"',
    '  PLATFORM=$(find "$SDK_CANON/platforms" -maxdepth 2 -type f -name android.jar -print 2>/dev/null | head -1)',
    '  if [ -n "$PLATFORM" ]; then echo "sdk_platforms=OK:$PLATFORM"; else echo sdk_platforms=MISSING; fi',
    '  BT=$(find "$SDK_CANON/build-tools" -maxdepth 2 -type f -name aapt2 -print 2>/dev/null | sort | tail -1)',
    '  if [ -n "$BT" ] && [ -x "$BT" ]; then echo "aapt2=OK:$BT"; else echo aapt2=MISSING; fi',
    "fi",
    'echo "AIB_TOOLCHAIN_END backend=$AIB_TOOLCHAIN_BACKEND"',
    "exit 0",
  ].join("\n");
}
