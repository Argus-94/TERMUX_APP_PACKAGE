import { ProjectStorage, projectFilePath } from './project-storage';
import { createHomeLayout } from './home/HomeLayout';

class FakeFs {
  readonly ensured: string[] = [];
  readonly files = new Map<string, string>();
  ensureDirectory(path: string) { this.ensured.push(path); }
  writeTextFile(path: string, content: string) { this.files.set(path, content); }
  readTextFile(path: string) { return this.files.get(path) ?? ''; }
  fileExists(path: string) { return this.files.has(path); }
}

describe('ProjectStorage', () => {
  it('persists files inside canonical HOME/projects', async () => {
    const fs = new FakeFs();
    const storage = new ProjectStorage(createHomeLayout('/AIBuilderTermux'), fs);
    const path = await storage.writeFile('demo', 'state.json', '{"ok":true}');
    expect(path).toBe('/AIBuilderTermux/projects/demo/state.json');
    expect(fs.ensured).toEqual(['/AIBuilderTermux/projects/demo']);
  });

  it('reads a stored project file', async () => {
    const fs = new FakeFs();
    const storage = new ProjectStorage(createHomeLayout('/AIBuilderTermux'), fs);
    await storage.writeFile('demo', 'README.md', 'hello');
    await expect(storage.readFile('demo', 'README.md')).resolves.toEqual({
      projectName: 'demo',
      path: '/AIBuilderTermux/projects/demo/README.md',
      content: 'hello',
    });
  });

  it('rejects traversal in project or file names', async () => {
    const fs = new FakeFs();
    const storage = new ProjectStorage(createHomeLayout('/AIBuilderTermux'), fs);
    await expect(storage.writeFile('../escape', 'x.txt', 'bad')).rejects.toThrow('INVALID_PROJECT_NAME');
    expect(() => projectFilePath(createHomeLayout('/AIBuilderTermux'), 'demo', '../x')).toThrow('INVALID_PROJECT_FILE_NAME');
    expect(() => projectFilePath(createHomeLayout('/AIBuilderTermux'), 'demo', 'dir/x')).toThrow('INVALID_PROJECT_FILE_NAME');
  });

  it('does not reference containers or execution environments', async () => {
    const fs = new FakeFs();
    const storage = new ProjectStorage(createHomeLayout('/AIBuilderTermux'), fs);
    await storage.ensureProject('app');
    expect(fs.ensured.some((p) => p.includes('/containers/'))).toBe(false);
  });
});
