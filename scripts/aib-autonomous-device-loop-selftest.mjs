import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const checks = [
  ['lib/autonomous-device-loop.ts', ['runAutonomousDeviceDevelopmentLoop','runAssembleDebug','buildFixPrompt']],
  ['core/agent/AgentManager.ts', ['device.automation_loop','Capability denied: adb','runDeviceAutomation']],
  ['core/RuntimeFacade.ts', ['"adb"','runDeviceAutomation: (options) => this.runDeviceAutomation(options)','runDeviceAutomationAsAgent']],
  ['hooks/useLLM.ts', ['runDeviceDevelopmentLoop','runAutonomousDeviceDevelopmentLoop','FileSystemLegacy.EncodingType.Base64']],
  ['app/runtime.tsx', ['rt("buildVisionFix")','runDeviceDevelopmentLoop']],
  ['lib/runtime-i18n.ts', ['buildVisionFix']],
];
for (const [file, needles] of checks) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`${file}: missing ${needle}`);
}
console.log('AIB_AUTONOMOUS_DEVICE_LOOP_SELFTEST_OK');
