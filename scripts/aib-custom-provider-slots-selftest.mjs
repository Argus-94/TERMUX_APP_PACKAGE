import fs from 'node:fs';
import assert from 'node:assert/strict';

const settings = fs.readFileSync('app/settings.tsx', 'utf8');
const hook = fs.readFileSync('hooks/useAppSettings.ts', 'utf8');
const llm = fs.readFileSync('hooks/useLLM.ts', 'utf8');
const i18n = fs.readFileSync('lib/i18n.ts', 'utf8');

for (const token of ['customProvider1Title', 'customProvider2Title', 'activeCustomSlot', 'setCustomProviderSlot', 'useAsActiveAgent']) {
  assert.ok(settings.includes(token), `settings missing ${token}`);
}
for (const token of ['customProvider2', 'CUSTOM2_PROVIDER_STORAGE_KEY', 'CUSTOM2_API_KEY_SECURE_STORAGE_KEY', 'normalizePersistedModelMode(persisted.mode)']) {
  assert.ok(hook.includes(token), `settings hook missing ${token}`);
}
assert.doesNotMatch(hook, /deepseek|api\.deepseek\.com/i, 'retired provider state is never hydrated or selected');
assert.ok(llm.includes('if (mode === "custom")'), 'custom mode must remain agent-enabled');
assert.ok(i18n.includes('customProvider1Section:') && i18n.includes('customProvider2Section:'), 'slot translations missing');
assert.ok(i18n.includes('useAsActiveAgent:'), 'agent activation translation missing');

console.log('AIB_CUSTOM_PROVIDER_SLOTS_SELFTEST_OK');
