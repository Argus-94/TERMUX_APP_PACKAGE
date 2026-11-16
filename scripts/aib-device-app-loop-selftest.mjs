import fs from 'node:fs';
const files = [
  'core/device/DeviceAppLoop.ts',
  'core/device/DeviceAgentBridge.ts',
  'core/device/TermuxAdbDeviceBridge.ts',
  'core/device/DeviceAgentTools.ts',
  'core/RuntimeFacade.ts',
  'app/runtime.tsx',
];
for (const f of files) if (!fs.existsSync(f)) throw new Error(`MISSING:${f}`);
const loop = fs.readFileSync('core/device/DeviceAppLoop.ts','utf8');
const adb = fs.readFileSync('core/device/TermuxAdbDeviceBridge.ts','utf8');
const tools = fs.readFileSync('core/device/DeviceAgentTools.ts','utf8');
const ui = fs.readFileSync('app/runtime.tsx','utf8');
for (const token of ['bridge.install', 'bridge.launch', 'bridge.screenshotBase64', 'bridge.logcat']) {
  if (!loop.includes(token)) throw new Error(`LOOP_TOKEN_MISSING:${token}`);
}
for (const token of ['adb exec-out screencap -p', 'base64']) {
  if (!adb.includes(token)) throw new Error(`ADB_SCREENSHOT_TOKEN_MISSING:${token}`);
}
for (const token of ['device.app_loop', 'device.screenshot.base64']) {
  if (!tools.includes(token)) throw new Error(`TOOL_TOKEN_MISSING:${token}`);
}
const runtimeI18n = fs.readFileSync('lib/runtime-i18n.ts','utf8');
if (!ui.includes('rt("installLaunchScreenshotLogcat")') || !runtimeI18n.includes('installLaunchScreenshotLogcat:')) throw new Error('UI_DEVICE_LOOP_MISSING');
console.log('AIB_DEVICE_APP_LOOP_SELFTEST_OK');
