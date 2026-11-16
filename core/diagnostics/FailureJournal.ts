/**
 * FailureJournal — structured failure records for repair targeting.
 * Complements RuntimeJournal (transactions) with human/agent-readable failure codes.
 */
export type FailureRecord = Readonly<{
  id: string;
  code: string;
  component: string;
  message: string;
  at: number;
  repaired: boolean;
  repairId?: string;
  details?: Readonly<Record<string, string>>;
}>;

export interface FailureStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export class FailureJournal {
  constructor(private readonly store: FailureStore, private readonly maxEntries = 100) {}

  async list(): Promise<FailureRecord[]> {
    const raw = await this.store.read();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async record(code: string, component: string, message: string, details?: Record<string, string>): Promise<FailureRecord> {
    const entry: FailureRecord = {
      id: `fail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      code,
      component,
      message,
      at: Date.now(),
      repaired: false,
      details,
    };
    const all = await this.list();
    all.unshift(entry);
    await this.store.write(JSON.stringify(all.slice(0, this.maxEntries)));
    return entry;
  }

  async markRepaired(id: string, repairId: string): Promise<void> {
    const all = await this.list();
    const idx = all.findIndex((x) => x.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], repaired: true, repairId };
    await this.store.write(JSON.stringify(all));
  }

  async openFailures(): Promise<FailureRecord[]> {
    return (await this.list()).filter((x) => !x.repaired);
  }
}
