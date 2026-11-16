#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { typescript as ts } from './test-helpers/load-typescript.mjs';
const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const rootPath = '/storage/emulated/0/AIBuilderTermux';
const cap = { rootPath, transport: 'procfd-nofollow', read: true, write: true, maxBytes: 2097152, nested: true };
const state = { access: true, caps: cap, read: { rootPath, relativePath: 'sub/a.txt', content: 'héllo', byteLength: 6 }, write: { rootPath, relativePath: 'sub/a.txt', byteLength: 3, written: true }, calls: [] };
const native = {
  getAIBuilderAllFilesAccessStatus: async () => ({ supported: true, granted: state.access, reason: null }),
  getAIBuilderWorkspaceFileCapabilities: async () => state.caps,
  readAIBuilderWorkspaceFile: async (p) => { state.calls.push(['read', p]); return state.read; },
  writeAIBuilderWorkspaceFile: async (p, c) => { state.calls.push(['write', p, c]); return state.write; },
};
function loadTs(file, stubs) {
  const module = { exports: {} };
  const js = ts.transpile(read(file), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {}, { filename: file })((id) => {
    if (Object.hasOwn(stubs, id)) return stubs[id]; throw new Error(`Unexpected dependency ${id}`);
  }, module, module.exports);
  return module.exports;
}
const bridge = loadTs('lib/termux-bridge.ts', {
  './embedded-runtime-diagnostics': loadTs('lib/embedded-runtime-diagnostics.ts', {}),
  'react-native': { NativeModules: { TermuxBridge: native }, NativeEventEmitter: class {}, Platform: { OS: 'android' }, Linking: {}, EmitterSubscription: class {} },
  'expo-file-system': { Directory: class { constructor() { this.exists = false; } delete() {} }, Paths: { cache: {} } },
  './persistent-logger': { persistentLogger: { add() {} } }, './termux-command-queue': { enqueueTermuxCommand() {}, clearPendingTermuxQueue() {} },
  './agent-shell-backend': { getBuildBackend() {}, backendLabel() {}, }, './command-log-redaction': {}, './diagnostic-trace': {},
  './termux-permission-gate': { RunCommandPermissionGate: class {}, isAndroidRunCommandPermissionDenied() {}, runCommandPermissionStatus() {} }, './embedded-exec-cancellation': {}, './termux-package-workflow-inputs': { buildTermuxPackageWorkflowInputs() {} },
  './private-workspace-policy': loadTs('lib/private-workspace-policy.ts', {}),
});
const checks = [];
assert.deepEqual({ ...await bridge.getAIBuilderWorkspaceFileCapabilities() }, cap); checks.push('capability success');
const result = await bridge.readAIBuilderWorkspaceFile('sub/a.txt');
assert.equal(result.byteLength, 6); assert.equal(result.content, 'héllo'); checks.push('UTF-8 read');
assert.deepEqual({ ...await bridge.writeAIBuilderWorkspaceFile('sub/a.txt', 'abc') }, state.write); checks.push('write success');
for (const bad of ['', '../x', 'a/../b', '/root/x', 'a\\b', 'a//b', 'a/./b', `a/${'x'.repeat(256)}`]) {
  await assert.rejects(() => bridge.readAIBuilderWorkspaceFile(bad), /AIB_WORKSPACE_RELATIVE_PATH_INVALID/);
  checks.push('path rejection');
}
state.access = false;
await assert.rejects(() => bridge.getAIBuilderWorkspaceFileCapabilities(), /AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED/); checks.push('permission gate');
state.access = true;
state.caps = { ...cap, rootPath: '/wrong' };
await assert.rejects(() => bridge.readAIBuilderWorkspaceFile('sub/a.txt'), /AIB_WORKSPACE_FILE_CAPABILITY_INVALID/); checks.push('malformed capability');
state.caps = cap;
for (const bad of [null, {}, { ...state.read, rootPath: '/wrong' }, { ...state.read, relativePath: 'other' }, { ...state.read, byteLength: 5 }, { ...state.read, byteLength: 2097153 }]) {
  state.read = bad;
  await assert.rejects(() => bridge.readAIBuilderWorkspaceFile('sub/a.txt'), /AIB_WORKSPACE_READ_RESULT_INVALID/);
  checks.push('malformed read response');
}
state.read = { rootPath, relativePath: 'sub/a.txt', content: 'ok', byteLength: 2 };
state.write = { rootPath, relativePath: 'sub/a.txt', byteLength: 9, written: true };
await assert.rejects(() => bridge.writeAIBuilderWorkspaceFile('sub/a.txt', 'abc'), /AIB_WORKSPACE_WRITE_RESULT_INVALID/); checks.push('malformed write response');
await assert.rejects(() => bridge.writeAIBuilderWorkspaceFile('a', 'x'.repeat(2097153)), /AIB_WORKSPACE_CONTENT_TOO_LARGE/); checks.push('write byte bound');
for (const invalidText of ['\uD800', '\uDC00', 'a\0b']) {
  const callCount = state.calls.length;
  await assert.rejects(() => bridge.writeAIBuilderWorkspaceFile('a', invalidText), /AIB_WORKSPACE_CONTENT_INVALID/);
  assert.equal(state.calls.length, callCount, 'invalid UTF-8/text is rejected before native mutation');
  checks.push('invalid text rejected before native');
}
state.read = { rootPath, relativePath: 'sub/a.txt', content: '\uD800', byteLength: 3 };
await assert.rejects(() => bridge.readAIBuilderWorkspaceFile('sub/a.txt'), /AIB_WORKSPACE_READ_RESULT_INVALID/); checks.push('invalid native UTF-8 rejected');
const policyFns = loadTs('lib/private-workspace-policy.ts', {});
for (const good of ['/storage/emulated/0/AIBuilderTermux', '/storage/emulated/0/AIBuilderTermux/nested/project', '/data/user/0/com.karat.aibuilder/files/home', '/data/data/com.karat.aibuilder/files/home/work']) {
  assert.equal(policyFns.isAllowedEmbeddedWorkdir(good), true, `allowed workdir ${good}`); checks.push('workdir allowed');
}
for (const bad of ['relative/path', '/sdcard/AIBuilderTermux', '/storage/emulated/0/AIBuilderTermuxX', '/storage/emulated/0/AIBuilderTermux/../other', '/storage/emulated/0/AIBuilderTermux/a/../b', '/data/user/0/com.karat.aibuilder/files/home/../../other', '/data/user/0/com.karat.aibuilder/files/homeX', '/storage/emulated/0//AIBuilderTermux']) {
  assert.equal(policyFns.isAllowedEmbeddedWorkdir(bad), false, `denied workdir ${bad}`); checks.push('workdir denied');
}
const policy = loadTs('lib/agent-private-tool-policy.ts', {});
assert.equal(policy.privateAgentToolUnsupportedReason('workspace.write', 'embedded-private'), null);
assert.equal(policy.privateAgentToolUnsupportedReason('workspace.write', 'selected-backend'), 'AGENT_SHELL_TARGET_INVALID'); checks.push('private allowlist');
const writeTool = loadTs('lib/agent-tools/workspace-write.ts', { '../private-workspace-policy': loadTs('lib/private-workspace-policy.ts', {}), '../termux-bridge': bridge });
assert.equal(writeTool.validate({ relativePath: 'a', content: 'x', extra: 1 }), 'AIB_WORKSPACE_WRITE_ARGS_UNSUPPORTED');
assert.equal(writeTool.validate({ relativePath: 'a', content: 'x'.repeat(2097153) }), 'AIB_WORKSPACE_CONTENT_TOO_LARGE'); checks.push('tool argument checks');
const registrySource = read('lib/agent-tools/index.ts');
assert.match(registrySource, /argCount=\$\{Object\.keys\(args \?\? \{\}\)\.length\}/);
assert.doesNotMatch((registrySource.match(/persistentLogger\.add\([\s\S]*?\);/g) || []).join('\n'), /args\.content|args\.relativePath|JSON\.stringify\(args/,
  'tool diagnostics never interpolate workspace content or file paths'); checks.push('diagnostic privacy');
console.log(`AIB_V487_WORKSPACE_FLOW_SELFTEST_OK checks=${checks.length} cases=${checks.join(',')}`);
