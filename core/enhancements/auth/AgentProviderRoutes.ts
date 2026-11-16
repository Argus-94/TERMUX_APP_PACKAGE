import type { ProviderRoute } from "./types";

export interface ProviderRouteSettingsStorage {
  getItem(key: string): Promise<string | null>;
}

const CONFIG_KEYS: Readonly<Record<string, { key: string; field: string }>> = Object.freeze({
  "custom.slot1": { key: "aibuilder.custom.provider.v1", field: "customProvider" },
  "custom.slot2": { key: "aibuilder.custom.provider2.v1", field: "customProvider2" },
  opencode: { key: "aibuilder.opencode.config.v1", field: "openCode" },
});
const DEFAULT_OPENCODE_ROUTE: ProviderRoute = Object.freeze({ baseUrl: "https://opencode.ai/zen/v1" });
const DEFAULT_BUILTIN_ROUTES: Readonly<Record<string, ProviderRoute>> = Object.freeze({
  manus: Object.freeze({ baseUrl: "https://api.manus.ai", authHeader: "x-manus-api-key", authScheme: "raw" }),
  openrouter: Object.freeze({ baseUrl: "https://openrouter.ai/api/v1" }),
});

function routeFromBaseUrl(value: unknown, provider: string): ProviderRoute | undefined {
  if (typeof value !== "string" || value.length > 2048 || !value.trim()) return undefined;
  const raw = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) return undefined;
    const anthropic = provider.startsWith("custom.") && /anthropic/i.test(raw);
    return anthropic
      ? { baseUrl: raw, authHeader: "x-api-key", authScheme: "raw" }
      : { baseUrl: raw, authHeader: "authorization", authScheme: "Bearer" };
  } catch {
    return undefined;
  }
}

function parseConfigBaseUrl(raw: string | null, provider: string, field: string, nested: boolean): ProviderRoute | undefined {
  if (!raw || raw.length > 64_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const root = parsed as Record<string, unknown>;
    const config = nested ? root[field] : root;
    if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
    return routeFromBaseUrl((config as Record<string, unknown>).baseUrl, provider);
  } catch {
    return undefined;
  }
}

/** Resolve only the configured destination/auth protocol; credential material is never read here. */
export async function resolveTaskProviderRoute(providerInput: string, storage: ProviderRouteSettingsStorage): Promise<ProviderRoute | undefined> {
  const provider = String(providerInput || "").trim().toLowerCase();
  if (DEFAULT_BUILTIN_ROUTES[provider]) return DEFAULT_BUILTIN_ROUTES[provider];
  const config = CONFIG_KEYS[provider];
  if (!config) return undefined;
  try {
    const dedicatedRaw = await storage.getItem(config.key);
    const dedicatedRoute = parseConfigBaseUrl(dedicatedRaw, provider, config.field, false);
    if (dedicatedRaw !== null) return dedicatedRoute;

    const settingsRaw = await storage.getItem("aibuilder.settings.v1");
    const settingsRoute = parseConfigBaseUrl(settingsRaw, provider, config.field, true);
    if (settingsRaw !== null) return settingsRoute;
    return provider === "opencode" ? DEFAULT_OPENCODE_ROUTE : undefined;
  } catch {
    return undefined;
  }
}
