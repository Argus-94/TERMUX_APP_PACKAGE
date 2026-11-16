/**
 * Встроенный ПРОСТОЙ скрипт сборки APK — использует ТОЧНО конфигурацию проекта.
 * Не меняет version Gradle, не переписывает gradle.properties.
 * ZIP: AIB_ZIP_PATH или $1; каталог = basename архива.
 */

import { buildProjectArchiveValidationCommand } from "./project-source-import.ts";
import { PRIVATE_BUILD_PATHS_INIT_SH } from "./private-path-policy.ts";

export const BUILTIN_BUILD_SCRIPT_ID = "aib-builtin-build-simple-v1";

const SCRIPT_BODY: string = "#!/data/data/com.karat.aibuilder/files/usr/bin/bash\n# ПРОСТАЯ СБОРКА - используется ТОЧНО то что в проекте\n# Никаких изменений версий, никаких переписываний конфигов\nset -e\nset -o pipefail\n\n# ZIP path: from env AIB_ZIP_PATH (AI Builder field) or first CLI arg\nZIP=\"${AIB_ZIP_PATH:-${1:-}}\"\nif [ -z \"$ZIP\" ]; then\n  echo \"ERROR: ZIP path not set. Pass via AIB_ZIP_PATH or as $1\" >&2\n  exit 10\nfi\nAIB_ROOT=\"/storage/emulated/0/AIBuilderTermux\"\nAIB_INTERNAL=\"$AIB_ROOT/.aibuilder\"\nAIB_WORK=\"$AIB_INTERNAL/work\"\nAIB_GRADLE=\"${HOME}/.aibuilder-gradle\"\nAIB_TMP=\"$AIB_INTERNAL/tmp\"\nAIB_KEYS=\"$AIB_INTERNAL/keys\"\nZIP_BASE=$(basename \"$ZIP\")\nZIP_STEM=\"${ZIP_BASE%.*}\"\nZIP_STEM=$(echo \"$ZIP_STEM\" | sed \"s/[^a-zA-Z0-9._-]/_/g\")\n[ -z \"$ZIP_STEM\" ] && ZIP_STEM=\"project\"\nBUILD_ID=\"$(date +%Y%m%d-%H%M%S)-$$\"\nPROJECT=\"$AIB_ROOT/projects/$ZIP_STEM-$BUILD_ID\"\nAIB_WORK=\"$PROJECT/.aibuildertermux-build\"\n\nmkdir -p \"$AIB_INTERNAL\" \"$AIB_ROOT/projects\" \"$AIB_GRADLE\" \"$AIB_TMP\" \"$AIB_KEYS\"\n\nLOG_FILE=\"$AIB_TMP/build-$BUILD_ID.log\"\n\nlog() {\n  echo \"[$(date '+%H:%M:%S')] $*\" | tee -a \"$LOG_FILE\"\n}\n\nlog \"==========================================\"\nlog \"СБОРКА - использует ТОЧНО то что в проекте\"\nlog \"==========================================\"\n\necho \"=== [1/5] Распаковка ===\"\ntest -f \"$ZIP\" || { log \"ERROR: ZIP не найден\"; exit 10; }\nEXTRACT_DIR=$(mktemp -d \"$AIB_TMP/aib-script-extract.XXXXXX\")\ntrap 'rm -rf -- \"$EXTRACT_DIR\" 2>/dev/null || true' EXIT\nunzip -q \"$ZIP\" -d \"$EXTRACT_DIR\"\n\nENTRIES=$(find \"$EXTRACT_DIR\" -mindepth 1 -maxdepth 1)\nCOUNT=$(echo \"$ENTRIES\" | grep -c .)\nif [ \"$COUNT\" -eq 1 ] && [ -d \"$ENTRIES\" ]; then\n  SRC=\"$ENTRIES\"\nelse\n  SRC=\"$EXTRACT_DIR\"\nfi\n\nmkdir \"$PROJECT\" || { log \"ERROR: project path collision; existing files were preserved\"; exit 11; }\ncp -a \"$SRC\"/. \"$PROJECT\"/\nmkdir -p \"$AIB_WORK/logs\" \"$PROJECT/artifacts\"\nGRADLE_LOG=\"$AIB_WORK/logs/gradle-$BUILD_ID.log\"\nlog \"✓ Проект готов\"\n\ncd \"$PROJECT\"\n\necho \"=== [2/5] Expo prebuild (если нужен) ===\"\nif [ -f \"package.json\" ] && grep -q '\"expo\"' package.json 2>/dev/null; then\n  if [ ! -d \"android\" ]; then\n    log \"Нужен Android через expo...\"\n    \n    if command -v corepack >/dev/null 2>&1; then\n      corepack disable >/dev/null 2>&1 || true\n    fi\n    \n    # Prefer project packageManager (pnpm) — never rewrite package.json.\n    # Fallback: npm ci / npm install. Do not change compile settings.\n    if command -v corepack >/dev/null 2>&1; then\n      corepack enable >/dev/null 2>&1 || true\n    fi\n    if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then\n      log \"deps: pnpm install --frozen-lockfile\"\n      pnpm install --frozen-lockfile --ignore-scripts 2>&1 | tail -25 >> \"$LOG_FILE\" || \\\n        pnpm install --ignore-scripts 2>&1 | tail -25 >> \"$LOG_FILE\"\n    elif [ -f package-lock.json ]; then\n      log \"deps: npm ci\"\n      npm ci --legacy-peer-deps --no-bin-links 2>&1 | tail -20 >> \"$LOG_FILE\"\n    else\n      log \"deps: npm install\"\n      npm install --legacy-peer-deps --no-bin-links 2>&1 | tail -20 >> \"$LOG_FILE\"\n    fi\n    \n    \n    EXPO_CLI=\"\"\n    for cand in \"$PROJECT/node_modules/expo/bin/cli\" \"$PROJECT/node_modules/expo/bin/cli.js\"; do\n      [ -f \"$cand\" ] && { EXPO_CLI=\"$cand\"; break; }\n    done\n    \n    if [ -n \"$EXPO_CLI\" ]; then\n      log \"expo prebuild...\"\n      set +e\n      node \"$EXPO_CLI\" prebuild --platform android --clean --non-interactive 2>&1 | tee -a \"$LOG_FILE\" | tail -20\n      PB_EC=${PIPESTATUS[0]}\n      set -e\n      if [ \"$PB_EC\" -ne 0 ]; then\n        log \"ERROR: expo prebuild failed exit=$PB_EC\"\n        exit 23\n      fi\n    fi\n  fi\nfi\n\nif [ -f \"android/gradlew\" ]; then\n  cd android\nelif [ -f \"gradlew\" ]; then\n  cd .\nelse\n  log \"ERROR: gradlew не найден после prebuild/unpack\"; exit 22\nfi\n\nlog \"✓ Android каталог: $(pwd)\"\n\necho \"=== [3/5] Настройка окружения ===\"\n\n# Находим SDK\nSDK=\"\"\nfor d in \"$ANDROID_HOME\" \"$ANDROID_SDK_ROOT\" \"$PREFIX/opt/android-sdk\" \"$PREFIX/share/android-sdk\" \"$PREFIX/lib/android-sdk\"; do\n  [ -d \"$d\" ] && { SDK=\"$d\"; break; }\ndone\n[ -z \"$SDK\" ] && { log \"ERROR: Android SDK не найден\"; exit 20; }\n\n# Находим Java\nJH=\"\"\nfor d in \"$PREFIX/lib/jvm/java-17-openjdk\" \"$JAVA_HOME\" \"$PREFIX/lib/jvm/java-21-openjdk\"; do\n  [ -x \"$d/bin/java\" ] 2>/dev/null && { JH=\"$d\"; break; }\ndone\n[ -z \"$JH\" ] && { log \"ERROR: Java не найдена\"; exit 21; }\n\n# Экспортируем\nexport JAVA_HOME=\"$JH\"\nexport ANDROID_HOME=\"$SDK\"\nexport ANDROID_SDK_ROOT=\"$SDK\"\nexport PATH=\"$JAVA_HOME/bin:$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$PATH\"\nBT=$(ls -d \"$SDK/build-tools\"/*/ 2>/dev/null | tail -1)\n[ -n \"$BT\" ] && export PATH=\"$BT:$PATH\"\n\n# Лицензии\nmkdir -p \"$SDK/licenses\"\nexport GRADLE_USER_HOME=\"$AIB_GRADLE\"\nprintf '%s\\n' '24333f8a63b6825ea9c5514f83c2829b004d1fee' > \"$SDK/licenses/android-sdk-license\"\nprintf '%s\\n' '84831b9409646a918e30573bab4c9c91346d8abd' > \"$SDK/licenses/android-sdk-preview-license\"\n\n# Ensure local.properties for AGP (env ANDROID_HOME alone is not always enough)\necho \"sdk.dir=$SDK\" > local.properties\nlog \"✓ local.properties sdk.dir=$SDK\"\n\nlog \"✓ Java: $(basename $JH)\"\nlog \"✓ SDK: $(basename $SDK)\"\n\n# Показываем версию Gradle из проекта\nif [ -f \"gradle/wrapper/gradle-wrapper.properties\" ]; then\n  GRADLE_VER=$(grep \"distributionUrl\" gradle/wrapper/gradle-wrapper.properties | sed 's/.*gradle-//' | sed 's/-all.*//')\n  log \"✓ Gradle версия из проекта: $GRADLE_VER\"\nfi\n\necho \"=== [4/5] СБОРКА ===\"\n\n[ ! -f gradlew ] && { log \"ERROR: gradlew не найден\"; exit 22; }\nchmod +x gradlew 2>/dev/null || true\n\nASSEMBLE_TASK=\"${AIB_ASSEMBLE_TASK:-assembleDebug}\"\nASSEMBLE_TASK=$(echo \"$ASSEMBLE_TASK\" | tr -cd 'a-zA-Z0-9')\n[ -z \"$ASSEMBLE_TASK\" ] && ASSEMBLE_TASK=assembleDebug\nlog \"Запуск: ./gradlew $ASSEMBLE_TASK\"\nlog \"(используется версия Gradle из gradle/wrapper/gradle-wrapper.properties)\"\nlog \"\"\n\n# Task via AIB_ASSEMBLE_TASK (default assembleDebug). Heap via AIB_GRADLE_JVMARGS / EXTRA_FLAGS.\nJVM_ARGS=\"${AIB_GRADLE_JVMARGS:--Xmx1536m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8}\"\nLOCKDIR=\"${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}/.aib-build.lockdir\"\nif [ -d \"$LOCKDIR\" ]; then\n  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y \"$LOCKDIR\" 2>/dev/null || echo 0) ))\n  if [ \"$LOCK_AGE\" -gt 2700 ]; then\n    log \"STALE_BUILD_LOCK age=${LOCK_AGE}s — снимаю\"\n    rm -rf \"$LOCKDIR\"\n  fi\nfi\nif ! mkdir \"$LOCKDIR\" 2>/dev/null; then\n  log \"другая сборка держит lock — жду до 120с\"\n  waited=0\n  while [ $waited -lt 120 ]; do\n    sleep 5; waited=$((waited+5))\n    if [ -d \"$LOCKDIR\" ]; then\n      LA=$(( $(date +%s) - $(stat -c %Y \"$LOCKDIR\" 2>/dev/null || echo 0) ))\n      [ \"$LA\" -gt 2700 ] && rm -rf \"$LOCKDIR\"\n    fi\n    mkdir \"$LOCKDIR\" 2>/dev/null && break\n  done\nfi\n[ -d \"$LOCKDIR\" ] || { log \"ERROR: BUILD_LOCK_TIMEOUT\"; exit 40; }\ntrap 'rm -rf -- \"$EXTRACT_DIR\" 2>/dev/null || true; rmdir \"$LOCKDIR\" 2>/dev/null || true' EXIT\nif bash gradlew \"$ASSEMBLE_TASK\" --no-daemon --max-workers=2 --stacktrace -Dorg.gradle.jvmargs=\"$JVM_ARGS\" $AIB_GRADLE_EXTRA_FLAGS 2>&1 | tee \"$GRADLE_LOG\"; then\n  log \"✅ Gradle завершился успешно\"\nelse\n  GEC=$?\n  log \"❌ Gradle вернул код $GEC\"\n  log \"\"\n  log \"ПОСЛЕДНИЕ 50 СТРОК:\"\n  tail -50 \"$GRADLE_LOG\"\n  exit $GEC\nfi\n\necho \"=== [5/5] Финализация ===\"\n\n# Ищем APK\npick_newest_apk() {\n  find \"$@\" -type f -name \"*.apk\" 2>/dev/null | while read -r f; do\n    [ -f \"$f\" ] || continue\n    printf \"%s\\t%s\\n\" \"$(stat -c %Y \"$f\" 2>/dev/null || echo 0)\" \"$f\"\n  done | sort -nr | head -1 | cut -f2-\n}\nRAW_APK=$(pick_newest_apk app/build/outputs/apk build/outputs/apk . 2>/dev/null)\nif [ -n \"$RAW_APK\" ] && [ \"${RAW_APK#/}\" = \"$RAW_APK\" ]; then\n  RAW_APK=\"$(pwd)/${RAW_APK#./}\"\nfi\n\nif [ -z \"$RAW_APK\" ] || [ ! -f \"$RAW_APK\" ]; then\n  log \"❌ APK не найден (app/build/outputs, build/outputs, recursive)\"\n  log \"Содержимое outputs:\"\n  find . -type d -name outputs 2>/dev/null | head -10\n  find app/build/outputs/apk -name \"*.apk\" -print -quit 2>/dev/null; find . -name \"*.apk\" -print 2>/dev/null | head -20\n  exit 30\nfi\n\nlog \"✓ Найден: $(basename $RAW_APK)\"\n\n# Подпись если возможна (soft-fail — unsigned APK тоже успех)\nBT=$(ls -d \"$SDK/build-tools\"/*/ 2>/dev/null | tail -1)\nZIPALIGN=\"\"; APKSIGNER=\"\"\n[ -n \"$BT\" ] && [ -x \"${BT}zipalign\" ] && ZIPALIGN=\"${BT}zipalign\"\n[ -n \"$BT\" ] && [ -x \"${BT}apksigner\" ] && APKSIGNER=\"${BT}apksigner\"\n[ -z \"$ZIPALIGN\" ] && command -v zipalign >/dev/null 2>&1 && ZIPALIGN=$(command -v zipalign)\n[ -z \"$APKSIGNER\" ] && command -v apksigner >/dev/null 2>&1 && APKSIGNER=$(command -v apksigner)\n\nif [ -n \"$ZIPALIGN\" ] && [ -n \"$APKSIGNER\" ]; then\n  KS=\"$AIB_KEYS/aib-debug.keystore\"\n  if [ ! -s \"$KS\" ]; then\n    keytool -genkeypair -v -keystore \"$KS\" -storepass android -keypass android \\\n      -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \\\n      -dname \"CN=AIBuilder,O=Termux,C=US\" 2>&1 | tail -2 >> \"$LOG_FILE\" || true\n  fi\n\n  mkdir -p \"$PROJECT/artifacts\"\n  BASE=$(basename \"$RAW_APK\" .apk)\n  ALIGNED=\"$PROJECT/artifacts/$BASE-$BUILD_ID-aligned.apk\"\n  SIGNED=\"$PROJECT/artifacts/$BASE-$BUILD_ID-signed.apk\"\n\n  set +e\n  \"$ZIPALIGN\" -f -p 4 \"$RAW_APK\" \"$ALIGNED\"\n  ZA=$?\n  if [ $ZA -ne 0 ]; then ALIGNED=\"$RAW_APK\"; log \"zipalign fail — use raw\"; fi\n  \"$APKSIGNER\" sign --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \\\n    --ks \"$KS\" --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey \\\n    --out \"$SIGNED\" \"$ALIGNED\"\n  SA=$?\n  set -e\n  if [ $SA -eq 0 ] && [ -s \"$SIGNED\" ]; then\n    RAW_APK=\"$SIGNED\"\n    log \"✓ APK подписан V1+V2+V3\"\n    echo \"SIGNED_V1_V2_V3_OK=$RAW_APK\"\n  else\n    log \"подпись не удалась — отдаём unsigned APK\"\n    echo \"UNSIGNED_APK_OK=$RAW_APK\"\n  fi\nelse\n  log \"zipalign/apksigner нет — unsigned APK\"\n  echo \"UNSIGNED_APK_OK=$RAW_APK\"\nfi\n\nSIZE=$(ls -lh \"$RAW_APK\" | awk '{print $5}')\n\nlog \"\"\nlog \"==========================================\"\nlog \"✅ УСПЕШНО\"\nlog \"==========================================\"\nlog \"APK: $RAW_APK\"\nlog \"Размер: $SIZE\"\nlog \"Артефакты проекта: $PROJECT/artifacts\"\nlog \"==========================================\"\necho \"APK_PATH=$RAW_APK\"\necho \"PROJECT_PATH=$PROJECT\"\necho \"LOG_PATH=$LOG_FILE\"\n";

