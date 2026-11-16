export type PersistenceVisibility = "public" | "private" | "never";

export type PersistenceErrorCode =
  | "PERSISTENCE_KEY_INVALID"
  | "PERSISTENCE_NEVER_EXPORT"
  | "PERSISTENCE_BACKEND_FAILED"
  | "PERSISTENCE_LINK_UNSAFE"
  | "MIGRATION_FAILED"
  | "MIGRATION_RECEIPT_INVALID";

export class PersistenceError extends Error {
  constructor(readonly code: PersistenceErrorCode, message: string = code) {
    super(message);
    this.name = "PersistenceError";
  }
}

/** Adapter over a user-authorized SAF directory or another durable document provider. */
export interface DurableDocumentStorage {
  read(relativePath: string): Promise<string | null>;
  write(relativePath: string, contents: string): Promise<void>;
  remove(relativePath: string): Promise<void>;
  /** Optional operation for an app-private compatibility link; never follows an existing destination. */
  symlink?(target: string, linkPath: string): Promise<void>;
}

export type MigrationEntry = Readonly<{ key: string; contents: string; visibility: Exclude<PersistenceVisibility, "never"> }>;
export type MigrationReceipt = Readonly<{
  id: string;
  committedAt: number;
  entries: readonly Readonly<{ key: string; previous: string | null; visibility: Exclude<PersistenceVisibility, "never"> }> [];
}>;

export type StoreClassification = Readonly<Record<string, PersistenceVisibility>>;
