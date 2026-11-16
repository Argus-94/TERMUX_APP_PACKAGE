import { buildUniversalAgentPrompt } from "./autonomous-engineer";
import { errorMessage } from "./error-utils";
/**
 * Надёжный APK build-loop:
 * assembleDebug -> анализ реального лога -> исправление через AI/Termux -> повтор.
 *
 * Этот модуль не считает сборку успешной только по exit=0:
 * APK должен существовать, быть zipaligned и реально подписан V1+V2+V3.
 */

import { type TermuxCommandResult } from "./termux-bridge";
import { executeGuardedTermuxCommand } from "./termux-executor";
import { persistentLogger } from "./persistent-logger";
import { redactBuildDiagnostics } from "./log-redaction";
import { buildRecoveryContext, classifyRecoveryFailure } from "./agent-recovery";
import { withForegroundTask } from "./foreground-task";
import { notePossibleBuildKill } from "./background-survival";
import { getBuildBackend, hostVisiblePath, isLinuxProotBackend } from "./agent-shell-backend";
import { PRIVATE_BUILD_PATHS_INIT_SH } from "./private-path-policy";
import { isCanonicalAIBuilderWorkspacePath } from "./private-workspace-policy";

export interface GradleError {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  raw: string;
}

export interface BuildAttemptResult {
  success: boolean;
  exitCode: number;
  log: string;
  errors: GradleError[];
  apkHint?: string;
  rawApk?: string;
  signing?: {
    success: boolean;
    scheme: "V1+V2+V3";
    message: string;
  };
}

const ERROR_LINE =
  /(?:e:\s*)?(?:file:\/\/\/?)?([^\s:]+\.(?:kt|java|xml|kts|gradle))[:\s(]+(\d+)(?::(\d+))?[:\s)\-]+(.+)/i;

const ERROR_AAPT =
  /(?:AAPT2?|aapt2?)\s*(?:error|failed)?[:\s]+(.+)/i;

const ERROR_UNRESOLVED =
  /Could not (?:resolve|find|get resource|download)\s+(.+)/i;

const ERROR_SIMPLE = /(?:error|e):\s*(.+)/i;

