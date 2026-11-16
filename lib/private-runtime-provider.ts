import { executeGuardedTermuxCommand } from "./termux-executor";
import type { GuardedTermuxOptions } from "./termux-executor";
import type { TermuxCommandResult } from "./termux-bridge";

/** Options intentionally omit backend/hostTermux/target selection. */
export type PrivateRuntimeCommandOptions = Readonly<Pick<
  GuardedTermuxOptions,
  "workdir" | "timeoutMs" | "signal" | "trustedInternal" | "preserveOutput" | "traceId"
>>;

export type PrivateRuntimeProvider = Readonly<{
  execute(command: string, options?: PrivateRuntimeCommandOptions): Promise<TermuxCommandResult>;
}>;

export type GuardedRuntimeExecutor = (
  command: string,
  options: GuardedTermuxOptions,
) => Promise<TermuxCommandResult>;

export type AgentShellRuntimeTarget = "selected-backend" | "embedded-private";

/**
 * Narrow provider for userland commands that must use AI Builder's private
 * embedded runtime. Native code remains responsible for private-HOME or explicitly granted exact-workspace
 * cwd containment. Missing native capability rejects; no external fallback is
 * available through this contract.
 */
export function createPrivateRuntimeProvider(
  runGuarded: GuardedRuntimeExecutor = executeGuardedTermuxCommand,
): PrivateRuntimeProvider {
  return Object.freeze({
    execute(command: string, options: PrivateRuntimeCommandOptions = {}) {
      const guarded: GuardedTermuxOptions = { executionTarget: "embedded-private" };
      if (options.workdir !== undefined) guarded.workdir = options.workdir;
      if (options.timeoutMs !== undefined) guarded.timeoutMs = options.timeoutMs;
      if (options.signal !== undefined) guarded.signal = options.signal;
      if (options.trustedInternal !== undefined) guarded.trustedInternal = options.trustedInternal;
      if (options.preserveOutput !== undefined) guarded.preserveOutput = options.preserveOutput;
      if (options.traceId !== undefined) guarded.traceId = options.traceId;
      return runGuarded(command, guarded);
    },
  });
}

/** Shared entry point for private-runtime call sites; external interop stays separate. */
export const privateRuntimeProvider = createPrivateRuntimeProvider();

/** Route one-shot agent shell commands; private failures propagate without a legacy retry. */
export function createAgentShellCommandExecutor(
  runLegacy: GuardedRuntimeExecutor = executeGuardedTermuxCommand,
  privateProvider: PrivateRuntimeProvider = privateRuntimeProvider,
): (command: string, options: GuardedTermuxOptions, target: AgentShellRuntimeTarget) => Promise<TermuxCommandResult> {
  return (command, options, target) => {
    if (target === "selected-backend") throw new Error("AGENT_SHELL_EXTERNAL_TARGET_DISABLED");
    if (target !== "embedded-private") throw new Error("AGENT_SHELL_TARGET_INVALID");
    const privateOptions: PrivateRuntimeCommandOptions = {
      ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.trustedInternal !== undefined ? { trustedInternal: options.trustedInternal } : {}),
      ...(options.preserveOutput !== undefined ? { preserveOutput: options.preserveOutput } : {}),
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
    };
    // backend, hostTermux, executionTarget and other legacy-only controls are stripped.
    return privateProvider.execute(command, privateOptions);
  };
}

export const executeAgentShellCommand = createAgentShellCommandExecutor();
