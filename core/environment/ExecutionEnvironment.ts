/** Runtime-neutral execution environment contract. */

export interface EnvironmentExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Optional runtime metadata; host Termux bridge may not provide these fields. */
  duration?: number;
  processId?: string;
}

export interface ExecutionEnvironment {
  exec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; preserveOutput?: boolean }): Promise<EnvironmentExecResult>;
  spawn(command: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<EnvironmentExecResult>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  getHome(): Promise<string> | string;
  /** Canonicalize absolute paths (including existing symlink parents) for isolation checks. */
  resolvePath?(path: string): Promise<string>;
}