export function parseGradleErrors(log: string): GradleError[] {
  const errors: GradleError[] = [];
  const seen = new Set<string>();

  for (const line of log.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!/error|e:|FAILED|What went wrong|Unresolved|cannot find|No such|Could not resolve|Execution failed|Permission denied|not found/i.test(t)) {
      continue;
    }

    const m = t.match(ERROR_LINE);
    if (m) {
      const key = `${m[1]}:${m[2]}:${m[4].slice(0, 100)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({
        file: m[1],
        line: Number(m[2]),
        column: m[3] ? Number(m[3]) : undefined,
        message: m[4].trim(),
        raw: t,
      });
      continue;
    }

    const aapt = t.match(ERROR_AAPT);
    if (aapt) {
      const key = `aapt:${aapt[1].slice(0, 120)}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push({ message: aapt[1].trim(), raw: t });
      }
      continue;
    }
    const unres = t.match(ERROR_UNRESOLVED);
    if (unres) {
      const key = `unres:${unres[1].slice(0, 120)}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push({ message: `Could not resolve ${unres[1].trim()}`, raw: t });
      }
      continue;
    }
    if (/FAILED|What went wrong|Execution failed|Could not resolve|Permission denied|not found/i.test(t)) {
      const key = t.slice(0, 160);
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push({ message: t, raw: t });
    } else {
      const sm = t.match(ERROR_SIMPLE);
      if (sm) {
        const key = sm[1].slice(0, 160);
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push({ message: sm[1].trim(), raw: t });
      }
    }
  }

  return errors.slice(0, 60);
}

export function formatErrorsForModel(errors: GradleError[]): string {
  if (!errors.length) return "(structured parser found no errors — inspect the log tail and assemble.log)";
  return errors
    .map((e, i) => {
      const loc = e.file
        ? `${e.file}${e.line != null ? `:${e.line}` : ""}${e.column != null ? `:${e.column}` : ""}`
        : "";
      return `${i + 1}. ${loc ? loc + " — " : ""}${e.message}`;
    })
    .join("\n");
}

export function findApkPaths(log: string): string[] {
  const paths = new Set<string>();
  const re = /(\/[^\s"'<>]+\.apk)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log))) paths.add(m[1]);

  if (/BUILD SUCCESSFUL/i.test(log)) {
    paths.add("app/build/outputs/apk/debug/app-debug.apk");
  }
  return [...paths];
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function androidBuildEnvironment(projectPath: string, writeLocalProperties = true, writeSdkLicenses = true, privateRuntime = false): string {
  const project = shellQuote(projectPath);
  const backend = privateRuntime ? "embedded-private" : getBuildBackend();
  const linuxProot = !privateRuntime && isLinuxProotBackend();
  const sdkCandidates = privateRuntime
    ? ['$PREFIX/opt/android-sdk', '$PREFIX/share/android-sdk', '$PREFIX/lib/android-sdk', '$ANDROID_HOME', '$ANDROID_SDK_ROOT']
    : linuxProot
    ? [
        '$ANDROID_HOME', '$ANDROID_SDK_ROOT',
        '$PREFIX/opt/android-sdk',
        '$HOME/Android/Sdk', '$HOME/android-sdk',
        '/opt/android-sdk', '/usr/local/android-sdk',
      ]
    : [
        '$ANDROID_HOME', '$ANDROID_SDK_ROOT', '$PREFIX/opt/android-sdk',
        '$PREFIX/share/android-sdk', '$PREFIX/lib/android-sdk',
      ];
  const javaCandidates = privateRuntime
    ? ['$PREFIX/lib/jvm/java-17-openjdk', '$PREFIX/lib/jvm/java-21-openjdk', '$JAVA_HOME']
    : linuxProot
    ? ['$JAVA_HOME', '/usr/lib/jvm/default-java', '$HOME/.sdkman/candidates/java/current']
    : ['$PREFIX/lib/jvm/java-17-openjdk', '$JAVA_HOME', '$PREFIX/lib/jvm/java-21-openjdk'];
  const ndkCandidates = privateRuntime
    ? ['$PREFIX/opt/android-ndk', '$SDK/ndk-bundle', '$ANDROID_NDK_HOME']
    : linuxProot
    ? ['$ANDROID_NDK_HOME', '/opt/android-ndk']
    : ['$ANDROID_NDK_HOME', '$PREFIX/opt/android-ndk', '$SDK/ndk-bundle'];
  return [
    `cd ${project}`,
    `SDK=""`,
    `for d in ${sdkCandidates.map((x) => `"${x}"`).join(' ')}; do if [ -n "$d" ] && [ -d "$d/platforms" ] && ls "$d/platforms"/android-*/android.jar >/dev/null 2>&1; then SDK="$d"; break; fi; done`,
    `if [ -z "$SDK" ]; then echo "ANDROID_SDK_NOT_FOUND backend=${backend}" >&2; exit 20; fi`,
    `JH=""`,
    `for d in ${javaCandidates.map((x) => `"${x}"`).join(' ')}; do if [ -x "$d/bin/java" ]; then JH="$d"; break; fi; done`,
    `if [ -z "$JH" ] && command -v java >/dev/null 2>&1; then JH=$(dirname "$(dirname "$(readlink -f "$(command -v java)" 2>/dev/null || command -v java)")"); fi`,
    `if [ -z "$JH" ] || [ ! -x "$JH/bin/java" ]; then echo "JAVA_NOT_FOUND backend=${backend}" >&2; exit 21; fi`,
    `"$JH/bin/java" -version >/dev/null 2>&1 || { echo "JAVA_RUNTIME_BROKEN" >&2; exit 21; }`,
    `export JAVA_HOME="$JH" ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"`,
    ...(privateRuntime
      ? [`PREFIX_REAL=$(realpath -e -- "$PREFIX") && SDK_REAL=$(realpath -e -- "$SDK") && JAVA_REAL=$(realpath -e -- "$JAVA_HOME") || { echo AIB_PRIVATE_TOOLCHAIN_PATH_INVALID; exit 25; }; case "$SDK_REAL" in "$PREFIX_REAL"/*) ;; *) echo AIB_ANDROID_SDK_OUTSIDE_PRIVATE_PREFIX; exit 25;; esac; case "$JAVA_REAL" in "$PREFIX_REAL"/*) ;; *) echo AIB_JAVA_OUTSIDE_PRIVATE_PREFIX; exit 25;; esac; SDK="$SDK_REAL"; JAVA_HOME="$JAVA_REAL"; export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK" JAVA_HOME`,]
      : []),
    `NDK=""; for d in ${ndkCandidates.map((x) => `"${x}"`).join(' ')}; do if [ -d "$d" ]; then NDK="$d"; break; fi; done; [ -n "$NDK" ] && export ANDROID_NDK_HOME="$NDK"`,
    ...(privateRuntime
      ? [`if [ -n "$NDK" ]; then NDK_REAL=$(realpath -e -- "$NDK") || { echo AIB_PRIVATE_NDK_PATH_INVALID; exit 25; }; case "$NDK_REAL" in "$PREFIX_REAL"/*|"$SDK"/*) ;; *) echo AIB_ANDROID_NDK_OUTSIDE_PRIVATE_PREFIX; exit 25;; esac; NDK="$NDK_REAL"; export ANDROID_NDK_HOME="$NDK"; fi`]
      : []),
    `export PATH="$JAVA_HOME/bin:$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$PATH"`,
    `BT=$(ls -d "$SDK/build-tools"/*/ 2>/dev/null | tail -1); [ -n "$BT" ] && export PATH="$BT:$PATH"`,
    ...(writeSdkLicenses ? [`mkdir -p "$SDK/licenses"`] : []),
    `mkdir -p "$HOME/.cache/aibuilder/gradle" "\${TMPDIR:-/tmp}/aibuilder"`,
    ...(privateRuntime
      ? [`export GRADLE_USER_HOME="$HOME/.aibuilder-gradle"`]
      : [`export GRADLE_USER_HOME="\${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"`]),
    `mkdir -p "$GRADLE_USER_HOME"`,
    ...(writeSdkLicenses
      ? [`printf '%s\n' '24333f8a63b6825ea9c5514f83c2829b004d1fee' > "$SDK/licenses/android-sdk-license"`, `printf '%s\n' '84831b9409646a918e30573bab4c9c91346d8abd' > "$SDK/licenses/android-sdk-preview-license"`]
      : [`[ -s "$SDK/licenses/android-sdk-license" ] && [ -s "$SDK/licenses/android-sdk-preview-license" ] || { echo AIB_SDK_LICENSES_NOT_ACCEPTED; exit 24; }`]),
    `AAPT2=$(ls "$SDK/build-tools"/*/aapt2 2>/dev/null | tail -1); [ -z "$AAPT2" ] && AAPT2=$(command -v aapt2 2>/dev/null || true)`,
    ...(privateRuntime
      ? [`if [ -n "$AAPT2" ]; then AAPT2_REAL=$(realpath -e -- "$AAPT2") || { echo AIB_PRIVATE_AAPT2_PATH_INVALID; exit 25; }; case "$AAPT2_REAL" in "$PREFIX_REAL"/*|"$SDK"/*) ;; *) echo AIB_AAPT2_OUTSIDE_PRIVATE_PREFIX; exit 25;; esac; AAPT2="$AAPT2_REAL"; fi`]
      : []),
    `echo "BUILD_BACKEND=${backend}"`,
    `echo "PROJECT_GRADLE_SETTINGS_PRESERVED=1"`,
    `echo "project_gradle_wrapper_properties=read-only"`,
    ...(writeLocalProperties ? [`echo "sdk.dir=$SDK" > local.properties`, `echo "local.properties sdk.dir=$SDK"`] : [`echo "LOCAL_PROPERTIES_WRITE_SKIPPED=1"`]),
    `if [ ! -f gradlew ]; then echo "GRADLE_RUNNER_MISSING" >&2; exit 22; fi`,
    `if [ -f gradle/wrapper/gradle-wrapper.jar ]; then echo "GRADLE_WRAPPER=project_verified"; else if grep -q "CBE / CI shim for Expo" gradlew 2>/dev/null; then echo "GRADLE_WRAPPER=expo_ci_shim"; else echo "GRADLE_WRAPPER_UNVERIFIED" >&2; exit 22; fi; fi`,
    `echo "BUILD_ENV JAVA_HOME=$JAVA_HOME SDK=$SDK AAPT2=$AAPT2"`,
  ].join("; ");
}

