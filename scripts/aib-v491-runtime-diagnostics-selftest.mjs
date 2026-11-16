#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { typescript as ts } from './test-helpers/load-typescript.mjs';

const moduleParent = new Module(createRequire(import.meta.url).resolve('./aib-v491-runtime-diagnostics-selftest.mjs'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'lib/termux-bridge.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const plugin = fs.readFileSync(path.join(root, 'plugins/withTermuxBridge.js'), 'utf8');
const diagnostics = fs.readFileSync(path.join(root, 'lib/embedded-runtime-diagnostics.ts'), 'utf8');
const compile = (file, text) => ts.transpileModule(text, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
}, fileName: file }).outputText;
const logs = [];
let native = {};
const noop = () => {};
const reactNative = { NativeModules: {}, NativeEventEmitter: class { addListener() { return { remove: noop }; } }, Platform: { OS: 'android' }, Linking: {}, EmitterSubscription: class {} };
const logger = { add: (...args) => logs.push(args), trace: noop };
const mocks = {
  'react-native': reactNative,
  'expo-file-system': { Directory: class { constructor() { this.exists = false; } delete() {} }, Paths: { cache: {} } },
  './persistent-logger': { persistentLogger: logger },
  // This fixture tests bootstrap/diagnostics; real queue ordering has its own v495 dynamic test.
  './termux-command-queue': { enqueueTermuxCommand: run => run(), clearPendingTermuxQueue: noop },
  './agent-shell-backend': { getBuildBackend: () => 'termux', backendLabel: () => 'Termux' },
  './command-log-redaction': { classifyCommandForDiagnostics: () => 'test', redactCommandForLogs: x => x, redactCommandOutputForLogs: (_c, x) => x, summarizeCommandOutputForLogs: (_c, x) => x },
  './diagnostic-trace': { classifyDiagnosticError: () => 'unknown', createTraceCorrelationId: () => 'trace', isExplicitTermuxExternalAppsFalse: () => false },
  './termux-permission-gate': { isAndroidRunCommandPermissionDenied: () => false, runCommandPermissionStatus: noop, RunCommandPermissionGate: class { check() { return true; } } },
  './embedded-exec-cancellation': { runWithEmbeddedAbort: async (_signal, run) => run() },
  './termux-package-workflow-inputs': { buildTermuxPackageWorkflowInputs: () => ({}) },
  './private-workspace-policy': { AI_BUILDER_WORKSPACE_ROOT: '/workspace', aiBuilderWorkspaceChildPath: noop, isCanonicalAIBuilderWorkspacePath: () => true, isSafeAIBuilderWorkspaceChildName: () => true, isSafeAIBuilderWorkspaceRelativePath: () => true, AI_BUILDER_WORKSPACE_MAX_BYTES: 1e6, isAllowedEmbeddedWorkdir: () => true },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'react-native') { Object.defineProperty(reactNative.NativeModules, 'TermuxBridge', { configurable: true, get: () => native }); return reactNative; }
  if (Object.hasOwn(mocks, request)) return mocks[request];
  if (request === './embedded-runtime-diagnostics') { const m = new Module(path.join(root, 'lib/embedded-runtime-diagnostics.ts'), moduleParent); m.filename = path.join(root, 'lib/embedded-runtime-diagnostics.ts'); m.paths = moduleParent.paths; m._compile(compile(m.filename, diagnostics), m.filename); return m.exports; }
  return originalLoad.call(this, request, parent, isMain);
};
let api;
try {
  const m = new Module(sourcePath, moduleParent); m.filename = sourcePath; m.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  m._compile(compile(sourcePath, source), sourcePath); api = m.exports;
} finally { Module._load = originalLoad; }
const run = (command = 'echo harmless', opts = {}) => api.runEmbeddedTermuxCommand(command, opts);
const rejected = (code, message = '/private/device/path key=secret raw-native-message') => Object.assign(new Error(message), { code });
const entries = () => logs.filter(x => x[1] === 'EmbeddedExecDiagnostic' || x[1] === 'EmbeddedRuntimeDiagnostic');
const safeLog = (entry, forbidden) => {
  const serialized = JSON.stringify(entry);
  for (const secret of forbidden) assert.equal(serialized.includes(secret), false, `log leaked ${secret}`);
  return serialized;
};

