/**
 * Runtime-only project registry rooted in the canonical AIBuilderTermux HOME.
 *
 * Projects are owned by HOME/projects and are deliberately independent from
 * execution environments/containers. This module does not touch build config.
 */
import type { HomeLayout } from './home/HomeLayout';

export interface ProjectManagerFileSystem {
  ensureDirectory(path: string): Promise<void> | void;
  listDirectories(path: string): Promise<readonly string[]> | readonly string[];
}

export interface ProjectInfo {
  readonly name: string;
  readonly path: string;
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateProjectName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized === '.' || normalized === '..' || !PROJECT_NAME.test(normalized)) {
    throw new Error('INVALID_PROJECT_NAME');
  }
  return normalized;
}

function projectPath(layout: HomeLayout, name: string): string {
  return `${layout.projects.replace(/[\\/]+$/, '')}/${name}`;
}

/** Creates/list projects without coupling them to a container or toolchain. */
export class ProjectManager {
  constructor(
    private readonly layout: HomeLayout,
    private readonly fs: ProjectManagerFileSystem,
  ) {}

  async ensureProjectsRoot(): Promise<void> {
    await this.fs.ensureDirectory(this.layout.projects);
  }

  async createProject(name: string): Promise<ProjectInfo> {
    const normalized = validateProjectName(name);
    const path = projectPath(this.layout, normalized);
    await this.fs.ensureDirectory(path);
    return { name: normalized, path };
  }

  async listProjects(): Promise<readonly ProjectInfo[]> {
    await this.ensureProjectsRoot();
    const names = await this.fs.listDirectories(this.layout.projects);
    return names
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .filter((name) => PROJECT_NAME.test(name))
      .map((name) => ({ name, path: projectPath(this.layout, name) }));
  }
}

export { validateProjectName };
