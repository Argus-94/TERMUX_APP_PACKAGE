import { ProjectManager, validateProjectName } from './project-manager';
import { createHomeLayout } from './home/HomeLayout';

class FakeFs {
  readonly ensured: string[] = [];
  names: string[] = [];
  ensureDirectory(path: string) { this.ensured.push(path); }
  listDirectories() { return this.names; }
}

describe('ProjectManager', () => {
  it('roots projects in canonical HOME/projects', async () => {
    const fs = new FakeFs();
    const manager = new ProjectManager(createHomeLayout('/AIBuilderTermux'), fs);
    const project = await manager.createProject('demo');
    expect(project.path).toBe('/AIBuilderTermux/projects/demo');
    expect(fs.ensured).toEqual(['/AIBuilderTermux/projects/demo']);
  });

  it('does not couple project creation to containers', async () => {
    const fs = new FakeFs();
    const layout = createHomeLayout('/AIBuilderTermux');
    const manager = new ProjectManager(layout, fs);
    await manager.createProject('app');
    expect(fs.ensured.some((p) => p.includes('/containers/'))).toBe(false);
  });

  it('lists only valid project directory names', async () => {
    const fs = new FakeFs();
    fs.names = ['app', 'my-project', '..', '', 'bad/name', 'tools_1'];
    const manager = new ProjectManager(createHomeLayout('/AIBuilderTermux'), fs);
    await expect(manager.listProjects()).resolves.toEqual([
      { name: 'app', path: '/AIBuilderTermux/projects/app' },
      { name: 'my-project', path: '/AIBuilderTermux/projects/my-project' },
      { name: 'tools_1', path: '/AIBuilderTermux/projects/tools_1' },
    ]);
  });

  it('rejects traversal and unsafe project names', () => {
    expect(() => validateProjectName('../escape')).toThrow('INVALID_PROJECT_NAME');
    expect(() => validateProjectName('bad/name')).toThrow('INVALID_PROJECT_NAME');
    expect(() => validateProjectName('')).toThrow('INVALID_PROJECT_NAME');
    expect(validateProjectName(' app-1 ')).toBe('app-1');
  });
});
