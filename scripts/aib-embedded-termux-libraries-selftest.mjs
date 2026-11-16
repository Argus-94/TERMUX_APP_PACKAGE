import fs from 'node:fs';
import Module from 'node:module';
import assert from 'node:assert/strict';

const pluginPath = new URL('../plugins/withEmbeddedTermuxLibraries.js', import.meta.url).pathname;
const originalLoad = Module._load;
const callbacks = {};
try {
  Module._load = function(request, parent, isMain) {
    if (request === '@expo/config-plugins') return {
      withProjectBuildGradle(config, action) { callbacks.project = action; return config; },
      withAppBuildGradle(config, action) { callbacks.app = action; return config; },
    };
    return originalLoad.apply(this, arguments);
  };
  const plugin = await import(`file://${pluginPath}?t=${Date.now()}`);
  const fn = plugin.default || plugin;
  const config = {};
  fn(config);
  assert.equal(plugin.TERMUX_VERSION || fn.TERMUX_VERSION, '0.118.0');
  const project = { modResults: { language: 'groovy', contents: 'allprojects {\n    repositories {\n        google()\n        mavenCentral()\n    }\n}' } };
  callbacks.project(project);
  assert.match(project.modResults.contents, /https:\/\/jitpack\.io/);
  callbacks.project(project);
  assert.equal((project.modResults.contents.match(/https:\/\/jitpack\.io/g) || []).length, 1, 'JitPack insertion must be idempotent');
  const app = { modResults: { language: 'groovy', contents: 'dependencies {\n    implementation "com.facebook.react:react-android"\n}' } };
  callbacks.app(app);
  for (const token of ['com.termux.termux-app:terminal-view:0.118.0', 'com.termux.termux-app:terminal-emulator:0.118.0', 'com.termux.termux-app:termux-shared:0.118.0', 'listenablefuture:9999.0-empty-to-avoid-conflict-with-guava']) assert.ok(app.modResults.contents.includes(token), `missing ${token}`);
  const once = app.modResults.contents;
  callbacks.app(app);
  assert.equal(app.modResults.contents, once, 'dependency insertion must be idempotent');
  const appConfig = fs.readFileSync(new URL('../app.config.ts', import.meta.url), 'utf8');
  assert.ok(appConfig.includes('withEmbeddedTermuxLibraries'));
  const versionCode = Number(appConfig.match(/versionCode:\s*(\d+)/)?.[1]);
  assert.ok(Number.isInteger(versionCode) && versionCode > 0, 'Android versionCode must remain a positive integer');
  const terminalScreen = fs.readFileSync(new URL('../app/terminal.tsx', import.meta.url), 'utf8');
  assert.match(terminalScreen, /Regular mode runs commands one at a time through the adapter/i, 'regular adapter mode must remain disclosed');
  assert.match(terminalScreen, /Embedded PTY is selected/i, 'embedded PTY mode must be disclosed separately');
  const nativeBridge = fs.readFileSync(new URL('../plugins/withTermuxBridge.js', import.meta.url), 'utf8');
  assert.match(nativeBridge, /getEmbeddedTermuxRuntimeStatus/);
  assert.match(nativeBridge, /function embeddedTerminalViewKotlin/);
  assert.match(nativeBridge, /TermuxEmbeddedTerminalViewManager/);
  assert.match(nativeBridge, /TerminalSession\(shell\.absolutePath/);
  assert.match(nativeBridge, /AibEmbeddedTerminalView/);
  const nativeViewWrapper = fs.readFileSync(new URL('../components/EmbeddedTermuxTerminalView.tsx', import.meta.url), 'utf8');
  assert.match(nativeViewWrapper, /AibEmbeddedTermuxTerminalView/);
  assert.match(nativeViewWrapper, /no external Termux app is required/i);
  const jsBridge = fs.readFileSync(new URL('../lib/termux-bridge.ts', import.meta.url), 'utf8');
  assert.match(jsBridge, /export async function getEmbeddedTermuxRuntimeStatus/);
  assert.match(jsBridge, /Fail closed: all required probes must be true/);
  assert.match(jsBridge, /bootstrapManifestValid/);
  assert.match(jsBridge, /bootstrapArchiveSha256/);
  assert.match(jsBridge, /embedded_prefix_ready/);
  console.log('PASS: pinned Termux libraries, JitPack repository, idempotent Gradle modifications, app config registration, honest PTY capability disclosure');
} finally {
  Module._load = originalLoad;
}
