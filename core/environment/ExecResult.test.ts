import { createExecResult } from './ExecResult';
test('ExecResult has standardized process result fields', () => {
  expect(createExecResult({ exitCode: 0, stdout: 'ok', stderr: '', duration: 5 })).toEqual({ exitCode: 0, stdout: 'ok', stderr: '', duration: 5 });
});
