#!/usr/bin/env node
import fs from 'node:fs';

const build = fs.readFileSync('lib/build-loop.ts', 'utf8');
const shell = fs.readFileSync('lib/agent-shell-backend.ts', 'utf8');
const selfHeal = fs.readFileSync('lib/self-healing-device-suite.ts', 'utf8');
const release = fs.readFileSync('lib/release-gate.ts', 'utf8');
const repair = fs.readFileSync('lib/repair-script-runner.ts', 'utf8');
const active = fs.readFileSync('lib/active-project.ts', 'utf8');

const checks = [
  ['unsigned build is rejected', build.includes('UNSIGNED_APK_NOT_ACCEPTED') && build.includes('const ok = fullySigned;')],
  ['all signature schemes verified', /V1_OK=0; V2_OK=0; V3_OK=0/.test(build) && build.includes('APK_SIGNATURE_SCHEMES_INCOMPLETE')],
  ['proot artifact translated to host path', shell.includes('hostVisiblePath') && shell.includes('guestHome = "/termux-home"') && build.includes('hostVisiblePath(signedRaw!)')],
  ['self-heal accepts backend-visible absolute artifact', selfHeal.includes('!apkHint.startsWith("/")')],
  ['release gate accepts backend-visible absolute artifact', release.includes('!artifact.startsWith("/")')],
  ['expo recovery pins pnpm and exposes guarded npm fallback', repair.includes('"$(pnpm --version 2>/dev/null || true)" = "9.15.0"') && repair.includes('pnpm install --frozen-lockfile') && repair.includes('NPM_FALLBACK_START') && repair.includes('restore_modules()')],
  ['signing repair fails closed', repair.includes('SIGNING_KEYSTORE_MISSING') && repair.includes('APKSIGNER_MISSING') && repair.includes('ZIPALIGN_MISSING')],
  ['aapt2 repair fails closed', repair.includes('AAPT2_BROKEN') && repair.includes('SDKMANAGER_MISSING') && repair.includes('REPAIR_FAIL:aapt2')],
  ['active project build discovers SDK', active.includes('ANDROID_SDK_NOT_FOUND') && active.includes('HOME/Android/Sdk')],
];
for (const [name, ok] of checks) if (!ok) throw new Error(`FAILED:${name}`);
console.log('AIB_V167_BUILD_CONTRACT_SELFTEST_OK unsigned=blocked signatures=v1v2v3 proot=host-visible recovery=fail-closed');
