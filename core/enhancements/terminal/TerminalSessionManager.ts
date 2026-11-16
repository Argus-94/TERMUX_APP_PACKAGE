import type { TerminalSessionHandle, TerminalSessionSnapshot, TerminalPreferenceStore } from "./types";
import { subscribeTerminalOutput } from "../../terminal/TerminalOutputBus.ts";
import { AI_BUILDER_SHARED_ROOT, isWithinSharedAppRoot } from "../../../lib/writable-path-policy.ts";

const STORAGE_KEY = "aib.terminal.sessions.v1";
const MAX_SESSIONS = 8;
const MAX_SCROLLBACK_CHARS = 24_000;
const SECRET_ENV_KEY = /(?:token|secret|password|credential|api[_-]?key|private[_-]?key)/i;

export type TerminalSessionHooks = Readonly<{
  createProjectSession(projectId: string, projectRoot?: string): Promise<TerminalSessionHandle>;
  restoreProjectSession?(projectId: string, cwd: string, env: Readonly<Record<string, string>>, projectRoot?: string): Promise<TerminalSessionHandle>;
  closeSession(sessionId: string): Promise<void>;
  send?(sessionId: string, text: string): Promise<void>;
  isAttached?(sessionId: string): boolean;
}>;

function safeProjectId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) && value !== "." && value !== ".."; }
function safeProjectRoot(value: unknown): value is string {
  if (typeof value !== "string" || !isWithinSharedAppRoot(value)) return false;
  const prefix = `${AI_BUILDER_SHARED_ROOT}/projects/`;
  if (!value.startsWith(prefix)) return false;
  const relative = value.slice(prefix.length);
  return relative.length > 0 && relative.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
function safeEnv(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(env).slice(0, 64)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || SECRET_ENV_KEY.test(key) || typeof value !== "string" || value.length > 2048 || value.includes("\0")) continue;
    result[key] = value;
  }
  return Object.freeze(result);
}

