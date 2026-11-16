import { createHomeLayout } from './HomeLayout';
import { HOME_INITIALIZATION_PATHS, initializeHome, type HomeDirectoryAdapter } from './HomeInitializer';

test('initializes every canonical HOME directory in parent-first order', async () => {
  const layout = createHomeLayout('/AIBuilderTermux');
  const calls: string[] = [];
  const adapter: HomeDirectoryAdapter = {
    ensureDirectory(path) {
      calls.push(path);
    },
  };

  const result = await initializeHome(layout, adapter);

  expect(calls).toEqual(HOME_INITIALIZATION_PATHS(layout));
  expect(result.root).toBe(layout.root);
  expect(result.created).toEqual(calls);
});

test('does not add paths outside the canonical HOME tree', async () => {
  const layout = createHomeLayout('/AIBuilderTermux');
  const calls: string[] = [];

  await initializeHome(layout, {
    ensureDirectory(path) {
      calls.push(path);
    },
  });

  for (const path of calls) {
    expect(path === layout.root || path.startsWith(`${layout.root}/`)).toBe(true);
  }
});
