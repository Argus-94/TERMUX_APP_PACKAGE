import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const required = [
  'lib/self-healing-device-suite.ts',
  'core/device/DeviceTestRunner.ts',
  'hooks/useLLM.ts',
  'app/runtime.tsx',
];
for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`MISSING:${rel}`);
}
const runner = fs.readFileSync(path.join(root, 'core/device/DeviceTestRunner.ts'), 'utf8');
if (!runner.includes('caseIds?: string[]')) throw new Error('CASE_FILTER_CONTRACT_MISSING');
if (!runner.includes('const selected = options.caseIds?.length')) throw new Error('CASE_FILTER_IMPLEMENTATION_MISSING');
const loop = fs.readFileSync(path.join(root, 'lib/self-healing-device-suite.ts'), 'utf8');
for (const token of ['generateDeviceTestSuite', 'runAssembleDebug', 'DeviceEvidenceStore', 'caseIds: selected', 'buildRepairPrompt', 'TEST_SUITE_FAILED']) {
  if (!loop.includes(token)) throw new Error(`SELF_HEAL_TOKEN_MISSING:${token}`);
}
const hook = fs.readFileSync(path.join(root, 'hooks/useLLM.ts'), 'utf8');
if (!hook.includes('runSelfHealingDeviceQA')) throw new Error('HOOK_MISSING');
const runtime = fs.readFileSync(path.join(root, 'app/runtime.tsx'), 'utf8');
const runtimeI18n = fs.readFileSync(path.join(root, 'lib/runtime-i18n.ts'), 'utf8');
if (!runtime.includes('rt("selfHealingQa")') || !runtimeI18n.includes('selfHealingQa:')) throw new Error('UI_BUTTON_MISSING');
console.log('AIB_PHASE8_SELF_HEALING_SELFTEST_OK');
