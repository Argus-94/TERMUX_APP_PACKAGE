import fs from 'node:fs';
const required = {
  'core/device/AccessibilityTree.ts': ['parseUiHierarchy','findUiNodes','nodeCenter'],
  'core/device/DeviceTestPlan.ts': ['generateDeviceTestPlan','DeviceTestPlan'],
  'core/device/DeviceTestAssertions.ts': ['evaluateDeviceTestPlan','text_present'],
  'core/device/DeviceAppLoop.ts': ['detectPackageName','APK_PACKAGE_NAME_NOT_DETECTED'],
  'core/device/DeviceAutomationAgent.ts': ['Accessibility tree','ASSERTIONS_PASSED','testPlan'],
  'core/device/TermuxAdbDeviceBridge.ts': ['uiHierarchy','detectPackageName','screenSize'],
};
for (const [file, needles] of Object.entries(required)) {
  if (!fs.existsSync(file)) throw new Error(`MISSING_${file}`);
  const text = fs.readFileSync(file, 'utf8');
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`${file}: missing ${needle}`);
}
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
if (pkg.scripts?.['test:phase6-ui-tree'] !== 'node scripts/aib-phase6-ui-tree-selftest.mjs') throw new Error('MISSING_PHASE6_SCRIPT');
console.log('AIB_PHASE6_UI_TREE_SELFTEST_OK');
