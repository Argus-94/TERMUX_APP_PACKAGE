import { errorMessage, errorName } from "./error-utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistAsyncStorageItem } from "./persistence";
import { redactBuildDiagnostics, redactPersistentLogPayload, redactSecrets } from "./log-redaction";
import { buildDiagnosticTraceRecord, classifyDiagnosticError, createTraceCorrelationId, type DiagnosticTraceInput } from "./diagnostic-trace";

/**
 * Единый лог приложения: UI, Termux, сети, краши, агент.
 * Переживает перезапуск (AsyncStorage). Пишет всё без «тихих» пропусков.
 *
 * v1.8.46+: structured fields (correlationId, action, errorCategory, exitCode,
 * path, stackPreview, meta) so the agent can self-correct from the log:
 * reconstruct what failed, where, with which command/exit code, and which
 * repair cluster applies — without inventing context.
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

/** Optional structured context attached to a log line for agent self-repair. */
export type LogEntryMeta = {
  correlationId?: string;
  action?: string;
  errorCategory?: string;
  exitCode?: number;
  path?: string;
  cwd?: string;
  stackPreview?: string;
  attempt?: number;
  durationMs?: number;
  recipeId?: string;
  failureCluster?: string;
  /** Free-form short key=value pairs (already redacted by caller when needed). */
  extra?: Record<string, string | number | boolean | null>;
};

export interface LogEntry {
  id: string;
  level: LogLevel;
  tag: string;
  message: string;
  timestamp: number;
  sessionId?: string;
  source?: "app" | "termux" | "linux" | "native" | "console" | "network" | "agent";
  /** Structured fields for agent self-correction (optional, backward-compatible). */
  correlationId?: string;
  action?: string;
  errorCategory?: string;
  exitCode?: number;
  path?: string;
  stackPreview?: string;
  meta?: Record<string, string | number | boolean | null>;
}

const STORAGE_KEY = "aibuilder.log.persistent.v2";
/** Ограничиваем и количество записей, и общий объём, чтобы AsyncStorage не переполнялся. */
const MAX_ENTRIES = 8000;
const MAX_PERSISTED_CHARS = 5_000_000;
/** Одна запись может быть большой (например, Gradle/Termux), но не бесконечной. */
const MAX_MESSAGE_CHARS = 250_000;

type Listener = (entries: LogEntry[]) => void;


function isTraceScreen(value: string): value is import("./diagnostic-trace").TraceScreen {
  return ["app", "runtime", "termux", "packages", "github", "settings", "chat", "build", "unknown"].includes(value);
}
function sanitizeMetaRecord(
  meta: unknown
): Record<string, string | number | boolean | null> | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  let n = 0;
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (n >= 24) break;
    const key = String(k).slice(0, 64);
    if (typeof v === "string") {
      out[key] = redactBuildDiagnostics(v).slice(0, 500);
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[key] = v;
    } else {
      continue;
    }
    n += 1;
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizePersistedEntry(value: unknown): LogEntry | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Partial<LogEntry>;
  if (typeof e.id !== "string" || typeof e.message !== "string" || typeof e.timestamp !== "number") return null;
  const tag = redactBuildDiagnostics(String(e.tag || "App"));
  const entry: LogEntry = {
    id: e.id,
    level: e.level === "warn" || e.level === "error" || e.level === "debug" ? e.level : "info",
    tag,
    message: redactPersistentLogPayload(tag, e.message),
    timestamp: e.timestamp,
    sessionId: typeof e.sessionId === "string" ? redactBuildDiagnostics(e.sessionId) : undefined,
    source: e.source,
  };
  if (typeof e.correlationId === "string") entry.correlationId = redactBuildDiagnostics(e.correlationId).slice(0, 128);
  if (typeof e.action === "string") entry.action = redactBuildDiagnostics(e.action).slice(0, 128);
  if (typeof e.errorCategory === "string") entry.errorCategory = String(e.errorCategory).slice(0, 64);
  if (typeof e.exitCode === "number" && Number.isFinite(e.exitCode)) entry.exitCode = e.exitCode;
  if (typeof e.path === "string") entry.path = redactBuildDiagnostics(e.path).slice(0, 512);
  if (typeof e.stackPreview === "string") entry.stackPreview = redactBuildDiagnostics(e.stackPreview).slice(0, 2000);
  const meta = sanitizeMetaRecord(e.meta);
  if (meta) entry.meta = meta;
  return entry;
}

