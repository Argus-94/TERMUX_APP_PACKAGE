import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyPackageMenuAvailability, packageMenuAvailabilityMessage } from '../lib/package-menu-availability.ts';
assert.deepEqual(classifyPackageMenuAvailability(true, false), { bridgeAvailable: true, sessionEnabled: false, reason: 'session-disabled' });
assert.deepEqual(classifyPackageMenuAvailability(false, false), { bridgeAvailable: false, sessionEnabled: false, reason: 'bridge-unavailable' });
assert.deepEqual(classifyPackageMenuAvailability(true, true), { bridgeAvailable: true, sessionEnabled: true, reason: 'eligible' });
for (const language of ['ru', 'uk', 'en']) {
  assert.match(packageMenuAvailabilityMessage('session-disabled', language), /runtime/i);
  assert.match(packageMenuAvailabilityMessage('session-disabled', language), /package actions|діями з пакетами|действиями с пакетами/i);
  assert.match(packageMenuAvailabilityMessage('session-disabled', language), /side menu|боков(?:ом|ому) меню/i);
  assert.match(packageMenuAvailabilityMessage('bridge-unavailable', language), /bridge|міст|мост/i);
}
const source = await readFile(new URL('../components/PackagesRightMenu.tsx', import.meta.url), 'utf8');
assert.match(source, /const termuxOk = availability\.reason === "eligible"/);
assert.match(source, /persistentLogger\.add\("info", "PackagesGate"/);
assert.match(source, /packageMenuAvailabilityMessage\(availability\.reason, language\)/, 'visible banner uses the gate-specific localized explanation');
assert.doesNotMatch(source, /Встроенное private runtime недоступно/, 'session-disabled must not be misreported as private runtime unavailable');
assert.doesNotMatch(source, /setEnabled\s*\(/);
console.log('v496 package menu availability self-test passed');
