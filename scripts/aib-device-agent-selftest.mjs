import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const files = [
  'core/device/DeviceAgentBridge.ts',
  'core/device/DeviceAgentTools.ts',
  'core/device/TermuxAdbDeviceBridge.ts',
  'lib/device-watchdog.ts',
  'plugins/withAibDeviceWatchdog.js',
];
const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
if (missing.length) { console.error('DEVICE_AGENT_MISSING', missing.join(',')); process.exit(1); }
const adb = fs.readFileSync(path.join(root, 'core/device/TermuxAdbDeviceBridge.ts'), 'utf8');
for (const token of ['adb devices','adb install -r','adb shell monkey','adb logcat','adb shell input tap','adb shell input swipe']) {
  if (!adb.includes(token)) { console.error('DEVICE_AGENT_CONTRACT_MISSING', token); process.exit(1); }
}
const cfg = fs.readFileSync(path.join(root, 'app.config.ts'), 'utf8');
for (const token of ['withAibDeviceWatchdog','FOREGROUND_SERVICE_CONNECTED_DEVICE']) {
  if (!cfg.includes(token)) { console.error('WATCHDOG_CONFIG_MISSING', token); process.exit(1); }
}
console.log('AIB_DEVICE_AGENT_SELFTEST_OK');
