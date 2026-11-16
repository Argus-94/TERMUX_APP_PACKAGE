import fs from 'node:fs';
import vm from 'node:vm';
import Module from 'node:module';
import { spawnSync } from 'node:child_process';
import packageShellPolicy from '../plugins/privatePackageShellPolicy.js';

const pluginPath = new URL('../plugins/withTermuxBridge.js', import.meta.url).pathname;
const source = fs.readFileSync(pluginPath, 'utf8');
if (source.includes('private fun nativeLog(cmdId: String, level: String, message: String)')) {
  throw new Error('raw-message nativeLog signature remains');
}
if (!source.includes('runEmbeddedTermuxCommand(command, workdir, timeoutMs, requestId, promise)')) {
  throw new Error('legacy runCommand must route directly to the bundled private runtime');
}
if (source.includes('setClassName(TERMUX_PACKAGE') || source.includes('com.termux.permission.RUN_COMMAND') || source.includes('getPackageInfo(TERMUX_PACKAGE')) {
  throw new Error('external Termux execution, permission, or package discovery must be absent');
}

const temp = `${pluginPath}.selftest.cjs`;
fs.writeFileSync(temp, `${source}\nmodule.exports={moduleKotlin, embeddedTerminalViewKotlin, bootstrapInstallerKotlin, withTermuxBridgeMainApplication};\n`, 'utf8');
const originalLoad = Module._load;
const modCallbacks = {};
try {
  Module._load = function(request, parent, isMain) {
    if (request === '@expo/config-plugins') {
      return {
        withAndroidManifest(config) { return config; },
        withMainApplication(config, action) { modCallbacks.mainApplication = action; return config; },
        withDangerousMod(config) { return config; },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  const { moduleKotlin, embeddedTerminalViewKotlin, bootstrapInstallerKotlin, withTermuxBridgeMainApplication } = await import(`file://${temp}?t=${Date.now()}`);
  const generated = moduleKotlin('com.karat.aibuilder');
  const lines = generated.split('\n');
  const generatedEmbeddedView = embeddedTerminalViewKotlin('com.karat.aibuilder');
  const blockedPackageCommands = [
    'pkg install clang',
    'pkg -y upgrade',
    'apt-get update && apt-get install make',
    '/data/data/com.karat.aibuilder/files/usr/bin/apt remove make',
    'dpkg -i ./fixture.deb',
    'dpkg --configure -a',
    'apt-key add fixture.gpg',
    'termux-change-repo',
  ];
  for (const command of blockedPackageCommands) {
    if (!packageShellPolicy.isPrivatePackageMutationCommand(command)) {
      throw new Error(`direct generic-shell package mutation must be blocked: ${command}`);
    }
  }
  for (const command of ['pkg list-installed', 'apt show clang', 'apt-cache policy', 'dpkg-query -W']) {
    if (packageShellPolicy.isPrivatePackageMutationCommand(command)) {
      throw new Error(`read-only package query must remain available: ${command}`);
    }
  }
  for (const pattern of packageShellPolicy.PRIVATE_PACKAGE_MUTATION_PATTERNS) {
    if (!generated.includes(JSON.stringify(pattern))) {
      throw new Error('generated native shell gate must use the tested package mutation pattern set');
    }
  }
  const shellMethodStart = generated.indexOf('fun runEmbeddedTermuxCommand(command: String');
  const shellMethodEnd = generated.indexOf('fun runEmbeddedTermuxBuildCommand(command: String', shellMethodStart);
  const shellMethod = shellMethodStart < 0 || shellMethodEnd < 0 ? '' : generated.slice(shellMethodStart, shellMethodEnd);
  const packageGateAt = shellMethod.indexOf('if (isPrivatePackageMutationCommand(command))');
  const shellDispatchAt = shellMethod.indexOf('runEmbeddedTermuxCommandInternal(command, workdir, timeoutMs, requestId, promise, 120000L)');
  if (packageGateAt < 0 || shellDispatchAt < packageGateAt || !shellMethod.includes('AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED')) {
    throw new Error('generic native shell must reject package mutation before dispatching any command');
  }
  const generatedInstaller = bootstrapInstallerKotlin('com.karat.aibuilder', {
    archiveSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), bootstrapVersion: 'custom-unreleased',
  });
  if (generatedEmbeddedView.includes('${context.packageName}') || !generatedEmbeddedView.includes('context.packageName != "com.karat.aibuilder"')) {
    throw new Error('embedded TerminalView must enforce the exact AI Builder application ID without a JavaScript template interpolation');
  }
  if (!generatedEmbeddedView.includes('this.descendantFocusability = android.view.ViewGroup.FOCUS_AFTER_DESCENDANTS') || generatedEmbeddedView.includes('terminal.descendantFocusability')) {
    throw new Error('descendant focusability must be configured on the FrameLayout host, not the TerminalView');
  }
  for (const token of [
    'val canonicalFiles = try { context.filesDir.canonicalFile } catch (_: Throwable) { null }',
    'prefix.canonicalFile.path == prefix.absolutePath',
    'home.canonicalFile.path == home.absolutePath',
    'manifest?.optString("archiveSha256") == AibEmbeddedTermuxBootstrapInstaller.EXPECTED_ARCHIVE_SHA256',
    'manifest?.optString("architecture") == "aarch64"',
    'manifest?.optBoolean("secondStageCompleted", false) == true',
    'Regex("^[A-Za-z0-9._-]{1,96}$")',
  ]) {
    if (!generatedEmbeddedView.includes(token)) throw new Error(`generated TerminalView runtime/identity guard is missing ${token}`);
  }
  if (!generated.includes("runEmbeddedTermuxCommand(command, workdir, timeoutMs, requestId, promise)")) {
    throw new Error('generated legacy bridge must execute using the embedded runtime');
  }
  for (const token of [
    'EXPECTED_RELEASE_SIGNER_SHA256 = "661e5c868dbb38f8fe57d380e5c9b35e594e79bedb72d9ad2ad0113665c80418"',
    'LEGACY_RELEASE_SIGNER_SHA256 = "b5dacc6f9c37adceace5c0d715eecb2762b5a0417468e221ec9c534ea1e6328e"',
    'EXPECTED_RELEASE_SIGNATURE_BYTES = 256',
    'fun getReleaseIntegrityEvidence(promise: Promise)',
    'AIB_APP_SIGNATURE_MISMATCH',
    'AIB_RUNTIME_HOOK_DETECTED',
    'known_instrumentation_mapping',
    'debugger_attached',
    'releaseIntegrityFailureCode()',
    'line.lowercase(java.util.Locale.ROOT)',
  ]) {
    if (!generated.includes(token)) throw new Error(`generated native integrity guard is missing ${token}`);
  }
  if (generated.includes('line.toLowerCase(java.util.Locale.ROOT)')) {
    throw new Error('generated Kotlin must not use the deprecated String.toLowerCase(Locale) API');
  }
  const integrityGateAt = generated.indexOf('if (integrityFailure != null)');
  const workerStartAt = generated.indexOf('val worker = Thread({', integrityGateAt);
  if (integrityGateAt < 0 || workerStartAt < 0 || integrityGateAt > workerStartAt ||
      !generated.includes('promise.reject(integrityFailure, integrityFailure, null)')) {
    throw new Error('native integrity failure must reject before the command worker starts');
  }
  const procfsWhitespaceRegexToken = 'Regex("' + String.fromCharCode(92).repeat(2) + 's+")';
  if (generated.split(procfsWhitespaceRegexToken).length - 1 !== 3) {
    throw new Error('generated procfs parsing must preserve Kotlin-safe escaped whitespace regexes');
  }
  const kotlinLineFeed = String.fromCharCode(92) + 'n';
  if (!generated.includes(`process!!.outputStream.write('${kotlinLineFeed}'.code)`)) {
    throw new Error('generated stdin EOF must contain a valid Kotlin newline character literal');
  }
  if (!generated.includes('Compatibility capability probe: embedded execution is available without a foreign grant.') || !generated.includes('promise.resolve(true)')) {
    throw new Error('legacy permission probe must not block embedded JavaScript callers');
  }
  if (!generated.includes('packageName == "com.termux" || packageName.startsWith("com.termux.")') || !generated.includes('EXTERNAL_TERMUX_UNSUPPORTED')) {
    throw new Error('generic package version lookup must reject external Termux discovery');
  }
  if (!generated.includes('manifest.optString(\"installState\") == \"complete\"')) {
    throw new Error('legacy installed probe must report private runtime readiness, not a bare shell file');
  }
  if (!generated.includes('private fun nativeLogTag(): String = "AIB-TermuxBridge"') || !generated.includes('val text = fields.joinToString(" ")')) {
    throw new Error('generated structured Logcat logger is invalid');
  }
  if (!generated.includes('ProcessBuilder(AibEmbeddedTermuxBootstrapInstaller.shellCommand(prefix, "--noprofile", "--norc", "-c", wrapper, "aib-embedded", command, rootPidFile.absolutePath))') || !generated.includes('IFS= read -r _aib_start')) {
    throw new Error('command payload must execute through the bundled private shell after process tracking handshake');
  }
  for (const token of ['getEmbeddedTermuxRuntimeStatus', 'bin/login', 'bin/bash', 'bin/apt', 'bin/dpkg', 'etc/termux', 'etc/apt/sources.list', 'var/lib/dpkg/status', 'bootstrapManifestPresent', 'bootstrapManifestValid', 'prefixRelativePath', 'homeRelativePath', 'sourceCommit', 'bootstrapVersion', 'embedded_prefix_ready', 'bootstrap_missing_or_incomplete']) {
    if (!generated.includes(token)) throw new Error(`embedded runtime status probe is missing ${token}`);
  }
  if (!generated.includes('dpkgPresent && configPresent && aptSourcesPresent && dpkgDatabasePresent && prefixWritable')) {
    throw new Error('embedded runtime readiness must require package database, sources, home and writable prefix evidence');
  }
  if (!generated.includes('Android may still reject execution')) {
    throw new Error('filesystem readiness must not claim to prove that Android can execute the shell');
  }
  for (const token of [
    'fun queryEmbeddedTermuxPackages(name: String?, limit: Double, promise: Promise)',
    'val (prefix, home, _) = validatedEmbeddedRuntimeLayout()',
    'File(prefix, "bin/dpkg-query")',
    'File(dpkgDatabase, "status")',
    'AibEmbeddedTermuxBootstrapInstaller.shellCommand(',
    'rootPidFile.absolutePath, *argv.toTypedArray()',
    'env.clear()',
    'awaitAibEmbeddedRootPid(process!!, rootPidFile, 1_000L)',
    'waitForAibEmbeddedProcess(process!!, 5_000L, processRoot!!, trackedDescendants)',
    'stopAibEmbeddedPackageReaders',
    'captureAibEmbeddedPackageOutput',
  ]) {
    if (!generated.includes(token)) throw new Error(`generated private package-query template is missing ${token}`);
  }
  if (!generated.includes('(?:js|tr)-[A-Za-z0-9_-]{1,96}')) {
    throw new Error('native callback/lifecycle correlation must accept both JS and trace command ID formats');
  }
  if (generated.includes('command=') || generated.includes('message.replace(')) {
    throw new Error('generated Logcat template contains raw command/message logging');
  }
  for (const token of [
    'EXPECTED_ARCHIVE_SHA256 = "' + 'a'.repeat(64) + '"',
    'validatePackagedProvenance', 'ZipFile(archive)', 'normalizeArchivePath',
    'symlink_target_outside_private_prefix', 'Os.symlink(link.target',
    'Os.rename(stage.absolutePath, prefix.absolutePath)', 'runSecondStage',
    'second_stage_lock_missing', 'existing_prefix_unmanaged', 'StatFs', 'availableBytes', 'insufficient_private_storage', 'installState", "complete',
  ]) {
    if (!generatedInstaller.includes(token)) throw new Error(`bootstrap installer template is missing ${token}`);
  }
  for (const token of ['embeddedExecFailureDetail(error, phase)', 'EMBEDDED_EXEC_CWD_SCOPE_REJECTED', 'EMBEDDED_EXEC_CWD_ALL_FILES_ACCESS_REQUIRED', 'EMBEDDED_EXEC_CWD_WORKSPACE_ROOT_MISSING', 'EMBEDDED_EXEC_CWD_DIRECTORY_MISSING', 'EMBEDDED_EXEC_CWD_NOT_DIRECTORY', 'EMBEDDED_EXEC_CWD_ROOT_SYMLINK_REJECTED', 'EMBEDDED_EXEC_CWD_COMPONENT_SYMLINK_REJECTED']) {
    if (!generated.includes(token)) throw new Error(`generated CWD diagnostics are missing safe reason token ${token}`);
  }
  if (!generatedEmbeddedView.includes('AibEmbeddedTermuxBootstrapInstaller.installIfNeeded(context)') ||
      !generatedEmbeddedView.includes('AibEmbeddedTermuxBootstrapInstaller.executionEnvironment(context, prefix, home, tempDir)') ||
      !generatedInstaller.includes('"TERMUX__UID"') || !generatedInstaller.includes('"TERMUX__USER_ID"') ||
      !generatedInstaller.includes('"TERMUX_APP__PACKAGE_NAME"') || !generatedInstaller.includes('"TERMUX_APP_PACKAGE"') ||
      !generatedInstaller.includes('"TERMUX_ARCH" to EXPECTED_ARCH') || !generatedEmbeddedView.includes('Preparing the private Linux environment')) {
    throw new Error('embedded terminal must install the private bootstrap before creating a PTY');
  }
  let inString = false;
  let escaped = false;
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      }
    }
    if (inString && i + 1 < lines.length) {
      throw new Error(`unterminated Kotlin string at generated line ${i + 1}`);
    }
  }
  withTermuxBridgeMainApplication({});
  const appFixtures = [
    { name: 'kt-post-github-apply', language: 'kt', contents: 'override fun getPackages(): List<ReactPackage> =\n  PackageList(this).packages.toMutableList().apply {\n    add(GithubToolPackage())\n  }' },
    { name: 'kt-original-apply', language: 'kt', contents: 'override fun getPackages(): List<ReactPackage> = PackageList(this).packages.apply { }' },
    { name: 'kt-mutable-list', language: 'kt', contents: 'val packages = PackageList(this).packages.toMutableList()\nreturn packages' },
    { name: 'kt-immutable-list', language: 'kt', contents: 'val packages = PackageList(this).packages\nreturn packages' },
    { name: 'kt-direct-return', language: 'kt', contents: 'return PackageList(this).packages' },
    { name: 'kt-comment-only', language: 'kt', contents: '// add(TermuxBridgePackage())\nreturn PackageList(this).packages' },
    { name: 'java-assignment', language: 'java', contents: 'List<ReactPackage> packages = new PackageList(this).getPackages();\nreturn packages;' },
    { name: 'java-direct-return', language: 'java', contents: 'return new PackageList(this).getPackages();' },
  ];
  for (const fixture of appFixtures) {
    const modConfig = { modResults: { language: fixture.language, contents: fixture.contents } };
    modCallbacks.mainApplication(modConfig);
    const output = modConfig.modResults.contents;
    const uncommented = output.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/(\s)\/\/.*$/gm, '$1');
    if ((uncommented.match(/\badd\s*\(\s*(?:new\s+)?TermuxBridgePackage\s*\(\s*\)\s*\)/g) || []).length !== 1) {
      throw new Error(`${fixture.name} must register TermuxBridgePackage exactly once`);
    }
    if (fixture.name === 'kt-post-github-apply' && !output.includes('add(GithubToolPackage())')) {
      throw new Error('Termux registration must preserve a previously registered GithubToolPackage');
    }
    const repeated = { modResults: { language: fixture.language, contents: output } };
    modCallbacks.mainApplication(repeated);
    if (repeated.modResults.contents !== output) throw new Error(`${fixture.name} registration must be idempotent`);
  }
  const unsupported = { modResults: { language: 'kt', contents: 'class MainApplication {}' } };
  let failClosed = false;
  try { modCallbacks.mainApplication(unsupported); } catch (e) { failClosed = String(e?.message || e).includes('TermuxBridgePackage'); }
  if (!failClosed) throw new Error('unknown MainApplication shape must fail closed');
  console.log(`AIB_TERMUX_BRIDGE_KOTLIN_TEMPLATE_SELFTEST_OK generated_strings=valid bootstrap_installer=hash_pinned_atomic main_application_fixtures=${appFixtures.length} idempotent=1 fail_closed=1`);
} finally {
  Module._load = originalLoad;
  fs.rmSync(temp, { force: true });
}
