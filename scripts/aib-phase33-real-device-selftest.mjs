import fs from 'node:fs';
const required = [
  ['core/device/RealDeviceIntegration.ts', ['runRealDeviceIntegration','RealDeviceIntegrationRequest','DEVICE_NOT_AVAILABLE']],
  ['core/RuntimeFacade.ts', ['runRealDeviceIntegration','real-device-integration']],
  ['core/device/DeviceAgentBridge.ts', ['DeviceAgentBridge','screenSize','uiHierarchy']],
  ['core/device/TermuxAdbDeviceBridge.ts', ['TermuxAdbDeviceBridge','adb exec-out screencap','adb devices']],
  ['scripts/aib-android-e2e.mjs', ['AIB_ANDROID_E2E_FAIL','no Android device/emulator']],
];
for (const [file, tokens] of required) {
  const text=fs.readFileSync(file,'utf8');
  for (const token of tokens) if (!text.includes(token)) throw new Error(`missing ${token} in ${file}`);
}
const src=fs.readFileSync('core/device/RealDeviceIntegration.ts','utf8');
if (/return \{ ok: true/.test(src)) throw new Error('must not hardcode success');
const bridge=fs.readFileSync('core/device/DeviceAgentBridge.ts','utf8');
for (const token of ['uiHierarchy()', 'detectPackageName(', 'screenSize()']) if (!bridge.includes(token)) throw new Error(`bridge contract missing ${token}`);
console.log('AIB_PHASE33_REAL_DEVICE_INTEGRATION_SELFTEST_OK');
