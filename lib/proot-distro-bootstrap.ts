import {
  buildProotDistroRootfsInstallCommand,
  buildTermuxProotDistroInstallCommand,
} from "./termux-bootstrap-install.ts";
import { withProotDistroHostToolLock, withProotDistroInstallLock, type ProotDistroAlias } from "./proot-distro-state.ts";
import { formatPackageInstallFailure } from "./package-install-diagnostics.ts";

export interface ProotBootstrapCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
}
export interface ProotBootstrapRunOptions {
  timeoutMs: number;
  kind: "check" | "install" | "update";
  packageId: string;
  isBuild?: boolean;
  honorExplicitTimeout?: boolean;
  /** Correlates a user-triggered check/prepare with the Termux bridge result. */
  traceId?: string;
}
export type ProotBootstrapRunner = (
  command: string,
  options: ProotBootstrapRunOptions,
) => Promise<ProotBootstrapCommandResult>;
export type ProotBootstrapLog = (level: "info" | "warn" | "error", message: string) => void;

const TOOL_CHECK_TIMEOUT_MS = 20_000;
const TOOL_INSTALL_TIMEOUT_MS = 180_000;
const ROOTFS_INSTALL_TIMEOUT_MS = 45 * 60_000;
const INSTALL_SUCCESS_MARKER: Record<ProotDistroAlias, string> = {
  debian: "DEBIAN_INSTALL_OK",
  ubuntu: "UBUNTU_INSTALL_OK",
};

export const PROOT_DISTRO_HOST_TOOL_PROBE_COMMAND = `if command -v proot-distro >/dev/null 2>&1; then
  echo AIB_PROOT_TOOL:AVAILABLE
else
  echo AIB_PROOT_TOOL:MISSING
fi`;

/**
 * Install one selected distro through the same package runner as Packages UI.
 * The host tool is probed first; if missing, the existing Termux pkg bootstrap
 * is run and its command availability is re-probed before any rootfs command.
 * Existing installed/unknown/login-failed rootfs guards remain in the final
 * production shell builder. A cancellation never starts the next phase.
 */
