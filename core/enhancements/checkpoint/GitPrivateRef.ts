import { CheckpointError, type CheckpointRecord, type GitCommandRunner, type GitCommandResult } from "./types";

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function normalize(path: string): string | null {
  if (!path.startsWith("/") || path.includes("\0")) return null;
  const out: string[] = [];
  for (const part of path.split("/")) { if (!part || part === ".") continue; if (part === "..") { if (!out.length) return null; out.pop(); } else out.push(part); }
  return `/${out.join("/")}`;
}
function inside(path: string, root: string): boolean { const p = normalize(path); const r = normalize(root); return Boolean(p && r && (p === r || p.startsWith(`${r.replace(/\/$/, "")}/`))); }
function join(root: string, child: string): string { return `${root.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`; }

/** Safe operations on private Git refs, using an isolated index file and the supplied execution boundary. */
export class GitPrivateRef {
  constructor(private readonly homeRoot: string, private readonly runner: GitCommandRunner, private readonly canonicalize?: (path: string) => Promise<string>) {}

  private async checkedRoot(root: string): Promise<string> {
    let home = normalize(this.homeRoot); let project = normalize(root);
    if (this.canonicalize) { try { [home, project] = await Promise.all([this.canonicalize(this.homeRoot), this.canonicalize(root)]); } catch { throw new CheckpointError("PROJECT_OUTSIDE_HOME", "Project path could not be canonicalized"); } }
    if (!home || !project || !inside(project, home)) throw new CheckpointError("PROJECT_OUTSIDE_HOME", "Checkpoint project must remain inside HOME");
    const probe = await this.runner(project, "git rev-parse --is-inside-work-tree");
    if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") throw new CheckpointError("NOT_GIT_REPOSITORY", "Checkpoint project is not a Git worktree");
    return project;
  }

  private async run(root: string, args: readonly string[], index?: string, extraEnv: Readonly<Record<string, string>> = {}): Promise<GitCommandResult> {
    const command = `git ${args.map(quote).join(" ")}`;
    const env = { ...(index ? { GIT_INDEX_FILE: index } : {}), ...extraEnv };
    const result = await this.runner(root, command, env);
    if (result.exitCode !== 0) throw new CheckpointError("GIT_COMMAND_FAILED", `Git command failed (${args[0] ?? "command"})`);
    return result;
  }

  private async indexPath(root: string): Promise<string> {
    const result = await this.run(root, ["rev-parse", "--git-path", "aib-checkpoint-index"]);
    const raw = result.stdout.trim();
    const candidate = normalize(raw.startsWith("/") ? raw : join(root, raw));
    if (!candidate || !inside(candidate, root)) throw new CheckpointError("PROJECT_OUTSIDE_HOME", "Git index path escaped project root");
    return candidate;
  }

  private async assertRestorePathsSafe(root: string, ref: string): Promise<void> {
    const listing = await this.run(root, ["ls-tree", "-r", "-z", "--name-only", ref]);
    const checks = new Map<string, boolean>();
    for (const file of listing.stdout.split("\0").filter(Boolean)) {
      const parts = file.split("/");
      for (let i = 0; i < parts.length; i++) checks.set(parts.slice(0, i + 1).join("/"), i < parts.length - 1);
    }
    const entries = [...checks.entries()];
    for (let offset = 0; offset < entries.length; offset += 400) {
      const batch = entries.slice(offset, offset + 400);
      const commands = batch.map(([relative, directory]) => {
        const target = quote(relative);
        const expected = directory ? `[ -d ${target} ]` : `[ -f ${target} ]`;
        return `if [ -L ${target} ]; then exit 42; elif [ -e ${target} ] && ! ${expected}; then exit 42; fi`;
      });
      const result = await this.runner(root, commands.join("; "));
      if (result.exitCode !== 0) throw new CheckpointError("GIT_COMMAND_FAILED", "Checkpoint restore conflicts with an existing file, directory, or symlink; workspace was not changed");
    }
  }

