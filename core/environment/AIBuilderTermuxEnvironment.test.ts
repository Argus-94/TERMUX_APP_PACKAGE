import { AIBuilderTermuxEnvironment } from './AIBuilderTermuxEnvironment';
test('AIBuilderTermuxEnvironment exposes canonical HOME', () => {
  const env = new AIBuilderTermuxEnvironment('/storage/emulated/0/AIBuilderTermux');
  expect(env.getHome()).toBe('/storage/emulated/0/AIBuilderTermux');
});
