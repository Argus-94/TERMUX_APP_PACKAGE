export type BeforeFileMutation = (absolutePath: string, toolName: string) => Promise<void>;

const MUTATING_TOOLS = new Set([
  "fs.create",
  "fs.delete",
  "fs.replace",
  "fs.replaceRange",
  "ast.edit",
  "workspace.write",
]);

export function isAgentToolMutation(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/** Execute only after the host has durably checkpointed the affected target. */
export async function executeAfterMutationCheckpoint<T>(
  toolName: string,
  absolutePath: string,
  beforeFileMutation: BeforeFileMutation | undefined,
  mutate: () => Promise<T>,
): Promise<T> {
  if (!isAgentToolMutation(toolName)) return mutate();
  if (!beforeFileMutation) throw new Error("FILE_WRITE_CHECKPOINT_UNAVAILABLE");
  await beforeFileMutation(absolutePath, toolName);
  return mutate();
}
