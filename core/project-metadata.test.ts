import { ProjectMetadataStore, projectMetadataPath } from './project-metadata';
import { createHomeLayout } from './home/HomeLayout';

class FakeFs {
  readonly ensured: string[] = [];
  readonly files = new Map<string, string>();
  ensureDirectory(path: string) { this.ensured.push(path); }
  writeTextFile(path: string, content: string) { this.files.set(path, content); }
  readTextFile(path: string) { return this.files.get(path) ?? ''; }
  fileExists(path: string) { return this.files.has(path); }
}

describe('ProjectMetadataStore', () => {
  it('stores metadata under canonical HOME/.ai-builder/metadata', async () => {
    const fs = new FakeFs();
    const store = new ProjectMetadataStore(createHomeLayout('/AIBuilderTermux'), fs);
    const path = await store.write('demo', { projectName: 'demo', kind: 'app' });
    expect(path).toBe('/AIBuilderTermux/.ai-builder/metadata/projects/demo.json');
    expect(fs.ensured).toEqual(['/AIBuilderTermux/.ai-builder/metadata/projects']);
  });

  it('round-trips project metadata', async () => {
    const fs = new FakeFs();
    const store = new ProjectMetadataStore(createHomeLayout('/AIBuilderTermux'), fs);
    const metadata = { projectName: 'demo', kind: 'app', tags: ['android'] };
    await store.write('demo', metadata);
    await expect(store.read('demo')).resolves.toEqual(metadata);
  });

  it('rejects metadata belonging to another project', async () => {
    const fs = new FakeFs();
    const store = new ProjectMetadataStore(createHomeLayout('/AIBuilderTermux'), fs);
    await expect(store.write('demo', { projectName: 'other' })).rejects.toThrow('PROJECT_METADATA_NAME_MISMATCH');
  });

  it('rejects traversal and invalid metadata', async () => {
    const fs = new FakeFs();
    const store = new ProjectMetadataStore(createHomeLayout('/AIBuilderTermux'), fs);
    expect(() => projectMetadataPath(createHomeLayout('/AIBuilderTermux'), '../escape')).toThrow('INVALID_PROJECT_NAME');
    fs.files.set('/AIBuilderTermux/.ai-builder/metadata/projects/demo.json', '{bad');
    await expect(store.read('demo')).rejects.toThrow('INVALID_PROJECT_METADATA');
  });

  it('does not create or depend on execution containers', async () => {
    const fs = new FakeFs();
    const store = new ProjectMetadataStore(createHomeLayout('/AIBuilderTermux'), fs);
    await store.write('app', { projectName: 'app' });
    expect(fs.ensured.some((p) => p.includes('/containers/'))).toBe(false);
  });
});
