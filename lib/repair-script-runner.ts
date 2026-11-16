import { persistentLogger } from "./persistent-logger";
/**
 * Allowlisted execution of DeterministicRepair recipes via Termux.
 * Only recipes with risk "low" | "medium" may run; high-risk requires explicit confirm.
 * AIB_INTERNAL:* hints are handled in-process (no shell).
 */
import { createDeterministicRepair, type RepairRecipe } from "../core/recovery/DeterministicRepair";
import { getRuntimeFacade } from "./runtime-facade";
import { executeGuardedTermuxCommand } from "./termux-executor";
import { getBuildBackend } from "./agent-shell-backend";
import { PRIVATE_BUILD_PATHS_INIT_SH } from "./private-path-policy";

export type RepairRunResult = Readonly<{
  ok: boolean;
  recipeId: string;
  message: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}>;

const repair = createDeterministicRepair();

/** Wrapper repair is copy-only: exact backend tool-pack/cache source, project scope, no overwrite. */
const VERIFIED_WRAPPER_COPY_SCRIPT =
  'PROJ=$(cat "$AIB_PRIVATE_ROOT/work/proj_path" 2>/dev/null || true); ROOT="${PROJ:-$PWD}"; ' +
  'AIB_ALLOWED_ROOT="/storage/emulated/0/AIBuilderTermux"; [ -d "$AIB_ALLOWED_ROOT" ] || { echo AIB_PROJECT_ROOT_MISSING; exit 1; }; ' +
  '[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || { echo AIB_PROJECT_ROOT_INVALID; exit 1; }; ' +
  'ROOT_CANON=$(CDPATH= cd -- "$ROOT" && pwd -P) || { echo AIB_PROJECT_ROOT_UNAVAILABLE; exit 1; }; ' +
  'ALLOWED_CANON=$(CDPATH= cd -- "$AIB_ALLOWED_ROOT" && pwd -P) || { echo AIB_PROJECT_ROOT_MISSING; exit 1; }; ' +
  'case "$ROOT_CANON" in "$ALLOWED_CANON"/*) ;; *) echo PROJECT_OUTSIDE_ALLOWED_ROOT; exit 1;; esac; cd -- "$ROOT_CANON" || exit 1; ' +
  '[ -f gradlew ] && [ ! -L gradlew ] || { echo NO_VERIFIED_PROJECT_GRADLE_LAUNCHER; exit 1; }; ' +
  '[ ! -L gradle ] && [ ! -L gradle/wrapper ] || { echo GRADLE_WRAPPER_SYMLINK_DENIED; exit 1; }; ' +
  '[ ! -L gradle/wrapper/gradle-wrapper.jar ] || { echo GRADLE_WRAPPER_TARGET_SYMLINK_DENIED; exit 1; }; ' +
  '[ -f gradle/wrapper/gradle-wrapper.properties ] && [ ! -L gradle/wrapper/gradle-wrapper.properties ] || { echo GRADLE_WRAPPER_PROPERTIES_MISSING_OR_UNTRUSTED; exit 1; }; ' +
  '[ -s gradle/wrapper/gradle-wrapper.jar ] && { echo WRAPPER_JAR_ALREADY_PRESENT; exit 0; }; ' +
  'WJAR=""; for c in "$AIB_TOOLPACK_WRAPPER_JAR" "$AIB_PRIVATE_ROOT/cache/gradle-wrapper.jar"; do ' +
  '[ -n "$c" ] && [ -s "$c" ] && [ ! -L "$c" ] && WJAR="$c" && break; done; ' +
  '[ -n "$WJAR" ] || { echo NO_VERIFIED_GRADLE_WRAPPER: verified APK build tool-pack/cache unavailable; exit 1; }; ' +
  'mkdir -p gradle/wrapper || exit 1; cp -n -- "$WJAR" gradle/wrapper/gradle-wrapper.jar || exit 1; ' +
  '[ -s gradle/wrapper/gradle-wrapper.jar ] && echo "wrapper_restored=$WJAR" && echo REPAIR_OK:gradle-wrapper';

