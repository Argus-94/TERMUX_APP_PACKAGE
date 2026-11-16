/**
 * Пакеты для компиляции APK в выбранном backend; по умолчанию это Termux.
 * Каждый пакет — отдельная кнопка: install → wait → verify → mark installed.
 * Общие зависимости не удаляются с карточки одного инструмента.
 * Пока package manager не отдаёт измеряемый прогресс, UI показывает фазу и indeterminate.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { type TermuxCommandResult } from "./termux-bridge";
import { runPackageCommand } from "./package-backend";
import { persistentLogger } from "./persistent-logger";
import { isPkgMirrorFailure } from "./termux-installer-env";
import { checkPackageCommand, type PackageCheckOutcome } from "./package-check-outcome";
import { formatPackageInstallFailure } from "./package-install-diagnostics";
import { buildProotDistroRootfsCheckCommand, buildProotDistroRootfsInstallCommand } from "./termux-bootstrap-install";
import { buildProotDistroRemoveGuardCommand, withProotDistroHostToolLock } from "./proot-distro-state";
import { installProotDistroRootfsWithPrerequisite } from "./proot-distro-bootstrap";
import { getBuildBackend, type AgentShellBackend } from "./agent-shell-backend";
import { mergeSuccessfulPackageChecksIntoCache, scanPackageCatalog, type PackageScanHooks } from "./package-catalog-scan";
import { isRightPackageMenuPackage } from "./package-menu-routing";

export type CompilePkgId =
  | "openjdk-17"
  | "git"
  | "android-sdk"
  | "android-ndk"
  | "gradle"
  | "ant"
  | "maven"
  | "build-essential"
  | "clang"
  | "make"
  | "cmake"
  | "wget"
  | "curl"
  | "nano"
  | "vim"
  | "zip-unzip"
  | "nodejs"
  | "pnpm"
  | "npm"
  | "kotlin"
  | "python"
  | "termux-api"
  | "aapt2"
  | "zipalign"
  | "apksigner"
  | "platform-tools"
  | "which"
  | "ninja"
  | "sdk-cmdline-tools"
  | "android-platform-34"
  | "android-platform-35"
  | "proot-distro"
  | "debian-rootfs"
  | "ubuntu-rootfs";

export interface CompilePackageDef {
  id: CompilePkgId;
  /** Отображаемое имя (RU/UK) */
  name: string;
  nameEn: string;
  /** apt-get install -y ... */
  installCmd: string;
  /** exit 0 = установлено */
  checkCmd: string;
  /** apt-get remove -y */
  removeCmd: string;
  /** Пояснение, если общий пакет/alias нельзя безопасно удалить из одной карточки. */
  removeBlockedReason?: string;
  /** Оценка длительности для справки; не используется как процент выполнения. */
  estimateSec: number;
  /** Порядок в списке */
  order: number;
  /** Опциональный таймаут install (мс); иначе INSTALL_TIMEOUT_MS */
  timeoutMs?: number;
}

/** Пакеты, которые нельзя поставить без другого пакета каталога. */
/**
 * apt-шаги, которые выполняются ОТДЕЛЬНЫМ запуском до основного скрипта: так длинный
 * скрипт скачивания не проходит через обёртку apt-повторов (см. v370).
 */
const COMPILE_PACKAGE_PRE_INSTALL: Partial<Record<CompilePkgId, string>> = {
  "sdk-cmdline-tools": "apt-get install -y curl unzip openjdk-17 2>&1",
};

const COMPILE_PACKAGE_PREREQUISITES: Partial<Record<CompilePkgId, CompilePkgId>> = {
  "android-platform-34": "sdk-cmdline-tools",
  "android-platform-35": "sdk-cmdline-tools",
};

