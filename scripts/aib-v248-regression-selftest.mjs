import fs from 'node:fs';
const packs=fs.readFileSync('lib/termux-packs.ts','utf8');
const agent=fs.readFileSync('lib/termux-agent.ts','utf8');
const build=fs.readFileSync('lib/build-loop.ts','utf8');
const i18n=fs.readFileSync('lib/i18n.ts','utf8');
const eng=fs.readFileSync('lib/agent-engine.ts','utf8');
const installer=fs.readFileSync('lib/termux-installer-env.ts','utf8');
const compilePkgs=fs.readFileSync('lib/compile-packages.ts','utf8');

const coreTexts=[['packs',packs],['agent',agent],['build',build],['i18n',i18n],['eng',eng]];
const forbidden=[
  /packages-cf\.termux\.dev\/apt\/termux-main/i,
  /packages\.termux\.dev\/apt\/termux-main/i,
  /mirror\.termina\.online/i,
  /mirrors\.ustc\.edu\.cn/i,
  /pkg install -y android-sdk/i,
  /pkg install -y gradle/i,
  /\|\|\s*gradle\s+assembleDebug/i,
  /sdkmanager[^\n]*\"platform-tools\"[^\n]*\"platforms;android-34\"/i,
  /gradle wrapper --gradle-version/i,
  /npm install -g apk-mitm/i,
  /pip install\s+-U/i,
  /r2pm\s+-[Ui]/i,
];
for(const [name,text] of coreTexts) for(const re of forbidden) if(re.test(text)) throw new Error(`AIB_V248_FORBIDDEN:${name}:${re}`);

// Installer + compile-packages: mirrors only (pkg install is their job)
const mirrorForbidden=[
  /packages-cf\.termux\.dev\/apt\/termux-main/i,
  /packages\.termux\.dev\/apt\/termux-main/i,
  /mirror\.termina\.online/i,
  /mirrors\.ustc\.edu\.cn/i,
];
for (const [name,text] of [['installer',installer],['compilePkgs',compilePkgs]]) {
  for (const re of mirrorForbidden) if (re.test(text)) throw new Error(`AIB_V248_FORBIDDEN:${name}:${re}`);
}
if (/gradle wrapper --gradle-version/i.test(eng)) throw new Error('AIB_V248_FORBIDDEN:eng:gradle wrapper');
if(!/verified APK build tool-pack (?:is missing|must provide)/i.test(agent)) throw new Error('AIB_V248_SDK_TOOLPACK_GUARD_MISSING');
const mirrorFixStart = agent.indexOf('const TERMUX_MIRROR_FIX_CMD = [');
const mirrorFixEnd = agent.indexOf('].join("\\n");', mirrorFixStart);
if (mirrorFixStart < 0 || mirrorFixEnd < 0) throw new Error('AIB_V248_MIRROR_CHECK_COMMAND_MISSING');
const mirrorFixCommand = agent.slice(mirrorFixStart, mirrorFixEnd);
if (/TERMUX_OFFICIAL_MIRROR|sources\.list|packages(?:-cf)?\.termux\.dev|mirror\.mwt\.me/i.test(mirrorFixCommand)) {
  throw new Error('AIB_V248_MIRROR_REWRITE_FORBIDDEN');
}
if (!mirrorFixCommand.includes('pkg update -y') || !mirrorFixCommand.includes('termux-change-repo')) {
  throw new Error('AIB_V248_MIRROR_CHECK_OR_GUIDANCE_MISSING');
}
if (/TERMUX_OFFICIAL_MIRROR|printf[^\n]*\bdeb\b[^\n]*sources\.list/i.test(agent)) {
  throw new Error('AIB_V248_AGENT_PROMPT_MIRROR_REWRITE_FORBIDDEN');
}
if (!agent.includes('never invent a mirror URL') || !agent.includes('user-controlled manual step remains')) {
  throw new Error('AIB_V248_AGENT_PROMPT_SAFE_RECOVERY_MISSING');
}
console.log('AIB_V248_REGRESSION_SELFTEST_OK mirror_override=blocked sdk_auto_install=blocked eng=fail_closed');
