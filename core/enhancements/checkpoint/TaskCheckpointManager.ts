import { CheckpointError, type CheckpointMetadataStore, type CheckpointRecord, type CheckpointSession } from "./types";
import { GitPrivateRef } from "./GitPrivateRef";

function scrubSummary(value: string): string {
  return value.slice(0, 240).replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

/** Coordinates private Git checkpoints and durable task metadata. */
export class TaskCheckpointManager {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly git: GitPrivateRef, private readonly store: CheckpointMetadataStore, private readonly now: () => number = Date.now) {}

  private async records(): Promise<CheckpointRecord[]> {
    const raw = await this.store.read();
    if (!raw) return [];
    try { const parsed: unknown = JSON.parse(raw); return Array.isArray(parsed) ? parsed as CheckpointRecord[] : []; }
    catch { throw new CheckpointError("CHECKPOINT_STORE_FAILED", "Checkpoint metadata is corrupted"); }
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Create a pre-task snapshot; summary is length bounded and credential-redacted. */
  async createBeforeTask(session: CheckpointSession, taskId: string, promptSummary = ""): Promise<CheckpointRecord> {
    if (!session.projectId) throw new CheckpointError("NOT_GIT_REPOSITORY", "Session has no project root id");
    const projectRoot = session.projectId;
    const sha = await this.git.createCheckpoint(projectRoot, taskId);
    const record: CheckpointRecord = { taskId, projectRoot, sha, createdAt: this.now(), promptSummary: scrubSummary(promptSummary) };
    try {
      await this.serialize(async () => { const all = (await this.records()).filter((r) => !(r.projectRoot === projectRoot && r.taskId === taskId)); all.push(record); await this.store.write(JSON.stringify(all.slice(-500))); });
    } catch {
      try { await this.git.deleteCheckpoint(projectRoot, taskId); } catch { /* private ref is safe to leave if metadata storage is unavailable */ }
      throw new CheckpointError("CHECKPOINT_STORE_FAILED", "Checkpoint metadata could not be saved");
    }
    return record;
  }

  /** Revert a task only when the session policy explicitly grants checkpoint.revert. */
  async revertTask(session: CheckpointSession, taskId: string): Promise<void> {
    if (!session.policy?.allowedCapabilities.includes("checkpoint.revert")) throw new CheckpointError("CAPABILITY_DENIED", "checkpoint.revert capability is required");
    const records = await this.records();
    const record = records.find((r) => r.projectRoot === session.projectId && r.taskId === taskId);
    if (!record) throw new CheckpointError("CHECKPOINT_NOT_FOUND", "Task checkpoint metadata was not found");
    await this.git.restoreCheckpoint(record.projectRoot, taskId);
  }

  /** Return durable records for one project, newest first. */
  async list(projectRoot: string): Promise<CheckpointRecord[]> {
    return (await this.records()).filter((record) => record.projectRoot === projectRoot).sort((a, b) => b.createdAt - a.createdAt);
  }
}
