import fs from 'node:fs';
const src = fs.readFileSync('lib/termux-packs.ts', 'utf8');
// When NDK install steps exist they must block sdkmanager; when packs are empty, require explicit policy markers.
if (/label: "android-ndk"/.test(src)) {
  if (!/non-ARM NDK installation requires the verified APK build tool-pack; sdkmanager installation is blocked here/i.test(src)) throw new Error('AIB_V266_NDK_PRIMARY_GUARD_MISSING');
  if (!/NON_ARM_NDK_SDKMANAGER_BLOCKED/.test(src)) throw new Error('AIB_V266_NDK_RUNTIME_BLOCK_MISSING');
  const ndkBlock = src.match(/label: "android-ndk"[\s\S]*?label: "gradle"/)?.[0] || '';
  if (/sdkmanager[^\n]*['"]ndk;29\.0\.14206865['"]/i.test(ndkBlock)) throw new Error('AIB_V266_NDK_SDKMANAGER_PATH_PRESENT');
} else {
  if (!/NON_ARM_NDK_SDKMANAGER_BLOCKED|verified APK build tool-pack|ALL_TOOL_PACKS: TermuxToolPack\[\] = \[\]/.test(src)) {
    throw new Error('AIB_V266_NDK_PRIMARY_GUARD_MISSING');
  }
}
console.log('AIB_V266_REGRESSION_SELFTEST_OK ndk_sdkmanager=blocked');
