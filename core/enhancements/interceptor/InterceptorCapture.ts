import type { CapturedExchange, RequestRecord, ResponseRecord } from "./types";

const SECRET_HEADER = /(?:authorization|proxy-authorization|(?:^|[-_])auth(?:$|[-_])|cookie|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|session)/i;
const SECRET_FIELD = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|auth|password|passwd|secret|credential|private[-_]?key|token|cookie|session)/i;
const SECRET_QUERY = /(?:^|[_-])(?:key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|authorization|auth|cookie|session|signature|sig|credential)(?:$|[_-])/i;
const MAX_BODY_CHARS = 256_000;
export type CaptureFilter = Readonly<{ query?: string; method?: string; status?: number; modified?: boolean; blocked?: boolean; contentType?: string }>;

/** Memory-first bounded traffic history. Bodies are never persisted and secret headers/query values are removed. */
export class InterceptorCapture {
  private records: CapturedExchange[] = [];
  private readonly listeners = new Set<(records: readonly CapturedExchange[]) => void>();
  private autoClear: boolean;
  constructor(private maxRecords = 300, autoClear = true) { this.autoClear = autoClear; this.setLimit(maxRecords); }
  setLimit(value: number): void { if (!Number.isInteger(value) || value < 20 || value > 5000) throw new Error("INTERCEPTOR_CAPTURE_LIMIT_INVALID"); this.maxRecords = value; this.trim(); }
  setAutoClear(value: boolean): void { this.autoClear = value; }
  subscribe(listener: (records: readonly CapturedExchange[]) => void): () => void { this.listeners.add(listener); listener(this.list()); return () => this.listeners.delete(listener); }
  record(input: Readonly<{ request: RequestRecord; response?: ResponseRecord; timing: { start: number; end: number; totalMs: number }; matchedRules?: readonly string[]; modified?: boolean; blocked?: boolean; error?: string; bytesIn?: number; bytesOut?: number }>): CapturedExchange {
    const request = sanitizeRequest(input.request); const response = input.response ? sanitizeResponse(input.response) : undefined;
    const exchange: CapturedExchange = Object.freeze({ id: input.request.id, request, ...(response ? { response } : {}), timing: { start: input.timing.start, end: input.timing.end, totalMs: Math.max(0, input.timing.totalMs) }, matchedRules: (input.matchedRules ?? []).slice(0, 50), modified: input.modified === true, blocked: input.blocked === true, ...(input.error ? { error: sanitizeBody(input.error).slice(0, 240) } : {}), bytesIn: nonNegative(input.bytesIn), bytesOut: nonNegative(input.bytesOut) });
    this.records.push(exchange); this.trim(); this.emit(); return exchange;
  }
  list(filter: CaptureFilter = {}, limit = this.maxRecords): readonly CapturedExchange[] {
    const query = (filter.query ?? "").trim().toLowerCase(); const method = filter.method?.toUpperCase();
    const matched = this.records.filter((item) => (!method || item.request.method === method) && (filter.status === undefined || item.response?.status === filter.status) && (filter.modified === undefined || item.modified === filter.modified) && (filter.blocked === undefined || item.blocked === filter.blocked) && (!filter.contentType || (item.response?.headers["content-type"] ?? "").toLowerCase().includes(filter.contentType.toLowerCase())) && (!query || [item.request.url, item.request.method, item.request.requestBody, item.response?.body].some((value) => String(value ?? "").toLowerCase().includes(query))));
    return matched.slice(-Math.max(1, Math.min(5000, Math.floor(limit)))).reverse();
  }
  get(id: string): CapturedExchange | undefined { return this.records.find((item) => item.id === id); }
  clear(): void { this.records = []; this.emit(); }
  restore(records: readonly CapturedExchange[]): void { if (!Array.isArray(records) || records.length > 5000) throw new Error("INTERCEPTOR_CAPTURE_RESTORE_INVALID"); this.records = records.slice(-this.maxRecords).map(sanitizeCapturedExchange); this.emit(); }
  clearOldest(count: number): number { const amount = Math.max(0, Math.min(this.records.length, Math.floor(count))); if (amount > 0) { this.records.splice(0, amount); this.emit(); } return amount; }
  get isAutoClearEnabled(): boolean { return this.autoClear; }
  get size(): number { return this.records.length; }
  stats(): Readonly<{ requests: number; blocked: number; modified: number; bytesIn: number; bytesOut: number; topDomains: readonly Readonly<{ host: string; count: number }>[] }> {
    const domains = new Map<string, number>(); for (const item of this.records) { try { const host = new URL(item.request.url).hostname; domains.set(host, (domains.get(host) ?? 0) + 1); } catch { /* malformed entries are already bounded */ } }
    return { requests: this.records.length, blocked: this.records.filter((item) => item.blocked).length, modified: this.records.filter((item) => item.modified).length, bytesIn: this.records.reduce((sum, item) => sum + item.bytesIn, 0), bytesOut: this.records.reduce((sum, item) => sum + item.bytesOut, 0), topDomains: [...domains].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count).slice(0, 10) };
  }
  private trim(): void { if (this.records.length <= this.maxRecords) return; const removeCount = this.autoClear ? Math.max(1, this.records.length - this.maxRecords) : this.records.length - this.maxRecords; if (removeCount > 0) this.records.splice(0, removeCount); }
  private emit(): void { const records = this.list(); for (const listener of this.listeners) { try { listener(records); } catch { /* isolate subscribers */ } } }
}
function sanitizeRequest(input: RequestRecord): RequestRecord { return { ...input, url: sanitizeUrl(input.url), method: input.method.toUpperCase().slice(0, 20), requestHeaders: sanitizeHeaders(input.requestHeaders), ...(input.requestBody !== undefined ? { requestBody: sanitizeBody(input.requestBody) } : {}) }; }
function sanitizeResponse(input: ResponseRecord): ResponseRecord { return { ...input, headers: sanitizeHeaders(input.headers), ...(input.body !== undefined ? { body: sanitizeBody(input.body) } : {}) }; }
export function sanitizeCapturedExchange(input: CapturedExchange): CapturedExchange { return Object.freeze({ ...input, request: sanitizeRequest(input.request), ...(input.response ? { response: sanitizeResponse(input.response) } : {}), timing: { start: nonNegative(input.timing.start), end: nonNegative(input.timing.end), totalMs: nonNegative(input.timing.totalMs) }, matchedRules: input.matchedRules.slice(0, 50).map((id) => String(id).slice(0, 80)), ...(input.error ? { error: input.error.slice(0, 240) } : {}) }); }
export function sanitizeBody(body: string): string {
  const bounded = body.slice(0, MAX_BODY_CHARS);
  try {
    const parsed: unknown = JSON.parse(bounded);
    const scrub = (value: unknown, depth = 0): unknown => {
      if (depth > 12) return "[DEPTH_LIMIT]";
      if (Array.isArray(value)) return value.slice(0, 1000).map((item) => scrub(item, depth + 1));
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 1000)) {
          if (!["__proto__", "prototype", "constructor"].includes(key)) out[key] = SECRET_FIELD.test(key) ? "[REDACTED]" : scrub(item, depth + 1);
        }
        return out;
      }
      return typeof value === "string" ? sanitizeSecretText(value) : value;
    };
    return JSON.stringify(scrub(parsed)).slice(0, MAX_BODY_CHARS);
  } catch {
    return sanitizeSecretText(bounded);
  }
}
function sanitizeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> { const out: Record<string, string> = {}; for (const [name, value] of Object.entries(headers).slice(0, 100)) out[name.slice(0, 128)] = SECRET_HEADER.test(name) ? "[REDACTED]" : String(value).slice(0, 8192); return out; }
function sanitizeSecretText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|authorization|auth|password|passwd|secret|token|cookie|session|credential)\s*[:=]\s*["']?)[^\s"'&,;]+/gi, "$1[REDACTED]");
}
function sanitizeUrl(raw: string): string { try { const url = new URL(raw); const keys: string[] = []; url.searchParams.forEach((_value, key) => keys.push(key)); for (const key of keys) { const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"); if (SECRET_QUERY.test(normalized)) url.searchParams.set(key, "[REDACTED]"); } url.username = ""; url.password = ""; return url.toString().slice(0, 4096); } catch { return "[INVALID_URL_REDACTED]"; } }
function nonNegative(value = 0): number { return Number.isFinite(value) ? Math.max(0, value) : 0; }
