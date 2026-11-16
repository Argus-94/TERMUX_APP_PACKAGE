/**
 * Built-in Script Runner templates (priority #5).
 */

export type ScriptTemplateIcon =
  | "rocket-outline"
  | "bug-outline"
  | "construct-outline"
  | "code-slash-outline";

export interface ScriptTemplate {
  id: string;
  nameRu: string;
  nameUk: string;
  nameEn: string;
  icon: ScriptTemplateIcon;
  body: string;
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: "tpl-expo-build",
    nameRu: "Сборка Expo",
    nameUk: "Збірка Expo",
    nameEn: "Expo build",
    icon: "rocket-outline",
    body: `#!/usr/bin/env bash
set -e
# Template: Expo/Gradle debug APK — uses PROJECT config as-is (no version rewrites)
AIB_ROOT="/storage/emulated/0/AIBuilderTermux"
AIB_PRIVATE_ROOT="\${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}"
ZIP="\${AIB_ZIP_PATH:-}"
[ -n "$ZIP" ] && [ -f "$ZIP" ] || { echo "Set AIB_ZIP_PATH to project ZIP"; exit 10; }
export GRADLE_USER_HOME="\${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"
mkdir -p "$GRADLE_USER_HOME" "$AIB_PRIVATE_ROOT/work" "$AIB_PRIVATE_ROOT/tmp" "$AIB_PRIVATE_ROOT/keys"
chmod 700 "$AIB_PRIVATE_ROOT" "$AIB_PRIVATE_ROOT/keys"
echo "=== Expo/Gradle build template ==="
echo "ZIP=$ZIP"
BUILD_ID="$(date +%Y%m%d-%H%M%S)-$$"
WORK="$AIB_ROOT/projects/tpl-expo-$BUILD_ID"
mkdir -p "$AIB_ROOT/projects"
mkdir "$WORK" || { echo "PROJECT_PATH_COLLISION; existing files were preserved" >&2; exit 11; }
unzip -q -o "$ZIP" -d "$WORK/src"
cd "$WORK/src"
if [ -f package.json ] && grep -q '"expo"' package.json 2>/dev/null && [ ! -d android ]; then
  if [ -f pnpm-lock.yaml ]; then
    command -v pnpm >/dev/null 2>&1 || { echo "pnpm 9.15.0 required" >&2; exit 24; }
    [ "$(pnpm --version 2>/dev/null)" = "9.15.0" ] || { echo "pnpm 9.15.0 required" >&2; exit 24; }
    pnpm install --frozen-lockfile --ignore-scripts
  elif [ -f package-lock.json ]; then
    npm ci --legacy-peer-deps --no-bin-links
  else
    npm install --legacy-peer-deps --no-bin-links
  fi
  if [ -f pnpm-lock.yaml ]; then
    pnpm exec expo prebuild --platform android --clean --non-interactive
  else
    npx --no-install expo prebuild --platform android --clean --non-interactive
  fi
fi
if [ -f android/gradlew ]; then cd android; elif [ -f gradlew ]; then :; else echo "gradlew missing"; exit 22; fi
chmod +x gradlew
./gradlew assembleDebug --stacktrace $AIB_GRADLE_EXTRA_FLAGS 2>&1 | tee "$AIB_PRIVATE_ROOT/work/last-build.log"
APK=$(find . -path '*/outputs/apk/*.apk' 2>/dev/null | head -1)
[ -n "$APK" ] || { echo "APK not found"; exit 30; }
SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-}}"
[ -n "$SDK" ] || { echo "ANDROID_SDK_UNAVAILABLE: private runtime SDK bootstrap is not qualified" >&2; exit 31; }
BT=$(ls -d "$SDK/build-tools"/*/ 2>/dev/null | tail -1)
ZIPALIGN="\${BT%/}/zipalign"; APKSIGNER="\${BT%/}/apksigner"
[ -x "$ZIPALIGN" ] || ZIPALIGN=$(command -v zipalign 2>/dev/null || true)
[ -x "$APKSIGNER" ] || APKSIGNER=$(command -v apksigner 2>/dev/null || true)
[ -n "$ZIPALIGN" ] && [ -n "$APKSIGNER" ] || { echo "SIGNING_TOOLS_MISSING" >&2; exit 31; }
KEYS="$AIB_PRIVATE_ROOT/keys"; KS="$KEYS/aib-debug.keystore"
if [ ! -s "$KS" ] && [ -s "$AIB_ROOT/.aibuilder/keys/aib-debug.keystore" ]; then
  KEY_STAGE="$KEYS/.aib-debug.migrate.$$"
  if cp -p -- "$AIB_ROOT/.aibuilder/keys/aib-debug.keystore" "$KEY_STAGE" && chmod 600 "$KEY_STAGE" && cmp -s -- "$AIB_ROOT/.aibuilder/keys/aib-debug.keystore" "$KEY_STAGE"; then
    ln "$KEY_STAGE" "$KS" 2>/dev/null || true
  fi
  rm -f -- "$KEY_STAGE"
fi
if [ ! -s "$KS" ]; then
  KEY_STAGE="$KEYS/.aib-debug.create.$$"
  keytool -genkeypair -v -keystore "$KEY_STAGE" -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=AIBuilder,O=Termux,C=US" >/dev/null 2>&1 || { rm -f -- "$KEY_STAGE"; echo "KEYSTORE_GENERATION_FAILED" >&2; exit 32; }
  chmod 600 "$KEY_STAGE"; ln "$KEY_STAGE" "$KS" 2>/dev/null || true; rm -f -- "$KEY_STAGE"
fi
[ -s "$KS" ] || { echo "KEYSTORE_UNAVAILABLE" >&2; exit 32; }
BASE=$(basename "$APK" .apk); mkdir -p "$WORK/artifacts"; ALIGNED="$AIB_PRIVATE_ROOT/tmp/\${BUILD_ID}-\${BASE}-aligned.apk"; SIGNED="$WORK/artifacts/\${BASE}-signed.apk"
"$ZIPALIGN" -f -p 4 "$APK" "$ALIGNED" || { echo "ZIPALIGN_FAIL" >&2; exit 33; }
"$APKSIGNER" sign --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --ks "$KS" --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out "$SIGNED" "$ALIGNED" || { echo "APKSIGNER_FAIL" >&2; exit 34; }
VERIFY=$("$APKSIGNER" verify --verbose "$SIGNED" 2>&1) || { echo "$VERIFY"; echo "APK_VERIFY_FAIL" >&2; exit 35; }
printf '%s\n' "$VERIFY" | grep -Eiq 'v1.*true|Verified using v1 scheme.*true' || { echo "V1_VERIFY_FAIL" >&2; exit 35; }
printf '%s\n' "$VERIFY" | grep -Eiq 'v2.*true|Verified using v2 scheme.*true' || { echo "V2_VERIFY_FAIL" >&2; exit 35; }
printf '%s\n' "$VERIFY" | grep -Eiq 'v3.*true|Verified using v3 scheme.*true' || { echo "V3_VERIFY_FAIL" >&2; exit 35; }
echo "SIGNED_V1_V2_V3_OK=$SIGNED"
ls -lh "$SIGNED"
rm -f -- "$ALIGNED"
command -v aapt >/dev/null && aapt dump badging "$SIGNED" 2>/dev/null | head -15 || true
echo BUILD_OK
`,
  },
  {
    id: "tpl-apk-analyze",
    nameRu: "Анализ APK",
    nameUk: "Аналіз APK",
    nameEn: "Analyze APK",
    icon: "bug-outline",
    body: `#!/usr/bin/env bash
set -e
APK="\${1:-}"
[ -z "$APK" ] && APK=$(find /storage/emulated/0/AIBuilderTermux -name '*.apk' -type f 2>/dev/null | head -1)
[ -n "$APK" ] && [ -f "$APK" ] || { echo "APK not found"; exit 10; }
OUT="/storage/emulated/0/AIBuilderTermux/analysis/reverse-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
echo "APK=$APK"
ls -lh "$APK" | tee "$OUT/ls.txt"
command -v aapt >/dev/null && aapt dump badging "$APK" 2>/dev/null | head -40 | tee "$OUT/aapt.txt" || true
unzip -l "$APK" 2>/dev/null | head -60 | tee "$OUT/zip.txt" || true
if command -v jadx >/dev/null 2>&1; then
  jadx -d "$OUT/jadx" --show-bad-code -q "$APK" 2>&1 | tail -20 | tee "$OUT/jadx.log" || true
else
  echo "jadx missing — pkg install jadx"
fi
echo "OUT=$OUT"
echo REVERSE_OK
`,
  },
  {
    id: "tpl-pkg-install",
    nameRu: "Установка пакетов",
    nameUk: "Встановлення пакетів",
    nameEn: "Install packages",
    icon: "construct-outline",
    body: `#!/usr/bin/env bash
set -e
echo "=== pkg update + base tools ==="
apt-get update -y 2>&1 | tail -8 || true
apt-get install -y openjdk-17 git wget curl unzip 2>&1 | tail -15 || true
command -v java >/dev/null && java -version 2>&1 | head -1 || echo "java missing"
echo INSTALL_OK
`,
  },
];

