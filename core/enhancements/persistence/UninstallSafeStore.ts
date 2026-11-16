import { PersistenceError, type DurableDocumentStorage, type PersistenceVisibility, type StoreClassification } from "./types";

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,179}$/;
const SECRET_NAME = /(?:^|[._/-])(?:credential|credentials|secret|secrets|token|tokens|api[_-]?key|openrouter[_-]?key|private[_-]?key|password|passwd|authorization)(?:$|[._/-])/i;

/**
 * Durable profile data store. Supply a SAF/document-provider adapter rooted in a
 * user-selected shared directory; app-private HOME is intentionally not a fallback.
 * Credentials and bridge tokens are refused, not merely filtered at export time.
 */
export class UninstallSafeStore {
  constructor(
    private readonly storage: DurableDocumentStorage,
    private readonly privateNamespace = "AIBuilder/private",
    private readonly publicNamespace = "AIBuilder/public",
  ) {}

  private path(visibility: Exclude<PersistenceVisibility, "never">, key: string): string {
    if (!SAFE_KEY.test(key) || key.startsWith("/") || key.split("/").some((part) => part === ".." || part === ".") || SECRET_NAME.test(key)) {
      throw new PersistenceError("PERSISTENCE_KEY_INVALID", "Invalid or secret-like persistence key");
    }
    const root = visibility === "public" ? this.publicNamespace : this.privateNamespace;
    const relative = visibility === "public" && key.startsWith("public/") ? key.slice("public/".length) : key;
    return `${root}/${relative}`;
  }

  classify(key: string): PersistenceVisibility {
    if (!SAFE_KEY.test(key) || SECRET_NAME.test(key)) return "never";
    return key.startsWith("public/") ? "public" : "private";
  }

  async read(key: string, visibility: Exclude<PersistenceVisibility, "never"> = "private"): Promise<string | null> {
    try { return await this.storage.read(this.path(visibility, key)); }
    catch (error) { throw error instanceof PersistenceError ? error : new PersistenceError("PERSISTENCE_BACKEND_FAILED"); }
  }

  async write(key: string, contents: string, visibility: Exclude<PersistenceVisibility, "never"> = "private"): Promise<void> {
    if (typeof contents !== "string") throw new PersistenceError("PERSISTENCE_BACKEND_FAILED");
    try { await this.storage.write(this.path(visibility, key), contents); }
    catch (error) { throw error instanceof PersistenceError ? error : new PersistenceError("PERSISTENCE_BACKEND_FAILED"); }
  }

  async remove(key: string, visibility: Exclude<PersistenceVisibility, "never"> = "private"): Promise<void> {
    try { await this.storage.remove(this.path(visibility, key)); }
    catch (error) { throw error instanceof PersistenceError ? error : new PersistenceError("PERSISTENCE_BACKEND_FAILED"); }
  }

  /** Build an export payload from an explicit allowlist; private and never-export data stay out. */
  async exportPublic(allowlist: readonly string[]): Promise<Readonly<Record<string, string>>> {
    const result: Record<string, string> = {};
    for (const key of allowlist) {
      if (this.classify(key) !== "public") continue;
      const value = await this.read(key, "public");
      if (value !== null) result[key] = value;
    }
    return Object.freeze(result);
  }

  /** Link only a caller-selected durable file into an app-private sandbox path. */
  async linkIntoSandbox(key: string, sandboxRoot: string, linkPath: string): Promise<void> {
    const root = normalizeAbsolute(sandboxRoot);
    const link = normalizeAbsolute(linkPath);
    if (!root || !link || (link !== root && !link.startsWith(`${root}/`)) || !this.storage.symlink) {
      throw new PersistenceError("PERSISTENCE_LINK_UNSAFE", "Private link must remain under the app sandbox and the provider must support links");
    }
    const target = this.path("private", key);
    try { await this.storage.symlink(target, link); }
    catch { throw new PersistenceError("PERSISTENCE_BACKEND_FAILED", "Private compatibility link could not be created"); }
  }

  /** Adapt durable metadata storage to WorkspaceSnapshot's existing metadata-store contract. */
  asSnapshotMetadataStore(key = "workspace-snapshots.json"): Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void> }> {
    return { read: () => this.read(key, "private"), write: (value) => this.write(key, value, "private") };
  }

  /** Expose immutable classification rules for UI/export tooling without exposing stored data. */
  classification(keys: readonly string[]): StoreClassification {
    const result: Record<string, PersistenceVisibility> = {};
    for (const key of keys) result[key] = this.classify(key);
    return Object.freeze(result);
  }
}

function normalizeAbsolute(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\")) return null;
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) return null;
  return `/${parts.join("/")}`;
}
