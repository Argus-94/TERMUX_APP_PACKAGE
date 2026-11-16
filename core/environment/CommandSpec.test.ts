import { commandToString } from './CommandSpec';
test('CommandSpec preserves structured command fields', () => {
  expect(commandToString({ command: 'echo', args: ['ok'] })).toBe('echo ok');
});