/** Persist bounded logical terminal context; live process ownership remains with the existing adapter. */
export class TerminalSessionManager {
  private sessions = new Map<string, TerminalSessionSnapshot>();
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly store: TerminalPreferenceStore, private readonly hooks: TerminalSessionHooks, private readonly now: () => number = Date.now) {
    // Output ownership belongs to the runtime, not the currently mounted Console screen.
    subscribeTerminalOutput((event) => {
      if (!event.sessionId || !event.data) return;
      const chunk = event.stream === "stderr" ? `\n${event.data}` : event.data;
      void this.appendScrollback(event.sessionId, chunk).catch(() => undefined);
    });
  }

  private async load(): Promise<void> {
    if (!this.loading) this.loading = (async () => {
      try {
        const raw = await this.store.get(STORAGE_KEY);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        for (const item of parsed.slice(-MAX_SESSIONS)) {
          if (!item || typeof item !== "object") continue;
          const row = item as Partial<TerminalSessionSnapshot>;
          if (typeof row.id !== "string" || typeof row.projectId !== "string" || !safeProjectId(row.projectId) || typeof row.cwd !== "string" || !row.cwd.startsWith("/") || typeof row.updatedAt !== "number") continue;
          if (row.projectRoot !== undefined && !safeProjectRoot(row.projectRoot)) continue;
          this.sessions.set(row.id, Object.freeze({ id: row.id, projectId: row.projectId, projectRoot: row.projectRoot, cwd: row.cwd.slice(0, 1024), env: safeEnv(row.env ?? {}), scrollback: typeof row.scrollback === "string" ? row.scrollback.slice(-MAX_SCROLLBACK_CHARS) : "", state: "saved", updatedAt: row.updatedAt }));
        }
      } catch { /* stale/corrupt preference data is ignored safely */ }
    })();
    await this.loading;
  }

  private async persist(): Promise<void> {
    const value = JSON.stringify([...this.sessions.values()].slice(-MAX_SESSIONS));
    const write = this.writes.catch(() => undefined).then(() => this.store.set(STORAGE_KEY, value));
    this.writes = write.catch(() => undefined);
    await write;
  }

  /** Open a project session exclusively through the existing project-scoped runtime hook. */
  async openProjectSession(projectId: string, projectRoot?: string): Promise<TerminalSessionSnapshot> {
    if (!safeProjectId(projectId)) throw new Error("TERMINAL_PROJECT_ID_INVALID");
    if (projectRoot !== undefined && !safeProjectRoot(projectRoot)) throw new Error("TERMINAL_PROJECT_ROOT_INVALID");
    await this.load();
    const handle = await this.hooks.createProjectSession(projectId, projectRoot);
    const hookProjectRoot = handle.env?.PROJECT_ROOT;
    const actualProjectRoot = projectRoot ?? (safeProjectRoot(hookProjectRoot) ? hookProjectRoot : undefined);
    const record: TerminalSessionSnapshot = Object.freeze({ id: handle.id, projectId, projectRoot: actualProjectRoot, cwd: handle.cwd, env: safeEnv(handle.env ?? {}), scrollback: this.sessions.get(handle.id)?.scrollback ?? "", state: "attached", updatedAt: this.now() });
    this.sessions.set(handle.id, record);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldestId = this.sessions.keys().next().value as string;
      await this.hooks.closeSession(oldestId).catch(() => undefined);
      this.sessions.delete(oldestId);
    }
    await this.persist();
    return record;
  }

  /** Recreate saved project sessions through the runtime adapter; never claims old processes survived restart. */
  async restoreSavedSessions(): Promise<readonly TerminalSessionSnapshot[]> {
    await this.load();
    const saved = [...this.sessions.values()].filter((row) => row.state !== "attached" || (this.hooks.isAttached && !this.hooks.isAttached(row.id)));
    const restored: TerminalSessionSnapshot[] = [];
    for (const prior of saved) { const next = await this.restoreSession(prior.id); if (next?.state === "attached") restored.push(next); }
    await this.persist();
    return restored;
  }

  /** Restore one saved profile through the existing project-scoped adapter. */
  async restoreSession(id: string, projectRootOverride?: string): Promise<TerminalSessionSnapshot | undefined> {
    await this.load();
    const prior = this.sessions.get(id);
    if (!prior) return undefined;
    if (projectRootOverride !== undefined && !safeProjectRoot(projectRootOverride)) throw new Error("TERMINAL_PROJECT_ROOT_INVALID");
    const envProjectRoot = prior.env.PROJECT_ROOT;
    const storedProjectRoot = prior.projectRoot ?? (safeProjectRoot(envProjectRoot) ? envProjectRoot : undefined);
    const projectRoot = projectRootOverride ?? storedProjectRoot;
    if (prior.state === "attached" && this.hooks.isAttached?.(prior.id) && (projectRootOverride === undefined || storedProjectRoot === projectRootOverride)) return prior;
    try {
      const handle = this.hooks.restoreProjectSession
        ? await this.hooks.restoreProjectSession(prior.projectId, prior.cwd, prior.env, projectRoot)
        : await this.hooks.createProjectSession(prior.projectId, projectRoot);
      const hookProjectRoot = handle.env?.PROJECT_ROOT;
      const actualProjectRoot = projectRoot ?? (safeProjectRoot(hookProjectRoot) ? hookProjectRoot : undefined);
      const next = Object.freeze({ ...prior, projectRoot: actualProjectRoot, id: handle.id, cwd: handle.cwd, env: safeEnv(handle.env ?? prior.env), state: "attached" as const, updatedAt: this.now() });
      this.sessions.delete(prior.id);
      this.sessions.set(next.id, next);
      await this.persist();
      return next;
    } catch {
      const unavailable = Object.freeze({ ...prior, state: "unavailable" as const, updatedAt: this.now() });
      this.sessions.set(prior.id, unavailable);
      await this.persist();
      return unavailable;
    }
  }

  /** Return saved session metadata newest-first. */
  async list(): Promise<readonly TerminalSessionSnapshot[]> { await this.load(); return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  /** Return one saved session by ID. */
  async get(id: string): Promise<TerminalSessionSnapshot | undefined> { await this.load(); return this.sessions.get(id); }

  /** Save a bounded output tail for fast tab switching without excessive storage writes. */
  async appendScrollback(id: string, text: string): Promise<void> {
    await this.load();
    const prior = this.sessions.get(id);
    if (!prior || !text) return;
    const nextText = `${prior.scrollback}${text}`.slice(-MAX_SCROLLBACK_CHARS);
    this.sessions.set(id, Object.freeze({ ...prior, scrollback: nextText, updatedAt: this.now() }));
    await this.persist();
  }

  /** Send only through the existing terminal adapter; unsupported control/PTY operations are not emulated. */
  async send(id: string, text: string, beforeSendScrollback = ""): Promise<void> {
    await this.load();
    const prior = this.sessions.get(id);
    if (!prior || !this.hooks.send) throw new Error("TERMINAL_SESSION_UNAVAILABLE");
    if (typeof text !== "string" || text.length > 16_000 || text.includes("\0")) throw new Error("TERMINAL_INPUT_INVALID");
    if (beforeSendScrollback) await this.appendScrollback(id, beforeSendScrollback);
    await this.hooks.send(id, text);
    const line = text.replace(/\r?\n$/, "");
    if (line === "cd" || line.startsWith("cd ")) {
      const latest = this.sessions.get(id) ?? prior;
      const target = line === "cd" ? latest.env.AI_BUILDER_HOME ?? latest.cwd : line.slice(3).trim() || latest.env.AI_BUILDER_HOME;
      if (target) {
        const cwd = target.startsWith("/") ? target : `${latest.cwd.replace(/\/$/, "")}/${target}`;
        this.sessions.set(id, Object.freeze({ ...latest, cwd, env: safeEnv({ ...latest.env, PWD: cwd }), updatedAt: this.now() }));
        await this.persist();
      }
    }
  }

  /** Clear one profile's persisted output tail. */
  async clearScrollback(id: string): Promise<void> {
    await this.load();
    const prior = this.sessions.get(id);
    if (!prior) return;
    this.sessions.set(id, Object.freeze({ ...prior, scrollback: "", updatedAt: this.now() }));
    await this.persist();
  }

  /** Close the logical session via the existing adapter, retaining its bounded history. */
  async close(id: string): Promise<void> {
    await this.load();
    const prior = this.sessions.get(id);
    if (!prior) return;
    await this.hooks.closeSession(id);
    this.sessions.set(id, Object.freeze({ ...prior, state: "saved", updatedAt: this.now() }));
    await this.persist();
  }
}
