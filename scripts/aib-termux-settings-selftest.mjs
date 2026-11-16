import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const app = read('app.config.ts');
const drawer = read('components/DrawerContent.tsx');
const layout = read('app/_layout.tsx');
const plugin = read('plugins/withTermuxBridge.js');
const installer = read('lib/termux-addon-installer.ts');
const screen = read('app/termux-settings.tsx');
const i18n = read('lib/i18n.ts');
const errors = [];

if (!fs.existsSync(path.join(root, 'app/termux-settings.tsx'))) errors.push('TERMUX_SETTINGS_SCREEN_MISSING');
if (!layout.includes('name="termux-settings"')) errors.push('TERMUX_SETTINGS_ROUTE_MISSING');
if (!drawer.includes('termux-settings')) errors.push('TERMUX_SETTINGS_DRAWER_ITEM_MISSING');
if (drawer.includes('Termux On') || drawer.includes('Termux Off')) errors.push('TERMUX_BUTTONS_STILL_IN_DRAWER');
for (const token of ['REQUEST_INSTALL_PACKAGES', 'FileProvider', 'aib_file_paths', 'canInstallPackages', 'installApk', 'getSupportedAbis', 'getPackageVersion', 'com.termux.boot', 'moe.shizuku.privileged.api', 'ClipData']) {
  if (!plugin.includes(token) && !app.includes(token)) errors.push(`NATIVE_INSTALL_GUARD_MISSING:${token}`);
}
const installerSrc = read('lib/termux-addon-installer.ts');
for (const token of ['downloadAddon', 'launchApkInstall']) {
  if (!installerSrc.includes(token)) errors.push(`ADDON_SPLIT_MISSING:${token}`);
}
for (const token of ['com.termux', 'RikkaApps/Shizuku', 'com.termux.boot', 'version: "0.118.3"', 'version: "v13.6.0"', 'version: "0.8.1"', 'assetName: "com.termux_1002.apk"', 'assetName: "shizuku-v13.6.0.r1086.2650830c-release.apk"', 'assetName: "com.termux.boot_1000.apk"', 'https://f-droid.org/repo/com.termux_1002.apk', 'https://f-droid.org/repo/com.termux.boot_1000.apk', 'arm64-v8a', 'armeabi-v7a', 'x86_64']) {
  if (!installer.includes(token)) errors.push(`ADDON_SOURCE_OR_ABI_MISSING:${token}`);
}
for (const token of [
  'Termux',
  'Shizuku',
  'Termux:Boot',
  'Termux On',
  'Termux Off',
  'termuxEnvironmentUpdateTitle',
  'yes | pkg update -y && yes | pkg upgrade -y',
  'pkg install termux-api -y',
  'termux-setup-storage',
  'allow-external-apps=true',
  'termux-reload-settings',
  'Clipboard',
  'termuxCopyAndOpen',
  'termuxSetupOutroNoCommands',
  'termuxBridgeMissingBanner',
  'termuxRecheckButton',
  'isNativeModuleAvailable',
  'checkTermuxReadiness',
  'termuxDownloadCancel',
  'cancelAddonDownload',
]) {
  if (!screen.includes(token) && !i18n.includes(token) && !installer.includes(token)) errors.push(`SCREEN_TOKEN_MISSING:${token}`);
}
for (const token of ['createDownloadResumable', 'cancelAddonDownload', 'DOWNLOAD_CANCELLED']) {
  if (!installer.includes(token)) errors.push(`ADDON_CANCEL_MISSING:${token}`);
}

if (screen.includes('termuxFirstLaunch') || screen.includes('Первый запуск Termux')) errors.push('FIRST_LAUNCH_CARD_STILL_PRESENT');
if (screen.includes('runShellCommand')) errors.push('ENV_UPDATE_STILL_USES_RUNSHELL');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`AIB_TERMUX_SETTINGS_SELFTEST_OK version=${pkg.version}`);
