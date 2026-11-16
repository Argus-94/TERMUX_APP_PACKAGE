import { createHomeLayout } from './home/HomeLayout';
import { ProjectLifecycle } from './project-lifecycle';

function createMemoryFs() {
  const dirs = new Set<string>();
  const files = new Map<string, string>();
  return {
    dirs, files,
    ensureDirectory(path: string) { dirs.add(path); },
    listDirectories(path: string) {
      const prefix = `${path.replace(/[\\/]+$/, '')}/`;
      return [...dirs].filter((d) => d.startsWith(prefix) && !d.slice(prefix.length).includes('/')).map((d) => d.slice(prefix.length));
    },
    readTextFile(path: string) { const v = files.get(path); if (v === undefined) throw new Error('MISSING'); return v; },
    writeTextFile(path: string, content: string) { files.set(path, content); },
    fileExists(path: string) { return files.has(path); },
    removeDirectory(path: string) { for (const d of [...dirs]) if (d === path || d.startsWith(`${path}/`)) dirs.delete(d); },
    moveDirectory(from: string, to: string) {
      for (const d of [...dirs]) if (d === from || d.startsWith(`${from}/`)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
      for (const [p, v] of [...files]) if (p.startsWith(`${from}/`)) { files.delete(p); files.set(to + p.slice(from.length), v); }
    },
    removeFile(path: string) { files.delete(path); },
  };
}

const layout = createHomeLayout('/AIBuilderTermux');

export async function testProjectLifecycle() {
  const fs = createMemoryFs();
  const lifecycle = new ProjectLifecycle(layout, fs);

  const created = await lifecycle.create('demo', { metadata: { kind: 'app' } });
  if (created.name !== 'demo') throw new Error('CREATE_FAILED');
  await lifecycle.open('demo');
  const renamed = await lifecycle.rename('demo', 'demo2');
  if (renamed.name !== 'demo2') throw new Error('RENAME_FAILED');
  await lifecycle.open('demo2');
  await lifecycle.delete('demo2');
  if (fs.dirs.has(`${layout.projects}/demo2`)) throw new Error('DELETE_FAILED');
  if (fs.files.has(`${layout.metadata}/projects/demo2.json`)) throw new Error('METADATA_DELETE_FAILED');
}

export function testLifecycleNameGuards() {
  const fs = createMemoryFs();
  const lifecycle = new ProjectLifecycle(layout, fs);
  return Promise.all([
    lifecycle.create('../escape').then(() => { throw new Error('TRAVERSAL_ACCEPTED'); }, (e) => {
      if ((e as Error).message !== 'INVALID_PROJECT_NAME') throw e;
    }),
  ]);
}
