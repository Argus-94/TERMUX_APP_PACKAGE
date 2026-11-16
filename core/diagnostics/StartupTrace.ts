/**
 * StartupTrace — durable record of boot stages.
 * Survives process death; next launch can show "last failure was X at stage Y".
 */
export type StartupStage =
  | "app-init"
  | "permissions"
  | "home-layout"
  | "runtime-identity"
  | "journal-recovery"
  | "health-checks"
  | "termux-bridge"
  | "toolchain-probe"
  | "agent-ready"
  | "ready"
  | "failed";

export type StartupTraceEntry = Readonly<{
  stage: StartupStage;
  status: "started" | "ok" | "warn" | "error";
  at: number;
  message?: string;
  details?: Readonly<Record<string, string>>;
}>;

export type StartupTraceSnapshot = Readonly<{
  sessionId: string;
  startedAt: number;
  finishedAt?: number;
  finalStage: StartupStage;
  entries: readonly StartupTraceEntry[];
}>;

export interface TraceStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export class StartupTrace {
  private sessionId = `boot-${Date.now().toString(36)}`;
  private startedAt = Date.now();
  private entries: StartupTraceEntry[] = [];
  private finalStage: StartupStage = "app-init";

  constructor(private readonly store?: TraceStore) {}

  begin(sessionId?: string): void {
    this.sessionId = sessionId ?? `boot-${Date.now().toString(36)}`;
    this.startedAt = Date.now();
    this.entries = [];
    this.finalStage = "app-init";
    this.push("app-init", "started");
  }

  push(stage: StartupStage, status: StartupTraceEntry["status"], message?: string, details?: Record<string, string>): void {
    this.finalStage = stage;
    this.entries.push({ stage, status, at: Date.now(), message, details });
  }

  markReady(): void {
    this.push("ready", "ok", "Runtime ready");
    void this.persist();
  }

  markFailed(stage: StartupStage, message: string, details?: Record<string, string>): void {
    this.push(stage, "error", message, details);
    this.finalStage = "failed";
    void this.persist();
  }

  snapshot(): StartupTraceSnapshot {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      finishedAt: this.finalStage === "ready" || this.finalStage === "failed" ? Date.now() : undefined,
      finalStage: this.finalStage,
      entries: [...this.entries],
    };
  }

  async persist(): Promise<void> {
    if (!this.store) return;
    const history = await this.loadHistory();
    const snap = this.snapshot();
    // Keep last 5 boots (DSHA keeps 5 desensitized records)
    const next = [snap, ...history.filter((h) => h.sessionId !== snap.sessionId)].slice(0, 5);
    await this.store.write(JSON.stringify(next));
  }

  async loadHistory(): Promise<StartupTraceSnapshot[]> {
    if (!this.store) return [];
    const raw = await this.store.read();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async lastFailure(): Promise<StartupTraceSnapshot | null> {
    const history = await this.loadHistory();
    return history.find((h) => h.finalStage === "failed") ?? null;
  }
}
