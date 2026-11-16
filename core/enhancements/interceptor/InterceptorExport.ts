import type { CapturedExchange } from "./types";
import { sanitizeBody } from "./InterceptorCapture";

const SECRET_HEADER = /(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|token|secret|password)/i;
export type ExportFormat = "har" | "json";

export function exportSession(records: readonly CapturedExchange[], format: ExportFormat, title = "AI Builder Interceptor session"): string {
  const safe = records.slice(0, 5000).map(safeExchange);
  if (format === "json") return JSON.stringify({ format: "aib-interceptor-session", version: 1, exportedAt: new Date().toISOString(), title: title.slice(0, 120), records: safe }, null, 2);
  const log = safe.map((item) => ({ startedDateTime: new Date(item.request.startedAt).toISOString(), time: item.timing.totalMs, request: { method: item.request.method, url: item.request.url, httpVersion: "HTTP/1.1", headers: Object.entries(item.request.requestHeaders).map(([name, value]) => ({ name, value })), queryString: safeQuery(item.request.url), cookies: [], headersSize: -1, bodySize: item.request.requestBody?.length ?? 0, ...(item.request.requestBody ? { postData: { mimeType: item.request.requestHeaders["content-type"] ?? "text/plain", text: item.request.requestBody } } : {}) }, response: item.response ? { status: item.response.status, statusText: item.response.statusText ?? "", httpVersion: "HTTP/1.1", headers: Object.entries(item.response.headers).map(([name, value]) => ({ name, value })), cookies: [], content: { size: item.response.body?.length ?? 0, mimeType: item.response.headers["content-type"] ?? "application/octet-stream", ...(item.response.body ? { text: item.response.body } : {}) }, redirectURL: "", headersSize: -1, bodySize: item.response.body?.length ?? 0 } : { status: 0, statusText: "No response", httpVersion: "HTTP/1.1", headers: [], cookies: [], content: { size: 0, mimeType: "application/octet-stream" }, redirectURL: "", headersSize: -1, bodySize: 0 }, cache: {}, timings: { send: 0, wait: item.timing.totalMs, receive: 0 }, _aib: { matchedRules: item.matchedRules, modified: item.modified, blocked: item.blocked } }));
  return JSON.stringify({ log: { version: "1.2", creator: { name: "AI Builder Interceptor", version: "1" }, entries: log } }, null, 2);
}
export function copyAsCurl(item: CapturedExchange): string {
  const headers = Object.entries(item.request.requestHeaders).filter(([name]) => !SECRET_HEADER.test(name)).map(([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`);
  const body = item.request.requestBody ? ` --data-raw ${shellQuote(item.request.requestBody)}` : "";
  return `curl -i -X ${shellQuote(item.request.method)} ${headers.join(" ")}${body} ${shellQuote(item.request.url)}`;
}
export function copyAsFetch(item: CapturedExchange): string {
  const headers = Object.fromEntries(Object.entries(item.request.requestHeaders).filter(([name]) => !SECRET_HEADER.test(name)));
  return `const response = await fetch(${JSON.stringify(item.request.url)}, {\n  method: ${JSON.stringify(item.request.method)},\n  headers: ${JSON.stringify(headers, null, 2)},${item.request.requestBody ? `\n  body: ${JSON.stringify(item.request.requestBody)},` : ""}\n});\nconsole.log(response.status, await response.text());`;
}
export function copyAsHttpie(item: CapturedExchange): string {
  const headers = Object.entries(item.request.requestHeaders).filter(([name]) => !SECRET_HEADER.test(name)).map(([name, value]) => `${name}:${shellQuote(value)}`);
  return `http ${shellQuote(item.request.method)} ${shellQuote(item.request.url)}${headers.length ? ` ${headers.join(" ")}` : ""}${item.request.requestBody ? ` ${shellQuote(item.request.requestBody)}` : ""}`;
}
function safeExchange(item: CapturedExchange): CapturedExchange { return { ...item, request: { ...item.request, url: sanitizeUrl(item.request.url), requestHeaders: safeHeaders(item.request.requestHeaders), ...(item.request.requestBody !== undefined ? { requestBody: sanitizeBody(item.request.requestBody) } : {}) }, ...(item.response ? { response: { ...item.response, headers: safeHeaders(item.response.headers), ...(item.response.body !== undefined ? { body: sanitizeBody(item.response.body) } : {}) } } : {}) }; }
function safeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> { return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SECRET_HEADER.test(name) ? "[REDACTED]" : value])); }
function sanitizeUrl(raw: string): string { try { const u = new URL(raw); const keys: string[] = []; u.searchParams.forEach((_value, key) => keys.push(key)); for (const key of keys) if (/(?:key|token|secret|password|signature|sig|auth|cookie)/i.test(key)) u.searchParams.set(key, "[REDACTED]"); u.username = ""; u.password = ""; return u.toString(); } catch { return raw; } }
function safeQuery(raw: string): { name: string; value: string }[] { try { const u = new URL(raw); const items: { name: string; value: string }[] = []; u.searchParams.forEach((value, name) => items.push({ name, value: /(?:key|token|secret|password|signature|sig|auth|cookie)/i.test(name) ? "[REDACTED]" : value })); return items; } catch { return []; } }
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
