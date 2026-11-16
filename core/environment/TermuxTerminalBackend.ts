/**
 * TerminalExecutionBackend backed by ExecutionEnvironment (Termux).
 * Session model is logical: one "session" maps to cwd + env for subsequent execs.
 * App-owned storage is AI_BUILDER_HOME; Termux's native HOME is never overridden.
 * Runtime-only; no compilation settings changes.
 */

import type { ExecutionEnvironment } from "./ExecutionEnvironment";
import { publishTerminalOutput } from "../terminal/TerminalOutputBus";
import type {
  ProcessControlAction,
  ProcessHandle,
  TerminalAdapter,
  TerminalSession,
  TerminalSessionOptions,
  TerminalSize,
} from "../terminal";

type SessionState = {
  id: string;
  cwd: string;
  env: Record<string, string>;
  size: TerminalSize;
  home?: string;
  projectRoot?: string;
  closed: boolean;
};

export class TermuxTerminalBackend implements TerminalAdapter {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly environment: ExecutionEnvironment) {}

  async createSession(options: TerminalSessionOptions): Promise<TerminalSession> {
    const id = options.id ?? `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (this.sessions.has(id)) {
      throw new Error(`Session exists: ${id}`);
    }
    const home =
      options.home ??
      String(await Promise.resolve(this.environment.getHome()));
    const env: Record<string, string> = {
      ...(options.env ?? {}),
      AI_BUILDER_HOME: home,
      PWD: options.cwd,
      ...(options.projectRoot
        ? {
            PROJECT_ROOT: options.projectRoot,
            AI_BUILDER_PROJECT: options.projectRoot,
          }
        : {}),
    };
    // The embedded bridge provides this application's validated private HOME.
    // Caller-supplied HOME must not redirect runtime state to another namespace.
    delete env.HOME;
    const state: SessionState = {
      id,
      cwd: options.cwd,
      env,
      size: options.size ?? { columns: 80, rows: 24 },
      home,
      projectRoot: options.projectRoot,
      closed: false,
    };
    this.sessions.set(id, state);

    const self = this;
    const session: TerminalSession = {
      id,
      cwd: state.cwd,
      size: state.size,
      home: state.home,
      projectRoot: state.projectRoot,
      async write(input: string) {
        await self.send({ sessionId: id, data: input });
      },
      async resize(size: TerminalSize) {
        await self.resize(id, size);
      },
      async close() {
        await self.close(id);
      },
      async stop() {
        await self.control(id, "stop");
      },
      async interrupt() {
        await self.control(id, "interrupt");
      },
      async kill() {
        await self.control(id, "kill");
      },
    };
    return session;
  }

  async send(input: { sessionId: string; data: string }): Promise<void> {
    const state = this.sessions.get(input.sessionId);
    if (!state || state.closed) {
      throw new Error(`Unknown or closed session: ${input.sessionId}`);
    }
    const line = input.data.replace(/\r?\n$/, "");
    if (!line.trim()) return;

    // Lightweight cd handling to keep PWD coherent
    if (line.startsWith("cd ") || line === "cd") {
      const target = line === "cd" ? state.home ?? state.cwd : line.slice(3).trim() || state.home;
      if (target) {
        const resolved = target.startsWith("/")
          ? target
          : `${state.cwd.replace(/\/$/, "")}/${target}`;
        state.cwd = resolved;
        state.env.PWD = resolved;
      }
      return;
    }

    const result = await this.environment.exec(line, {
      cwd: state.cwd,
      env: state.env,
    });
    const stdout =
      result && typeof result === "object" && "stdout" in result
        ? String((result as { stdout?: string }).stdout ?? "")
        : "";
    const stderr =
      result && typeof result === "object" && "stderr" in result
        ? String((result as { stderr?: string }).stderr ?? "")
        : "";
    if (stdout) {
      publishTerminalOutput({
        sessionId: state.id,
        stream: "stdout",
        data: stdout,
      });
    }
    if (stderr) {
      publishTerminalOutput({
        sessionId: state.id,
        stream: "stderr",
        data: stderr,
      });
    }
  }

  async resize(sessionId: string, size: TerminalSize): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state) state.size = size;
  }

  async close(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.closed = true;
      this.sessions.delete(sessionId);
    }
  }

  async control(sessionId: string, action: ProcessControlAction): Promise<void> {
    // The Termux exec bridge exposes no cancellable PID/signal; closing a
    // logical session cannot truthfully implement kill while exec is running.
    if (action === "kill") throw new Error("TERMINAL_PROCESS_CONTROL_UNSUPPORTED");
    // Termux one-shot exec has no long-lived PID here; close session as stop.
    await this.close(sessionId);
  }

  getProcessHandle(sessionId: string): ProcessHandle | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    return {
      id: `proc-${sessionId}`,
      sessionId,
      startedAt: Date.now(),
      command: "termux-shell",
    };
  }
}

export function createTermuxTerminalBackend(
  environment: ExecutionEnvironment,
): TermuxTerminalBackend {
  return new TermuxTerminalBackend(environment);
}
