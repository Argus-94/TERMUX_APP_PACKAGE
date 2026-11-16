import fs from 'node:fs';

const packs = fs.readFileSync('lib/termux-packs.ts', 'utf8');
const agent = fs.readFileSync('lib/termux-agent.ts', 'utf8');
const skills = fs.readFileSync('lib/agent-skills.ts', 'utf8');
const recovery = fs.readFileSync('lib/agent-recovery.ts', 'utf8');
const settings = fs.readFileSync('app/settings.tsx', 'utf8');
const i18n = fs.readFileSync('lib/i18n.ts', 'utf8');

if (/curl[^\n]*lzhiyong\/termux-ndk|wget[^\n]*lzhiyong\/termux-ndk/i.test(agent)) {
  throw new Error('AIB_A08_REGRESSION_DIRECT_NDK_DOWNLOAD');
}
if (/Download aarch64 Termux NDK/i.test(agent) && !/Direct model-generated NDK downloads are disabled/i.test(agent)) {
  throw new Error('AIB_A08_REGRESSION_NDK_POLICY_MISSING');
}
if (/try a valid (?:Android\/Termux )?mirror|other mirror|alternate source|working mirror|актуальн.*верси|рабоч.*зеркал|исправь зеркало|альтернативн.*имя пакет/i.test(agent + skills + recovery + settings + i18n)) {
  throw new Error('AIB_A08_REGRESSION_UNVERIFIED_MIRROR_GUIDANCE');
}
if (!/pinned SHA-256/i.test(agent + packs)) throw new Error('AIB_A08_REGRESSION_PINNED_SHA_POLICY_MISSING');
console.log('AIB_A08_REGRESSION_SELFTEST_OK direct_ndk=blocked mirror_guidance=pinned_only');
