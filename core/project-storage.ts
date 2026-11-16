/**
 * Runtime-only persistent storage boundary for projects.
 *
 * Project data lives under the canonical AIBuilderTermux HOME/projects tree.
 * This module deliberately does not know about containers, Gradle, Expo, or
 * Android compilation settings.
 */
import type { HomeLayout } from './home/HomeLayout';
import { validateProjectName } from './project-manager';

export interface ProjectStorageFileSystem {
  ensureDirectory(path: string): Promise<void> | void;
  readTextFile(path: string): Promise<string> | string;
  writeTextFile(path: string, content: string): Promise<void> | void;
  fileExists(path: string): Promise<boolean> | boolean;
}

export interface ProjectDocument {
  readonly projectName: string;
  readonly path: string;
  readonly content: string;
}

function projectDirectory(layout: HomeLayout, name: string): string {
  const normalized = validateProjectName(name);
  return `${layout.projects.replace(/[\\/]+$/, '')}/${normalized}`;
}

function filePath(layout: HomeLayout, projectName: string, fileName: string): string {
  const directory = projectDirectory(layout, projectName);
  const normalized = fileName.trim();
  if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('/') || normalized.includes('\\')) {
    throw new Error('INVALID_PROJECT_FILE_NAME');
  }
  return `${directory}/${normalized}`;
}

export class ProjectStorage {
  constructor(
    private readonly layout: HomeLayout,
    private readonly fs: ProjectStorageFileSystem,
  ) {}

  async ensureProject(name: string): Promise<string> {
    const directory = projectDirectory(this.layout, name);
    await this.fs.ensureDirectory(directory);
    return directory;
  }

  async writeFile(projectName: string, fileName: string, content: string): Promise<string> {
    const directory = await this.ensureProject(projectName);
    const path = filePath(this.layout, projectName, fileName);
    // Keep the explicit directory result as a guard against adapters that do
    // not implement recursive parent creation.
    if (!path.startsWith(`${directory}/`)) throw new Error('PROJECT_STORAGE_PATH_ERROR');
    await this.fs.writeTextFile(path, content);
    return path;
  }

  async readFile(projectName: string, fileName: string): Promise<ProjectDocument> {
    const path = filePath(this.layout, projectName, fileName);
    const exists = await this.fs.fileExists(path);
    if (!exists) throw new Error('PROJECT_FILE_NOT_FOUND');
    const content = await this.fs.readTextFile(path);
    return { projectName: validateProjectName(projectName), path, content };
  }
}

export { filePath as projectFilePath };
