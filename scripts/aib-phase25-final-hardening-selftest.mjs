import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.match(pkg.version, /^1\.(7|8|10)\.\d+$/, 'package version must be 1.7.x, 1.8.x or 1.10.x');
assert.ok(pkg.scripts?.['test:phase25-final-hardening']);
assert.ok(fs.existsSync(path.join(root, 'pnpm-lock.yaml')), 'pnpm lockfile is required');

const identity = fs.readFileSync(path.join(root, 'core/runtime/RuntimeIdentity.ts'), 'utf8');
assert.match(identity, /appVersion:\s*"1\.\d+\.\d+"/);

const required = [
  'lib/fleet-slo-dashboard.ts',
  'lib/fleet-alert-escalation.ts',
  'lib/app-notifications.ts',
  'lib/fleet-unified-control-center.ts',
  'scripts/aib-phase22-fleet-slo-dashboard-selftest.mjs',
  'scripts/aib-phase23-alert-escalation-selftest.mjs',
  'scripts/aib-phase24-unified-control-center-selftest.mjs',
];
for (const rel of required) assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);

const forbiddenNames = new Set(['.env', '.env.local', '.env.production', 'release.keystore', 'debug.keystore']);
const forbiddenMarkers = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/];
const ignored = new Set(['node_modules', '.git', 'android/.gradle', 'android/build']);
const suspicious = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) { walk(full); continue; }
    if (forbiddenNames.has(entry.name)) suspicious.push(`${rel}: forbidden secret/artifact filename`);
    if (fs.statSync(full).size > 2_000_000) continue;
    if (/\.(ts|tsx|js|jsx|mjs|json|md|txt|yml|yaml|properties|gradle|sh)$/.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8');
      for (const marker of forbiddenMarkers) if (marker.test(text)) suspicious.push(`${rel}: private credential marker`);
    }
  }
}
walk(root);
assert.deepEqual(suspicious, [], suspicious.join('\n'));

// Run the deterministic phase self-tests that do not require Expo/native dependencies.
const tests = [
  'scripts/aib-phase22-fleet-slo-dashboard-selftest.mjs',
  'scripts/aib-phase23-alert-escalation-selftest.mjs',
  'scripts/aib-phase24-unified-control-center-selftest.mjs',
];
for (const rel of tests) execFileSync(process.execPath, [rel], { stdio: 'pipe' });

console.log('AIB_PHASE25_FINAL_HARDENING_SELFTEST_OK version=' + pkg.version);
