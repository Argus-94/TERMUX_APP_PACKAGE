import fs from 'node:fs';

const packs = fs.readFileSync('lib/termux-packs.ts', 'utf8');
const settings = fs.readFileSync('hooks/useAppSettings.ts', 'utf8');

// Packs UI was intentionally emptied: installSteps are empty, ALL_TOOL_PACKS=[].
// Policy: no sdkmanager NDK path, no unpinned NDK fallbacks, safe cancel scope.
if (/ndk;29\.0\.14206865"\s*\|\|\s*"\$SM"[^\n]*ndk;27\./.test(packs) || /ndk;27\.2\.12479018|ndk;27\.0\.12077973|ndk;26\.3\.11579264/.test(packs)) {
  throw new Error('unpinned NDK fallback revisions remain');
}
if (/sdkmanager[^\n]*ndk;29\.0\.14206865/i.test(packs)) {
  throw new Error('NDK sdkmanager installation path must remain blocked');
}
if (!/ALL_TOOL_PACKS:\s*TermuxToolPack\[\]\s*=\s*\[\]/.test(packs) && !/export const ALL_TOOL_PACKS: TermuxToolPack\[\] = \[\]/.test(packs)) {
  // if packs are re-enabled they must carry the pinned ARM64 archive
  if (!/ndk-r29-aarch64\.tar\.xz/.test(packs) || !/sha256:\s*"[a-f0-9]{64}"/.test(packs)) {
    throw new Error('pinned ARM64 NDK archive path missing');
  }
}
if (/pkill -f 'curl\|wget\|apt-get\|pkg install\|pip install\|sdkmanager\|unzip .*android\|tar -x'/.test(settings)) {
  throw new Error('cancellation still kills broad package/build processes');
}
if (!/pkill -f 'curl\|wget'/.test(settings)) {
  throw new Error('safe downloader cancellation path missing');
}
console.log('AIB_V250_REGRESSION_SELFTEST_OK ndk_fallback=blocked cancel_scope=downloaders_only packs=disabled_or_pinned');
