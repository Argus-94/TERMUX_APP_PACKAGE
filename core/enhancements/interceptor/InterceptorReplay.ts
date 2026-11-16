import type { InterceptorPolicy } from "./InterceptorPolicy";
import type { CapturedExchange, InterceptorSource, InterceptorTimeline, ResponseRecord, SafeHeaders } from "./types";

export type ReplayRequest = Readonly<{ url: string; method: string; headers: SafeHeaders; body?: string }>;
export type ReplayResult = Readonly<{ response: ResponseRecord; changed: Readonly<{ status: boolean; headers: boolean; body: boolean }>; durationMs: number }>;
const FORBIDDEN_HEADERS = /^(?:host|content-length|connection|transfer-encoding|proxy-authorization)$/i;
const SECRET_HEADERS = /(?:authorization|cookie|api[-_]?key|token|secret|password)/i;

/** Direct replay is explicit and policy checked; it never forwards the app's credential-proxy endpoint. */
export class InterceptorReplay {
  constructor(private readonly policy: InterceptorPolicy, private readonly fetcher: typeof fetch = fetch, private readonly record?: InterceptorTimeline) {}
  async replay(original: CapturedExchange, edit: Partial<ReplayRequest> = {}, options: Readonly<{ capability: boolean; source?: InterceptorSource }> = { capability: false }): Promise<ReplayResult> {
    const request: ReplayRequest = { url: edit.url ?? original.request.url, method: (edit.method ?? original.request.method).toUpperCase(), headers: edit.headers ?? original.request.requestHeaders, ...(edit.body !== undefined ? { body: edit.body } : original.request.requestBody !== undefined ? { body: original.request.requestBody } : {}) };
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method) || request.url.length > 4096 || (request.body?.length ?? 0) > 256_000) throw new Error("REPLAY_REQUEST_INVALID");
    const allowed = await this.policy.authorize("replay", options.source ?? "user", options.capability, request.url, { fetcher: this.fetcher });
    if (!allowed.allowed) throw new Error(allowed.reason || "INTERCEPTOR_POLICY_DENIED");
    const url = new URL(request.url);
    if (url.username || url.password) throw new Error("REPLAY_CREDENTIALS_IN_URL_DENIED");
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (FORBIDDEN_HEADERS.test(name) || SECRET_HEADERS.test(name)) continue;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || /[\r\n\0]/.test(value)) throw new Error("REPLAY_HEADER_INVALID");
      headers.set(name, value);
    }
    const started = Date.now();
    let response: Response;
    try { response = await this.fetcher(url.toString(), { method: request.method, headers, redirect: "error", ...(request.body && request.method !== "GET" && request.method !== "HEAD" ? { body: request.body } : {}) }); }
    catch { throw new Error("REPLAY_NETWORK_FAILED"); }
    const pairs: [string, string][] = []; response.headers.forEach((value, name) => { if (!SECRET_HEADERS.test(name)) pairs.push([name, value.slice(0, 8192)]); });
    const contentLength = Number(response.headers.get("content-length") ?? 0); if (contentLength > 256_000) { try { await response.body?.cancel(); } catch { /* ignore */ } throw new Error("REPLAY_RESPONSE_TOO_LARGE"); }
    const body = await readBoundedText(response, 256_000);
    const record: ResponseRecord = { status: response.status, statusText: response.statusText.slice(0, 120), headers: Object.fromEntries(pairs), body };
    const prior = original.response;
    const changed = { status: prior?.status !== record.status, headers: JSON.stringify(prior?.headers ?? {}) !== JSON.stringify(record.headers), body: (prior?.body ?? "") !== body };
    try { await this.record?.({ operation: "replay-result", outcome: "allowed", source: timelineSource(options.source ?? "user"), details: { status: record.status, durationMs: Math.max(0, Date.now() - started), changed } }); } catch { /* audit is best effort */ }
    return { response: record, changed, durationMs: Math.max(0, Date.now() - started) };
  }
}
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (typeof TextDecoder === "undefined") { const text = await response.text(); if (text.length > maxBytes) throw new Error("REPLAY_RESPONSE_TOO_LARGE"); return text; }
  const reader = response.body?.getReader(); if (!reader) { const text = await response.text(); if (text.length > maxBytes) throw new Error("REPLAY_RESPONSE_TOO_LARGE"); return text; }
  const decoder = new TextDecoder(); let output = ""; let bytes = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("REPLAY_RESPONSE_TOO_LARGE"); } output += decoder.decode(chunk.value, { stream: true }); if (output.length > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("REPLAY_RESPONSE_TOO_LARGE"); } } output += decoder.decode(); if (output.length > maxBytes) throw new Error("REPLAY_RESPONSE_TOO_LARGE"); return output; }
  finally { try { reader.releaseLock(); } catch { /* ignore */ } }
}
function timelineSource(source: InterceptorSource): "user" | "agent" { return source === "agent" ? "agent" : "user"; }
