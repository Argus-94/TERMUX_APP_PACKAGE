import { AuthError, type MaskedProviderCredential, type SecureCredentialStorage } from "./types";
import { AGENT_AUTH_PROXY_ACCESS } from "./AgentAuthProxyAccess";

const PROVIDER_RE = /^[a-z][a-z0-9._-]{0,63}$/i;
const STORAGE_PREFIX = "aib.agent-auth.v1.";

type ProxyCredentialResolver = (provider: string) => Promise<string | null>;

/**
 * Provider credentials kept only in the supplied SecureStore adapter.
 * Public reads return masked metadata; only a closure for the proxy may resolve a secret.
 */
export class AgentAuthStore {
  private readonly storage: SecureCredentialStorage;
  private readonly providerLocks = new Map<string, Promise<void>>();

  constructor(storage: SecureCredentialStorage) {
    this.storage = storage;
  }

  private storageKey(provider: string): string {
    const normalized = provider.trim().toLowerCase();
    if (!PROVIDER_RE.test(normalized)) throw new AuthError("INVALID_PROVIDER", "Invalid provider identifier");
    return `${STORAGE_PREFIX}${normalized}`;
  }

  private async withProviderLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.providerLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.providerLocks.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.providerLocks.get(key) === current) this.providerLocks.delete(key);
    }
  }

  /** Store or replace one provider key. Empty values are rejected and never persisted. */
  async setProviderKey(provider: string, key: string): Promise<void> {
    const storageKey = this.storageKey(provider);
    const rollbackKey = `aib.agent-auth.rollback.v1.${provider.trim().toLowerCase()}`;
    const value = key.trim();
    if (!value) throw new AuthError("EMPTY_CREDENTIAL", "Credential must not be empty");
    if (value.length > 8192) throw new AuthError("INVALID_CREDENTIAL", "Credential exceeds the supported size");
    return this.withProviderLock(storageKey, async () => {
      let previous: string | null;
      try {
        previous = await this.storage.get(storageKey);
        if (previous !== null) {
          await this.storage.set(rollbackKey, previous);
          if (await this.storage.get(rollbackKey) !== previous) throw new Error("ROLLBACK_BACKUP_VERIFY_FAILED");
        } else {
          await this.storage.delete(rollbackKey);
        }
      } catch {
        throw new AuthError("SECURE_STORAGE_FAILED", "Secure credential storage failed");
      }
      try {
        await this.storage.set(storageKey, value);
        if (await this.storage.get(storageKey) !== value) throw new Error("SECURE_WRITE_VERIFY_FAILED");
      } catch {
        try {
          if (previous !== null) {
            await this.storage.set(storageKey, previous);
            if (await this.storage.get(storageKey) === previous) await this.storage.delete(rollbackKey);
          } else {
            await this.storage.delete(storageKey);
            if (await this.storage.get(storageKey) === null) await this.storage.delete(rollbackKey);
          }
        } catch { /* keep the SecureStore-only rollback copy if restoration also fails */ }
        throw new AuthError("SECURE_STORAGE_FAILED", "Secure credential storage failed");
      }
      // Cleanup is best-effort only after the new canonical value is verified.
      try { await this.storage.delete(rollbackKey); } catch { /* retained only in SecureStore */ }
    });
  }

  /** Return status and a short masked hint only; plaintext is never returned. */
  async getProviderKey(provider: string): Promise<MaskedProviderCredential> {
    const storageKey = this.storageKey(provider);
    return this.withProviderLock(storageKey, async () => {
      let value: string | null;
      try { value = await this.storage.get(storageKey); }
      catch { throw new AuthError("SECURE_STORAGE_FAILED", "Secure credential storage failed"); }
      return { provider: provider.trim().toLowerCase(), configured: Boolean(value), masked: value ? `••••${value.length > 4 ? value.slice(-4) : ""}` : null };
    });
  }

  /** Check whether a provider credential is configured without reading it into caller code. */
  async hasKey(provider: string): Promise<boolean> {
    return (await this.getProviderKey(provider)).configured;
  }

  /** Remove a provider key from SecureStore. */
  async deleteKey(provider: string): Promise<void> {
    const storageKey = this.storageKey(provider);
    const normalized = provider.trim().toLowerCase();
    return this.withProviderLock(storageKey, async () => {
      let failed = false;
      const keys = [storageKey, `aib.agent-auth.rollback.v1.${normalized}`];
      for (let index = 0; index < 32; index++) {
        keys.push(`aib.agent-auth.legacy.v1.${normalized}.${index}`);
        keys.push(`aib.agent-auth.legacy-inline.v1.${normalized}.${index}`);
        keys.push(`aib.agent-auth.pending.v1.${normalized}.${index}`);
      }
      for (const key of keys) {
        try { await this.storage.delete(key); } catch { failed = true; }
      }
      if (failed) throw new AuthError("SECURE_STORAGE_FAILED", "Secure credential deletion failed");
    });
  }

  /** @internal Privileged resolver for CredentialProxy; normal callers must use masked metadata APIs. */
  createProxyResolver(access: typeof AGENT_AUTH_PROXY_ACCESS): ProxyCredentialResolver {
    if (access !== AGENT_AUTH_PROXY_ACCESS) throw new AuthError("PROXY_ACCESS_DENIED", "Credential resolution is reserved for the native proxy");
    return async (provider: string): Promise<string | null> => {
      const storageKey = this.storageKey(provider);
      return this.withProviderLock(storageKey, async () => {
        try { return await this.storage.get(storageKey); }
        catch { throw new AuthError("SECURE_STORAGE_FAILED", "Secure credential storage failed"); }
      });
    };
  }
}
