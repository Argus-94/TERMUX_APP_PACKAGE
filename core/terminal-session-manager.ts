/**
 * Runtime-only terminal session lifecycle manager.
 *
 * Owns session identity and lifecycle bookkeeping while delegating actual
 * terminal work to an injected TerminalAdapter.
 * Supports graceful stop / interrupt / kill via ProcessHandle abstraction.
 */

import type {
  ProcessControlAction,
  ProcessHandle,
  TerminalAdapter,
  TerminalSession,
  TerminalSessionOptions,
} from "./terminal";

export type ManagedTerminalSession = {
  readonly session: TerminalSession;
  readonly createdAt: number;
  processHandle?: ProcessHandle;
};

export class TerminalSessionManager {
  private readonly sessions = new Map<string, ManagedTerminalSession>();

  constructor(private readonly adapter: TerminalAdapter) {}

  async create(options: TerminalSessionOptions): Promise<TerminalSession> {
    const session = await this.adapter.createSession(options);
    if (this.sessions.has(session.id)) {
      await this.adapter.close(session.id);
      throw new Error(`Terminal session already exists: ${session.id}`);
    }

    const processHandle =
      this.adapter.getProcessHandle?.(session.id) ??
      ({
        id: `proc-${session.id}`,
        sessionId: session.id,
        startedAt: Date.now(),
      } satisfies ProcessHandle);

    this.sessions.set(session.id, {
      session,
      createdAt: Date.now(),
      processHandle,
    });
    return session;
  }

  get(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  getProcessHandle(sessionId: string): ProcessHandle | undefined {
    return this.sessions.get(sessionId)?.processHandle;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }

  async control(sessionId: string, action: ProcessControlAction): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      return;
    }
    if (this.adapter.control) {
      await this.adapter.control(sessionId, action);
      return;
    }
    const session = this.sessions.get(sessionId)?.session;
    if (!session) return;
    if (action === "stop" && session.stop) {
      await session.stop();
    } else if (action === "interrupt" && session.interrupt) {
      await session.interrupt();
    } else if (action === "kill" && session.kill) {
      await session.kill();
    } else {
      await this.close(sessionId);
    }
  }

  async stop(sessionId: string): Promise<void> {
    await this.control(sessionId, "stop");
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.control(sessionId, "interrupt");
  }

  async kill(sessionId: string): Promise<void> {
    await this.control(sessionId, "kill");
  }

  async close(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      return;
    }
    await this.adapter.close(sessionId);
    this.sessions.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    const ids = this.list();
    for (const id of ids) {
      await this.close(id);
    }
  }
}
