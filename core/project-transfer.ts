/**
 * Runtime-only project import/export boundary.
 * Archive/compression format is intentionally supplied by an adapter.
 */

export type ProjectTransferFile = {
  relativePath: string;
  data: Uint8Array;
};

export type ProjectTransferManifest = {
  projectName: string;
  files: string[];
};

export interface ProjectExportSource {
  listFiles(projectName: string): Promise<string[]>;
  readFile(projectName: string, relativePath: string): Promise<Uint8Array>;
}

export interface ProjectImportSink {
  createProject(projectName: string): Promise<void>;
  writeFile(projectName: string, relativePath: string, data: Uint8Array): Promise<void>;
}

export interface ProjectTransferAdapter {
  exportProject(
    manifest: ProjectTransferManifest,
    source: ProjectExportSource,
  ): Promise<void>;
  importProject(
    manifest: ProjectTransferManifest,
    files: AsyncIterable<ProjectTransferFile>,
    sink: ProjectImportSink,
  ): Promise<void>;
}

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertTransferProjectName(projectName: string): string {
  if (!PROJECT_NAME_RE.test(projectName)) {
    throw new Error(`Invalid project name: ${projectName}`);
  }
  return projectName;
}

export function normalizeTransferPath(relativePath: string): string {
  if (!relativePath || relativePath.includes("\0")) {
    throw new Error("Invalid project transfer path");
  }

  const normalized = relativePath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(`Project transfer path escapes project root: ${relativePath}`);
  }

  return normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
}

/** AI Builder HOME metadata is not part of a portable project payload. */
export function isPortableProjectPath(relativePath: string): boolean {
  const normalized = normalizeTransferPath(relativePath);
  return normalized !== ".ai-builder" && !normalized.startsWith(".ai-builder/");
}

export function createProjectTransferManifest(
  projectName: string,
  files: string[],
): ProjectTransferManifest {
  assertTransferProjectName(projectName);

  const normalized = files
    .map(normalizeTransferPath)
    .filter(isPortableProjectPath);

  return {
    projectName,
    files: Array.from(new Set(normalized)).sort(),
  };
}
