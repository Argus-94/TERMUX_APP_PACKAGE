#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { typescript as ts } from './test-helpers/load-typescript.mjs';

const root = process.cwd();
const workspace = '/storage/emulated/0/AIBuilderTermux';
const events = [];
function load(file, resolve) {
  const module = { exports: {} };
  const js = ts.transpile(fs.readFileSync(path.join(root, file), 'utf8'), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {}, { filename: file })(resolve, module, module.exports);
  return module.exports;
}
const noImports = (id) => { throw new Error(`Unexpected import: ${id}`); };
const policy = load('lib/private-workspace-policy.ts', noImports);
const checkpoints = load('lib/agent-tools/mutation-checkpoint.ts', noImports);
const posix = load('lib/agent-tools/posix-path.ts', noImports);
const bridge = { writeAIBuilderWorkspaceFile: async (relativePath, content) => {
  events.push({ phase: 'native-write', path: `${workspace}/${relativePath}`, relativePath, content });
  return { written: true };
} };
const writer = load('lib/agent-tools/workspace-write.ts', (id) => {
  if (id === '../private-workspace-policy') return policy;
  if (id === '../termux-bridge') return bridge;
  return noImports(id);
});
const dispatcher = load('lib/agent-tools/index.ts', (id) => {
  if (id === './workspace-write') return writer;
  if (id === '../private-workspace-policy') return policy;
  if (id === './github-mutations') return { isGithubMutationTool: () => false, githubMutationTarget: () => '' };
  if (id === './mutation-checkpoint') return checkpoints;
  if (id === './posix-path') return posix;
  if (id === './types') return { AGENT_TOOL_NAMES: ['workspace.write'] };
  if (id === '../persistent-logger') return { persistentLogger: { add() {} } };
  if (id === '../agent-private-tool-policy') return { privateAgentToolUnsupportedReason: (name, target) => target === 'embedded-private' ? null : 'AGENT_SHELL_TARGET_INVALID' };
  // Other registered tools must never execute in these tests.
  return { validate: () => null, execute: async () => { throw new Error(`Unexpected tool: ${id}`); } };
});
const execute = (args, projectPath, beforeFileMutation) => dispatcher.executeAgentTool('workspace.write', args, projectPath, { executionTarget: 'embedded-private', beforeFileMutation });
const args = { relativePath: 'project/nested/a.txt', content: 'hello' };
assert.equal(checkpoints.isAgentToolMutation('workspace.write'), true);
await assert.rejects(() => execute(args, `${workspace}/project`), /FILE_WRITE_CHECKPOINT_UNAVAILABLE/);
assert.deepEqual(events, []);
await assert.rejects(() => execute(args, `${workspace}/project`, async (target) => { events.push({ phase: 'checkpoint-failed', path: target }); throw new Error('CHECKPOINT_FAILED'); }), /CHECKPOINT_FAILED/);
assert.equal(events.some((e) => e.phase === 'native-write'), false);
events.length = 0;
const checkpoint = async (target, tool) => { events.push({ phase: 'checkpoint', path: target, tool }); };
await assert.rejects(() => execute(args, '/storage/emulated/0/Other', checkpoint), /AIB_WORKSPACE_PROJECT_ROOT_NOT_ALLOWED/);
await assert.rejects(() => execute(args, `${workspace}/other-project`, checkpoint), /PATH_NOT_ALLOWED/);
await assert.rejects(() => execute({ relativePath: 'a.txt', content: 'wrong-scope' }, `${workspace}/project`, checkpoint), /PATH_NOT_ALLOWED/);
await assert.rejects(() => execute({ relativePath: 'project/../outside', content: 'x' }, `${workspace}/project`, checkpoint), /AIB_WORKSPACE_RELATIVE_PATH_INVALID/);
assert.deepEqual(events, [], 'scope and path errors must precede checkpoint and native mutation');
await execute(args, `${workspace}/project`, checkpoint);
assert.deepEqual(events.map((e) => e.phase), ['checkpoint', 'native-write']);
assert.equal(events[0].path, `${workspace}/${args.relativePath}`);
assert.equal(events[0].path, events[1].path, 'checkpoint and native write must address exactly the same file');
assert.equal(events[0].tool, 'workspace.write');
events.length = 0;
await execute({ relativePath: 'root.txt', content: '' }, undefined, checkpoint);
assert.equal(events[0].path, `${workspace}/root.txt`);
assert.equal(events[0].path, events[1].path);
console.log('AIB_V487_WORKSPACE_CHECKPOINT_SELFTEST_OK actual-dispatcher=1 actual-writer=1 missing=blocked failed=blocked wrong-project=blocked mismatch=blocked exact-target=verified order=verified');
