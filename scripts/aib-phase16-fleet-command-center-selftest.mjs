import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const required = [
  'lib/fleet-command-center.ts',
  'lib/fleet-observability.ts',
  'lib/device-fleet-manager.ts',
  'app/runtime.tsx',
  'hooks/useLLM.ts',
];
for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`MISSING_${rel}`);
}
const command = fs.readFileSync(path.join(root, 'lib/fleet-command-center.ts'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'app/runtime.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'hooks/useLLM.ts'), 'utf8');
for (const token of ['getFleetCommandSnapshot','deployFleetDevice','rollbackFleetDevice','acknowledgeCommandCenterIncident']) if (!command.includes(token)) throw new Error(`MISSING_COMMAND_${token}`);
for (const token of ['runAIFleetCommandCenter','runAIFleetDeviceCommand']) if (!ui.includes(token) && !hook.includes(token)) throw new Error(`MISSING_UI_${token}`);
const runtimeI18n = fs.readFileSync(path.join(root,'lib/runtime-i18n.ts'),'utf8');
for (const token of ['fleetCommand','deploy','rollback']) if (!runtimeI18n.includes(`${token}:`) || !ui.includes(`rt("${token}")`)) throw new Error(`MISSING_UI_${token}`);
if (!hook.includes('runAIFleetCommandCenter')) throw new Error('HOOK_COMMAND_CENTER_MISSING');
if (!hook.includes('runAIFleetDeviceCommand')) throw new Error('HOOK_DEVICE_COMMAND_MISSING');
console.log('AIB_PHASE16_FLEET_COMMAND_CENTER_SELFTEST_OK');