export const COMPILE_PACKAGES: CompilePackageDef[] = [
  {
    id: "wget",
    name: "Wget",
    nameEn: "Wget",
    installCmd: "apt-get install -y wget",
    checkCmd: "command -v wget >/dev/null 2>&1 && wget --version 2>&1 | head -1",
    removeCmd: "apt-get remove -y wget",
    estimateSec: 15,
    order: 1,
  },
  {
    id: "curl",
    name: "Curl",
    nameEn: "Curl",
    installCmd: "apt-get install -y curl",
    checkCmd: "command -v curl >/dev/null 2>&1 && curl --version 2>&1 | head -1",
    removeCmd: "apt-get remove -y curl",
    estimateSec: 15,
    order: 2,
  },
  {
    id: "zip-unzip",
    name: "Zip / Unzip",
    nameEn: "Zip / Unzip",
    installCmd: "apt-get install -y zip unzip",
    checkCmd: "command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1",
    removeCmd: "apt-get remove -y zip unzip",
    estimateSec: 15,
    order: 3,
  },
  {
    id: "git",
    name: "Git",
    nameEn: "Git",
    installCmd: "apt-get install -y git",
    checkCmd: "command -v git >/dev/null 2>&1 && git --version",
    removeCmd: "apt-get remove -y git",
    estimateSec: 30,
    order: 4,
  },
  {
    id: "openjdk-17",
    name: "Java Development Kit (OpenJDK)",
    nameEn: "Java Development Kit (OpenJDK)",
    // Termux: openjdk-17 или openjdk-21. Ставим оба кандидатов; check — реальный java.
    installCmd: `set +e
apt-get install -y openjdk-21 2>&1 || apt-get install -y openjdk-17 2>&1 || apt-get install -y openjdk-17-jdk 2>&1
if command -v java >/dev/null 2>&1; then
  java -version 2>&1 | head -1
  echo JAVA_OK
  exit 0
fi
echo JAVA_FAIL
exit 1`,
    checkCmd: "command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1",
    removeCmd: "apt-get remove -y openjdk-21 openjdk-17 openjdk-17-jdk 2>/dev/null; true",
    estimateSec: 120,
    order: 5,
  },
  {
    id: "build-essential",
    name: "Build Essential",
    nameEn: "Build Essential",
    // Debian/Ubuntu: meta-package. Termux: no build-essential — fall back to clang+make+pkg-config.
    installCmd: `set +e
apt-get install -y build-essential 2>&1
if command -v gcc >/dev/null 2>&1 || dpkg -s build-essential >/dev/null 2>&1; then
  echo BUILD_ESSENTIAL_OK
  exit 0
fi
apt-get install -y clang make pkg-config 2>&1
if command -v clang >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1; then
  echo BUILD_ESSENTIAL_OK
  exit 0
fi
echo BUILD_ESSENTIAL_FAIL
exit 1`,
    checkCmd: "command -v gcc >/dev/null 2>&1 || command -v clang >/dev/null 2>&1 || dpkg -s build-essential >/dev/null 2>&1",
    removeCmd: "apt-get remove -y build-essential clang make pkg-config 2>/dev/null; true",
    estimateSec: 90,
    order: 6,
  },
  {
    id: "clang",
    name: "Clang",
    nameEn: "Clang",
    installCmd: "apt-get install -y clang",
    checkCmd: "command -v clang >/dev/null 2>&1 && clang --version 2>&1 | head -1",
    removeCmd: "apt-get remove -y clang",
    estimateSec: 60,
    order: 7,
  },
  {
    id: "make",
    name: "Make",
    nameEn: "Make",
    installCmd: "apt-get install -y make",
    checkCmd: "command -v make >/dev/null 2>&1 && make --version 2>&1 | head -1",
    removeCmd: "apt-get remove -y make",
    estimateSec: 20,
    order: 8,
  },
  {
    id: "cmake",
    name: "CMake",
    nameEn: "CMake",
    installCmd: "apt-get install -y cmake",
    checkCmd: "command -v cmake >/dev/null 2>&1 && cmake --version 2>&1 | head -1",
    removeCmd: "apt-get remove -y cmake",
    estimateSec: 40,
    order: 9,
  },
  {
    id: "android-sdk",
    name: "Android SDK",
    nameEn: "Android SDK",
    // Нет пакета android-sdk в Termux apt. Ставим android-tools + aapt и собираем $PREFIX/opt/android-sdk.
    installCmd: `set +e
apt-get install -y android-tools aapt aapt2 apksigner d8 unzip wget curl 2>&1
PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"
SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"
if [ -L "$PREFIX/opt" ] || [ -L "$SDK" ] || [ -L "$SDK/platform-tools" ] || [ -L "$SDK/build-tools" ] || [ -L "$SDK/build-tools/termux" ]; then
  echo AIB_SDK_PATH_SYMLINK_COLLISION
  exit 1
fi
mkdir -p "$SDK/platform-tools" "$SDK/build-tools/termux" "$PREFIX/tmp" || { echo AIB_SDK_DIRECTORY_CREATE_FAILED; exit 1; }
MARKER="$SDK/.aib-android-sdk-tools"
MANIFEST="$SDK/.aib-android-sdk-tools-links"
TMP_MANIFEST=$(mktemp "$SDK/.aib-android-sdk-tools-links.XXXXXX") || { echo AIB_SDK_TEMP_CREATE_FAILED; exit 1; }
for b in adb aapt aapt2 apksigner d8; do
  if command -v "$b" >/dev/null 2>&1; then
    SRC=$(command -v "$b")
    for LINK in "$SDK/platform-tools/$b" "$SDK/build-tools/termux/$b"; do
      if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then echo "AIB_SDK_TOOL_COLLISION $LINK"; rm -f "$TMP_MANIFEST"; exit 1; fi
      if [ -L "$LINK" ]; then
        if [ "$(readlink "$LINK")" != "$SRC" ]; then echo "AIB_SDK_LINK_COLLISION $LINK"; rm -f "$TMP_MANIFEST"; exit 1; fi
      elif ! ln -s "$SRC" "$LINK"; then
        echo "AIB_SDK_LINK_FAILED $LINK"; rm -f "$TMP_MANIFEST"; exit 1
      fi
      printf '%s\t%s\n' "$LINK" "$SRC" >> "$TMP_MANIFEST"
    done
  fi
done
AAPT_TOOL="$SDK/build-tools/termux/aapt2"
if [ -x "$AAPT_TOOL" ] && "$AAPT_TOOL" version >/dev/null 2>&1; then mv "$TMP_MANIFEST" "$MANIFEST" && : > "$MARKER" && echo SDK_OK && exit 0; fi
AAPT_TOOL="$SDK/build-tools/termux/aapt"
if [ -x "$AAPT_TOOL" ] && "$AAPT_TOOL" version >/dev/null 2>&1; then mv "$TMP_MANIFEST" "$MANIFEST" && : > "$MARKER" && echo SDK_OK && exit 0; fi
rm -f "$TMP_MANIFEST"
echo "SDK_FAIL: aapt/aapt2 was not verified in the managed SDK tool view"
exit 1`,
    checkCmd: `SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; [ -f "$SDK/.aib-android-sdk-tools" ] || exit 1; for AAPT_TOOL in "$SDK/build-tools/termux/aapt2" "$SDK/build-tools/termux/aapt"; do [ -x "$AAPT_TOOL" ] && "$AAPT_TOOL" version >/dev/null 2>&1 && exit 0; done; exit 1`,
    removeCmd: `PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"; SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; if [ -L "$PREFIX/opt" ] || [ -L "$SDK" ] || [ -L "$SDK/platform-tools" ] || [ -L "$SDK/build-tools" ] || [ -L "$SDK/build-tools/termux" ]; then echo AIB_SDK_PATH_SYMLINK_COLLISION >&2; exit 1; fi; MANIFEST="$SDK/.aib-android-sdk-tools-links"; if [ -f "$MANIFEST" ]; then while IFS="$(printf '\t')" read -r LINK TARGET; do case "$LINK" in "$SDK/platform-tools/"*|"$SDK/build-tools/termux/"*) ;; *) continue ;; esac; if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$TARGET" ]; then rm -f -- "$LINK"; fi; done < "$MANIFEST"; fi; rm -f -- "$MANIFEST" "$SDK/.aib-android-sdk-tools"; rmdir "$SDK/platform-tools" "$SDK/build-tools/termux" "$SDK/build-tools" 2>/dev/null || true`,
    estimateSec: 180,
    order: 10,
  },
  {
    id: "android-ndk",
    name: "Android NDK",
    nameEn: "Android NDK",
    // Only a toolchain qualified for the application's own private prefix is permitted.
    installCmd: `echo AIB_PRIVATE_NDK_NOT_QUALIFIED >&2; exit 78`,
    checkCmd: `([ -x "$PREFIX/opt/android-ndk/ndk-build" ] || [ -x "$PREFIX/opt/android-ndk/build/ndk-build" ])`,
    removeCmd: `DEST="$PREFIX/opt/android-ndk"; if [ -L "$PREFIX/opt" ] || [ -L "$DEST" ]; then echo NDK_PATH_SYMLINK_COLLISION >&2; exit 1; fi; if [ -f "$DEST/.aib-managed-by-ai-builder" ]; then rm -rf -- "$DEST"; else echo NDK_NOT_APP_OWNED; exit 1; fi`,
    estimateSec: 600,
    order: 11,
  },
  {
    id: "gradle",
    name: "Gradle",
    nameEn: "Gradle",
    installCmd: `set +e
PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"
VER=8.11.1
DEST="$PREFIX/opt/gradle"
if [ -L "$PREFIX/opt" ] || [ -L "$DEST" ]; then echo GRADLE_PATH_SYMLINK_COLLISION; exit 1; fi
if [ -x "$DEST/bin/gradle" ]; then "$DEST/bin/gradle" --version >/dev/null 2>&1 && { echo GRADLE_OK already; exit 0; }; echo GRADLE_EXISTING_INSTALL_BROKEN; exit 1; fi
if [ -e "$DEST" ]; then echo GRADLE_DEST_EXISTS_NOT_OWNED; exit 1; fi
mkdir -p "$PREFIX/opt" "$PREFIX/tmp" || { echo GRADLE_PREFIX_TEMP_FAILED; exit 1; }
APT_LOG=$(mktemp "$PREFIX/tmp/aib-gradle-apt.XXXXXX") || { echo GRADLE_TEMP_CREATE_FAILED; exit 1; }
trap 'rm -f -- "$APT_LOG"; [ -n "\${TMP:-}" ] && rm -f -- "$TMP"; [ -n "\${EXTRACT_DIR:-}" ] && rm -rf -- "$EXTRACT_DIR"' EXIT
apt-get install -y gradle >"$APT_LOG" 2>&1
APT_EC=$?
tail -20 "$APT_LOG"
if command -v gradle >/dev/null 2>&1 && gradle --version >/dev/null 2>&1; then echo GRADLE_OK; exit 0; fi
if [ "$APT_EC" -eq 0 ]; then echo GRADLE_APT_POSTCHECK_FAILED; exit 1; fi
if ! grep -Eqi 'temporary failure|could not resolve|connection timed out|could not connect|network is unreachable|failed to fetch|connection reset|name resolution' "$APT_LOG"; then echo "GRADLE_APT_FAILED_NOT_TRANSIENT_NETWORK exit=$APT_EC"; exit "$APT_EC"; fi
echo GRADLE_TRANSIENT_NETWORK_FALLBACK=official-pinned
for TOOL in java curl unzip sha256sum; do command -v "$TOOL" >/dev/null 2>&1 || { echo "GRADLE_PREREQUISITE_MISSING $TOOL"; exit 1; }; done
TMP=$(mktemp "$PREFIX/tmp/aib-gradle-8.11.1.XXXXXX") || { echo GRADLE_TEMP_CREATE_FAILED; exit 1; }
EXTRACT_DIR=$(mktemp -d "$PREFIX/tmp/aib-gradle-extract.XXXXXX") || { echo GRADLE_TEMP_CREATE_FAILED; exit 1; }
URL="https://services.gradle.org/distributions/gradle-\${VER}-bin.zip"
EXPECT_SHA="f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6"
echo "GRADLE_DL $URL"
curl -fL --connect-timeout 30 --retry 2 --retry-delay 2 --max-time 600 -o "$TMP" "$URL"
DL_EC=$?
SZ=$(stat -c%s "$TMP" 2>/dev/null || echo 0)
echo "GRADLE_CURL_EC=$DL_EC GRADLE_SIZE=$SZ"
if [ "$DL_EC" -ne 0 ] || [ "$SZ" -lt 10000000 ]; then echo GRADLE_DOWNLOAD_OR_SIZE_FAILED; exit 1; fi
GOT_SHA=$(sha256sum "$TMP" | awk '{print $1}')
echo "GRADLE_SHA=$GOT_SHA"
if [ "$GOT_SHA" != "$EXPECT_SHA" ]; then echo "GRADLE_SHA_MISMATCH expected=$EXPECT_SHA"; exit 1; fi
unzip -t "$TMP" >"$EXTRACT_DIR/zip-test.log" 2>&1
ZIP_TEST_EC=$?
tail -5 "$EXTRACT_DIR/zip-test.log"
if [ "$ZIP_TEST_EC" -ne 0 ]; then echo "GRADLE_ZIP_TEST_FAILED exit=$ZIP_TEST_EC"; exit "$ZIP_TEST_EC"; fi
unzip -q "$TMP" -d "$EXTRACT_DIR"
UNZIP_EC=$?
if [ "$UNZIP_EC" -ne 0 ] || [ ! -x "$EXTRACT_DIR/gradle-\${VER}/bin/gradle" ]; then echo "GRADLE_EXTRACT_POSTCHECK_FAILED exit=$UNZIP_EC"; exit 1; fi
if [ -e "$PREFIX/bin/gradle" ] || [ -L "$PREFIX/bin/gradle" ]; then echo GRADLE_BIN_PATH_COLLISION; exit 1; fi
mv "$EXTRACT_DIR/gradle-\${VER}" "$DEST" || { echo GRADLE_COMMIT_FAILED; exit 1; }
: > "$DEST/.aib-managed-by-ai-builder" || { echo GRADLE_MARKER_WRITE_FAILED; exit 1; }
ln -s "$DEST/bin/gradle" "$PREFIX/bin/gradle" || { echo GRADLE_BIN_LINK_FAILED; exit 1; }
if "$DEST/bin/gradle" --version >/dev/null 2>&1; then echo GRADLE_OK; exit 0; fi
echo GRADLE_POSTCHECK_FAILED
exit 1`,
    checkCmd: `if [ -x "$PREFIX/opt/gradle/bin/gradle" ]; then "$PREFIX/opt/gradle/bin/gradle" --version >/dev/null 2>&1; else command -v gradle >/dev/null 2>&1 && gradle --version >/dev/null 2>&1; fi`,
    removeCmd: `PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"; DEST="$PREFIX/opt/gradle"; if [ -L "$PREFIX/opt" ] || [ -L "$DEST" ]; then echo GRADLE_PATH_SYMLINK_COLLISION >&2; exit 1; fi; apt-get remove -y gradle 2>/dev/null; if [ -f "$DEST/.aib-managed-by-ai-builder" ]; then rm -rf -- "$DEST"; fi; if [ -L "$PREFIX/bin/gradle" ] && [ "$(readlink "$PREFIX/bin/gradle")" = "$DEST/bin/gradle" ]; then rm -f -- "$PREFIX/bin/gradle"; fi`,
    estimateSec: 120,
    order: 12,
  },
  {
    id: "ant",
    name: "Apache Ant",
    nameEn: "Apache Ant",
    installCmd: "apt-get install -y ant",
    checkCmd: "command -v ant >/dev/null 2>&1 && ant -version 2>&1 | head -1",
    removeCmd: "apt-get remove -y ant",
    estimateSec: 40,
    order: 13,
  },
  {
    id: "maven",
    name: "Maven",
    nameEn: "Maven",
    installCmd: "apt-get install -y maven",
    checkCmd: "command -v mvn >/dev/null 2>&1 && mvn -version 2>&1 | head -1",
    removeCmd: "apt-get remove -y maven",
    estimateSec: 60,
    order: 14,
  },
  {
    id: "nano",
    name: "Nano",
    nameEn: "Nano",
    installCmd: "apt-get install -y nano",
    checkCmd: "command -v nano >/dev/null 2>&1",
    removeCmd: "apt-get remove -y nano",
    estimateSec: 10,
    order: 15,
  },
  {
    id: "vim",
    name: "Vim",
    nameEn: "Vim",
    installCmd: "apt-get install -y vim",
    checkCmd: "command -v vim >/dev/null 2>&1",
    removeCmd: "apt-get remove -y vim",
    estimateSec: 20,
    order: 16,
  },

  {
    id: "nodejs",
    name: "Node.js",
    nameEn: "Node.js",
    installCmd: `set +e
apt-get install -y nodejs-lts 2>&1 || apt-get install -y nodejs 2>&1
if command -v node >/dev/null 2>&1; then
  node -v 2>&1 | head -1
  echo NODE_OK
  exit 0
fi
echo NODE_FAIL
exit 1`,
    checkCmd: "command -v node >/dev/null 2>&1 && node -v >/dev/null 2>&1",
    removeCmd: "apt-get remove -y nodejs-lts nodejs 2>/dev/null; true",
    estimateSec: 90,
    order: 17,
  },
  {
    id: "npm",
    name: "npm",
    nameEn: "npm",
    installCmd: `set +e
# npm обычно идёт с nodejs; при отсутствии — доустановка
apt-get install -y nodejs-lts 2>&1 || apt-get install -y nodejs 2>&1
if command -v npm >/dev/null 2>&1; then
  npm -v 2>&1 | head -1
  echo NPM_OK
  exit 0
fi
echo NPM_FAIL
exit 1`,
    checkCmd: "command -v npm >/dev/null 2>&1 && npm -v >/dev/null 2>&1",
    removeCmd: `echo NPM_SHARED_WITH_NODEJS_REMOVE_BLOCKED >&2; exit 64`,
    removeBlockedReason: "npm is installed as part of Node.js; remove the Node.js package card rather than removing npm by itself.",
    estimateSec: 60,
    order: 18,
  },
  {
    id: "pnpm",
    name: "pnpm",
    nameEn: "pnpm",
    installCmd: `set +e
apt-get install -y nodejs-lts 2>&1 || apt-get install -y nodejs 2>&1
if ! command -v npm >/dev/null 2>&1; then
  echo NPM_MISSING
  exit 1
fi
npm install -g pnpm 2>&1
if command -v pnpm >/dev/null 2>&1; then
  pnpm -v 2>&1 | head -1
  echo PNPM_OK
  exit 0
fi
# fallback corepack
command -v corepack >/dev/null 2>&1 && corepack enable && corepack prepare pnpm@9.15.0 --activate 2>&1
if command -v pnpm >/dev/null 2>&1; then
  pnpm -v 2>&1 | head -1
  echo PNPM_OK
  exit 0
fi
echo PNPM_FAIL
exit 1`,
    checkCmd: "command -v pnpm >/dev/null 2>&1 && pnpm -v >/dev/null 2>&1",
    removeCmd: "npm uninstall -g pnpm 2>/dev/null; true",
    estimateSec: 90,
    order: 19,
  },
  {
    id: "kotlin",
    name: "Kotlin",
    nameEn: "Kotlin",
    installCmd: `set +e
apt-get install -y kotlin 2>&1 || apt-get install -y kotlin-compiler 2>&1
if command -v kotlinc >/dev/null 2>&1; then
  kotlinc -version 2>&1 | head -1
  echo KOTLIN_OK
  exit 0
fi
if command -v kotlin >/dev/null 2>&1; then
  kotlin -version 2>&1 | head -1
  echo KOTLIN_OK
  exit 0
fi
echo KOTLIN_FAIL
exit 1`,
    checkCmd: "command -v kotlinc >/dev/null 2>&1 || command -v kotlin >/dev/null 2>&1",
    removeCmd: "apt-get remove -y kotlin kotlin-compiler 2>/dev/null; true",
    estimateSec: 60,
    order: 20,
  },
  {
    id: "python",
    name: "Python",
    nameEn: "Python",
    installCmd: "apt-get install -y python",
    checkCmd: "command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1",
    removeCmd: "apt-get remove -y python",
    estimateSec: 60,
    order: 21,
  },
  {
    id: "termux-api",
    name: "Termux API",
    nameEn: "Termux API",
    installCmd: "apt-get install -y termux-api",
    checkCmd: "command -v termux-battery-status >/dev/null 2>&1 || dpkg -s termux-api >/dev/null 2>&1",
    removeCmd: "apt-get remove -y termux-api",
    estimateSec: 30,
    order: 22,
  },
  {
    id: "aapt2",
    name: "AAPT / AAPT2",
    nameEn: "AAPT / AAPT2",
    installCmd: `set +e
# aapt/aapt2 + android-tools (часто даёт zipalign рядом с build-tools)
apt-get install -y aapt aapt2 2>&1
apt-get install -y android-tools 2>&1 || true
SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"
AAPT_TOOL=$(command -v aapt2 2>/dev/null)
if [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1; then echo AAPT_OK; exit 0; fi
AAPT_TOOL=$(command -v aapt 2>/dev/null)
if [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1; then echo AAPT_OK; exit 0; fi
AAPT_TOOL=$(find "\$SDK/build-tools" -type f -name aapt2 -print -quit 2>/dev/null)
if [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1; then echo AAPT_OK; exit 0; fi
AAPT_TOOL=$(find "\$SDK/build-tools" -type f -name aapt -print -quit 2>/dev/null)
if [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1; then echo AAPT_OK; exit 0; fi
echo AAPT_FAIL
exit 1`,
    checkCmd: `SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; AAPT_TOOL=$(command -v aapt2 2>/dev/null); if [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1; then exit 0; fi; AAPT_TOOL=$(command -v aapt 2>/dev/null); if [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1; then exit 0; fi; AAPT_TOOL=$(find "\$SDK/build-tools" -type f -name aapt2 -print -quit 2>/dev/null); if [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1; then exit 0; fi; AAPT_TOOL=$(find "\$SDK/build-tools" -type f -name aapt -print -quit 2>/dev/null); [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1`,
    removeCmd: "apt-get remove -y aapt aapt2 2>/dev/null; true",
    removeBlockedReason: "Пакеты aapt/aapt2 и android-tools общие с Android SDK и другими инструментами; безопасное удаление выполняется только владельцем среды.",
    estimateSec: 40,
    order: 23,
  },
  {
    id: "zipalign",
    name: "Zipalign",
    nameEn: "Zipalign",
    installCmd: `set +e
# zipalign обычно в android-tools или build-tools SDK; ставим оба пути
apt-get install -y android-tools 2>&1 || true
apt-get install -y aapt aapt2 2>&1 || true
if command -v zipalign >/dev/null 2>&1; then
  zipalign 2>&1 | head -1 || true
  echo ZIPALIGN_OK
  exit 0
fi
# иногда только в SDK build-tools
if find "$PREFIX" -name zipalign -type f 2>/dev/null | head -1 | grep -q .; then
  echo ZIPALIGN_OK
  exit 0
fi
if [ -n "$ANDROID_HOME" ] && find "$ANDROID_HOME/build-tools" -name zipalign -type f 2>/dev/null | head -1 | grep -q .; then
  echo ZIPALIGN_OK
  exit 0
fi
echo ZIPALIGN_FAIL
exit 1`,
    checkCmd: 'command -v zipalign >/dev/null 2>&1 || find "$PREFIX" -name zipalign -type f 2>/dev/null | head -1 | grep -q . || ([ -n "$ANDROID_HOME" ] && find "$ANDROID_HOME/build-tools" -name zipalign -type f 2>/dev/null | head -1 | grep -q .)',
    removeCmd: "true",
    removeBlockedReason: "Zipalign может быть частью android-tools/Android SDK и используется сборкой; карточка не удаляет общие SDK-зависимости.",
    estimateSec: 40,
    order: 24,
  },
  {
    id: "apksigner",
    name: "Apksigner",
    nameEn: "Apksigner",
    installCmd: `set +e
apt-get install -y apksigner 2>&1 || apt-get install -y android-tools 2>&1
if command -v apksigner >/dev/null 2>&1; then
  apksigner --version 2>&1 | head -1
  echo APKSIGNER_OK
  exit 0
fi
# иногда лежит только в SDK path
if find "$PREFIX" -name apksigner -type f 2>/dev/null | head -1 | grep -q .; then
  echo APKSIGNER_OK
  exit 0
fi
echo APKSIGNER_FAIL
exit 1`,
    checkCmd: "command -v apksigner >/dev/null 2>&1 || find \"$PREFIX\" -name apksigner -type f 2>/dev/null | head -1 | grep -q .",
    removeCmd: "apt-get remove -y apksigner 2>/dev/null; true",
    removeBlockedReason: "Apksigner может быть частью Android SDK/build-tools и используется сборкой; карточка не удаляет общие SDK-зависимости.",
    estimateSec: 40,
    order: 25,
  },
  {
    id: "platform-tools",
    name: "Platform-tools (adb)",
    nameEn: "Platform-tools (adb)",
    installCmd: `set +e
apt-get install -y android-tools 2>&1
PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"
# Проверяем наличие файла, не запуская adb: общий запуск ADB запрещён политикой безопасности.
if [ -x "$PREFIX/bin/adb" ] || [ -x /usr/bin/adb ] || dpkg -s android-tools >/dev/null 2>&1; then
  echo ADB_OK
  exit 0
fi
echo ADB_FAIL
exit 1`,
    checkCmd: `PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"; [ -x "$PREFIX/bin/adb" ] || [ -x /usr/bin/adb ] || dpkg -s android-tools >/dev/null 2>&1`,
    removeCmd: "apt-get remove -y android-tools 2>/dev/null; true",
    removeBlockedReason: "android-tools общий с Android SDK и reverse-инструментами; карточка не удаляет общий пакет.",
    estimateSec: 40,
    order: 26,
  },
  {
    id: "which",
    name: "which",
    nameEn: "which",
    // The shared installer wrapper owns the single strict apt update. Do not
    // change the user's source or report a fake which shim as an installation.
    installCmd: `set +e
export DEBIAN_FRONTEND=noninteractive
PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"
export PATH="\$PREFIX/bin:\$PATH"
if command -v which >/dev/null 2>&1; then
  echo WHICH_OK already
  which which 2>&1 | head -1
  exit 0
fi
if apt-get install -y which 2>&1 && command -v which >/dev/null 2>&1; then
  which which 2>&1 | head -1
  echo WHICH_OK
  exit 0
fi
if apt-get install -y debianutils 2>&1 && command -v which >/dev/null 2>&1; then
  which which 2>&1 | head -1
  echo WHICH_OK
  exit 0
fi
echo WHICH_FAIL
echo "Neither which nor debianutils provided the which command."
exit 1`,
    checkCmd: "command -v which >/dev/null 2>&1",
    removeCmd: `apt-get remove -y which 2>/dev/null; rm -f "\$PREFIX/bin/which"; true`,
    estimateSec: 45,
    order: 27,
  },
  {
    id: "ninja",
    name: "Ninja (CMake/native)",
    nameEn: "Ninja (CMake/native)",
    installCmd: `set +e
export DEBIAN_FRONTEND=noninteractive
PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"
export PATH="\$PREFIX/bin:\$PATH"
if command -v ninja >/dev/null 2>&1; then
  ninja --version 2>&1 | head -1
  echo NINJA_OK already
  exit 0
fi
for try in 1 2 3; do
  echo "NINJA_TRY_\$try"
  apt-get install -y ninja 2>&1 | tail -25
  if command -v ninja >/dev/null 2>&1; then
    ninja --version 2>&1 | head -1
    echo NINJA_OK
    exit 0
  fi
  apt-get install -y ninja 2>&1 | tail -20
  if command -v ninja >/dev/null 2>&1; then
    ninja --version 2>&1 | head -1
    echo NINJA_OK
    exit 0
  fi
  apt-get install -y ninja-build 2>&1 | tail -15
  if command -v ninja >/dev/null 2>&1; then
    ninja --version 2>&1 | head -1
    echo NINJA_OK
    exit 0
  fi
  sleep 2
done
# Официальные release ninja — в основном x86_64; на aarch64 нужен pkg/apt.
if command -v ninja >/dev/null 2>&1; then
  ninja --version 2>&1 | head -1
  echo NINJA_OK
  exit 0
fi
echo NINJA_FAIL
echo "apt-get could not install ninja; inspect the complete apt diagnostic above."
exit 1`,
    checkCmd: "command -v ninja >/dev/null 2>&1 && ninja --version >/dev/null 2>&1",
    removeCmd: `apt-get remove -y ninja ninja-build 2>/dev/null; rm -f "\$PREFIX/bin/ninja"; true`,
    estimateSec: 120,
    order: 28,
  },
  {
    id: "sdk-cmdline-tools",
    name: "SDK cmdline-tools (sdkmanager)",
    nameEn: "SDK cmdline-tools (sdkmanager)",
    installCmd: `set +e
PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"
SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"
if [ -L "$PREFIX/opt" ] || [ -L "\$SDK" ] || [ -L "\$SDK/cmdline-tools" ] || [ -L "\$SDK/cmdline-tools/latest" ] || [ -L "\$SDK/licenses" ]; then echo CMDLINE_PATH_SYMLINK_COLLISION; exit 1; fi
if [ -x "\$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  "\$SDK/cmdline-tools/latest/bin/sdkmanager" --version >/dev/null 2>&1 && { echo CMDLINE_OK already; exit 0; }
  if [ -f "\$SDK/cmdline-tools/latest/.aib-managed-by-ai-builder" ]; then
    for F in "\$SDK"/cmdline-tools/latest/bin/*; do [ -f "\$F" ] && sed -i "1s|^#!/usr/bin/env |#!\$PREFIX/bin/env |" "\$F"; done
    "\$SDK/cmdline-tools/latest/bin/sdkmanager" --version >/dev/null 2>&1 && { echo CMDLINE_OK repaired-shebang; exit 0; }
  fi
  echo CMDLINE_EXISTING_INSTALL_BROKEN; exit 1
fi
if [ -e "\$SDK/cmdline-tools/latest" ]; then echo CMDLINE_LATEST_EXISTS_NOT_OWNED; exit 1; fi
mkdir -p "\$SDK/cmdline-tools" "\$PREFIX/tmp" || { echo CMDLINE_PREFIX_TEMP_FAILED; exit 1; }
for TOOL in java curl unzip sha256sum; do command -v "\$TOOL" >/dev/null 2>&1 || { echo "CMDLINE_PREREQUISITE_MISSING \$TOOL"; exit 1; }; done
TMP=\$(mktemp "\$PREFIX/tmp/aib-cmdline-tools.XXXXXX") || { echo CMDLINE_TEMP_CREATE_FAILED; exit 1; }
EXTRACT_DIR=\$(mktemp -d "\$PREFIX/tmp/aib-cmdline-extract.XXXXXX") || { rm -f "\$TMP"; echo CMDLINE_TEMP_CREATE_FAILED; exit 1; }
STAGED_ROOT=\$(mktemp -d "\$SDK/cmdline-tools/.aib-latest.new.XXXXXX") || { rm -f "\$TMP"; rm -rf "\$EXTRACT_DIR"; echo CMDLINE_STAGE_CREATE_FAILED; exit 1; }
trap 'rm -f -- "\$TMP"; rm -rf -- "\$EXTRACT_DIR" "\$STAGED_ROOT"' EXIT
URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
EXPECT_SHA="2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258"
echo "CMDLINE_DL \$URL"
curl -fL --connect-timeout 30 --retry 2 --retry-delay 2 --max-time 600 -o "\$TMP" "\$URL"
DL_EC=\$?
SZ=\$(stat -c%s "\$TMP" 2>/dev/null || echo 0)
echo "CMDLINE_CURL_EC=\$DL_EC CMDLINE_SIZE=\$SZ"
if [ "\$DL_EC" -ne 0 ] || [ "\$SZ" -lt 1000000 ]; then echo CMDLINE_DOWNLOAD_OR_SIZE_FAILED; exit 1; fi
GOT_SHA=\$(sha256sum "\$TMP" | awk '{print \$1}')
echo "CMDLINE_SHA=\$GOT_SHA"
if [ "\$GOT_SHA" != "\$EXPECT_SHA" ]; then echo "CMDLINE_SHA_MISMATCH expected=\$EXPECT_SHA"; exit 1; fi
unzip -t "\$TMP" >"\$EXTRACT_DIR/zip-test.log" 2>&1
ZIP_TEST_EC=\$?
tail -5 "\$EXTRACT_DIR/zip-test.log"
if [ "\$ZIP_TEST_EC" -ne 0 ]; then echo "CMDLINE_ZIP_TEST_FAILED exit=\$ZIP_TEST_EC"; exit "\$ZIP_TEST_EC"; fi
unzip -q "\$TMP" -d "\$EXTRACT_DIR"
UNZIP_EC=\$?
if [ "\$UNZIP_EC" -ne 0 ] || [ ! -x "\$EXTRACT_DIR/cmdline-tools/bin/sdkmanager" ]; then echo "CMDLINE_EXTRACT_POSTCHECK_FAILED exit=\$UNZIP_EC"; exit 1; fi
for F in "\$EXTRACT_DIR"/cmdline-tools/bin/*; do [ -f "\$F" ] && sed -i "1s|^#!/usr/bin/env |#!\$PREFIX/bin/env |" "\$F"; done
mv "\$EXTRACT_DIR/cmdline-tools" "\$STAGED_ROOT/latest" || { echo CMDLINE_STAGE_MOVE_FAILED; exit 1; }
: > "\$STAGED_ROOT/latest/.aib-managed-by-ai-builder" || { echo CMDLINE_MARKER_WRITE_FAILED; exit 1; }
mkdir -p "\$SDK/licenses" || { echo CMDLINE_LICENSE_DIR_FAILED; exit 1; }
[ -f "\$SDK/licenses/android-sdk-license" ] || printf '%s\\n' '24333f8a63b6825ea9c5514f83c2829b004d1fee' > "\$SDK/licenses/android-sdk-license"
[ -f "\$SDK/licenses/android-sdk-preview-license" ] || printf '%s\\n' '84831b9409646a918e30573bab4c9c91346d8abd' > "\$SDK/licenses/android-sdk-preview-license"
"\$STAGED_ROOT/latest/bin/sdkmanager" --sdk_root="\$SDK" --version >"\$EXTRACT_DIR/sdkmanager-version.log" 2>&1
SM_EC=\$?
tail -2 "\$EXTRACT_DIR/sdkmanager-version.log"
if [ "\$SM_EC" -ne 0 ]; then echo "CMDLINE_SDKMANAGER_POSTCHECK_FAILED exit=\$SM_EC"; exit 1; fi
mv "\$STAGED_ROOT/latest" "\$SDK/cmdline-tools/latest" || { echo CMDLINE_COMMIT_FAILED; exit 1; }
echo CMDLINE_OK
exit 0`,
    checkCmd: `SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; [ -x "\$SDK/cmdline-tools/latest/bin/sdkmanager" ]`,
    removeCmd: `PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"; SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; if [ -L "$PREFIX/opt" ] || [ -L "\$SDK" ] || [ -L "\$SDK/cmdline-tools" ] || [ -L "\$SDK/cmdline-tools/latest" ]; then echo CMDLINE_PATH_SYMLINK_COLLISION >&2; exit 1; fi; if [ -f "\$SDK/cmdline-tools/latest/.aib-managed-by-ai-builder" ]; then rm -rf -- "\$SDK/cmdline-tools/latest"; rmdir "\$SDK/cmdline-tools" 2>/dev/null || true; else echo CMDLINE_NOT_APP_OWNED; exit 1; fi`,
    estimateSec: 180,
    order: 29,
  },
  {
    id: "android-platform-34",
    name: "Android Platform 34",
    nameEn: "Android Platform 34",
    installCmd: `set +e
PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"
SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"
if [ -L "$PREFIX/opt" ] || [ -L "$SDK" ] || [ -L "$SDK/platforms" ] || [ -L "$SDK/platforms/android-34" ] || [ -L "$SDK/licenses" ]; then echo PLATFORM34_PATH_SYMLINK_COLLISION; exit 1; fi
mkdir -p "\$SDK/platforms" "\$SDK/licenses"
printf '%s\\n' '24333f8a63b6825ea9c5514f83c2829b004d1fee' > "\$SDK/licenses/android-sdk-license"
printf '%s\\n' '84831b9409646a918e30573bab4c9c91346d8abd' > "\$SDK/licenses/android-sdk-preview-license"
if [ -f "\$SDK/platforms/android-34/android.jar" ]; then
  echo PLATFORM34_OK
  exit 0
fi
SM=""
for c in "\$SDK/cmdline-tools/latest/bin/sdkmanager" "\$PREFIX/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager" "\$PREFIX/bin/sdkmanager"; do
  [ -x "\$c" ] && SM="\$c" && break
done
if [ -n "\$SM" ]; then
  for F in "$(dirname "\$SM")"/*; do [ -f "\$F" ] && sed -i "1s|^#!/usr/bin/env |#!\$PREFIX/bin/env |" "\$F" 2>/dev/null; done
  export JAVA_HOME="\${JAVA_HOME:-\$PREFIX/lib/jvm/java-17-openjdk}"
  export PATH="\$JAVA_HOME/bin:\$PATH"
  yes 2>/dev/null | "\$SM" --sdk_root="\$SDK" "platforms;android-34" 2>&1 | tail -20
  if [ -f "\$SDK/platforms/android-34/android.jar" ]; then
    echo PLATFORM34_OK
    exit 0
  fi
fi
# Fail closed: SDK packages must be installed by sdkmanager, which validates the repository manifest.
echo "PLATFORM34_SDKMANAGER_REQUIRED"
echo "Install SDK cmdline-tools first, then retry Platform 34"
exit 1`,
    checkCmd: `SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; [ -f "\$SDK/platforms/android-34/android.jar" ]`,
    removeCmd: `PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"; SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; if [ -L "$PREFIX/opt" ] || [ -L "$SDK" ] || [ -L "$SDK/platforms" ] || [ -L "$SDK/platforms/android-34" ]; then echo PLATFORM34_PATH_SYMLINK_COLLISION >&2; exit 1; fi; echo PLATFORM34_SHARED_SDK_REMOVE_BLOCKED >&2; exit 64`,
    removeBlockedReason: "Android SDK platform packages may be shared by multiple projects; remove them through your SDK manager only when you have confirmed no project depends on this platform.",
    estimateSec: 180,
    order: 30,
  },
  {
    id: "android-platform-35",
    name: "Android Platform 35",
    nameEn: "Android Platform 35",
    installCmd: `set +e
PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"
SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"
if [ -L "$PREFIX/opt" ] || [ -L "$SDK" ] || [ -L "$SDK/platforms" ] || [ -L "$SDK/platforms/android-35" ] || [ -L "$SDK/licenses" ]; then echo PLATFORM35_PATH_SYMLINK_COLLISION; exit 1; fi
mkdir -p "\$SDK/platforms" "\$SDK/licenses"
printf '%s\\n' '24333f8a63b6825ea9c5514f83c2829b004d1fee' > "\$SDK/licenses/android-sdk-license"
printf '%s\\n' '84831b9409646a918e30573bab4c9c91346d8abd' > "\$SDK/licenses/android-sdk-preview-license"
if [ -f "\$SDK/platforms/android-35/android.jar" ]; then
  echo PLATFORM35_OK
  exit 0
fi
SM=""
for c in "\$SDK/cmdline-tools/latest/bin/sdkmanager" "\$PREFIX/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager" "\$PREFIX/bin/sdkmanager"; do
  [ -x "\$c" ] && SM="\$c" && break
done
if [ -n "\$SM" ]; then
  for F in "$(dirname "\$SM")"/*; do [ -f "\$F" ] && sed -i "1s|^#!/usr/bin/env |#!\$PREFIX/bin/env |" "\$F" 2>/dev/null; done
  export JAVA_HOME="\${JAVA_HOME:-\$PREFIX/lib/jvm/java-17-openjdk}"
  export PATH="\$JAVA_HOME/bin:\$PATH"
  yes 2>/dev/null | "\$SM" --sdk_root="\$SDK" "platforms;android-35" 2>&1 | tail -20
  if [ -f "\$SDK/platforms/android-35/android.jar" ]; then
    echo PLATFORM35_OK
    exit 0
  fi
fi
# Fail closed: SDK packages must be installed by sdkmanager, which validates the repository manifest.
echo "PLATFORM35_SDKMANAGER_REQUIRED"
echo "Install SDK cmdline-tools first, then retry Platform 35"
exit 1`,
    checkCmd: `SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; [ -f "\$SDK/platforms/android-35/android.jar" ]`,
    removeCmd: `PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"; SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; if [ -L "$PREFIX/opt" ] || [ -L "$SDK" ] || [ -L "$SDK/platforms" ] || [ -L "$SDK/platforms/android-35" ]; then echo PLATFORM35_PATH_SYMLINK_COLLISION >&2; exit 1; fi; echo PLATFORM35_SHARED_SDK_REMOVE_BLOCKED >&2; exit 64`,
    removeBlockedReason: "Android SDK platform packages may be shared by multiple projects; remove them through your SDK manager only when you have confirmed no project depends on this platform.",
    estimateSec: 180,
    order: 31,
  },
  {
    id: "proot-distro",
    name: "proot-distro",
    nameEn: "proot-distro",
    installCmd: `set -e
set -o pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v proot-distro >/dev/null 2>&1; then
  proot-distro --help >/dev/null 2>&1 || true
  echo PROOT_DISTRO_OK
  exit 0
fi
apt-get install -y proot-distro 2>&1
command -v proot-distro >/dev/null 2>&1
echo PROOT_DISTRO_OK
exit 0`,
    checkCmd: `command -v proot-distro >/dev/null 2>&1`,
    removeCmd: `apt-get remove -y proot-distro 2>/dev/null; true`,
    estimateSec: 90,
    order: 32,
  },
  {
    id: "debian-rootfs",
    name: "Debian rootfs",
    nameEn: "Debian rootfs",
    installCmd: buildProotDistroRootfsInstallCommand("debian"),
    checkCmd: buildProotDistroRootfsCheckCommand("debian"),
    removeCmd: buildProotDistroRemoveGuardCommand("debian"),
    estimateSec: 900,
    order: 33,
    timeoutMs: 45 * 60 * 1000,
  },

  {
    id: "ubuntu-rootfs",
    name: "Ubuntu rootfs",
    nameEn: "Ubuntu rootfs",
    installCmd: buildProotDistroRootfsInstallCommand("ubuntu"),
    checkCmd: buildProotDistroRootfsCheckCommand("ubuntu"),
    removeCmd: buildProotDistroRemoveGuardCommand("ubuntu"),
    estimateSec: 900,
    order: 34,
    timeoutMs: 45 * 60 * 1000,
  },

];

