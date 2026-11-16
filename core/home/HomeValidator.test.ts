import { createHomeLayout } from './HomeLayout';
import { HOME_INITIALIZATION_PATHS } from './HomeInitializer';
import { validateHome, type HomeDirectoryValidatorAdapter } from './HomeValidator';

test('validates every canonical HOME directory', async () => {
  const layout = createHomeLayout('/AIBuilderTermux');
  const checked: string[] = [];
  const adapter: HomeDirectoryValidatorAdapter = {
    isDirectory(path) {
      checked.push(path);
      return true;
    },
  };

  const result = await validateHome(layout, adapter);

  expect(result.valid).toBe(true);
  expect(result.root).toBe(layout.root);
  expect(result.missing).toEqual([]);
  expect(result.checked).toEqual(HOME_INITIALIZATION_PATHS(layout));
  expect(checked).toEqual(result.checked);
});

test('reports missing directories without mutating storage', async () => {
  const layout = createHomeLayout('/AIBuilderTermux');
  const existing = new Set([layout.root, layout.projects, layout.workspace]);
  const calls: string[] = [];
  const adapter: HomeDirectoryValidatorAdapter = {
    isDirectory(path) {
      calls.push(path);
      return existing.has(path);
    },
  };

  const result = await validateHome(layout, adapter);
  const expectedMissing = HOME_INITIALIZATION_PATHS(layout).filter(
    (path) => !existing.has(path),
  );

  expect(result.valid).toBe(false);
  expect(result.missing).toEqual(expectedMissing);
  expect(calls).toEqual(result.checked);
});

test('does not validate paths outside the canonical HOME tree', async () => {
  const layout = createHomeLayout('/AIBuilderTermux');
  const calls: string[] = [];

  await validateHome(layout, {
    isDirectory(path) {
      calls.push(path);
      return true;
    },
  });

  for (const path of calls) {
    expect(path === layout.root || path.startsWith(`${layout.root}/`)).toBe(true);
  }
});
