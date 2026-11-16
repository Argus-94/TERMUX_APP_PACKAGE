#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { typescript as ts } from './test-helpers/load-typescript.mjs';

const moduleParent = new Module(createRequire(import.meta.url).resolve('./aib-v492-bootstrap-routing-selftest.mjs'));
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

const executeResult = { stdout: 'AIB_PRIVATE_EXEC_OK\n', stderr: '', exitCode: 0, timedOut: false, outputTruncated: false, durationMs: 8, backendId: 'embedded-termux' };
const validStatus = { ready: true, prefixPresent: true, homePresent: true, shellPresent: true, packageManagerPresent: true, dpkgPresent: true, termuxConfigPresent: true, aptSourcesPresent: true, dpkgDatabasePresent: true, prefixWritable: true, bootstrapManifestPresent: true, bootstrapManifestValid: true, bootstrapVersion: '1', bootstrapArchiveSha256: 'a'.repeat(64), applicationId: 'com.karat.aibuilder', architecture: 'aarch64', applicationDataDir: '/private/app', filesDir: '/private/app/files', termuxPrefix: '/private/app/files/usr', packageFeedUrl: 'https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main', packageFeedStatus: 'blocked_signing_key_unprovisioned', packageFeedEnabled: false, packageFeedKeyFingerprint: '', status: 'embedded_prefix_ready' };
let prepareCalls=0, executeCalls=0, resolveInstall;
native = { prepareEmbeddedTermuxRuntime: () => { prepareCalls++; return new Promise(r => {resolveInstall=r;}); }, runEmbeddedTermuxCommand: async (...args) => {executeCalls++; return {...executeResult,commandId:args[3]};} };
const first=api.runEmbeddedTermuxCommand('printf ok'); const second=api.runEmbeddedTermuxCommand('printf ok');
assert.equal(prepareCalls,1); assert.equal(executeCalls,0); resolveInstall(true);
await Promise.all([first,second]); assert.equal(executeCalls,2);
// Rejection clears single-flight state, preserves no raw native details, and does not execute.
native.prepareEmbeddedTermuxRuntime = async () => {prepareCalls++; throw Object.assign(new Error('private-path secret-value'),{code:'UNTRUSTED_CODE'});};
await assert.rejects(api.runEmbeddedTermuxCommand('printf ok'), /EMBEDDED_BOOTSTRAP_FAILED/); assert.equal(executeCalls,2);
assert.equal(JSON.stringify(logs).includes('secret-value'),false);
native.prepareEmbeddedTermuxRuntime = async () => {prepareCalls++; return true;};
await api.runEmbeddedTermuxCommand('printf retry'); assert.equal(executeCalls,3);
const before=prepareCalls;
await assert.rejects(api.runEmbeddedTermuxCommand(''),/COMMAND_INVALID/);
await assert.rejects(api.runEmbeddedTermuxCommand('ok',{timeoutMs:NaN}),/TIMEOUT_INVALID/);
const controller=new AbortController();controller.abort(new Error('caller aborted'));
await assert.rejects(api.runEmbeddedTermuxCommand('ok',{signal:controller.signal}),/CANCEL_UNAVAILABLE|caller aborted/);
assert.equal(prepareCalls,before,'rejected requests must not bootstrap');
// Passive status stays read-only; deep readiness repairs then performs exact marker probe.
let ready=false;
native.getEmbeddedTermuxRuntimeStatus=async()=>({...validStatus,ready});
native.prepareEmbeddedTermuxRuntime=async()=>{prepareCalls++;ready=true;return true;};
assert.equal((await api.getEmbeddedTermuxRuntimeStatus()).ready,false); assert.equal(prepareCalls,before);
const checked=await api.checkTermuxReadiness({deep:true,refreshPermission:true});
assert.equal(checked.ready,true);assert.equal(checked.probed,true);assert.ok(prepareCalls>before);
assert.match(plugin,/fun prepareEmbeddedTermuxRuntime\(promise: Promise\)/);
assert.match(plugin,/val requestedCwd = requestedWorkingDirectory \?: throw SecurityException\("cwd_scope_violation"\)/);
assert.match(plugin,/val workingDirectory = resolveAllowedDirectory\(home, requestedCwd\)/);
assert.match(plugin,/TerminalSession\(launch.first\(\), cwdPath, launch.toTypedArray\(\), env, 2000, client\)/);
assert.doesNotMatch(plugin,/TerminalSession\(launch.first\(\), home.absolutePath/);
const installer=fs.readFileSync(path.join(root,'plugins/termuxBootstrapInstallerKotlin.js'),'utf8');
assert.match(installer,/ProcessBuilder\(shellCommand\(prefix, script.absolutePath\)\)/);
assert.match(installer,/internal fun shellCommand\(prefix: File, vararg arguments: String\): List<String> \{\s*return executableCommand\(listOf\(File\(prefix, "bin\/bash"\)\.absolutePath\) \+ arguments\)/);
assert.match(installer,/internal fun executableCommand\(argv: List<String>\): List<String> \{\s*return if \(Build\.VERSION\.SDK_INT >= 29\) listOf\("\/system\/bin\/linker64"\) \+ argv else argv/);
assert.doesNotMatch(plugin,/ProcessBuilder\(shell.absolutePath/);
assert.match(installer,/Build.VERSION.SDK_INT >= 29/); assert.match(installer,/\/system\/bin\/linker64/);
assert.match(installer,/libtermux-exec-linker-ld-preload.so/);assert.match(installer,/"TERMUX__USER_ID" to \(Process.myUid\(\) \/ 100000\)/);
assert.match(installer,/quarantineDamagedManagedPrefix/);
assert.match(fs.readFileSync(path.join(root,'app/termux-settings.tsx'),'utf8'),/router.push\("\/terminal"\)/);
console.log('AIB_V492_BOOTSTRAP_ROUTING_SELFTEST_OK single-flight=1 init-before-exec=1 failed-no-exec=1 retry=1 invalid-no-init=1 passive-readonly=1 deep-init=1 private-PTY-navigation=1 Android=NOT_RUN');
