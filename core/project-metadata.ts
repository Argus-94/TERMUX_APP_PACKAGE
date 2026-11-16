/**
 * Runtime-only persistent metadata for projects.
 *
 * Metadata is owned by the canonical AIBuilderTermux HOME/.ai-builder/metadata
 * tree and is independent from project payload files and execution containers.
 */
import type { HomeLayout } from './home/HomeLayout';
import { validateProjectName } from './project-manager';

export interface ProjectMetadataFileSystem {
  ensureDirectory(path: string): Promise<void> | void;
  readTextFile(path: string): Promise<string> | string;
  writeTextFile(path: string, content: string): Promise<void> | void;
  fileExists(path: string): Promise<boolean> | boolean;
}

export interface ProjectMetadata {
  readonly projectName: string;
  readonly [key: string]: unknown;
}

function metadataProjectDirectory(layout: HomeLayout): string {
  return `${layout.metadata.replace(/[\\/]+$/, '')}/projects`;
}

function metadataPath(layout: HomeLayout, projectName: string): string {
  const name = validateProjectName(projectName);
  return `${metadataProjectDirectory(layout)}/${name}.json`;
}

function encodeMetadata(metadata: ProjectMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function decodeMetadata(content: string, projectName: string): ProjectMetadata {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('INVALID_PROJECT_METADATA');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_PROJECT_METADATA');
  }
  const record = value as Record<string, unknown>;
  if (record.projectName !== projectName) {
    throw new Error('PROJECT_METADATA_NAME_MISMATCH');
  }
  return record as ProjectMetadata;
}

export class ProjectMetadataStore {
  constructor(
    private readonly layout: HomeLayout,
    private readonly fs: ProjectMetadataFileSystem,
  ) {}

  async ensureMetadataRoot(): Promise<void> {
    await this.fs.ensureDirectory(metadataProjectDirectory(this.layout));
  }

  async write(projectName: string, metadata: ProjectMetadata): Promise<string> {
    const name = validateProjectName(projectName);
    if (metadata.projectName !== name) throw new Error('PROJECT_METADATA_NAME_MISMATCH');
    await this.ensureMetadataRoot();
    const path = metadataPath(this.layout, name);
    await this.fs.writeTextFile(path, encodeMetadata(metadata));
    return path;
  }

  async read(projectName: string): Promise<ProjectMetadata> {
    const name = validateProjectName(projectName);
    const path = metadataPath(this.layout, name);
    if (!(await this.fs.fileExists(path))) throw new Error('PROJECT_METADATA_NOT_FOUND');
    return decodeMetadata(await this.fs.readTextFile(path), name);
  }
}

export { metadataPath as projectMetadataPath };
