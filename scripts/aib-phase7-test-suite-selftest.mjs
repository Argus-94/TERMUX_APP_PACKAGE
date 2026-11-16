import fs from 'node:fs';
const required = {
  'core/device/DeviceTestPlanner.ts': ['generateDeviceTestSuite','buildFallbackSuite','Allowed actions'],
  'core/device/DeviceEvidenceStore.ts': ['EvidenceRef','documentDirectory','writeJson'],
  'core/device/DeviceTestRunner.ts': ['runDeviceTestSuite','capture','SELECTOR_NOT_FOUND'],
  'core/device/DeviceTestReport.ts': ['renderDeviceTestReport','Device Test Report'],
  'core/device/DeviceAgentBridge.ts': ['inputText'],
  'core/device/TermuxAdbDeviceBridge.ts': ['inputText','adb shell input text'],
  'app/runtime.tsx': ['generateRunSuite','runSuite'],
};
for (const [file, needles] of Object.entries(required)) {
  if (!fs.existsSync(file)) throw new Error(`MISSING_${file}`);
  const text = fs.readFileSync(file, 'utf8');
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`${file}: missing ${needle}`);
}
const runtimeI18n = fs.readFileSync('lib/runtime-i18n.ts','utf8');
for (const key of ['generateRunSuite','runSuite']) if (!runtimeI18n.includes(`${key}:`)) throw new Error(`runtime i18n missing ${key}`);
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
if (pkg.scripts?.['test:phase7-test-suite'] !== 'node scripts/aib-phase7-test-suite-selftest.mjs') throw new Error('MISSING_PHASE7_SCRIPT');
console.log('AIB_PHASE7_TEST_SUITE_SELFTEST_OK');
