/**
 * Phase 34: Persistent AI Workspace.
 *
 * Gives every AI project a durable workspace with Git-backed checkpoints,
 * snapshots, diff/history, undo/restore, and a bounded dependency-cache area.
 * The runtime never accepts arbitrary paths: project ids resolve only below
 * the canonical AIBuilderTermux projects directory.
 */
import type { HomeLayout } from "../home/HomeLayout";
import type { ExecutionEnvironment } from "../environment/ExecutionEnvironment";
import { validateProjectName } from "../project-manager";
import { buildArchiveSecretScanCommand, isSecretArchiveMember } from "../../lib/secret-archive-policy";

export type WorkspaceGitEntry = {
  readonly hash: string;
  readonly subject: string;
  readonly timestamp: string;
};

export type PersistentWorkspaceStatus = {
  readonly projectId: string;
  readonly path: string;
  readonly gitReady: boolean;
  readonly clean: boolean;
  readonly branch: string;
  readonly head?: string;
  readonly changedFiles: number;
  readonly dependencyCachePath: string;
};

export type PersistentWorkspaceSnapshot = {
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly commit: string;
  readonly createdAt: number;
  readonly archivePath: string;
};

export type PersistentWorkspaceOptions = {
  readonly maxHistory?: number;
  readonly maxSnapshots?: number;
};

const MAX_HISTORY = 100;
const MAX_SNAPSHOTS = 20;
const MAX_RESTORE_MEMBERS = 20_000;
const MAX_RESTORE_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;
type ExecResult = { exitCode: number; stdout?: string; stderr?: string };
const MAX_LABEL = 80;
const SNAPSHOT_EXCLUDES = [".git", ".aib-snapshots", ".aib-memory", ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.jks", "local.properties"];

function shell(value: string): string { return JSON.stringify(value); }

function safeLabel(value: string): string {
  const label = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_LABEL);
  if (!label) throw new Error("WORKSPACE_LABEL_REQUIRED");
  return label;
}

function projectPath(home: HomeLayout, projectId: string): string {
  const id = validateProjectName(projectId);
  return `${home.projects.replace(/[\\/]+$/, "")}/${id}`;
}

function output(result: { stdout?: string; stderr?: string; exitCode?: number }): string {
  return (result.stdout || "").trim();
}

export class PersistentAIWorkspace {
  private readonly maxHistory: number;
  private readonly maxSnapshots: number;

  constructor(
    private readonly environment: ExecutionEnvironment,
    private readonly home: HomeLayout,
    options: PersistentWorkspaceOptions = {},
  ) {
    this.maxHistory = Math.min(MAX_HISTORY, Math.max(1, options.maxHistory ?? 50));
    this.maxSnapshots = Math.min(MAX_SNAPSHOTS, Math.max(1, options.maxSnapshots ?? 10));
  }

  private async exec(command: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    return await this.environment.exec(command, options) as ExecResult;
  }

  workspacePath(projectId: string): string { return projectPath(this.home, projectId); }

