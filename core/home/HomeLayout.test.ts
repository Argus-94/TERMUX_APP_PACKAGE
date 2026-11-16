import { createHomeLayout, HOME_PATH_KEYS } from './HomeLayout';

describe('HomeLayout', () => {
  it('keeps AIBuilderTermux as the canonical root', () => {
    const layout = createHomeLayout('/AIBuilderTermux');
    expect(layout.root).toBe('/storage/emulated/0/AIBuilderTermux');
    expect(layout.projects).toBe('/storage/emulated/0/AIBuilderTermux/projects');
    expect(layout.workspace).toBe('/storage/emulated/0/AIBuilderTermux/workspace');
    expect(layout.containersUbuntu).toBe('/storage/emulated/0/AIBuilderTermux/containers/ubuntu');
    expect(layout.containersKali).toBe('/storage/emulated/0/AIBuilderTermux/containers/kali');
  });

  it('normalizes a trailing separator without changing the root', () => {
    expect(createHomeLayout('/x/AIBuilderTermux/').root).toBe('/x/AIBuilderTermux');
  });

  it('rejects an empty home', () => {
    expect(() => createHomeLayout('')).toThrow('AI_BUILDER_HOME_REQUIRED');
  });

  it('declares every persistent layout key', () => {
    expect(HOME_PATH_KEYS).toHaveLength(12);
  });
});