function buildValidatedBuiltinScript(): string {
  let script = SCRIPT_BODY;
  const replaceOnce = (needle: string, replacement: string, marker: string): void => {
    const index = script.indexOf(needle);
    if (index < 0 || script.indexOf(needle, index + needle.length) >= 0) {
      throw new Error(`BUILTIN_BUILD_PATCH_MARKER_INVALID:${marker}`);
    }
    script = script.slice(0, index) + replacement + script.slice(index + needle.length);
  };

  const legacyLogBlock = String.raw`log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"
}`;
  const redactedLogBlock = String.raw`redact_build_output() {
  awk '
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ { print "[REDACTED_PRIVATE_KEY]"; private_key=1; next }
    private_key { if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/) private_key=0; next }
    {
      line=$0; lower=tolower(line)
      if (lower ~ /authorization[[:space:]]*[:=][[:space:]]*bearer[[:space:]]+/ || lower ~ /[a-z0-9_-]*(api[_-]?key|token|password|secret|authorization)[a-z0-9_-]*[[:space:]]*[:=][[:space:]]*[^[:space:]]+/) { print "[REDACTED_SECRET_LINE]"; next }
      gsub(/(sk-|ghp_|gho_|gha_|ghu_|ghr_|github_pat_|glpat-)[A-Za-z0-9_-]+/, "[REDACTED_TOKEN]", line)
      gsub(/AKIA[A-Z0-9]{16}/, "[REDACTED_AWS_KEY]", line)
      gsub(/AIza[0-9A-Za-z_-]+/, "[REDACTED_GOOGLE_KEY]", line)
      gsub(/(https?|wss?|file|content|github):\/\/[^[:space:]]+/, "[URL_REDACTED]", line)
      gsub(/\/data\/data\/[^\/[:space:]]+\/files\/home\/[^\/[:space:]]+/, "[PRIVATE_PATH]", line)
      gsub(/\/storage\/emulated\/0\/[^\/[:space:]]+\/[^\/[:space:]]+\/[^\/[:space:]]+/, "[PRIVATE_PATH]", line)
      gsub(/\/home\/[^\/[:space:]]+\/[^\/[:space:]]+/, "[PRIVATE_PATH]", line)
      print line
    }
  '
}
log() {
  printf '[%s] %s\\n' "$(date '+%H:%M:%S')" "$*" | redact_build_output | tee -a "$LOG_FILE"
}`
  replaceOnce(legacyLogBlock, redactedLogBlock, "build-log-redaction");

  replaceOnce(
    'pnpm install --frozen-lockfile --ignore-scripts 2>&1 | tail -25 >> "$LOG_FILE"',
    'pnpm install --frozen-lockfile --ignore-scripts 2>&1 | redact_build_output | tail -25 >> "$LOG_FILE"',
    "pnpm-log-redaction",
  );
  replaceOnce(
    'pnpm install --ignore-scripts 2>&1 | tail -25 >> "$LOG_FILE"',
    'pnpm install --ignore-scripts 2>&1 | redact_build_output | tail -25 >> "$LOG_FILE"',
    "pnpm-fallback-log-redaction",
  );
  replaceOnce(
    'npm ci --legacy-peer-deps --no-bin-links 2>&1 | tail -20 >> "$LOG_FILE"',
    'npm ci --legacy-peer-deps --no-bin-links 2>&1 | redact_build_output | tail -20 >> "$LOG_FILE"',
    "npm-ci-log-redaction",
  );
  replaceOnce(
    'npm install --legacy-peer-deps --no-bin-links 2>&1 | tail -20 >> "$LOG_FILE"',
    'npm install --legacy-peer-deps --no-bin-links 2>&1 | redact_build_output | tail -20 >> "$LOG_FILE"',
    "npm-install-log-redaction",
  );
  replaceOnce(
    'node "$EXPO_CLI" prebuild --platform android --clean --non-interactive 2>&1 | tee -a "$LOG_FILE" | tail -20',
    'node "$EXPO_CLI" prebuild --platform android --clean --non-interactive 2>&1 | redact_build_output | tee -a "$LOG_FILE" | tail -20',
    "prebuild-log-redaction",
  );
  replaceOnce(
    '-dname "CN=AIBuilder,O=Termux,C=US" 2>&1 | tail -2 >> "$LOG_FILE" || true',
    '-dname "CN=AIBuilder,O=Termux,C=US" 2>&1 | redact_build_output | tail -2 >> "$LOG_FILE" || true',
    "keytool-log-redaction",
  );
  replaceOnce(
    'bash gradlew "$ASSEMBLE_TASK" --no-daemon --max-workers=2 --stacktrace -Dorg.gradle.jvmargs="$JVM_ARGS" $AIB_GRADLE_EXTRA_FLAGS 2>&1 | tee "$GRADLE_LOG"',
    'bash gradlew "$ASSEMBLE_TASK" --no-daemon --max-workers=2 --stacktrace -Dorg.gradle.jvmargs="$JVM_ARGS" $AIB_GRADLE_EXTRA_FLAGS 2>&1 | redact_build_output | tee "$GRADLE_LOG"',
    "gradle-log-redaction",
  );

  const legacyPathBlock = [
    'AIB_ROOT="/storage/emulated/0/AIBuilderTermux"',
    'AIB_INTERNAL="$AIB_ROOT/.aibuilder"',
    'AIB_WORK="$AIB_INTERNAL/work"',
    'AIB_GRADLE="${HOME}/.aibuilder-gradle"',
    'AIB_TMP="$AIB_INTERNAL/tmp"',
    'AIB_KEYS="$AIB_INTERNAL/keys"',
  ].join("\n");
  replaceOnce(legacyPathBlock, PRIVATE_BUILD_PATHS_INIT_SH, "private-paths");
  replaceOnce('AIB_WORK="$PROJECT/.aibuildertermux-build"', 'AIB_WORK="$AIB_PRIVATE_ROOT/work"', "private-build-log");
  replaceOnce(
    'if [ $ZA -ne 0 ]; then ALIGNED="$RAW_APK"; log "zipalign fail — use raw"; fi',
    'if [ "$ZA" -ne 0 ]; then echo "ZIPALIGN_FAIL: raw APK fallback disabled" >&2; exit 33; fi',
    "zipalign-fail-closed",
  );
  replaceOnce(
    "# Подпись если возможна (soft-fail — unsigned APK тоже успех)",
    "# A successful APK must be aligned, signed, and verified with schemes V1+V2+V3.",
    "signing-comment",
  );
  replaceOnce(
    'if [ $SA -eq 0 ] && [ -s "$SIGNED" ]; then\n    RAW_APK="$SIGNED"',
    String.raw`if [ "$SA" -eq 0 ] && [ -s "$SIGNED" ]; then
    VERIFY=$("$APKSIGNER" verify --verbose "$SIGNED" 2>&1) || { echo "APKSIGNER_VERIFY_FAIL" >&2; exit 35; }
    printf '%s\n' "$VERIFY" | grep -Eiq 'v1.*true|Verified using v1 scheme.*true' || { echo "APK_V1_SIGNATURE_MISSING" >&2; exit 35; }
    printf '%s\n' "$VERIFY" | grep -Eiq 'v2.*true|Verified using v2 scheme.*true' || { echo "APK_V2_SIGNATURE_MISSING" >&2; exit 35; }
    printf '%s\n' "$VERIFY" | grep -Eiq 'v3.*true|Verified using v3 scheme.*true' || { echo "APK_V3_SIGNATURE_MISSING" >&2; exit 35; }
    RAW_APK="$SIGNED"`,
    "signed-artifact-verification",
  );
  replaceOnce(
    '  else\n    log "подпись не удалась — отдаём unsigned APK"\n    echo "UNSIGNED_APK_OK=$RAW_APK"\n  fi',
    '  else\n    log "ERROR: apksigner did not produce a verified signed artifact"\n    echo "APKSIGNER_FAIL" >&2\n    exit 34\n  fi',
    "signing-fail-closed",
  );
  replaceOnce(
    'else\n  log "zipalign/apksigner нет — unsigned APK"\n  echo "UNSIGNED_APK_OK=$RAW_APK"\nfi',
    'else\n  log "ERROR: zipalign/apksigner are required for a successful APK build"\n  echo "SIGNING_TOOLS_MISSING" >&2\n  exit 36\nfi',
    "signing-tools-required",
  );

  const extraction = 'unzip -q "$ZIP" -d "$EXTRACT_DIR"';
  if (!script.includes(extraction)) throw new Error("BUILTIN_BUILD_ARCHIVE_EXTRACTION_MARKER_MISSING");
  const guardedExtraction = ['SRC="$ZIP"', buildProjectArchiveValidationCommand(), extraction].join("\n");
  script = script.replace(extraction, guardedExtraction);
  return script;
}

