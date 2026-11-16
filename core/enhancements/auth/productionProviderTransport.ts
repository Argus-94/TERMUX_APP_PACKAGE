import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { AgentAuthStore } from "./AgentAuthStore";
import { CredentialProxy } from "./CredentialProxy";
import { NativeProxyTransportAdapter } from "./NativeProxyTransport";
import { resolveTaskProviderRoute } from "./AgentProviderRoutes";
import { createSecureCredentialStorage } from "./SecureStoreAdapter";
import type { ProxyRequest, ProviderRoute } from "./types";
import { persistentLogger } from "../../../lib/persistent-logger";

export const PROVIDER_CREDENTIAL_IDS = {
  manus: "manus",
  openrouter: "openrouter",
  custom1: "custom.slot1",
  custom2: "custom.slot2",
  opencode: "opencode",
} as const;

const secureStorage = createSecureCredentialStorage();
const productionAgentAuthStore = new AgentAuthStore(secureStorage);
const productionCredentialProxy = new CredentialProxy(productionAgentAuthStore, {
  manus: { baseUrl: "https://api.manus.ai", authHeader: "x-manus-api-key", authScheme: "raw" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  opencode: { baseUrl: "https://opencode.ai/zen/v1" },
  "custom.slot1": { baseUrl: "https://invalid.local" },
  "custom.slot2": { baseUrl: "https://invalid.local" },
}, {
  nativeTransport: new NativeProxyTransportAdapter(),
  logMetadata: (m) => persistentLogger.add("debug", "ProviderTransport", JSON.stringify(m)),
});

const ACTIVE_PROVIDER_IDS = new Set<string>(Object.values(PROVIDER_CREDENTIAL_IDS));
function isActiveProvider(provider: string): boolean {
  return ACTIVE_PROVIDER_IDS.has(String(provider || "").trim().toLowerCase());
}
function requireActiveProvider(provider: string): void {
  if (!isActiveProvider(provider)) throw new Error("PROVIDER_NOT_SUPPORTED");
}

const credentialMutationQueues = new Map<string, Promise<void>>();
async function serializeCredentialMutation<T>(provider: string, operation: () => Promise<T>): Promise<T> {
  const key = provider.trim().toLowerCase();
  const previous = credentialMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  credentialMutationQueues.set(key, current);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally {
    release();
    if (credentialMutationQueues.get(key) === current) credentialMutationQueues.delete(key);
  }
}

async function saveProviderCredentialLocked(provider: string, value: string): Promise<boolean> {
  const safeProvider = provider.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64) || "unknown";
  try {
    const clean = String(value ?? "").trim();
    await productionCredentialProxy.rotateProviderCredential(provider, async () => {
      if (!clean) await productionAgentAuthStore.deleteKey(provider);
      else await productionAgentAuthStore.setProviderKey(provider, clean);
    });
    persistentLogger.add("info", "ProviderCredential", `SecureStore credential committed and read-back verified; provider=${safeProvider}`);
    return true;
  } catch {
    persistentLogger.add("error", "ProviderCredential", `SecureStore credential save failed; provider=${safeProvider}; previous value preserved when available`);
    return false;
  }
}

/** The one permitted app-level provider request path; all requests are sent to native loopback. */
export async function securedProviderFetch(
  provider: string,
  route: ProviderRoute,
  path: string,
  init: RequestInit = {},
  metadata?: { model?: string },
): Promise<Response> {
  requireActiveProvider(provider);
  const request: ProxyRequest = {
    provider,
    path,
    method: init.method ?? "POST",
    headers: init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : Array.isArray(init.headers)
        ? Object.fromEntries(init.headers)
        : (init.headers as Record<string, string> | undefined),
    body: init.body as BodyInit | null | undefined,
    signal: init.signal ?? undefined,
    model: metadata?.model,
  };
  return productionCredentialProxy.forward(request, route);
}

/** Validate a typed Manus API key through an isolated one-shot native session; the key is never saved. */
export async function probeManusCredential(draft: string, signal?: AbortSignal): Promise<Response> {
  return productionCredentialProxy.probeWithCredential({ provider: "manus", path: "v2/user.me", method: "GET", signal }, draft);
}

