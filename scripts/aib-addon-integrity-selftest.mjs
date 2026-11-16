import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const src = fs.readFileSync(path.join(root, 'lib/termux-addon-installer.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'plugins/withTermuxBridge.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assert(ok, msg) { if (!ok) throw new Error(`AIB_ADDON_INTEGRITY_SELFTEST_FAIL: ${msg}`); }

assert(src.includes('downloadUrl: "https://github.com/RikkaApps/Shizuku/releases/download/v13.6.0/shizuku-v13.6.0.r1086.2650830c-release.apk"'), 'Shizuku download URL must be statically pinned');
assert(src.includes('downloadUrl: "https://f-droid.org/repo/com.termux_1002.apk"'), 'Termux F-Droid URL must be statically pinned');
assert(src.includes('downloadUrl: "https://f-droid.org/repo/com.termux.boot_1000.apk"'), 'Termux:Boot F-Droid URL must be statically pinned');
assert(!src.includes('api.github.com/repos/'), 'addon installer must not resolve mutable GitHub API metadata at runtime');
assert(src.includes('expectedSha256: "6e273ab0e991c4e79bc8b1bbb9b9dd739ccac1a8712a541a214078886b7b790f"'), 'Shizuku SHA-256 must be statically pinned');
assert(/expectedSha256: \"6e273ab0e991c4e79bc8b1bbb9b9dd739ccac1a8712a541a214078886b7b790f\"/.test(src), 'Shizuku SHA-256 must be pinned');
assert(/expectedSha256: \"e6265a57eb5ca363808488e3b01955958bed93bc0c8a0d281849b363b11027ec\"/.test(src), 'Termux SHA-256 must be pinned');
assert(/expectedSha256: \"6f7cf9b94f539d3efd4af3544ff819947b49395275d8cfa7e5f80de14f3d9cf8\"/.test(src), 'Termux:Boot SHA-256 must be pinned');
assert(/ADDON_STATIC_SHA256_REQUIRED/.test(src), 'static SHA-256 validation missing');
assert(/ADDON_SOURCE_HTTPS_REQUIRED/.test(src), 'source HTTPS validation missing');
assert(/sha256File\(result\.uri\)/.test(src), 'downloaded APK is not hashed before install');
assert(/ADDON_APK_SHA256_MISMATCH/.test(src), 'hash mismatch must block install');
assert(/MessageDigest\.getInstance\("SHA-256"\)/.test(bridge), 'native SHA-256 implementation missing');
assert(/sha256File\(fileUri: String, promise: Promise\)/.test(bridge), 'native hash method missing');
assert(pkg.scripts?.['test:addon-integrity'] === 'node scripts/aib-addon-integrity-selftest.mjs', 'package script missing');
console.log('AIB_ADDON_INTEGRITY_SELFTEST_OK static_urls=3 static_sha256=3 apk_install=blocked_on_mismatch');
