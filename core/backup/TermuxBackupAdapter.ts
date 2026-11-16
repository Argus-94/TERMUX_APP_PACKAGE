import type { ExecutionEnvironment } from "../environment/ExecutionEnvironment";
import type { HomeLayout } from "../home/HomeLayout";
import type { BackupAdapter, BackupManifest } from "./BackupManager";
import { buildArchiveSecretScanCommand, isSecretArchiveMember, SECRET_ARCHIVE_TAR_EXCLUDES } from "../../lib/secret-archive-policy";

function q(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

const BACKUP_EXCLUDES = SECRET_ARCHIVE_TAR_EXCLUDES;
const MAX_RESTORE_MEMBERS = 20_000;
const MAX_RESTORE_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;

/** Real Android/Termux adapter: tar.gz staging + gzip CRC + sha256 verification. */
export class TermuxBackupAdapter implements BackupAdapter {
  constructor(private readonly env: ExecutionEnvironment, private readonly home: HomeLayout) {}

  private archive(destination: string) {
    return `${destination.replace(/[\\/]+$/, "")}/ai-builder-data.tar.gz`;
  }

  private manifest(destination: string) {
    return `${destination.replace(/[\\/]+$/, "")}/manifest.json`;
  }

  private relativePaths(paths: string[]): string[] {
    const root = this.home.root.replace(/\/+$/, "") || "/";
    const prefix = root === "/" ? "/" : `${root}/`;
    return paths.map((value) => {
      if (value.includes("\\")) throw new Error("BACKUP_PATH_INVALID");
      const normalized = value.replace(/\/{2,}/g, "/");
      if (!normalized.startsWith(prefix)) throw new Error("BACKUP_PATH_OUTSIDE_HOME");
      const relative = normalized.slice(prefix.length);
      if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error("BACKUP_PATH_INVALID");
      }
      return relative;
    });
  }

  async ensureDir(path: string) {
    await this.env.mkdir(path);
  }

  async snapshot(paths: string[], destination: string) {
    if (!paths.length) return;
    await this.ensureDir(destination);
    const rel = this.relativePaths(paths);
    const excludes = BACKUP_EXCLUDES.map((pattern) => `--exclude=${q(pattern)}`).join(" ");
    const archive = this.archive(destination);
    const temporary = `${archive}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cleanup = async () => { try { await this.env.exec(`rm -f -- ${q(temporary)}`, { cwd: this.home.root }); } catch { /* best-effort cleanup of this invocation's temporary archive */ } };
    const command = `tar -czf ${q(temporary)} ${excludes} -C ${q(this.home.root)} -- ${rel.map(q).join(" ")}`;
    try {
      const result = await this.env.exec(command, { cwd: this.home.root }) as { exitCode: number; stderr?: string };
      if (result.exitCode !== 0) throw new Error(result.stderr || "BACKUP_ARCHIVE_FAILED");
      const integrity = await this.env.exec(`tar -tzf ${q(temporary)} >/dev/null && tar -xzf ${q(temporary)} -O >/dev/null`, { cwd: this.home.root }) as { exitCode: number; stderr?: string };
      if (integrity.exitCode !== 0) throw new Error(integrity.stderr || "BACKUP_ARCHIVE_CONTENT_READ_FAILED");
      const scan = await this.env.exec(buildArchiveSecretScanCommand(temporary), { cwd: this.home.root }) as { exitCode: number; stderr?: string };
      if (scan.exitCode === 0) throw new Error("BACKUP_ARCHIVE_SECRET_CONTENT_FORBIDDEN");
      if (scan.exitCode !== 1) throw new Error(scan.stderr || "BACKUP_ARCHIVE_CONTENT_SCAN_FAILED");
      const commit = await this.env.exec(`mv -f -- ${q(temporary)} ${q(archive)}`, { cwd: this.home.root }) as { exitCode: number; stderr?: string };
      if (commit.exitCode !== 0) throw new Error(commit.stderr || "BACKUP_ARCHIVE_COMMIT_FAILED");
    } catch (error) { await cleanup(); throw error; }
  }

  async inspect(destination: string) {
    const archive = this.archive(destination);
    const check = await this.env.exec(`tar -tzf ${q(archive)} >/dev/null && sha256sum ${q(archive)}`) as { exitCode: number; stderr?: string; stdout?: string };
    if (check.exitCode !== 0) return { ok: false, bytes: 0, files: 0, error: check.stderr || "BACKUP_CORRUPT" };
    const digest = String(check.stdout || "").trim().split(/\s+/)[0];
    const size = await this.env.exec(`wc -c < ${q(archive)}`) as { stdout?: string };
    const files = await this.env.exec(`tar -tzf ${q(archive)} | wc -l`) as { stdout?: string };
    return { ok: true, bytes: Number(String(size.stdout || "0").trim()) || 0, files: Number(String(files.stdout || "0").trim()) || 0, digest };
  }

  private async validatedArchiveMembers(source: string, allowedPaths: string[]): Promise<string[]> {
    const archive = this.archive(source);
    const roots = this.relativePaths(allowedPaths);
    if (!roots.length) throw new Error("BACKUP_RESTORE_SCOPE_EMPTY");

    const memberCountResult = await this.env.exec(`tar -tzf ${q(archive)} | wc -l`);
    const memberCount = Number(String((memberCountResult as { stdout?: string }).stdout || "").trim());
    if ((memberCountResult as { exitCode?: number }).exitCode !== 0 || !Number.isSafeInteger(memberCount) || memberCount < 1 || memberCount > MAX_RESTORE_MEMBERS) {
      throw new Error("BACKUP_ARCHIVE_LIMIT_EXCEEDED");
    }

    const expandedResult = await this.env.exec(`tar -xzf ${q(archive)} -O | wc -c`);
    const expandedBytes = Number(String((expandedResult as { stdout?: string }).stdout || "").trim());
    if ((expandedResult as { exitCode?: number }).exitCode !== 0 || !Number.isSafeInteger(expandedBytes) || expandedBytes < 0 || expandedBytes > MAX_RESTORE_EXPANDED_BYTES) {
      throw new Error("BACKUP_ARCHIVE_LIMIT_EXCEEDED");
    }

    // Verbose and name listings are compared so control characters (notably
    // newlines) cannot split one member into multiple apparent paths. Only regular
    // files and directories are accepted; links can redirect later writes.
    const typedListing = await this.env.exec(
      `tar -tvzf ${q(archive)}`,
      { preserveOutput: true },
    ) as { exitCode: number; stderr?: string; stdout?: string };
    if (typedListing.exitCode !== 0) throw new Error(typedListing.stderr || "BACKUP_ARCHIVE_TYPE_LIST_FAILED");
    const typeLines = String(typedListing.stdout || "").split(/\r?\n/).filter(Boolean);
    if (!typeLines.length || typeLines.some((line) => line[0] !== "-" && line[0] !== "d")) {
      throw new Error("BACKUP_ARCHIVE_UNSAFE_TYPE");
    }

    const listing = await this.env.exec(`tar -tzf ${q(archive)}`, { preserveOutput: true }) as { exitCode: number; stderr?: string; stdout?: string };
    if (listing.exitCode !== 0) throw new Error(listing.stderr || "BACKUP_CORRUPT");

    const members: string[] = [];
    const seen = new Set<string>();
    for (const raw of String(listing.stdout || "").split(/\r?\n/)) {
      if (!raw) continue;
      const name = raw.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
      const parts = name.split("/");
      if (
        !name ||
        name.startsWith("/") ||
        name.includes("\\") ||
        parts.some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error("BACKUP_ARCHIVE_UNSAFE_PATH");
      }
      if (isSecretArchiveMember(name)) throw new Error("BACKUP_ARCHIVE_SECRET_FORBIDDEN");
      if (!roots.some((root) => name === root || name.startsWith(`${root}/`))) {
        throw new Error("BACKUP_ARCHIVE_SCOPE_MISMATCH");
      }
      if (seen.has(name)) throw new Error("BACKUP_ARCHIVE_DUPLICATE_PATH");
      seen.add(name);
      members.push(name);
    }
    if (!members.length) throw new Error("BACKUP_ARCHIVE_EMPTY");
    if (members.length > MAX_RESTORE_MEMBERS) throw new Error("BACKUP_ARCHIVE_LIMIT_EXCEEDED");
    if (members.length !== typeLines.length) throw new Error("BACKUP_ARCHIVE_LISTING_MISMATCH");
    const missingRoots = roots.filter((root) => !members.some((name) => name === root || name.startsWith(`${root}/`)));
    if (missingRoots.length) throw new Error(`BACKUP_ARCHIVE_SCOPE_INCOMPLETE:${missingRoots.join(",")}`);
    const integrity = await this.env.exec(`tar -xzf ${q(archive)} -O >/dev/null`, { preserveOutput: true }) as { exitCode: number; stderr?: string };
    if (integrity.exitCode !== 0) throw new Error(integrity.stderr || "BACKUP_ARCHIVE_CONTENT_READ_FAILED");
    const secretScan = await this.env.exec(buildArchiveSecretScanCommand(archive), { preserveOutput: true }) as { exitCode: number; stderr?: string };
    if (secretScan.exitCode === 0) throw new Error("BACKUP_ARCHIVE_SECRET_CONTENT_FORBIDDEN");
    if (secretScan.exitCode !== 1) throw new Error(secretScan.stderr || "BACKUP_ARCHIVE_CONTENT_SCAN_FAILED");
    return members;
  }

  async validateRestoreScope(source: string, paths: string[]) {
    await this.validatedArchiveMembers(source, paths);
  }

  /** Clear only canonical HomeLayout paths; used for replace semantics and rollback. */
  async clear(paths: string[]) {
    const rel = this.relativePaths(paths);
    if (!rel.length) throw new Error("BACKUP_RESTORE_SCOPE_EMPTY");
    const result = await this.env.exec(
      `rm -rf -- ${rel.map((name) => q(`${this.home.root.replace(/[\\/]+$/, "")}/${name}`)).join(" ")}`,
      { cwd: this.home.root },
    ) as { exitCode: number; stderr?: string };
    if (result.exitCode !== 0) throw new Error(result.stderr || "BACKUP_RESTORE_CLEAR_FAILED");
  }

  async restore(source: string, paths: string[]) {
    const archive = this.archive(source);
    const members = await this.validatedArchiveMembers(source, paths);
    const args = members.map(q).join(" ");
    await this.clear(paths);
    const result = await this.env.exec(
      `tar -xzf ${q(archive)} -C ${q(this.home.root)} --no-same-owner --no-same-permissions -- ${args}`,
    ) as { exitCode: number; stderr?: string };
    if (result.exitCode !== 0) throw new Error(result.stderr || "BACKUP_RESTORE_FAILED");
  }

  async writeManifest(destination: string, manifest: BackupManifest) {
    await this.env.write(this.manifest(destination), JSON.stringify(manifest, null, 2));
  }

  async readManifest(source: string) {
    const manifestPath = this.manifest(source);
    let exists: boolean;
    try {
      exists = await this.env.exists(manifestPath);
    } catch {
      throw new Error("BACKUP_MANIFEST_READ_FAILED");
    }
    if (!exists) return null;
    let text: string;
    try {
      text = await this.env.read(manifestPath);
    } catch {
      throw new Error("BACKUP_MANIFEST_READ_FAILED");
    }
    try {
      return JSON.parse(text) as BackupManifest;
    } catch {
      throw new Error("BACKUP_MANIFEST_INVALID");
    }
  }

  /** List immediate subdirectories of parent (backup destinations). */
  async listChildren(parent: string): Promise<string[]> {
    try {
      const r = await this.env.exec(`ls -1 ${q(parent)} 2>/dev/null | head -80`) as { exitCode?: number; stdout?: string };
      if ((r.exitCode ?? 1) !== 0) return [];
      return String(r.stdout || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
