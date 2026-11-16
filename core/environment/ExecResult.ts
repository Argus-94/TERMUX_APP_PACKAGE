export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  processId?: string;
}
export function createExecResult(input: Omit<ExecResult, 'duration'> & { duration?: number }): ExecResult {
  return { ...input, duration: input.duration ?? 0 };
}
