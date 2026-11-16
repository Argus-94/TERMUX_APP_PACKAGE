import type { ExecutionEnvironment } from "../../environment/ExecutionEnvironment";
import type { HomeLayout } from "../../home/HomeLayout";
import { validateProjectName } from "../../project-manager";
import type { RuntimeTaskGate } from "../../runtime/RuntimeTaskGate";
import { EnvironmentTextStore } from "../../runtime/RuntimeStores";
import { getSnapshotExcludes } from "./SnapshotExclude";
import { buildArchiveSecretScanCommand, isSecretArchiveMember } from "../../../lib/secret-archive-policy";
import type { UninstallSafeStore } from "../persistence/UninstallSafeStore";

export type SnapshotRecord = Readonly<{ id: string; projectId: string; archivePath: string; createdAt: number; label?: string }>;
export type SnapshotErrorCode = "PROJECT_PATH_INVALID" | "SNAPSHOT_NOT_FOUND" | "SNAPSHOT_CREATE_FAILED" | "SNAPSHOT_RESTORE_FAILED" | "SNAPSHOT_FORK_FAILED" | "SNAPSHOT_ARCHIVE_UNSAFE" | "SNAPSHOT_STORAGE_FAILED";
export class SnapshotError extends Error { constructor(readonly code: SnapshotErrorCode, message: string) { super(message); this.name = "SnapshotError"; } }
export type SnapshotMetadataStore = Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void> }>;
export type WorkspaceSnapshotOptions = Readonly<{ metadataStore?: SnapshotMetadataStore; uninstallSafeStore?: UninstallSafeStore; beforeRestore?: (projectRoot: string, snapshot: SnapshotRecord) => Promise<void>; taskGate?: RuntimeTaskGate; now?: () => number }>;

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function normalize(path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\n") || path.includes("\r")) throw new SnapshotError("PROJECT_PATH_INVALID", "Snapshot path must be an absolute safe path");
  const out: string[] = [];
  for (const part of path.split("/")) { if (!part || part === ".") continue; if (part === "..") { if (!out.length) throw new SnapshotError("PROJECT_PATH_INVALID", "Snapshot path escaped its root"); out.pop(); } else out.push(part); }
  return `/${out.join("/")}`;
}
function isWithin(parent: string, candidate: string): boolean { const p = normalize(parent).replace(/\/$/, "") || "/"; const c = normalize(candidate); return c === p || c.startsWith(`${p}/`); }
function safeLabel(label?: string): string | undefined {
  if (!label) return undefined;
  const value = label.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,95}$/.test(value) || /(?:secret|token|credential|password|api[_-]?key|bearer)/i.test(value)) return undefined;
  return value;
}

