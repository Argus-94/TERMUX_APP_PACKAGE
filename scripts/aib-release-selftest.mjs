import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const app = read('app.config.ts');
const eas = JSON.parse(read('eas.json'));
const errors = [];

// Keep the protected package manifest byte-for-byte unchanged; run build-critical gates here.
await import('./aib-apk-validation-selftest.mjs');
await import('./aib-build-artifact-gate-selftest.mjs');
await import('./aib-v388-android-build-chain-selftest.mjs');
await import('./aib-v388-build-recovery-selftest.mjs');

const appVersionLiteral = app.match(/version:\s*["']([^"']+)["']/)?.[1];
const usesCanonicalVersion = /version:\s*APP_VERSION\b/.test(app);
if (appVersionLiteral && appVersionLiteral !== pkg.version) errors.push(`VERSION_MISMATCH package=${pkg.version} app=${appVersionLiteral}`);
if (!appVersionLiteral && !usesCanonicalVersion) errors.push(`VERSION_SOURCE_MISSING package=${pkg.version}`);
if (eas?.build?.preview?.android?.buildType !== 'apk') errors.push('PREVIEW_APK_PROFILE_MISSING');
if (eas?.build?.production?.android?.buildType !== 'app-bundle') errors.push('PRODUCTION_AAB_PROFILE_MISSING');
if (!pkg.scripts?.['test:agent']) errors.push('AGENT_TEST_SCRIPT_MISSING');
if (!pkg.scripts?.['test:android:e2e']) errors.push('ANDROID_E2E_SCRIPT_MISSING');

const required = [
  'lib/agent-tools.ts', 'lib/session-memory.ts', 'lib/local-model.ts',
  'lib/termux-agent.ts', 'lib/termux-bridge.ts', 'scripts/aib-hashline.mjs',
  'scripts/aib-android-e2e.mjs'
];
for (const p of required) if (!fs.existsSync(path.join(root, p))) errors.push(`REQUIRED_FILE_MISSING:${p}`);

const localModel = read('lib/local-model.ts');
for (const token of ['LOCAL_MODEL', 'validateDownloadedFiles', 'smokeTest']) {
  if (!localModel.includes(token)) errors.push(`LOCAL_MODEL_GUARD_MISSING:${token}`);
}
const tools = read('lib/agent-tools.ts');
for (const token of ['fs.hashline', 'ast.preview', 'lsp.diagnostics', 'github.tree', 'memory.retain']) {
  if (!tools.includes(token)) errors.push(`AGENT_TOOL_MISSING:${token}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`AIB_RELEASE_SELFTEST_OK version=${pkg.version}`);