function buildCommand(projectPath: string, extraFlags = "", writeLocalProperties = true, allowPermissionRepair = true, writeSdkLicenses = true, privateRuntime = false, cachedGradlePath?: string): string {
  const project = shellQuote(projectPath);
  const gradleLaunch = cachedGradlePath ? '"$AIB_CACHED_GRADLE_BIN"' : "bash gradlew";
  return (
    androidBuildEnvironment(projectPath, writeLocalProperties, writeSdkLicenses, privateRuntime) +
    `; cd ${project}; ` +
    `if [ -f gradlew ]; then ` +
    `${allowPermissionRepair ? "chmod +x gradlew 2>/dev/null || true;" : "echo GRADLE_WRAPPER_MODE_UNCHANGED=1;"} echo "runner=${cachedGradlePath ? "cached-gradle-distribution" : "gradlew (verified wrapper)"}"; ` +
    `JVM_ARGS="\${AIB_GRADLE_JVMARGS:--Xmx1536m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8}"; ` +
    `ASSEMBLE_TASK="\${AIB_ASSEMBLE_TASK:-assembleDebug}"; ASSEMBLE_TASK=$(echo "$ASSEMBLE_TASK" | tr -cd 'a-zA-Z0-9'); [ -z "$ASSEMBLE_TASK" ] && ASSEMBLE_TASK=assembleDebug; echo "assemble_task=$ASSEMBLE_TASK"; ` +
    `LOCKDIR="\${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}/.aib-build.lockdir"; ` +
    `if [ -d "$LOCKDIR" ]; then LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKDIR" 2>/dev/null || echo 0) )); if [ "$LOCK_AGE" -gt 2700 ]; then echo "STALE_BUILD_LOCK age=$LOCK_AGE"; rm -rf "$LOCKDIR"; fi; fi; ` +
    `if ! mkdir "$LOCKDIR" 2>/dev/null; then echo "BUILD_LOCK_BUSY waiting"; waited=0; while [ $waited -lt 120 ]; do sleep 5; waited=$((waited+5)); if [ -d "$LOCKDIR" ]; then LA=$(( $(date +%s) - $(stat -c %Y "$LOCKDIR" 2>/dev/null || echo 0) )); [ "$LA" -gt 2700 ] && rm -rf "$LOCKDIR"; fi; mkdir "$LOCKDIR" 2>/dev/null && break; done; fi; ` +
    `if [ ! -d "$LOCKDIR" ]; then echo "BUILD_LOCK_TIMEOUT" >&2; EC=40; else ` +
    `trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT; ` +
    `AAPT2=$(ls "$SDK/build-tools"/*/aapt2 2>/dev/null | tail -1); [ -z "$AAPT2" ] && AAPT2=$(command -v aapt2 2>/dev/null || true); ` +
    `AAPT2_FLAG=""; if [ -n "$AAPT2" ]; then ${allowPermissionRepair ? 'chmod +x "$AAPT2" 2>/dev/null || true;' : 'echo AAPT2_MODE_UNCHANGED=1;'} AAPT2_FLAG="-Pandroid.aapt2FromMavenOverride=$AAPT2"; echo "aapt2_override=$AAPT2"; fi; ` +
    `${gradleLaunch} "$ASSEMBLE_TASK" --no-daemon --max-workers=2 --console=plain -x test --stacktrace -Dorg.gradle.jvmargs="\$JVM_ARGS" $AAPT2_FLAG \${AIB_GRADLE_EXTRA_FLAGS} ${extraFlags}; EC=\$?; ` +
    `fi; ` +
    `else echo "GRADLE_RUNNER_MISSING" >&2; EC=127; fi; ` +
    `echo "gradle_ec=$EC"; exit $EC`
  );
}

