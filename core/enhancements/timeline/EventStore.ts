export type TimelineActor = "agent" | "runtime" | "user" | "system";
export type TimelineLevel = "debug" | "info" | "warn" | "error";
export type TimelineEventType =
  | "task.start" | "task.finish" | "task.revert" | "checkpoint.created"
  | "container.sleep" | "container.wake" | "container.quarantine"
  | "agent.error" | "restore.started" | "restore.finished" | "policy.denied"
  | "process.started" | "process.stopped" | "process.restarted"
  | "manifest.applied" | "snapshot.created" | "snapshot.restored" | "snapshot.forked"
  | "backup.started" | "backup.finished" | "recovery.started" | "recovery.finished" | "runtime.error"
  | "bootstrap.diagnostic" | "bootstrap.progress" | "bootstrap.smart-defaults" | "backend.policy" | "performance.mode" | "device.policy"
  | "offline.agent" | "gguf.lifecycle" | "toolchain.android"
  | "network.portforward" | "network.interceptor" | "runtime.status.change" | "permissions.onboarding";
export type TimelineEventInput = Readonly<{ type: TimelineEventType; actor: TimelineActor; projectId?: string; taskId?: string; payload?: Readonly<Record<string, unknown>>; level?: TimelineLevel; ts?: number }>;
export type TimelineEvent = Readonly<{ id: string; ts: number; type: TimelineEventType; actor: TimelineActor; projectId?: string; taskId?: string; payload: Readonly<Record<string, unknown>>; level: TimelineLevel }>;
export type EventStorage = Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void> }>;
export type EventStoreErrorCode = "EVENT_INVALID" | "EVENT_STORAGE_FAILED";
export class EventStoreError extends Error { constructor(readonly code: EventStoreErrorCode, message: string) { super(message); this.name = "EventStoreError"; } }

