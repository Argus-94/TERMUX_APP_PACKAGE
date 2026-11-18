#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { typescript as ts } from './test-helpers/load-typescript.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.version, '1.10.112');
assert.match(read('app.config.ts'), /versionCode:\s*512\b/);
assert.match(read('app.config.ts'), /package:\s*"com\.karat\.aibuilder"/);
const configBaseline = read('verification-v492/baseline/app.config.ts.txt');
assert.equal(hash(configBaseline.replace('versionCode: 491', 'versionCode: 486')), 'a88a17c9b902ce75265a822864ff3b1d3a204fa02629456856cb57c2f33543ca', 'baseline configuration identity is pinned');
const configJs = (source) => ts.transpileModule(source.replace(/versionCode:\s*\d+/, 'versionCode: 486'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, removeComments: true } }).outputText;
assert.equal(configJs(read('app.config.ts')), configJs(configBaseline), 'type-only Expo compatibility fix must emit the exact same config JavaScript; only release code may differ');
assert.equal(hash(JSON.stringify({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, pnpm: pkg.pnpm, overrides: pkg.overrides, packageManager: pkg.packageManager })), '79fd695920d82a927331ead71759a9d072ceb3ef33a012e33da7e441fbf4fc09', 'dependency and package-manager configuration must match the reviewed v506 pin');
assert.equal(pkg.dependencies.fflate, '0.8.3');
assert.equal(pkg.dependencies['@xmldom/xmldom'], '0.9.12');
assert.equal(pkg.dependencies['expo-pdf-text-extract'], '1.1.0');
const protectedHashes = {
  'pnpm-lock.yaml': '53db6fc4b7ccf03b0d0140a250c2d87305fd3e4217d3c694fa0d70ba8a38a250',
  'gradle.properties': 'fd048ca701127912fae07cc1116c79301032c8c25fc6c520f3709de5470b6074',
  'eas.json': 'b89c0cc62bc73ed611f34733a209f2705f78293927b05c4e12fff802e09eeee5',
  'plugins/withEmbeddedTermuxLibraries.js': '7779ff6815e1f7ce1c6b21d923904cbbaa0e7203dbac766fdc2f8bf9c6205c78',
  'plugins/withFixGradleProperties.js': 'b83237f274442c11a9a4749db5e8dcac8d2443cad63490d7cf506cf231c692d2',
  'plugins/withEnsureBuildConfig.js': 'c042dd812b78491c509dcbb07d34550a72d6959b61f800a0145e827718550ef8',
  'plugins/withLlamaRnProguard.js': '4f5eb7051880f634fc99197a097c84d6d9e0a9d4d492ad0315dc5df845da7b4a',
  'plugins/withAndroidReleaseSigning.js': '2aa97ad9330268d2bc3ce911b65ae980f1e8daede2f3189818d8c69acac57e0c',
  'scripts/aib-apply-android-release-signing.mjs': 'f9a2b711c03decf3101b94a06fb64bcc66056eb663f2ea89a8e4c2881478ac1a',
  'scripts/aib-auto-prebuild.mjs': '1c0238bbf8884d3bb9625071819414309de873cbfc4d68784ef126cadacba0ae',
};
for (const [name, expected] of Object.entries(protectedHashes)) assert.equal(hash(fs.readFileSync(path.join(root, name))), expected, name);

const files = [];
function collect(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(relative);
    else if (/\.(?:[cm]?js|tsx?|kt|java|sh)$/.test(entry.name)) files.push(relative);
  }
}
for (const dir of ['app', 'components', 'lib', 'core', 'plugins', 'native', 'scripts/repair', 'AIBuilder']) collect(dir);
const forbidden = [
  /com\.termux\.permission\.RUN_COMMAND/,
  /com\.termux\.app\.(?:RunCommandService|TermuxService|TermuxActivity)/,
  /(?:package:|market:\/\/details\?id=)com\.termux\b/,
  /https?:\/\/(?:packages\.termux\.(?:dev|net)|packages-cf\.termux\.dev|grimler\.se\/termux)/,
  /https?:\/\/f-droid\.org\/[^\s"']*com\.termux/,
  /\/data\/(?:data|user\/\d+)\/com\.termux(?:\/|\b)/,
];
for (const file of files) {
  const source = read(file);
  for (const pattern of forbidden) assert.ok(!pattern.test(source), `${file}: forbidden external runtime route ${pattern}`);
}
const native = read('plugins/withTermuxBridge.js');
assert.ok(!native.includes('setClassName(TERMUX_PACKAGE'));
assert.ok(!native.includes('getPackageInfo(TERMUX_PACKAGE'));
assert.ok(!native.includes('startService(runCommandIntent'));
assert.match(native, /runEmbeddedTermuxCommand\(command, workdir, timeoutMs, requestId, promise\)/);
assert.match(native, /EXTERNAL_TERMUX_UNSUPPORTED/);
const proguardPlugin = read('plugins/withLlamaRnProguard.js');
assert.match(proguardPlugin, /-dontwarn com\.gemalto\.jp2\.JP2Decoder/);
assert.doesNotMatch(proguardPlugin, /-dontwarn com\.gemalto\.jp2\.\*/);
assert.match(proguardPlugin, /text extraction/);
assert.match(read('lib/private-workspace-policy.ts'), /\/storage\/emulated\/0\/AIBuilderTermux/);
assert.match(read('lib/private-runtime-provider.ts'), /executionTarget: "embedded-private"/);
assert.match(read('lib/termux-executor.ts'), /embedded-private/);
for (const file of ['lib/i18n.ts', 'AIBuilder/lib/i18n.ts', 'lib/ide-core-prompt.ts', 'lib/autonomous-engineer.ts', 'lib/task-prompts.ts']) {
  assert.doesNotMatch(read(file), /официальн[^\n]*APK Termux|офіційн[^\n]*APK Termux|opens Termux|open Termux and|Скопируйте и выполните в Termux|Скопіюйте і виконайте в Termux|pkg update -y && pkg install/, `${file}: stale external setup or unqualified auto-install guidance`);
}
assert.doesNotMatch(read('app/runtime.tsx'), /\["selected-backend", language/, 'the UI cannot offer the disabled external target');
console.log(`AIB_V487_EMBEDDED_BOUNDARY_SELFTEST_OK scanned=${files.length} immutable_config=${Object.keys(protectedHashes).length} external_routes=absent dependencies=v506-pinned evidence=source-only`);