/** Format structured meta into a single log-message suffix (key=value …). */
export function formatLogMeta(meta?: LogEntryMeta | null): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.correlationId) parts.push(`correlationId=${meta.correlationId}`);
  if (meta.action) parts.push(`action=${meta.action}`);
  if (meta.errorCategory) parts.push(`errorCategory=${meta.errorCategory}`);
  if (meta.exitCode != null) parts.push(`exitCode=${meta.exitCode}`);
  if (meta.path) parts.push(`path=${meta.path}`);
  if (meta.cwd) parts.push(`cwd=${meta.cwd}`);
  if (meta.attempt != null) parts.push(`attempt=${meta.attempt}`);
  if (meta.durationMs != null) parts.push(`durationMs=${meta.durationMs}`);
  if (meta.recipeId) parts.push(`recipeId=${meta.recipeId}`);
  if (meta.failureCluster) parts.push(`failureCluster=${meta.failureCluster}`);
  if (meta.stackPreview) parts.push(`stack=${meta.stackPreview.slice(0, 400)}`);
  if (meta.extra) {
    for (const [k, v] of Object.entries(meta.extra)) {
      if (v === undefined) continue;
      parts.push(`${k}=${v === null ? "null" : String(v)}`);
    }
  }
  return parts.length ? " " + parts.join(" ") : "";
}

/** Public helper for export / share paths (same rules as storage). */
export function redactLogText(value: string): string {
  return redactBuildDiagnostics(value);
}

function trimToStorageBudget(entries: LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  let chars = 2;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const cost = entry.message.length + entry.tag.length + (entry.sessionId?.length || 0) + 160;
    if (out.length > 0 && chars + cost > MAX_PERSISTED_CHARS) break;
    out.push(entry);
    chars += cost;
    if (out.length >= MAX_ENTRIES) break;
  }
  return out.reverse();
}

class PersistentLogger {
  private entries: LogEntry[] = [];
  private listeners = new Set<Listener>();
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistQueued = false;
  private sessionId = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private consoleInstalled = false;
  private globalHandlersInstalled = false;
  private fetchInstalled = false;
  private clearedBeforeHydrate = false;

