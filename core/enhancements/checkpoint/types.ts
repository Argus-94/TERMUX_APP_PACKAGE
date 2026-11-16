/** Task checkpoint contracts; refs are private and do not alter the user's branch or index. */
export type CheckpointErrorCode = "INVALID_TASK_ID" | "PROJECT_OUTSIDE_HOME" | "NOT_GIT_REPOSITORY" | "GIT_COMMAND_FAILED" | "CHECKPOINT_NOT_FOUND" | "CHECKPOINT_STORE_FAILED" | "CAPABILITY_DENIED";
export class CheckpointError extends Error {
  constructor(readonly code: CheckpointErrorCode, message: string) { super(message); this.name = "CheckpointError"; }
}
export type GitCommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export type GitCommandRunner = (cwd: string, command: string, env?: Readonly<Record<string, string>>) => Promise<GitCommandResult>;
export type CheckpointRecord = Readonly<{ taskId: string; projectRoot: string; sha: string; createdAt: number; promptSummary?: string }>;
export type CheckpointMetadataStore = Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void> }>;
export type CheckpointSession = Readonly<{ id: string; projectId?: string; policy?: Readonly<{ allowedCapabilities: readonly string[] }> }>;
