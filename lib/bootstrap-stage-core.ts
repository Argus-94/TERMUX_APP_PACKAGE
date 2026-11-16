import type { AgentShellBackend } from "./agent-shell-backend";
import type { BootstrapStageId, StageRunner } from "../core/runtime/BootstrapPipeline";
import {
  buildProotDistroRootfsCheckCommand,
  buildProotDistroRootfsInstallCommand,
  buildTermuxProotDistroInstallCommand,
  buildTermuxToolsBaseInstallCommand,
} from "./termux-bootstrap-install";
import {
  rootfsDistroForBackend,
  routeRuntimeCommand,
} from "./runtime-command-routing";

type CommandResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

type BootstrapRunnerDependencies = {
  getBackend: () => AgentShellBackend;
  execute: (command: string, backend: AgentShellBackend, timeoutMs: number) => Promise<CommandResult>;
};

function outputOf(result: CommandResult): string {
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}

function hasMirrorDiagnostic(output: string): boolean {
  return /Testing the available mirrors|No mirror found|Failed to fetch|Could not resolve host|Temporary failure resolving|Network is unreachable|Connection timed out/i.test(output);
}

export function createBootstrapStageRunner(deps: BootstrapRunnerDependencies): StageRunner {
  const runHost = async (command: string, timeoutMs: number) => {
    const backend = routeRuntimeCommand(deps.getBackend(), "host");
    try {
      const result = await deps.execute(command, backend, timeoutMs);
      return { ok: result.exitCode === 0, out: outputOf(result), result };
    } catch (error) {
      return {
        ok: false,
        out: error instanceof Error ? error.message : String(error),
        result: { exitCode: 1 },
      };
    }
  };

  return async (stageId: BootstrapStageId, report) => {
    switch (stageId) {
      case "termux-ready": {
        report("Probe Termux shell…");
        const result = await runHost("echo AIB_BOOTSTRAP_OK", 15_000);
        if (!result.ok || !result.out.includes("AIB_BOOTSTRAP_OK")) {
          return { ok: false, message: "Встроенная среда не отвечает (private bootstrap / native bridge / execution)" };
        }
        return { ok: true, fingerprint: "termux:echo-ok", message: "Termux session OK" };
      }
      case "tools-base": {
        report("Checking base tools (java/unzip/git)…");
        const check = await runHost(
          `ok=1
command -v unzip >/dev/null || ok=0
command -v git >/dev/null || ok=0
echo tools_ok=$ok
command -v java >/dev/null && java -version 2>&1 | head -1 || echo java=missing`,
          20_000,
        );
        if (check.out.includes("tools_ok=1") && !check.out.includes("java=missing")) {
          return { ok: true, fingerprint: "tools:java+unzip+git", message: "Base tools present" };
        }
        report("Installing openjdk-17 unzip git wget curl…");
        const install = await runHost(buildTermuxToolsBaseInstallCommand(), 600_000);
        const verify = await runHost(
          "command -v java && command -v unzip && command -v git && echo TOOLS_OK",
          15_000,
        );
        if (!verify.out.includes("TOOLS_OK")) {
          return {
            ok: false,
            message: `tools-base failed (pkg output and post-check):\n${install.out}\n${verify.out}`,
          };
        }
        return { ok: true, fingerprint: "tools:java+unzip+git", message: "Base tools installed" };
      }
      case "proot-distro": {
        report("Checking proot-distro…");
        const check = await runHost(
          "command -v proot-distro >/dev/null 2>&1; echo EXIT:$?",
          10_000,
        );
        if (/EXIT:0/.test(check.out)) {
          return { ok: true, fingerprint: "pkg:proot-distro", message: "proot-distro present" };
        }
        report("pkg update + install proot-distro…");
        const install = await runHost(buildTermuxProotDistroInstallCommand(), 600_000);
        const verify = await runHost(
          "command -v proot-distro >/dev/null 2>&1; echo EXIT:$?",
          10_000,
        );
        if (/EXIT:0/.test(verify.out)) {
          return { ok: true, fingerprint: "pkg:proot-distro", message: "proot-distro installed" };
        }
        const detail = install.out || "(empty pkg output)";
        const mirrorHint = hasMirrorDiagnostic(detail)
          ? " Проверьте выбранный источник Termux и сеть; команды установки не меняли настройки источников."
          : "";
        return { ok: false, message: `proot-distro install failed.${mirrorHint}\n${detail}`.trim() };
      }
      case "environment-image": {
        const selectedBackend = deps.getBackend();
        const distro = rootfsDistroForBackend(selectedBackend);
        if (!distro) {
          return {
            ok: true,
            skipped: true,
            fingerprint: "image:none:termux",
            message: "Termux выбран; Linux rootfs не требуется",
          };
        }

        const hostBackend = routeRuntimeCommand(selectedBackend, "proot-distro");
        const checkCommand = buildProotDistroRootfsCheckCommand(distro);
        report(`Checking ${distro} image on Termux host…`);
        const check = await deps.execute(checkCommand, hostBackend, 20_000).catch((error) => ({
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        }));
        const marker = `${distro.toUpperCase()}_ROOTFS_OK`;
        if (check.exitCode === 0 && outputOf(check).includes(marker)) {
          return {
            ok: true,
            fingerprint: `image:${distro}`,
            message: `${distro[0].toUpperCase()}${distro.slice(1)} already installed`,
          };
        }

        const checkOutput = outputOf(check);
        const markerPrefix = `AIB_${distro.toUpperCase()}_ROOTFS_`;
        if (checkOutput.includes(`${markerPrefix}INSTALLED_LOGIN_FAILED`)) {
          return { ok: false, message: `${distro} is listed as installed but login failed; rootfs preserved and no install/reset was attempted. Review the Termux error.` };
        }
        if (!checkOutput.includes(`${markerPrefix}MISSING`)) {
          return { ok: false, message: `${distro} state is unverified; installer was not invoked to protect any existing rootfs.` };
        }

        report(`proot-distro install ${distro} on Termux host (long)…`);
        const install = await deps.execute(
          buildProotDistroRootfsInstallCommand(distro),
          hostBackend,
          45 * 60_000,
        ).catch((error) => ({
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        }));
        const verify = await deps.execute(checkCommand, hostBackend, 20_000).catch((error) => ({
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        }));
        if (verify.exitCode === 0 && outputOf(verify).includes(marker)) {
          return {
            ok: true,
            fingerprint: `image:${distro}`,
            message: `${distro[0].toUpperCase()}${distro.slice(1)} installed`,
          };
        }

        const detail = [outputOf(check), outputOf(install), outputOf(verify)].filter(Boolean).join("\n");
        const mirrorHint = hasMirrorDiagnostic(detail)
          ? " Проверьте выбранный источник Termux и сеть; команда не меняла настройки источников."
          : "";
        return {
          ok: false,
          message: `${distro[0].toUpperCase()}${distro.slice(1)} install failed.${mirrorHint}\n${detail || "(empty proot-distro output)"}`.trim(),
        };
      }
      case "workspace": {
        report("Ensure workspace dirs…");
        const result = await runHost(
          `mkdir -p "$HOME/workspace" "$HOME/exports" "$HOME/backups" 2>/dev/null
[ -d "$HOME/workspace" ] && echo WS_OK || echo WS_FAIL`,
          15_000,
        );
        if (!result.out.includes("WS_OK")) return { ok: false, message: "workspace dirs failed" };
        return { ok: true, fingerprint: "dirs:workspace+exports", message: "Workspace ready" };
      }
      case "verify": {
        report("Final verify…");
        const result = await runHost(
          `echo AIB_VERIFY_OK
command -v proot-distro >/dev/null && proot-distro list 2>/dev/null | head -5 || true`,
          20_000,
        );
        if (!result.out.includes("AIB_VERIFY_OK")) return { ok: false, message: "verify probe failed" };
        return { ok: true, fingerprint: "verify:ok", message: "Bootstrap verify OK" };
      }
      default:
        return { ok: false, message: `Unknown stage ${stageId}` };
    }
  };
}
