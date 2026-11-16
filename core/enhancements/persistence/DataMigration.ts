import { PersistenceError, type MigrationEntry, type MigrationReceipt } from "./types";
import { UninstallSafeStore } from "./UninstallSafeStore";

type JournalEntry = MigrationReceipt["entries"][number];
type MigrationJournal = Readonly<{
  version: 1;
  id: string;
  mode: "apply" | "rollback";
  entries: readonly JournalEntry[];
}>;

const MAX_ENTRIES = 1000;
const MAX_KEY_LENGTH = 180;
const MAX_CONTENT_LENGTH = 1_000_000;
const RESERVED_PREFIX = "migrations/";
const SECRET_VALUE = /(?:-----BEGIN\s+(?:(?:RSA|EC|OPENSSH|DSA)\s+)?PRIVATE\s+KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|aib_[A-Za-z0-9_-]{8,}[0-9]{10,13}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{12,})\b)/i;
const SECRET_ASSIGNMENT = /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret|authorization|credential|private[_ -]?key)["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/gi;

/**
 * Copies legacy records into durable storage using a write-ahead recovery journal.
 * Source values are never deleted. Interrupted writes are restored before a retry;
 * explicit rollback is also restart-safe and can be retried after provider failures.
 */
export class DataMigration {
  private readonly applied = new Map<string, MigrationReceipt>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly store: UninstallSafeStore, private readonly now: () => number = Date.now) {}

  /**
   * Idempotently migrate an allowlisted set of non-secret values. A durable pending
   * journal is committed before the first destination is modified.
   */
  async migrate(migrationId: string, entries: readonly MigrationEntry[]): Promise<MigrationReceipt> {
    this.validateInput(migrationId, entries);
    return this.serialize(migrationId, () => this.migrateExclusive(migrationId, entries));
  }

  private async migrateExclusive(migrationId: string, entries: readonly MigrationEntry[]): Promise<MigrationReceipt> {
    this.validateInput(migrationId, entries);
    const committed = await this.readCommitted(migrationId);
    const pending = await this.readJournal(migrationId);
    if (!pending) {
      const inMemory = this.applied.get(migrationId);
      if (inMemory) return inMemory;
    }
    if (pending) {
      if (committed && pending.mode === "apply") {
        // Commit succeeded but removing the apply journal did not. The committed
        // receipt is authoritative; deleting only the stale marker is safe.
        await this.removeJournal(migrationId);
        this.applied.set(migrationId, committed);
        return committed;
      }
      await this.restorePrevious(pending.entries);
      if (pending.mode === "rollback") await this.removeCommitted(migrationId);
      await this.removeJournal(migrationId);
    }
    if (committed && !pending) {
      this.applied.set(migrationId, committed);
      return committed;
    }

    const previous = await this.capturePrevious(entries);
    if (previous.some((item) => item.previous !== null && hasSecretContent(item.previous))) {
      throw new PersistenceError("MIGRATION_RECEIPT_INVALID", "Existing durable data contains credential-like content; no migration writes were started");
    }
    const journal: MigrationJournal = Object.freeze({
      version: 1,
      id: migrationId,
      mode: "apply",
      entries: Object.freeze(previous.map((item) => Object.freeze(item))),
    });
    await this.writeJournal(journal);

    try {
      for (const entry of entries) {
        const existing = await this.store.read(entry.key, entry.visibility);
        if (existing !== entry.contents) await this.store.write(entry.key, entry.contents, entry.visibility);
      }
    } catch {
      await this.recoverFailedApply(journal);
      throw new PersistenceError("MIGRATION_FAILED", "Data migration failed; a recovery journal was retained if rollback was incomplete");
    }

    const receipt: MigrationReceipt = Object.freeze({
      id: migrationId,
      committedAt: this.now(),
      entries: Object.freeze(previous.map((item) => Object.freeze(item))),
    });
    try {
      await this.store.write(this.committedKey(migrationId), JSON.stringify(receipt), "private");
    } catch {
      await this.recoverFailedApply(journal);
      throw new PersistenceError("MIGRATION_FAILED", "Migration receipt could not be committed; previous values were restored where storage remained available");
    }

    this.applied.set(migrationId, receipt);
    try { await this.removeJournal(migrationId); } catch { /* committed receipt makes a stale apply journal harmless */ }
    return receipt;
  }

  /**
   * Restore the values captured by a migration receipt. The rollback intent is
   * durably journaled first so a process crash or SAF failure can be retried.
   */
  async rollback(receipt: MigrationReceipt): Promise<void> {
    if (!receipt || !/^[A-Za-z0-9_-]{1,80}$/.test(receipt.id) || !Array.isArray(receipt.entries)) {
      throw new PersistenceError("MIGRATION_RECEIPT_INVALID");
    }
    return this.serialize(receipt.id, () => this.rollbackExclusive(receipt));
  }

  private async rollbackExclusive(receipt: MigrationReceipt): Promise<void> {
    if (!receipt || !/^[A-Za-z0-9_-]{1,80}$/.test(receipt.id) || !Array.isArray(receipt.entries)) {
      throw new PersistenceError("MIGRATION_RECEIPT_INVALID");
    }
    const current = this.applied.get(receipt.id);
    if (!current || current !== receipt || !isReceipt(receipt, receipt.id, this.store)) {
      throw new PersistenceError("MIGRATION_RECEIPT_INVALID", "Receipt was not issued by this migration manager");
    }

    const journal: MigrationJournal = Object.freeze({
      version: 1,
      id: receipt.id,
      mode: "rollback",
      entries: receipt.entries,
    });
    await this.writeJournal(journal);
    try {
      await this.restorePrevious(journal.entries);
      await this.removeCommitted(receipt.id);
      await this.removeJournal(receipt.id);
      this.applied.delete(receipt.id);
    } catch {
      throw new PersistenceError("MIGRATION_FAILED", "Migration rollback is incomplete; its recovery journal was retained for retry");
    }
  }

  private validateInput(migrationId: string, entries: readonly MigrationEntry[]): void {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(migrationId) || !Array.isArray(entries) || entries.length > MAX_ENTRIES) {
      throw new PersistenceError("MIGRATION_RECEIPT_INVALID");
    }
    const keys = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry.key !== "string" || entry.key.length > MAX_KEY_LENGTH ||
          typeof entry.contents !== "string" || entry.contents.length > MAX_CONTENT_LENGTH ||
          (entry.visibility !== "public" && entry.visibility !== "private") ||
          this.store.classify(entry.key) === "never" || isReservedKey(entry.key) || keys.has(entry.key) ||
          hasSecretContent(entry.contents)) {
        throw new PersistenceError("MIGRATION_RECEIPT_INVALID");
      }
      keys.add(entry.key);
    }
  }

  private committedKey(id: string): string { return `${RESERVED_PREFIX}${id}`; }
  private journalKey(id: string): string { return `${RESERVED_PREFIX}${id}.pending`; }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const tail = next.then(() => undefined, () => undefined);
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return next;
  }

  private async capturePrevious(entries: readonly MigrationEntry[]): Promise<JournalEntry[]> {
    try {
      const result: JournalEntry[] = [];
      for (const entry of entries) {
        result.push({ key: entry.key, previous: await this.store.read(entry.key, entry.visibility), visibility: entry.visibility });
      }
      return result;
    } catch {
      throw new PersistenceError("MIGRATION_FAILED", "Durable storage could not be read; no migration writes were started");
    }
  }

  private async readCommitted(id: string): Promise<MigrationReceipt | null> {
    let raw: string | null;
    try { raw = await this.store.read(this.committedKey(id), "private"); }
    catch { throw new PersistenceError("MIGRATION_FAILED", "Durable migration state could not be read"); }
    if (raw === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new PersistenceError("MIGRATION_RECEIPT_INVALID", "Durable migration receipt is malformed"); }
    if (!isReceipt(parsed, id, this.store)) throw new PersistenceError("MIGRATION_RECEIPT_INVALID", "Durable migration receipt is invalid");
    return parsed;
  }

  private async readJournal(id: string): Promise<MigrationJournal | null> {
    let raw: string | null;
    try { raw = await this.store.read(this.journalKey(id), "private"); }
    catch { throw new PersistenceError("MIGRATION_FAILED", "Durable migration recovery state could not be read"); }
    if (raw === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new PersistenceError("MIGRATION_RECEIPT_INVALID", "Migration recovery journal is malformed"); }
    if (!isJournal(parsed, id, this.store)) throw new PersistenceError("MIGRATION_RECEIPT_INVALID", "Migration recovery journal is invalid");
    return parsed;
  }

  private async writeJournal(journal: MigrationJournal): Promise<void> {
    try { await this.store.write(this.journalKey(journal.id), JSON.stringify(journal), "private"); }
    catch { throw new PersistenceError("MIGRATION_FAILED", "Recovery journal could not be committed; no migration writes were started"); }
  }

  private async restorePrevious(entries: readonly JournalEntry[]): Promise<void> {
    let failed = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const item = entries[i];
      try {
        if (item.previous === null) await this.store.remove(item.key, item.visibility);
        else await this.store.write(item.key, item.previous, item.visibility);
      } catch { failed = true; }
    }
    if (failed) throw new PersistenceError("MIGRATION_FAILED", "One or more prior values could not be restored");
  }

  private async recoverFailedApply(journal: MigrationJournal): Promise<void> {
    try {
      await this.restorePrevious(journal.entries);
      await this.removeJournal(journal.id);
    } catch {
      // Keep the write-ahead journal so a later invocation can safely retry recovery.
    }
  }

  private async removeCommitted(id: string): Promise<void> {
    try { await this.store.remove(this.committedKey(id), "private"); }
    catch { throw new PersistenceError("MIGRATION_FAILED", "Committed migration receipt could not be removed"); }
  }

  private async removeJournal(id: string): Promise<void> {
    try { await this.store.remove(this.journalKey(id), "private"); }
    catch { throw new PersistenceError("MIGRATION_FAILED", "Migration recovery journal could not be removed"); }
  }
}

