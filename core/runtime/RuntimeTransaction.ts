/**
 * RuntimeTransaction — exclusive maintenance unit with prepare → mutate → verify → commit|rollback.
 * Stronger than a plain lock: every long mutation is journaled and recoverable on next boot.
 * Written from scratch for AI Builder (not a port of DSHA Java classes).
 */
import { RuntimeTaskGate } from "./RuntimeTaskGate";
import { RuntimeJournal, type RuntimeJournalEntry } from "./RuntimeJournal";

export type TransactionPhase = "prepare" | "mutate" | "verify" | "commit" | "rollback";

export type TransactionContext = {
  entry: RuntimeJournalEntry;
  stage: (phase: TransactionPhase, detail?: string) => Promise<void>;
  annotate: (metadata: Record<string, string>) => Promise<void>;
  signal: { aborted: boolean };
};

export type TransactionResult<T> =
  | { ok: true; value: T; entry: RuntimeJournalEntry }
  | { ok: false; error: string; entry: RuntimeJournalEntry; rolledBack: boolean };

export class RuntimeTransaction {
  constructor(
    private readonly gate: RuntimeTaskGate,
    private readonly journal: RuntimeJournal,
    private readonly drainTimeoutMs = 15_000,
  ) {}

  /**
   * Run an exclusive maintenance transaction.
   * 1) Acquire maintenance gate (drains normal work)
   * 2) Journal begin
   * 3) body() with stage() helper
   * 4) On success → finish completed
   * 5) On failure → finish failed; optional rollbackHook
   */
  async run<T>(
    operation: string,
    body: (ctx: TransactionContext) => Promise<T>,
    options?: {
      metadata?: Record<string, string>;
      rollback?: (ctx: TransactionContext, error: unknown) => Promise<void>;
      owner?: string;
    },
  ): Promise<TransactionResult<T>> {
    const owner = options?.owner ?? operation;
    return this.gate.run("maintenance", owner, async () => {
      // Extra drain window so long-running normal tasks can finish cleanly
      const drainDeadline = Date.now() + this.drainTimeoutMs;
      while (this.gate.snapshot().normal.length > 0 && Date.now() < drainDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (this.gate.snapshot().normal.length > 0) throw new Error("MAINTENANCE_DRAIN_TIMEOUT");

      const entry = await this.journal.begin(operation, {
        ...(options?.metadata ?? {}),
        owner,
      });

      const signal = { aborted: false };
      const ctx: TransactionContext = {
        entry,
        signal,
        stage: async (phase, detail) => {
          await this.journal.annotate(entry.id, {
            phase,
            ...(detail ? { detail } : {}),
            at: String(Date.now()),
          });
        },
        annotate: async (metadata) => {
          await this.journal.annotate(entry.id, metadata);
        },
      };

      try {
        await ctx.stage("prepare");
        const value = await body(ctx);
        await ctx.stage("commit");
        await this.journal.finish(entry, "completed");
        return { ok: true, value, entry: { ...entry, status: "completed", finishedAt: Date.now() } };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        signal.aborted = true;
        let rolledBack = false;
        if (options?.rollback) {
          try {
            await ctx.stage("rollback", message);
            await options.rollback(ctx, e);
            rolledBack = true;
            await this.journal.finish(entry, "rolled_back", message);
          } catch (rbErr) {
            const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
            await this.journal.finish(entry, "failed", `${message}; rollback_failed=${rbMsg}`);
          }
        } else {
          await this.journal.finish(entry, "failed", message);
        }
        return {
          ok: false,
          error: message,
          entry: { ...entry, status: rolledBack ? "rolled_back" : "failed", finishedAt: Date.now(), error: message },
          rolledBack,
        };
      }
    });
  }

  /** Recover any journal entries left in "started" from a previous crash. */
  async recoverPending(
    handler: (entry: RuntimeJournalEntry) => Promise<"rolled_back" | "completed" | "failed">,
  ): Promise<{ recovered: number; failed: number }> {
    const pending = await this.journal.pending();
    let recovered = 0;
    let failed = 0;
    for (const entry of pending) {
      try {
        const outcome = await handler(entry);
        await this.journal.finish(entry, outcome === "completed" ? "completed" : outcome === "rolled_back" ? "rolled_back" : "failed");
        if (outcome === "failed") failed++;
        else recovered++;
      } catch (e) {
        await this.journal.finish(entry, "failed", e instanceof Error ? e.message : String(e));
        failed++;
      }
    }
    return { recovered, failed };
  }
}