/** Prefer multi-line allowlisted scripts over one-liner hints */
const SCRIPT_BY_RECIPE: Record<string, string> = {
  "java-install": "set -e; if java -version 2>&1 | head -1 | grep -Eq 'version .(1[7-9]|[2-9][0-9])'; then echo JAVA_17_PLUS_ALREADY_AVAILABLE; command -v java && java -version 2>&1 | head -1 && echo REPAIR_OK:java; else echo EMBEDDED_SIGNED_FEED_REQUIRED: Java installation is unavailable; no external or stock feed used; exit 1; fi",
  "android-tools": "command -v adb >/dev/null 2>&1 && adb version && echo REPAIR_OK:android-tools-existing-only || { echo EMBEDDED_SIGNED_FEED_REQUIRED: ADB installation is unavailable; no external or stock feed used; exit 1; }",
  "nodejs": "command -v node >/dev/null 2>&1 && node -v && echo REPAIR_OK:nodejs-existing-only || { echo EMBEDDED_SIGNED_FEED_REQUIRED: Node.js installation is unavailable; no external or stock feed used; exit 1; }",
  "unzip": "command -v unzip >/dev/null 2>&1 && echo REPAIR_OK:unzip-existing-only || { echo EMBEDDED_SIGNED_FEED_REQUIRED: unzip installation is unavailable; no external or stock feed used; exit 1; }",
  "proot-distro-pkg": "command -v proot-distro >/dev/null 2>&1 && echo REPAIR_OK:proot-distro-existing-only || { echo EMBEDDED_SIGNED_FEED_REQUIRED: proot-distro installation is unavailable; no external or stock feed used; exit 1; }",
  "git": "command -v git >/dev/null 2>&1 && git --version && echo REPAIR_OK:git-existing-only || { echo EMBEDDED_SIGNED_FEED_REQUIRED: Git installation is unavailable; no external or stock feed used; exit 1; }",
  "wget-curl": "command -v wget >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && echo REPAIR_OK:wget-curl-existing-only || { echo EMBEDDED_SIGNED_FEED_REQUIRED: wget/curl installation is unavailable; no external or stock feed used; exit 1; }",
  "gradle-pkg": VERIFIED_WRAPPER_COPY_SCRIPT,
  "home-layout": "mkdir -p \"$AIB_PRIVATE_ROOT\" /storage/emulated/0/AIBuilderTermux/projects && echo REPAIR_OK:home-layout",
  "gradle-cache": "GH=\"${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}\"; rm -rf \"$GH/caches\" \"$GH/daemon\" 2>/dev/null; mkdir -p \"$GH\"; echo REPAIR_OK:gradle-cache cleared=$GH",
  "build-lock": "LOCKDIR=\"${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}/.aib-build.lockdir\"; if [ -d \"$LOCKDIR\" ]; then LA=$(( $(date +%s) - $(stat -c %Y \"$LOCKDIR\" 2>/dev/null || echo 0) )); GA=0; pgrep -f \"[Gg]radle|GradleDaemon\" >/dev/null 2>&1 && GA=1; echo lock_age=$LA gradle_alive=$GA; if [ \"$LA\" -gt 300 ] || [ \"$GA\" -eq 0 ]; then rm -rf \"$LOCKDIR\" && echo REPAIR_OK:build-lock cleared; else echo BUILD_LOCK_HELD age=$LA; fi; else echo REPAIR_OK:build-lock none; fi",
  "disk-cache": (
    'echo DISK_BEFORE; df -h "$HOME" /storage/emulated/0 2>/dev/null | head -5; ' +
    'GH="${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"; ' +
    'rm -rf "$GH/caches/transforms-"* "$GH/caches/build-cache-"* "$GH/daemon" 2>/dev/null; ' +
    'rm -rf "$AIB_PRIVATE_ROOT/expo-src" "$AIB_PRIVATE_ROOT/cache/deps" 2>/dev/null; ' +
    'rm -rf "$AIB_PRIVATE_ROOT"/tmp/* 2>/dev/null; ' +
    'echo DISK_AFTER; df -h "$HOME" /storage/emulated/0 2>/dev/null | head -5; echo REPAIR_OK:disk-cache'
  ),
  "expo-deps": (
    'echo EMBEDDED_SIGNED_FEED_REQUIRED: Expo dependency installation is unavailable until a compatible signed embedded-private feed is configured; no external or stock feeds used; exit 1'
  ),
  "expo-cli": (
    'set -Eeuo pipefail; command -v node || { echo EMBEDDED_SIGNED_FEED_REQUIRED: Node.js installation is unavailable; no external or stock feed used; exit 1; }; ' +
    'PROJ=$(cat $AIB_PRIVATE_ROOT/work/proj_path 2>/dev/null || true); ' +
    'ROOT="$PROJ"; [ -f "$ROOT/package.json" ] || ROOT=$(dirname "$PROJ" 2>/dev/null || true); ' +
    'if [ -z "$ROOT" ] || [ ! -f "$ROOT/package.json" ]; then echo NO_PACKAGE_JSON; exit 1; fi; cd "$ROOT"; ' +
    'if [ ! -d "$ROOT/node_modules/expo" ]; then echo EXPO_MODULE_MISSING; echo RUN_EXPO_DEPS_REPAIR_FIRST; exit 1; fi; ' +
    'if [ -d android ] && { [ -f android/gradlew ] && { [ -f android/settings.gradle ] || [ -f android/settings.gradle.kts ]; }; }; then echo EXPO_ANDROID_ALREADY_COMPLETE; echo REPAIR_OK:expo-cli; exit 0; fi; ' +
    'HAD_ANDROID=0; BACKUP_DIR=""; if [ -d android ]; then HAD_ANDROID=1; BACKUP_DIR=$(mktemp -d "$ROOT/.aib-expo-rollback.XXXXXX"); fi; ' +
    'rollback_expo(){ status=$?; trap - EXIT; if [ "$status" -ne 0 ]; then rm -rf "$ROOT/android"; if [ "$HAD_ANDROID" -eq 1 ] && [ -d "$BACKUP_DIR/android" ]; then mv "$BACKUP_DIR/android" "$ROOT/android" || echo EXPO_ANDROID_ROLLBACK_FAILED; fi; fi; [ -z "$BACKUP_DIR" ] || rm -rf "$BACKUP_DIR"; exit "$status"; }; trap rollback_expo EXIT; ' +
    'if [ "$HAD_ANDROID" -eq 1 ]; then mv android "$BACKUP_DIR/android" || { echo EXPO_ANDROID_BACKUP_FAILED; exit 1; }; fi; ' +
    'node "$ROOT/node_modules/expo/bin/cli" prebuild --platform android --no-install 2>&1 | tail -60 || { echo EXPO_PREBUILD_FAILED; exit 1; }; ' +
    '[ -f android/settings.gradle ] || [ -f android/settings.gradle.kts ] || { echo EXPO_PREBUILD_OUTPUT_INVALID; exit 1; }; ' +
    'trap - EXIT; [ -z "$BACKUP_DIR" ] || rm -rf "$BACKUP_DIR"; echo REPAIR_OK:expo-cli'
  ),
  "signing-tools": (
    'set -e; JH=""; for d in "$PREFIX/lib/jvm/java-17-openjdk" "$PREFIX/lib/jvm/java-21-openjdk" "$JAVA_HOME"; do ' +
    '[ -x "$d/bin/keytool" ] && JH="$d" && break; done; [ -n "$JH" ] && export PATH="$JH/bin:$PATH"; ' +
    'SDK="${ANDROID_HOME:-$PREFIX/opt/android-sdk}"; BT=$(ls -d "$SDK/build-tools"/*/ 2>/dev/null | tail -1); ' +
    'echo keytool=$(command -v keytool) bt=$BT; KEYS="$AIB_PRIVATE_ROOT/keys"; mkdir -p "$KEYS"; chmod 700 "$AIB_PRIVATE_ROOT" "$KEYS"; KS="$KEYS/aib-debug.keystore"; ' +
    'if [ ! -s "$KS" ] && command -v keytool >/dev/null; then keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=AIBuilder,O=Termux,C=US" 2>&1 | tail -3; fi; ' +
    '[ -s "$KS" ] || { echo SIGNING_KEYSTORE_MISSING; exit 1; }; [ -x "${BT}apksigner" ] || { echo APKSIGNER_MISSING; exit 1; }; ' +
    '[ -x "${BT}zipalign" ] || { echo ZIPALIGN_MISSING; exit 1; }; echo REPAIR_OK:signing-tools'
  ),
  
  "maven-deps": (
    'set -e; PROJ=$(cat $AIB_PRIVATE_ROOT/work/proj_path 2>/dev/null); ' +
    'test -n "$PROJ" -a -d "$PROJ" || { echo NO_PROJ; exit 1; }; ' +
    'MROOT="$PROJ"; [ -f "$PROJ/pom.xml" ] || { [ -f "$PROJ/../pom.xml" ] && MROOT="$(cd "$PROJ/.." && pwd)"; }; ' +
    '[ -f "$MROOT/pom.xml" ] || { echo NO_POM; exit 1; }; cd "$MROOT"; echo MROOT=$MROOT; ' +
    'command -v mvn >/dev/null 2>&1 || { echo NO_MAVEN; exit 1; }; ' +
    'mvn -B -DskipTests dependency:resolve 2>&1 | tail -40; test ${PIPESTATUS[0]} -eq 0 || { echo MAVEN_DEPS_FAIL; exit 1; }; ' +
    'echo REPAIR_OK:maven-deps' 
  ),
  "flutter-pub": (
    'set -e; PROJ=$(cat $AIB_PRIVATE_ROOT/work/proj_path 2>/dev/null); ' +
    'FROOT="$PROJ"; [ -f "$PROJ/../pubspec.yaml" ] && FROOT="$(cd "$PROJ/.." && pwd)"; ' +
    '[ -f "$FROOT/pubspec.yaml" ] || { echo NO_PUBSPEC; exit 1; }; cd "$FROOT"; ' +
    'command -v flutter >/dev/null 2>&1 || { echo NO_FLUTTER; exit 1; }; ' +
    'flutter pub get 2>&1 | tail -40; test ${PIPESTATUS[0]} -eq 0 || { echo FLUTTER_PUB_FAIL; exit 1; }; ' +
    '{ [ -d .dart_tool ] || [ -f .packages ] || [ -f pubspec.lock ]; } && echo REPAIR_OK:flutter-pub || { echo FLUTTER_PUB_FAIL; exit 1; }'
  ),
  "ndk-path": "NDK=\"\"; for d in \"$PREFIX/opt/android-ndk\" \"${ANDROID_NDK_HOME:-}\" \"$PREFIX/opt/android-sdk/ndk-bundle\"; do [ -n \"$d\" ] && { [ -f \"$d/ndk-build\" ] || [ -f \"$d/build/ndk-build\" ] || [ -d \"$d\" ]; } && NDK=\"$d\" && break; done; if [ -z \"$NDK\" ]; then echo NDK_MISSING; exit 1; fi; export ANDROID_NDK_HOME=\"$NDK\" ANDROID_NDK_ROOT=\"$NDK\"; PROJ=$(cat $AIB_PRIVATE_ROOT/work/proj_path 2>/dev/null); if [ -n \"$PROJ\" ] && [ -d \"$PROJ\" ]; then if [ -f \"$PROJ/local.properties\" ]; then grep -q '^ndk.dir=' \"$PROJ/local.properties\" 2>/dev/null || echo \"ndk.dir=$NDK\" >> \"$PROJ/local.properties\"; else echo \"sdk.dir=${ANDROID_HOME:-$PREFIX/opt/android-sdk}\" > \"$PROJ/local.properties\"; echo \"ndk.dir=$NDK\" >> \"$PROJ/local.properties\"; fi; CMAKE=\"\"; for cd in \"$NDK/cmake\" \"${ANDROID_HOME:-$PREFIX/opt/android-sdk}/cmake\"; do [ -d \"$cd\" ] && CMAKE=$(ls -d \"$cd\"/*/ 2>/dev/null | tail -1) && break; done; [ -n \"$CMAKE\" ] && [ -n \"$PROJ\" ] && grep -q '^cmake.dir=' \"$PROJ/local.properties\" 2>/dev/null || { [ -n \"$CMAKE\" ] && [ -n \"$PROJ\" ] && echo \"cmake.dir=${CMAKE%/}\" >> \"$PROJ/local.properties\"; }; echo REPAIR_OK:ndk path=$NDK cmake=${CMAKE:-none} proj=$PROJ; else echo REPAIR_OK:ndk path=$NDK no_proj; fi",
  "aapt2-sdk": 'set -e; AAPT2=$(command -v aapt2 2>/dev/null || true); ' +
    '[ -z "$AAPT2" ] && AAPT2=$(find "${ANDROID_HOME:-$PREFIX/opt/android-sdk}/build-tools" -name aapt2 -type f 2>/dev/null | sort | tail -1); ' +
    'if [ -z "$AAPT2" ]; then echo AAPT2_MISSING_VERIFIED_SDK_ONLY; exit 1; fi; ' +
    'chmod +x "$AAPT2" 2>/dev/null || true; "$AAPT2" version >/dev/null 2>&1 || { echo AAPT2_BROKEN; exit 1; }; echo REPAIR_OK:aapt2-existing-only',
  "adb-server": "adb kill-server 2>/dev/null; adb start-server && echo REPAIR_OK:adb-server",
  "local-properties": (
    'SDK=""; for d in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$PREFIX/opt/android-sdk" "$PREFIX/share/android-sdk"; do ' +
    '[ -n "$d" ] && [ -d "$d/platforms" ] && SDK="$d" && break; done; ' +
    'SDK="${SDK:-$PREFIX/opt/android-sdk}"; ' +
    'PROJ=$(cat $AIB_PRIVATE_ROOT/work/proj_path 2>/dev/null); ' +
    'for R in "$PROJ" /storage/emulated/0/AIBuilderTermux/* "$PWD"; do ' +
    '[ -n "$R" ] && [ -d "$R" ] && { [ -f "$R/settings.gradle" ] || [ -f "$R/settings.gradle.kts" ] || [ -f "$R/build.gradle" ] || [ -f "$R/build.gradle.kts" ]; } && ' +
    'echo "sdk.dir=$SDK" > "$R/local.properties" && echo "REPAIR_OK:local-properties path=$R sdk=$SDK" && exit 0; done; ' +
    'echo "sdk.dir=$SDK" > local.properties; echo "REPAIR_OK:local-properties cwd sdk=$SDK"'
  ),
  "gradle-wrapper": VERIFIED_WRAPPER_COPY_SCRIPT,
};

