import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const required = [
  'lib/device-fleet-manager.ts',
  'lib/production-deployment-manager.ts',
  'core/device/TermuxAdbDeviceBridge.ts',
  'hooks/useLLM.ts',
  'app/runtime.tsx',
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`MISSING:${file}`);
}
const src = fs.readFileSync(path.join(root, 'lib/device-fleet-manager.ts'), 'utf8');
for (const token of ['deployReleaseFleet', 'concurrency', 'AUTO_ROLLBACK_COMPLETED', 'fleet-']) {
  if (!src.includes(token)) throw new Error(`CONTRACT:${token}`);
}
console.log('AIB_PHASE13_DEVICE_FLEET_SELFTEST_OK');
