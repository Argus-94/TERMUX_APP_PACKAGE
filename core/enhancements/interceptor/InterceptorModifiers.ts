import type { ResponseRecord, RuleAction, SafeHeaders } from "./types";

const MAX_BODY = 1_000_000;
const UNSAFE_REGEX = /\([^)]*[+*][^)]*\)[+*{]|\([^)]*\|[^)]*\)[+*{]|\\[1-9]/;
export type ModifierResult = Readonly<{ response: ResponseRecord; modified: boolean; blocked: boolean; delayMs: number; breakpoint: boolean; error?: string }>;

/** Apply only data transformations; file/network access is always delegated to policy-checked callbacks. */
export async function applyAction(response: ResponseRecord, action: RuleAction, options?: Readonly<{
  readLocal?: (path: string) => Promise<string>;
  checkRemote?: (url: string) => Promise<boolean>;
  fetchRemote?: (url: string) => Promise<ResponseRecord>;
}>): Promise<ModifierResult> {
  let next = response; let modified = false; let blocked = false; let delayMs = 0; let breakpoint = false;
  try {
    switch (action.type) {
      case "mockResponse":
        next = { status: validStatus(action.status), headers: removeFramingHeaders(cleanHeaders(action.headers ?? {})), body: limitBody(action.body) }; modified = true; break;
      case "modifyBody": {
        const body = String(next.body ?? "");
        let result: string;
        if (action.jsonPath) result = updateJsonPath(body, action.jsonPath, action.replace);
        else if (action.regex) {
          if (!action.find || action.find.length > 200 || UNSAFE_REGEX.test(action.find)) throw new Error("REGEX_PATTERN_REJECTED");
          result = replaceRegexBounded(body, new RegExp(action.find, "g"), action.replace);
        } else result = replaceStringBounded(body, action.find, action.replace);
        next = { ...next, headers: removeFramingHeaders(cleanHeaders(next.headers)), body: limitBody(result) }; modified = result !== body; break;
      }
      case "modifyHeaders": {
        const headers: Record<string, string> = { ...cleanHeaders(next.headers) };
        for (const name of action.remove ?? []) { validateHeaderName(name); deleteHeader(headers, name); }
        for (const [name, value] of Object.entries(action.add ?? {})) { validateHeader(name, value); if (!findHeader(headers, name)) headers[name] = value; }
        for (const [name, value] of Object.entries(action.set ?? {})) { validateHeader(name, value); deleteHeader(headers, name); headers[name] = value; }
        next = { ...next, headers: removeFramingHeaders(headers) }; modified = true; break;
      }
      case "setStatusCode": next = { ...next, status: validStatus(action.status) }; modified = true; break;
      case "block": blocked = true; next = { status: 451, statusText: "Blocked by Interceptor", headers: { "content-type": "text/plain; charset=utf-8" }, body: "Request blocked by local rule." }; modified = true; break;
      case "delay": if (!Number.isInteger(action.ms) || action.ms < 0 || action.ms > 30_000) throw new Error("DELAY_OUT_OF_RANGE"); else delayMs = action.ms; break;
      case "breakpoint": breakpoint = true; break;
      case "mapLocal": {
        if (!options?.readLocal) throw new Error("MAP_LOCAL_ADAPTER_UNAVAILABLE");
        const body = await options.readLocal(action.filePath);
        next = { status: validStatus(action.status ?? 200), headers: { "content-type": safeContentType(action.contentType) }, body: limitBody(body) }; modified = true; break;
      }
      case "mapRemote": {
        let url: URL; try { url = new URL(action.targetUrl); } catch { throw new Error("MAP_REMOTE_URL_INVALID"); }
        if (url.protocol !== "https:" || url.username || url.password || !options?.checkRemote || !(await options.checkRemote(url.toString())) || !options.fetchRemote) throw new Error("MAP_REMOTE_POLICY_DENIED");
        next = await options.fetchRemote(url.toString()); modified = true; break;
      }
    }
  } catch (error) {
    return { response: next, modified, blocked, delayMs, breakpoint, error: error instanceof Error ? error.message : "MODIFIER_FAILED" };
  }
  return { response: next, modified, blocked, delayMs, breakpoint };
}

function updateJsonPath(body: string, path: string, replacement: string): string {
  if (body.length > MAX_BODY) throw new Error("BODY_TOO_LARGE");
  const segments = path.startsWith("$") ? path.replace(/^\$\.?/, "").split(".").filter(Boolean) : path.split(".").filter(Boolean);
  if (!segments.length || segments.length > 16 || segments.some((part) => !/^[A-Za-z0-9_-]{1,80}$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part))) throw new Error("JSON_PATH_INVALID");
  const root: unknown = JSON.parse(body);
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== "object" || !(segment in current)) throw new Error("JSON_PATH_NOT_FOUND");
    current = (current as Record<string, unknown>)[segment];
  }
  if (!current || typeof current !== "object" || !(segments[segments.length - 1]! in current)) throw new Error("JSON_PATH_NOT_FOUND");
  const key = segments[segments.length - 1]!;
  const old = (current as Record<string, unknown>)[key];
  let value: unknown = replacement;
  try { value = JSON.parse(replacement); } catch { /* replacement is a string when it is not JSON */ }
  if (typeof old === "string" && typeof value !== "string") value = String(value);
  (current as Record<string, unknown>)[key] = value;
  return JSON.stringify(root);
}
function validStatus(status: number): number { if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("STATUS_CODE_INVALID"); return status; }
function limitBody(body: string): string { if (typeof body !== "string" || body.length > MAX_BODY) throw new Error("BODY_TOO_LARGE"); return body; }
function validateHeaderName(name: string): void { if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) throw new Error("HEADER_NAME_INVALID"); }
function validateHeader(name: string, value: string): void { validateHeaderName(name); if (typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error("HEADER_VALUE_INVALID"); }
function cleanHeaders(input: SafeHeaders): Record<string, string> { const out: Record<string, string> = {}; for (const [name, value] of Object.entries(input)) { validateHeader(name, value); out[name] = value; } return out; }
function removeFramingHeaders(input: Record<string, string>): Record<string, string> { const out = { ...input }; for (const name of Object.keys(out)) if (["content-length", "transfer-encoding", "content-encoding"].includes(name.toLowerCase())) delete out[name]; return out; }
function findHeader(headers: Record<string, string>, name: string): string | undefined { return Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase()); }
function deleteHeader(headers: Record<string, string>, name: string): void { for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key]; }
function safeContentType(value?: string): string { return value && /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*charset=[\w-]+)?$/i.test(value) ? value : "application/octet-stream"; }
function replaceStringBounded(body: string, find: string, replace: string): string {
  if (!find) throw new Error("EMPTY_FIND_REJECTED");
  const parts: string[] = []; let cursor = 0; let total = 0;
  while (cursor < body.length) {
    const index = body.indexOf(find, cursor);
    if (index < 0) { const tail = body.slice(cursor); total += tail.length; if (total > MAX_BODY) throw new Error("BODY_TOO_LARGE"); parts.push(tail); break; }
    const prefix = body.slice(cursor, index); total += prefix.length + replace.length;
    if (total > MAX_BODY) throw new Error("BODY_TOO_LARGE");
    parts.push(prefix, replace); cursor = index + find.length;
  }
  return parts.join("");
}
function replaceRegexBounded(body: string, expression: RegExp, replace: string): string {
  const parts: string[] = []; let cursor = 0; let total = 0;
  while (true) {
    const match = expression.exec(body); if (!match) break;
    const index = match.index; if (index < cursor) continue;
    const prefix = body.slice(cursor, index); total += prefix.length + replace.length;
    if (total > MAX_BODY) throw new Error("BODY_TOO_LARGE");
    parts.push(prefix, replace);
    if (match[0].length > 0) cursor = index + match[0].length;
    else { cursor = index; expression.lastIndex = index + 1; }
  }
  const tail = body.slice(cursor); total += tail.length; if (total > MAX_BODY) throw new Error("BODY_TOO_LARGE"); parts.push(tail);
  return parts.join("");
}
