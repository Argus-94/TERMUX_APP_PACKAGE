import { DEFAULT_INTERCEPTOR_SETTINGS, type InterceptorRule, type InterceptorSettings, type InterceptorStoreAdapter } from "./types";

const MAX_STORE_CHARS = 1_000_000;
const MAX_RULES = 500;
const MAX_SESSIONS = 30;
type StoreDocument = { version: 1; settings: InterceptorSettings; rules: InterceptorRule[]; sessions: Readonly<{ id: string; name: string; savedAt: number; records: number }>[] };

/** Bounded rules/settings/session metadata store; never persists intercepted body data. */
export class InterceptorStore {
  private document: StoreDocument = { version: 1, settings: { ...DEFAULT_INTERCEPTOR_SETTINGS }, rules: [], sessions: [] };
  private loaded = false;
  private loadPromise?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly adapter?: InterceptorStoreAdapter) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      if (!this.adapter) { this.loaded = true; return; }
      try {
        const raw = await this.adapter.read();
        if (!raw) { this.loaded = true; return; }
        if (raw.length > MAX_STORE_CHARS) throw new Error("INTERCEPTOR_STORE_TOO_LARGE");
        const parsed = JSON.parse(raw) as Partial<StoreDocument>;
        if (parsed.version !== 1 || !Array.isArray(parsed.rules) || !parsed.settings || typeof parsed.settings !== "object") throw new Error("INTERCEPTOR_STORE_INVALID");
        const settings = validateSettings(parsed.settings as InterceptorSettings);
        const rules = parsed.rules.slice(0, MAX_RULES).filter(isRule);
        const sessions = Array.isArray(parsed.sessions) ? parsed.sessions.slice(-MAX_SESSIONS).filter(isSession) : [];
        this.document = { version: 1, settings, rules, sessions };
        this.loaded = true;
      } catch (error) {
        throw new Error("INTERCEPTOR_STORE_READ_FAILED", { cause: error });
      }
    })();
    try { await this.loadPromise; } finally { if (!this.loaded) this.loadPromise = undefined; }
  }
  async settings(): Promise<InterceptorSettings> { await this.load(); return { ...this.document.settings }; }
  async updateSettings(patch: Partial<InterceptorSettings>): Promise<InterceptorSettings> {
    await this.load();
    const next = validateSettings({ ...this.document.settings, ...patch });
    this.document = { ...this.document, settings: next }; await this.persist(); return { ...next };
  }
  async listRules(): Promise<readonly InterceptorRule[]> { await this.load(); return this.document.rules.map(copyRule); }
  async putRule(input: InterceptorRule): Promise<void> {
    await this.load();
    if (!isRule(input)) throw new Error("INTERCEPTOR_RULE_INVALID");
    const index = this.document.rules.findIndex((rule) => rule.id === input.id);
    if (index < 0 && this.document.rules.length >= MAX_RULES) throw new Error("INTERCEPTOR_RULE_LIMIT");
    const rules = [...this.document.rules];
    if (index < 0) rules.push(copyRule(input)); else rules[index] = copyRule(input);
    this.document = { ...this.document, rules }; await this.persist();
  }
  async removeRule(id: string): Promise<boolean> {
    await this.load(); const rules = this.document.rules.filter((rule) => rule.id !== id);
    if (rules.length === this.document.rules.length) return false;
    this.document = { ...this.document, rules }; await this.persist(); return true;
  }
  async clearRules(): Promise<void> { await this.load(); this.document = { ...this.document, rules: [] }; await this.persist(); }
  async saveSession(name: string, records: number, now = Date.now()): Promise<string> {
    await this.load();
    const cleanName = name.trim().slice(0, 80) || `Session ${new Date(now).toISOString()}`;
    if (!Number.isSafeInteger(records) || records < 0 || records > 1_000_000) throw new Error("INTERCEPTOR_SESSION_INVALID");
    const session = { id: `is-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: cleanName, savedAt: now, records };
    this.document = { ...this.document, sessions: [...this.document.sessions, session].slice(-MAX_SESSIONS) }; await this.persist(); return session.id;
  }
  async listSessions(): Promise<readonly Readonly<{ id: string; name: string; savedAt: number; records: number }>[]> { await this.load(); return this.document.sessions.map((item) => ({ ...item })); }
  async reset(): Promise<void> { this.document = { version: 1, settings: { ...DEFAULT_INTERCEPTOR_SETTINGS }, rules: [], sessions: [] }; this.loaded = true; await this.persist(); }

  private async persist(): Promise<void> {
    if (!this.adapter) return;
    const operation = this.queue.catch(() => undefined).then(async () => {
      const encoded = JSON.stringify(this.document);
      if (encoded.length > MAX_STORE_CHARS) throw new Error("INTERCEPTOR_STORE_LIMIT");
      await this.adapter!.write(encoded);
    });
    this.queue = operation.then(() => undefined, () => undefined); await operation;
  }
}

function validateSettings(value: InterceptorSettings): InterceptorSettings {
  if (!value || (value.mode !== "simple" && value.mode !== "advanced") || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !Number.isInteger(value.maxRecords) || value.maxRecords < 20 || value.maxRecords > 5000 || typeof value.autoClear !== "boolean" || !Number.isInteger(value.bodyLimitBytes) || value.bodyLimitBytes < 1024 || value.bodyLimitBytes > 2_000_000) throw new Error("INTERCEPTOR_SETTINGS_INVALID");
  if (value.mitmEnabled !== undefined && typeof value.mitmEnabled !== "boolean") throw new Error("INTERCEPTOR_SETTINGS_INVALID");
  return { mode: value.mode, port: value.port, mitmEnabled: value.mitmEnabled === true, maxRecords: value.maxRecords, autoClear: value.autoClear, bodyLimitBytes: value.bodyLimitBytes };
}
function isRule(value: unknown): value is InterceptorRule {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<InterceptorRule>;
  return typeof r.id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(r.id) && typeof r.name === "string" && r.name.trim().length > 0 && r.name.length <= 120 && typeof r.enabled === "boolean" && Number.isInteger(r.priority) && (r.priority ?? -1) >= 0 && (r.priority ?? 1001) <= 1000 && Array.isArray(r.conditions) && r.conditions.length <= 30 && r.conditions.every(isCondition) && Array.isArray(r.actions) && r.actions.length > 0 && r.actions.length <= 30 && r.actions.every(isAction) && Number.isFinite(r.createdAt) && Number.isFinite(r.updatedAt) && (r.source === "user" || r.source === "agent" || r.source === "preset");
}
function isCondition(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case "urlContains": case "urlEquals": case "methodIs": case "bodyContains": return typeof item.value === "string" && item.value.length <= 2048;
    case "urlMatches": return typeof item.value === "string" && item.value.length <= 200 && !/\([^)]*[+*][^)]*\)[+*{]|\\[1-9]/.test(item.value);
    case "headerExists": return typeof item.name === "string" && SAFE_HEADER_NAME.test(item.name);
    case "headerEquals": return typeof item.name === "string" && SAFE_HEADER_NAME.test(item.name) && typeof item.value === "string" && item.value.length <= 8192;
    case "statusCodeIs": return Number.isInteger(item.value) && Number(item.value) >= 100 && Number(item.value) <= 599;
    default: return false;
  }
}
function isAction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case "mockResponse": return Number.isInteger(item.status) && Number(item.status) >= 100 && Number(item.status) <= 599 && typeof item.body === "string" && item.body.length <= 256_000 && (item.headers === undefined || isHeaderMap(item.headers));
    case "modifyBody": return typeof item.find === "string" && item.find.length <= 2048 && (Boolean(item.jsonPath) || item.find.length > 0) && typeof item.replace === "string" && item.replace.length <= 16_000 && (item.regex === undefined || typeof item.regex === "boolean") && (item.jsonPath === undefined || (typeof item.jsonPath === "string" && item.jsonPath.length <= 512));
    case "modifyHeaders": return (item.add === undefined || isHeaderMap(item.add)) && (item.set === undefined || isHeaderMap(item.set)) && (item.remove === undefined || (Array.isArray(item.remove) && item.remove.length <= 100 && item.remove.every((name) => typeof name === "string" && SAFE_HEADER_NAME.test(name))));
    case "setStatusCode": return Number.isInteger(item.status) && Number(item.status) >= 100 && Number(item.status) <= 599;
    case "block": case "breakpoint": return true;
    case "delay": return Number.isInteger(item.ms) && Number(item.ms) >= 0 && Number(item.ms) <= 30_000;
    case "mapLocal": return typeof item.filePath === "string" && item.filePath.length <= 1024 && item.filePath.startsWith("/") && (item.status === undefined || (Number.isInteger(item.status) && Number(item.status) >= 100 && Number(item.status) <= 599));
    case "mapRemote": try { const url = new URL(String(item.targetUrl)); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
    default: return false;
  }
}
const SAFE_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
function isHeaderMap(value: unknown): boolean { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.entries(value as Record<string, unknown>).length <= 100 && Object.entries(value as Record<string, unknown>).every(([name, item]) => SAFE_HEADER_NAME.test(name) && typeof item === "string" && item.length <= 8192 && !/[\r\n\0]/.test(item))); }
function isSession(value: unknown): value is StoreDocument["sessions"][number] { const s = value as { id?: unknown; name?: unknown; savedAt?: unknown; records?: unknown }; return Boolean(s && typeof s.id === "string" && typeof s.name === "string" && Number.isFinite(s.savedAt) && Number.isInteger(s.records)); }
function copyRule(rule: InterceptorRule): InterceptorRule { return { ...rule, conditions: rule.conditions.map((item) => ({ ...item })), actions: rule.actions.map((item) => ({ ...item })) }; }