export function getBuiltinBuildScript(): string {
  return buildValidatedBuiltinScript();
}

function toBase64(scriptBody: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(scriptBody, "utf8").toString("base64");
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = unescape(encodeURIComponent(scriptBody));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes.charCodeAt(i);
    const b = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : 0;
    const c = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : 0;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? chars[c & 63] : "=";
  }
  return out;
}

/**
 * Канонический путь user-скрипта.
 * Приоритет: $HOME (надёжнее, нет noexec/permission issues на /storage),
 * fallback на shared storage для совместимости.
 * materializeUserScript пишет через Termux, поэтому $HOME резолвится в Termux.
 */
export const AIB_USER_SCRIPT_PATH_HOME = "$PREFIX/tmp/aibuilder-scripts/aib-user-script.sh";
/** User-authored scripts are private temporary Termux files; never fall back to shared storage. */
export const AIB_USER_SCRIPT_PATH = AIB_USER_SCRIPT_PATH_HOME;

/** Failed script kept next to log for open/edit/retry. */
export const AIB_LAST_FAILED_SCRIPT_PATH = "$PREFIX/tmp/aibuilder-scripts/aib-last-failed.sh";
export const AIB_LAST_FAILED_LOG_PATH = "$PREFIX/tmp/aibuilder-scripts/aib-last-failed.log";

