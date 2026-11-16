import { InterceptorCapture } from "./InterceptorCapture";
import { InterceptorPolicy } from "./InterceptorPolicy";
import { InterceptorRules } from "./InterceptorRules";
import { InterceptorStore } from "./InterceptorStore";
import type { CapturedExchange, InterceptorRuntimeAdapter, InterceptorSource, InterceptorStatus, InterceptorTimeline, RequestRecord, ResponseRecord, SafeHeaders } from "./types";
import { InterceptorPathPolicy } from "./InterceptorPathPolicy";

export type InterceptorEngineSnapshot = Readonly<{ status: InterceptorStatus; enabled: boolean; port: number; address?: string; authToken?: string; mitmEnabled: boolean; error?: string }>;
export type InterceptorEngineListener = (snapshot: InterceptorEngineSnapshot) => void;
export type InterceptorPortGuard = (port: number) => Promise<boolean>;
const MAX_PROXY_BODY = 256_000;
const FORBIDDEN_REQUEST_HEADERS = /^(?:host|content-length|connection|transfer-encoding|proxy-authorization)$/i;
const SECRET_HEADER = /(?:authorization|cookie|set-cookie|api[-_]?key|token|secret|password)/i;

/** Runtime-neutral orchestration. A listener is never claimed active without an injected, verified adapter. */
export class InterceptorEngine {
  private state: InterceptorStatus = "stopped";
  private port = 8888;
  private address?: string;
  private authToken?: string;
  private mitmEnabled = false;
  private error?: string;
  private readonly listeners = new Set<InterceptorEngineListener>();
  private operation: Promise<void> = Promise.resolve();
  constructor(
    readonly store: InterceptorStore,
    readonly policy: InterceptorPolicy,
    readonly capture: InterceptorCapture,
    private readonly rules: InterceptorRules,
    private readonly adapter?: InterceptorRuntimeAdapter,
    private readonly paths?: InterceptorPathPolicy,
    private readonly record?: InterceptorTimeline,
    private readonly fetcher: typeof fetch = fetch,
    private readonly portInUse?: InterceptorPortGuard,
  ) {}

