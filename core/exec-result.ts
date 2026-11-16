/**
 * Runtime-only normalized command execution result.
 *
 * This is a transport-neutral result model. It performs no execution and
 * makes no assumptions about shell, PTY, Termux, containers, Shizuku or root.
 */

export type ExecStream = "stdout" | "stderr";

export type ExecResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export function createExecResult(input: ExecResult): ExecResult {
  if (!input.command || input.command.includes("\u0000")) {
    throw new Error("Invalid execution command");
  }
  if (!Array.isArray(input.args)) {
    throw new Error("Execution args must be an array");
  }
  if (input.exitCode !== null && !Number.isInteger(input.exitCode)) {
    throw new Error("Execution exitCode must be an integer or null");
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new Error("Execution durationMs must be a non-negative number");
  }

  return {
    command: input.command,
    args: [...input.args],
    exitCode: input.exitCode,
    ...(input.signal ? { signal: input.signal } : {}),
    stdout: input.stdout,
    stderr: input.stderr,
    durationMs: input.durationMs,
  };
}

export function isSuccessfulExecResult(result: ExecResult): boolean {
  return result.exitCode === 0 && !result.signal;
}
