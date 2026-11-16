/**
 * Runtime-only SessionManager.
 * Unifies project + environment + terminal + agent + build + logs identity.
 */

export type SessionId = string;

export type BuilderSession = {
  readonly id: SessionId;
  readonly projectId?: string;
  readonly projectRoot?: string;
  readonly environmentId?: string;
  readonly terminalSessionIds: string[];
  readonly agentSessionIds: string[];
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, string>>;
};

export class SessionManager {
  private readonly sessions = new Map<SessionId, BuilderSession>();

  create(input: {
    id?: SessionId;
    projectId?: string;
    projectRoot?: string;
    environmentId?: string;
    metadata?: Record<string, string>;
  }): BuilderSession {
    const id = input.id ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (this.sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`);
    }
    const session: BuilderSession = {
      id,
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      environmentId: input.environmentId,
      terminalSessionIds: [],
      agentSessionIds: [],
      createdAt: Date.now(),
      metadata: input.metadata ? { ...input.metadata } : undefined,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: SessionId): BuilderSession | undefined {
    return this.sessions.get(id);
  }

  attachTerminal(sessionId: SessionId, terminalId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session: ${sessionId}`);
    if (!s.terminalSessionIds.includes(terminalId)) {
      (s.terminalSessionIds as string[]).push(terminalId);
    }
  }

  attachAgent(sessionId: SessionId, agentId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session: ${sessionId}`);
    if (!s.agentSessionIds.includes(agentId)) {
      (s.agentSessionIds as string[]).push(agentId);
    }
  }

  list(): BuilderSession[] {
    return [...this.sessions.values()];
  }

  close(id: SessionId): boolean {
    return this.sessions.delete(id);
  }

  closeAll(): void {
    this.sessions.clear();
  }
}

export function createSessionManager(): SessionManager {
  return new SessionManager();
}
