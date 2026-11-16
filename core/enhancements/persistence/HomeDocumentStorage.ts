import type { ExecutionEnvironment } from "../../environment/ExecutionEnvironment";
import { PersistenceError, type DurableDocumentStorage } from "./types";

const MAX_DOCUMENT_CHARS = 1_000_000;

/**
 * Durable text documents stored below AIBuilderTermux HOME. HOME is the existing
 * user-visible shared directory; this adapter deliberately does not claim that
 * its "private" namespace is encrypted or app-private.
 */
export class HomeDocumentStorage implements DurableDocumentStorage {
  private readonly root: string;

  constructor(private readonly env: ExecutionEnvironment, root: string) {
    this.root = normalizeAbsolute(root);
  }

  private async path(relativePath: string): Promise<string> {
    if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.includes("\0") || relativePath.includes("\n") || relativePath.includes("\r")) {
      throw new PersistenceError("PERSISTENCE_KEY_INVALID");
    }
    const parts = relativePath.split("/");
    if (parts.some((part) => !/^[A-Za-z0-9._-]{1,180}$/.test(part) || part === "." || part === "..")) {
      throw new PersistenceError("PERSISTENCE_KEY_INVALID");
    }
    const candidate = `${this.root}/${parts.join("/")}`;
    try {
      const canonicalRoot = this.env.resolvePath ? await this.env.resolvePath(this.root) : this.root;
      const canonical = this.env.resolvePath ? await this.env.resolvePath(candidate) : candidate;
      if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot.replace(/\/$/, "")}/`)) {
        throw new PersistenceError("PERSISTENCE_KEY_INVALID");
      }
      return canonical;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError("PERSISTENCE_BACKEND_FAILED");
    }
  }

  async read(relativePath: string): Promise<string | null> {
    try {
      const file = await this.path(relativePath);
      if (!(await this.env.exists(file))) return null;
      const contents = await this.env.read(file);
      if (contents.length > MAX_DOCUMENT_CHARS) throw new PersistenceError("PERSISTENCE_BACKEND_FAILED", "Durable document exceeds the size limit");
      return contents;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError("PERSISTENCE_BACKEND_FAILED");
    }
  }

  async write(relativePath: string, contents: string): Promise<void> {
    if (typeof contents !== "string" || contents.length > MAX_DOCUMENT_CHARS || contents.includes("\0")) {
      throw new PersistenceError("PERSISTENCE_BACKEND_FAILED", "Durable document is invalid or too large");
    }
    let temporary = "";
    try {
      const file = await this.path(relativePath);
      const slash = file.lastIndexOf("/");
      const parent = slash > 0 ? file.slice(0, slash) : "/";
      await this.env.mkdir(parent);
      temporary = `${file}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
      await this.env.write(temporary, contents);
      const result = await this.env.exec(`mv -f -- ${shellQuote(temporary)} ${shellQuote(file)}`, { cwd: this.root, timeoutMs: 15_000 });
      if (result.exitCode !== 0) throw new Error("atomic rename failed");
    } catch (error) {
      if (temporary) {
        try { await this.env.exec(`rm -f -- ${shellQuote(temporary)}`, { cwd: this.root, timeoutMs: 10_000 }); } catch { /* best-effort temporary-file cleanup */ }
      }
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError("PERSISTENCE_BACKEND_FAILED");
    }
  }

  async remove(relativePath: string): Promise<void> {
    try {
      const file = await this.path(relativePath);
      if (!(await this.env.exists(file))) return;
      const result = await this.env.exec(`rm -f -- ${shellQuote(file)}`, { cwd: this.root, timeoutMs: 10_000 });
      if (result.exitCode !== 0) throw new Error("remove failed");
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError("PERSISTENCE_BACKEND_FAILED");
    }
  }
}

function normalizeAbsolute(value: string): string {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\") || value.includes("\n") || value.includes("\r")) {
    throw new PersistenceError("PERSISTENCE_KEY_INVALID", "Durable storage root must be an absolute safe path");
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new PersistenceError("PERSISTENCE_KEY_INVALID");
  return `/${parts.join("/")}`;
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
