import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targets = [
  'app/index.tsx', 'app/settings.tsx', 'app/termux-settings.tsx',
  'app/checkpoints.tsx', 'app/log-screen.tsx', 'app/session-replay.tsx',
  'hooks/usePermissions.ts',
];
const forbidden = /catch\s*\([^)]*:\s*any\)|as\s+any/;
for (const rel of targets) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  if (forbidden.test(text)) throw new Error(`P2_TYPE_SAFETY_REGRESSION: ${rel}`);
}
const context = fs.readFileSync(path.join(root, 'components/LLMContext.tsx'), 'utf8');
if (!context.includes('type LLMContextType = ReturnType<typeof useLLM>;')) throw new Error('LLM_CONTEXT_TYPE_CONTRACT_MISSING');
console.log('AIB_P2_TYPE_SAFETY_SELFTEST_OK');
