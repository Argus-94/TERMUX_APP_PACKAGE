#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { typescript as ts } from './test-helpers/load-typescript.mjs';
const root = process.cwd(); const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
function load(file, stubs) { const m = { exports: {} }; const js = ts.transpile(read(file), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }); vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {}, { filename: file })((id) => { if (Object.hasOwn(stubs,id)) return stubs[id]; throw Error(`Unexpected dependency ${id}`); },m,m.exports); return m.exports; }
const policy = load('lib/private-workspace-policy.ts', {}); let readCalls=0; let response={rootPath:'/storage/emulated/0/AIBuilderTermux',relativePath:'dir/note.txt',content:'hello',byteLength:5};
const bridge = { readAIBuilderWorkspaceFile: async (relative) => { readCalls++; assert.equal(relative,'dir/note.txt'); return response; } };
const tool = load('lib/agent-tools/workspace-read.ts', { '../private-workspace-policy': policy, '../termux-bridge': bridge });
assert.equal(tool.validate({relativePath:'dir/note.txt'}),null);
for (const args of [{}, {name:'note.txt'}, {path:'/storage/emulated/0/AIBuilderTermux/note.txt'}, {relativePath:'../outside'}, {relativePath:'a/../b'}, {relativePath:'/absolute'}, {relativePath:'a//b'}, {relativePath:'a\\b'}, {relativePath:'a',extra:true}]) assert.notEqual(tool.validate(args),null,`rejected ${JSON.stringify(args)}`);
await assert.rejects(() => tool.execute({relativePath:'dir/note.txt'},null,{executionTarget:'selected-backend'}), /AIB_TOOL_WORKSPACE_READ_PRIVATE_TARGET_REQUIRED/);
await assert.rejects(() => tool.execute({relativePath:'dir/note.txt'}), /AIB_TOOL_WORKSPACE_READ_PRIVATE_TARGET_REQUIRED/);
assert.equal(readCalls,0,'non-private target never invokes native API');
assert.deepEqual({...await tool.execute({relativePath:'dir/note.txt'},null,{executionTarget:'embedded-private'})}, {...response}); assert.equal(readCalls,1);
const bridgeSource=read('lib/termux-bridge.ts');
assert.match(bridgeSource,/getAIBuilderWorkspaceFileCapabilities/); assert.match(bridgeSource,/AIB_WORKSPACE_FILE_CAPABILITY_INVALID/); assert.match(bridgeSource,/AIB_WORKSPACE_READ_RESULT_INVALID/); assert.match(bridgeSource,/utf8ByteLength\(r\.content\)/);
assert.match(bridgeSource,/AIB_WORKSPACE_FILE_API_UNAVAILABLE/); assert.doesNotMatch(bridgeSource,/workspace\.read[\s\S]{0,1200}runEmbeddedTermuxCommand/,'read has no shell fallback');
const native=read('plugins/withTermuxBridge.js');
assert.match(native,/fun getAIBuilderWorkspaceFileCapabilities\(promise: Promise\)/); assert.match(native,/fun readAIBuilderWorkspaceFile\(relativePath: String, promise: Promise\)/); assert.match(native,/O_NOFOLLOW/); assert.match(native,/proc\/self\/fd/);
assert.match(native,/if \(!hasAIBuilderAllFilesAccess\(\)\)[\s\S]*?AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED/);
const registry=read('lib/agent-tools/index.ts'); assert.match(registry,/"workspace\.read": \{ validate: workspaceRead\.validate, execute: workspaceRead\.execute \}/); assert.match(read('lib/agent-private-tool-policy.ts'),/"workspace\.list", "workspace\.read", "workspace\.write"/);
console.log('AIB_PRIVATE_WORKSPACE_READ_SELFTEST_OK native-procfd-read=1 typed-result-validation=1 nested-relative-path=1 traversal/absolute/extra-args=denied nonprivate-fallback=0');