  /** Create a tree commit and point a private ref at it; normal HEAD and index are not touched. */
  async createCheckpoint(projectRoot: string, taskId: string): Promise<string> {
    if (!TASK_ID_RE.test(taskId)) throw new CheckpointError("INVALID_TASK_ID", "Invalid task id");
    const root = await this.checkedRoot(projectRoot);
    const index = await this.indexPath(root);
    const head = await this.runner(root, "git rev-parse --verify HEAD", { GIT_INDEX_FILE: index });
    if (head.exitCode === 0) await this.run(root, ["read-tree", "HEAD"], index);
    else await this.run(root, ["read-tree", "--empty"], index);
    await this.run(root, ["add", "-A", "--", "."], index);
    const tree = (await this.run(root, ["write-tree"], index)).stdout.trim();
    const commit = (await this.run(root, ["commit-tree", tree, "-m", `aib-checkpoint:${taskId}`, "--no-gpg-sign"], undefined, {
      GIT_AUTHOR_NAME: "AI Builder Checkpoint",
      GIT_AUTHOR_EMAIL: "checkpoint@ai-builder.invalid",
      GIT_COMMITTER_NAME: "AI Builder Checkpoint",
      GIT_COMMITTER_EMAIL: "checkpoint@ai-builder.invalid",
    })).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new CheckpointError("GIT_COMMAND_FAILED", "Git returned an invalid checkpoint id");
    await this.run(root, ["update-ref", `refs/aib/checkpoints/${taskId}`, commit]);
    return commit;
  }

  /** Restore the worktree from its private commit using the separate checkpoint index. */
  async restoreCheckpoint(projectRoot: string, taskId: string): Promise<void> {
    if (!TASK_ID_RE.test(taskId)) throw new CheckpointError("INVALID_TASK_ID", "Invalid task id");
    const root = await this.checkedRoot(projectRoot);
    const ref = `refs/aib/checkpoints/${taskId}`;
    const exists = await this.runner(root, `git rev-parse --verify ${quote(ref)}`);
    if (exists.exitCode !== 0) throw new CheckpointError("CHECKPOINT_NOT_FOUND", "Checkpoint was not found");
    const index = await this.indexPath(root);
    await this.assertRestorePathsSafe(root, ref);
    await this.run(root, ["read-tree", ref], index);
    // Never run `git clean` here: it also removes files created by the user after
    // the checkpoint. Restore checkpointed paths only; unrelated untracked files
    // are deliberately preserved, even when that means the worktree is not pristine.
    await this.run(root, ["checkout-index", "-a", "-f"], index);
  }

  /** List private checkpoint refs without traversing user refs. */
  async listCheckpoints(projectRoot: string): Promise<Array<Pick<CheckpointRecord, "taskId" | "sha" | "createdAt">>> {
    const root = await this.checkedRoot(projectRoot);
    const result = await this.runner(root, "git for-each-ref --format='%(refname:strip=3) %(objectname) %(creatordate:unix)' refs/aib/checkpoints");
    if (result.exitCode !== 0) throw new CheckpointError("GIT_COMMAND_FAILED", "Unable to list checkpoints");
    return result.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const [taskId, sha, time] = line.split(/\s+/);
      const createdAt = Number(time) * 1000;
      return taskId && TASK_ID_RE.test(taskId) && sha && Number.isFinite(createdAt) ? [{ taskId, sha, createdAt }] : [];
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Delete only this module's private ref. */
  async deleteCheckpoint(projectRoot: string, taskId: string): Promise<void> {
    if (!TASK_ID_RE.test(taskId)) throw new CheckpointError("INVALID_TASK_ID", "Invalid task id");
    const root = await this.checkedRoot(projectRoot);
    await this.run(root, ["update-ref", "-d", `refs/aib/checkpoints/${taskId}`]);
  }

  /** Keep the newest bounded number of AIB checkpoint refs. */
  async pruneOldCheckpoints(projectRoot: string, keepLastN = 20): Promise<number> {
    const keep = Math.max(0, Math.min(500, Math.floor(keepLastN)));
    const root = await this.checkedRoot(projectRoot);
    const checkpoints = await this.listCheckpoints(root);
    for (const checkpoint of checkpoints.slice(keep)) await this.deleteCheckpoint(root, checkpoint.taskId);
    return Math.max(0, checkpoints.length - keep);
  }
}