  getSnapshot(): InterceptorEngineSnapshot { return Object.freeze({ status: this.state, enabled: this.state === "listening" || this.state === "capturing", port: this.port, mitmEnabled: this.mitmEnabled, ...(this.address ? { address: this.address } : {}), ...(this.authToken ? { authToken: this.authToken } : {}), ...(this.error ? { error: this.error } : {}) }); }
  subscribe(listener: InterceptorEngineListener): () => void { this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener); }
  async initialize(): Promise<void> { await this.store.load(); const settings = await this.store.settings(); this.port = settings.port; this.capture.setLimit(settings.maxRecords); this.capture.setAutoClear(settings.autoClear); }

  private serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Called only after an explicit UI confirmation; agent calls cannot set this consent. */
  startByUser(confirmed: boolean): Promise<InterceptorEngineSnapshot> {
    return this.serializeOperation(() => this.startByUserSerialized(confirmed));
  }
  private async startByUserSerialized(confirmed: boolean): Promise<InterceptorEngineSnapshot> {
    if (!confirmed) { this.setError("USER_CONFIRMATION_REQUIRED"); await this.audit("start", "denied", "USER_CONFIRMATION_REQUIRED", "user"); return this.getSnapshot(); }
    const consent = await this.policy.confirmUserEnable(true);
    if (!consent.allowed) { this.setError(consent.reason ?? "POLICY_DENIED"); return this.getSnapshot(); }
    return this.startAuthorized("user", true);
  }
  /** Agent start requires its own network.intercept grant and a prior user consent. */
  startByAgent(capability: boolean): Promise<InterceptorEngineSnapshot> {
    return this.serializeOperation(() => this.startAuthorized("agent", capability));
  }
  private async startAuthorized(source: InterceptorSource, capability: boolean): Promise<InterceptorEngineSnapshot> {
    await this.initialize();
    const settings = await this.store.settings(); this.port = settings.port; this.capture.setLimit(settings.maxRecords);
    const checked = await this.policy.authorize("start", source, capability);
    if (!checked.allowed) { this.setError(checked.reason ?? "INTERCEPTOR_POLICY_DENIED"); return this.getSnapshot(); }
    if (this.state === "listening" || this.state === "capturing") return this.getSnapshot();
    try { if (await this.portInUse?.(this.port)) { this.setError("INTERCEPTOR_PORT_CONFLICT_WITH_PORT_FORWARD"); await this.audit("start", "denied", this.error, source); return this.getSnapshot(); } }
    catch { this.setError("INTERCEPTOR_PORT_GUARD_UNAVAILABLE"); await this.audit("start", "denied", this.error, source); return this.getSnapshot(); }
    if (!this.adapter) { this.state = "unsupported"; this.address = undefined; this.error = "VERIFIED_PROXY_ADAPTER_UNAVAILABLE"; this.emit(); await this.audit("start", "failed", this.error, source); return this.getSnapshot(); }
    this.state = "starting"; this.address = undefined; this.authToken = undefined; this.mitmEnabled = false; this.error = undefined; this.emit();
    try {
      if (settings.mitmEnabled && !(await this.policy.authorize("mitm-transport", "runtime", true, "https://transport-check.invalid/", { runtimeAdapter: this.adapter, fetcher: this.fetcher })).allowed) throw new Error("MITM_REQUIRES_VERIFIED_PINNED_ANDROID_TRANSPORT");
      const result = await this.adapter.start({ port: this.port, mitmEnabled: settings.mitmEnabled, onRequest: (request) => this.handleRequest(request) });
      if (!result.verified || result.address !== "127.0.0.1" || result.port !== this.port) throw new Error("PROXY_LISTENER_UNVERIFIED");
      if (result.authToken !== undefined && (result.authToken.length < 24 || result.authToken.length > 256 || /[^A-Za-z0-9_-]/.test(result.authToken))) throw new Error("PROXY_AUTH_TOKEN_INVALID");
      this.address = result.address; this.authToken = result.authToken; this.mitmEnabled = settings.mitmEnabled; this.state = "listening"; this.error = undefined; this.emit();
      await this.audit("start", "allowed", undefined, source); return this.getSnapshot();
    } catch (error) {
      this.state = "error"; this.address = undefined; this.authToken = undefined; this.mitmEnabled = false; this.error = error instanceof Error ? error.message.slice(0, 180) : "PROXY_START_FAILED"; this.emit();
      await this.audit("start", "failed", this.error, source); try { await this.adapter.stop(); } catch { /* best-effort partial-start cleanup */ }
      return this.getSnapshot();
    }
  }
  /** Stopping is always a fail-safe operation, including lifecycle shutdown after consent revocation. */
  stop(source: InterceptorSource | "runtime" = "user"): Promise<InterceptorEngineSnapshot> {
    return this.serializeOperation(() => this.stopSerialized(source));
  }
  private async stopSerialized(source: InterceptorSource | "runtime"): Promise<InterceptorEngineSnapshot> {
    this.state = "stopping"; this.address = undefined; this.authToken = undefined; this.mitmEnabled = false; this.error = undefined; this.emit();
    try { await this.adapter?.stop(); this.state = "stopped"; this.error = undefined; await this.audit("stop", "allowed", undefined, source); }
    catch (error) { this.state = "error"; this.error = error instanceof Error ? error.message.slice(0, 180) : "PROXY_STOP_FAILED"; await this.audit("stop", "failed", this.error, source); }
    this.emit(); return this.getSnapshot();
  }
  restartByUser(confirmed: boolean): Promise<InterceptorEngineSnapshot> {
    return this.serializeOperation(async () => { await this.stopSerialized("user"); return this.startByUserSerialized(confirmed); });
  }
  setAppState(state: "active" | "background"): void { if (state === "background" && (this.getSnapshot().enabled || this.state === "starting")) void this.stop("runtime"); }
  notifyMemoryWarning(): void { if (this.getSnapshot().enabled || this.state === "starting") void this.stop("runtime"); void this.store.settings().then((settings) => { if (settings.autoClear) this.capture.clearOldest(Math.ceil(this.capture.size / 2)); }).catch(() => undefined); }
  setPort(port: number): Promise<void> {
    return this.serializeOperation(async () => {
      if (this.getSnapshot().enabled || this.state === "starting") throw new Error("STOP_INTERCEPTOR_BEFORE_PORT_CHANGE");
      if (this.portInUse && await this.portInUse(port)) throw new Error("INTERCEPTOR_PORT_CONFLICT_WITH_PORT_FORWARD");
      const settings = await this.store.updateSettings({ port }); this.port = settings.port; this.emit();
    });
  }

  async handleAgentOperation(action: string, capability: boolean, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    const checked = await this.policy.authorize(`agent-${action}`, "agent", capability);
    if (!checked.allowed) throw new Error(checked.reason ?? "INTERCEPTOR_POLICY_DENIED");
    switch (action) {
      case "enable": return this.startByAgent(capability);
      case "disable": return this.stop("agent");
      case "last": return this.capture.list({}, boundedInt(args.limit, 10, 1, 50)).map(summary);
      case "detail": { const id = stringArg(args.id, 100); const item = this.capture.get(id); if (!item) throw new Error("INTERCEPTOR_RECORD_NOT_FOUND"); return item; }
      default: throw new Error("INTERCEPTOR_AGENT_ACTION_INVALID");
    }
  }

  private async handleRequest(input: Readonly<{ url: string; method: string; headers: SafeHeaders; body?: string }>): Promise<ResponseRecord> {
    const started = Date.now(); const id = `ix-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let parsedUrl: URL; try { parsedUrl = new URL(input.url); } catch { return { status: 400, statusText: "Invalid URL", headers: { "content-type": "text/plain" }, body: "Request URL is invalid." }; }
    if (!/^[A-Z!#$%&'*+.^_`|~0-9-]{1,20}$/i.test(input.method) || !input.headers || Object.keys(input.headers).length > 100) return { status: 400, statusText: "Invalid request", headers: {}, body: "Request method or headers are invalid." };
    const settings = await this.store.settings(); const bodyLimit = Math.max(1, Math.min(MAX_PROXY_BODY, settings.bodyLimitBytes));
    const request: RequestRecord = { id, startedAt: started, url: parsedUrl.toString(), method: input.method.toUpperCase(), protocol: parsedUrl.protocol as "http:" | "https:", requestHeaders: input.headers, ...(input.body !== undefined ? { requestBody: input.body.slice(0, bodyLimit) } : {}) };
    if (request.method === "CONNECT") {
      const allowed = await this.policy.authorize("connect-tunnel", "runtime", true, request.url, { runtimeAdapter: this.adapter, fetcher: this.fetcher });
      const response: ResponseRecord = allowed.allowed
        ? { status: 200, statusText: "Connection established", headers: { "content-length": "0" } }
        : { status: 451, statusText: "Blocked by Interceptor policy", headers: { "content-type": "text/plain" }, body: allowed.reason ?? "Policy denied." };
      this.capture.record({ request, response, timing: { start: started, end: Date.now(), totalMs: Date.now() - started }, blocked: !allowed.allowed, error: allowed.reason, bytesIn: 0, bytesOut: response.body?.length ?? 0 });
      return response;
    }
    const allowed = await this.policy.authorize("capture-request", "runtime", true, request.url);
    if (!allowed.allowed) {
      if (allowed.reason === "CREDENTIAL_PROXY_EXCLUDED") return { status: 451, statusText: "Blocked by Interceptor policy", headers: { "content-type": "text/plain" }, body: "Credential-bearing local endpoint is excluded." };
      const response = { status: 451, statusText: "Blocked by Interceptor policy", headers: { "content-type": "text/plain" }, body: allowed.reason ?? "Policy denied." };
      // A request rejected by policy is not a user-authorized capture. Keep
      // only routing metadata; never retain its bodies or arbitrary headers.
      const blockedRequest: RequestRecord = {
        id: request.id,
        startedAt: request.startedAt,
        url: request.url,
        method: request.method,
        protocol: request.protocol,
        requestHeaders: {},
      };
      this.capture.record({ request: blockedRequest, response, timing: { start: started, end: Date.now(), totalMs: Date.now() - started }, blocked: true, error: allowed.reason, bytesIn: input.body?.length ?? 0, bytesOut: response.body.length }); return response;
    }
    if (input.body && input.body.length > bodyLimit) return { status: 413, statusText: "Request body too large", headers: {}, body: "Request body exceeds interceptor limit." };
    const activeRules = await this.store.listRules();
    const io = {
      readLocal: async (path: string) => { if (!this.paths) throw new Error("MAP_LOCAL_POLICY_ADAPTER_UNAVAILABLE"); return this.paths.readText(path); },
      checkRemote: async (url: string) => (await this.policy.authorize("map-remote", "runtime", true, url, { runtimeAdapter: this.adapter, fetcher: this.fetcher })).allowed,
      fetchRemote: async (url: string) => this.fetchResponse(url, "GET", {}, undefined, bodyLimit),
    };
    const pre = await this.rules.evaluate(request, { status: 599, headers: {}, body: "" }, activeRules, io, "request");
    if (pre.delayMs) await wait(pre.delayMs);
    if (pre.breakpoint) {
      const response = { status: 409, statusText: "Breakpoint unavailable", headers: { "content-type": "text/plain" }, body: "Manual breakpoint editing is not supported by the active proxy adapter." };
      this.capture.record({ request, response, timing: { start: started, end: Date.now(), totalMs: Date.now() - started }, matchedRules: pre.matchedRuleIds, modified: pre.modified, blocked: true, error: "BREAKPOINT_ADAPTER_UNAVAILABLE", bytesIn: input.body?.length ?? 0, bytesOut: response.body.length }); return response;
    }
    if (pre.blocked || pre.response.status !== 599) {
      const response = pre.response;
      this.capture.record({ request, response, timing: { start: started, end: Date.now(), totalMs: Date.now() - started }, matchedRules: pre.matchedRuleIds, modified: pre.modified, blocked: pre.blocked, bytesIn: input.body?.length ?? 0, bytesOut: response.body?.length ?? 0 }); return response;
    }
    const egressAllowed = await this.policy.authorize("proxy-forward", "runtime", true, request.url, { runtimeAdapter: this.adapter, fetcher: this.fetcher });
    if (!egressAllowed.allowed) {
      const response = { status: 451, statusText: "Blocked by Interceptor policy", headers: { "content-type": "text/plain" }, body: egressAllowed.reason ?? "Policy denied." };
      this.capture.record({ request, response, timing: { start: started, end: Date.now(), totalMs: Date.now() - started }, matchedRules: pre.matchedRuleIds, blocked: true, error: egressAllowed.reason, bytesIn: input.body?.length ?? 0, bytesOut: response.body.length });
      return response;
    }
    let upstream: ResponseRecord;
    try { upstream = await this.fetchResponse(request.url, request.method, input.headers, input.body, bodyLimit); }
    catch (error) {
      this.capture.record({ request, timing: { start: started, end: Date.now(), totalMs: Date.now() - started }, matchedRules: pre.matchedRuleIds, error: error instanceof Error ? error.message : "UPSTREAM_FAILED", bytesIn: input.body?.length ?? 0 });
      return { status: 502, statusText: "Upstream failed", headers: {}, body: "The upstream request failed." };
    }
    const post = await this.rules.evaluate(request, upstream, activeRules, io, "response");
    if (post.delayMs) await wait(post.delayMs);
    const final = post.response;
    this.capture.record({ request, response: final, timing: { start: started, end: Date.now(), totalMs: Date.now() - started }, matchedRules: [...pre.matchedRuleIds, ...post.matchedRuleIds], modified: pre.modified || post.modified, blocked: post.blocked, error: [...pre.errors, ...post.errors].join(";").slice(0, 240) || undefined, bytesIn: input.body?.length ?? 0, bytesOut: final.body?.length ?? 0 });
    if (this.state === "listening") { this.state = "capturing"; this.emit(); }
    return final;
  }

  private async fetchResponse(url: string, method: string, inputHeaders: SafeHeaders, body?: string, maxBodyBytes = MAX_PROXY_BODY): Promise<ResponseRecord> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(inputHeaders)) { if (FORBIDDEN_REQUEST_HEADERS.test(name) || /[\r\n\0]/.test(value)) continue; headers.set(name, value); }
    let response: Response;
    try { response = await this.fetcher(url, { method, headers, redirect: "error", ...(body && !["GET", "HEAD"].includes(method) ? { body } : {}) }); }
    catch { throw new Error("UPSTREAM_NETWORK_FAILED"); }
    const contentLength = Number(response.headers.get("content-length") ?? 0); if (contentLength > maxBodyBytes) { try { await response.body?.cancel(); } catch { /* ignore */ } throw new Error("UPSTREAM_BODY_TOO_LARGE"); }
    const text = await readBoundedText(response, maxBodyBytes);
    const outputHeaders: Record<string, string> = {}; response.headers.forEach((value, name) => { outputHeaders[name] = value.slice(0, 8192); });
    return { status: response.status, statusText: response.statusText.slice(0, 120), headers: outputHeaders, body: text };
  }
  private setError(error: string): void { this.state = "error"; this.error = error.slice(0, 180); this.address = undefined; this.emit(); }
  private emit(): void { const snapshot = this.getSnapshot(); for (const listener of this.listeners) { try { listener(snapshot); } catch { /* isolate UI subscribers */ } } }
  private async audit(operation: string, outcome: "allowed" | "denied" | "failed", reason: string | undefined, source: InterceptorSource | "runtime"): Promise<void> { try { await this.record?.({ operation, outcome, source: source === "preset" ? "user" : source, ...(reason ? { reason } : {}), details: { port: this.port, status: this.state } }); } catch { /* best effort */ } }
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function boundedInt(value: unknown, fallback: number, min: number, max: number): number { const n = Number(value); return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function stringArg(value: unknown, max: number): string { if (typeof value !== "string" || !value || value.length > max) throw new Error("INTERCEPTOR_ARGUMENT_INVALID"); return value; }
function summary(item: CapturedExchange): Readonly<Record<string, unknown>> { return { id: item.id, method: item.request.method, url: item.request.url, status: item.response?.status ?? 0, durationMs: item.timing.totalMs, modified: item.modified, blocked: item.blocked, matchedRules: item.matchedRules }; }
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (typeof TextDecoder === "undefined") { const text = await response.text(); if (text.length > maxBytes) throw new Error("UPSTREAM_BODY_TOO_LARGE"); return text; }
  const reader = response.body?.getReader();
  if (!reader) { const text = await response.text(); if (text.length > maxBytes) throw new Error("UPSTREAM_BODY_TOO_LARGE"); return text; }
  const decoder = new TextDecoder(); let output = ""; let bytes = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("UPSTREAM_BODY_TOO_LARGE"); } output += decoder.decode(chunk.value, { stream: true }); if (output.length > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("UPSTREAM_BODY_TOO_LARGE"); } }
    output += decoder.decode(); if (output.length > maxBytes) throw new Error("UPSTREAM_BODY_TOO_LARGE"); return output;
  } finally { try { reader.releaseLock(); } catch { /* already released */ } }
}
