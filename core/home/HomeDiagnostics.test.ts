import { createHomeLayout } from './HomeLayout';
import { diagnoseHome } from './HomeDiagnostics';

function makeAdapter(existing: Set<string>) {
  return {
    isDirectory: (path: string) => existing.has(path),
    canRead: () => true,
    canWrite: () => true,
    canExecute: () => true,
    getFreeSpaceBytes: () => 123456,
  };
}

test('diagnoses ready HOME with status, path, permissions and free space', async () => {
  const layout = createHomeLayout('/AIBuilderTermux');
  const all = new Set([
    layout.root, layout.projects, layout.workspace, layout.containers,
    layout.containersUbuntu, layout.containersKali, layout.toolchains,
    layout.sdk, layout.cache, layout.logs, layout.backups, layout.metadata,
  ]);
  const result = await diagnoseHome(layout, makeAdapter(all));
  expect(result.status).toBe('ready');
  expect(result.path).toBe(layout.root);
  expect(result.exists).toBe(true);
  expect(result.missing).toEqual([]);
  expect(result.permissions).toEqual({ read: true, write: true, execute: true });
  expect(result.freeSpaceBytes).toBe(123456);
});

test('reports missing HOME paths without mutating storage', async () => {
  const layout = createHomeLayout('/tmp/AIBuilderTermux');
  const calls: string[] = [];
  const adapter = {
    isDirectory: (path: string) => { calls.push(`read:${path}`); return path === layout.root; },
  };
  const result = await diagnoseHome(layout, adapter);
  expect(result.status).toBe('incomplete');
  expect(result.exists).toBe(true);
  expect(result.missing.length).toBe(11);
  expect(result.permissions).toEqual({ read: null, write: null, execute: null });
  expect(result.freeSpaceBytes).toBeNull();
  expect(calls.length).toBe(12);
});