// Real exported execute function: exact native method contract and successful result passthrough.
let calls = [];
const executeResult = { commandId: 'request-1', stdout: 'ok\n', stderr: '', exitCode: 0, timedOut: false, outputTruncated: false, durationMs: 8, backendId: 'embedded-termux' };
native = { runEmbeddedTermuxCommand: async (...args) => { calls.push(args); return { ...executeResult, commandId: args[3] }; } };
const ok = await run('echo harmless', { timeoutMs: 5000 });
assert.deepEqual(calls[0].slice(0, 3), ['echo harmless', null, 5000]);
assert.equal(calls[0].length, 4); assert.match(calls[0][3], /^private-/);
assert.deepEqual(ok, { ...executeResult, commandId: calls[0][3] });
for (const code of ['EMBEDDED_EXEC_RUNTIME_NOT_READY', 'EMBEDDED_EXEC_IO_FAILED']) {
  logs.length = 0; native = { runEmbeddedTermuxCommand: async () => { throw rejected(code); } };
  await assert.rejects(run());
  const log = entries().find(x => x[1] === 'EmbeddedExecDiagnostic'); assert.ok(log);
  assert.match(safeLog(log, ['/private/device/path', 'key=secret', 'raw-native-message']), new RegExp(code));
}
for (const [message, reasonCode, pathCategory] of [
  ['EMBEDDED_EXEC_CWD_SCOPE_REJECTED', 'EMBEDDED_EXEC_CWD_SCOPE_REJECTED', 'scope_or_resolution'],
  ['EMBEDDED_EXEC_CWD_ALL_FILES_ACCESS_REQUIRED', 'EMBEDDED_EXEC_CWD_ALL_FILES_ACCESS_REQUIRED', 'permission_required'],
  ['EMBEDDED_EXEC_CWD_WORKSPACE_ROOT_MISSING', 'EMBEDDED_EXEC_CWD_WORKSPACE_ROOT_MISSING', 'workspace_root_missing'],
  ['EMBEDDED_EXEC_CWD_DIRECTORY_MISSING', 'EMBEDDED_EXEC_CWD_DIRECTORY_MISSING', 'directory_missing'],
  ['EMBEDDED_EXEC_CWD_NOT_DIRECTORY', 'EMBEDDED_EXEC_CWD_NOT_DIRECTORY', 'not_directory'],
  ['EMBEDDED_EXEC_CWD_ROOT_SYMLINK_REJECTED', 'EMBEDDED_EXEC_CWD_ROOT_SYMLINK_REJECTED', 'allowlisted_root_symlink'],
  ['EMBEDDED_EXEC_CWD_COMPONENT_SYMLINK_REJECTED', 'EMBEDDED_EXEC_CWD_COMPONENT_SYMLINK_REJECTED', 'path_component_symlink'],
]) {
  logs.length = 0; native = { runEmbeddedTermuxCommand: async () => { throw rejected('EMBEDDED_EXEC_CWD_REJECTED', message); } };
  await assert.rejects(run('private command', { workdir: '/data/user/0/private-user/path' }));
  const entry = entries().find(x => x[1] === 'EmbeddedExecDiagnostic'); const payload = JSON.parse(entry[2]);
  assert.equal(payload.code, 'EMBEDDED_EXEC_CWD_REJECTED'); assert.equal(payload.reasonCode, reasonCode); assert.equal(payload.pathCategory, pathCategory);
  safeLog(entry, ['/data/user/0/private-user/path', 'private command', 'private-user']);
}
logs.length = 0; native = { runEmbeddedTermuxCommand: async () => { throw rejected('EMBEDDED_EXEC_CWD_REJECTED', 'https://provider.example/path?key=secret /home/user'); } };
await assert.rejects(run('secret command', { workdir: 'https://provider.example/path?key=secret' }));
const unknownCwd = entries().find(x => x[1] === 'EmbeddedExecDiagnostic'); const unknownCwdPayload = JSON.parse(unknownCwd[2]);
assert.equal(unknownCwdPayload.reasonCode, 'EMBEDDED_EXEC_CWD_REJECTED'); assert.equal(unknownCwdPayload.pathCategory, 'unclassified_resolution');
safeLog(unknownCwd, ['provider.example', 'key=secret', '/home/user', 'secret command']);
logs.length = 0; native = { runEmbeddedTermuxCommand: async () => { throw rejected('NOT_ALLOWLISTED_NATIVE_CODE'); } };
await assert.rejects(run());
assert.match(safeLog(entries().find(x => x[1] === 'EmbeddedExecDiagnostic'), ['/private/device/path', 'key=secret', 'raw-native-message']), /UNCLASSIFIED_NATIVE_REJECTION/);