export interface RunHistoryEntry {
  id: string;
  scriptName: string;
  exitCode: number;
  ok: boolean;
  at: number;
  tail: string;
  apkPath?: string;
}

export const STORAGE_RUN_HISTORY = "aibuilder.script_runner.run_history.v1";
export const MAX_RUN_HISTORY = 20;

const APK_WORKSPACE_ROOT = "/storage/emulated/0/AIBuilderTermux";
/** Validate candidate (not proof of existence or provenance) APK paths lexically. */
export function isValidApkCandidatePath(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.includes("\0") || /[\r\n]/.test(candidate)) return false;
  const parts = candidate.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) return false;
  const normalized = `/${parts.filter((part) => part !== ".").join("/")}`;
  return normalized.startsWith(`${APK_WORKSPACE_ROOT}/`) && /\.apk$/i.test(normalized);
}
export function sanitizeRunHistory(value: unknown): RunHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return (value as RunHistoryEntry[]).slice(0, MAX_RUN_HISTORY).map((entry) => ({
    ...entry,
    apkPath: entry?.ok && isValidApkCandidatePath(entry.apkPath) ? entry.apkPath : undefined,
  }));
}
export function extractApkPathFromLog(log: string): string | undefined {
  const text = log || "";
  const patterns = [
    /APK_PATH=(\/[^\s]+)/,
    /\bAPK=(\/[^\s]+\.apk)/i,
    /APK:\s*(\/[^\s]+\.apk)/i,
    /Готовый APK:\s*(\/[^\s]+)/i,
    /signed\.apk[^\n]*?(\/[^\s]+\.apk)/i,
    /(\/storage\/emulated\/0\/[^\s]+\.apk)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1] && isValidApkCandidatePath(m[1])) return m[1];
  }
  const any = /(\/[^\s\'"]+\.apk)\b/i.exec(text);
  return any?.[1] && isValidApkCandidatePath(any[1]) ? any[1] : undefined;
}
export function tailLog(log: string, maxLines = 40): string {
  const lines = (log || "").split("\n");
  return lines.slice(-maxLines).join("\n");
}
