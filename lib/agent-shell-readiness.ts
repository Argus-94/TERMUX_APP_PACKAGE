import { checkTermuxReadiness, type TermuxCommandResult, type TermuxReadiness } from "./termux-bridge";
import { privateRuntimeProvider, type PrivateRuntimeCommandOptions } from "./private-runtime-provider";
import type { AgentShellExecutionTarget } from "./agent-shell-target";

export const PRIVATE_SHELL_READINESS_MARKER = "AIB_EMBEDDED_PRIVATE_SHELL_READY";
export const PRIVATE_SHELL_READINESS_COMMAND = `printf '%s\\n' '${PRIVATE_SHELL_READINESS_MARKER}'`;

type LegacyReadinessOptions = { deep: true; refreshPermission: true };
export type AgentShellReadinessResult =
  | { target: "selected-backend"; ready: boolean; legacy: TermuxReadiness }
  | { target: "embedded-private"; ready: true }
  | {
      target: "embedded-private";
      ready: false;
      reason: "private_probe_rejected" | "private_probe_timeout" | "private_probe_truncated" | "private_probe_failed";
    };

export type AgentShellReadinessDependencies = Readonly<{
  checkLegacyReadiness: (options: LegacyReadinessOptions) => Promise<TermuxReadiness>;
  executePrivateProbe: (
    command: string,
    options: PrivateRuntimeCommandOptions,
  ) => Promise<TermuxCommandResult>;
}>;

const defaultDependencies: AgentShellReadinessDependencies = {
  checkLegacyReadiness: (options) => checkTermuxReadiness(options),
  executePrivateProbe: (command, options) => privateRuntimeProvider.execute(command, options),
};

/**
 * Check only the selected agent shell target. The selected-backend branch keeps
 * its previous deep Termux readiness contract unchanged. The opt-in private
 * branch starts a bounded app-private Bash probe; it never consults the selected
 * Termux/Ubuntu backend or retries through another executor.
 */
export function createAgentShellReadinessChecker(
  dependencies: AgentShellReadinessDependencies = defaultDependencies,
): (target: AgentShellExecutionTarget) => Promise<AgentShellReadinessResult> {
  return async (target) => {
    if (target === "selected-backend") {
      const legacy = await dependencies.checkLegacyReadiness({ deep: true, refreshPermission: true });
      return { target, ready: legacy.ready, legacy };
    }
    if (target !== "embedded-private") throw new Error("AGENT_SHELL_TARGET_INVALID");

    let result: TermuxCommandResult;
    try {
      result = await dependencies.executePrivateProbe(PRIVATE_SHELL_READINESS_COMMAND, {
        timeoutMs: 5_000,
        trustedInternal: true,
        preserveOutput: true,
      });
    } catch {
      return { target, ready: false, reason: "private_probe_rejected" };
    }
    if (!result || typeof result !== "object") {
      return { target, ready: false, reason: "private_probe_failed" };
    }
    if (result.timedOut) return { target, ready: false, reason: "private_probe_timeout" };
    if (result.outputTruncated) return { target, ready: false, reason: "private_probe_truncated" };
    if (result.exitCode !== 0 || typeof result.stdout !== "string" || result.stdout.trim() !== PRIVATE_SHELL_READINESS_MARKER) {
      return { target, ready: false, reason: "private_probe_failed" };
    }
    return { target, ready: true };
  };
}

export const checkAgentShellReadiness = createAgentShellReadinessChecker();