/** Health rule id → DeterministicRepair recipe id */
const DIAG_TO_RECIPE: Record<string, string> = {
  "toolchain.java": "java-install",
  "toolchain.gradle": "gradle-pkg",
  "toolchain.node": "nodejs",
  "toolchain.android-sdk": "android-tools",
  "device.adb": "android-tools",
  "runtime.proot": "proot-distro-pkg",
  "runtime.termux-session": "journal-recovery",
  "runtime.userspace": "proot-distro-pkg",
  "runtime.disk": "disk-cleanup",
  "toolchain.git": "git",
  "toolchain.unzip": "unzip",
  "runtime.debian": "proot-distro-pkg",
  "runtime.home-layout": "home-layout",
  "toolchain.ndk": "ndk-path",
  "toolchain.aapt2": "aapt2-sdk",
  "toolchain.expo": "expo-deps",
  "toolchain.flutter": "flutter-pub",
  "toolchain.maven": "maven-deps",
  "build.wrapper": "gradle-wrapper",
  "build.cache": "gradle-cache",
  "build.lock": "build-lock",
};

/** Recipes safe to auto-run from Health "Repair all" without extra confirm. */
const AUTO_ALLOW = new Set([
  "journal-recovery",
  "local-properties",
  "gradle-wrapper",
  "android-tools",
  "nodejs",
  "proot-distro-pkg",
  "unzip",
  "git",
  "wget-curl",
  "java-install",
  "home-layout",
  "build-lock",
  "disk-cache",
  "ndk-path",
  "aapt2-sdk",
  "adb-server",
  "expo-deps",
  "expo-cli",
  "maven-deps",
  "flutter-pub",
  "signing-tools",
]);

