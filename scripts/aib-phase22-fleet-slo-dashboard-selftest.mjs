import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const required = [
  'lib/fleet-slo-dashboard.ts',
  'lib/fleet-recovery-scheduler.ts',
  'lib/fleet-observability.ts',
  'hooks/useLLM.ts',
  'app/runtime.tsx',
];
for (const f of required) if (!fs.existsSync(path.join(root, f))) throw new Error(`MISSING:${f}`);
const dash = fs.readFileSync(path.join(root,'lib/fleet-slo-dashboard.ts'),'utf8');
if (!dash.includes('getFleetSloDashboard') || !dash.includes('acknowledgeFleetDashboardAlert')) throw new Error('DASHBOARD_CONTRACT_MISSING');
if (!dash.includes('failureRate') || !dash.includes('backupFresh') || !dash.includes('drillFresh')) throw new Error('SLO_METRICS_MISSING');
const hook = fs.readFileSync(path.join(root,'hooks/useLLM.ts'),'utf8');
for (const x of ['runAIFleetSloDashboard','acknowledgeAIFleetDashboardAlert','acknowledgeAIFleetDashboardIncident']) if (!hook.includes(x)) throw new Error(`HOOK_MISSING:${x}`);
const ui = fs.readFileSync(path.join(root,'app/runtime.tsx'),'utf8');
const runtimeI18n = fs.readFileSync(path.join(root,'lib/runtime-i18n.ts'),'utf8');
if (!ui.includes('rt("fleetSlo")') || !runtimeI18n.includes('fleetSlo:')) throw new Error('UI_BUTTON_MISSING');
console.log('AIB_PHASE22_FLEET_SLO_DASHBOARD_SELFTEST_OK');
