import fs from 'node:fs';

const src = fs.readFileSync('lib/termux-packs.ts', 'utf8');
const agentSrc = fs.readFileSync('lib/termux-agent.ts', 'utf8');
const downloadBlocks = [...src.matchAll(/download:\s*\{[\s\S]*?\}/g)].map(m => m[0]);
const packsDisabled = /export const ALL_TOOL_PACKS: TermuxToolPack\[\] = \[\]/.test(src) ||
  (/installSteps:\s*\[\]/.test(src) && !/label: "android-ndk"/.test(src));

if (!downloadBlocks.length && !packsDisabled) throw new Error('AIB_A08_NO_DOWNLOAD_BLOCKS');
if (/ghproxy|mirror\.ghproxy/i.test(src + agentSrc)) throw new Error('AIB_A08_PROXY_MIRROR_PRESENT');
if (/DL\s*\(.*\).*https:\/\/github\.com\/lzhiyong\/termux-ndk/i.test(agentSrc) && !/SHA-256|sha256|pinned/i.test(agentSrc)) throw new Error('AIB_A08_UNPINNED_NDK_FAST_PATH');
if (/discoverGoogleZips\(run/.test(src)) throw new Error('AIB_A08_DYNAMIC_DISCOVERY_BYPASS');
if (/npm install -g apk-mitm/i.test(src)) throw new Error('AIB_A08_GLOBAL_APK_MITM_INSTALL_PRESENT');
if (!/apk-mitm installation is disabled because global npm installs are not integrity-pinned/i.test(src)) throw new Error('AIB_A08_APK_MITM_FAIL_CLOSED_MISSING');
if (/command -v d2j-dex2jar[^\n]*\|\|\s*pkg install -y dex2jar/i.test(src)) throw new Error('AIB_A08_DEX2JAR_HASH_BYPASS');
if (/pkg install -y gradle[^\n]*command -v gradle/i.test(src)) throw new Error('AIB_A08_UNVERIFIED_GRADLE_FALLBACK');
if (/pkg install -y android-sdk[^\n]*SDK=/i.test(src)) throw new Error('AIB_A08_UNVERIFIED_ANDROID_SDK_FALLBACK');
if (/\|\| gradle assembleDebug/i.test(src)) throw new Error('AIB_A08_GRADLE_WRAPPER_FALLBACK');
if (!packsDisabled) {
  if (!/sha256sum\s+"\$\{dest\}"/.test(src)) throw new Error('AIB_A08_SHA256_VERIFY_MISSING');
  if (!/DOWNLOAD_DIGEST_REQUIRED/.test(src)) throw new Error('AIB_A08_FAIL_CLOSED_MISSING');
}
if (/gradle-8\.10\.2-bin\.zip|distributionSha256Sum=31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26/.test(agentSrc)) throw new Error('AIB_PROJECT_GRADLE_PIN_PRESENT');
if (/gradle-8\.10\.2-bin\.zip|distributionSha256Sum=31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26/.test(fs.readFileSync('lib/build-loop.ts', 'utf8'))) throw new Error('AIB_BUILD_LOOP_PROJECT_GRADLE_PIN_PRESENT');

if (/mirror\.termina\.online|mirrors\.ustc\.edu\.cn|packages\.termux\.dev\/apt\/termux-main/i.test(src)) throw new Error('AIB_A08_RUNTIME_MIRROR_FALLBACK_PRESENT');
if (/tryRecoverPkgMirror|mirrorTried|after mirror switch/i.test(src)) throw new Error('AIB_A08_PKG_MIRROR_RECOVERY_PRESENT');
if (/lzhiyong\/termux-ndk|lzhiyong aarch64|aarch64 \/ lzhiyong/i.test(agentSrc)) throw new Error('AIB_A08_STALE_NDK_MIRROR_GUIDANCE');
if (/Нет wrapper → gradle wrapper\.|Немає wrapper → gradle wrapper\.|No wrapper → gradle wrapper\./i.test(fs.readFileSync('lib/i18n.ts', 'utf8'))) throw new Error('AIB_A08_STALE_WRAPPER_GUIDANCE');

const activeProject = fs.readFileSync('lib/active-project.ts', 'utf8');
const idePrompt = fs.readFileSync('lib/ide-core-prompt.ts', 'utf8');
if (/\|\|\s*gradle\s+assembleDebug/i.test(activeProject)) throw new Error('AIB_A08_ACTIVE_PROJECT_GRADLE_FALLBACK');
if (/download it or use the system gradle|скачай его или используй системный gradle/i.test(idePrompt)) throw new Error('AIB_A08_IDE_UNPINNED_GRADLE_GUIDANCE');

const buildLoop = fs.readFileSync('lib/build-loop.ts', 'utf8');
if (/command -v gradle[^\n]*gradle wrapper --gradle-version/i.test(buildLoop)) throw new Error('AIB_A08_BUILD_LOOP_UNPINNED_WRAPPER_GENERATION');
if (/gradle wrapper --gradle-version|generating wrapper.*system gradle|"\$G" wrapper --gradle-version/i.test(agentSrc)) throw new Error('AIB_A08_TERMUX_AGENT_UNPINNED_WRAPPER_GENERATION');
if (!/NO_VERIFIED_GRADLE_WRAPPER/i.test(agentSrc) || !/project wrapper JAR is missing|verified APK build tool-pack/i.test(agentSrc)) throw new Error('AIB_TERMUX_AGENT_WRAPPER_FAIL_CLOSED_MISSING');
if (/system-gradle|elif command -v gradle[^\n]*gradle assembleDebug/i.test(buildLoop)) throw new Error('AIB_A08_BUILD_LOOP_SYSTEM_GRADLE_FALLBACK');
if (/pkg install -y openjdk-17/i.test(buildLoop)) throw new Error('AIB_A08_BUILD_LOOP_UNVERIFIED_JDK_INSTALL');
if (/pkg install -y openjdk-17/i.test(agentSrc)) throw new Error('AIB_A08_AGENT_UNVERIFIED_JDK_INSTALL');

console.log(`AIB_TOOLCHAIN_INTEGRITY_SELFTEST_OK pinned=${downloadBlocks.length} packs_disabled=${packsDisabled ? 1 : 0} fail_closed=1`);