export function listRepairRecipes(): RepairRecipe[] {
  return repair.list();
}

export function getRepairRecipe(id: string): RepairRecipe | undefined {
  return repair.get(id);
}

/**
 * Run a single recipe. Internal handlers first, then allowlisted shell hint.
 */
export async function runRepairRecipe(
  id: string,
  options?: { allowMedium?: boolean; force?: boolean },
): Promise<RepairRunResult> {
  persistentLogger.add("info", "Repair", `recipe=${id}`);
  const recipe = repair.get(id);
  if (!recipe) {
    return { ok: false, recipeId: id, message: `Unknown recipe: ${id}` };
  }

  if (recipe.risk === "high" && !options?.force) {
    return {
      ok: false,
      recipeId: id,
      message: `Recipe ${id} is high-risk; pass force:true after user confirm`,
    };
  }
  if (recipe.risk === "medium" && !options?.allowMedium && !options?.force && !AUTO_ALLOW.has(id)) {
    return {
      ok: false,
      recipeId: id,
      message: `Recipe ${id} is medium-risk; enable allowMedium or force`,
    };
  }

  // In-process handlers
  if (recipe.termuxHint.startsWith("AIB_INTERNAL:")) {
    const internal = recipe.termuxHint.slice("AIB_INTERNAL:".length).trim();
    if (internal === "journal-recover") {
      try {
        const r = await getRuntimeFacade().recoverPendingTransactions();
        return {
          ok: true,
          recipeId: id,
          message: `Journal recovery: recovered=${r.recovered} failed=${r.failed}`,
        };
      } catch (e) {
        return {
          ok: false,
          recipeId: id,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }
    return { ok: false, recipeId: id, message: `Unknown internal handler: ${internal}` };
  }

  // Shell allowlist: only the exact termuxHint string from the recipe catalog
  const script = SCRIPT_BY_RECIPE[id];
  const backend = getBuildBackend();
  const wrapperToolpackPath = backend === "termux"
    ? '"${PREFIX:-/data/data/com.karat.aibuilder/files/usr}/opt/aibuilder-toolpack/gradle/wrapper/gradle-wrapper.jar"'
    : "'/opt/aibuilder-toolpack/gradle/wrapper/gradle-wrapper.jar'";
  const selectedScript = (id === "gradle-wrapper" || id === "gradle-pkg") && script
    ? `AIB_TOOLPACK_WRAPPER_JAR=${wrapperToolpackPath}; ${script}`
    : script;
  if (backend !== "termux" && id === "gradle-pkg") {
    return {
      ok: false,
      recipeId: id,
      message: `BACKEND_REPAIR_UNAVAILABLE: ${backend} must use the project's verified Gradle wrapper; distro Gradle is not substituted`,
    };
  }
  if (backend !== "termux" && ["local-properties", "aapt2-sdk", "ndk-path"].includes(id)) {
    return {
      ok: false,
      recipeId: id,
      message: `BACKEND_REPAIR_UNAVAILABLE: ${id} uses Termux-specific SDK/NDK paths; preserve project files and inspect the selected ${backend} toolchain`,
    };
  }
  // Java is checked on every backend, but installation requires a compatible signed
  // embedded-private feed; never fall back to apt, pkg, or a stock/external feed.
  const backendJavaScript = selectedScript;
  const cmd = id === "java-install" ? (backendJavaScript || recipe.termuxHint) : (selectedScript || recipe.termuxHint);
  // Expo dependency resolution mutates node_modules and can fetch arbitrary packages.
  // Until an embedded-private signed provider is available, fail before execution.
  if (id === "expo-deps") {
    return {
      ok: false,
      recipeId: id,
      message: "EMBEDDED_SIGNED_FEED_REQUIRED: Expo dependency installation is unavailable until a compatible signed embedded-private feed is configured; no external or stock feeds used",
      stderr: "EMBEDDED_SIGNED_FEED_REQUIRED",
      exitCode: 1,
    };
  }
  if (!cmd || (!script && (cmd.includes("\n") || cmd.length > 500))) {
    return { ok: false, recipeId: id, message: "Recipe shell hint rejected by allowlist" };
  }

  try {
    const result = await executeGuardedTermuxCommand(`${PRIVATE_BUILD_PATHS_INIT_SH}; ${cmd}`, { timeoutMs: 300_000, isBuild: true, trustedInternal: true, hostTermux: id === "proot-distro-pkg" });
    const exitCode = result.exitCode ?? 1;
    return {
      ok: exitCode === 0,
      recipeId: id,
      message: exitCode === 0 ? `Recipe ${id} OK` : `Recipe ${id} exit=${exitCode}`,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
    };
  } catch (e) {
    return {
      ok: false,
      recipeId: id,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Map diagnostic rule id → run matching recipe if any. */
export async function runRepairForDiagnostic(
  diagnosticId: string,
  options?: { allowMedium?: boolean },
): Promise<RepairRunResult> {
  persistentLogger.add("info", "Repair", `start id=${diagnosticId}`);
  const recipe = repair.forDiagnostic(diagnosticId);
  if (!recipe) {
    return { ok: false, recipeId: diagnosticId, message: `No recipe for diagnostic ${diagnosticId}` };
  }
  return runRepairRecipe(recipe.id, options);
}
