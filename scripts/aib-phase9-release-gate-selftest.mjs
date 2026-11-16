import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'lib/release-gate.ts',
  'core/device/DeviceTestRunner.ts',
  'core/device/DeviceTestReport.ts',
  'core/device/DeviceEvidenceStore.ts',
  'lib/self-healing-device-suite.ts',
];
for (const rel of required) if (!fs.existsSync(path.join(root, rel))) throw new Error(`MISSING:${rel}`);
const src = fs.readFileSync(path.join(root, 'lib/release-gate.ts'), 'utf8');
for (const token of ['runAssembleDebug', 'runDeviceTestSuite', 'RELEASE_ALLOWED', 'RELEASE_BLOCKED']) {
  if (!src.includes(token)) throw new Error(`CONTRACT_MISSING:${token}`);
}
console.log('AIB_PHASE9_RELEASE_GATE_SELFTEST_OK');
