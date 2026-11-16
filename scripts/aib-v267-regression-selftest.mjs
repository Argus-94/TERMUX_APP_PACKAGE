import fs from 'node:fs';
const src = fs.readFileSync('lib/termux-addon-installer.ts', 'utf8');
function assert(ok, msg) { if (!ok) throw new Error(`AIB_V267_REGRESSION_FAIL: ${msg}`); }
assert(/ADDON_STATIC_SHA256_REQUIRED/.test(src), 'addon install must fail closed without static SHA-256');
assert(/expectedSha256: "6e273ab0e991c4e79bc8b1bbb9b9dd739ccac1a8712a541a214078886b7b790f"/.test(src), 'Shizuku static digest missing');
assert(/expectedSha256: "6f7cf9b94f539d3efd4af3544ff819947b49395275d8cfa7e5f80de14f3d9cf8"/.test(src), 'Termux:Boot static digest missing');
assert(/downloadUrl: "https:\/\/github.com\/RikkaApps\/Shizuku\/releases\/download\/v13\.6\.0\//.test(src), 'Shizuku static download URL missing');
assert(/downloadUrl: "https:\/\/f-droid\.org\/repo\/com\.termux\.boot_1000\.apk"/.test(src), 'Termux:Boot static F-Droid URL missing');
assert(!/api\.github\.com\/repos\//.test(src), 'runtime GitHub release API lookup remains');
console.log('AIB_V267_REGRESSION_SELFTEST_OK addon_urls=static addon_sha256=2 runtime_api=blocked');
