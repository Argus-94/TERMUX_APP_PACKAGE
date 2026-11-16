import { getBuildBackend } from "./agent-shell-backend";
import { executeGuardedTermuxCommand } from "./termux-executor";
import { createBootstrapStageRunner } from "./bootstrap-stage-core";
import type { AgentShellBackend } from "./agent-shell-backend";

/** Production StageRunner. proot-distro lifecycle commands are always Termux-host commands. */
export function createDefaultBootstrapRunner() {
  return createBootstrapStageRunner({
    getBackend: getBuildBackend,
    execute: async (command: string, backend: AgentShellBackend, timeoutMs: number) =>
      executeGuardedTermuxCommand(command, {
        backend,
        hostTermux: backend === "termux",
        timeoutMs,
        trustedInternal: true,
      }),
  });
}
