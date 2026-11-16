/**
 * Runtime-only project lifecycle orchestration.
 *
 * Coordinates project payload directories and project metadata. It does not
 * know about containers, toolchains, Gradle, Expo, or Android compilation.
 */
import type { HomeLayout } from './home/HomeLayout';
import { ProjectManager, validateProjectName, type ProjectManagerFileSystem, type ProjectInfo } from './project-manager';
import { ProjectMetadataStore, type ProjectMetadata, type ProjectMetadataFileSystem, projectMetadataPath } from './project-metadata';
import { ProjectStorage } from './project-storage';

export interface ProjectLifecycleFileSystem extends ProjectManagerFileSystem, ProjectMetadataFileSystem {
  removeDirectory(path: string): Promise<void> | void;
  moveDirectory(from: string, to: string): Promise<void> | void;
  removeFile(path: string): Promise<void> | void;
}

export interface ProjectLifecycleCreateOptions {
  readonly metadata?: Omit<ProjectMetadata, 'projectName'>;
}

function projectDirectory(layout: HomeLayout, name: string): string {
  return `${layout.projects.replace(/[\\/]+$/, '')}/${validateProjectName(name)}`;
}

const projectOperationTails = new Map<string, Promise<void>>();

async function withProjectLocks<T>(layout: HomeLayout, names: readonly string[], action: () => Promise<T>): Promise<T> {
  const root = layout.projects.replace(/[\\/]+$/, '');
  const keys = [...new Set(names.map((name) => `${root}/${validateProjectName(name)}`))].sort();
  const previous: Promise<void>[] = [];
  const releases: Array<() => void> = [];
  for (const key of keys) {
    previous.push(projectOperationTails.get(key) ?? Promise.resolve());
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    projectOperationTails.set(key, tail);
    releases.push(() => {
      release();
      if (projectOperationTails.get(key) === tail) projectOperationTails.delete(key);
    });
  }
  await Promise.all(previous);
  try {
    return await action();
  } finally {
    for (let i = releases.length - 1; i >= 0; i--) releases[i]();
  }
}

export class ProjectLifecycle {
  private readonly manager: ProjectManager;
  private readonly metadata: ProjectMetadataStore;
  private readonly storage: ProjectStorage;

  constructor(
    private readonly layout: HomeLayout,
    private readonly fs: ProjectLifecycleFileSystem,
  ) {
    this.manager = new ProjectManager(layout, fs);
    this.metadata = new ProjectMetadataStore(layout, fs);
    this.storage = new ProjectStorage(layout, fs);
  }