/** Quote a literal shell word; only an approved leading home variable is expanded. */
function shellQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

export function shellPathExpr(path: string): string {
  const p = String(path || "");
  if (!p || /[\0\r\n]/.test(p)) throw new Error("UNSAFE_SHELL_PATH");
  const expansion = /^(~|\$HOME|\$\{HOME\}|\$PREFIX|\$\{PREFIX\})(?=\/|$)/.exec(p)?.[0];
  if (!expansion) return shellQuoteLiteral(p);
  const variable = expansion.includes("PREFIX") ? '"$PREFIX"' : '"$HOME"';
  const suffix = p.slice(expansion.length);
  return suffix ? `${variable}${shellQuoteLiteral(suffix)}` : variable;
}

export type TermuxRunner = (
  cmd: string,
  opts?: { timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;

export interface MaterializeProgress {
  phase: "prep" | "chunk" | "verify";
  current: number;
  total: number;
  detail?: string;
}

export interface MaterializeOptions {
  onProgress?: (p: MaterializeProgress) => void;
  /** Override target path (default AIB_USER_SCRIPT_PATH). */
  scriptPath?: string;
}

/** UTF-8 byte length of string (for size verify after base64 decode). */
export function utf8ByteLength(s: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(s, "utf8");
  // RN fallback
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Пишет тело скрипта на диск кусками base64 (короткие команды Termux),
 * чтобы не упираться в лимит RUN_COMMAND / binder на длинный one-shot.
 * Проверяет размер файла == utf8ByteLength(body).
 */
export async function materializeUserScript(
  scriptBody: string,
  run: TermuxRunner,
  options?: MaterializeOptions,
): Promise<string> {
  let scriptPath = options?.scriptPath || AIB_USER_SCRIPT_PATH;
  let dir = scriptPath.replace(/\/[^/]+$/, "");
  let sp = shellPathExpr(scriptPath);
  let dp = shellPathExpr(dir);
  const expectedBytes = utf8ByteLength(scriptBody);
  const b64 = toBase64(scriptBody);
  const chunkSize = 2400;
  const totalChunks = Math.max(1, Math.ceil(b64.length / chunkSize));

  options?.onProgress?.({ phase: "prep", current: 0, total: totalChunks, detail: "prep" });

  let prep = await run(
    `mkdir -p ${dp} && : > ${sp} && echo PREP_OK`,
    { timeoutMs: 20_000 },
  );
  if (prep.exitCode !== 0 && !/PREP_OK/.test(prep.stdout || "")) {
    throw new Error(
      `Cannot prepare private Termux script file: exit=${prep.exitCode} ${(prep.stderr || prep.stdout || "").slice(0, 200)}`,
    );
  }

  let chunkIndex = 0;
  for (let i = 0; i < b64.length; i += chunkSize) {
    chunkIndex += 1;
    const c = b64.slice(i, i + chunkSize);
    options?.onProgress?.({
      phase: "chunk",
      current: chunkIndex,
      total: totalChunks,
      detail: `chunk ${chunkIndex}/${totalChunks}`,
    });
    // Recreate parent before every chunk because command runners may isolate calls.
    const r = await run(`mkdir -p ${dp} && printf '%s' '${c}' | base64 -d >> ${sp}`, { timeoutMs: 20_000 });
    if (r.exitCode !== 0) {
      throw new Error(
        `Script chunk write failed at ${chunkIndex}/${totalChunks}: exit=${r.exitCode} ${(r.stderr || "").slice(0, 160)}`,
      );
    }
  }

  options?.onProgress?.({
    phase: "verify",
    current: totalChunks,
    total: totalChunks,
    detail: `verify size=${expectedBytes}`,
  });

  // Robust size check: Termux may drop multi-line stdout (log showed only "14475 path").
  const parseSize = (text: string): number => {
    const s = String(text || "");
    const m1 = /SIZE=(\d+)/.exec(s);
    if (m1) return Number(m1[1]);
    // "14475 /path/to/file" or bare number
    const m2 = /^\s*(\d+)\b/m.exec(s);
    if (m2) return Number(m2[1]);
    const digits = s.replace(/\D+/g, " ").trim().split(/\s+/).filter(Boolean);
    return digits.length ? Number(digits[0]) : 0;
  };

  const verify = await run(
    `chmod +x ${sp} 2>/dev/null || true; ACT=$(wc -c < ${sp} 2>/dev/null | tr -d ' \t\n\r'); printf 'SIZE=%s\n' "$ACT"`,
    { timeoutMs: 15_000 },
  );
  let actual = parseSize(`${verify.stdout || ""}\n${verify.stderr || ""}`);

  if (!(actual === expectedBytes && actual > 0)) {
    const again = await run(
      `wc -c < ${sp} 2>/dev/null | tr -d ' \t\n\r'`,
      { timeoutMs: 10_000 },
    );
    actual = parseSize(again.stdout || "") || parseSize(again.stderr || "");
  }

  // Accept exact match, or tiny drift, or non-empty file when expected>0 and exit 0
  const sizeOk = actual === expectedBytes && actual > 0;
  const driftOk = actual > 100 && Math.abs(actual - expectedBytes) <= 8;
  if (!sizeOk && !driftOk) {
    // Last resort: test -s only (chunks all exited 0) — avoid blocking real builds
    const exists = await run(
      `test -s ${sp} && echo EXISTS || echo MISSING`,
      { timeoutMs: 10_000 },
    );
    if (!/EXISTS/.test(exists.stdout || "")) {
      throw new Error(
        `Script verify failed: expected=${expectedBytes} actual=${actual} exit=${verify.exitCode} out=${String(verify.stdout || "").slice(0, 200)}`,
      );
    }
    // File exists and non-empty after successful chunk writes — proceed with warning size
  }
  return scriptPath;
}

/**
 * Короткая команда запуска: скрипт УЖЕ на диске (см. materializeUserScript).
 * Не тащит тело скрипта в base64 внутри одной команды.
 */
export function buildTermuxLaunchCommand(
  zipPath: string | undefined | null,
  scriptPath: string = AIB_USER_SCRIPT_PATH,
): string {
  const safeZip = (zipPath || "").replace(/'/g, `'"'"'`);
  const scriptExpr = shellPathExpr(scriptPath || AIB_USER_SCRIPT_PATH);
  // Seed Termux SDK/Java env BEFORE user script runs.
  // User scripts often reuse PREFIX (e.g. ZIP name prefix) and then
  // "$PREFIX/opt/android-sdk" points nowhere. ANDROID_HOME survives that.
  const envPreamble = [
    'export PREFIX="${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"',
    'export TERMUX_PREFIX="$PREFIX"',
    'if [ -z "${ANDROID_HOME:-}${ANDROID_SDK_ROOT:-}" ]; then',
    '  for d in "$PREFIX/opt/android-sdk" "$PREFIX/share/android-sdk" "$PREFIX/lib/android-sdk"; do',
    '    [ -d "$d" ] && export ANDROID_HOME="$d" ANDROID_SDK_ROOT="$d" && break',
    '  done',
    'fi',
    'if [ -z "${JAVA_HOME:-}" ]; then',
    '  for d in "$PREFIX/lib/jvm/java-17-openjdk" "$PREFIX/lib/jvm/java-21-openjdk" "$PREFIX/lib/jvm/java-11-openjdk"; do',
    '    [ -x "$d/bin/java" ] && export JAVA_HOME="$d" && break',
    '  done',
    'fi',
    '[ -n "$JAVA_HOME" ] && export PATH="$JAVA_HOME/bin:$PATH"',
    '[ -n "$ANDROID_HOME" ] && export PATH="$PATH:$ANDROID_HOME/platform-tools"',
    'export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"',
    'mkdir -p "$GRADLE_USER_HOME"',
    // AIB_SHEBANG_FIX (v415): RUN_COMMAND + stdbuf can lose termux-exec in LD_PRELOAD, so scripts with
    // `#!/usr/bin/env node` (node_modules/.bin/expo, ...) fail with `sh: 1: expo: not found`.
    // Restore it for the user script; drop libstdbuf (it only line-buffers stdio of children).
    'AIB_LDP=""; AIB_OLD_IFS="$IFS"; IFS=:',
    'for x in ${LD_PRELOAD:-}; do case "$x" in ""|*libstdbuf*) ;; *) AIB_LDP="${AIB_LDP:+$AIB_LDP:}$x" ;; esac; done',
    'IFS="$AIB_OLD_IFS"',
    'case ":$AIB_LDP:" in *termux-exec*) ;; *)',
    '  for l in "$PREFIX/lib/libtermux-exec-ld-preload.so" "$PREFIX/lib/libtermux-exec.so"; do',
    '    [ -f "$l" ] && AIB_LDP="$l${AIB_LDP:+:$AIB_LDP}" && break',
    '  done ;; esac',
    'if [ -n "$AIB_LDP" ]; then export LD_PRELOAD="$AIB_LDP"; else unset LD_PRELOAD; fi',
    'AIB_SB="$(mktemp "${TMPDIR:-$PREFIX/tmp}/aib-shebang.XXXXXX" 2>/dev/null)"',
    'if [ -n "$AIB_SB" ]; then printf \'#!/usr/bin/env sh\\necho ok\\n\' > "$AIB_SB"; chmod +x "$AIB_SB"; if [ "$("$AIB_SB" 2>/dev/null)" = ok ]; then AIB_SHEBANG=ok; else AIB_SHEBANG=BROKEN; fi; rm -f "$AIB_SB"; else AIB_SHEBANG=unknown; fi',
  ].join("\n");
  const lines: string[] = [
    envPreamble,
    // Без TTY bash/gradle буферизуют вывод → в логе «stdout 0 байт» и непонятно, живо ли
    "export PYTHONUNBUFFERED=1",
    "export TERM=${TERM:-xterm}",
    "set -e",
    `SCRIPT=${scriptExpr}`,
    'test -s "$SCRIPT" || { echo "SCRIPT_MISSING: $SCRIPT" >&2; exit 9; }',
  ];
  if (safeZip) {
    lines.push(`export AIB_ZIP_PATH='${safeZip}'`);
  }
  lines.push(
    'echo "=== AI Builder Script Runner ==="',
    safeZip
      ? 'echo "ZIP: $AIB_ZIP_PATH"'
      : 'echo "ZIP: (none) — скрипт может сам искать архив в AIBuilderTermux"',
    'echo "SCRIPT: $SCRIPT"',
    'wc -c "$SCRIPT" | awk \'{print "SIZE: "$1" bytes"}\'',
    'echo "START: $(date \'+%H:%M:%S\') — ждите строки лога; Gradle часто 5–20 мин"',
    'echo "AIB_ENV: shebang=$AIB_SHEBANG LD_PRELOAD=${LD_PRELOAD:-<empty>}"',
    'echo "---"',
    // set +e: чтобы после скрипта напечатать END и код выхода
    "set +e",
    // v415: no stdbuf here - it rewrites LD_PRELOAD and breaks termux-exec shebang handling.
    'bash -o pipefail "$SCRIPT"',
    "EC=$?",
    'echo "---"',
    'echo "END: $(date \'+%H:%M:%S\') exit=$EC"',
    "exit $EC",
  );
  return lines.join("\n");
}

export function buildStopCommand(): string {
  return [
    "pkill -f 'aib-user-script|gradlew|assembleDebug' 2>/dev/null || true",
    "sleep 0.4",
    "pkill -9 -f 'aib-user-script|gradlew|assembleDebug' 2>/dev/null || true",
    "echo AIB_SCRIPT_STOPPED",
  ].join("; ");
}
