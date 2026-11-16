import { AuthError, type NativeProxyTransport, type ProxyClientConfiguration, type ProxyFetch, type ProxyMetadataLogger, type ProxyRequest, type ProviderRoute } from "./types";
import type { AgentAuthStore } from "./AgentAuthStore";
import { AGENT_AUTH_PROXY_ACCESS } from "./AgentAuthProxyAccess";

export const DUMMY_PROXY_API_KEY = "dummy-aib-proxy-key";
const SAFE_FORWARD_HEADERS = new Set(["accept", "content-type", "anthropic-version", "openai-beta", "http-referer", "x-title"]);
const SAFE_PROVIDERS = /^[a-z][a-z0-9._-]{0,63}$/i;
const ACTIVE_PROVIDERS = new Set(["manus", "openrouter", "opencode", "custom.slot1", "custom.slot2"]);

function normalizeProvider(value: string): string {
  const provider = String(value || "").trim().toLowerCase();
  if (!SAFE_PROVIDERS.test(provider)) throw new AuthError("INVALID_PROVIDER", "Invalid provider identifier");
  if (!ACTIVE_PROVIDERS.has(provider)) throw new AuthError("PROVIDER_NOT_SUPPORTED", "Provider is not supported");
  return provider;
}

function validateRoute(route: ProviderRoute): ProviderRoute {
  let base: URL;
  try { base = new URL(route.baseUrl); } catch { throw new AuthError("ROUTE_NOT_CONFIGURED", "Provider route is invalid"); }
  const host = base.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) throw new AuthError("ROUTE_NOT_CONFIGURED", "Provider route must use HTTPS (HTTP is limited to loopback)");
  if (base.username || base.password || base.search || base.hash || !route.baseUrl.trim()) throw new AuthError("ROUTE_NOT_CONFIGURED", "Provider route must not contain credentials, query, or fragment");
  if (route.authHeader && route.authHeader !== "authorization" && route.authHeader !== "x-api-key" && route.authHeader !== "x-manus-api-key") throw new AuthError("ROUTE_NOT_CONFIGURED", "Unsupported provider auth header");
  if (route.authScheme && route.authScheme !== "Bearer" && route.authScheme !== "raw") throw new AuthError("ROUTE_NOT_CONFIGURED", "Unsupported provider auth scheme");
  if (route.baseUrl && base.hostname.toLowerCase() === "api.manus.ai" && (route.authHeader !== "x-manus-api-key" || route.authScheme !== "raw")) throw new AuthError("ROUTE_NOT_CONFIGURED", "Manus auth protocol is pinned");
  return { baseUrl: base.toString().replace(/\/$/, ""), authHeader: route.authHeader ?? "authorization", authScheme: route.authScheme ?? "Bearer" };
}

function routeKey(provider: string, route: ProviderRoute): string {
  return `${provider}\n${route.baseUrl}\n${route.authHeader ?? "authorization"}\n${route.authScheme ?? "Bearer"}`;
}

function safeRouteUrl(baseUrl: string, requestPath: string): URL {
  let base: URL;
  try { base = new URL(baseUrl); } catch { throw new AuthError("PROXY_SESSION_INVALID", "Native proxy route is invalid"); }
  const expectedPrefix = `/v1/session/${base.pathname.split("/").filter(Boolean).at(-1)}`;
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port || base.username || base.password || base.search || base.hash || !base.pathname.startsWith("/v1/session/")) throw new AuthError("PROXY_SESSION_INVALID", "Native proxy route is not a loopback session");
  if (!requestPath || requestPath.includes("\\") || requestPath.includes("\0")) throw new AuthError("INVALID_REQUEST", "Invalid provider request path");
  const relative = requestPath.replace(/^\/+/, "");
  let url: URL;
  try { url = new URL(relative, `${base.toString().replace(/\/+$/, "")}/`); } catch { throw new AuthError("INVALID_REQUEST", "Invalid provider request path"); }
  if (url.origin !== base.origin || !url.pathname.startsWith(`${expectedPrefix}/`) || url.pathname.includes("/../") || url.pathname.includes("/./")) throw new AuthError("INVALID_REQUEST", "Provider request escaped its native proxy session");
  return url;
}

/** Native-backed credential proxy. Provider secrets are resolved only for the native session start. */
export class CredentialProxy {
  #resolver: (provider: string) => Promise<string | null>;
  private readonly routes: Readonly<Record<string, ProviderRoute>>;
  private readonly fetcher: ProxyFetch;
  private readonly nativeTransport?: NativeProxyTransport;
  private readonly logMetadata?: ProxyMetadataLogger;
  private readonly active = new Map<string, ProxyClientConfiguration>();
  private readonly latestByProvider = new Map<string, string>();
  private readonly appRoutes = new Map<string, string>();
  private readonly lifecycleQueues = new Map<string, Promise<void>>();

