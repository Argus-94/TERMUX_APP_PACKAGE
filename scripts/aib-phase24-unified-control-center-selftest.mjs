import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/fleet-unified-control-center.ts', import.meta.url), 'utf8');
for (const token of [
  'getFleetCommandSnapshot',
  'getFleetSloDashboard',
  'escalateFleetAlerts',
  'getFleetPolicy',
  'FleetUnifiedControlSnapshot',
  'criticalAlerts',
  'pendingNotifications',
]) assert.ok(source.includes(token), `missing ${token}`);
assert.ok(source.includes('status = "incident"'));
assert.ok(source.includes('status = "degraded"'));
console.log('AIB_PHASE24_UNIFIED_CONTROL_CENTER_SELFTEST_OK');