/** Workspace-only tar snapshots. System/rootfs backups remain owned by BackupManager. */
export class WorkspaceSnapshot {
  private readonly metadata: SnapshotMetadataStore;
  private readonly now: () => number;
  private serial = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly env: ExecutionEnvironment, private readonly home: HomeLayout, options: WorkspaceSnapshotOptions = {}) {
    this.metadata = options.metadataStore ?? options.uninstallSafeStore?.asSnapshotMetadataStore() ?? new EnvironmentTextStore(env, `${home.metadata}/workspace-snapshots.json`);
    this.now = options.now ?? Date.now;
    this.beforeRestore = options.beforeRestore;
    this.gate = options.taskGate;
  }
  private readonly beforeRestore?: WorkspaceSnapshotOptions["beforeRestore"];
  private readonly gate?: RuntimeTaskGate;
  private snapshotsRoot(): string { return `${this.home.backups.replace(/[\\/]+$/, "")}/workspace-snapshots`; }

  private async canonical(path: string): Promise<string> { const normalized = normalize(path); try { return normalize(this.env.resolvePath ? await this.env.resolvePath(normalized) : normalized); } catch { throw new SnapshotError("PROJECT_PATH_INVALID", "Snapshot path could not be canonicalized"); } }
  private async projectIdentity(projectRoot: string): Promise<{ projectId: string; root: string }> {
    const projects = await this.canonical(this.home.projects); const root = await this.canonical(projectRoot);
    if (!isWithin(projects, root) || root === projects) throw new SnapshotError("PROJECT_PATH_INVALID", "Workspace snapshots are restricted to a direct project under HOME/projects");
    const projectId = root.slice(projects.replace(/\/$/, "").length + 1);
    if (projectId.includes("/") || validateProjectName(projectId) !== projectId) throw new SnapshotError("PROJECT_PATH_INVALID", "Project path is not a valid workspace root");
    const home = await this.canonical(this.home.root); if (!isWithin(home, root)) throw new SnapshotError("PROJECT_PATH_INVALID", "Project path escaped AI Builder HOME");
    return { projectId, root };
  }

  private async readRecords(): Promise<SnapshotRecord[]> {
    try { const raw = await this.metadata.read(); if (!raw) return []; const parsed: unknown = JSON.parse(raw); if (!Array.isArray(parsed)) return []; return parsed.filter((x): x is SnapshotRecord => !!x && typeof x.id === "string" && /^[A-Za-z0-9_-]{4,100}$/.test(x.id) && typeof x.projectId === "string" && typeof x.archivePath === "string" && Number.isFinite(x.createdAt)); }
    catch { return []; }
  }
  private async writeRecords(records: readonly SnapshotRecord[]): Promise<void> {
    const run = this.writes.catch(() => undefined).then(async () => { try { await this.metadata.write(JSON.stringify(records)); } catch { throw new SnapshotError("SNAPSHOT_STORAGE_FAILED", "Snapshot metadata could not be saved"); } });
    this.writes = run.then(() => undefined, () => undefined); await run;
  }
  private newId(): string { return `snap-${this.now()}-${(++this.serial).toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  private async checkedArchive(record: SnapshotRecord): Promise<string> {
    if (!isWithin(this.snapshotsRoot(), record.archivePath)) throw new SnapshotError("SNAPSHOT_ARCHIVE_UNSAFE", "Snapshot archive path escaped its storage root");
    const archive = await this.canonical(record.archivePath); const base = await this.canonical(this.snapshotsRoot());
    if (!isWithin(base, archive) || !(await this.env.exists(archive))) throw new SnapshotError("SNAPSHOT_NOT_FOUND", "Snapshot archive is missing");
    return archive;
  }
  private async run(command: string, cwd: string): Promise<string> {
    const result = await this.env.exec(command, { cwd, timeoutMs: 300_000 });
    if (result.exitCode !== 0) throw new SnapshotError("SNAPSHOT_CREATE_FAILED", "Snapshot archive command failed");
    return result.stdout;
  }
  private async validateArchive(archive: string): Promise<void> {
    let listing: string;
    let detailedListing: string;
    try {
      const [names, details] = await Promise.all([
        this.env.exec(`tar -tzf ${shellQuote(archive)}`, { cwd: this.home.root, timeoutMs: 60_000 }),
        this.env.exec(`tar -tvzf ${shellQuote(archive)}`, { cwd: this.home.root, timeoutMs: 60_000 }),
      ]);
      if (names.exitCode !== 0 || details.exitCode !== 0) throw new Error("bad tar");
      listing = names.stdout;
      detailedListing = details.stdout;
    }
    catch { throw new SnapshotError("SNAPSHOT_ARCHIVE_UNSAFE", "Snapshot archive could not be listed safely"); }
    const entries = listing.split(/\r?\n/).filter(Boolean);
    if (entries.length === 0) throw new SnapshotError("SNAPSHOT_ARCHIVE_UNSAFE", "Empty snapshot archives are not restorable");
    for (const entry of entries) {
      if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..")) throw new SnapshotError("SNAPSHOT_ARCHIVE_UNSAFE", "Snapshot archive contains an unsafe path");
      if (isSecretArchiveMember(entry)) throw new SnapshotError("SNAPSHOT_ARCHIVE_UNSAFE", "Snapshot archive contains a forbidden credential path");
    }
    // Extraction is staged, but archive symlinks/hardlinks and special files can
    // still redirect later members or create surprising filesystem objects.
    // Workspace snapshots intentionally support only regular files/directories.
    for (const line of detailedListing.split(/\r?\n/).filter(Boolean)) {
      if (line[0] !== "-" && line[0] !== "d") {
        throw new SnapshotError("SNAPSHOT_ARCHIVE_UNSAFE", "Snapshot archive contains a link or special filesystem entry");
      }
    }
    const secretScan = await this.env.exec(buildArchiveSecretScanCommand(archive), { cwd: this.home.root, timeoutMs: 300_000 });
    if (secretScan.exitCode === 0) throw new SnapshotError("SNAPSHOT_ARCHIVE_UNSAFE", "Snapshot archive contains credential-like content");
    if (secretScan.exitCode !== 1) throw new SnapshotError("SNAPSHOT_ARCHIVE_UNSAFE", "Snapshot archive content could not be scanned safely");
  }

  /** Create one compressed workspace archive, excluding caches, package trees and common secret files. */
  async createSnapshot(projectRoot: string, label?: string): Promise<SnapshotRecord> {
    try { return await this.createSnapshotInternal(projectRoot, label); }
    catch (error) { if (error instanceof SnapshotError) throw error; throw new SnapshotError("SNAPSHOT_CREATE_FAILED", "Workspace snapshot failed"); }
  }

  private async createSnapshotInternal(projectRoot: string, label?: string): Promise<SnapshotRecord> {
    const { projectId, root } = await this.projectIdentity(projectRoot);
    if (!(await this.env.exists(root))) throw new SnapshotError("PROJECT_PATH_INVALID", "Project workspace does not exist");
    const id = this.newId(); const archivePath = `${this.snapshotsRoot()}/${projectId}/${id}.tar.gz`;
    const temporaryArchivePath = `${archivePath}.tmp`;
    const archiveDir = archivePath.slice(0, archivePath.lastIndexOf("/")); await this.env.mkdir(archiveDir);
    let excludeFile = ""; const excludePath = `${root}/.aib/snapshot-exclude`;
    try { if (await this.env.exists(excludePath)) excludeFile = await this.env.read(excludePath); } catch { /* optional project config */ }
    let excludes: readonly string[];
    try { excludes = getSnapshotExcludes(excludeFile); } catch { throw new SnapshotError("SNAPSHOT_CREATE_FAILED", "Project snapshot exclude file contains an unsafe pattern"); }
    const args = excludes.map((pattern) => `--exclude=${shellQuote(pattern)}`).join(" ");
    const command = `tar -czf ${shellQuote(temporaryArchivePath)} ${args} -C ${shellQuote(root)} .`;
    try {
      await this.run(command, root);
      const scan = await this.env.exec(buildArchiveSecretScanCommand(temporaryArchivePath), { cwd: root, timeoutMs: 300_000 });
      if (scan.exitCode === 0) throw new SnapshotError("SNAPSHOT_CREATE_FAILED", "Snapshot contains credential-like content and was not committed");
      if (scan.exitCode !== 1) throw new SnapshotError("SNAPSHOT_CREATE_FAILED", "Snapshot content could not be scanned safely");
      const commit = await this.env.exec(`if [ -e ${shellQuote(archivePath)} ]; then exit 1; else mv -- ${shellQuote(temporaryArchivePath)} ${shellQuote(archivePath)}; fi`, { cwd: root, timeoutMs: 30_000 });
      if (commit.exitCode !== 0) throw new SnapshotError("SNAPSHOT_CREATE_FAILED", "Snapshot archive could not be committed");
    } catch (error) {
      try { await this.env.exec(`rm -f -- ${shellQuote(temporaryArchivePath)}`, { cwd: root, timeoutMs: 10_000 }); } catch { /* best effort cleanup of only this invocation's temporary archive */ }
      throw error instanceof SnapshotError ? error : new SnapshotError("SNAPSHOT_CREATE_FAILED", "Workspace snapshot failed");
    }
    const record: SnapshotRecord = { id, projectId, archivePath, createdAt: this.now(), ...(safeLabel(label) ? { label: safeLabel(label) } : {}) };
    try { const all = await this.readRecords(); all.push(record); await this.writeRecords(all); }
    catch (error) { try { await this.env.exec(`rm -f -- ${shellQuote(archivePath)}`, { cwd: root, timeoutMs: 10_000 }); } catch { /* best effort cleanup of unrecorded archive */ } throw error instanceof SnapshotError ? error : new SnapshotError("SNAPSHOT_STORAGE_FAILED", "Snapshot record could not be saved"); }
    return record;
  }

  /** Restore one workspace snapshot via staged extraction and atomic directory rename; first records a pre-restore snapshot. */
  async restoreSnapshot(projectRoot: string, snapshotId: string): Promise<SnapshotRecord> {
    try { return this.gate ? await this.gate.run("maintenance", "workspace-snapshot:restore", () => this.restoreSnapshotInternal(projectRoot, snapshotId)) : await this.restoreSnapshotInternal(projectRoot, snapshotId); }
    catch (error) { if (error instanceof SnapshotError) throw error; throw new SnapshotError("SNAPSHOT_RESTORE_FAILED", "Workspace restore failed"); }
  }

  private async restoreSnapshotInternal(projectRoot: string, snapshotId: string): Promise<SnapshotRecord> {
    const { projectId, root } = await this.projectIdentity(projectRoot); const record = (await this.readRecords()).find((x) => x.id === snapshotId && x.projectId === projectId);
    if (!record) throw new SnapshotError("SNAPSHOT_NOT_FOUND", "Snapshot was not found for this project");
    const archive = await this.checkedArchive(record); await this.validateArchive(archive);
    if (this.beforeRestore) { try { await this.beforeRestore(root, record); } catch { throw new SnapshotError("SNAPSHOT_RESTORE_FAILED", "Pre-restore checkpoint failed; workspace was not changed"); } }
    const safetySnapshot = await this.createSnapshot(root, `pre-restore-${record.id}`);
    const parent = root.slice(0, root.lastIndexOf("/")) || "/"; const staging = `${parent}/.aib-restore-${this.newId()}`; const previous = `${parent}/.aib-before-restore-${this.newId()}`;
    await this.env.mkdir(staging);
    try {
      const extract = await this.env.exec(`tar -xzf ${shellQuote(archive)} --no-same-owner --no-same-permissions -C ${shellQuote(staging)}`, { cwd: parent, timeoutMs: 300_000 });
      if (extract.exitCode !== 0) throw new SnapshotError("SNAPSHOT_RESTORE_FAILED", "Snapshot extraction failed");
      const swap = `if mv -- ${shellQuote(root)} ${shellQuote(previous)}; then if mv -- ${shellQuote(staging)} ${shellQuote(root)}; then exit 0; else mv -- ${shellQuote(previous)} ${shellQuote(root)}; exit 1; fi; else exit 1; fi`;
      const result = await this.env.exec(swap, { cwd: parent, timeoutMs: 30_000 });
      if (result.exitCode !== 0) throw new SnapshotError("SNAPSHOT_RESTORE_FAILED", "Workspace restore transaction could not be committed");
    } catch (error) {
      try { await this.env.exec(`rm -rf -- ${shellQuote(staging)}`, { cwd: parent, timeoutMs: 30_000 }); } catch { /* staging was created exclusively by this operation */ }
      throw error instanceof SnapshotError ? error : new SnapshotError("SNAPSHOT_RESTORE_FAILED", "Workspace restore failed");
    }
    return safetySnapshot;
  }

  /** Fork an existing workspace snapshot into a new, validated project name. */
  async forkSnapshot(snapshotId: string, newProjectName: string): Promise<string> {
    try { return this.gate ? await this.gate.run("maintenance", "workspace-snapshot:fork", () => this.forkSnapshotInternal(snapshotId, newProjectName)) : await this.forkSnapshotInternal(snapshotId, newProjectName); }
    catch (error) { if (error instanceof SnapshotError) throw error; throw new SnapshotError("SNAPSHOT_FORK_FAILED", "Workspace fork failed"); }
  }

  /** Create a fresh exclude-aware snapshot and fork it in one operation. */
  async forkProject(projectRoot: string, newProjectName: string, label = "fork-source"): Promise<string> {
    const record = await this.createSnapshot(projectRoot, label);
    return this.forkSnapshot(record.id, newProjectName);
  }

  private async forkSnapshotInternal(snapshotId: string, newProjectName: string): Promise<string> {
    const projectId = validateProjectName(newProjectName); const record = (await this.readRecords()).find((x) => x.id === snapshotId);
    if (!record) throw new SnapshotError("SNAPSHOT_NOT_FOUND", "Snapshot was not found");
    const projects = await this.canonical(this.home.projects); const destination = normalize(`${projects}/${projectId}`);
    if (!isWithin(projects, destination) || destination === projects || await this.env.exists(destination)) throw new SnapshotError("SNAPSHOT_FORK_FAILED", "Destination project already exists or is invalid");
    const archive = await this.checkedArchive(record); await this.validateArchive(archive);
    const stage = normalize(`${projects}/.aib-fork-${this.newId()}`);
    let forkCreated = false;
    try {
      const make = await this.env.exec(`mkdir -- ${shellQuote(stage)}`, { cwd: projects, timeoutMs: 15_000 }); if (make.exitCode !== 0) throw new Error("mkdir failed");
      const extract = await this.env.exec(`tar -xzf ${shellQuote(archive)} --no-same-owner --no-same-permissions -C ${shellQuote(stage)}`, { cwd: projects, timeoutMs: 300_000 }); if (extract.exitCode !== 0) throw new Error("extract failed");
      const move = await this.env.exec(`mv -- ${shellQuote(stage)} ${shellQuote(destination)}`, { cwd: projects, timeoutMs: 30_000 }); if (move.exitCode !== 0) throw new Error("move failed");
      forkCreated = true;
      const all = await this.readRecords(); all.push({ ...record, id: this.newId(), projectId, archivePath: record.archivePath, createdAt: this.now(), label: `fork-of-${record.id}` }); await this.writeRecords(all);
      return destination;
    } catch { try { await this.env.exec(`rm -rf -- ${shellQuote(stage)}`, { cwd: projects, timeoutMs: 30_000 }); } catch { /* only temporary fork staging path */ } if (forkCreated) try { await this.env.exec(`rm -rf -- ${shellQuote(destination)}`, { cwd: projects, timeoutMs: 30_000 }); } catch { /* only the destination created by this invocation */ } throw new SnapshotError("SNAPSHOT_FORK_FAILED", "Workspace could not be forked from snapshot"); }
  }

  /** List snapshots chronologically for one validated project name. */
  async listSnapshots(projectId: string): Promise<readonly SnapshotRecord[]> {
    try { const name = validateProjectName(projectId); await this.writes.catch(() => undefined); return (await this.readRecords()).filter((record) => record.projectId === name).sort((a, b) => a.createdAt - b.createdAt); }
    catch (error) { if (error instanceof SnapshotError) throw error; throw new SnapshotError("SNAPSHOT_STORAGE_FAILED", "Snapshot records could not be listed"); }
  }
}
