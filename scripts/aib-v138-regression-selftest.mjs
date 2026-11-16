import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const backend = read('lib/package-backend.ts');
const routing = read('lib/package-command-routing.ts');
const menu = read('components/PackagesRightMenu.tsx');
const compile = read('lib/compile-packages.ts');
const reverse = read('lib/reverse-packages.ts');
const custom = read('lib/custom-packages.ts');
const build = read('lib/build-loop.ts');
const apk = read('lib/apk-build-engine.ts');
const agent = read('lib/agent-shell-backend.ts');
const bootstrap = read('lib/termux-bootstrap-install.ts');

if (!backend.includes('runPackageCommand')) throw new Error('PACKAGE_BACKEND_MISSING');
if (!backend.includes('getBuildBackend()')) throw new Error('PACKAGE_BACKEND_NOT_UNIFIED');
if (!routing.includes('apt-get ${verb === "install" ? "install" : "remove"} -y')) throw new Error('UBUNTU_APT_ADAPTER_MISSING');
if (!routing.includes('"proot-distro"') || !backend.includes('packageBackendTarget(selectedBackend, options.packageId)')) throw new Error('BOOTSTRAP_HOST_ROUTE_MISSING');
if (!backend.includes('PACKAGE_UNSUPPORTED_IN_${selectedBackend === "ubuntu-proot" ? "DEBIAN" : "UBUNTU"}')) throw new Error('UNSUPPORTED_LINUX_PACKAGE_NOT_EXPLICIT');
for (const [name, src] of [['compile',compile],['reverse',reverse],['custom',custom]]) {
  if (/runShellCommand\(/.test(src)) throw new Error(`${name.toUpperCase()}_DIRECT_TERMUX_EXECUTOR_REMAINED`);
  if (!src.includes('runPackageCommand')) throw new Error(`${name.toUpperCase()}_PACKAGE_BACKEND_MISSING`);
}
if (/ghfast\.top|ghproxy|mirror\.ghproxy|gh-proxy\.com|ghproxy\.net/.test(compile + reverse)) {
  throw new Error('UNTRUSTED_PROXY_REMAINED');
}
if (!reverse.includes('Автоустановка отключена: для Smali/Baksmali')) throw new Error('SMALI_UNPINNED_NOT_BLOCKED');
if (!compile.includes('NDK_SHA_MISMATCH') || !compile.includes('NDK_SHA256_TOOL_MISSING')) throw new Error('NDK_SHA_NOT_MANDATORY');
if (!compile.includes('GRADLE_SHA_MISMATCH') || !compile.includes('GRADLE_PREREQUISITE_MISSING') || !compile.includes('EXPECT_SHA="f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6"')) throw new Error('GRADLE_SHA_NOT_MANDATORY');
if (!compile.includes('CMDLINE_SHA_MISMATCH') || !compile.includes('CMDLINE_PREREQUISITE_MISSING') || !compile.includes('EXPECT_SHA="2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258"') || !compile.includes('https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip')) throw new Error('CMDLINE_SHA_NOT_MANDATORY');
if (!bootstrap.includes('buildProotDistroRootfsCheckCommand') || !bootstrap.includes('AIB_${marker}_ROOTFS_INSTALLED_LOGIN_FAILED') || !bootstrap.includes('AIB_${marker}_ROOTFS_MISSING')) throw new Error('ROOTFS_PROFILE_ID_CHECK_MISSING');
if (/platform-34-ext7_r03\.zip|platform-35_r01\.zip/.test(compile) && !compile.includes('PLATFORM34_SDKMANAGER_REQUIRED')) throw new Error('PLATFORM_FALLBACK_NOT_FAIL_CLOSED');
if (!menu.includes('backendLabel')) throw new Error('MENU_BACKEND_INDICATOR_MISSING');
if (!build.includes("'$PREFIX/opt/android-sdk'")) throw new Error('UBUNTU_SDK_PREFIX_NOT_DISCOVERED');
if (!build.includes("'$PREFIX/opt/android-ndk'")) throw new Error('UBUNTU_NDK_PREFIX_NOT_DISCOVERED');
if (!apk.includes('executeGuardedTermuxCommand')) throw new Error('APK_ENGINE_NOT_BACKEND_AWARE');
if (!agent.includes('if [ -z "$PREFIX" ]; then PREFIX=/root/.aibuilder-prefix; fi; export PREFIX')) throw new Error('UBUNTU_PREFIX_EXPORT_MISSING');

console.log('AIB_V138_REGRESSION_SELFTEST_OK unified_package_backend=1 ubuntu_adapter=1 bootstrap_host=1 no_proxy_fallback=1 mandatory_ndk_sha=1 build_preflight_backend=1');