/** Validate a typed OpenRouter key through a one-shot native session; the key is never saved. */
export async function probeOpenRouterCredential(credential: string, signal?: AbortSignal): Promise<Response> {
  return productionCredentialProxy.probeWithCredential({ provider: "openrouter", path: "key", method: "GET", signal }, credential);
}

/** Probe a draft provider credential against GET /models through an isolated native session. */
export async function probeProviderModelsCredential(
  provider: string,
  route: ProviderRoute,
  credential: string,
  signal?: AbortSignal,
): Promise<Response> {
  requireActiveProvider(provider);
  return productionCredentialProxy.probeWithCredential({ provider, path: "models", method: "GET", signal }, credential, route);
}

export async function hasProviderCredential(provider: string): Promise<boolean> {
  if (!isActiveProvider(provider)) return false;
  return productionAgentAuthStore.hasKey(provider);
}

/** Resolve only a user's saved provider destination; this deliberately never reads credential values. */
export async function resolveAgentProviderRoute(provider: string): Promise<ProviderRoute | undefined> {
  if (!isActiveProvider(provider)) return undefined;
  return resolveTaskProviderRoute(provider, { getItem: (key) => AsyncStorage.getItem(key) });
}

/** Keep a migration value only under a verified SecureStore pending key; never use it as an active credential. */
async function preservePendingSecureCredential(provider: string, value: string): Promise<boolean> {
  const normalized = provider.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(normalized) || !value.trim() || value.length > 8192) return false;
  try {
    for (let index = 0; index < 32; index++) {
      const alias = `aib.agent-auth.pending.v1.${normalized}.${index}`;
      const existing = await secureStorage.get(alias);
      if (existing === value) return true;
      if (existing !== null) continue;
      await secureStorage.set(alias, value);
      if (await secureStorage.get(alias) === value) return true;
    }
  } catch { /* an unverified pending write must never authorize source deletion */ }
  return false;
}

/** Migrate a legacy inline secret without ever persisting it in ordinary settings. */
export async function migrateInlineProviderCredential(provider: string, rawValue: unknown): Promise<boolean> {
  if (!isActiveProvider(provider)) return false;
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) return hasProviderCredential(provider);
  return serializeCredentialMutation(provider, async () => {
    const canonical = `aib.agent-auth.v1.${provider.trim().toLowerCase()}`;
    try {
      const existing = await secureStorage.get(canonical);
      if (!existing) {
        if (await saveProviderCredentialLocked(provider, value)) return true;
        return preservePendingSecureCredential(provider, value);
      }
      if (existing === value) return true;
      // Preserve a conflicting old value in SecureStore; never replace a newer canonical credential.
      for (let index = 0; index < 32; index++) {
        const alias = `aib.agent-auth.legacy-inline.v1.${provider.trim().toLowerCase()}.${index}`;
        const occupied = await secureStorage.get(alias);
        if (occupied) continue;
        await secureStorage.set(alias, value);
        if (await secureStorage.get(alias) !== value) return false;
        return true;
      }
      return false;
    } catch {
      return preservePendingSecureCredential(provider, value);
    }
  });
}

/** Save only to canonical SecureStore; invalidate native sessions before rotating/removing a key. */
export async function saveProviderCredential(provider: string, value: string): Promise<boolean> {
  if (!isActiveProvider(provider)) return false;
  return serializeCredentialMutation(provider, () => saveProviderCredentialLocked(provider, value));
}

/**
 * Move aliases into canonical AgentAuthStore names once.
 * Legacy AsyncStorage fallbacks are copied and verified in SecureStore before being removed;
 * conflicting fallback values are preserved under a SecureStore-only legacy key.
 */
