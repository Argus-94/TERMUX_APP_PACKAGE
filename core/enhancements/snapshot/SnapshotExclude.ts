import { SECRET_ARCHIVE_TAR_EXCLUDES } from "../../../lib/secret-archive-policy";

export type SnapshotExcludeOptions = Readonly<{ excludeApk?: boolean }>;
export const DEFAULT_SNAPSHOT_EXCLUDES: readonly string[] = Object.freeze([
  "node_modules", ".next", "out", "dist", "build", ".gradle", ".venv", "venv", "__pycache__", ".cache", ".turbo", ".expo", "coverage", "target",
  ".git", ...SECRET_ARCHIVE_TAR_EXCLUDES,
]);
const SAFE_PATTERN = /^[A-Za-z0-9._*?@+/-]{1,180}$/;
export class SnapshotExcludeError extends Error {
  readonly code = "SNAPSHOT_EXCLUDE_PATTERN_INVALID" as const;
  constructor() { super("SNAPSHOT_EXCLUDE_PATTERN_INVALID"); this.name = "SnapshotExcludeError"; }
}

/** Parse the optional project .aib/snapshot-exclude file, rejecting paths and option injection. */
export function parseSnapshotExcludeFile(content: string): readonly string[] {
  const patterns = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const value = raw.trim();
    if (!value || value.startsWith("#")) continue;
    if (!SAFE_PATTERN.test(value) || value.startsWith("-") || value.startsWith("/") || value.split("/").includes("..") || value.includes("\\")) throw new SnapshotExcludeError();
    patterns.add(value);
  }
  return [...patterns];
}

/** Merge defaults with project-local patterns; optional build artifacts can be retained explicitly. */
export function getSnapshotExcludes(projectConfig = "", options: SnapshotExcludeOptions = {}): readonly string[] {
  const base = options.excludeApk === false ? DEFAULT_SNAPSHOT_EXCLUDES.filter((x) => x !== "*.apk" && x !== "*.aab") : DEFAULT_SNAPSHOT_EXCLUDES;
  return [...new Set([...base, ...parseSnapshotExcludeFile(projectConfig)])];
}
