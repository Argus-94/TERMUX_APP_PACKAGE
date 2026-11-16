/**
 * RuntimeJournal — durable log of maintenance transactions.
 * Pending ("started") entries are recovered on next boot via RuntimeTransaction.recoverPending.
 */
export type JournalStatus = "started" | "completed" | "failed" | "rolled_back";

export type RuntimeJournalEntry = Readonly<{
  id: string;
  operation: string;
  status: JournalStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  metadata?: Readonly<Record<string, string>>;
}>;

export interface JournalStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export class RuntimeJournal {
  constructor(private readonly store: JournalStore, private readonly maxEntries = 200) {}

  async list(): Promise<RuntimeJournalEntry[]> {
    const raw = await this.store.read();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async begin(operation: string, metadata?: Record<string, string>): Promise<RuntimeJournalEntry> {
    const entry: RuntimeJournalEntry = {
      id: `j-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      operation,
      status: "started",
      startedAt: Date.now(),
      metadata,
    };
    const all = await this.list();
    all.push(entry);
    await this.store.write(JSON.stringify(all.slice(-this.maxEntries)));
    return entry;
  }

  async annotate(id: string, patch: Record<string, string>): Promise<void> {
    const all = await this.list();
    const index = all.findIndex((x) => x.id === id);
    if (index < 0) return;
    const prev = all[index].metadata ?? {};
    all[index] = { ...all[index], metadata: { ...prev, ...patch } };
    await this.store.write(JSON.stringify(all));
  }

  async finish(entry: RuntimeJournalEntry, status: Exclude<JournalStatus, "started">, error?: string): Promise<void> {
    const all = await this.list();
    const index = all.findIndex((x) => x.id === entry.id);
    if (index < 0) return;
    all[index] = {
      ...all[index],
      status,
      finishedAt: Date.now(),
      ...(error ? { error } : {}),
    };
    await this.store.write(JSON.stringify(all));
  }

  async pending(): Promise<RuntimeJournalEntry[]> {
    return (await this.list()).filter((x) => x.status === "started");
  }

  async recent(limit = 20): Promise<RuntimeJournalEntry[]> {
    const all = await this.list();
    return all.slice(-limit).reverse();
  }
}