const validStatus = { ready: true, prefixPresent: true, homePresent: true, shellPresent: true, packageManagerPresent: true, dpkgPresent: true, termuxConfigPresent: true, aptSourcesPresent: true, dpkgDatabasePresent: true, prefixWritable: true, bootstrapManifestPresent: true, bootstrapManifestValid: true, bootstrapVersion: '1', bootstrapArchiveSha256: 'a'.repeat(64), applicationId: 'com.karat.aibuilder', architecture: 'aarch64', applicationDataDir: '/data/app/private', filesDir: '/data/app/files', termuxPrefix: '/data/data/com.termux/files/usr', packageFeedUrl: 'https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main', packageFeedStatus: 'ok', packageFeedEnabled: true, packageFeedKeyFingerprint: '', status: 'embedded_prefix_ready' };
logs.length = 0; let executeCalls = 0;
native = { runEmbeddedTermuxCommand: async (...args) => { executeCalls++; return { ...executeResult, commandId: args[3] }; }, getEmbeddedTermuxRuntimeStatus: async () => { throw rejected('EMBEDDED_TERMUX_STATUS_FAILED'); } };
assert.equal(await api.getEmbeddedTermuxRuntimeStatus(), null);
assert.equal(executeCalls, 0); assert.match(safeLog(entries().find(x => x[1] === 'EmbeddedRuntimeDiagnostic'), ['/private/device/path', 'key=secret', 'raw-native-message']), /native_rejected.*EMBEDDED_TERMUX_STATUS_FAILED/);
logs.length = 0; native.getEmbeddedTermuxRuntimeStatus = async () => ({ ...validStatus, ready: 'secret-bad-value', applicationDataDir: '/secret/path' });
assert.equal(await api.getEmbeddedTermuxRuntimeStatus(), null); assert.equal(executeCalls, 0);
const invalidLog = entries().find(x => x[1] === 'EmbeddedRuntimeDiagnostic');
assert.match(safeLog(invalidLog, ['/secret/path', 'secret-bad-value']), /invalid_result/);
logs.length = 0; native.getEmbeddedTermuxRuntimeStatus = async () => ({ ...validStatus, ready: false });
const notReady = await api.getEmbeddedTermuxRuntimeStatus();
assert.equal(notReady.ready, false); assert.equal(notReady.status, 'bootstrap_missing_or_incomplete'); assert.equal(executeCalls, 0);
assert.match(safeLog(entries().find(x => x[1] === 'EmbeddedRuntimeDiagnostic'), ['/data/app/private', '/data/app/files', '/data/data/com.termux/files/usr']), /not_ready/);
logs.length = 0; native.getEmbeddedTermuxRuntimeStatus = async () => validStatus;
assert.deepEqual(await api.getEmbeddedTermuxRuntimeStatus(), validStatus); assert.equal(executeCalls, 0);
assert.match(safeLog(entries().find(x => x[1] === 'EmbeddedRuntimeDiagnostic'), ['/data/app/private', '/data/app/files', '/data/data/com.termux/files/usr']), /ready/);

// Static guard against native error/detail leakage; actual Kotlin execution belongs to host JVM validation.
assert.match(plugin, /promise\.reject\(code,\s*embeddedExecFailureDetail\(error, phase\)\)/);
assert.match(plugin, /EMBEDDED_EXEC_(?:RUNTIME_NOT_READY|IDENTITY_REJECTED|LAYOUT_REJECTED|CWD_REJECTED|TMP_FAILED|START_FAILED|IO_FAILED|WAIT_FAILED|FAILED|BUSY|ID_IN_USE|REQUEST_ID_INVALID|COMMAND_INVALID|TIMEOUT_INVALID)|UNCLASSIFIED_NATIVE_REJECTION/);
for (const token of ['EMBEDDED_EXEC_CWD_SCOPE_REJECTED', 'EMBEDDED_EXEC_CWD_ALL_FILES_ACCESS_REQUIRED', 'EMBEDDED_EXEC_CWD_WORKSPACE_ROOT_MISSING', 'EMBEDDED_EXEC_CWD_DIRECTORY_MISSING', 'EMBEDDED_EXEC_CWD_NOT_DIRECTORY', 'EMBEDDED_EXEC_CWD_ROOT_SYMLINK_REJECTED', 'EMBEDDED_EXEC_CWD_COMPONENT_SYMLINK_REJECTED']) assert.ok(plugin.includes(token));
const nativeExecBlock = plugin.slice(plugin.indexOf('runEmbeddedTermuxCommand'), plugin.indexOf('queryEmbeddedTermuxPackages'));
assert.doesNotMatch(nativeExecBlock, /promise\.reject\([^\n]*e\.message|promise\.reject\([^\n]*e\.toString\(\)/);
assert.match(diagnostics, /const allowed = new Set<string>\(EMBEDDED_EXEC_FAILURE_CODES\)/);
assert.match(source, /options\.workdir \?\? null/);
assert.match(source, /const timeoutCap = options\.offlineBuild \? 900_000 : 120_000/);
assert.match(source, /Math\.max\(1_000, Math\.min\(timeoutCap, requestedTimeout\)\)/);
console.log('AIB_V491_RUNTIME_DIAGNOSTICS_SELFTEST_OK mock exports, native contract, safe diagnostics, status validation, template safeguards (no device/JVM)');
