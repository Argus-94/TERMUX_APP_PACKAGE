import fs from 'node:fs';

const files = [
  'lib/termux-agent.ts',
  'lib/build-loop.ts',
  'lib/reviewer.ts',
  'lib/agents-md.ts',
  'lib/agent-orchestrator.ts',
  'lib/subagents.ts',
  'lib/agent-tools.ts',
  'lib/github-tools.ts',
  'hooks/useAppSettings.ts',
];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  if (file !== 'lib/termux-executor.ts' && /runShellCommand\s*\(/.test(src)) {
    throw new Error(`AIB_SHELL_BOUNDARY_BYPASS:${file}`);
  }
}
const executor = fs.readFileSync('lib/termux-executor.ts', 'utf8');
if (!/guardTermuxCommand/.test(executor) || !/runShellCommand\s*\(/.test(executor)) {
  throw new Error('AIB_SHELL_BOUNDARY_EXECUTOR_INVALID');
}
console.log('AIB_SHELL_BOUNDARY_SELFTEST_OK model_reachable=guarded');
