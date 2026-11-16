import type { CapturedExchange, InterceptorStoreAdapter } from "./types";
import { sanitizeCapturedExchange } from "./InterceptorCapture";

export type SavedInterceptorSession = Readonly<{ id: string; name: string; savedAt: number; records: readonly CapturedExchange[] }>;
const MAX_ARCHIVE_CHARS = 1_500_000;
const MAX_SESSIONS = 12;
const MAX_RECORDS_PER_SESSION = 500;
type ArchiveDocument = { version: 1; sessions: SavedInterceptorSession[] };

/** Disk storage is opt-in at the explicit save action; persisted exchanges are redacted and bounded. */
export class InterceptorSessionStorage {
  private document: ArchiveDocument = { version: 1, sessions: [] };
  private loaded = false;
  private loadPromise?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly adapter?: InterceptorStoreAdapter) {}

  async list(): Promise<readonly SavedInterceptorSession[]> { await this.load(); await this.queue; return this.document.sessions.map(copySession); }
  async get(id: string): Promise<SavedInterceptorSession | undefined> { await this.load(); await this.queue; const item = this.document.sessions.find((session) => session.id === id); return item ? copySession(item) : undefined; }
  async save(name: string, input: readonly CapturedExchange[], now = Date.now()): Promise<string> {
    await this.load();
    if (!Array.isArray(input) || input.length > MAX_RECORDS_PER_SESSION) throw new Error("INTERCEPTOR_SESSION_RECORD_LIMIT");
    return this.serialize(async () => {
      const cleanName = name.trim().slice(0, 80) || `Session ${new Date(now).toISOString()}`;
      const session: SavedInterceptorSession = Object.freeze({ id: `is-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: cleanName, savedAt: now, records: input.map(sanitizeCapturedExchange) });
      const next: ArchiveDocument = { version: 1, sessions: [...this.document.sessions, session].slice(-MAX_SESSIONS) };
      while (JSON.stringify(next).length > MAX_ARCHIVE_CHARS && next.sessions.length > 1) next.sessions.shift();
      if (JSON.stringify(next).length > MAX_ARCHIVE_CHARS) throw new Error("INTERCEPTOR_SESSION_ARCHIVE_TOO_LARGE");
      await this.persist(next);
      return session.id;
    });
  }
  async remove(id: string): Promise<boolean> {
    await this.load();
    return this.serialize(async () => {
      const sessions = this.document.sessions.filter((item) => item.id !== id);
      if (sessions.length === this.document.sessions.length) return false;
      await this.persist({ version: 1, sessions }); return true;
    });
  }
  async clear(): Promise<void> { await this.load(); await this.serialize(async () => { await this.persist({ version: 1, sessions: [] }); }); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      if (!this.adapter) { this.loaded = true; return; }
      try {
        const raw = await this.adapter.read();
        if (!raw) { this.loaded = true; return; }
        if (raw.length > MAX_ARCHIVE_CHARS) throw new Error("INTERCEPTOR_SESSION_ARCHIVE_TOO_LARGE");
        const parsed = JSON.parse(raw) as Partial<ArchiveDocument>;
        if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error("INTERCEPTOR_SESSION_ARCHIVE_INVALID");
        const sessions = parsed.sessions.slice(-MAX_SESSIONS).filter(isSession).map((session) => ({ ...session, records: session.records.slice(-MAX_RECORDS_PER_SESSION).map(sanitizeCapturedExchange) }));
        this.document = { version: 1, sessions }; this.loaded = true;
      } catch (error) { throw new Error("INTERCEPTOR_SESSION_STORE_READ_FAILED", { cause: error }); }
    })();
    try { await this.loadPromise; } finally { if (!this.loaded) this.loadPromise = undefined; }
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async persist(next: ArchiveDocument): Promise<void> {
    const raw = JSON.stringify(next);
    if (raw.length > MAX_ARCHIVE_CHARS) throw new Error("INTERCEPTOR_SESSION_ARCHIVE_TOO_LARGE");
    if (this.adapter) await this.adapter.write(raw);
    this.document = next;
  }
}
function isSession(value: unknown): value is SavedInterceptorSession {
  if (!value || typeof value !== "object") return false; const session = value as Partial<SavedInterceptorSession>;
  return typeof session.id === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(session.id) && typeof session.name === "string" && session.name.length <= 80 && Number.isFinite(session.savedAt) && Array.isArray(session.records) && session.records.length <= MAX_RECORDS_PER_SESSION && session.records.every((item) => Boolean(item && typeof item === "object" && (item as CapturedExchange).request && typeof (item as CapturedExchange).request.url === "string"));
}
function copySession(session: SavedInterceptorSession): SavedInterceptorSession { return Object.freeze({ ...session, records: session.records.map(sanitizeCapturedExchange) }); }