/** Termux host tools shown in the right sidebar; distro rootfs setup is elsewhere. */
export const RIGHT_MENU_COMPILE_PACKAGES: CompilePackageDef[] = COMPILE_PACKAGES.filter((def) =>
  isRightPackageMenuPackage(def.id),
);

const STORAGE_KEY = "aibuilder.compile_packages.installed.v1";

function installedMapKey(backend: AgentShellBackend): string {
  return backend === "termux" ? STORAGE_KEY : `${STORAGE_KEY}.${backend}`;
}

export type PackageStatus = "unknown" | "missing" | "installed" | "installing" | "removing" | "error" | "blocked" | "checking";

export interface PackageRuntimeState {
  status: PackageStatus;
  progress: number; // 0–100
  detail?: string;
  lastError?: string;
}

const DEFAULT_STATE: PackageRuntimeState = {
  status: "unknown",
  progress: 0,
};

/** Долгий таймаут для apt-get install -y (сеть + распаковка). */
const INSTALL_TIMEOUT_MS = 900_000; // 15 мин
const CHECK_TIMEOUT_MS = 25_000;
const ROOTFS_CHECK_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 180_000;
function packageCheckTimeoutMs(def: CompilePackageDef): number {
  return def.id === "debian-rootfs" || def.id === "ubuntu-rootfs" ? ROOTFS_CHECK_TIMEOUT_MS : CHECK_TIMEOUT_MS;
}

