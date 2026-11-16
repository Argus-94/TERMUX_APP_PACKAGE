import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const required = [
  'lib/fleet-canary-manager.ts',
  'lib/device-fleet-manager.ts',
  'hooks/useLLM.ts',
  'app/runtime.tsx',
];
for (const f of required) {
  if (!fs.existsSync(path.join(root, f))) throw new Error(`MISSING:${f}`);
}
const src = fs.readFileSync(path.join(root,'lib/fleet-canary-manager.ts'),'utf8');
for (const token of ['runFleetCanary','maxFailureRate','NO_READY_FLEET_DEVICES','STAGE_']) if (!src.includes(token)) throw new Error(`CONTRACT:${token}`);
const ui = fs.readFileSync(path.join(root,'app/runtime.tsx'),'utf8');
const runtimeI18n = fs.readFileSync(path.join(root,'lib/runtime-i18n.ts'),'utf8');
if (!ui.includes('rt("fleetCanary")') || !runtimeI18n.includes('fleetCanary:')) throw new Error('UI_MISSING');
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
pkg.scripts ||= {};
if (pkg.scripts['test:phase14-fleet-canary'] !== 'node scripts/aib-phase14-fleet-canary-selftest.mjs') throw new Error('SCRIPT_MISSING');
console.log('AIB_PHASE14_FLEET_CANARY_SELFTEST_OK');
