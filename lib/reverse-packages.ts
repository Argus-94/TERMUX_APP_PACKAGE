/**
 * Пакеты для реверс-инжиниринга APK в Termux.
 * Структура зеркалит compile-packages.ts — те же install/check/remove.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { type TermuxCommandResult } from "./termux-bridge";
import { runPackageCommand } from "./package-backend";
import { persistentLogger } from "./persistent-logger";
import { isPkgMirrorFailure } from "./termux-installer-env";
import { checkPackageCommand, type PackageCheckOutcome } from "./package-check-outcome";
import { formatPackageInstallFailure } from "./package-install-diagnostics";
import { getBuildBackend, type AgentShellBackend } from "./agent-shell-backend";
import { mergeSuccessfulPackageChecksIntoCache, scanPackageCatalog, type PackageScanHooks } from "./package-catalog-scan";

export type ReversePkgId =
  | "smali"
  | "radare2"
  | "aapt"
  | "aapt2"
  | "zipalign"
  | "apksigner"
  | "openssl"
  | "binutils"
  | "strace"
  | "ltrace"
  | "gdb"
  | "android-tools"
  | "frida-tools"
  | "androguard"
  | "apkleaks"
  | "jadx"
  | "objection"
  | "mitmproxy"
  | "capstone";

export interface ReversePackageDef {
  id: ReversePkgId;
  name: string;
  nameEn: string;
  installCmd: string;
  checkCmd: string;
  removeCmd: string;
  estimateSec: number;
  order: number;
  /** Packages shared with compile/build entries must not be removed per-card. */
  removeBlockedReason?: string;
  /** true = установка намеренно отключена (нет pin SHA / pip). UI не должен показывать «Установить» как рабочее. */
  blocked?: boolean;
  blockedReason?: string;
}

/**
 * Optional reverse-tool downloads remain fail-closed until each artifact and
 * its complete dependency graph can be verified against immutable SHA-256 pins.
 */