async function signApkV123(projectPath: string, rawApk: string, writeLocalProperties = true, writeSdkLicenses = true): Promise<{
  success: boolean;
  signedPath?: string;
  message: string;
}> {
  const project = shellQuote(projectPath);
  const raw = shellQuote(rawApk);
  const cmd =
    `set -e; PROJECT=${project}; cd "$PROJECT"; ${PRIVATE_BUILD_PATHS_INIT_SH}; ARTIFACTS="$PROJECT/artifacts"; mkdir -p "$ARTIFACTS"; export GRADLE_USER_HOME="$AIB_GRADLE"; ` +
    `SDK="$ANDROID_HOME"; [ -z "$SDK" ] && SDK="$ANDROID_SDK_ROOT"; [ -z "$SDK" ] && SDK="\${PREFIX:?AI_BUILDER_PRIVATE_PREFIX_REQUIRED}/opt/android-sdk"; ` +
    `BT=$(ls -d "$SDK/build-tools"/*/ 2>/dev/null | tail -1); BT="\${BT%/}"; ` +
    `ZIPALIGN=""; APKSIGNER=""; ` +
    `[ -n "$BT" ] && [ -x "$BT/zipalign" ] && ZIPALIGN="$BT/zipalign"; ` +
    `[ -n "$BT" ] && [ -x "$BT/apksigner" ] && APKSIGNER="$BT/apksigner"; ` +
    `[ -z "$ZIPALIGN" ] && command -v zipalign >/dev/null 2>&1 && ZIPALIGN=$(command -v zipalign); ` +
    `[ -z "$APKSIGNER" ] && command -v apksigner >/dev/null 2>&1 && APKSIGNER=$(command -v apksigner); ` +
    `KS="$AIB_KEYS/aib-debug.keystore"; ` +
    `if [ -n "$APKSIGNER" ] && [ ! -s "$KS" ]; then KEY_STAGE="$AIB_KEYS/.aib-debug.$$.keystore"; if keytool -genkeypair -v -keystore "$KEY_STAGE" -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=AIBuilder,O=Termux,C=US" >"$AIB_PRIVATE_ROOT/tmp/aibuilder-keytool.log" 2>&1; then chmod 600 "$KEY_STAGE"; ln "$KEY_STAGE" "$KS" 2>/dev/null || true; fi; rm -f -- "$KEY_STAGE"; fi; ` +
    `if [ -n "$APKSIGNER" ] && [ ! -s "$KS" ]; then echo DEBUG_KEYSTORE_UNAVAILABLE >&2; exit 31; fi; ` +
    `BASE=$(basename ${raw} .apk); BUILD_ID=$(date +%Y%m%d-%H%M%S)-$$; ALIGNED="$AIB_TMP/$BASE-$BUILD_ID-aligned.apk"; SIGNED="$ARTIFACTS/$BASE-$BUILD_ID-signed.apk"; SIGN_SOURCE="$ALIGNED"; trap 'rm -f -- "$ALIGNED"' EXIT; ` +
    `if [ -z "$ZIPALIGN" ] || [ -z "$APKSIGNER" ]; then ` +
    `  echo "UNSIGNED_APK_OK=${raw}"; echo "SIGN_TOOLS_MISSING zipalign=\${ZIPALIGN:-no} apksigner=\${APKSIGNER:-no}"; ` +
    `  printf '%s\n' "${raw}"; exit 0; ` +
    `fi; ` +
    `set +e; "$ZIPALIGN" -f -p 4 ${raw} "$ALIGNED"; ZA=$?; set -e; ` +
    `if [ $ZA -ne 0 ]; then echo "ZIPALIGN_FAIL" >&2; exit 32; fi; ` +
    `[ -s "$ALIGNED" ] || { echo "ZIPALIGN_OUTPUT_INVALID" >&2; exit 33; }; SIGN_SOURCE="$ALIGNED"; ` +
    `set +e; "$APKSIGNER" sign --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --ks "$KS" --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out "$SIGNED" "$SIGN_SOURCE"; SA=$?; set -e; ` +
    `if [ $SA -ne 0 ] || [ ! -s "$SIGNED" ]; then echo "APKSIGNER_FAIL"; echo "UNSIGNED_APK_OK=${raw}"; printf '%s\n' "${raw}"; exit 0; fi; ` +
    `VERIFY=$("$APKSIGNER" verify --verbose --print-certs "$SIGNED" 2>&1); EC=$?; printf '%s\n' "$VERIFY"; ` +
    `if [ $EC -ne 0 ]; then echo "APK_VERIFY_WARN"; echo "UNSIGNED_APK_OK=${raw}"; printf '%s\n' "${raw}"; exit 0; fi; ` +
    `V1_OK=0; V2_OK=0; V3_OK=0; printf '%s\n' "$VERIFY" | grep -Eiq 'v1.*true|Verified using v1 scheme.*true' && V1_OK=1 || true; ` +
    `printf '%s\n' "$VERIFY" | grep -Eiq 'v2.*true|Verified using v2 scheme.*true' && V2_OK=1 || true; ` +
    `printf '%s\n' "$VERIFY" | grep -Eiq 'v3.*true|Verified using v3 scheme.*true' && V3_OK=1 || true; ` +
    `if [ "$V1_OK" -ne 1 ] || [ "$V2_OK" -ne 1 ] || [ "$V3_OK" -ne 1 ]; then echo "APK_SIGNATURE_SCHEMES_INCOMPLETE v1=$V1_OK v2=$V2_OK v3=$V3_OK"; echo "UNSIGNED_APK_OK=${raw}"; printf '%s\n' "${raw}"; exit 0; fi; ` +
    `echo "SIGNED_V1_V2_V3_OK=$SIGNED"; ` +
    `printf '%s\n' "$SIGNED"`;

  try {
    const r = await executeGuardedTermuxCommand(
      androidBuildEnvironment(projectPath, writeLocalProperties, writeSdkLicenses) + "; " + cmd,
      {
        timeoutMs: 180_000,
        trustedInternal: true,
        allowSdkLicenseWrites: writeSdkLicenses,
        allowInternalDebugKeystore: true,
      }
    );
    const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
    const signedRaw = out.match(/SIGNED_V1_V2_V3_OK=(\S+\.apk)/i)?.[1];
    const unsignedRaw = out.match(/UNSIGNED_APK_OK=(\S+\.apk)/i)?.[1];
    const fullySigned = r.exitCode === 0 && !!signedRaw && /SIGNED_V1_V2_V3_OK=/i.test(out);
    const unsignedOk = r.exitCode === 0 && !!unsignedRaw && /UNSIGNED_APK_OK=/i.test(out);
    // Unsigned output is a diagnostic artifact, never a successful build result.
    const ok = fullySigned;
    return {
      success: ok,
      signedPath: ok ? hostVisiblePath(signedRaw!) : (unsignedOk ? hostVisiblePath(unsignedRaw!) : undefined),
      message: out.slice(-5000),
    };
  } catch (e: unknown) {
    return { success: false, message: errorMessage(e) };
  }
}

export type AndroidToolchainBuildOnlyResult = Readonly<{
  ok: boolean;
  artifactPath?: string;
  failureCode?: string;
}>;

/**
 * Production build-only adapter used by the coordinator. Unlike runAssembleDebug,
 * this deliberately stops before signing so the coordinator can verify each
 * stage in order. It uses the existing guarded Termux/proot build boundary.
 */
