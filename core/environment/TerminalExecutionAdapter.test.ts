import { TerminalExecutionAdapter } from './TerminalExecutionAdapter';
test('terminal adapter delegates execution to injected environment', async () => {
  const calls: string[] = [];
  const env = {
    exec: async (command: string) => { calls.push(command); return { exitCode: 0, stdout: '', stderr: '' }; },
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }), read: async () => '', write: async () => {}, exists: async () => true,
    mkdir: async () => {}, getHome: () => '/home',
  };
  const terminal = new TerminalExecutionAdapter(env);
  await terminal.exec('echo ok');
  expect(calls).toEqual(['echo ok']);
  expect(terminal.getHome()).toBe('/home');
});