  hydrate(): Promise<void> {
    if (this.hydratePromise) return this.hydratePromise;
    this.hydratePromise = (async () => {
      try {
        // v2, затем fallback v1
        let raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) raw = await AsyncStorage.getItem("aibuilder.log.persistent.v1");
        if (raw && !this.clearedBeforeHydrate) {
          if (raw.length > MAX_PERSISTED_CHARS * 2) {
            // Corrupt/oversized blob — drop rather than OOM on parse
            try { await AsyncStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
            raw = null as any;
          }
        }
        if (raw && !this.clearedBeforeHydrate) {
          const parsed = JSON.parse(raw) as unknown[];
          if (Array.isArray(parsed)) {
            // Re-redact legacy v1/v2 records on hydration: older builds may
            // have persisted a token before the stronger redaction rules.
            const incoming = trimToStorageBudget(
              parsed.map(sanitizePersistedEntry).filter((e): e is LogEntry => !!e)
            );
            const existing = this.entries;
            const seen = new Set(existing.map((e) => e.id));
            this.entries = trimToStorageBudget([...incoming, ...existing.filter((e) => !seen.has(e.id))]);
            // Persist only the sanitized representation; remove the legacy
            // copy so a future downgrade/restart cannot resurrect raw v1 data.
            persistAsyncStorageItem(STORAGE_KEY, JSON.stringify(this.entries));
            void AsyncStorage.removeItem("aibuilder.log.persistent.v1").catch((error: unknown) => console.warn(`[AIB][storage] AsyncStorage remove failed for aibuilder.log.persistent.v1: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
      } catch {
        // ignore
      } finally {
        this.hydrated = true;
        this.notify();
      }
    })();
    return this.hydratePromise;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  startSession(reason = "startup") {
    this.sessionId = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.add("info", "AppSession", `SESSION_START id=${this.sessionId} reason=${reason}`, "app");
  }

  isHydrated(): boolean {
    return this.hydrated;
  }

  getAll(): LogEntry[] {
    return this.entries;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) listener(this.entries);
  }

  private schedulePersist() {
    this.persistQueued = true;
    if (this.persistTimer) return;
    // debounce 400ms — при лавине записей (Termux stdout) не убиваем AsyncStorage
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.persistQueued) return;
      this.persistQueued = false;
      persistAsyncStorageItem(STORAGE_KEY, JSON.stringify(trimToStorageBudget(this.entries)));
    }, 400);
  }

  add(
    level: LogLevel,
    tag: string,
    message: string,
    source: LogEntry["source"] = "app",
    structured?: LogEntryMeta | null
  ) {
    const safeTag = redactBuildDiagnostics(tag || "App");
    const metaSuffix = formatLogMeta(structured);
    const full = redactPersistentLogPayload(safeTag, (message ?? "") + metaSuffix);
    // Termux (and agent shell) must not lose output: split into sequential
    // entries instead of truncating a single message.
    const chunks: string[] =
      full.length <= MAX_MESSAGE_CHARS
        ? [full]
        : (() => {
            const out: string[] = [];
            let offset = 0;
            let part = 1;
            const total = Math.ceil(full.length / MAX_MESSAGE_CHARS);
            while (offset < full.length) {
              const piece = full.slice(offset, offset + MAX_MESSAGE_CHARS);
              out.push(
                total > 1
                  ? `[part ${part}/${total}]\n${piece}`
                  : piece
              );
              offset += MAX_MESSAGE_CHARS;
              part += 1;
            }
            return out;
          })();

    let next = this.entries;
    const ts = Date.now();
    const baseMeta = structured
      ? sanitizeMetaRecord({
          ...(structured.extra || {}),
          ...(structured.cwd ? { cwd: structured.cwd } : {}),
          ...(structured.attempt != null ? { attempt: structured.attempt } : {}),
          ...(structured.durationMs != null ? { durationMs: structured.durationMs } : {}),
          ...(structured.recipeId ? { recipeId: structured.recipeId } : {}),
          ...(structured.failureCluster ? { failureCluster: structured.failureCluster } : {}),
        })
      : undefined;
    for (let i = 0; i < chunks.length; i++) {
      const entry: LogEntry = {
        id: `${ts}-${Math.random().toString(36).slice(2, 10)}-${i}`,
        level,
        tag: safeTag,
        message: chunks[i],
        timestamp: ts + i,
        sessionId: redactBuildDiagnostics(this.sessionId),
        source,
      };
      if (structured?.correlationId) entry.correlationId = redactBuildDiagnostics(structured.correlationId).slice(0, 128);
      if (structured?.action) entry.action = redactBuildDiagnostics(structured.action).slice(0, 128);
      if (structured?.errorCategory) entry.errorCategory = String(structured.errorCategory).slice(0, 64);
      if (structured?.exitCode != null && Number.isFinite(structured.exitCode)) entry.exitCode = structured.exitCode;
      if (structured?.path) entry.path = redactBuildDiagnostics(structured.path).slice(0, 512);
      if (structured?.stackPreview && i === 0) entry.stackPreview = redactBuildDiagnostics(structured.stackPreview).slice(0, 2000);
      if (baseMeta) entry.meta = baseMeta;
      next = trimToStorageBudget([...next, entry]);
    }
    this.entries = next;
    this.notify();
    this.schedulePersist();
  }

  /**
   * Agent-oriented error log: captures error category, optional stack, path,
   * exit code, and correlation so self-repair can map log → recipe without
   * guessing. Prefer this over bare add("error", ...) when handling failures
   * the agent may later need to diagnose from the log alone.
   */
  logAgentError(
    tag: string,
    message: string,
    error?: unknown,
    opts?: {
      correlationId?: string;
      action?: string;
      path?: string;
      cwd?: string;
      exitCode?: number;
      attempt?: number;
      recipeId?: string;
      failureCluster?: string;
      extra?: Record<string, string | number | boolean | null>;
      source?: LogEntry["source"];
    }
  ) {
    const category = classifyDiagnosticError(error ?? message);
    let stackPreview: string | undefined;
    if (error instanceof Error && typeof error.stack === "string") {
      stackPreview = error.stack
        .split("\n")
        .slice(0, 8)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" | ")
        .slice(0, 800);
    }
    const detail = error != null ? ` err=${errorName(error) || "Error"}:${errorMessage(error).slice(0, 400)}` : "";
    this.add(
      "error",
      tag || "Agent",
      `${message}${detail}`,
      opts?.source || "agent",
      {
        correlationId: opts?.correlationId || createTraceCorrelationId(opts?.action || tag || "agent.error"),
        action: opts?.action,
        errorCategory: category,
        path: opts?.path,
        cwd: opts?.cwd,
        exitCode: opts?.exitCode,
        attempt: opts?.attempt,
        recipeId: opts?.recipeId,
        failureCluster: opts?.failureCluster,
        stackPreview,
        extra: opts?.extra,
      }
    );
  }

  /**
   * Structured agent step (command / tool / decision) for self-correction trails.
   * Always includes correlationId so related lines can be regrouped from the log.
   */
  logAgentStep(
    summary: string,
    opts?: {
      level?: LogLevel;
      tag?: string;
      correlationId?: string;
      action?: string;
      path?: string;
      cwd?: string;
      exitCode?: number;
      ok?: boolean;
      durationMs?: number;
      command?: string;
      stdoutPreview?: string;
      stderrPreview?: string;
      recipeId?: string;
      failureCluster?: string;
      extra?: Record<string, string | number | boolean | null>;
      source?: LogEntry["source"];
    }
  ) {
    const level: LogLevel =
      opts?.level ||
      (opts?.ok === false || (opts?.exitCode != null && opts.exitCode !== 0) ? "error" : "info");
    const parts = [summary];
    if (opts?.command) parts.push(`cmd=${String(opts.command).slice(0, 300)}`);
    if (opts?.stdoutPreview) parts.push(`stdout=${String(opts.stdoutPreview).slice(0, 200)}`);
    if (opts?.stderrPreview) parts.push(`stderr=${String(opts.stderrPreview).slice(0, 300)}`);
    if (opts?.ok != null) parts.push(`ok=${opts.ok}`);
    this.add(
      level,
      opts?.tag || "AgentStep",
      parts.join(" "),
      opts?.source || "agent",
      {
        correlationId: opts?.correlationId || createTraceCorrelationId(opts?.action || "agent.step"),
        action: opts?.action,
        path: opts?.path,
        cwd: opts?.cwd,
        exitCode: opts?.exitCode,
        durationMs: opts?.durationMs,
        recipeId: opts?.recipeId,
        failureCluster: opts?.failureCluster,
        errorCategory:
          opts?.ok === false || (opts?.exitCode != null && opts.exitCode !== 0)
            ? classifyDiagnosticError(opts?.stderrPreview || summary)
            : undefined,
        extra: opts?.extra,
      }
    );
  }

  /** Persist allowlisted lifecycle metadata only; never accept payloads, commands, URLs, or raw errors. */
  trace(event: DiagnosticTraceInput) {
    const record = buildDiagnosticTraceRecord({
      correlationId: event.correlationId || createTraceCorrelationId(event.action),
      ...event,
    });
    // v407: exit code 1 of a shell probe (`test -f`, `command -v`, grep) and rate limits (429)
    // are expected, recoverable outcomes — log them as warnings, not as errors.
    const recr = record as unknown as { action?: string; exitCode?: number; httpStatus?: number };
    const expectedFailure = record.status === "failed" &&
      ((typeof recr.action === "string" && recr.action.startsWith("command.") && recr.exitCode === 1) || recr.httpStatus === 429);
    const level = expectedFailure ? "warn"
      : record.status === "failed" || record.status === "timed_out" ? "error"
      : record.status === "blocked" || record.status === "cancelled" ? "warn"
        : record.status === "started" || record.status === "progress" ? "debug" : "info";
    const source: LogEntry["source"] = record.backend === "termux" ? "termux"
      : record.backend === "ubuntu-proot" ? "linux"
        : record.backend === "provider" || record.backend === "github" ? "network" : "app";
    this.add(level, "Trace", JSON.stringify(record), source);
    return record;
  }

  /** Принудительно сбросить на диск (перед тяжёлой операцией / крашем). */
  flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistQueued = false;
    persistAsyncStorageItem(STORAGE_KEY, JSON.stringify(trimToStorageBudget(this.entries)));
  }

  installRuntimeCapture() {
    if (this.globalHandlersInstalled) return;
    this.globalHandlersInstalled = true;
    this.startSession("runtime-init");

    // JS console: capture what normally disappears from the in-app log.
    if (!this.consoleInstalled && typeof console !== "undefined") {
      this.consoleInstalled = true;
      const c = console as any;
      for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        const original = c[level];
        if (typeof original !== "function") continue;
        c[level] = (...args: any[]) => {
          try {
            const errorCategories = args.filter((x) => x instanceof Error).map((x) => classifyDiagnosticError(x));
            const textChars = args.reduce((sum, x) => sum + (typeof x === "string" ? x.length : x instanceof Error ? String(x.message || "").length : 16), 0);
            const traceId = createTraceCorrelationId("console");
            this.trace({ correlationId: traceId, action: "console.capture", step: `console.${level}`, status: level === "error" ? "failed" : "progress", backend: "app", screen: "app", ...(errorCategories[0] ? { errorCategory: errorCategories[0] } : {}) });
            this.add(level === "error" ? "error" : level === "warn" ? "warn" : level === "debug" ? "debug" : "info", "Console", `level=${level} argCount=${args.length} textChars=${Math.min(textChars, 1_000_000)}${errorCategories.length ? ` errorCategories=${[...new Set(errorCategories)].join(",")}` : ""}`, "console");
          } catch {}
          try { original.apply(console, args); } catch {}
        };
      }
    }

    // Capture every JS fetch without recording request bodies/authorization.
    try {
      const g: any = globalThis as any;
      if (!this.fetchInstalled && typeof g.fetch === "function") {
        this.fetchInstalled = true;
        const originalFetch = g.fetch.bind(g);
        g.fetch = async (input: any, init?: any) => {
          const candidateMethod = String(init?.method || input?.method || "GET").toUpperCase();
          const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(candidateMethod) ? candidateMethod : "OTHER";
          const started = Date.now();
          const correlationId = createTraceCorrelationId("fetch");
          this.trace({ correlationId, action: "network.fetch", step: "fetch.start", status: "started", backend: "provider", screen: "unknown" });
          this.add("debug", "Network", `→ ${method} endpoint=remote correlationId=${correlationId}`, "network");
          try {
            const response = await originalFetch(input, init);
            const durationMs = Date.now() - started;
            this.trace({ correlationId, action: "network.fetch", step: "fetch.result", status: response.ok ? "succeeded" : "failed", backend: "provider", screen: "unknown", durationMs, httpStatus: response.status, ...(!response.ok ? { errorCategory: "http-error" as const } : {}) });
            this.add(response.ok ? "debug" : "warn", "Network", `← ${method} endpoint=remote HTTP ${response.status} (${durationMs}ms) correlationId=${correlationId}`, "network");
            return response;
          } catch (e: unknown) {
            const durationMs = Date.now() - started;
            const errorCategory = classifyDiagnosticError(e);
            this.trace({ correlationId, action: "network.fetch", step: "fetch.result", status: "failed", backend: "provider", screen: "unknown", durationMs, errorCategory });
            this.add("error", "Network", `× ${method} endpoint=remote ${durationMs}ms errorCategory=${errorCategory} correlationId=${correlationId}`, "network");
            throw e;
          }
        };
      }
    } catch {}

    // React Native global fatal/unhandled hooks when available.
    try {
      const g: any = globalThis as any;
      const ErrorUtils = g.ErrorUtils;
      if (ErrorUtils?.setGlobalHandler && !ErrorUtils.__aibuilderWrapped) {
        const previous = ErrorUtils.getGlobalHandler?.();
        ErrorUtils.setGlobalHandler((error: any, isFatal: boolean) => {
          const errorCategory = classifyDiagnosticError(error);
          this.trace({ correlationId: createTraceCorrelationId("crash"), action: "app.exception", step: "global-handler", status: "failed", backend: "app", screen: "app", errorCategory });
          this.add("error", "GlobalError", `fatal=${!!isFatal} name=${errorName(error) || "Error"} errorCategory=${errorCategory}`, "app");
          this.flush();
          try { previous?.(error, isFatal); } catch {}
        });
        ErrorUtils.__aibuilderWrapped = true;
      }
    } catch {}

    try {
      const g: any = globalThis as any;
      const previous = g.onunhandledrejection;
      g.onunhandledrejection = (event: any) => {
        const r = event?.reason;
        const errorCategory = classifyDiagnosticError(r);
        this.trace({ correlationId: createTraceCorrelationId("rejection"), action: "app.exception", step: "unhandled-rejection", status: "failed", backend: "app", screen: "app", errorCategory });
        this.add("error", "UnhandledRejection", `name=${errorName(r) || "Error"} errorCategory=${errorCategory}`, "app");
        try { previous?.(event); } catch {}
      };
    } catch {}
  }

  markAppEvent(event: string, details?: unknown) {
    const eventName = /^[A-Z][A-Z0-9_]{1,63}$/.test(String(event)) ? String(event) : "APP_EVENT";
    const record = details && typeof details === "object" ? details as Record<string, unknown> : {};
    const safeScreen = typeof record.screen === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(record.screen) ? record.screen : "app";
    const safeAddon = typeof record.addon === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(record.addon) ? record.addon : undefined;
    const safeVersion = typeof record.version === "string" && /^v?\d{1,3}(?:\.\d{1,3}){0,3}(?:[-+][A-Za-z0-9.-]{1,24})?$/.test(record.version) ? record.version : undefined;
    const safeState = typeof record.state === "string" && ["active", "inactive", "background"].includes(record.state) ? record.state : undefined;
    const safeCount = typeof record.count === "number" && Number.isFinite(record.count) && record.count >= 0 && record.count <= 1_000_000 ? Math.floor(record.count) : undefined;
    const safeDuration = typeof record.durationMs === "number" && Number.isFinite(record.durationMs) && record.durationMs >= 0 && record.durationMs <= 86_400_000 ? Math.floor(record.durationMs) : undefined;
    const ready = typeof record.ready === "boolean" ? record.ready : undefined;
    const status = /(?:CANCELLED|CANCELED)$/.test(eventName) ? "cancelled"
      : /(?:FAILED|ERROR)$/.test(eventName) ? "failed"
        : /(?:START|STARTED|REQUESTED)$/.test(eventName) ? "started" : "succeeded";
    const safeCorrelationId = createTraceCorrelationId("app-event");
    const trace = buildDiagnosticTraceRecord({
      correlationId: safeCorrelationId,
      action: "app.event",
      step: eventName,
      status,
      backend: "app",
      screen: isTraceScreen(safeScreen) ? safeScreen : undefined,
      ...(ready !== undefined ? { resultCode: ready ? "ready" as const : "unknown" as const } : {}),
      ...(safeDuration !== undefined ? { durationMs: safeDuration } : {}),
    });
    const safeFields = [
      `event=${eventName}`,
      `screen=${safeScreen}`,
      ...(safeAddon ? [`addon=${safeAddon}`] : []),
      ...(safeVersion ? [`version=${safeVersion}`] : []),
      ...(safeState ? [`state=${safeState}`] : []),
      ...(safeCount !== undefined ? [`count=${safeCount}`] : []),
      ...(ready !== undefined ? [`ready=${ready}`] : []),
      ...(safeDuration !== undefined ? [`durationMs=${safeDuration}`] : []),
      ...(Array.isArray(record.reasons) ? [`reasonCount=${Math.min(record.reasons.length, 100)}`] : []),
    ];
    this.add("info", "AppEvent", `${JSON.stringify(trace)} ${safeFields.join(" ")}`, "app");
  }

  markModelRequest(provider: string, model: string, messages: Array<{ role?: string; content?: unknown }> | undefined, bodyBytes: number, workflow = "chat", subagent = false, attempt = 1, fileType?: string, fileSize?: number) {
    let selectedTextBytes = 0;
    let messagesCount = 0;
    try {
      messagesCount = Array.isArray(messages) ? messages.length : 0;
      selectedTextBytes = Array.isArray(messages)
        ? messages.reduce((sum, m) => sum + (typeof m?.content === "string" ? m.content.length : JSON.stringify(m?.content ?? "").length), 0)
        : 0;
    } catch {}
    const estimatedTokens = Math.ceil(selectedTextBytes / 4);
    this.add(
      "info",
      "ModelRequest",
      `provider=${redactSecrets(provider)} model=${redactSecrets(model)} fileType=${fileType || "none"} fileSize=${fileSize ?? 0} selectedTextBytes=${selectedTextBytes} estimatedTokens=${estimatedTokens} messages=${messagesCount} bodyBytes=${bodyBytes} workflow=${redactSecrets(workflow)} subagent=${!!subagent} attempt=${attempt}`,
      "agent"
    );
  }

  /** Log response metadata only; provider output may contain private text or echoed credentials. */
  markModelResponse(provider: string, model: string, content: string, durationMs?: number, meta?: string) {
    const text = content ?? "";
    this.add(
      "info",
      "ModelResponse",
      `provider=${redactSecrets(provider)} model=${redactSecrets(model)}` +
        (durationMs != null ? ` ${durationMs}ms` : "") +
        (meta ? ` ${redactSecrets(meta)}` : "") +
        ` chars=${text.length}`,
      "agent"
    );
  }

  markNetwork(method: string, url: string, details?: unknown) {
    // The URL and arbitrary detail object may disclose private hosts, paths, or payloads.
    this.add("debug", "Network", `${String(method).toUpperCase()} endpoint=remote details=${details === undefined ? "none" : "omitted"}`, "network");
  }

  clear() {
    this.clearedBeforeHydrate = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistQueued = false;
    this.entries = [];
    this.notify();
    void AsyncStorage.removeItem(STORAGE_KEY).catch((error: unknown) => console.warn(`[AIB][storage] AsyncStorage remove failed for ${STORAGE_KEY}: ${error instanceof Error ? error.message : String(error)}`));
    void AsyncStorage.removeItem("aibuilder.log.persistent.v1").catch((error: unknown) => console.warn(`[AIB][storage] AsyncStorage remove failed for aibuilder.log.persistent.v1: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export const persistentLogger = new PersistentLogger();
persistentLogger.installRuntimeCapture();
