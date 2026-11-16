/**
 * Pins the official Termux terminal UI/emulator libraries for the embedded-console
 * implementation. This deliberately does NOT claim to ship a Termux rootfs/bootstrap.
 * Upstream: https://github.com/termux/termux-app (libraries published to JitPack).
 */
const { withProjectBuildGradle, withAppBuildGradle } = require('@expo/config-plugins');

const TERMUX_VERSION = '0.118.0';
const JITPACK_REPO = 'maven { url "https://jitpack.io" }';
const LIBRARIES = [
  `implementation "com.termux.termux-app:terminal-view:${TERMUX_VERSION}"`,
  `implementation "com.termux.termux-app:terminal-emulator:${TERMUX_VERSION}"`,
  `implementation "com.termux.termux-app:termux-shared:${TERMUX_VERSION}"`,
  'implementation "com.google.guava:listenablefuture:9999.0-empty-to-avoid-conflict-with-guava"',
];

function withEmbeddedTermuxLibraries(config) {
  config = withProjectBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') return mod;
    let src = mod.modResults.contents;
    if (!src.includes('https://jitpack.io')) {
      const repoBlock = /allprojects\s*\{\s*repositories\s*\{/;
      if (repoBlock.test(src)) {
        src = src.replace(repoBlock, (m) => `${m}\n        ${JITPACK_REPO}`);
      } else {
        // Expo's root build.gradle normally has allprojects.repositories. If its
        // structure changes, fail prebuild loudly instead of silently omitting deps.
        throw new Error('[EmbeddedTermux] Could not locate allprojects.repositories in root build.gradle');
      }
    }
    mod.modResults.contents = src;
    return mod;
  });

  config = withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') return mod;
    let src = mod.modResults.contents;
    const missing = LIBRARIES.filter((dep) => !src.includes(dep));
    if (missing.length) {
      const depsBlock = /dependencies\s*\{/;
      if (!depsBlock.test(src)) {
        throw new Error('[EmbeddedTermux] Could not locate dependencies block in app/build.gradle');
      }
      src = src.replace(depsBlock, (m) => `${m}\n    // Official Termux terminal components; bootstrap/rootfs is a separate implementation phase.\n    ${missing.join('\n    ')}`);
    }
    mod.modResults.contents = src;
    return mod;
  });
  return config;
}

module.exports = withEmbeddedTermuxLibraries;
module.exports.TERMUX_VERSION = TERMUX_VERSION;
module.exports.LIBRARIES = LIBRARIES;
