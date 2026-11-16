import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

const read = (file) => fs.readFileSync(file, 'utf8');
const plugin = read('plugins/withTermuxBridge.js');
// Exercise the current Expo template even in the source-only release archive.
const templatePath = path.resolve('plugins/withTermuxBridge.js');
const generated = new Module(templatePath);
generated.filename = templatePath;
generated.paths = Module._nodeModulePaths(path.dirname(templatePath));
const originalLoad = Module._load;
try {
  Module._load = function(request, parent, isMain) {
    if (request === '@expo/config-plugins') return { withAndroidManifest: config => config, withMainApplication: config => config, withDangerousMod: config => config };
    return originalLoad.call(this, request, parent, isMain);
  };
  generated._compile(plugin + '\nmodule.exports = { moduleKotlin };\n', templatePath);
} finally { Module._load = originalLoad; }
const native = generated.exports.moduleKotlin('com.karat.aibuilder');
const bridge = read('lib/termux-bridge.ts');
const executor = read('lib/termux-executor.ts');
const privateProvider = read('lib/private-runtime-provider.ts');
const terminal = read('app/terminal.tsx');
const packageJson = JSON.parse(read('package.json'));
const gradle = fs.existsSync('android/app/build.gradle') ? read('android/app/build.gradle') : null;
const appConfig = read('app.config.ts');
const runtimeIdentity = read('core/runtime/RuntimeIdentity.ts');

function section(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `missing section ${startToken}`);
  return source.slice(start, end);
}

