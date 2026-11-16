import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const menu = read('components/PackagesRightMenu.tsx');
const routing = read('lib/package-menu-routing.ts');
const layout = read('app/_layout.tsx');
const nativeTerminal = read('components/EmbeddedTermuxTerminalView.tsx');
const policy = read('lib/private-package-install-policy.ts');

// Reachability: app header opens the mounted right-side panel.
assert.match(layout, /onPress=\{openPackages\}/);
assert.match(layout, /<PackagesRightMenu visible=\{packagesVisible\} onClose=\{closePackages\} \/>/);
// Right-side package management remains pinned to the embedded Termux host, independent of build target.
assert.match(routing, /RIGHT_PACKAGE_MENU_BACKEND[^\n]*=\s*"termux"/);
assert.match(menu, /const buildBackend = RIGHT_PACKAGE_MENU_BACKEND/);
assert.match(menu, /installCompilePackage\([\s\S]*?buildBackend/);
assert.match(menu, /installReversePackage\([\s\S]*?buildBackend/);
assert.match(menu, /installCustomTool\([\s\S]*?buildBackend/);
assert.match(menu, /checkPackageInstalled\(def, buildBackend\)/);
assert.match(menu, /checkReversePackageInstalled\(def, buildBackend\)/);
assert.match(menu, /checkCustomToolInstalled\(def, def\.installKind === "custom", buildBackend\)/);
assert.match(menu, /const termuxOk = availability\.reason === "eligible"/);
assert.match(policy, /allowed: false/);
assert.match(policy, /AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED/);
assert.match(menu, /getPrivatePackageMutationAvailability\(\)\.allowed/);
// A blocked tap explains its reason; each callback still returns before mutation.
assert.doesNotMatch(menu, /disabled=\{!packageMutationAllowed \|\|/);
assert.equal((menu.match(/if \(!getPrivatePackageMutationAvailability\(\)\.allowed\)/g) || []).length, 4);
assert.match(menu, /offlinePackageMutationGateMessage\(language\)/);
assert.match(menu, /Ordinary catalog changes remain disabled/);
assert.match(menu, /onPress=\{\(\) => reviewRawCommand\(def, "check", \(\) => void handleVerifyCustom\(def\)\)\}/);
assert.match(menu, /Embedded Termux/);
assert.match(menu, /Встроенный Termux/);
assert.match(menu, /def\.blockedReason \|\| "Автоустановка отключена/);
assert.match(menu, /onPress=\{\(\) => void runInstall\(def\.id as AnyPkgId, kind\)\}/);
assert.match(menu, /onPress=\{\(\) => reviewRawCommand\(def, "install", \(\) => void handleInstallCustom\(def\)\)\}/);
assert.match(menu, /onPress=\{\(\) => void runCacheCleanup\(\)\}/);
assert.doesNotMatch(menu, /RUN_COMMAND|startActivityForResult|externalTermux|Linking\.open/i);
assert.match(nativeTerminal, /app-private storage/);
console.log('AIB_V492_SIDEBAR_SELFTEST_OK reachable=1 embedded_termux_target=1 qualified_block=1 actionable_controls=1');
