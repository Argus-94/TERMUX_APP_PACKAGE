import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const checks = [
  ['node', 'node'],
  ['npm', 'npm'],
  ['java', 'java'],
  ['adb', 'adb'],
  ['sdkmanager', 'sdkmanager'],
];
let failed = false;
function has(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
for (const [name, cmd] of checks) {
  const ok = has(cmd);
  console.log(`${ok ? 'OK' : 'MISSING'} ${name}`);
  if (!ok && ['adb','sdkmanager'].includes(name)) failed = true;
}
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
console.log(`${sdk && fs.existsSync(sdk) ? 'OK' : 'MISSING'} ANDROID_SDK_ROOT/HOME`);
if (!sdk || !fs.existsSync(sdk)) failed = true;
const wrapper = fs.existsSync(path.join(root, 'android', 'gradlew')) || fs.existsSync(path.join(root, 'gradlew'));
console.log(`${wrapper ? 'OK' : 'MISSING'} Gradle wrapper`);
if (!wrapper) failed = true;
const androidDir = fs.existsSync(path.join(root, 'android'));
console.log(`${androidDir ? 'OK' : 'MISSING'} android/ native project`);
if (!androidDir) failed = true;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!fs.existsSync(path.join(root, 'node_modules'))) {
  console.error('MISSING node_modules — real Expo/React Native build cannot run here.');
  failed = true;
}
if (failed) {
  console.error('AIB_REAL_ENV_NOT_READY');
  process.exit(2);
}
console.log(`AIB_REAL_ENV_READY version=${pkg.version}`);