const nativeExec = section(native, 'fun runEmbeddedTermuxCommand(', 'fun isTermuxInstalled(');
const pluginExec = section(plugin, 'fun runEmbeddedTermuxCommand(', 'fun isTermuxInstalled(');
for (const [name, source] of [['native', nativeExec], ['plugin', pluginExec]]) {
  for (const token of [
    'validatedEmbeddedRuntimeLayout()', 'ProcessBuilder(', 'waitForAibEmbeddedProcess(',
    'cwd_scope_violation', 'cwd_all_files_access_required', 'cwd_workspace_root_missing', 'cwd_directory_missing', 'cwd_not_directory', 'cwd_root_symlink_rejected', 'cwd_symlink_rejected', 'private_tmp_scope_violation', 'environment()',
    'env.clear()', 'AibEmbeddedTermuxBootstrapInstaller.executionEnvironment(reactApplicationContext, prefix, home, tempDir)', 'reserveAibEmbeddedRequest(id)',
    'putBoolean("timedOut"', 'backendId', 'releaseAibEmbeddedRequest(id)',
  ]) assert.ok(source.includes(token), `${name} private executor is missing ${token}`);
  assert.doesNotMatch(source, /runCommand\s*\(|TERMUX_RUN_COMMAND_SERVICE|TERMUX_BASH/,
    `${name} private executor must not dispatch to external Termux`);
}
for (const token of ['private_layout_symlink_rejected', 'homeRelativePath', 'homeExpected.absolutePath', 'runtime_not_ready']) {
  assert.ok(native.includes(token), `current generated private layout must retain ${token}`);
}
assert.match(read('plugins/termuxBootstrapInstallerKotlin.js'), /LD_LIBRARY_PATH/);
assert.match(native, /fun cancelEmbeddedTermuxCommand\(/);
assert.match(native, /fun runEmbeddedTermuxBuildCommand\([\s\S]*?runEmbeddedTermuxCommandInternal\(command, workdir, timeoutMs, requestId, promise, 900000L\)/);
assert.match(native, /AIB_ASSEMBLE_TASK=assembleDebug/);
assert.match(native, /AIB_GRADLE_EXTRA_FLAGS=--offline/);
assert.match(native, /Only the fixed private offline assembleDebug command is permitted/);
assert.match(native, /requestAibEmbeddedCancellation\(id\)/);
assert.match(native, /stopAibEmbeddedProcess\(current, root, tracked\)/);
assert.match(native, /awaitAibEmbeddedRootPid\(process!!, rootPidFile, 1_000L\)/,
  'execution must receive and validate the shell PID before releasing the user command');
assert.match(native, /val rootPidFile = File\.createTempFile\("aib-embedded-pid-"/);
assert.doesNotMatch(native, /getMethod\("pid"\)|\.pid\(\)/,
  'API-24 execution must not depend on Process.pid() or hidden PID reflection');
assert.match(native, /private fun canonicalEmbeddedRuntimeRoots\(\)/);
assert.match(native, /private fun trackAibEmbeddedDescendants\(/);
assert.match(native, /private fun cleanupAibEmbeddedDescendants\(/);
assert.match(native, /embedded_output_reader_cleanup_failed/);
assert.match(native, /IFS= read -r _aib_start/);
assert.match(native, /eval .{0,4}\$1.{0,4}/,
  'the wrapper evaluates its command argument rather than interpolating command text into the wrapper');
assert.match(native, /process!!\.inputStream\.close\(\)/);
assert.match(native, /process!!\.errorStream\.close\(\)/);
assert.match(native, /stdoutThread\.join\(1500\)/);
assert.match(native, /context\.packageName != "com\.karat\.aibuilder"/);
assert.match(native, /File\(prefix, "bin\/bash"\)/);
assert.doesNotMatch(native, /File\(prefix, "bin\/timeout"\)/);
assert.match(native, /EXPECTED_ARCHIVE_SHA256/);
assert.match(native, /archiveSha256/);
assert.match(native, /cwdPath\.startsWith\(homePath \+ File\.separator\)/);
assert.match(native, /Semaphore\(2, true\)/);

assert.match(bridge, /runEmbeddedTermuxCommand\(/);
assert.match(bridge, /return enqueueTermuxCommand\(\(\) => runEmbeddedTermuxCommandNow\(command, options, options\.offlineBuild \? "offline-build" : "direct-api"\)\)/,
  'direct embedded callers must serialize through the same queue as foreground shell/Console runs');
assert.match(bridge, /runEmbeddedTermuxCommandNow\(command, options, options\.offlineBuild \? "offline-build" : "direct-api"\)/);
assert.match(bridge, /runEmbeddedTermuxBuildCommand\?\(/);
assert.match(bridge, /AIB_PRIVATE_OFFLINE_BUILD_V1=1/);
assert.match(bridge, /Math\.min\(timeoutCap, requestedTimeout\)/);
assert.match(bridge, /requestOrigin = "shell-queue"/);
assert.match(bridge, /requestOrigin, outcome: "native_rejected"/,
  'rejection logs must identify safe request origin without command or cwd data');
assert.match(bridge, /embeddedCwdRejectionDetails\(error\)/, 'cwd refusal diagnostics must use the fixed safe-reason classifier');
assert.doesNotMatch(bridge, /JSON\.stringify\(\{[^\n]*options\.workdir/, 'raw cwd must not be serialized');
assert.doesNotMatch(bridge, /JSON\.stringify\(\{[^\n]*command\s*:/, 'raw command must not be serialized');
for (const token of ['EMBEDDED_EXEC_CWD_SCOPE_REJECTED', 'EMBEDDED_EXEC_CWD_ALL_FILES_ACCESS_REQUIRED', 'EMBEDDED_EXEC_CWD_WORKSPACE_ROOT_MISSING', 'EMBEDDED_EXEC_CWD_DIRECTORY_MISSING', 'EMBEDDED_EXEC_CWD_NOT_DIRECTORY', 'EMBEDDED_EXEC_CWD_ROOT_SYMLINK_REJECTED', 'EMBEDDED_EXEC_CWD_COMPONENT_SYMLINK_REJECTED']) {
  assert.ok(plugin.includes(token), `native rejection detail is missing safe reason token ${token}`);
}
assert.match(bridge, /runEmbeddedTermuxCommandNow\(command, options, options\.offlineBuild \? "offline-build" : "direct-api"\)/);
assert.match(bridge, /runEmbeddedTermuxCommandNow\(command, \{ workdir: workdir \?\? undefined, timeoutMs \}, "shell-queue"\)/,
  'already-queued shell dispatch must not recursively enqueue and deadlock');
assert.match(bridge, /cancelEmbeddedTermuxCommand\?\(requestId: string\)/);
assert.match(bridge, /runWithEmbeddedAbort\(/);
assert.match(bridge, /EMBEDDED_CANCEL_UNAVAILABLE/);
assert.match(bridge, /EMBEDDED_EXEC_UNAVAILABLE/);
assert.match(bridge, /enqueueTermuxCommand\(\(\) => runWithEmbeddedAbort\(signal/,
  'fixed candidate native transactions must serialize through the global exclusive queue');
assert.match(bridge, /Missing capability is an error, never a Termux fallback/);
assert.match(executor, /options\.executionTarget === "embedded-private"/);
assert.match(executor, /runEmbeddedTermuxCommand\(commandNorm/);
assert.match(executor, /signal: options\.signal/);
assert.match(executor, /options\.offlineBuild && !\(options\.executionTarget === "embedded-private" && options\.trustedInternal === true && options\.isBuild === true\)/);
assert.match(executor, /offlineBuild: true/);
const privateBranch = section(executor, 'if (options.executionTarget === "embedded-private" || (!options.backend && options.hostTermux !== true))', '\n  } else {');
assert.doesNotMatch(privateBranch, /runShellCommand\s*\(|resolveAgentExecutionBackend\s*\(/,
  'private target must not use host/proot shell fallback');
assert.match(executor, /executionTarget\?: "embedded-private"/);

assert.match(terminal, /privateRuntimeProvider\.execute\(probe/);
assert.match(privateProvider, /executionTarget: "embedded-private"/);
assert.doesNotMatch(privateProvider, /options\.(?:backend|hostTermux|executionTarget)/,
  'private provider options cannot select host/proot/legacy execution');
assert.match(native, /cwdPath\.startsWith\(homePath \+ File\.separator\)/,
  'native bridge retains canonical private-HOME cwd containment');
assert.match(terminal, /\$PREFIX\/bin\/apt/);
assert.match(terminal, /\$PREFIX\/bin\/dpkg/);
assert.doesNotMatch(terminal, /apt\s+(?:install|update|upgrade)|pkg\s+(?:install|update|upgrade)/i,
  'the smoke probe must not change package state or access repositories');
assert.match(terminal, /AIB_PRIVATE_EXEC_OK/);

const expectedVersionCode = Number(appConfig.match(/versionCode:\s*(\d+)/)?.[1]);
assert.ok(Number.isInteger(expectedVersionCode), 'app.config.ts must declare a numeric Android versionCode');
assert.equal(packageJson.version, runtimeIdentity.match(/appVersion: "([^"]+)"/)?.[1], 'RuntimeIdentity must match package.json');
if (gradle) assert.ok(gradle.includes(`versionCode ${expectedVersionCode}`), 'generated Gradle config must match app.config.ts versionCode');
if (gradle) assert.ok(gradle.includes(`versionName "${packageJson.version}"`), 'generated Gradle config must match package.json version');
assert.ok(packageJson.scripts['test:embedded-termux-exec']?.includes('aib-embedded-termux-exec-selftest.mjs'));
console.log('AIB_EMBEDDED_TERMUX_EXEC_SELFTEST_OK fail-closed private runner, workspace boundary, app-specific manifest, bounded process, no external fallback');
