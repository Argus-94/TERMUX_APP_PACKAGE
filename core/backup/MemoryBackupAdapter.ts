import type { BackupAdapter } from "./BackupManager";

/** Test/dev adapter. Production apps should provide a filesystem/archive adapter. */
export class MemoryBackupAdapter implements BackupAdapter {
  readonly snapshots = new Map<string, string[]>();
  async ensureDir(_path: string) {}
  async snapshot(paths: string[], destination: string) {
    this.snapshots.set(destination, [...paths]);
  }
  async inspect(destination: string) {
    return this.snapshots.has(destination)
      ? { ok: true, bytes: 0, files: this.snapshots.get(destination)!.length }
      : { ok: false, bytes: 0, files: 0, error: "BACKUP_NOT_FOUND" };
  }
  async restore(source: string, _paths: string[]) {
    if (!this.snapshots.has(source)) throw new Error("BACKUP_NOT_FOUND");
  }
  async listChildren(_parent: string): Promise<string[]> {
    return [...this.snapshots.keys()].map((k) => k.split("/").pop() || k);
  }
}