export async function installProotDistroRootfsWithPrerequisite(
  alias: ProotDistroAlias,
  run: ProotBootstrapRunner,
  onProgress: (percent: number, detail: string) => void,
  shouldAbort: () => boolean = () => false,
  onLog: ProotBootstrapLog = () => undefined,
): Promise<{ ok: boolean; error?: string }> {
  return withProotDistroInstallLock(alias, async () => {
    const event = (level: "info" | "warn" | "error", text: string) => {
      onLog(level, `AIB_ROOTFS_BOOTSTRAP alias=${alias} ${text}`);
    };
    const cancelled = (phase: string) => {
      event("warn", `phase=${phase} result=cancelled`);
      return { ok: false as const, error: "aborted" };
    };
    const failed = (phase: string, reason: string, result?: ProotBootstrapCommandResult) => {
      const transcript = [result?.stdout, result?.stderr]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join("\n").trim();
      const detail = transcript ? `\n${transcript.slice(-2400)}` : "";
      event("error", `phase=${phase} result=failed reason=${reason}`);
      return { ok: false as const, error: `${reason}${detail}` };
    };
    const probeHostTool = async (phase: "host-tool-check" | "host-tool-verify") => {
      event("info", `phase=${phase} result=started`);
      let result: ProotBootstrapCommandResult;
      try {
        result = await run(PROOT_DISTRO_HOST_TOOL_PROBE_COMMAND, {
          timeoutMs: TOOL_CHECK_TIMEOUT_MS,
          kind: "check",
          packageId: "proot-distro",
          honorExplicitTimeout: true,
        });
      } catch (error: unknown) {
        return { kind: "error" as const, error: failed(phase, `PROOT_TOOL_PROBE_FAILED: ${error instanceof Error ? error.message : String(error)}`) };
      }
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const available = markerCount(output, "AIB_PROOT_TOOL:AVAILABLE");
      const missing = markerCount(output, "AIB_PROOT_TOOL:MISSING");
      if (result.timedOut || result.outputTruncated || result.exitCode !== 0 || available + missing !== 1) {
        return { kind: "error" as const, error: failed(phase, "PROOT_TOOL_STATE_UNVERIFIED: Termux probe did not return one complete host-tool status marker", result) };
      }
      const kind = available === 1 ? "available" as const : "missing" as const;
      event("info", `phase=${phase} result=${kind}`);
      return { kind };
    };

    const hostTool = await withProotDistroHostToolLock(async () => {
      if (shouldAbort()) return { ok: false as const, error: cancelled("before-start") };
      onProgress(2, "Проверка host-инструмента proot-distro в Termux…");
      const initial = await probeHostTool("host-tool-check");
      if (initial.kind === "error") return { ok: false as const, error: initial.error };
      if (initial.kind === "available") return { ok: true as const };

      if (shouldAbort()) return { ok: false as const, error: cancelled("before-host-tool-install") };
      onProgress(6, "Установка host-пакета proot-distro через Termux pkg…");
      event("info", "phase=host-tool-install result=started");
      let installTool: ProotBootstrapCommandResult;
      try {
        installTool = await run(buildTermuxProotDistroInstallCommand(), {
          timeoutMs: TOOL_INSTALL_TIMEOUT_MS,
          kind: "install",
          packageId: "proot-distro",
          // The short, explicit prereq budget must not be raised to the generic
          // 30-minute long-command floor; the bridge still enforces its 60m cap.
          honorExplicitTimeout: true,
        });
      } catch (error: unknown) {
        return { ok: false as const, error: failed("host-tool-install", `PROOT_TOOL_INSTALL_FAILED: ${error instanceof Error ? error.message : String(error)}`) };
      }
      if (shouldAbort()) return { ok: false as const, error: cancelled("after-host-tool-install") };
      if (installTool.timedOut) return { ok: false as const, error: failed("host-tool-install", "PROOT_TOOL_INSTALL_TIMEOUT after 180000ms", installTool) };
      if (installTool.outputTruncated) return { ok: false as const, error: failed("host-tool-install", "PROOT_TOOL_INSTALL_OUTPUT_INCOMPLETE", installTool) };
      if (installTool.exitCode !== 0) {
        return { ok: false as const, error: failed("host-tool-install", formatPackageInstallFailure(installTool), installTool) };
      }
      onProgress(12, "Проверка доступности команды proot-distro…");
      if (shouldAbort()) return { ok: false as const, error: cancelled("before-host-tool-verify") };
      const verified = await probeHostTool("host-tool-verify");
      if (verified.kind === "error") return { ok: false as const, error: verified.error };
      if (verified.kind !== "available") {
        return { ok: false as const, error: failed("host-tool-verify", "PROOT_TOOL_INSTALL_NOT_VERIFIED: pkg завершился, но команда proot-distro не найдена") };
      }
      event("info", "phase=host-tool-install result=verified");
      return { ok: true as const };
    });
    if (!hostTool.ok) return hostTool.error;
    if (shouldAbort()) return cancelled("before-rootfs-install");
    onProgress(18, `Проверка состояния и установка ${alias} rootfs (без reset/remove)…`);
    event("info", "phase=rootfs-install result=started timeoutMs=2700000");
    let rootfs: ProotBootstrapCommandResult;
    try {
      rootfs = await run(buildProotDistroRootfsInstallCommand(alias), {
        timeoutMs: ROOTFS_INSTALL_TIMEOUT_MS,
        kind: "install",
        packageId: `${alias}-rootfs`,
        isBuild: true,
      });
    } catch (error: unknown) {
      return failed("rootfs-install", `ROOTFS_INSTALL_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (shouldAbort()) return cancelled("after-rootfs-command");
    const output = `${rootfs.stdout || ""}\n${rootfs.stderr || ""}`;
    const healthyMarker = `AIB_${alias.toUpperCase()}_ROOTFS_OK`;
    if (rootfs.timedOut) return failed("rootfs-install", "ROOTFS_INSTALL_TIMEOUT after 2700000ms; final state must be checked", rootfs);
    if (rootfs.outputTruncated) return failed("rootfs-install", "ROOTFS_INSTALL_OUTPUT_INCOMPLETE; success cannot be confirmed", rootfs);
    if (rootfs.exitCode !== 0) return failed("rootfs-install", formatPackageInstallFailure(rootfs), rootfs);
    if (markerCount(output, INSTALL_SUCCESS_MARKER[alias]) !== 1 || markerCount(output, healthyMarker) !== 1) {
      return failed("rootfs-install", "ROOTFS_INSTALL_SUCCESS_NOT_CONFIRMED: post-install login marker was absent or ambiguous", rootfs);
    }
    event("info", "phase=rootfs-install result=healthy-login-confirmed");
    onProgress(99, `${alias} прошёл проверку входа; подтверждаем состояние…`);
    return { ok: true };
  });
}

function markerCount(output: string, marker: string): number {
  return output.split(/\r?\n/).filter((line) => line.trim() === marker).length;
}
