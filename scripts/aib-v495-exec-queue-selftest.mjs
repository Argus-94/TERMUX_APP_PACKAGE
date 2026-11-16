#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { typescript as ts } from './test-helpers/load-typescript.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = new Module(createRequire(import.meta.url).resolve('./aib-v495-exec-queue-selftest.mjs'));
const compile = (file, text) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }, fileName: file }).outputText;
const loadTs = file => { const m = new Module(file, parent); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file)); m._compile(compile(file, fs.readFileSync(file, 'utf8')), file); return m.exports; };
const queuePath = path.join(root, 'lib/termux-command-queue.ts');
const queue = loadTs(queuePath);
const logs = [];
let native = {};
const noop = () => {};
const rn = { NativeModules: {}, NativeEventEmitter: class { addListener() { return { remove: noop }; } }, Platform: { OS: 'android' }, Linking: {}, EmitterSubscription: class {} };
const mocks = {
  'react-native': rn,
  'expo-file-system': { Directory: class { constructor() { this.exists = false; } delete() {} }, Paths: { cache: {} } },
  './persistent-logger': { persistentLogger: { add: (...a) => logs.push(a), trace: noop } },
  './termux-command-queue': queue,
  './agent-shell-backend': { getBuildBackend: () => 'termux', backendLabel: () => 'Termux' },
  './command-log-redaction': { classifyCommandForDiagnostics: () => 'test', redactCommandForLogs: x => x, redactCommandOutputForLogs: (_c,x) => x, summarizeCommandOutputForLogs: (_c,x) => x },
  './diagnostic-trace': { classifyDiagnosticError: () => 'unknown', createTraceCorrelationId: () => 'trace', isExplicitTermuxExternalAppsFalse: () => false },
  './termux-permission-gate': { isAndroidRunCommandPermissionDenied: () => false, runCommandPermissionStatus: noop, RunCommandPermissionGate: class { async check() { return true; } } },
  './embedded-exec-cancellation': { runWithEmbeddedAbort: async (signal, run) => { if (signal?.aborted) throw signal.reason || Error('ABORTED'); return run(); } },
  './termux-package-workflow-inputs': { buildTermuxPackageWorkflowInputs: () => ({}) },
  './private-workspace-policy': { AI_BUILDER_WORKSPACE_ROOT: '/workspace', aiBuilderWorkspaceChildPath: noop, isCanonicalAIBuilderWorkspacePath: () => true, isSafeAIBuilderWorkspaceChildName: () => true, isSafeAIBuilderWorkspaceRelativePath: () => true, AI_BUILDER_WORKSPACE_MAX_BYTES: 1e6, isAllowedEmbeddedWorkdir: () => true },
};
const originalLoad = Module._load;
Module._load = function(request, p, isMain) {
  if (request === 'react-native') { Object.defineProperty(rn.NativeModules, 'TermuxBridge', { configurable: true, get: () => native }); return rn; }
  if (Object.hasOwn(mocks, request)) return mocks[request];
  if (request === './embedded-runtime-diagnostics') return loadTs(path.join(root, 'lib/embedded-runtime-diagnostics.ts'));
  return originalLoad.call(this, request, p, isMain);
};
let api;
try { api = loadTs(path.join(root, 'lib/termux-bridge.ts')); }
finally { Module._load = originalLoad; }

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
let inFlight = 0, maxInFlight = 0, calls = [];
const resultFor = id => ({ commandId:id, stdout:'ok', stderr:'', exitCode:0, timedOut:false, outputTruncated:false, durationMs:1, backendId:'embedded-termux' });
const gate = deferred();
native = { runEmbeddedTermuxCommand: async (...args) => { calls.push(args); inFlight++; maxInFlight=Math.max(maxInFlight,inFlight); try { await gate.promise; return resultFor(args[3]); } finally { inFlight--; } } };
// Direct API and shell dispatch share one slot; shell's internal Now path must not re-enter/deadlock the queue.
const first = api.runEmbeddedTermuxCommand('direct-first');
const direct2 = api.runEmbeddedTermuxCommand('direct-second');
const shell = api.runShellCommand('shell-third', { timeoutMs:5000 });
await tick(); assert.equal(calls.length, 1); assert.equal(maxInFlight, 1);
gate.resolve(); await Promise.all([first,direct2,shell]);
assert.equal(maxInFlight, 1); assert.equal(calls.length, 3); assert.equal(queue.isTermuxCommandQueueIdle(), true);

// Failure from the running native operation is propagated but always releases the queue slot.
calls=[]; const failGate=deferred();
native.runEmbeddedTermuxCommand = async (...args) => { calls.push(args); if (args[0]==='fail-now') { await failGate.promise; throw Object.assign(Error('/private raw detail'), { code:'EMBEDDED_EXEC_IO_FAILED' }); } return resultFor(args[3]); };
const failed=api.runEmbeddedTermuxCommand('fail-now'); const afterFailure=api.runEmbeddedTermuxCommand('after-failure'); await tick(); assert.equal(calls.length,1); failGate.resolve();
await assert.rejects(failed); await afterFailure; assert.equal(calls.length,2); assert.equal(queue.isTermuxCommandQueueIdle(),true);

// A request aborted before it reaches the native slot must never dispatch natively.
calls=[]; const hold=deferred(); native.runEmbeddedTermuxCommand=async (...args)=>{ calls.push(args); await hold.promise; return resultFor(args[3]); };
const active=api.runEmbeddedTermuxCommand('occupy'); await tick(); const controller=new AbortController();
const queued=api.runEmbeddedTermuxCommand('must-not-dispatch',{signal:controller.signal}); controller.abort(Error('ABORTED')); hold.resolve();
await active; await assert.rejects(queued); assert.equal(calls.length,1); assert.equal(calls[0][0],'occupy'); assert.equal(queue.isTermuxCommandQueueIdle(),true);

// Diagnostic origin is a safe enum-like label; raw native message and private paths stay out of logs.
logs.length=0; native.runEmbeddedTermuxCommand=async()=>{ throw Object.assign(Error('/private/device/path key=secret raw-native-message'),{code:'EMBEDDED_EXEC_CWD_REJECTED'}); };
await assert.rejects(api.runEmbeddedTermuxCommand('cwd-fails'));
const diag=logs.find(x=>x[1]==='EmbeddedExecDiagnostic'); assert.ok(diag); const json=JSON.stringify(diag);
const payload=JSON.parse(diag[2]); assert.equal(payload.requestOrigin,'direct-api'); assert.equal(payload.code,'EMBEDDED_EXEC_CWD_REJECTED');
for (const secret of ['/private/device/path','key=secret','raw-native-message']) assert.equal(json.includes(secret),false);
console.log('AIB_V495_EXEC_QUEUE_SELFTEST_OK actual transpiled bridge + queue; burst serialization, shell non-reentrant dispatch, failure release, queued abort, origin privacy');