  constructor(authStore: AgentAuthStore, routes: Readonly<Record<string, ProviderRoute>>, options?: { fetcher?: ProxyFetch; logMetadata?: ProxyMetadataLogger; nativeTransport?: NativeProxyTransport }) {
    this.#resolver = authStore.createProxyResolver(AGENT_AUTH_PROXY_ACCESS); this.routes = routes;
    this.fetcher = options?.fetcher ?? ((input, init) => fetch(input, init));
    this.nativeTransport = options?.nativeTransport; this.logMetadata = options?.logMetadata;
  }

  private async withProviderLifecycle<T>(provider: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleQueues.get(provider) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.lifecycleQueues.set(provider, current);
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (this.lifecycleQueues.get(provider) === current) this.lifecycleQueues.delete(provider);
    }
  }

  private resolveRoute(provider: string, override?: ProviderRoute): ProviderRoute {
    const route = override ?? this.routes[provider];
    if (!route) throw new AuthError("ROUTE_NOT_CONFIGURED", "No route configured for provider");
    if (provider === "manus") {
      if (route.baseUrl.replace(/\/+$/, "") !== "https://api.manus.ai" || (route.authHeader && route.authHeader !== "x-manus-api-key") || (route.authScheme && route.authScheme !== "raw")) throw new AuthError("ROUTE_NOT_CONFIGURED", "Cloud API route is pinned");
      return validateRoute({ baseUrl: "https://api.manus.ai", authHeader: "x-manus-api-key", authScheme: "raw" });
    }
    return validateRoute(route);
  }

  /** Start an ephemeral loopback listener using SecureStore; only dummy client credentials are returned. */
  async start(providerInput: string, routeOverride?: ProviderRoute): Promise<ProxyClientConfiguration> {
    const provider = normalizeProvider(providerInput);
    const route = this.resolveRoute(provider, routeOverride);
    return this.withProviderLifecycle(provider, () => this.startUnlocked(provider, route));
  }

  private async startUnlocked(provider: string, route: ProviderRoute, credentialOverride?: string): Promise<ProxyClientConfiguration> {
    if (!this.nativeTransport) throw new AuthError("NATIVE_TRANSPORT_UNAVAILABLE", "Native credential proxy transport is unavailable");
    const credential = credentialOverride === undefined ? await this.#resolver(provider) : credentialOverride;
    if (!credential) throw new AuthError("CREDENTIAL_MISSING", "Provider credential is not configured");
    let nativeSession;
    try { nativeSession = await this.nativeTransport.start(provider, credential, route); }
    catch { throw new AuthError("NATIVE_TRANSPORT_UNAVAILABLE", "Native credential proxy could not start"); }
    const sessionId = typeof nativeSession?.sessionId === "string" ? nativeSession.sessionId : "";
    const collision = Boolean(sessionId && this.active.has(sessionId));
    const url = (() => { try { return new URL(nativeSession?.baseUrl ?? ""); } catch { return null; } })();
    const expectedPath = `/v1/session/${sessionId}`;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || nativeSession?.apiKey !== DUMMY_PROXY_API_KEY || !url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== expectedPath || url.username || url.password || url.search || url.hash || collision) {
      try { if (sessionId && !collision) await this.nativeTransport.stop(sessionId); } catch { /* fail closed */ }
      throw new AuthError("PROXY_SESSION_INVALID", "Native proxy returned an invalid loopback session");
    }
    const config: ProxyClientConfiguration = { provider, baseUrl: nativeSession.baseUrl, apiKey: DUMMY_PROXY_API_KEY, sessionId };
    this.active.set(config.sessionId, config);
    this.latestByProvider.set(provider, config.sessionId);
    return config;
  }

  private async ensureAppSessionUnlocked(provider: string, route: ProviderRoute): Promise<ProxyClientConfiguration> {
    const key = routeKey(provider, route);
    const existingId = this.appRoutes.get(key);
    const existing = existingId ? this.active.get(existingId) : undefined;
    if (existing) return existing;
    const created = await this.startUnlocked(provider, route);
    this.appRoutes.set(key, created.sessionId);
    return created;
  }

  /** Probe a typed provider credential in an isolated native session without writing it to SecureStore. */
  async probeWithCredential(request: ProxyRequest, credentialInput: string, routeOverride?: ProviderRoute): Promise<Response> {
    const provider = normalizeProvider(request.provider);
    const method = (request.method ?? "GET").toUpperCase();
    const requestPath = request.path.replace(/^\/+/, "");
    const allowedOpenRouterKeyCheck = provider === "openrouter" && requestPath === "key";
    const allowedReadOnlyModelsCheck = requestPath === "models";
    const allowedManusCheck = provider === "manus" && requestPath === "v2/user.me";
    if (method !== "GET" || (!allowedOpenRouterKeyCheck && !allowedReadOnlyModelsCheck && !allowedManusCheck)) {
      throw new AuthError("INVALID_REQUEST", "Transient credentials are limited to GET /models or the OpenRouter GET /key endpoint");
    }
    const credential = String(credentialInput ?? "").trim();
    if (!credential) throw new AuthError("EMPTY_CREDENTIAL", "Credential must not be empty");
    if (credential.length > 8192) throw new AuthError("INVALID_CREDENTIAL", "Credential exceeds the supported size");
    const route = this.resolveRoute(provider, routeOverride);
    const safeRequest: ProxyRequest = { ...request, provider, path: requestPath, method: "GET" };
    return this.withProviderLifecycle(provider, async () => {
      const session = await this.startUnlocked(provider, route, credential);
      try {
        return await this.fetchThroughSession(safeRequest, session);
      } finally {
        await this.stopSessionUnlocked(session.sessionId);
      }
    });
  }

  private async stopProviderUnlocked(provider: string): Promise<boolean> {
    const ids = [...this.active.values()].filter((session) => session.provider === provider).map((session) => session.sessionId);
    let stopped = false;
    for (const id of ids) stopped = (await this.stopSessionUnlocked(id)) || stopped;
    return stopped;
  }

  /** Stop all listeners and run a credential mutation atomically against provider session start/fetch. */
  async rotateProviderCredential<T>(providerInput: string, mutation: () => Promise<T>): Promise<T> {
    const provider = normalizeProvider(providerInput);
    return this.withProviderLifecycle(provider, async () => {
      await this.stopProviderUnlocked(provider);
      return mutation();
    });
  }

  /** Stop all listeners owned by a provider; used when a key is changed or removed. */
  async stop(providerInput: string): Promise<boolean> {
    const provider = normalizeProvider(providerInput);
    return this.withProviderLifecycle(provider, () => this.stopProviderUnlocked(provider));
  }

  /** Stop precisely one ephemeral listener, used by per-task cleanup. */
  async stopSession(sessionId: string): Promise<boolean> {
    const config = this.active.get(sessionId);
    if (!config) return false;
    return this.withProviderLifecycle(config.provider, () => this.stopSessionUnlocked(sessionId));
  }

  private async stopSessionUnlocked(sessionId: string): Promise<boolean> {
    const config = this.active.get(sessionId);
    if (!config || !this.nativeTransport) return false;
    this.active.delete(sessionId);
    for (const [key, id] of this.appRoutes) if (id === sessionId) this.appRoutes.delete(key);
    if (this.latestByProvider.get(config.provider) === sessionId) {
      const replacement = [...this.active.values()].reverse().find((item) => item.provider === config.provider);
      if (replacement) this.latestByProvider.set(config.provider, replacement.sessionId);
      else this.latestByProvider.delete(config.provider);
    }
    try { return await this.nativeTransport.stop(sessionId); }
    catch { throw new AuthError("NATIVE_TRANSPORT_UNAVAILABLE", "Native credential proxy could not stop"); }
  }

  async stopAll(): Promise<void> {
    for (const sessionId of [...this.active.keys()]) await this.stopSession(sessionId);
  }

  getClientConfig(providerInput?: string): ProxyClientConfiguration {
    if (providerInput) { const sessionId = this.latestByProvider.get(normalizeProvider(providerInput)); const config = sessionId ? this.active.get(sessionId) : undefined; if (config) return config; }
    else if (this.active.size === 1) return [...this.active.values()][0];
    throw new AuthError("PROXY_NOT_STARTED", "Start the native proxy before configuring an agent");
  }

  /** All app-owned provider fetches terminate at a verified 127.0.0.1 native session using a dummy key. */
  async forward(request: ProxyRequest, routeOverride?: ProviderRoute): Promise<Response> {
    const provider = normalizeProvider(request.provider);
    const route = this.resolveRoute(provider, routeOverride);
    return this.withProviderLifecycle(provider, async () => {
      const session = await this.ensureAppSessionUnlocked(provider, route);
      return this.fetchThroughSession(request, session);
    });
  }

  private async fetchThroughSession(request: ProxyRequest, session: ProxyClientConfiguration): Promise<Response> {
    const method = (request.method ?? "POST").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new AuthError("INVALID_REQUEST", "Unsupported provider method");
    const url = safeRouteUrl(session.baseUrl, request.path);
    if (session.provider === "manus") {
      const relativePath = url.pathname.slice(new URL(session.baseUrl).pathname.length + 1);
      const allowed = method === "GET" ? ["v2/user.me", "v2/task.listMessages", "v2/task.detail", "v2/usage.availableCredits"] : ["v2/task.create", "v2/task.sendMessage"];
      if (!allowed.includes(relativePath)) throw new AuthError("INVALID_REQUEST", "Cloud API route is not allowlisted");
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers ?? {})) if (SAFE_FORWARD_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    headers.set("Authorization", `Bearer ${DUMMY_PROXY_API_KEY}`);
    const started = Date.now();
    let response: Response;
    try { response = await this.fetcher(url.toString(), { method, headers, body: method === "GET" ? undefined : request.body ?? undefined, signal: request.signal }); }
    catch { throw new AuthError("UPSTREAM_FAILED", "Secured provider transport failed"); }
    try { this.logMetadata?.({ provider: session.provider, model: request.model, status: response.status, latencyMs: Math.max(0, Date.now() - started), streaming: /text\/event-stream/i.test(response.headers.get("content-type") ?? "") }); }
    catch { /* telemetry cannot break a provider response */ }
    return response;
  }
}
