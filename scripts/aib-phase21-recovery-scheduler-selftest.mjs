import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const required = [
  'lib/fleet-recovery-scheduler.ts',
  'lib/fleet-disaster-recovery-drill.ts',
  'lib/fleet-backup-recovery.ts',
  'docs/dsha-phase21-recovery-scheduler-slo.md'
];
for (const f of required) if (!fs.existsSync(path.join(root,f))) throw new Error(`MISSING:${f}`);
const src = fs.readFileSync(path.join(root,'lib/fleet-recovery-scheduler.ts'),'utf8');
for (const token of ['defaultFleetRecoverySchedule','getFleetRecoverySchedule','setFleetRecoverySchedule','evaluateFleetRecoverySlo','runFleetScheduledRecoveryCheck','RECOVERY_DRILL_FAILED']) if (!src.includes(token)) throw new Error(`TOKEN_MISSING:${token}`);
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if (pkg.scripts['test:phase21-recovery-scheduler'] !== 'node scripts/aib-phase21-recovery-scheduler-selftest.mjs') throw new Error('SCRIPT_MISSING');
console.log('AIB_PHASE21_RECOVERY_SCHEDULER_SELFTEST_OK');
