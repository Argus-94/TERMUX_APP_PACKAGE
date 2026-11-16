import { executeGuardedTermuxCommand } from '../../lib/termux-executor';
import { createHomeEnvironment } from '../home/HomeEnvironment';
import type { ExecutionEnvironment } from './ExecutionEnvironment';
import { resolveAllowedWritePath, SHARED_APP_WRITE_ROOTS, AI_BUILDER_SHARED_ROOT } from '../../lib/writable-path-policy.ts';

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function envPrefix(env?: Record<string, string>): string {
  if (!env) return '';
  const entries = Object.entries(env);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) throw new Error("BACKEND_ENV_INVALID");
    if (key === "HOME" || key === "PREFIX" || key === "TMPDIR") throw new Error(`TERMUX_ENV_PATH_OVERRIDE_FORBIDDEN:${key}`);
    if (key === "AI_BUILDER_HOME" && value.replace(/\/+$/, "") !== AI_BUILDER_SHARED_ROOT) throw new Error("AI_BUILDER_HOME_OUTSIDE_SHARED_ROOT");
  }
  return entries.map(([key, value]) => `export ${key}=${shellQuote(value)};`).join(' ') + (entries.length ? ' ' : '');
}

function commandTimedOut(result: { timedOut?: boolean }): boolean {
  return result.timedOut === true;
}

function commandFailure(operation: string, result: { exitCode?: number | null; stderr?: string; timedOut?: boolean }): Error {
  const status = commandTimedOut(result) ? "TIMEOUT" : `exit=${result.exitCode ?? "unavailable"}`;
  const detail = result.stderr?.trim();
  return new Error(`${operation}_FAILED:${status}${detail ? `:${detail}` : ""}`);
}

function requireCommandSuccess(operation: string, result: { exitCode?: number | null; stderr?: string; timedOut?: boolean }): void {
  if (result.exitCode !== 0 || commandTimedOut(result)) throw commandFailure(operation, result);
}

/** First concrete runtime implementation, backed by the existing Termux bridge. */
export class AIBuilderTermuxEnvironment implements ExecutionEnvironment {
  constructor(private readonly home: string = createHomeEnvironment().AI_BUILDER_HOME) {}

  private async writablePath(path: string): Promise<string> {
    return resolveAllowedWritePath(path, SHARED_APP_WRITE_ROOTS, (candidate) => this.resolvePath(candidate));
  }

  async exec(command: string, options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; preserveOutput?: boolean } = {}) {
    if (options.signal?.aborted) throw new Error("ABORTED");
    const prefix = envPrefix(options.env);
    const result = await executeGuardedTermuxCommand(prefix + command, {
      workdir: options.cwd,
      timeoutMs: options.timeoutMs,
      executionTarget: "embedded-private",
            preserveOutput: options.preserveOutput,
    });
    if (options.signal?.aborted) throw new Error("ABORTED");
    return result;
  }

  async spawn(command: string, options: { cwd?: string; env?: Record<string, string> } = {}) {
    return this.exec(command, { ...options });
  }

  async read(path: string): Promise<string> {
    const result = await this.exec(`cat -- ${shellQuote(path)}`);
    requireCommandSuccess("READ", result);
    return result.stdout;
  }

  async write(path: string, content: string): Promise<void> {
    const target = await this.writablePath(path);
    const result = await this.exec(`printf '%s' ${shellQuote(content)} > ${shellQuote(target)}`);
    requireCommandSuccess("WRITE", result);
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.exec(`test -e ${shellQuote(path)}`);
    if (commandTimedOut(result)) throw commandFailure("EXISTS", result);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1 && !result.stderr?.trim()) return false;
    throw commandFailure("EXISTS", result);
  }

  async mkdir(path: string): Promise<void> {
    const target = await this.writablePath(path);
    const result = await this.exec(`mkdir -p -- ${shellQuote(target)}`);
    requireCommandSuccess("MKDIR", result);
  }

  async resolvePath(path: string): Promise<string> {
    if (!path.startsWith("/") || path.includes("\0") || path.includes("\n") || path.includes("\r")) {
      throw new Error("PATH_INVALID");
    }
    const result = await this.exec(`realpath -m -- ${shellQuote(path)}`, { timeoutMs: 10_000 });
    const canonical = result.stdout.trim();
    if (result.exitCode !== 0 || commandTimedOut(result) || !canonical.startsWith("/")) throw commandFailure("PATH_RESOLVE", result);
    return canonical;
  }

  getHome(): string { return this.home; }
}
