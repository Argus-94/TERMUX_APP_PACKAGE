import type { ExecutionEnvironment } from './ExecutionEnvironment';
test('ExecutionEnvironment exposes required runtime operations', () => {
  const names: (keyof ExecutionEnvironment)[] = ['exec','spawn','read','write','exists','mkdir','getHome'];
  expect(names).toEqual(['exec','spawn','read','write','exists','mkdir','getHome']);
});