  async create(name: string, options: ProjectLifecycleCreateOptions = {}): Promise<ProjectInfo> {
    const normalized = validateProjectName(name);
    return withProjectLocks(this.layout, [normalized], async () => {
      if ((await this.manager.listProjects()).some((project) => project.name === normalized)) {
        throw new Error("PROJECT_ALREADY_EXISTS");
      }
      const info = await this.manager.createProject(normalized);
      const metadata: ProjectMetadata = {
        ...(options.metadata ?? {}),
        projectName: info.name,
      };
      try {
        await this.metadata.write(info.name, metadata);
      } catch (error) {
        const rollbackErrors: string[] = [];
        try { await this.fs.removeFile(projectMetadataPath(this.layout, info.name)); }
        catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
        try { await this.fs.removeDirectory(info.path); }
        catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
        if (rollbackErrors.length) {
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`PROJECT_CREATE_ROLLBACK_FAILED:${cause};${rollbackErrors.join(";")}`);
        }
        throw error;
      }
      return info;
    });
  }

  async open(name: string): Promise<ProjectInfo> {
    const normalized = validateProjectName(name);
    return withProjectLocks(this.layout, [normalized], async () => {
      const path = projectDirectory(this.layout, normalized);
      const exists = await this.fs.listDirectories(this.layout.projects);
      if (!exists.map((entry) => entry.trim()).includes(normalized)) {
        throw new Error('PROJECT_NOT_FOUND');
      }
      await this.metadata.read(normalized);
      return { name: normalized, path };
    });
  }

  async delete(name: string): Promise<void> {
    const normalized = validateProjectName(name);
    await withProjectLocks(this.layout, [normalized], async () => {
      const path = projectDirectory(this.layout, normalized);
      const metadata = await this.metadata.read(normalized);
      const metadataPath = projectMetadataPath(this.layout, normalized);
      const quarantine = `${this.layout.projects.replace(/[\\/]+$/, '')}/.aib-delete-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      await this.fs.moveDirectory(path, quarantine);
      try {
        await this.fs.removeFile(metadataPath);
      } catch (error) {
        const rollbackErrors: string[] = [];
        try { await this.fs.moveDirectory(quarantine, path); }
        catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
        try {
          if (!(await this.fs.fileExists(metadataPath))) await this.metadata.write(normalized, metadata);
        } catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
        if (rollbackErrors.length) {
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`PROJECT_DELETE_ROLLBACK_FAILED:${cause};${rollbackErrors.join(";")}`);
        }
        throw error;
      }
      try {
        await this.fs.removeDirectory(quarantine);
      } catch (error) {
        const quarantineName = quarantine.split(/[\\/]/).pop() || `project-${Date.now()}`;
        const recoveryDirectory = `${this.layout.metadata.replace(/[\\/]+$/, "")}/deletions`;
        const recoveryPath = `${recoveryDirectory}/${quarantineName}.json`;
        let markerError = "";
        try {
          await this.fs.ensureDirectory(recoveryDirectory);
          await this.fs.writeTextFile(recoveryPath, `${JSON.stringify({
            format: 1,
            projectName: normalized,
            originalPath: path,
            quarantinePath: quarantine,
            metadata,
            cleanupError: error instanceof Error ? error.message : String(error),
            recordedAt: Date.now(),
          }, null, 2)}\n`);
        } catch (recoveryError) {
          markerError = `;recovery_marker_error=${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
        }
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`PROJECT_DELETE_CLEANUP_FAILED:quarantine=${quarantine};recovery=${recoveryPath};cause=${cause}${markerError}`);
      }
    });
  }

  async rename(from: string, to: string): Promise<ProjectInfo> {
    const source = validateProjectName(from);
    const target = validateProjectName(to);
    if (source === target) return this.open(source);
    return withProjectLocks(this.layout, [source, target], async () => {
      const sourcePath = projectDirectory(this.layout, source);
      const targetPath = projectDirectory(this.layout, target);
      const entries = await this.fs.listDirectories(this.layout.projects);
      const names = entries.map((entry) => entry.trim());
      if (!names.includes(source)) throw new Error('PROJECT_NOT_FOUND');
      if (names.includes(target)) throw new Error('PROJECT_ALREADY_EXISTS');

      const currentMetadata = await this.metadata.read(source);
      await this.fs.moveDirectory(sourcePath, targetPath);
      try {
        await this.metadata.write(target, { ...currentMetadata, projectName: target });
        await this.fs.removeFile(projectMetadataPath(this.layout, source));
      } catch (error) {
        const rollbackErrors: string[] = [];
        const targetMetadataPath = projectMetadataPath(this.layout, target);
        const sourceMetadataPath = projectMetadataPath(this.layout, source);
        try {
          if (await this.fs.fileExists(targetMetadataPath)) await this.fs.removeFile(targetMetadataPath);
        } catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
        try { await this.fs.moveDirectory(targetPath, sourcePath); }
        catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
        try {
          if (!(await this.fs.fileExists(sourceMetadataPath))) await this.metadata.write(source, currentMetadata);
        } catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
        if (rollbackErrors.length) {
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`PROJECT_RENAME_ROLLBACK_FAILED:${cause};${rollbackErrors.join(";")}`);
        }
        throw error;
      }
      return { name: target, path: targetPath };
    });
  }

  /** Exposes storage only for lifecycle clients that need project payload access. */
  get projectStorage(): ProjectStorage { return this.storage; }
}