function isEntry(value: unknown, store: UninstallSafeStore): value is JournalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as JournalEntry;
  return typeof entry.key === "string" && entry.key.length > 0 && entry.key.length <= MAX_KEY_LENGTH &&
    !isReservedKey(entry.key) && store.classify(entry.key) !== "never" &&
    (entry.previous === null || (typeof entry.previous === "string" && entry.previous.length <= MAX_CONTENT_LENGTH)) &&
    (entry.visibility === "public" || entry.visibility === "private");
}

function isReservedKey(key: string): boolean { return key === "migrations" || key.startsWith(RESERVED_PREFIX); }

/** Migration accepts only non-secret data: validate values, not just destination key names. */
function hasSecretContent(contents: string): boolean {
  if (SECRET_VALUE.test(contents)) return true;
  SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of contents.matchAll(SECRET_ASSIGNMENT)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value && !/^(?:null|undefined|\[redacted\])$/i.test(value)) return true;
  }
  return false;
}

function isReceipt(value: unknown, id: string, store: UninstallSafeStore): value is MigrationReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as MigrationReceipt;
  return receipt.id === id && Number.isFinite(receipt.committedAt) && Array.isArray(receipt.entries) &&
    receipt.entries.length <= MAX_ENTRIES && receipt.entries.every((entry) => isEntry(entry, store)) &&
    new Set(receipt.entries.map((entry) => entry.key)).size === receipt.entries.length;
}

function isJournal(value: unknown, id: string, store: UninstallSafeStore): value is MigrationJournal {
  if (!value || typeof value !== "object") return false;
  const journal = value as MigrationJournal;
  return journal.version === 1 && journal.id === id && (journal.mode === "apply" || journal.mode === "rollback") &&
    Array.isArray(journal.entries) && journal.entries.length <= MAX_ENTRIES &&
    journal.entries.every((entry) => isEntry(entry, store)) &&
    new Set(journal.entries.map((entry) => entry.key)).size === journal.entries.length;
}
