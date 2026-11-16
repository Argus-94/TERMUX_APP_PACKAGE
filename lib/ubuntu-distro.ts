/**
 * Ubuntu (proot-distro) install / presence checks.
 * Ubuntu proot-distro profile for APK builds inside Ubuntu userspace.
 */
import { executeGuardedTermuxCommand } from "./termux-executor";
import { withForegroundTask } from "./foreground-task";
import { inspectTermuxProotDistro, withProotDistroInstallLock } from "./proot-distro-inspector";
import { buildProotDistroRestoreCommand, decideProotDistroInstall, shellQuoteData } from "./proot-distro-state";
import { buildProotDistroRootfsInstallCommand } from "./termux-bootstrap-install";
const PROFILE = "ubuntu";

export type DistroProgress = {
  percent: number;
  stage: string;
  detail: string;
};

export type DistroOpResult = {
  ok: boolean;
  exitCode: number;
  log: string;
  path?: string;
};


export async function isUbuntuInstalled(): Promise<boolean> {
  try {
    return (await inspectTermuxProotDistro("ubuntu")).healthy;
  } catch {
    return false;
  }
}

export async function bootstrapUbuntu(
  onProgress?: (p: DistroProgress) => void,
): Promise<DistroOpResult> {
  const report = (percent: number, stage: string, detail: string) => {
    onProgress?.({ percent, stage, detail });
  };

  return withForegroundTask("bootstrap", "Ubuntu rootfs", async () => {
    report(3, "check", "Проверка proot-distro…");
    const has = await executeGuardedTermuxCommand("command -v proot-distro >/dev/null 2>&1; echo EXIT:$?", { timeoutMs: 15_000, executionTarget: "embedded-private", trustedInternal: true });
    if (!/EXIT:0/.test(has.stdout || "")) {
      report(0, "error", "proot-distro не установлен");
      return {
        ok: false,
        exitCode: 127,
        log: "proot-distro missing — pkg install proot-distro",
      };
    }

    const before = await inspectTermuxProotDistro("ubuntu");
    const decision = decideProotDistroInstall(before);
    if (decision === "already-healthy") {
      report(100, "done", "Ubuntu уже работает через proot-distro — без повторной загрузки");
      return { ok: true, exitCode: 0, log: "already_installed; verified by proot-distro login; no install/reset/remove executed" };
    }
    if (decision !== "install-once") {
      const detail = decision === "repair-required"
        ? "Ubuntu зарегистрирована, но login smoke не прошёл. Rootfs сохранён; автоматическая переустановка запрещена."
        : "Состояние установленного rootfs не подтверждено. Ничего не изменено, чтобы не затронуть ручную установку.";
      report(0, "error", detail);
      return { ok: false, exitCode: before.toolAvailable ? 78 : 127, log: `${before.diagnostic}: ${detail}` };
    }

    report(15, "install_start", "Ubuntu отсутствует в Installed distributions; однократная установка без reset");
    const script = buildProotDistroRootfsInstallCommand(PROFILE);
    const r = await withProotDistroInstallLock("ubuntu", async () => {
      const currentState = await inspectTermuxProotDistro("ubuntu");
      const currentDecision = decideProotDistroInstall(currentState);
      if (currentDecision === "already-healthy") return { exitCode: 0, stdout: "already_installed; concurrent install finished", stderr: "" };
      if (currentDecision !== "install-once") return { exitCode: 78, stdout: `${currentState.diagnostic}: install refused; existing rootfs preserved`, stderr: "" };
      return executeGuardedTermuxCommand(script, { timeoutMs: 45 * 60 * 1000, executionTarget: "embedded-private", trustedInternal: true, preserveOutput: true });
    });
    const log = ((r.stdout || "") + "\n" + (r.stderr || "")).slice(0, 8000);
    for (const line of log.split("\n")) {
      const m = line.match(/^STAGE:(\d+):(\w+)\s*(.*)$/);
      if (m) report(Number(m[1]), m[2], m[3] || m[2]);
      else if (/INSTALL_LINE:/.test(line)) report(40, "download", line.replace(/^INSTALL_LINE:/, "").slice(0, 100));
    }
    const ok = r.exitCode === 0 && (await isUbuntuInstalled());
    if (ok) report(100, "done", "Ubuntu установлен");
    else report(0, "error", `Установка не удалась (exit ${r.exitCode})`);
    return {
      ok,
      exitCode: r.exitCode ?? 1,
      log,
      path: undefined,
    };
  });
}