export async function runAndroidToolchainBuildOnly(projectPath: string): Promise<AndroidToolchainBuildOnlyResult> {
  const root = String(projectPath || "").trim();
  if (!isCanonicalAIBuilderWorkspacePath(root) || root.includes("\0") || /(^|\/)\.\.(?:\/|$)/.test(root)) {
    return { ok: false, failureCode: "PROJECT_PATH_INVALID" };
  }
  return withForegroundTask("build", `coordinator assembleDebug ${root.split("/").filter(Boolean).pop() || "app"}`, async () => {
    try {
      const offlinePreflight = androidBuildEnvironment(root, false, false, true) + `; cd ${shellQuote(root)}; ` +
        `URL=$(sed -n 's/^distributionUrl=//p' gradle/wrapper/gradle-wrapper.properties 2>/dev/null | head -n 1 | sed 's/\\\\:/:/g'); ` +
        `case "$URL" in https://services.gradle.org/distributions/gradle-*-bin.zip|https://services.gradle.org/distributions/gradle-*-all.zip|https://downloads.gradle.org/distributions/gradle-*-bin.zip|https://downloads.gradle.org/distributions/gradle-*-all.zip) ;; *) echo AIB_GRADLE_DISTRIBUTION_URL_UNSUPPORTED; exit 23;; esac; ` +
        `DIST=$(basename "$URL" .zip); printf '%s' "$DIST" | grep -Eq '^gradle-[0-9]+([.][0-9]+)*(-bin|-all)$' || { echo AIB_GRADLE_DISTRIBUTION_INVALID; exit 23; }; ` +
        `CACHE="$GRADLE_USER_HOME/wrapper/dists/$DIST"; ` +
        `[ -d "$CACHE" ] || { echo AIB_GRADLE_DISTRIBUTION_NOT_CACHED_OFFLINE; exit 23; }; ` +
        `GRADLE_BIN=$(find "$CACHE" -type f -path '*/bin/gradle' -executable -print -quit); ` +
        `[ -n "$GRADLE_BIN" ] || { echo AIB_GRADLE_DISTRIBUTION_NOT_CACHED_OFFLINE; exit 23; }; ` +
        `GRADLE_HOME_REAL=$(realpath -e -- "$GRADLE_USER_HOME") && GRADLE_BIN_REAL=$(realpath -e -- "$GRADLE_BIN") || { echo AIB_GRADLE_DISTRIBUTION_CACHE_INVALID; exit 23; }; ` +
        `case "$GRADLE_BIN_REAL" in "$GRADLE_HOME_REAL"/wrapper/dists/"$DIST"/*/gradle-*/bin/gradle) ;; *) echo AIB_GRADLE_DISTRIBUTION_CACHE_INVALID; exit 23;; esac; ` +
        `echo "AIB_CACHED_GRADLE_BIN=$GRADLE_BIN_REAL"; echo AIB_GRADLE_OFFLINE_READY=1`;
      const preflight = await executeGuardedTermuxCommand(offlinePreflight, {
        timeoutMs: 45_000,
        trustedInternal: true,
        executionTarget: "embedded-private",
        workdir: root,
        preserveOutput: true,
      });
      const preflightOutput = `${preflight.stdout || ""}\n${preflight.stderr || ""}`;
      const cachedGradlePath = preflightOutput.match(/(?:^|\n)AIB_CACHED_GRADLE_BIN=(\S+)(?:\n|$)/)?.[1];
      if (preflight.exitCode !== 0 || !/AIB_GRADLE_OFFLINE_READY=1/.test(preflightOutput) || !cachedGradlePath) {
        const failureCode = /AIB_GRADLE_DISTRIBUTION_NOT_CACHED_OFFLINE/.test(preflightOutput) ? "GRADLE_DISTRIBUTION_NOT_CACHED_OFFLINE"
          : /AIB_GRADLE_DISTRIBUTION_URL_UNSUPPORTED|AIB_GRADLE_DISTRIBUTION_INVALID|AIB_GRADLE_DISTRIBUTION_CACHE_INVALID/.test(preflightOutput) ? "GRADLE_DISTRIBUTION_UNVERIFIED_OFFLINE"
            : /AIB_SDK_LICENSES_NOT_ACCEPTED/.test(preflightOutput) ? "ANDROID_SDK_LICENSES_NOT_ACCEPTED"
            : "ANDROID_TOOLCHAIN_PREFLIGHT_FAILED";
        return { ok: false, failureCode };
      }
      const command = `AIB_PRIVATE_OFFLINE_BUILD_V1=1; export AIB_PRIVATE_OFFLINE_BUILD_V1; AIB_CACHED_GRADLE_BIN=${shellQuote(cachedGradlePath)}; export AIB_CACHED_GRADLE_BIN; AIB_ASSEMBLE_TASK=assembleDebug; AIB_GRADLE_EXTRA_FLAGS=--offline; ${buildCommand(root, "", false, false, false, true, cachedGradlePath)}`;
      const result = await executeGuardedTermuxCommand(command, {
        timeoutMs: 900_000,
        isBuild: true,
        trustedInternal: true,
        executionTarget: "embedded-private",
        offlineBuild: true,
        workdir: root,
        preserveOutput: true,
      });
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      if (result.exitCode !== 0 || !/BUILD SUCCESSFUL/i.test(output) || /ANDROID_SDK_NOT_FOUND|JAVA_NOT_FOUND|GRADLE_RUNNER_MISSING/i.test(output)) {
        return { ok: false, failureCode: classifyAndroidBuildFailure(output) };
      }
      const find = await executeGuardedTermuxCommand(
        `cd ${shellQuote(root)} && find app/build/outputs/apk/debug -maxdepth 1 -type f -name '*.apk' ! -name '*-signed.apk' ! -name '*-aligned.apk' ! -name '*-androidTest*.apk' -print 2>/dev/null`,
        { timeoutMs: 20_000, trustedInternal: true, executionTarget: "embedded-private", workdir: root, preserveOutput: true },
      );
      const candidates = (find.stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      const candidate = candidates.find((value) => /(?:^|\/)app-debug\.apk$/i.test(value)) ?? candidates[0];
      if (find.exitCode !== 0 || !candidate) return { ok: false, failureCode: "APK_OUTPUT_NOT_FOUND" };
      const absolute = candidate.startsWith("/") ? candidate : `${root.replace(/\/$/, "")}/${candidate.replace(/^\.\//, "")}`;
      if (!isLexicallyWithin(root, absolute)) return { ok: false, failureCode: "APK_OUTPUT_OUTSIDE_PROJECT" };
      return { ok: true, artifactPath: hostVisiblePath(absolute) };
    } catch {
      return { ok: false, failureCode: "ANDROID_BUILD_EXECUTION_FAILED" };
    }
  });
}

/** Sign with the existing app-owned V1/V2/V3 signer; key material never leaves this host function. */
export async function runAndroidToolchainSign(projectPath: string, artifactPath: string): Promise<AndroidToolchainBuildOnlyResult> {
  const root = String(projectPath || "").trim();
  const artifact = String(artifactPath || "").trim();
  if (!isLexicallyWithin(root, artifact)) return { ok: false, failureCode: "APK_PATH_OUTSIDE_PROJECT" };
  const signed = await signApkV123(root, artifact, false, false);
  return signed.success && signed.signedPath && isLexicallyWithin(root, signed.signedPath)
    ? { ok: true, artifactPath: signed.signedPath }
    : { ok: false, failureCode: "APK_V1_V2_V3_SIGNING_FAILED" };
}

/** Verify containment, regular-file status, SHA-256, package id, and (after signing) all three schemes. */
export async function verifyAndroidToolchainArtifact(
  projectPath: string,
  artifactPath: string,
  requireV123: boolean,
): Promise<Readonly<{ verified: boolean; artifactPath: string; regularFile: boolean; sha256: string; applicationId: string; errors: readonly string[] }>> {
  const root = String(projectPath || "").trim();
  const artifact = String(artifactPath || "").trim();
  const invalid = { verified: false, artifactPath: artifact, regularFile: false, sha256: "", applicationId: "", errors: ["ARTIFACT_PATH_INVALID"] } as const;
  if (!isLexicallyWithin(root, artifact)) return invalid;
  try {
    const command = androidBuildEnvironment(root, false, false) + `; cd ${shellQuote(root)}; ` +
      `ROOT=$(realpath -e -- ${shellQuote(root)}) || exit 40; APK=$(realpath -e -- ${shellQuote(artifact)}) || exit 41; ` +
      `case "$APK" in "$ROOT"/*) ;; *) echo AIB_ARTIFACT_OUTSIDE_PROJECT; exit 42 ;; esac; ` +
      `[ -f "$APK" ] && [ ! -L ${shellQuote(artifact)} ] || { echo AIB_ARTIFACT_NOT_REGULAR; exit 43; }; ` +
      `SHA=$(sha256sum -- "$APK" | awk '{print $1}'); ` +
      `AAPT=$(command -v aapt 2>/dev/null || true); [ -n "$AAPT" ] || { echo AIB_AAPT_MISSING; exit 44; }; ` +
      `PKG=$("$AAPT" dump badging "$APK" 2>/dev/null | sed -n "s/^package: name='\\([^']*\\)'.*/\\1/p" | head -n 1); ` +
      `[ -n "$PKG" ] || { echo AIB_PACKAGE_ID_UNREADABLE; exit 45; }; ` +
      `echo AIB_ARTIFACT_PATH="$APK"; echo AIB_SHA256="$SHA"; echo AIB_APPLICATION_ID="$PKG"; ` +
      (requireV123
        ? `APKSIGNER=$(command -v apksigner 2>/dev/null || true); [ -n "$APKSIGNER" ] || { echo AIB_APKSIGNER_MISSING; exit 46; }; ` +
          `VERIFY=$("$APKSIGNER" verify --verbose "$APK" 2>&1) || { echo AIB_SIGNATURE_INVALID; exit 47; }; ` +
          `printf '%s\\n' "$VERIFY"; ` +
          `printf '%s\\n' "$VERIFY" | grep -Eiq 'verified using v1 scheme.*true|v1.*true' || exit 48; ` +
          `printf '%s\\n' "$VERIFY" | grep -Eiq 'verified using v2 scheme.*true|v2.*true' || exit 49; ` +
          `printf '%s\\n' "$VERIFY" | grep -Eiq 'verified using v3 scheme.*true|v3.*true' || exit 50; echo AIB_V123_OK=1;`
        : "echo AIB_CONTENT_VERIFIED=1;");
    const result = await executeGuardedTermuxCommand(command, {
      timeoutMs: 45_000,
      trustedInternal: true,
      workdir: root,
      preserveOutput: true,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const artifactOut = output.match(/AIB_ARTIFACT_PATH=(\S+)/)?.[1] ?? "";
    const hostArtifactPath = artifactOut ? hostVisiblePath(artifactOut) : "";
    const sha256 = output.match(/AIB_SHA256=([a-f0-9]{64})/i)?.[1] ?? "";
    const applicationId = output.match(/AIB_APPLICATION_ID=([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)/)?.[1] ?? "";
    const verified = result.exitCode === 0 && !!hostArtifactPath && isLexicallyWithin(root, hostArtifactPath) &&
      /^[a-f0-9]{64}$/i.test(sha256) && !!applicationId &&
      (!requireV123 || /AIB_V123_OK=1/.test(output));
    return Object.freeze({
      verified,
      artifactPath: hostArtifactPath || artifact,
      regularFile: !!artifactOut,
      sha256,
      applicationId,
      errors: Object.freeze(verified ? [] : ["ARTIFACT_VERIFICATION_FAILED"]),
    });
  } catch {
    return invalid;
  }
}

function isLexicallyWithin(root: string, candidate: string): boolean {
  if (!root.startsWith("/") || !candidate.startsWith("/") || root.includes("\0") || candidate.includes("\0") ||
      root.includes("\\") || candidate.includes("\\") || /(^|\/)\.\.(?:\/|$)/.test(root) || /(^|\/)\.\.(?:\/|$)/.test(candidate)) return false;
  const normalizedRoot = root.replace(/\/$/, "");
  return candidate.startsWith(`${normalizedRoot}/`);
}

function classifyAndroidBuildFailure(output: string): string {
  if (/ANDROID_SDK_NOT_FOUND/.test(output)) return "ANDROID_SDK_NOT_FOUND";
  if (/JAVA_NOT_FOUND|JAVA_RUNTIME_BROKEN/.test(output)) return "JAVA_UNAVAILABLE";
  if (/GRADLE_RUNNER_MISSING|GRADLE_WRAPPER_UNVERIFIED/.test(output)) return "GRADLE_WRAPPER_UNAVAILABLE";
  if (/BUILD_LOCK_BUSY|BUILD_LOCK_TIMEOUT/.test(output)) return "BUILD_LOCK_UNAVAILABLE";
  return "ANDROID_BUILD_FAILED";
}

/** Одна попытка assembleDebug + обязательная проверка/подпись V1+V2+V3. */
export interface BuildStageUpdate {
  id: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
}

export async function runAssembleDebug(
  projectPath: string,
  timeoutMs = 900_000,
  onStage?: (update: BuildStageUpdate) => void
): Promise<BuildAttemptResult> {
  const root = String(projectPath || "").trim();
  // Project roots are discovered dynamically and may live in shared storage,
  // Termux HOME, a proot HOME, or another backend-visible absolute location.
  // Do not reject valid projects merely because their path is not one of the
  // historical AIBuilderTermux locations. Parent traversal is rejected here;
  // the central shell guard remains the final sandbox/policy boundary.
  if (!root || !root.startsWith("/") || root.includes("\0") || /(^|\/)\.\.(?:\/|$)/.test(root)) {
    return {
      success: false,
      exitCode: 1,
      log: "PROJECT_PATH_INVALID",
      errors: [{ message: "PROJECT_PATH_INVALID", raw: "PROJECT_PATH_INVALID" }],
    };
  }
  const leaf = root.split("/").filter(Boolean).pop() || "app";
  return withForegroundTask("build", `assembleDebug ${leaf}`, async () =>
    runAssembleDebugInner(projectPath, timeoutMs, onStage),
  );
}

async function runAssembleDebugInner(
  projectPath: string,
  timeoutMs = 600_000,
  onStage?: (update: BuildStageUpdate) => void
): Promise<BuildAttemptResult> {
  const watchId = `assemble-debug-${Date.now()}`;
  const markBuild = async (health: "ok" | "failed", detail?: string) => {
    try {
      const { getRuntimeFacade } = await import("./runtime-facade");
      const reg = getRuntimeFacade().processRegistry;
      if (!reg.get(watchId) && health === "ok") {
        reg.register({
          id: watchId,
          kind: "runtime",
          startedAt: Date.now(),
          label: "assembleDebug",
          metadata: { watchdog: "true", source: "build-loop", health: "ok" },
        });
      } else if (reg.get(watchId)) {
        reg.patchMetadata(watchId, { health, detail: (detail || health).slice(0, 120) });
      } else if (health === "failed") {
        reg.register({
          id: watchId,
          kind: "runtime",
          startedAt: Date.now(),
          label: "assembleDebug",
          metadata: { watchdog: "true", source: "build-loop", health: "failed" },
        });
      }
    } catch {
      /* optional */
    }
  };
  try {
    const { getRuntimeFacade } = await import("./runtime-facade");
    getRuntimeFacade().processRegistry.register({
      id: watchId,
      kind: "runtime",
      startedAt: Date.now(),
      label: "assembleDebug",
      metadata: { watchdog: "true", source: "build-loop", health: "ok" },
    });
  } catch {
    /* optional */
  }
  try {
  const stage = (id: string, status: BuildStageUpdate["status"], detail?: string) =>
    onStage?.({ id, status, detail });
  stage("setup", "active", "Проверяю окружение Android/Java/Gradle");
  const cmd = buildCommand(projectPath);
  persistentLogger.add("info", "Build", `$ ${cmd}`);

  let result: TermuxCommandResult;
  stage("setup", "done", "Окружение готово");
  stage("compile", "active", "Gradle собирает APK — ждём полного завершения");
  try {
    result = await executeGuardedTermuxCommand(cmd, {
      timeoutMs,
      isBuild: true,
      trustedInternal: true,
      allowSdkLicenseWrites: true,
    });
  } catch (e: unknown) {
    const msg = redactBuildDiagnostics(errorMessage(e), projectPath);
    persistentLogger.add("error", "Build", msg);
    stage("setup", "error", msg);
    void notePossibleBuildKill("assemble-throw");
    await markBuild("failed", "throw");
    return {
      success: false,
      exitCode: 1,
      log: msg,
      errors: [{ message: msg, raw: msg }],
    };
  }

  const rawLog = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  let log = redactBuildDiagnostics(rawLog, projectPath);
  const errors = parseGradleErrors(rawLog).map((entry) => ({
    ...entry,
    file: entry.file ? redactBuildDiagnostics(entry.file, projectPath) : undefined,
    message: redactBuildDiagnostics(entry.message, projectPath),
    raw: redactBuildDiagnostics(entry.raw, projectPath),
  }));
  let success =
    result.exitCode === 0 &&
    /BUILD SUCCESSFUL/i.test(rawLog) &&
    !/GRADLE_MISSING|ANDROID_SDK_NOT_FOUND|JAVA_NOT_FOUND/i.test(rawLog);

  if (success) stage("compile", "done", "Gradle завершил сборку успешно");
  else {
    stage("compile", "error", errors[0]?.message || "Gradle завершился с ошибкой");
    void notePossibleBuildKill("assemble-gradle-fail");
  }
  stage("apk", success ? "active" : "error", success ? "Ищу реальный APK в outputs/apk" : "Сборка не завершилась — агент анализирует причину");
  let apks = findApkPaths(rawLog);
  let rawApk: string | undefined;

  if (success) {
    try {
      const verify = await executeGuardedTermuxCommand(
        `cd ${shellQuote(projectPath)} && find . -type f \\( -path "*/outputs/apk/*.apk" -o -path "*/outputs/apk/**/*.apk" -o -path "*/outputs/apk/*/*/*.apk" \\) ! -name "*-signed.apk" ! -name "*-aligned.apk" ! -name "*-androidTest*.apk" -print 2>/dev/null; find . -type f -name "*.apk" -path "*/build/outputs/*" ! -name "*-signed.apk" ! -name "*-aligned.apk" ! -name "*-androidTest*.apk" -print 2>/dev/null | head -30`,
        { timeoutMs: 20_000, trustedInternal: true }
      );
      const candidates = (verify.stdout || "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (verify.exitCode === 0 && candidates.length) {
        stage("apk", "done", "APK найден в каталоге outputs/apk");
        stage("align", "active", "Подготавливаю APK к подписи");
        const preferred =
          candidates.find((x) => /app-debug\.apk$/i.test(x)) ||
          candidates.find((x) => /debug\.apk$/i.test(x)) ||
          candidates[0];
        rawApk = preferred.startsWith("/")
          ? preferred
          : `${projectPath}/${preferred.replace(/^\.\//, "")}`;
        apks = [...new Set([...apks, rawApk])];
      } else {
        stage("apk", "error", "BUILD SUCCESSFUL, но файл APK не найден");
        success = false;
        errors.push({
          file: rawApk ?? undefined,
          message: "BUILD SUCCESSFUL, but a real APK output was not found",
          raw: "APK_NOT_FOUND",
        });
      }
    } catch (e: unknown) {
      success = false;
      errors.push({
        file: rawApk ?? undefined,
        message: redactBuildDiagnostics(`APK output verification failed: ${errorMessage(e)}`, projectPath),
        raw: redactBuildDiagnostics(String(e), projectPath),
      });
    }
  }

  let signing: BuildAttemptResult["signing"];
  if (success && rawApk) {
    const signed = await signApkV123(projectPath, rawApk);
    stage("align", "done", "Выравнивание выполнено");
    stage("sign", "active", "Подписываю V1 + V2 + V3");
    const signingMessage = redactBuildDiagnostics(signed.message, projectPath);
    signing = {
      success: signed.success,
      scheme: "V1+V2+V3",
      message: signingMessage,
    };
    log += `\n\n--- SIGN V1+V2+V3 ---\n${signingMessage}`;
    if (signed.success && signed.signedPath && /SIGNED_V1_V2_V3_OK/i.test(signed.message)) {
      stage("sign", "done", "Подпись V1 + V2 + V3 подтверждена");
      stage("verify", "done", "apksigner verify прошёл успешно");
      apks = [...new Set([...apks, signed.signedPath])];
    } else if (/UNSIGNED_APK_OK/i.test(signingMessage)) {
      stage("sign", "error", "APK собран, но V1+V2+V3 подпись не подтверждена");
      stage("verify", "error", "Unsigned APK не считается успешным результатом");
      success = false;
      if (signed.signedPath) apks = [...new Set([...apks, signed.signedPath])];
      errors.push({
        file: rawApk,
        message: "APK was built but signing tools or signing verification are unavailable; unsigned APK is not accepted as build success",
        raw: "UNSIGNED_APK_NOT_ACCEPTED",
      });
    } else {
      stage("sign", "error", "Не удалось подтвердить V1 + V2 + V3");
      success = false;
      errors.push({
        file: rawApk,
        message: `APK signing V1+V2+V3 failed: ${signingMessage.slice(-1200)}`,
        raw: "SIGNING_FAILED",
      });
    }
  }

  persistentLogger.add(
    success ? "info" : "warn",
    "Build",
    `exit=${result.exitCode} success=${success} errors=${errors.length}` +
      (signing ? ` signing=${signing.success ? "V1+V2+V3" : "failed"}` : "")
  );

  if (success) await markBuild("ok", "success");
  else await markBuild("failed", "assemble-fail");
  const visibleApks = apks.map(hostVisiblePath);
  const visibleRawApk = rawApk ? hostVisiblePath(rawApk) : undefined;
  return {
    success,
    exitCode: result.exitCode,
    log: log.slice(-20_000),
    errors,
    apkHint: visibleApks.find((x) => /-signed\.apk$/i.test(x)) || visibleApks[0],
    rawApk: visibleRawApk,
    signing,
  };
  } finally {
    try {
      const { getRuntimeFacade } = await import("./runtime-facade");
      getRuntimeFacade().processRegistry.unregister(watchId);
    } catch {
      /* ignore */
    }
  }
}

export function buildFixPrompt(
  projectPath: string,
  attempt: number,
  maxAttempts: number,
  build: BuildAttemptResult,
  recoveryHistory: string[] = []
): string {
  const safeProjectPath = redactBuildDiagnostics(projectPath, projectPath);
  const safeLog = redactBuildDiagnostics(build.log, projectPath);
  const safeErrors = build.errors.map((entry) => ({
    ...entry,
    file: entry.file ? redactBuildDiagnostics(entry.file, projectPath) : undefined,
    message: redactBuildDiagnostics(entry.message, projectPath),
    raw: redactBuildDiagnostics(entry.raw, projectPath),
  }));
  const safeHistory = recoveryHistory.map((item) => redactBuildDiagnostics(item, projectPath));
  const recovery = redactBuildDiagnostics(
    buildRecoveryContext(classifyRecoveryFailure(safeLog), safeHistory),
    projectPath,
  );
  return (
    buildUniversalAgentPrompt("build") + "\n\n" +
    `[BUILD_RECOVERY attempt ${attempt}/${maxAttempts}]\n` +
    `Project: ${safeProjectPath}\n` +
    `The Android build/signing attempt FAILED. The user must NOT receive this intermediate error.\n` +
    `You are the autonomous repair engineer. Inspect the REAL project and REAL logs, diagnose the root cause, apply the smallest safe fix, and verify it.\n\n` +
    `Structured errors:\n${formatErrorsForModel(safeErrors)}\n\n` +
    `Credential- and path-redacted build log tail:\n${safeLog.slice(-9000)}\n\n` +
    recovery +
    `\n\nRequired recovery behavior:\n` +
    `1. Inspect the actual files/paths and the full relevant assemble log before editing.\n` +
    `2. Fix source/config problems with AIB_TOOL hashline/AST tools; use TERMUX_RUN only for read-only inspection. Use AIB_TOOL:build.run for build/Gradle/SDK commands.\n` +
    `3. If a path is wrong, discover the real path with pwd/ls/find and replace it; never invent paths.\n` +
    `4. If a dependency/download is broken, diagnose 404/timeout/HTML/wrong-architecture responses and retry only the pinned allowlisted source or an already verified cached artifact. Do not substitute an unverified mirror.\n` +
    `5. On Termux aarch64, never install desktop x86_64/amd64/Windows/macOS binaries. NDK must be Android aarch64.\n` +
    `6. If a tool is missing, install the correct Termux package; do not merely report it.\n` +
    `7. If Gradle is the problem, repair wrapper/properties/repositories and retry. Do not blindly downgrade working project plugins.\n` +
    `8. After fixes, run a real verification command. Do not invent BUILD SUCCESSFUL, [TERMUX_RESULT], or file contents.\n` +
    `9. You may run assembleDebug yourself, but final success is accepted only after the outer builder verifies the APK and V1+V2+V3 signing.\n` +
    `10. Finish with TERMUX_DONE describing briefly what you actually changed/tried. Never return an intermediate failure just because one fix did not work; try another reasonable recovery path.`
  );
}

export function buildSuccessMessage(projectPath: string, build: BuildAttemptResult): string {
  return (
    `✅ APK готов\n` +
    `Проект: ${projectPath}\n` +
    (build.apkHint ? `APK: ${build.apkHint}\n` : "") +
    `Подпись: V1 + V2 + V3 ✓\n` +
    `Сборка и подпись проверены реально.`
  );
}

export async function quickBuildOnce(projectPath: string): Promise<BuildAttemptResult> {
  return runAssembleDebug(projectPath);
}
