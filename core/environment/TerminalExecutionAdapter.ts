import type { ExecutionEnvironment } from './ExecutionEnvironment';

/** Terminal-facing adapter: terminal code depends on the environment contract, not Termux. */
export class TerminalExecutionAdapter {
  constructor(private readonly environment: ExecutionEnvironment) {}

  exec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) {
    return this.environment.exec(command, options);
  }

  getHome() { return this.environment.getHome(); }
}