export const REVERSE_PACKAGES: ReversePackageDef[] = [
  {
    id: "openssl",
    name: "OpenSSL",
    nameEn: "OpenSSL",
    installCmd: `set +e
apt-get install -y openssl openssl-tool 2>&1
if command -v openssl >/dev/null 2>&1; then
  openssl version 2>&1 | head -1
  echo OPENSSL_OK
  exit 0
fi
# уже может быть как зависимость curl
if [ -x "$PREFIX/bin/openssl" ]; then
  echo OPENSSL_OK
  exit 0
fi
echo OPENSSL_FAIL
exit 1`,
    checkCmd: 'command -v openssl >/dev/null 2>&1 || [ -x "$PREFIX/bin/openssl" ]',
    removeCmd: "apt-get remove -y openssl openssl-tool 2>/dev/null; true",
    estimateSec: 25,
    order: 1,
  },
  {
    id: "binutils",
    name: "Binutils (objdump/readelf)",
    nameEn: "Binutils (objdump/readelf)",
    installCmd: "apt-get install -y binutils",
    checkCmd: "command -v objdump >/dev/null 2>&1 && command -v readelf >/dev/null 2>&1",
    removeCmd: "apt-get remove -y binutils",
    estimateSec: 40,
    order: 2,
  },
  {
    id: "android-tools",
    name: "Android Tools (adb)",
    nameEn: "Android Tools (adb)",
    installCmd: "apt-get install -y android-tools",
    checkCmd: `PREFIX="\${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"; [ -x "$PREFIX/bin/adb" ] || [ -x /usr/bin/adb ] || dpkg -s android-tools >/dev/null 2>&1`,
    removeCmd: "apt-get remove -y android-tools",
    removeBlockedReason: "android-tools общий с Android SDK, platform-tools и другими карточками; индивидуальное удаление может сломать их.",
    estimateSec: 40,
    order: 3,
  },
  {
    id: "aapt",
    name: "AAPT",
    nameEn: "AAPT",
    installCmd: "apt-get install -y aapt",
    checkCmd: `SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; AAPT_TOOL=$(command -v aapt 2>/dev/null); if [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1; then exit 0; fi; AAPT_TOOL=$(find "\$SDK/build-tools" -type f -name aapt -print -quit 2>/dev/null); [ -n "\$AAPT_TOOL" ] && "\$AAPT_TOOL" version >/dev/null 2>&1`,
    removeCmd: "apt-get remove -y aapt",
    removeBlockedReason: "aapt используется Android SDK и карточкой AAPT/AAPT2; индивидуальное удаление небезопасно.",
    estimateSec: 25,
    order: 4,
  },
  {
    id: "aapt2",
    name: "AAPT2",
    nameEn: "AAPT2",
    installCmd: "apt-get install -y aapt2",
    checkCmd: `SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; AAPT2_TOOL=$(command -v aapt2 2>/dev/null); if [ -n "\$AAPT2_TOOL" ] && "\$AAPT2_TOOL" version >/dev/null 2>&1; then exit 0; fi; AAPT2_TOOL=$(find "\$SDK/build-tools" -type f -name aapt2 -print -quit 2>/dev/null); [ -n "\$AAPT2_TOOL" ] && "\$AAPT2_TOOL" version >/dev/null 2>&1`,
    removeCmd: "apt-get remove -y aapt2",
    removeBlockedReason: "aapt2 используется Android SDK и карточкой AAPT/AAPT2; индивидуальное удаление небезопасно.",
    estimateSec: 25,
    order: 5,
  },
  {
    id: "zipalign",
    name: "Zipalign",
    nameEn: "Zipalign",
    installCmd: "apt-get install -y zipalign",
    checkCmd: `SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; (command -v zipalign >/dev/null 2>&1 || find "\$SDK/build-tools" -type f -name zipalign -print -quit 2>/dev/null | grep -q .)`,
    removeCmd: "apt-get remove -y zipalign",
    removeBlockedReason: "zipalign может быть общим Android SDK/build-tools компонентом и используется сборкой.",
    estimateSec: 15,
    order: 6,
  },
  {
    id: "apksigner",
    name: "Apksigner",
    nameEn: "Apksigner",
    installCmd: "apt-get install -y apksigner",
    checkCmd: `SDK="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-\$PREFIX/opt/android-sdk}}"; (command -v apksigner >/dev/null 2>&1 || find "\$SDK/build-tools" -type f -name apksigner -print -quit 2>/dev/null | grep -q .)`,
    removeCmd: "apt-get remove -y apksigner",
    removeBlockedReason: "apksigner может быть общим Android SDK/build-tools компонентом и используется сборкой.",
    estimateSec: 20,
    order: 7,
  },
  {
    id: "smali",
    name: "Smali / Baksmali",
    nameEn: "Smali / Baksmali",
    installCmd: "echo SMALI_INSTALL_DISABLED_SHA256_REQUIRED >&2; exit 1",
    blocked: true,
    blockedReason: "Автоустановка отключена: для Smali/Baksmali отсутствует проверенный SHA-256 (release 3.0.10 фиксирует только версию, а не контрольную сумму). Automatic install remains disabled until immutable SHA-256 verification is implemented.",
    checkCmd: "command -v smali >/dev/null 2>&1 || command -v baksmali >/dev/null 2>&1",
    removeCmd: `rm -f "$PREFIX/bin/smali" "$PREFIX/bin/baksmali"; rm -rf "$PREFIX/opt/smali"`,
    estimateSec: 90,
    order: 9,
  },
  {
    id: "jadx",
    name: "JADX",
    nameEn: "JADX",
    installCmd: "apt-get install -y jadx",
    checkCmd: "command -v jadx >/dev/null 2>&1 || command -v jadx-cli >/dev/null 2>&1",
    removeCmd: "apt-get remove -y jadx",
    estimateSec: 50,
    order: 10,
  },
  {
    id: "radare2",
    name: "Radare2",
    nameEn: "Radare2",
    installCmd: "apt-get install -y radare2",
    checkCmd: "command -v r2 >/dev/null 2>&1 || command -v radare2 >/dev/null 2>&1",
    removeCmd: "apt-get remove -y radare2",
    estimateSec: 90,
    order: 11,
  },
  {
    id: "strace",
    name: "Strace",
    nameEn: "Strace",
    installCmd: "apt-get install -y strace",
    checkCmd: "command -v strace >/dev/null 2>&1",
    removeCmd: "apt-get remove -y strace",
    estimateSec: 20,
    order: 12,
  },
  {
    id: "ltrace",
    name: "Ltrace",
    nameEn: "Ltrace",
    installCmd: "apt-get install -y ltrace",
    checkCmd: "command -v ltrace >/dev/null 2>&1",
    removeCmd: "apt-get remove -y ltrace",
    estimateSec: 20,
    order: 13,
  },
  {
    id: "gdb",
    name: "GDB",
    nameEn: "GDB",
    installCmd: "apt-get install -y gdb",
    checkCmd: "command -v gdb >/dev/null 2>&1",
    removeCmd: "apt-get remove -y gdb",
    estimateSec: 60,
    order: 14,
  },
  {
    id: "frida-tools",
    name: "Frida Tools",
    nameEn: "Frida Tools",
    installCmd: `set +e
apt-get install -y root-repo 2>&1 | tail -3
apt-get install -y frida 2>&1
# CLI may be absent; server/inject is enough for device-side
if command -v frida >/dev/null 2>&1 || command -v frida-server >/dev/null 2>&1 || command -v frida-inject >/dev/null 2>&1; then
  frida-server --version 2>&1 | head -1 || frida --version 2>&1 | head -1 || true
  echo FRIDA_OK
  exit 0
fi
echo FRIDA_FAIL
exit 1`,
    checkCmd: `command -v frida >/dev/null 2>&1 || command -v frida-server >/dev/null 2>&1 || command -v frida-inject >/dev/null 2>&1`,
    removeCmd: "apt-get remove -y frida frida-server 2>/dev/null; true",
    estimateSec: 90,
    order: 15,
  },
  {
    id: "capstone",
    name: "Capstone",
    nameEn: "Capstone",
    installCmd: "apt-get install -y capstone",
    checkCmd: "command -v cstool >/dev/null 2>&1 || (command -v python >/dev/null 2>&1 && python -c 'import capstone' 2>/dev/null)",
    removeCmd: "apt-get remove -y capstone",
    estimateSec: 40,
    order: 16,
  },
  {
    id: "androguard",
    name: "Androguard",
    nameEn: "Androguard",
    installCmd: "echo PYPI_INSTALL_DISABLED_INTEGRITY_PIN_REQUIRED >&2; exit 1",
    blocked: true,
    blockedReason: "Автоустановка отключена: pip versions and dependency resolution are not pinned and hash-verified. Re-enable only through a separately verified SHA-256-pinned tool-pack.",
    checkCmd: "python -c 'import androguard' 2>/dev/null || command -v androguard >/dev/null 2>&1",
    removeCmd: "pip uninstall -y androguard 2>/dev/null; true",
    estimateSec: 300,
    order: 17,
  },
  {
    id: "apkleaks",
    name: "APKLeaks",
    nameEn: "APKLeaks",
    installCmd: "echo PYPI_INSTALL_DISABLED_INTEGRITY_PIN_REQUIRED >&2; exit 1",
    blocked: true,
    blockedReason: "Автоустановка отключена: pip versions and dependency resolution are not pinned and hash-verified. Re-enable only through a separately verified SHA-256-pinned tool-pack.",
    checkCmd: "command -v apkleaks >/dev/null 2>&1 || python -c 'import apkleaks' 2>/dev/null",
    removeCmd: "pip uninstall -y apkleaks 2>/dev/null; true",
    estimateSec: 300,
    order: 18,
  },
  {
    id: "objection",
    name: "Objection",
    nameEn: "Objection",
    installCmd: "echo PYPI_INSTALL_DISABLED_INTEGRITY_PIN_REQUIRED >&2; exit 1",
    blocked: true,
    blockedReason: "Автоустановка отключена: pip versions and dependency resolution are not pinned and hash-verified. Re-enable only through a separately verified SHA-256-pinned tool-pack.",
    checkCmd: "command -v objection >/dev/null 2>&1",
    removeCmd: "pip uninstall -y objection 2>/dev/null; true",
    estimateSec: 300,
    order: 19,
  },
  {
    id: "mitmproxy",
    name: "mitmproxy",
    nameEn: "mitmproxy",
    installCmd: "echo PYPI_INSTALL_DISABLED_INTEGRITY_PIN_REQUIRED >&2; exit 1",
    blocked: true,
    blockedReason: "Автоустановка отключена: pip versions and dependency resolution are not pinned and hash-verified. Re-enable only through a separately verified SHA-256-pinned tool-pack.",
    checkCmd: "command -v mitmproxy >/dev/null 2>&1 || command -v mitmdump >/dev/null 2>&1",
    removeCmd: "pip uninstall -y mitmproxy 2>/dev/null; true",
    estimateSec: 300,
    order: 20,
  },

];