export async function migrateProviderCredential(
  provider: string,
  secureAliases: readonly string[] = [],
  legacyAsyncStorageKeys: readonly string[] = [],
): Promise<boolean> {
  if (!isActiveProvider(provider)) return false;
  return serializeCredentialMutation(provider, async () => {
  const canonical = `aib.agent-auth.v1.${provider.trim().toLowerCase()}`;
  try {
    let canonicalValue = await secureStorage.get(canonical);
    for (let pendingIndex = 0; pendingIndex < 32; pendingIndex++) {
      const pendingKey = `aib.agent-auth.pending.v1.${provider.trim().toLowerCase()}.${pendingIndex}`;
      const pendingValue = await secureStorage.get(pendingKey);
      if (!pendingValue?.trim()) continue;
      if (canonicalValue === pendingValue) {
        await secureStorage.delete(pendingKey);
      } else if (!canonicalValue) {
        await productionAgentAuthStore.setProviderKey(provider, pendingValue);
        canonicalValue = await secureStorage.get(canonical);
        if (canonicalValue !== pendingValue) throw new Error("SECURE_MIGRATION_VERIFY_FAILED");
        await secureStorage.delete(pendingKey);
      }
    }
    let secureAliasIndex = 0;
    for (const alias of secureAliases) {
      const value = await SecureStore.getItemAsync(alias);
      if (!value?.trim()) continue;
      const cleanValue = value.trim();
      if (!canonicalValue) {
        await productionAgentAuthStore.setProviderKey(provider, cleanValue);
        canonicalValue = await secureStorage.get(canonical);
        if (canonicalValue !== cleanValue) throw new Error("SECURE_MIGRATION_VERIFY_FAILED");
      } else if (canonicalValue !== cleanValue) {
        let preservedAlias = "";
        for (let attempt = 0; attempt < 32; attempt++) {
          const candidate = `aib.agent-auth.legacy.v1.${provider.trim().toLowerCase()}.${secureAliasIndex++}`;
          if (await secureStorage.get(candidate)) continue;
          await secureStorage.set(candidate, cleanValue);
          if (await secureStorage.get(candidate) !== cleanValue) throw new Error("SECURE_MIGRATION_VERIFY_FAILED");
          preservedAlias = candidate;
          break;
        }
        if (!preservedAlias) throw new Error("SECURE_MIGRATION_ALIAS_LIMIT");
      }
      // Delete the old name only after either a verified canonical copy or a verified secure preservation copy exists.
      await SecureStore.deleteItemAsync(alias);
      persistentLogger.add("info", "CredentialMigration", `Canonicalized SecureStore alias for ${provider}`);
    }

    let index = 0;
    for (const legacyKey of legacyAsyncStorageKeys) {
      const legacyValue = await AsyncStorage.getItem(legacyKey);
      if (!legacyValue?.trim()) continue;
      if (!canonicalValue) {
        try {
          await productionAgentAuthStore.setProviderKey(provider, legacyValue);
          canonicalValue = await secureStorage.get(canonical);
          if (canonicalValue !== legacyValue.trim()) throw new Error("SECURE_MIGRATION_VERIFY_FAILED");
        } catch {
          if (!await preservePendingSecureCredential(provider, legacyValue.trim())) throw new Error("SECURE_MIGRATION_VERIFY_FAILED");
          await AsyncStorage.removeItem(legacyKey);
          persistentLogger.add("info", "CredentialMigration", `Moved legacy credential into verified SecureStore quarantine for ${provider}`);
          continue;
        }
      } else if (canonicalValue !== legacyValue.trim()) {
        let preserved = false;
        for (let attempt = 0; attempt < 32; attempt++) {
          const preservedAlias = `aib.agent-auth.legacy.v1.${provider.trim().toLowerCase()}.${index++}`;
          if (await secureStorage.get(preservedAlias)) continue;
          await secureStorage.set(preservedAlias, legacyValue.trim());
          if (await secureStorage.get(preservedAlias) !== legacyValue.trim()) throw new Error("SECURE_MIGRATION_VERIFY_FAILED");
          preserved = true;
          break;
        }
        if (!preserved) throw new Error("SECURE_MIGRATION_ALIAS_LIMIT");
      }
      // Removal happens only after a verified secure copy exists; the old credential is never lost.
      await AsyncStorage.removeItem(legacyKey);
      persistentLogger.add("info", "CredentialMigration", `Moved legacy plaintext setting to SecureStore for ${provider}`);
    }
    return Boolean(canonicalValue?.trim());
  } catch {
    // Keep legacy data untouched on migration failure and prevent network use without canonical key.
    persistentLogger.add("error", "CredentialMigration", `Secure migration failed for ${provider}; provider disabled until repaired`);
    return false;
  }
  });
}
