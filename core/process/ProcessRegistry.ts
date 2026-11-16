/**
 * Runtime-only process registry.
 * Tracks agent / terminal / runtime / container / bridge processes.
 * Does not spawn processes and does not touch compilation settings.
 */

export type ProcessKind =
  | "agent"
  | "terminal"
  | "runtime"
  | "container"
  | "bridge"
  | "other";

export type RegisteredProcess = {
  readonly id: string;
  readonly kind: ProcessKind;
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly label?: string;
  readonly startedAt: number;
  readonly pid?: number | string;
  readonly metadata?: Readonly<Record<string, string>>;
};

export class ProcessRegistry {
  private readonly processes = new Map<string, RegisteredProcess>();

  register(process: RegisteredProcess): void {
    if (this.processes.has(process.id)) {
      throw new Error(`Process already registered: ${process.id}`);
    }
    this.processes.set(process.id, process);
  }

  unregister(id: string): boolean {
    return this.processes.delete(id);
  }

  /** Merge metadata keys (e.g. health=failed for supervisor tick). */
  patchMetadata(id: string, patch: Record<string, string>): boolean {
    const cur = this.processes.get(id);
    if (!cur) return false;
    this.processes.set(id, {
      ...cur,
      metadata: { ...(cur.metadata || {}), ...patch },
    });
    return true;
  }

  get(id: string): RegisteredProcess | undefined {
    return this.processes.get(id);
  }

  list(kind?: ProcessKind): RegisteredProcess[] {
    const all = [...this.processes.values()];
    return kind ? all.filter((p) => p.kind === kind) : all;
  }

  listBySession(sessionId: string): RegisteredProcess[] {
    return [...this.processes.values()].filter((p) => p.sessionId === sessionId);
  }

  clear(): void {
    this.processes.clear();
  }

  size(): number {
    return this.processes.size;
  }
}

export function createProcessRegistry(): ProcessRegistry {
  return new ProcessRegistry();
}
