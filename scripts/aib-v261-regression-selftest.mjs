import fs from 'node:fs';
const src = fs.readFileSync('lib/termux-packs.ts', 'utf8');
if (/if\s*\(isNdk\s*&&\s*dl\.sha256\)/.test(src)) throw new Error('AIB_V261_POST_DOWNLOAD_NDK_FALLBACK_BLOCK_PRESENT');
const ndk = (src.match(/label: "android-ndk"[\s\S]{0,900}/) || [])[0];
if (ndk) {
  if (!/sha256:\s*"[a-f0-9]{64}"/i.test(ndk)) throw new Error('AIB_V261_NDK_SHA256_MISSING');
} else {
  // Packs intentionally emptied — require fail-closed / disabled policy markers
  if (!/PIP_DISABLED_STEP/.test(src) && !/ALL_TOOL_PACKS:\s*TermuxToolPack\[\]\s*=\s*\[\]/.test(src) && !/export const ALL_TOOL_PACKS: TermuxToolPack\[\] = \[\]/.test(src)) {
    throw new Error('AIB_V261_NDK_SHA256_MISSING');
  }
}
console.log('AIB_V261_REGRESSION_SELFTEST_OK ndk_fallback=blocked');