const STORAGE_KEY = "aibuilder.reverse_packages.installed.v1";

function installedMapKey(backend: AgentShellBackend): string {
  return backend === "termux" ? STORAGE_KEY : `${STORAGE_KEY}.${backend}`;
}

export type PackageStatus = "unknown" | "missing" | "installed" | "installing" | "removing" | "error" | "blocked" | "checking";

export interface PackageRuntimeState {
  status: PackageStatus;
  progress: number;
  detail?: string;
  lastError?: string;
}

const INSTALL_TIMEOUT_MS = 900_000;
const CHECK_TIMEOUT_MS = 25_000;
const REMOVE_TIMEOUT_MS = 180_000;

export async function loadReverseInstalledMap(backend: AgentShellBackend = getBuildBackend()): Promise<Record<string, boolean>> {
  try {
    const raw = await AsyncStorage.getItem(installedMapKey(backend));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function saveReverseInstalledMap(map: Record<string, boolean>, backend: AgentShellBackend = getBuildBackend()) {
  try {
    await AsyncStorage.setItem(installedMapKey(backend), JSON.stringify(map));
  } catch {}
}

export async function verifyReversePackageInstalled(
  def: ReversePackageDef,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<boolean> {
  return (await checkReversePackageInstalled(def, selectedBackend)).status === "installed";
}

export async function checkReversePackageInstalled(
  def: ReversePackageDef,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<PackageCheckOutcome> {
  return checkPackageCommand(() =>
    runPackageCommand(def.checkCmd, { timeoutMs: CHECK_TIMEOUT_MS, kind: "check", packageId: def.id, selectedBackend })
  );
}

export async function verifyAllReversePackages(
  onUpdate?: (id: string, result: PackageCheckOutcome) => void,
  options: {
    selectedBackend?: AgentShellBackend;
    onStart?: (id: string) => void;
    shouldContinue?: () => boolean;
    definitions?: readonly ReversePackageDef[];
  } = {},
): Promise<Record<string, PackageCheckOutcome>> {
  const selectedBackend = options.selectedBackend ?? getBuildBackend();
  const checks = await scanPackageCatalog(
    options.definitions ?? REVERSE_PACKAGES,
    (def) => checkReversePackageInstalled(def, selectedBackend),
    {
      onStart: (id) => options.onStart?.(id),
      onResult: (id, check) => onUpdate?.(id, check),
      shouldContinue: options.shouldContinue,
      delayMs: 80,
    } satisfies PackageScanHooks<string>,
  );
  const cached = await loadReverseInstalledMap(selectedBackend);
  await saveReverseInstalledMap(mergeSuccessfulPackageChecksIntoCache(cached, checks), selectedBackend);
  return checks;
}

export async function installReversePackage(
  def: ReversePackageDef,
  onProgress: (p: number, detail: string) => void,
  shouldAbort?: () => boolean,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<{ ok: boolean; error?: string }> {
  const tag = `ReversePkg:${def.id}`;
  const tick = (p: number, detail: string) => {
    if (shouldAbort?.()) return;
    onProgress(Math.min(99, Math.max(0, p)), detail);
  };

  try {
    // Заблокированные pip-инструменты: не гоняем pkg update и не врём прогрессом.
    if (def.blocked) {
      const reason = def.blockedReason || "установка отключена (нет integrity pin)";
      tick(0, "Заблокировано");
      return { ok: false, error: `BLOCKED: ${reason}` };
    }

    tick(0, "Подготовка…");
    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    if (shouldAbort?.()) return { ok: false, error: "aborted" };
    tick(0, `Установка ${def.name}…`);
    let installResult: TermuxCommandResult | null = null;
    let installError: string | undefined;

    try {
      installResult = await runPackageCommand(def.installCmd, {
        timeoutMs: INSTALL_TIMEOUT_MS,
        isBuild: true,
        kind: "install",
        packageId: def.id,
        selectedBackend,
      });
    } catch (e: unknown) {
      installError = e instanceof Error ? e.message : String(e);
    }

    if (shouldAbort?.()) return { ok: false, error: "aborted" };

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
        installResult = await runPackageCommand(def.installCmd, {
          timeoutMs: INSTALL_TIMEOUT_MS,
          isBuild: true,
          kind: "install",
          packageId: def.id,
          selectedBackend,
        });
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

    tick(0, "Проверка установки…");
    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    const verification = await checkReversePackageInstalled(def, selectedBackend);
    const verified = verification.status === "installed";
    if (installResult.exitCode === 0 && !installResult.timedOut && verified) {
      tick(100, "Установлено");
      const map = await loadReverseInstalledMap(selectedBackend);
      map[def.id] = true;
      await saveReverseInstalledMap(map, selectedBackend);
      return { ok: true };
    }

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

export async function removeReversePackage(
  def: ReversePackageDef,
  onProgress: (p: number, detail: string) => void,
  shouldAbort?: () => boolean,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<{ ok: boolean; error?: string }> {
  const tag = `ReversePkg:${def.id}`;
  if (def.removeBlockedReason) {
    return { ok: false, error: `REMOVE_BLOCKED: ${def.removeBlockedReason}` };
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

    const verification = await checkReversePackageInstalled(def, selectedBackend);
    if (verification.status === "error") {
      return { ok: false, error: `PACKAGE_CHECK_INCONCLUSIVE:${verification.detail}` };
    }
    const stillThere = verification.status === "installed";
    if (!stillThere) {
      onProgress(100, "Удалено");
      const map = await loadReverseInstalledMap(selectedBackend);
      map[def.id] = false;
      await saveReverseInstalledMap(map, selectedBackend);
      return { ok: true };
    }

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