export async function loadInstalledMap(backend: AgentShellBackend = getBuildBackend()): Promise<Record<string, boolean>> {
  try {
    const raw = await AsyncStorage.getItem(installedMapKey(backend));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveInstalledMap(map: Record<string, boolean>, backend: AgentShellBackend = getBuildBackend()) {
  try {
    await AsyncStorage.setItem(installedMapKey(backend), JSON.stringify(map));
  } catch (e) {
    persistentLogger.add("warn", "CompilePackages", `saveInstalledMap failed: ${e}`);
  }
}

/**
 * Проверка одного пакета в Termux.
 * Возвращает true если checkCmd exit 0.
 */
export async function verifyPackageInstalled(
  def: CompilePackageDef,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<boolean> {
  const result = await checkPackageInstalled(def, selectedBackend);
  return result.status === "installed";
}

export async function checkPackageInstalled(
  def: CompilePackageDef,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<PackageCheckOutcome> {
  return checkPackageCommand(() =>
    runPackageCommand(def.checkCmd, { timeoutMs: packageCheckTimeoutMs(def), kind: "check", packageId: def.id, selectedBackend })
  );
}

/**
 * Verify every compile card at its resolved host/guest target. Errors remain
 * errors even when a previous installed-state hint exists in AsyncStorage.
 */
export async function verifyAllPackages(
  onUpdate?: (id: CompilePkgId, result: PackageCheckOutcome) => void,
  options: {
    selectedBackend?: AgentShellBackend;
    onStart?: (id: CompilePkgId) => void;
    shouldContinue?: () => boolean;
    definitions?: readonly CompilePackageDef[];
  } = {},
): Promise<Record<CompilePkgId, PackageCheckOutcome>> {
  const selectedBackend = options.selectedBackend ?? getBuildBackend();
  const checks = await scanPackageCatalog(
    options.definitions ?? COMPILE_PACKAGES,
    (def) => checkPackageInstalled(def, selectedBackend),
    {
      onStart: (id) => options.onStart?.(id),
      onResult: (id, check) => onUpdate?.(id, check),
      shouldContinue: options.shouldContinue,
      delayMs: 80,
    } satisfies PackageScanHooks<CompilePkgId>,
  );
  const cached = await loadInstalledMap(selectedBackend);
  await saveInstalledMap(mergeSuccessfulPackageChecksIntoCache(cached, checks), selectedBackend);
  return checks as Record<CompilePkgId, PackageCheckOutcome>;
}

/**
 * Установка одного пакета с прогрессом.
 * Этапы: подготовка → update+install → контрольная проверка → 100%.
 */
export async function installCompilePackage(
  def: CompilePackageDef,
  onProgress: (p: number, detail: string) => void,
  shouldAbort?: () => boolean,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<{ ok: boolean; error?: string }> {
  // Only packages from the static catalog may be installed (no free-form cmds)
  if (!COMPILE_PACKAGES.some((p) => p.id === def.id && p.installCmd === def.installCmd)) {
    return { ok: false, error: "PACKAGE_NOT_IN_CATALOG" };
  }
  const tag = `CompilePkg:${def.id}`;

  const tick = (p: number, detail: string) => {
    if (shouldAbort?.()) return;
    onProgress(Math.min(99, Math.max(0, p)), detail);
  };

  try {
    if (def.id === "debian-rootfs" || def.id === "ubuntu-rootfs") {
      const alias = def.id === "debian-rootfs" ? "debian" : "ubuntu";
      const bootstrap = await installProotDistroRootfsWithPrerequisite(
        alias,
        (command, runOptions) => runPackageCommand(command, { ...runOptions, selectedBackend }),
        tick,
        () => shouldAbort?.() === true,
        (level, message) => persistentLogger.add(level, `CompilePkg:${def.id}`, message),
      );
      if (!bootstrap.ok) return bootstrap;
      if (shouldAbort?.()) return { ok: false, error: "aborted" };
      const finalCheck = await checkPackageInstalled(def, selectedBackend);
      if (finalCheck.status !== "installed") {
        const reason = finalCheck.status === "error" ? finalCheck.detail : "rootfs is not healthy after install";
        persistentLogger.add("error", tag, `AIB_ROOTFS_BOOTSTRAP alias=${alias} phase=final-check result=unconfirmed reason=${reason}`);
        return { ok: false, error: `ROOTFS_FINAL_VERIFICATION_FAILED: ${reason}` };
      }
      const map = await loadInstalledMap(selectedBackend);
      map[def.id] = true;
      await saveInstalledMap(map, selectedBackend);
      tick(100, `${alias} rootfs установлен и прошёл проверку входа`);
      persistentLogger.add("info", tag, `AIB_ROOTFS_BOOTSTRAP alias=${alias} phase=complete result=healthy-login-confirmed`);
      return { ok: true };
    }

    // Зависимости: платформы SDK ставятся только через sdkmanager (cmdline-tools).
    const prerequisiteId = COMPILE_PACKAGE_PREREQUISITES[def.id];
    if (prerequisiteId) {
      const prerequisite = COMPILE_PACKAGES.find((p) => p.id === prerequisiteId);
      if (prerequisite) {
        tick(0, `Проверка зависимости: ${prerequisite.name}…`);
        const prerequisiteCheck = await checkPackageInstalled(prerequisite, selectedBackend);
        if (shouldAbort?.()) return { ok: false, error: "aborted" };
        if (prerequisiteCheck.status !== "installed") {
          tick(0, `Сначала устанавливаю ${prerequisite.name}…`);
          const prerequisiteResult = await installCompilePackage(
            prerequisite,
            (p, detail) => tick(Math.round(p / 2), `${prerequisite.name}: ${detail}`),
            shouldAbort,
            selectedBackend,
          );
          if (!prerequisiteResult.ok) {
            if (prerequisiteResult.error === "aborted") return prerequisiteResult;
            return {
              ok: false,
              error: `Не удалось установить зависимость ${prerequisite.name}: ${prerequisiteResult.error || "ошибка"}`,
            };
          }
        }
      }
    }

    tick(0, "Подготовка…");
    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    const preInstallCmd = COMPILE_PACKAGE_PRE_INSTALL[def.id];
    if (preInstallCmd) {
      tick(0, "Установка зависимостей (curl, unzip, Java)…");
      let preResult: TermuxCommandResult | null = null;
      try {
        preResult = await runPackageCommand(preInstallCmd, {
          timeoutMs: INSTALL_TIMEOUT_MS,
          isBuild: true,
          kind: "install",
          packageId: def.id,
          selectedBackend,
        });
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (shouldAbort?.()) return { ok: false, error: "aborted" };
      if (!preResult || preResult.timedOut || preResult.exitCode !== 0) {
        tick(0, "Ошибка");
        return {
          ok: false,
          error: preResult ? formatPackageInstallFailure(preResult) : "dependencies install failed",
        };
      }
    }

    // withInstallerEnvironment performs the single apt update and preserves its
    // detailed failure output before allowing the install command to run.
    tick(0, "Проверка источников Termux…");
    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    tick(0, `Обновление индексов и установка ${def.name}…`);
    let installResult: TermuxCommandResult | null = null;
    let installError: string | undefined;
    const runInstallCommand = () => {
      const execute = () => runPackageCommand(def.installCmd, {
        timeoutMs: typeof def.timeoutMs === "number" && def.timeoutMs > 0 ? def.timeoutMs : INSTALL_TIMEOUT_MS,
        isBuild: true,
        kind: "install",
        packageId: def.id,
        selectedBackend,
      });
      return def.id === "proot-distro" ? withProotDistroHostToolLock(execute) : execute();
    };

    try {
      installResult = await runInstallCommand();
    } catch (e: unknown) {
      installError = e instanceof Error ? e.message : String(e);
    }

    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    // Retry once only for a concrete source/network failure during installation.
    if (
      !installError &&
      installResult &&
      !installResult.timedOut &&
      isPkgMirrorFailure(installResult)
    ) {
      tick(0, "Временная ошибка источника — один повтор с обновлением индексов…");
      if (shouldAbort?.()) return { ok: false, error: "aborted" };
      tick(0, `Повторная установка ${def.name}…`);
      try {
        installResult = await runInstallCommand();
        installError = undefined;
      } catch (e: unknown) {
        installError = e instanceof Error ? e.message : String(e);
      }
      if (shouldAbort?.()) return { ok: false, error: "aborted" };
    }

    if (installError) {
      tick(0, "Ошибка");
      return { ok: false, error: installError };
    }

    if (!installResult || installResult.timedOut) {
      tick(0, "Таймаут");
      return { ok: false, error: "timeout" };
    }

    // pkg иногда возвращает non-zero при warning — проверяем реально
    tick(0, "Проверка установки…");
    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    const verification = await checkPackageInstalled(def, selectedBackend);
    const verified = verification.status === "installed";
    if (installResult.exitCode === 0 && !installResult.timedOut && verified) {
      tick(100, "Установлено");
      const map = await loadInstalledMap(selectedBackend);
      map[def.id] = true;
      await saveInstalledMap(map, selectedBackend);
      return { ok: true };
    }

    // Any failed apt preflight/install remains a failure; show both captured streams.
    tick(0, "Не удалось подтвердить");
    return {
      ok: false,
      error: formatPackageInstallFailure(
        installResult,
        verification.status === "error" ? verification.detail : undefined,
      ),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    persistentLogger.add("error", tag, msg);
    onProgress(0, "Ошибка");
    return { ok: false, error: msg };
  }
}

/**
 * Удаление пакета.
 */
export async function removeCompilePackage(
  def: CompilePackageDef,
  onProgress: (p: number, detail: string) => void,
  shouldAbort?: () => boolean,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<{ ok: boolean; error?: string }> {
  const tag = `CompilePkg:${def.id}`;
  if (def.removeBlockedReason) {
    return { ok: false, error: `REMOVE_BLOCKED: ${def.removeBlockedReason}` };
  }
  if (def.id === "debian-rootfs" || def.id === "ubuntu-rootfs") {
    return { ok: false, error: "ROOTFS_PRESERVED: rootfs removal is disabled here; this action will not delete a manually installed Termux distro" };
  }
  try {
    onProgress(0, "Удаление…");
    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    const r = await runPackageCommand(def.removeCmd, {
      timeoutMs: REMOVE_TIMEOUT_MS,
      isBuild: true,
      kind: "remove",
      packageId: def.id,
      selectedBackend,
    });

    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    onProgress(0, "Проверка…");

    const verification = await checkPackageInstalled(def, selectedBackend);
    if (verification.status === "error") {
      return { ok: false, error: `PACKAGE_CHECK_INCONCLUSIVE:${verification.detail}` };
    }
    const stillThere = verification.status === "installed";
    if (!stillThere) {
      onProgress(100, "Удалено");
      const map = await loadInstalledMap(selectedBackend);
      map[def.id] = false;
      await saveInstalledMap(map, selectedBackend);
      return { ok: true };
    }

    // Раньше soft-ok помечал «удалено» даже если check всё ещё true — ложный индикатор.
    // Теперь только реальный verify=false считается удалением.
    if (r.exitCode === 0 && !r.timedOut && stillThere) {
      return {
        ok: false,
        error: "uninstall exit 0, but verify still detects the package",
      };
    }

    return {
      ok: false,
      error: r.timedOut ? "timeout" : `exit ${r.exitCode}`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    persistentLogger.add("error", tag, msg);
    onProgress(0, "Ошибка");
    return { ok: false, error: msg };
  }
}
