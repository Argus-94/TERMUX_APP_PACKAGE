import {
  DEFAULT_AI_BUILDER_HOME,
  createHomeEnvironment,
  resolveAiBuilderHome,
} from './HomeEnvironment';

describe('HomeEnvironment', () => {
  it('uses the canonical shared root for the app and does not synthesize a Termux HOME', () => {
    const env = createHomeEnvironment({ AI_BUILDER_HOME: DEFAULT_AI_BUILDER_HOME });
    expect(env.AI_BUILDER_HOME).toBe(DEFAULT_AI_BUILDER_HOME);
    expect(env.HOME).toBeUndefined();
    expect(env.layout.projects).toBe(`${DEFAULT_AI_BUILDER_HOME}/projects`);
  });

  it('keeps a caller-supplied real HOME separate from the app workspace', () => {
    const env = createHomeEnvironment({ HOME: '/data/data/com.karat.aibuilder/files/home' });
    expect(env.HOME).toBe('/data/data/com.karat.aibuilder/files/home');
    expect(env.AI_BUILDER_HOME).toBe(DEFAULT_AI_BUILDER_HOME);
  });

  it('rejects an app workspace outside the canonical shared root', () => {
    expect(() => createHomeEnvironment({ AI_BUILDER_HOME: '/data/aibuilder' }))
      .toThrow('AI_BUILDER_HOME_OUTSIDE_SHARED_ROOT');
  });

  it('does not promote a legacy app-looking Termux HOME into the new workspace', () => {
    expect(resolveAiBuilderHome({ HOME: '/storage/emulated/0/AIBuilderTermux' }))
      .toBe('/storage/emulated/0/AIBuilderTermux');
  });

  it('does not promote unrelated Termux HOME', () => {
    expect(resolveAiBuilderHome({ HOME: '/data/data/com.karat.aibuilder/files/home' }))
      .toBe(DEFAULT_AI_BUILDER_HOME);
  });

  it('does not mutate the supplied environment object', () => {
    const input = { HOME: '/data/data/com.karat.aibuilder/files/home' };
    createHomeEnvironment(input);
    expect(input).toEqual({ HOME: '/storage/emulated/0/AIBuilderTermux' });
  });
});
