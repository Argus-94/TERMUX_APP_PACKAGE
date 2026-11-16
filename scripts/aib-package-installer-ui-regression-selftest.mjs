#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const backend = read('lib/package-backend.ts');
const routing = read('lib/package-command-routing.ts');
const installerEnv = read('lib/termux-installer-env.ts');
const compile = read('lib/compile-packages.ts');
const reverse = read('lib/reverse-packages.ts');
const custom = read('lib/custom-packages.ts');
const aptHelper = read('lib/termux-apt-install.ts');
const diagnostics = read('lib/package-install-diagnostics.ts');
const menu = read('components/PackagesRightMenu.tsx');
const files = read('assets/github-tool/js/files.js');
const css = read('assets/github-tool/css/files.css');

// Proot commands must use guest apt indexes and must not run Termux mirror setup.
assert.match(installerEnv, /export function withPackageIndexUpdate\(\)[\s\S]*?if \(!isLinuxProotBackend\(\)\) return AI_BUILDER_INSTALLER_ENV \+ TERMUX_MIRROR_REPAIR/);
assert.match(installerEnv, /AI_BUILDER_TERMUX_INSTALLER_ENV \+ wrapTermuxAptInstallWithUpdate\(preferAptGetInstall\(adapted\)\)/);
assert.match(aptHelper, /AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED/);
assert.match(aptHelper, /exit 78/);
assert.doesNotMatch(aptHelper, /https?:\/\/|apt-get update|apt-get install/, "unqualified feed compatibility wrapper cannot retain an active package transaction");
assert.match(backend, /executionTarget: "embedded-private"/);
assert.match(backend, /options.kind !== "check"\) assertPrivatePackageMutationAllowed/);
assert.doesNotMatch(backend, /hostTermux:/);
assert.doesNotMatch(aptHelper, /termux-change-repo 2>\&1 \|\|/);
assert.match(diagnostics, /APT_UPDATE_DIAGNOSTIC_BEGIN[\s\S]*APT_UPDATE_DIAGNOSTIC_END/);
const linuxWrapper = installerEnv.slice(
  installerEnv.indexOf('function wrapLinuxAptInstallWithUpdate'),
  installerEnv.indexOf('/**\n * Run apt-get install/remove', installerEnv.indexOf('function wrapLinuxAptInstallWithUpdate')),
);
assert.match(linuxWrapper, /apt-get update -y/);
assert.match(linuxWrapper, /AIB_APT_EXIT:\$upd/);
assert.doesNotMatch(linuxWrapper, /TERMUX_PACKAGE_INDEX_CHECK|chosen_mirrors|termux-change-repo/);
assert.match(routing, /adaptAptGetPackageCommands\(c\)/);
assert.match(routing, /openjdk-17-jdk/);
assert.match(routing, /nodejs-lts/);
assert.match(routing, /__SDKMANAGER__/);
assert.match(routing, /packageBackendTarget/);
assert.match(routing, /adaptTermuxPackageCommand/);

// A result is successful only when the command exits successfully AND a fresh
// live check confirms the tool. An explicit installer error cannot be replaced
// by a second boolean check in the UI.
for (const [name, source] of [['compile', compile], ['reverse', reverse], ['custom', custom]]) {
  assert.match(source, /installResult\.exitCode === 0 && !installResult\.timedOut && (?:verified|verification\.status === "installed")/, `${name}: success requires exit 0, no timeout, and verification`);
  assert.match(source, /verification\.status === "error"/, `${name}: check failures should preserve their diagnostic`);
  assert.match(source, /formatPackageInstallFailure\(/, `${name}: full apt diagnostics must reach UI`);
}
assert.doesNotMatch(reverse + custom, /withPackageIndexUpdate\(\)[\s\S]{0,500}soft-fail/);
assert.doesNotMatch(compile, /termux-change-repo/);
assert.equal((menu.match(/if \(result\.ok && reallyThere\)/g) || []).length, 3);
assert.doesNotMatch(menu, /else if \(reallyThere\)/);
assert.match(menu, /Не удалось установить:[\s\S]{0,80}\$\{result\.error/);
assert.match(menu, /const buildBackend = RIGHT_PACKAGE_MENU_BACKEND/);
assert.match(menu, /resolveRightPackageMenuExpansionScanPlan\(RIGHT_PACKAGE_MENU_BACKEND, section\)/);
assert.match(menu, /SCAN_EXPAND target=\$\{plan\.target\} section=\$\{plan\.section\}/);
assert.match(menu, /if \(section !== "custom" \|\| customToolsReadyRef\.current\) \{\s*void verifySection\(section\)/);
assert.match(menu, /expandedRef\.current\[section\]/);
assert.doesNotMatch(menu, /resolveRightPackageMenuOpenScanPlan|SCAN_OPEN/);
assert.match(menu, /RIGHT_MENU_COMPILE_PACKAGES\.map\(\(def\) => renderPkgCard/);
assert.doesNotMatch(menu, /getBuildBackend\(\)/, "right sidebar must not follow the selected build environment");
assert.doesNotMatch(menu, /startOpenScans|for \(const section of plan\.sections\)/, "drawer open cannot scan all sections");
assert.match(menu, /Проверено в \$\{packageBackendLabel\(id\)\}/);

// GitHub file-manager delete confirmation supplies a label; the theme's generic
// danger rule had painted that label with the same color as the button surface.
assert.match(files, /confirmBox\('Удалить\?'[\s\S]{0,300}'Удалить', true\)/);
assert.match(css, /#modalWrap button\.mb\.danger\s*\{[\s\S]*?color:\s*var\(--on-danger, #690005\) !important;[\s\S]*?-webkit-text-fill-color:\s*var\(--on-danger, #690005\) !important;/);

console.log('AIB_PACKAGE_INSTALLER_UI_REGRESSION_SELFTEST_OK private_transport=1 qualified_feed_failclosed=1 legacy_linux_wrapper_only=1 strict_install_success=3 delete_label_contrast=1');
