import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(import.meta.url);
const originalLoad = Module._load;
let plugin;
try {
  Module._load = function(request, parent, isMain) {
    if (request === '@expo/config-plugins') return { withAndroidManifest: config => config, withMainApplication: config => config, withDangerousMod: config => config };
    return originalLoad.call(this, request, parent, isMain);
  };
  plugin = require('../plugins/withTermuxBridge.js');
} finally { Module._load = originalLoad; }
const kotlin = plugin.__moduleKotlinForTest('com.karat.aibuilder');
const installer = fs.readFileSync(path.join(root, 'plugins/termuxBootstrapInstallerKotlin.js'), 'utf8');
const nativeBridge = kotlin.slice(kotlin.indexOf('class TermuxBridgeModule'), kotlin.indexOf('class TermuxBridgePackage'));

assert.match(kotlin, /sharedLexicalRoots = listOf\("\/storage\/emulated\/0\/AIBuilderTermux"\)/);
assert.doesNotMatch(kotlin, /\/sdcard\/AIBuilderTermux/);
assert.doesNotMatch(kotlin, /getPackageInfo\(\s*"com\.termux|setPackage\(\s*"com\.termux|com\.termux\.app/);
assert.doesNotMatch(nativeBridge, /startService\(|startForegroundService\(|ComponentName\([^\n]*com\.termux|Termux.*ACTION_RUN_COMMAND/);
assert.match(kotlin, /runEmbeddedTermuxCommand/);
assert.match(installer, /filesDir/);
assert.match(installer, /return PackageFeedState\(false, "blocked_signing_key_unprovisioned"\)/);
assert.doesNotMatch(installer, /PACKAGE_FEED_KEY_SHA256\s*=\s*"(?!UNPROVISIONED)/);
assert.doesNotMatch(installer + kotlin, /A7EE64180D30C6DCD498F12FDC3AF8E50872E21F|a19da39a2dcfe805be612ce886e8eb644e56ea9fbbb5e74b71aab79949717df2|BEGIN PGP (?:PUBLIC|PRIVATE) KEY BLOCK|OPENPGP/i);
const productionAssets = path.join(root, 'assets/termux-production');
assert.ok(!fs.existsSync(productionAssets) || fs.readdirSync(productionAssets).length === 0, 'no production feed key or secret is provisioned');
assert.ok(fs.statSync(path.join(root, 'assets/termux-bootstrap/termux-bootstrap-aarch64.zip')).size > 0, 'bundled bootstrap archive must be present');
assert.equal(fs.existsSync(path.join(root, 'android')), false, 'no generated android project exists to inspect');
assert.equal(fs.existsSync(path.join(root, 'templates')), false, 'no templates directory exists to inspect');
console.log('AIB_V488_NATIVE_SELFTEST_OK embedded_bridge=1 shared_root=exact packaged_bootstrap=1 generated_android=absent');
