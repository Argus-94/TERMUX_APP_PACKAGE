import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadTypeScript } from './test-helpers/load-typescript.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = loadTypeScript();
const require = createRequire(import.meta.url);
const sourcePath = path.join(root, 'lib/manus-credits.ts');
const js = ts.transpile(fs.readFileSync(sourcePath, 'utf8'), {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', js)((id) => require(id), mod, mod.exports);
const { parseManusCredits, creditsRefreshState } = mod.exports;

const envelope = (data) => ({ ok: true, data });
const base = { total_credits: 120, free_credits: 20, periodic_credits: 30, addon_credits: 10, pro_monthly_credits: 40, event_credits: 20, refresh_credits: 10, max_refresh_credits: 30 };
const now = 1_800_000_000_000;
const nowSeconds = now / 1000;

// Personal accounts: daily/weekly, and monthly quota is informational—not a refresh cadence.
const daily = parseManusCredits(envelope({ ...base, refresh_interval: 'daily', next_refresh_time: nowSeconds + 86_400 }));
assert.equal(daily.total_credits, 120);
assert.equal(daily.pro_monthly_credits, 40);
assert.equal(creditsRefreshState(daily, now), 'scheduled');
const weekly = parseManusCredits(envelope({ ...base, refresh_interval: 'weekly', next_refresh_time: nowSeconds + 7 * 86_400 }));
assert.equal(creditsRefreshState(weekly, now), 'scheduled');
const monthlyOnly = parseManusCredits(envelope({ total_credits: 75, pro_monthly_credits: 75, next_refresh_time: nowSeconds + 30 * 86_400 }));
assert.equal(creditsRefreshState(monthlyOnly, now), 'unavailable');

// Zero and negative balances are preserved; omitted optional team fields remain omitted.
const unusual = parseManusCredits(envelope({ total_credits: -5, free_credits: 0, addon_credits: -5 }));
assert.equal(unusual.total_credits, -5);
assert.equal(unusual.free_credits, 0);
assert.equal(unusual.addon_credits, -5);
assert.equal(Object.hasOwn(unusual, 'periodic_credits'), false);
const team = parseManusCredits(envelope({ total_credits: 100, free_credits: 100 }));
assert.equal(Object.hasOwn(team, 'refresh_interval'), false);
assert.equal(Object.hasOwn(team, 'next_refresh_time'), false);
assert.equal(creditsRefreshState(team, now), 'unavailable');

const noUpcoming = parseManusCredits(envelope({ total_credits: 0, refresh_interval: 'daily', next_refresh_time: 0 }));
assert.equal(creditsRefreshState(noUpcoming, now), 'none');
const expired = parseManusCredits(envelope({ total_credits: 8, refresh_interval: 'daily', next_refresh_time: nowSeconds - 1 }));
assert.equal(creditsRefreshState(expired, now), 'expired');

const malformed = [
  null,
  [],
  {},
  { ok: false, data: { total_credits: 1 } },
  { ok: true, data: null },
  envelope({}),
  envelope({ total_credits: '1' }),
  envelope({ total_credits: 1.5 }),
  envelope({ total_credits: 2_147_483_648 }),
  envelope({ total_credits: -2_147_483_649 }),
  envelope({ total_credits: 1, free_credits: null }),
  envelope({ total_credits: 1, next_refresh_time: -1 }),
  envelope({ total_credits: 1, next_refresh_time: Number.MAX_SAFE_INTEGER }),
  envelope({ total_credits: 1, current_period_end: 1.25 }),
  envelope({ total_credits: 1, refresh_interval: 'monthly' }),
];
for (const fixture of malformed) {
  assert.throws(() => parseManusCredits(fixture), (error) => {
    assert.match(error.message, /^MANUS_INVALID_RESPONSE: /);
    assert.equal(error.message.includes(JSON.stringify(fixture)), false, 'error must not include response payload');
    return true;
  });
}
console.log('PASS Manus credits parser and refresh-state fixtures (daily, weekly, monthly quota, signed balances, omissions, zero, expired, malformed)');