const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential|private[_-]?key)/i;
const SECRET_VALUE = /\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g;
const SECRET_ASSIGNMENT = /((?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|auth|password|passwd|secret|credential|cookie|session)\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"'&,;]+/gi;
const SECRET_VALUE_CHECK = new RegExp(SECRET_VALUE.source, "i");
const SECRET_VALUE_WORD = /(?:^|[^A-Za-z0-9])(?:secret|token|password|credential|api[_ -]?key|private[_ -]?key|bearer)(?:$|[^A-Za-z0-9])/i;
const SAFE_CATEGORY_KEY = /^(?:action|actor|backend|capability|category|code|eventType|kind|level|mode|model|operation|permission|preset|profile|processName|provider|reasonCode|result|sha|source|state|status|taskType|tool|type|version)$/i;
const SAFE_CATEGORY_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EVENT_TYPES: ReadonlySet<string> = new Set<TimelineEventType>([
  "task.start", "task.finish", "task.revert", "checkpoint.created", "container.sleep", "container.wake", "container.quarantine",
  "agent.error", "restore.started", "restore.finished", "policy.denied", "process.started", "process.stopped", "process.restarted",
  "manifest.applied", "snapshot.created", "snapshot.restored", "snapshot.forked", "backup.started", "backup.finished",
  "recovery.started", "recovery.finished", "runtime.error", "bootstrap.diagnostic", "bootstrap.progress", "backend.policy",
  "performance.mode", "device.policy", "bootstrap.smart-defaults", "offline.agent", "gguf.lifecycle", "toolchain.android", "network.portforward",
  "network.interceptor", "runtime.status.change", "permissions.onboarding",
]);
const MAX_PERSISTED_EVENTS = 5_000;
const MAX_PERSISTED_CHARS = 2_000_000;

function scrubString(value: string): string {
  return value.replace(SECRET_VALUE, "[REDACTED]").replace(SECRET_ASSIGNMENT, "$1[REDACTED]").slice(0, 2048);
}
function containsOpaqueSecret(value: string, key: string): boolean {
  const candidates = value.match(/[A-Za-z0-9_+/-]{24,}/g) ?? [];
  return candidates.some((candidate) => {
    if (/^sha$/i.test(key) && /^[A-Fa-f0-9]{40,128}$/.test(candidate)) return false;
    if (/^[A-Fa-f0-9]{32,}$/.test(candidate)) return true;
    const classes = [/[a-z]/.test(candidate), /[A-Z]/.test(candidate), /[0-9]/.test(candidate), /[_+/-]/.test(candidate)].filter(Boolean).length;
    return classes >= 3;
  });
}
function isSafeCategoryValue(key: string, value: string): boolean {
  return SAFE_CATEGORY_KEY.test(key) && SAFE_CATEGORY_VALUE.test(value) && !SECRET_VALUE_CHECK.test(value) && !SECRET_VALUE_WORD.test(value) && !containsOpaqueSecret(value, key);
}
function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = scrubString(value.trim());
  return SAFE_IDENTIFIER.test(normalized) ? normalized : undefined;
}
function scrub(value: unknown, depth = 0, key = ""): unknown {
  if (depth > 6) return "[DEPTH_LIMIT]";
  if (typeof value === "string") {
    const normalized = scrubString(value).trim();
    // Free-form text is never persisted. Unknown secrets cannot be reliably
    // recognized from arbitrary prose, so only bounded categorical fields survive.
    return isSafeCategoryValue(key, normalized) ? normalized : "[REDACTED_TEXT]";
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => scrub(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [childKey, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      if (childKey === "__proto__" || childKey === "constructor" || childKey === "prototype") continue;
      result[childKey] = SECRET_KEY.test(childKey) ? "[REDACTED]" : scrub(item, depth + 1, childKey);
    }
    return result;
  }
  return "[REDACTED_TEXT]";
}
function normalizeStoredEvent(value: unknown): TimelineEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string" || event.id.length < 1 || event.id.length > 180 || !/^[A-Za-z0-9._:-]+$/.test(event.id)) return null;
  if (!Number.isFinite(event.ts) || typeof event.type !== "string" || !EVENT_TYPES.has(event.type)) return null;
  if (!(event.actor === "agent" || event.actor === "runtime" || event.actor === "user" || event.actor === "system")) return null;
  const level = event.level === "debug" || event.level === "warn" || event.level === "error" ? event.level : "info";
  const payload = scrub(event.payload ?? {}) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    id: event.id,
    ts: Number(event.ts),
    type: event.type as TimelineEventType,
    actor: event.actor,
    ...(safeIdentifier(event.projectId) ? { projectId: safeIdentifier(event.projectId) } : {}),
    ...(safeIdentifier(event.taskId) ? { taskId: safeIdentifier(event.taskId) } : {}),
    payload,
    level,
  });
}
function parseStoredEvents(value: string | null): TimelineEvent[] {
  if (!value) return [];
  return value.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { const event = normalizeStoredEvent(JSON.parse(line)); return event ? [event] : []; }
    catch { return []; }
  });
}
function encodeBounded(events: readonly TimelineEvent[], maxEvents: number, maxChars: number): string {
  const retained = [...events];
  const encoded = () => retained.map((event) => JSON.stringify(event));
  let lines = encoded();
  let chars = lines.reduce((sum, line) => sum + line.length + 1, 0);
  while (retained.length > 1 && (retained.length > maxEvents || chars > maxChars)) {
    chars -= lines[0].length + 1;
    retained.shift();
    lines.shift();
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Durable structured JSONL events with a bounded recent ring and bounded on-disk retention. */
export class EventStore {
  private readonly ring: TimelineEvent[] = [];
  private serial = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly storage?: EventStorage, private readonly ringCapacity = 500, private readonly now: () => number = Date.now, private readonly maxPersistedEvents = MAX_PERSISTED_EVENTS, private readonly maxPersistedChars = MAX_PERSISTED_CHARS) {
    if (!Number.isSafeInteger(ringCapacity) || ringCapacity < 1 || ringCapacity > 50_000) throw new EventStoreError("EVENT_INVALID", "Timeline ring capacity is invalid");
    if (!Number.isSafeInteger(maxPersistedEvents) || maxPersistedEvents < 1 || maxPersistedEvents > 100_000 || !Number.isSafeInteger(maxPersistedChars) || maxPersistedChars < 8192 || maxPersistedChars > 20_000_000) throw new EventStoreError("EVENT_INVALID", "Timeline retention limits are invalid");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes.catch(() => undefined).then(operation);
    this.writes = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Validate, scrub untrusted strings and durably append one bounded JSONL event. */
  async append(input: TimelineEventInput): Promise<TimelineEvent> {
    if (!input || !EVENT_TYPES.has(input.type) || !["agent", "runtime", "user", "system"].includes(input.actor) || !["debug", "info", "warn", "error"].includes(input.level ?? "info")) throw new EventStoreError("EVENT_INVALID", "Timeline event shape is invalid");
    const ts = Number.isFinite(input.ts) ? Number(input.ts) : this.now();
    const payload = scrub(input.payload ?? {}) as Readonly<Record<string, unknown>>;
    let encodedPayload = JSON.stringify(payload);
    if (encodedPayload.length > 8192) encodedPayload = JSON.stringify({ truncated: true, originalChars: encodedPayload.length });
    const event: TimelineEvent = Object.freeze({ id: `ev-${ts}-${++this.serial}-${Math.random().toString(36).slice(2, 8)}`, ts, type: input.type, actor: input.actor, ...(safeIdentifier(input.projectId) ? { projectId: safeIdentifier(input.projectId) } : {}), ...(safeIdentifier(input.taskId) ? { taskId: safeIdentifier(input.taskId) } : {}), payload: JSON.parse(encodedPayload) as Readonly<Record<string, unknown>>, level: input.level ?? "info" });
    await this.enqueue(async () => {
      if (this.storage) {
        try {
          const previous = parseStoredEvents(await this.storage.read());
          await this.storage.write(encodeBounded([...previous, event], this.maxPersistedEvents, this.maxPersistedChars));
        } catch { throw new EventStoreError("EVENT_STORAGE_FAILED", "Timeline event could not be persisted"); }
      }
      this.ring.push(event);
      if (this.ring.length > this.ringCapacity) this.ring.splice(0, this.ring.length - this.ringCapacity);
    });
    return event;
  }

  /** List durable events, sanitizing legacy rows before returning or retaining them. */
  async list(projectId?: string, since?: number, limit = 100): Promise<readonly TimelineEvent[]> {
    const events = await this.enqueue(async () => {
      if (!this.storage) return [...this.ring];
      try {
        const raw = await this.storage.read();
        const parsed = parseStoredEvents(raw);
        const normalized = encodeBounded(parsed, this.maxPersistedEvents, this.maxPersistedChars);
        if ((raw ?? "") !== normalized) await this.storage.write(normalized);
        return parsed;
      } catch { return [...this.ring]; }
    });
    const cap = Math.max(1, Math.min(1000, Math.floor(Number.isFinite(limit) ? limit : 100)));
    return events.filter((event) => (!projectId || event.projectId === projectId) && (since === undefined || event.ts >= since)).slice(-cap);
  }

  /** UI fast path for most recent events, backed by the sanitized in-memory ring. */
  recent(limit = 50): readonly TimelineEvent[] {
    const safeLimit = Math.max(1, Math.min(this.ringCapacity, Math.floor(Number.isFinite(limit) ? limit : 50)));
    return this.ring.slice(-safeLimit).reverse();
  }
}
