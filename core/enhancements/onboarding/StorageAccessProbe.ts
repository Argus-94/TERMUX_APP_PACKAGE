const SHARED_STORAGE_ROOT = "/storage/emulated/0";
const AI_BUILDER_HOME_ROOT = "/storage/emulated/0/AIBuilderTermux";

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Build a read-only shell probe for the directories used by Termux-backed
 * project and artifact operations. `test -w` checks the executing Termux UID's
 * effective access without creating, deleting, or changing user files.
 */
export function buildStorageAccessProbeCommand(homeRoot: string): string {
  if (homeRoot !== AI_BUILDER_HOME_ROOT) throw new Error("STORAGE_HOME_ROOT_UNEXPECTED");
  return [SHARED_STORAGE_ROOT, homeRoot]
    .map((directory) => {
      const quoted = shellQuote(directory);
      return `test -d ${quoted} && test -r ${quoted} && test -w ${quoted} && test -x ${quoted}`;
    })
    .join(" && ");
}

export type StorageAccessProbeStatus = "ok" | "denied" | "unknown";

/** Exit 0 proves effective access; exit 1 means a path/access check failed. */
export function classifyStorageAccessProbeExitCode(exitCode: number): StorageAccessProbeStatus {
  if (exitCode === 0) return "ok";
  if (exitCode === 1) return "denied";
  return "unknown";
}