  async ensure(projectId: string): Promise<string> {
    const path = this.workspacePath(projectId);
    await this.environment.mkdir(path);
    await this.environment.mkdir(`${path}/.aib-snapshots`);
    await this.environment.mkdir(`${this.home.cache}/dependencies/${validateProjectName(projectId)}`);
    const ignorePath = `${path}/.gitignore`;
    const requiredIgnore = [
      ".aib-snapshots/",
      ".aib-memory/",
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "*.p12",
      "*.jks",
      "local.properties",
    ];
    let ignore = await this.environment.exists(ignorePath) ? await this.environment.read(ignorePath) : "";
    const lines = new Set(ignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    let changed = false;
    for (const rule of requiredIgnore) {
      if (!lines.has(rule)) { lines.add(rule); changed = true; }
    }
    if (changed || !(await this.environment.exists(ignorePath))) {
      await this.environment.write(ignorePath, `${[...lines].join("\n")}\n`);
    }
    const git = await this.exec(`git -C ${shell(path)} rev-parse --is-inside-work-tree`, { cwd: path, timeoutMs: 10_000 });
    if (git.exitCode !== 0 || output(git) !== "true") {
      const init = await this.exec(`git init ${shell(path)}`, { cwd: path, timeoutMs: 20_000 });
      if (init.exitCode !== 0) throw new Error(`WORKSPACE_GIT_INIT_FAILED:${(init.stderr || "").trim().slice(0, 500)}`);
      await this.exec(`git -C ${shell(path)} config user.name ${shell("AIBuilder AI")}`);
      await this.exec(`git -C ${shell(path)} config user.email ${shell("ai-builder@localhost")}`);
    }
    return path;
  }

  async status(projectId: string): Promise<PersistentWorkspaceStatus> {
    const path = await this.ensure(projectId);
    const result = await this.exec(`git -C ${shell(path)} status --porcelain=v1 --branch`, { cwd: path, timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error("WORKSPACE_GIT_STATUS_FAILED");
    const lines = (result.stdout || "").split(/\r?\n/).filter(Boolean);
    const branchLine = lines[0] || "## main";
    const branch = branchLine.replace(/^##\s*/, "").split("...")[0].replace(/\[.*$/, "").trim() || "main";
    const changedFiles = Math.max(0, lines.length - 1);
    const head = output(await this.exec(`git -C ${shell(path)} rev-parse HEAD`, { cwd: path, timeoutMs: 10_000 }));
    return {
      projectId: validateProjectName(projectId), path, gitReady: true,
      clean: changedFiles === 0, branch, head: head || undefined, changedFiles,
      dependencyCachePath: `${this.home.cache}/dependencies/${validateProjectName(projectId)}`,
    };
  }

  async diff(projectId: string): Promise<string> {
    const path = await this.ensure(projectId);
    const result = await this.exec(`git -C ${shell(path)} diff --no-ext-diff`, { cwd: path, timeoutMs: 20_000 });
    if (result.exitCode !== 0) throw new Error("WORKSPACE_GIT_DIFF_FAILED");
    const untracked = await this.exec(`git -C ${shell(path)} ls-files --others --exclude-standard`, { cwd: path, timeoutMs: 10_000 });
    const extra = output(untracked);
    return `${result.stdout || ""}${extra ? `\nUNTRACKED:\n${extra}\n` : ""}`.slice(-100_000);
  }

  async checkpoint(projectId: string, message = "AI checkpoint"): Promise<WorkspaceGitEntry> {
    const path = await this.ensure(projectId);
    const subject = message.trim().slice(0, 160) || "AI checkpoint";
    const add = await this.exec(`git -C ${shell(path)} add -A`, { cwd: path, timeoutMs: 20_000 });
    if (add.exitCode !== 0) throw new Error("WORKSPACE_GIT_ADD_FAILED");
    const commit = await this.exec(`git -C ${shell(path)} commit -m ${shell(subject)}`, { cwd: path, timeoutMs: 30_000 });
    if (commit.exitCode !== 0 && !/nothing to commit/i.test(`${commit.stdout}\n${commit.stderr}`)) {
      throw new Error(`WORKSPACE_GIT_COMMIT_FAILED:${(commit.stderr || "").trim().slice(0, 500)}`);
    }
    const hash = output(await this.exec(`git -C ${shell(path)} rev-parse HEAD`, { cwd: path, timeoutMs: 10_000 }));
    if (!hash) throw new Error("WORKSPACE_NO_HEAD");
    return { hash, subject, timestamp: new Date().toISOString() };
  }

  async history(projectId: string, limit = this.maxHistory): Promise<WorkspaceGitEntry[]> {
    const path = await this.ensure(projectId);
    const bounded = Math.min(this.maxHistory, Math.max(1, Math.floor(limit)));
    const result = await this.exec(
      `git -C ${shell(path)} log -n ${bounded} --date=iso-strict --format=%H%x09%s%x09%aI`,
      { cwd: path, timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) return [];
    return (result.stdout || "").split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash, subject, timestamp] = line.split("\t");
      return { hash: hash || "", subject: subject || "", timestamp: timestamp || "" };
    }).filter((entry) => entry.hash);
  }

  async restore(projectId: string, ref = "HEAD~1"): Promise<void> {
    const path = await this.ensure(projectId);
    const validRef = /^[A-Za-z0-9._~^/-]{1,120}$/.test(ref.trim());
    if (!validRef) throw new Error("INVALID_GIT_REF");
    const check = await this.exec(`git -C ${shell(path)} rev-parse --verify ${shell(ref.trim())}`, { cwd: path, timeoutMs: 10_000 });
    if (check.exitCode !== 0) throw new Error("WORKSPACE_GIT_REF_NOT_FOUND");
    const result = await this.exec(`git -C ${shell(path)} reset --hard ${shell(ref.trim())}`, { cwd: path, timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error("WORKSPACE_RESTORE_FAILED");
  }

  async snapshot(projectId: string, label = "snapshot"): Promise<PersistentWorkspaceSnapshot> {
    const path = await this.ensure(projectId);
    const safe = safeLabel(label);
    const checkpoint = await this.checkpoint(projectId, `snapshot: ${safe}`);
    const id = `${Date.now()}-${safe}`;
    const archivePath = `${path}/.aib-snapshots/${id}.tar.gz`;
    const temporaryArchive = `${archivePath}.tmp`;
    const excludeArgs = SNAPSHOT_EXCLUDES.map((pattern) => `--exclude=${shell(pattern)}`).join(" ");
    try {
      const archive = await this.exec(
        `tar -czf ${shell(temporaryArchive)} ${excludeArgs} -C ${shell(path)} .`,
        { cwd: path, timeoutMs: 60_000 },
      );
      if (archive.exitCode !== 0) throw new Error("WORKSPACE_SNAPSHOT_FAILED");
      const integrity = await this.exec(`tar -tzf ${shell(temporaryArchive)} >/dev/null && tar -xzf ${shell(temporaryArchive)} -O >/dev/null`, { cwd: path, timeoutMs: 300_000 });
      if (integrity.exitCode !== 0) throw new Error("WORKSPACE_SNAPSHOT_CONTENT_READ_FAILED");
      const scan = await this.exec(buildArchiveSecretScanCommand(temporaryArchive), { cwd: path, timeoutMs: 300_000 });
      if (scan.exitCode === 0) throw new Error("WORKSPACE_SNAPSHOT_SECRET_CONTENT_FORBIDDEN");
      if (scan.exitCode !== 1) throw new Error("WORKSPACE_SNAPSHOT_CONTENT_SCAN_FAILED");
      const commit = await this.exec(`mv -- ${shell(temporaryArchive)} ${shell(archivePath)}`, { cwd: path, timeoutMs: 30_000 });
      if (commit.exitCode !== 0) throw new Error("WORKSPACE_SNAPSHOT_COMMIT_FAILED");
    } catch (error) {
      await this.exec(`rm -f -- ${shell(temporaryArchive)}`, { cwd: path, timeoutMs: 10_000 });
      throw error instanceof Error && /^WORKSPACE_SNAPSHOT_/.test(error.message) ? error : new Error("WORKSPACE_SNAPSHOT_FAILED");
    }
    const record: PersistentWorkspaceSnapshot = { id, projectId: validateProjectName(projectId), label: safe, commit: checkpoint.hash, createdAt: Date.now(), archivePath };
    await this.environment.write(`${path}/.aib-snapshots/${id}.json`, JSON.stringify(record, null, 2));
    await this.pruneSnapshots(path);
    return record;
  }

  async restoreSnapshot(projectId: string, snapshotId: string): Promise<void> {
    const path = await this.ensure(projectId);
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(snapshotId)) throw new Error("INVALID_SNAPSHOT_ID");
      const archive = `${path}/.aib-snapshots/${snapshotId}.tar.gz`;
      if (!(await this.environment.exists(archive))) throw new Error("WORKSPACE_SNAPSHOT_NOT_FOUND");
      const restoreId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const restoreDir = `${this.home.cache}/workspace-restore-${restoreId}`;
      const rollbackDir = `${this.home.cache}/workspace-rollback-${restoreId}`;
      await this.environment.mkdir(restoreDir);
      try {
      const memberCount = await this.exec(`tar -tzf ${shell(archive)} | wc -l`, { cwd: path, timeoutMs: 300_000 });
      const count = Number((memberCount.stdout || "").trim());
      if (memberCount.exitCode !== 0 || !Number.isSafeInteger(count) || count < 1 || count > MAX_RESTORE_MEMBERS) throw new Error("WORKSPACE_SNAPSHOT_LIMIT_EXCEEDED");
      const listing = await this.exec(`tar -tzf ${shell(archive)}`, { cwd: path, timeoutMs: 30_000 });
      if (listing.exitCode !== 0) throw new Error("WORKSPACE_SNAPSHOT_LIST_FAILED");
      const entries = (listing.stdout || "").split(/\r?\n/).filter(Boolean);
      if (!entries.length || entries.length > MAX_RESTORE_MEMBERS) throw new Error("WORKSPACE_SNAPSHOT_LIMIT_EXCEEDED");
      for (const entry of entries) {
        const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "");
        if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
          throw new Error("WORKSPACE_SNAPSHOT_PATH_TRAVERSAL");
        }
        if (isSecretArchiveMember(normalized)) throw new Error("WORKSPACE_SNAPSHOT_SECRET_PATH_FORBIDDEN");
      }
      const integrity = await this.exec(`tar -xzf ${shell(archive)} -O >/dev/null`, { cwd: path, timeoutMs: 300_000 });
      if (integrity.exitCode !== 0) throw new Error("WORKSPACE_SNAPSHOT_CONTENT_READ_FAILED");
      const expanded = await this.exec(`tar -xzf ${shell(archive)} -O | wc -c`, { cwd: path, timeoutMs: 300_000 });
      const expandedBytes = Number((expanded.stdout || "").trim());
      if (expanded.exitCode !== 0 || !Number.isSafeInteger(expandedBytes) || expandedBytes < 0 || expandedBytes > MAX_RESTORE_EXPANDED_BYTES) throw new Error("WORKSPACE_SNAPSHOT_LIMIT_EXCEEDED");
      const secretScan = await this.exec(buildArchiveSecretScanCommand(archive), { cwd: path, timeoutMs: 300_000 });
      if (secretScan.exitCode === 0) throw new Error("WORKSPACE_SNAPSHOT_SECRET_CONTENT_FORBIDDEN");
      if (secretScan.exitCode !== 1) throw new Error("WORKSPACE_SNAPSHOT_CONTENT_SCAN_FAILED");
      const extract = await this.exec(`tar -xzf ${shell(archive)} -C ${shell(restoreDir)} --no-same-owner`, { cwd: path, timeoutMs: 60_000 });
      if (extract.exitCode !== 0) throw new Error("WORKSPACE_SNAPSHOT_EXTRACT_FAILED");
      // Prepare all live-only metadata in staging before touching the project.
      // A failed copy can therefore never leave a half-overwritten workspace.
      const preserve = await this.exec(
        `cp -a ${shell(`${path}/.git`)} ${shell(restoreDir)}/ && cp -a ${shell(`${path}/.aib-snapshots`)} ${shell(restoreDir)}/`,
        { cwd: path, timeoutMs: 60_000 },
      );
      if (preserve.exitCode !== 0) throw new Error("WORKSPACE_SNAPSHOT_METADATA_STAGE_FAILED");

      // Both directories live below the canonical HOME, so mv stays on the
      // same filesystem. Keep the old tree until the new tree is committed.
      const swap = await this.exec(
        `mv ${shell(path)} ${shell(rollbackDir)} && if mv ${shell(restoreDir)} ${shell(path)}; then :; else mv ${shell(rollbackDir)} ${shell(path)} || exit 74; exit 1; fi`,
        { cwd: this.home.root, timeoutMs: 60_000 },
      );
      if (swap.exitCode !== 0) throw new Error("WORKSPACE_SNAPSHOT_SWAP_FAILED");
      try {
        await this.checkpoint(projectId, `restore snapshot: ${snapshotId}`);
      } catch (error) {
        const rollback = await this.exec(
          `mv ${shell(path)} ${shell(restoreDir)} && mv ${shell(rollbackDir)} ${shell(path)}`,
          { cwd: this.home.root, timeoutMs: 60_000 },
        );
        if (rollback.exitCode !== 0) throw new Error("WORKSPACE_SNAPSHOT_ROLLBACK_FAILED");
        throw error;
      }
      await this.exec(`rm -rf ${shell(rollbackDir)}`, { cwd: this.home.root, timeoutMs: 30_000 });
    } finally {
      await this.exec(`rm -rf ${shell(restoreDir)}`, { cwd: path, timeoutMs: 20_000 });
    }
  }

  private async pruneSnapshots(path: string): Promise<void> {
    const result = await this.exec(`ls -1t ${shell(`${path}/.aib-snapshots`)}/*.tar.gz 2>/dev/null`, { cwd: path, timeoutMs: 10_000 });
    if (result.exitCode !== 0) return;
    const archives = (result.stdout || "").split(/\r?\n/).filter(Boolean);
    for (const archive of archives.slice(this.maxSnapshots)) {
      const id = archive.split("/").pop()?.replace(/\.tar\.gz$/, "") || "";
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(id)) continue;
      await this.exec(`rm -f ${shell(archive)} ${shell(`${path}/.aib-snapshots/${id}.json`)}`, { cwd: path, timeoutMs: 10_000 });
    }
  }

  async dependencyCachePath(projectId: string): Promise<string> {
    await this.ensure(projectId);
    return `${this.home.cache}/dependencies/${validateProjectName(projectId)}`;
  }
}

export function createPersistentAIWorkspace(environment: ExecutionEnvironment, home: HomeLayout): PersistentAIWorkspace {
  return new PersistentAIWorkspace(environment, home);
}