/** Export installed Ubuntu rootfs to a .tar.gz archive. */
export async function exportUbuntu(
  destPath: string,
  onProgress?: (p: DistroProgress) => void,
): Promise<DistroOpResult> {
  return withForegroundTask("backup", "Ubuntu export", async (fgUpdate) => {
    const report = (percent: number, stage: string, detail: string) => {
      onProgress?.({ percent, stage, detail });
      fgUpdate(percent / 100, detail.slice(0, 80));
    };
    report(5, "check", "Проверка Ubuntu…");
    if (!(await isUbuntuInstalled())) return { ok: false, exitCode: 1, log: "Ubuntu не установлен — нечего экспортировать" };
    const safeDest = destPath;
    const quotedDest = shellQuoteData(safeDest);
    const script = `
set -e
set -o pipefail
DEST=${quotedDest}
mkdir -p "$(dirname "$DEST")"
echo "STAGE:25:backup_start"
LOG_FILE="/tmp/aib-ubuntu-backup.$$.log"
if proot-distro backup ${PROFILE} --output "$DEST" >"$LOG_FILE" 2>&1; then
  cat "$LOG_FILE"
  echo "STAGE:90:backup_ok"
else
  cat "$LOG_FILE" >&2
  echo "PROOT_DISTRO_BACKUP_FAILED" >&2
  exit 2
fi
[ -s "$DEST" ] || { echo "EXPORT_EMPTY:$DEST" >&2; exit 3; }
ls -lh "$DEST"
echo "STAGE:100:done"
echo "EXPORT_PATH:$DEST"
`;
    const r = await executeGuardedTermuxCommand(script, { timeoutMs: 30 * 60_000, executionTarget: "embedded-private", trustedInternal: true, preserveOutput: true });
    const log = `${r.stdout || ""}\n${r.stderr || ""}`;
    for (const line of log.split("\n")) {
      const m = line.match(/^STAGE:(\d+):([^ ]+)\s*(.*)$/);
      if (m) report(Number(m[1]), m[2], m[3] || m[2]);
    }
    const path = log.match(/EXPORT_PATH:(.+)/)?.[1]?.trim() || safeDest;
    const ok = (r.exitCode ?? 1) === 0 && /STAGE:100:done/.test(log) && /EXPORT_PATH:/.test(log);
    report(ok ? 100 : 0, ok ? "done" : "failed", ok ? `Экспорт: ${path}` : "Ошибка экспорта");
    return { ok, exitCode: r.exitCode ?? 1, log: log.slice(-6000), path };
  });
}

/** Import Ubuntu from a local proot-distro backup or tar.gz archive. */
export async function importUbuntu(
  sourcePath: string,
  onProgress?: (p: DistroProgress) => void,
): Promise<DistroOpResult> {
  const report = (percent: number, stage: string, detail: string) => onProgress?.({ percent, stage, detail });
  report(5, "check", `Файл: ${sourcePath}`);
  const before = await inspectTermuxProotDistro("ubuntu");
  if (before.healthy || before.installed !== false) {
    const detail = before.healthy
      ? "Ubuntu уже работает; импорт, который может заменить rootfs, отклонён."
      : "Состояние Ubuntu не подтверждает отсутствие. Rootfs сохранён; импорт отклонён.";
    return { ok: false, exitCode: 78, log: `${before.diagnostic}: ${detail}` };
  }
  const script = buildProotDistroRestoreCommand(PROFILE, sourcePath);
  const r = await executeGuardedTermuxCommand(script, { timeoutMs: 30 * 60 * 1000, executionTarget: "embedded-private", trustedInternal: true, preserveOutput: true });
  const log = `${r.stdout || ""}\n${r.stderr || ""}`.slice(-16_000);
  report(70, "restore", "Восстановление через proot-distro без замены существующих каталогов");
  const after = await inspectTermuxProotDistro("ubuntu");
  const ok = r.exitCode === 0 && after.healthy;
  report(ok ? 100 : 0, ok ? "done" : "failed", ok ? "Импорт завершён и login smoke прошёл" : "Импорт не подтверждён; существующие данные не удалялись");
  return { ok, exitCode: ok ? 0 : r.exitCode ?? 78, log: `${log}\nVERIFY:${after.diagnostic}`.slice(-16_000) };
}

export function defaultUbuntuExportPath(homeRoot: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${homeRoot}/exports/ubuntu-${ts}.tar.gz`;
}
