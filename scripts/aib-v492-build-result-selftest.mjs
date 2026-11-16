import assert from 'node:assert/strict';
import fs from 'node:fs';
import { executeProjectBuildRunner } from '../lib/project-build-runner.ts';

const source = fs.readFileSync(new URL('../lib/termux-agent.ts', import.meta.url), 'utf8');
const expressions = [...source.matchAll(/return (\{ \.\.\.result, stdout: result\.stdout \?\? "", stderr: result\.stderr \?\? "", timedOut: result\.timedOut \?\? result\.exitCode === 124 \});/g)].map(match => match[1]);
assert.equal(expressions.length, 2, 'both verified and unverified build-runner return routes must preserve timeout evidence');
assert.equal(expressions[0], expressions[1]);
// Evaluate the exact production return expression, not a separately reimplemented mapper.
const normalize = new Function('result', `return (${expressions[0]});`);
for (const [input, expected] of [
  [{exitCode: -1, timedOut: true}, true],
  [{exitCode: 124, timedOut: false}, false],
  [{exitCode: 124}, true],
  [{exitCode: 0}, false],
]) {
  const normalized = normalize(input);
  assert.equal(normalized.timedOut, expected);
  assert.equal(normalized.stdout, '');
  assert.equal(normalized.stderr, '');
}
const options = {projectRoot:'/storage/emulated/0/AIBuilderTermux/example',projectName:'example',projectKind:'test',backend:'termux',variant:'debug',command:'printf harmless',timeoutMs:1000};
const runnerPath = '/private/app/files/home/.aibuilder/work/build-runners/build-apk-fixture.sh';
for (const timedOut of [true, false]) {
  const result = await executeProjectBuildRunner(options, async () => ({exitCode: timedOut ? -1 : 0, stdout:`PROJECT_BUILD_SCRIPT=${runnerPath}\n`, timedOut}));
  assert.equal(result.projectBuildScriptPath, runnerPath);
  assert.equal(result.timedOut, timedOut);
  assert.equal(normalize(result).timedOut, timedOut);
}
assert.doesNotMatch(source, /buildRepairTargetInstruction\(repairTarget, build\.projectBuildScriptPath\)/, 'recovery must not read an out-of-scope build variable');
assert.match(source, /let msg = String\(parsed\.message \|\| ""\)/, 'final result can be annotated without assigning to const');
console.log('AIB_V492_BUILD_RESULT_SELFTEST_OK real-native-timeout-preserved=1 no-ReferenceError=1 mutable-final-result=1 mocked-build-only Android=NOT_RUN');
